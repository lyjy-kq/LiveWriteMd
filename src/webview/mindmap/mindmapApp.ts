/**
 * 导图应用层：把「自研画布引擎」和「markdown 文档操作」粘在一起。
 *
 * 职责边界（与重构前一致，底层从 simple-mind-map 换成 engine/canvas.ts）：
 * - 画布只管模型/布局/渲染/平移缩放/拖动交互；
 * - 本文件负责：md ⇄ 树、编辑会话、工具条、右键菜单、搜索、快捷键、导出；
 * - 所有结构性修改都走 markdownEdit 计算新全文 → onEdit 回写宿主，
 *   一次导图操作 = 源文档一步撤销。
 *
 * 编辑采用「显示 CM 原地翻转」：节点显示态与编辑态是同一个 mini-CM，
 * 进编辑只重配 Compartment，不重建 DOM、不重排画布。
 */

import type { LanguageDescription } from '@codemirror/language';
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { ThemeType } from '../../shared/types.js';
import {
    toggleBold,
    toggleInlineCode,
    toggleItalic,
} from '../codemirror/extensions/keymap.js';
// 表格右键菜单复用 live 模式的那一套：菜单项文案 + 落格解析 + 增删行列命令
import { TABLE_MENU_ITEMS } from '../editorContextMenu.js';
import { cellAt, splitRowText } from '../codemirror/extensions/livePreview/tableRender.js';
import {
    runTableCommand,
    type TableCommand,
} from '../codemirror/extensions/livePreview/tableCommands.js';
import type { NodeDisplay } from './miniCm.js';
import { MindmapSearchBar } from './searchBar.js';
import { ensureMindMapCss } from './mindmapStyles.js';
import { buildMindMapTree } from './treeBuilder.js';
import {
    MapCanvas,
    type DropPayload,
    type MapCanvasOptions,
} from './engine/canvas.js';
import type { MapNode } from './engine/model.js';
import {
    toPdfDataUrl,
    toPngDataUrl,
    rasterizeSvg,
} from './engine/export.js';
import type {
    MindMapEditCallback,
    MindMapNodeKind,
    MindMapRuntimeSettings,
    MindMapTreeNode,
    NodeLineRange,
} from './types.js';
import {
    addChildNode,
    addNode,
    addSiblingNode,
    countSubtreeNodes,
    deleteNode,
    findNodeByUid as findTreeNodeByUid,
    isMediaKind,
    moveNode,
    renameNode,
    type NewNodeSpec,
} from './markdownEdit.js';

/** 默认运行时设置（与 settingsSchema 默认值对齐）。 */
const DEFAULT_RUNTIME_SETTINGS: MindMapRuntimeSettings = {
    mindmapTheme: 'auto',
    mindmapDefaultExpandLevel: 2,
    mindmapPerformanceMode: true,
    // 离屏实例 LRU 淘汰：默认关闭，离屏实例一直保留（来回平移不重建 CM）
    mindmapDisplayCache: false,
    mindmapNodeMaxWidth: 20,
    mindmapNodeMaxLines: 3,
    mindmapCodeMinWidth: 10,
    // 缩放降级：两个档位默认都关闭（与 settingsSchema 默认值一致），
    // 关闭时不看阈值，任何缩放比例都保持全量渲染
    mindmapLiteEnabled: false,
    mindmapPlainEnabled: false,
    // 缩放降级阈值（百分比）：与 settingsSchema 默认值一致
    mindmapLiteZoom: 70,
    mindmapPlainZoom: 40,
    // 手势期清晰度优先：默认开启。实测平移帧间隔与提升模式一致、
    // 滚轮缩放反而少了 41ms 的建层尖峰，所以默认不提升。
    mindmapGestureCrisp: true,
};

/**
 * 文本节点：编辑中内容变高（回车换行 / 长行折行）时要把单元格撑高。
 * 代码、表格、公式等媒体节点不在此列 —— 它们编辑时保持盒内滚动。
 */
const TEXT_NODE_KINDS = new Set<MindMapNodeKind>(['heading', 'list', 'para']);

/** 导图应用构造参数。 */
export interface MindMapAppOptions {
    /** 导图编辑产生新全文时回调（模式内由宿主 dispatch 到隐藏的 CM）。 */
    onEdit: MindMapEditCallback;
    /** 非编辑态 Ctrl+Z：转发给隐藏主 CM 的撤销栈。 */
    onUndo?: () => void;
    /** 非编辑态 Ctrl+Y / Ctrl+Shift+Z：转发重做。 */
    onRedo?: () => void;
    /** 代码块嵌套高亮语言表（主编辑器同款，mini-CM 用）。 */
    codeLanguages?: readonly LanguageDescription[];
    /** 选中节点时回调其大纲行号（1-based；非标题节点取最近的父标题）。 */
    onSelectLine?: (line: number) => void;
    /** 导出结果回调（宿主把内容发 extension 存盘；缺省则不显示导出项）。 */
    onExport?: (payload: MindmapExportPayload) => void;
}

/** 导图导出载荷（webview → extension）。 */
export interface MindmapExportPayload {
    format: 'png' | 'svg' | 'pdf';
    name: string;
    dataUrl?: string;
    svgText?: string;
}

/** 进行中的编辑会话。 */
interface EditSession {
    uid: string;
    kind: MindMapNodeKind;
    initialText: string;
    /**
     * 进入编辑前的节点高度。
     * 编辑时盒子只增不减（growNodeHeight），文本没变就按这个值收回去，
     * 避免为了「缩回原高」把整个 mini-CM 销毁重建。
     */
    baseHeight: number;
    display: NonNullable<ReturnType<MapCanvas['getDisplay']>>;
}

export class MindMapApp {
    private readonly container: HTMLElement;
    private readonly options: MindMapAppOptions;
    /** 自研画布引擎。 */
    private readonly canvas: MapCanvas;
    /** 导图内搜索条。 */
    private readonly searchBar: MindmapSearchBar;

    /** 当前文档全文与按行缓存（computeDoc 高频调用，避免反复 split）。 */
    private markdown = '';
    private markdownLines: string[] = [];
    /** 当前文件名（不含扩展名），虚拟根文本。 */
    private fileName = '';

    /** 当前明暗主题（auto 时用）。 */
    private theme: ThemeType = 'dark';
    /** 导图运行时设置。 */
    private settings: MindMapRuntimeSettings = { ...DEFAULT_RUNTIME_SETTINGS };

    /** 容器当前是否显示（display:none 时不量尺寸）。 */
    private active = false;
    /** 容器尺寸观察器。 */
    private resizeObserver: ResizeObserver | null = null;
    private lastContainerWidth = 0;
    private lastContainerHeight = 0;

    /** 已经出现过的 uid（新 uid 按默认展开层级初始化）。 */
    private readonly knownUids = new Set<string>();
    /** 用户收起的 uid 集合；重建树后据此恢复展开状态。 */
    private readonly collapsedUids = new Set<string>();
    /** 被用户点开「展开到最大行数」的 uid 集合。 */
    private readonly expandedUids = new Set<string>();

    /** 隐藏状态下改设置：等 setActive(true) 再量尺寸/重排。 */
    private pendingSettingsRefresh: {
        performance: boolean;
        size: boolean;
        expand: boolean;
        /** 缩放降级阈值是否变了（跨档时 canvas 会整树重建）。 */
        tier: boolean;
        /** 显示实例 LRU 淘汰开关是否变了。 */
        cache: boolean;
    } | null = null;

    /** 最近一次喂给画布的树（编辑操作以它为基准）。 */
    private currentTree: MindMapTreeNode | null = null;
    /** 编辑期间到来的外部更新：只保留最新一棵，会话结束后补发。 */
    private pendingTree: MindMapTreeNode | null = null;

    private selectedUid: string | null = null;
    private editSession: EditSession | null = null;
    /** 编辑中撑高节点的合并帧：每帧最多量一次内容高度，别每个按键都强制布局。 */
    private growFrame: number | null = null;

    /** 浮动工具条。 */
    private toolbarEl: HTMLDivElement | null = null;
    private toolbarTimer: ReturnType<typeof setInterval> | null = null;
    /**
     * 「待确认删除」的节点 uid（第一次点删除后按钮变红）。
     *
     * 不用 window.confirm：VS Code webview 里原生确认框会被吞掉，
     * 有子项的节点点删除看起来就像完全没反应。改成按钮内二次确认：
     * 第一次点击把按钮变红（文案「确认删除」），4 秒内再点一次才真正删。
     */
    private pendingDeleteUid: string | null = null;
    private pendingDeleteTimer: ReturnType<typeof setTimeout> | null = null;
    /** 右键菜单。 */
    private contextMenuEl: HTMLDivElement | null = null;
    /**
     * 右键落在表格节点上时的上下文（菜单项据此增删行列）。
     *
     * 只有真的点到表格格子才非空；菜单关闭时若没执行命令，要把临时
     * 提升成全量的显示实例降回当前渲染档（见 closeContextMenu）。
     */
    private tableMenuContext: { uid: string; display: NodeDisplay } | null = null;
    /** 右键菜单的全局关闭监听（destroy 时要摘掉，避免实例泄漏）。 */
    private readonly onContainerContextMenu = (event: MouseEvent): void => {
        event.preventDefault();
        event.stopPropagation();
        // 先关旧菜单（会把上一轮临时提升的全量显示实例降档），再解析新落点：
        // 反过来的话，连续右键同一个表格时 close 会把刚解析出来的 display 销毁。
        this.closeContextMenu();
        // 在右键落点上解析表格格子（顺便把整格选起来），再拼菜单
        const table = this.resolveTableMenuContext(event);
        this.openContextMenu(event, table);
    };
    private readonly onDocumentClick = (): void => this.closeContextMenu();
    private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') this.closeContextMenu();
    };
    private readonly onWindowBlur = (): void => this.closeContextMenu();

    /** 导出进行中（菜单连点防重）。 */
    private exportInFlight = false;

    constructor(container: HTMLElement, options: MindMapAppOptions) {
        this.container = container;
        this.options = options;
        ensureMindMapCss();

        this.searchBar = new MindmapSearchBar(container, {
            getMarkdown: () => this.markdown,
            onEdit: (text) => this.commit({ text }),
            onHighlight: (uids, currentUid) => this.applySearchHighlight(uids, currentUid),
            onGotoUid: (uid) => this.selectAndCenterUid(uid),
            findUidAtLine: (line0) => this.findNodeUidAtLine(line0),
            onClose: () => this.applySearchHighlight([], null),
        });

        this.canvas = new MapCanvas(container, {
            computeDoc: (node) => this.computeNodeDoc(node),
            getTheme: () => this.resolveTheme(),
            codeLanguages: options.codeLanguages,
            onNodeClick: (node, event) => this.handleNodeClick(node, event),
            onNodeDoubleClick: (node, event) =>
                this.startEdit(node.uid, event.clientX, event.clientY),
            onCanvasClick: () => this.clearSelection(),
            onExpandChange: (uid, expanded, recursive) =>
                this.handleExpandChange(uid, expanded, recursive),
            onDrop: (payload) => this.handleDrop(payload),
            onViewChange: () => this.positionToolbar(),
            canDrop: (dragUid, parentUid) => this.validateDropParent(dragUid, parentUid),
        } satisfies MapCanvasOptions);

        this.applyNodeSizeVars();
        // 缩放降级阈值：先落到画布，首屏 fit 出来的缩放就会按档渲染
        this.canvas.setZoomRenderThresholds(
            this.settings.mindmapLiteZoom,
            this.settings.mindmapPlainZoom,
            this.settings.mindmapLiteEnabled,
            this.settings.mindmapPlainEnabled
        );
        this.canvas.setVirtualization(this.isPerformanceEnabled());
        // 离屏实例 LRU 淘汰：默认关闭，必须跟设置同步，否则旧行为会一直开着
        this.canvas.setDisplayCacheEnabled(this.settings.mindmapDisplayCache);
        this.createToolbar();
        this.createContextMenu();

        window.addEventListener('keydown', this.handleWindowKeyDown, true);
        this.resizeObserver = new ResizeObserver(() => this.handleContainerResize());
        this.resizeObserver.observe(container);
    }

    // ==================================================================
    // 生命周期 / 输入
    // ==================================================================

    /** 引擎是同步构造的；保留 Promise 接口供宿主统一 await。 */
    async whenReady(): Promise<void> {
        /* 无异步启动链 */
    }

    /** 调试/探针用：取底层画布（生产代码不应调用）。 */
    debugGetInstance(): MapCanvas {
        return this.canvas;
    }

    /**
     * 设置文档内容（INIT / UPDATE / 自身重建）。
     *
     * @param markdown 当前全文
     * @param fileName 不含扩展名的文件名
     */
    setDocument(markdown: string, fileName: string): void {
        // 导图自身编辑会回环一次 UPDATE；内容没变就不重建（避免白做）
        if (this.currentTree && markdown === this.markdown && fileName === this.fileName) return;
        this.setMarkdown(markdown);
        this.fileName = fileName;
        const tree = buildMindMapTree(markdown, fileName);
        this.currentTree = tree;
        // 编辑中（输入法组合态）：外部更新延后，保护编辑 DOM
        if (this.editSession) {
            this.pendingTree = tree;
            return;
        }
        this.canvas.setData(this.bakeExpandState(tree));
        this.toggleEmptyHint(tree.children.length === 0);
    }

    /** 切换明暗主题（auto 时跟随编辑器）。 */
    setTheme(theme: ThemeType): void {
        this.theme = theme;
        if (this.settings.mindmapTheme === 'auto') {
            this.canvas.setTheme(this.resolveTheme());
        }
    }

    /**
     * 更新导图设置（必须对已经在画布上的节点立即生效）。
     */
    setSettings(settings: MindMapRuntimeSettings): void {
        const previous = this.settings;
        this.settings = { ...DEFAULT_RUNTIME_SETTINGS, ...settings };

        // ① 配色：即时切换（与画布可见性无关）
        if (previous.mindmapTheme !== this.settings.mindmapTheme) {
            this.canvas.setTheme(this.resolveTheme());
        }

        // ② 手势期清晰度：无条件同步一次。不能只在「值变了」时调用 ——
        // 默认值是 true，初始化时 previous 与 settings 相同，画布就永远
        // 拿不到 .lwm-crisp。setGestureCrisp 内部是 classList.toggle，幂等。
        this.canvas.setGestureCrisp(this.settings.mindmapGestureCrisp);

        const performanceChanged =
            previous.mindmapPerformanceMode !== this.settings.mindmapPerformanceMode;
        const cacheChanged =
            previous.mindmapDisplayCache !== this.settings.mindmapDisplayCache;
        const sizeChanged =
            previous.mindmapNodeMaxWidth !== this.settings.mindmapNodeMaxWidth ||
            previous.mindmapNodeMaxLines !== this.settings.mindmapNodeMaxLines ||
            previous.mindmapCodeMinWidth !== this.settings.mindmapCodeMinWidth;
        if (sizeChanged) this.applyNodeSizeVars();
        const expandChanged =
            previous.mindmapDefaultExpandLevel !== this.settings.mindmapDefaultExpandLevel;
        // 缩放降级阈值：改了不必重测（没跨档时内容不变；跨档时 canvas 自己重建）
        // 两个开关也算在内：关掉某档要立刻退出该档，不能等阈值变化
        const tierChanged =
            previous.mindmapLiteZoom !== this.settings.mindmapLiteZoom ||
            previous.mindmapPlainZoom !== this.settings.mindmapPlainZoom ||
            previous.mindmapLiteEnabled !== this.settings.mindmapLiteEnabled ||
            previous.mindmapPlainEnabled !== this.settings.mindmapPlainEnabled;

        if (
            !performanceChanged &&
            !cacheChanged &&
            !sizeChanged &&
            !expandChanged &&
            !tierChanged
        ) {
            return;
        }

        // 隐藏时量出来的尺寸是 0：挂起，激活后补做
        if (!this.active) {
            const pending = this.pendingSettingsRefresh ?? {
                performance: false,
                size: false,
                expand: false,
                tier: false,
                cache: false,
            };
            pending.performance ||= performanceChanged;
            pending.size ||= sizeChanged;
            pending.expand ||= expandChanged;
            pending.tier ||= tierChanged;
            pending.cache ||= cacheChanged;
            this.pendingSettingsRefresh = pending;
            return;
        }
        this.applySettingsRefresh(
            performanceChanged,
            sizeChanged,
            expandChanged,
            tierChanged,
            cacheChanged
        );
    }

    /** 把设置变更落到已渲染的画布上。 */
    private applySettingsRefresh(
        performanceChanged: boolean,
        sizeChanged: boolean,
        expandChanged: boolean,
        tierChanged: boolean,
        cacheChanged: boolean
    ): void {
        if (tierChanged) {
            this.canvas.setZoomRenderThresholds(
                this.settings.mindmapLiteZoom,
                this.settings.mindmapPlainZoom,
                this.settings.mindmapLiteEnabled,
                this.settings.mindmapPlainEnabled
            );
        }
        if (performanceChanged) this.canvas.setVirtualization(this.isPerformanceEnabled());
        // 从关到开时 setDisplayCacheEnabled 会立刻做一轮淘汰
        if (cacheChanged) {
            this.canvas.setDisplayCacheEnabled(this.settings.mindmapDisplayCache);
        }
        if (sizeChanged) this.canvas.remeasureAll();
        if (expandChanged) this.applyExpandLevel();
        // 性能模式变化时也需要重算可见集合
        this.canvas.resize();
    }

    /** 按新的默认展开层级重置整棵树的展开状态。 */
    private applyExpandLevel(): void {
        const level = this.settings.mindmapDefaultExpandLevel;
        this.collapsedUids.clear();
        if (this.currentTree) {
            const walk = (tree: MindMapTreeNode, depth: number): void => {
                const collapse = depth >= level && tree.children.length > 0;
                tree.data.expand = !collapse;
                if (collapse) this.collapsedUids.add(tree.data.uid);
                tree.children.forEach((child) => walk(child, depth + 1));
            };
            walk(this.currentTree, 0);
        }
        const collapsed = this.canvas.applyExpandLevel(level);
        for (const uid of collapsed) this.collapsedUids.add(uid);
    }

    /** 节点尺寸上限 → 容器 CSS 变量。 */
    private applyNodeSizeVars(): void {
        this.container.style.setProperty(
            '--lwm-node-max-width',
            `${this.settings.mindmapNodeMaxWidth}em`
        );
        this.container.style.setProperty(
            '--lwm-node-max-lines',
            String(this.settings.mindmapNodeMaxLines)
        );
        this.container.style.setProperty(
            '--lwm-code-min-width',
            `${this.settings.mindmapCodeMinWidth}ch`
        );
    }

    /** 容器显示 / 隐藏切换。 */
    setActive(active: boolean): void {
        this.active = active;
        if (active) {
            this.lastContainerWidth = 0;
            this.lastContainerHeight = 0;
            const pending = this.pendingSettingsRefresh;
            if (pending) {
                this.pendingSettingsRefresh = null;
                this.applySettingsRefresh(
                    pending.performance,
                    pending.size,
                    pending.expand,
                    pending.tier,
                    pending.cache
                );
            }
            this.canvas.setActive(true);
            this.toggleEmptyHint((this.currentTree?.children.length ?? 0) === 0);
        } else {
            // 切回文本模式时收起浮动 UI（编辑会话提交）
            this.commitEditSession();
            this.searchBar.close();
            this.closeContextMenu();
            this.clearSelection();
            this.toggleEmptyHint(false);
        }
    }

    /** 容器尺寸变化（只更新视口，不改节点尺寸）。 */
    private handleContainerResize(): void {
        if (!this.active) return;
        const rect = this.container.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const width = Math.round(rect.width);
        const height = Math.round(rect.height);
        if (width === this.lastContainerWidth && height === this.lastContainerHeight) return;
        this.lastContainerWidth = width;
        this.lastContainerHeight = height;
        this.canvas.resize();
    }

    /** 销毁实例。 */
    destroy(): void {
        window.removeEventListener('keydown', this.handleWindowKeyDown, true);
        this.container.removeEventListener('contextmenu', this.onContainerContextMenu);
        document.removeEventListener('click', this.onDocumentClick);
        document.removeEventListener('keydown', this.onDocumentKeyDown);
        window.removeEventListener('blur', this.onWindowBlur);
        this.searchBar.close();
        if (this.toolbarTimer) clearInterval(this.toolbarTimer);
        if (this.pendingDeleteTimer !== null) clearTimeout(this.pendingDeleteTimer);
        this.pendingDeleteTimer = null;
        this.cancelGrowEditingNode();
        if (this.editSession) {
            this.editSession.display.exitEdit();
            this.editSession = null;
        }
        this.toolbarEl?.remove();
        this.toolbarEl = null;
        this.closeContextMenu();
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.canvas.destroy();
    }

    // ==================================================================
    // 文档 / 树
    // ==================================================================

    /** 更新 markdown 并同步按行缓存。 */
    private setMarkdown(text: string): void {
        this.markdown = text;
        this.markdownLines = text.split('\n');
    }

    /** 按主题设置解析实际明暗。 */
    private resolveTheme(): ThemeType {
        if (this.settings.mindmapTheme === 'dark') return 'dark';
        if (this.settings.mindmapTheme === 'default') return 'light';
        return this.theme;
    }

    /**
     * 性能模式完全由用户设置决定。
     *
     * 早期版本在节点数超过 800 时会强制虚拟化并提示一次，但这会让
     * 「关闭了性能模式」变成一句空话：用户明确要全量 DOM 时仍被强制
     * 切到虚拟化。现在取消阈值强制，关闭就是全量渲染。
     */
    private isPerformanceEnabled(): boolean {
        return this.settings.mindmapPerformanceMode;
    }

    /**
     * 重建前把展开状态烤进树：新 uid 按默认展开层级初始化，旧 uid 跟随用户操作。
     */
    private bakeExpandState(tree: MindMapTreeNode): MindMapTreeNode {
        const level = this.settings.mindmapDefaultExpandLevel;
        const walk = (node: MindMapTreeNode, depth: number): void => {
            const uid = node.data.uid;
            if (!this.knownUids.has(uid)) {
                this.knownUids.add(uid);
                if (depth >= level && node.children.length > 0) {
                    this.collapsedUids.add(uid);
                }
            }
            node.data.expand = !this.collapsedUids.has(uid);
            node.children.forEach((child) => walk(child, depth + 1));
        };
        walk(tree, 0);
        return tree;
    }

    /** 渲染节点显示文档（computeDoc 回调）。 */
    private computeNodeDoc(node: MapNode): { doc: string; sentinel: boolean } {
        const range = node.data._lineRange as NodeLineRange | undefined;
        // 自身区间（不含子节点）：列表项的父节点不能把嵌套列表再渲染一遍
        const selfRange =
            (node.data._selfLineRange as NodeLineRange | undefined) ?? range;
        const sliceRange = (r: NodeLineRange | undefined): string =>
            r ? this.markdownLines.slice(r.fromLine, r.toLine + 1).join('\n') : '';
        switch (node.kind) {
            case 'root':
                return { doc: `# ${node.text}`, sentinel: true };
            case 'heading': {
                // 标题节点允许在格子里按 Enter 换行（commit 后 md 是「# 标题」+
                // 紧跟的续行，treeBuilder 把它并回同一个节点）。首行统一显示成
                // 规范的 ATX 前缀，续行原样保留：
                // - ATX：源首行以 # 开头，续行从第 2 行起；
                // - setext：源首行是文字、第 2 行是 ===/--- 下划线（不显示），
                //   续行从第 3 行起。
                const level = Number(node.data._headingLevel ?? 1);
                const prefix = '#'.repeat(Math.min(6, Math.max(1, level)));
                const lines = selfRange ? sliceRange(selfRange).split('\n') : [];
                const first = (lines[0] ?? '').trimStart();
                const isAtx = /^#{1,6}(\s|$)/.test(first);
                const isSetext =
                    !isAtx &&
                    lines.length > 1 &&
                    /^\s*(?:=+|-+)\s*$/.test(lines[1] ?? '');
                const continuation = lines
                    .slice(isAtx ? 1 : isSetext ? 2 : 1)
                    .join('\n');
                return {
                    doc: continuation
                        ? `${prefix} ${node.text}\n${continuation}`
                        : `${prefix} ${node.text}`,
                    sentinel: true,
                };
            }
            case 'para':
                return { doc: sliceRange(range).trim(), sentinel: true };
            case 'list':
                // 只渲染列表项自身（含首段续行），子列表是独立节点。
                // 必须先去掉父级缩进：嵌套项在源文档里带 2 空格 / 1 个 Tab，
                // 单元格是独立节点，直接把缩进画进去会在格子左边多出一截空白。
                return {
                    doc: selfRange
                        ? dedentListSource(sliceRange(selfRange))
                        : node.text,
                    sentinel: true,
                };
            default:
                // code / table / math / mermaid / image / meta：叶子，整段源码
                return { doc: range ? sliceRange(range) : node.text, sentinel: true };
        }
    }

    // ==================================================================
    // 选中 / 工具条 / 编辑
    // ==================================================================

    /**
     * 节点单击：直接选中并进入编辑（光标落在点击位置）。
     *
     * 不再要求「先点一下选中、再点一下编辑」——那是旧交互的遗留。
     * root 只选中不编辑（它不是 Markdown 里的可编辑块）。
     */
    private handleNodeClick(node: MapNode, event: MouseEvent): void {
        const uid = node.uid;
        // 正在编辑这个节点：让 mini-CM 自己处理这次点击（定位光标）
        if (this.editSession?.uid === uid) return;
        this.selectNode(uid);
        if (node.kind === 'root') return;
        this.startEdit(uid, event.clientX, event.clientY);
    }

    /** 选中节点、显示工具条、联动大纲。 */
    private selectNode(uid: string): void {
        // 换了节点：上一条「待确认删除」作废，避免红按钮跟到别的节点上
        if (this.pendingDeleteUid !== null && this.pendingDeleteUid !== uid) {
            this.clearPendingDelete();
        }
        this.selectedUid = uid;
        this.canvas.setSelected(uid);
        this.showToolbar(uid);
        // 其它节点的显示 CM 选区复位（行内元素收回渲染态）
        this.resetDisplaySelections(uid);
        const line = this.outlineLineOf(uid);
        if (line !== null) this.options.onSelectLine?.(line);
    }

    /** 节点对应的大纲行号（1-based；非标题沿父链找最近的标题）。 */
    private outlineLineOf(uid: string): number | null {
        if (!this.currentTree) return null;
        const found = findTreeNodeByUid(this.currentTree, uid);
        if (!found) return null;
        let current: MindMapTreeNode | null = found.node;
        while (current) {
            if (current.data._kind === 'heading' && current.data._lineRange) {
                return current.data._lineRange.fromLine + 1;
            }
            const parentUid = current.data.uid.split('/').slice(0, -1).join('/');
            if (!parentUid || parentUid === current.data.uid) break;
            current = findTreeNodeByUid(this.currentTree, parentUid)?.node ?? null;
        }
        return null;
    }

    /** 清除选中并隐藏工具条。 */
    private clearSelection(): void {
        // 取消选中 = 取消待确认删除（红按钮不该留在屏幕上）
        this.clearPendingDelete();
        this.selectedUid = null;
        this.canvas.setSelected(null);
        this.resetDisplaySelections(null);
        if (this.toolbarEl) this.toolbarEl.style.display = 'none';
        if (this.toolbarTimer) {
            clearInterval(this.toolbarTimer);
            this.toolbarTimer = null;
        }
    }

    /** 所有显示实例的选区复位（P1 失焦恢复）。 */
    private resetDisplaySelections(exceptUid: string | null): void {
        this.canvas.forEachDisplay((uid, display) => {
            if (uid === exceptUid) return;
            display.resetSelection();
        });
    }

    /**
     * 创建浮动工具条（＋子节点 / ＋兄弟 / 删除）。
     *
     * 添加类按钮的行为分两层：
     * - 普通点击：添加一个普通文本节点（列表里则是同级列表项）；
     * - 悬浮：展开二级菜单，可选标题（三级菜单 H1-H4）/ 表格（三级菜单
     *   4×4 方格，点哪个位置就插多大的表）/ 代码块 / 公式 / mermaid / 列表项。
     */
    private createToolbar(): void {
        if (this.toolbarEl) return;
        const bar = document.createElement('div');
        bar.className = 'lwm-toolbar';
        bar.style.display = 'none';
        bar.appendChild(this.createAddMenu('child', '＋子节点'));
        bar.appendChild(this.createAddMenu('sibling', '＋兄弟'));
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.dataset.act = 'delete';
        deleteButton.textContent = '删除';
        bar.appendChild(deleteButton);
        // 工具条上的按下事件不要漏给画布（避免触发平移/选中）
        bar.addEventListener('pointerdown', (event) => event.stopPropagation());
        bar.addEventListener('click', (event) => {
            event.stopPropagation();
            const target = event.target as HTMLElement;
            // 先认菜单项（data-add）：它们不在顶层面板按钮里面，
            // closest 不会误认成「点击了顶层按钮」
            const addItem = target.closest<HTMLElement>('[data-add]');
            if (addItem) {
                const menu = addItem.closest<HTMLElement>('.lwm-tool-menu');
                const placement =
                    menu?.dataset.menu === 'sibling' ? 'sibling' : 'child';
                this.addFromMenu(placement, addItem);
                return;
            }
            const button = target.closest<HTMLButtonElement>('button[data-act]');
            if (!button || !this.selectedUid) return;
            switch (button.dataset.act) {
                case 'child':
                    // 普通点击 = 普通文本节点
                    this.addQuick('child');
                    break;
                case 'sibling':
                    this.addQuick('sibling');
                    break;
                case 'delete':
                    this.deleteSelected();
                    break;
                default:
                    break;
            }
        });
        // 表格方格：悬停多少行多少列就高亮到哪（点击插入对应尺寸）
        bar.addEventListener('mouseover', (event) => {
            const cell = (event.target as HTMLElement).closest<HTMLElement>(
                '.lwm-table-grid button'
            );
            if (!cell) return;
            const rows = Number(cell.dataset.rows) || 1;
            const cols = Number(cell.dataset.cols) || 1;
            cell.parentElement
                ?.querySelectorAll<HTMLElement>('button[data-rows]')
                .forEach((item) => {
                    const r = Number(item.dataset.rows) || 0;
                    const c = Number(item.dataset.cols) || 0;
                    item.classList.toggle('lwm-table-hit', r <= rows && c <= cols);
                });
            const hint = cell.parentElement?.parentElement?.querySelector(
                '.lwm-table-hint'
            );
            if (hint) hint.textContent = `${rows} 行 × ${cols} 列`;
        });
        this.container.appendChild(bar);
        this.toolbarEl = bar;
    }

    /** 造一个「添加类」按钮 + 悬浮二级菜单。 */
    private createAddMenu(act: 'child' | 'sibling', label: string): HTMLDivElement {
        const wrap = document.createElement('div');
        wrap.className = 'lwm-tool-menu';
        wrap.dataset.menu = act;
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.act = act;
        button.textContent = label;
        button.title = '点击添加普通文本节点；悬停选择其它类型';
        wrap.appendChild(button);

        const popup = document.createElement('div');
        popup.className = 'lwm-tool-popup';
        const addItem = (text: string, dataset: Record<string, string>): void => {
            const item = document.createElement('button');
            item.type = 'button';
            item.textContent = text;
            item.dataset.add = dataset.add;
            for (const [key, value] of Object.entries(dataset)) {
                if (key !== 'add') item.dataset[key] = value;
            }
            popup.appendChild(item);
        };
        addItem('普通文本', { add: 'text' });

        // —— 标题 ▸ H1-H4（三级菜单）——
        const headingItem = document.createElement('div');
        headingItem.className = 'lwm-tool-item';
        const headingLabel = document.createElement('div');
        headingLabel.className = 'lwm-tool-label';
        headingLabel.textContent = '标题';
        headingItem.appendChild(headingLabel);
        const headingPopup = document.createElement('div');
        headingPopup.className = 'lwm-tool-popup lwm-tool-popup-right';
        for (const level of [1, 2, 3, 4]) {
            const item = document.createElement('button');
            item.type = 'button';
            item.textContent = `${'#'.repeat(level)} ${level} 级标题`;
            item.dataset.add = 'heading';
            item.dataset.level = String(level);
            headingPopup.appendChild(item);
        }
        headingItem.appendChild(headingPopup);
        popup.appendChild(headingItem);

        // —— 表格 ▸ 4×4 方格（三级菜单）——
        const tableItem = document.createElement('div');
        tableItem.className = 'lwm-tool-item';
        const tableLabel = document.createElement('div');
        tableLabel.className = 'lwm-tool-label';
        tableLabel.textContent = '表格';
        tableItem.appendChild(tableLabel);
        const tablePopup = document.createElement('div');
        tablePopup.className = 'lwm-tool-popup lwm-tool-popup-right';
        const grid = document.createElement('div');
        grid.className = 'lwm-table-grid';
        for (let rows = 1; rows <= 4; rows += 1) {
            for (let cols = 1; cols <= 4; cols += 1) {
                const cell = document.createElement('button');
                cell.type = 'button';
                cell.dataset.add = 'table';
                cell.dataset.rows = String(rows);
                cell.dataset.cols = String(cols);
                cell.title = `${rows} 行 × ${cols} 列`;
                grid.appendChild(cell);
            }
        }
        tablePopup.appendChild(grid);
        const tableHint = document.createElement('div');
        tableHint.className = 'lwm-table-hint';
        tableHint.textContent = '1 行 × 1 列';
        tablePopup.appendChild(tableHint);
        tableItem.appendChild(tablePopup);
        popup.appendChild(tableItem);

        addItem('代码块', { add: 'code' });
        addItem('公式', { add: 'math' });
        addItem('mermaid 图', { add: 'mermaid' });
        addItem('列表项', { add: 'list' });
        wrap.appendChild(popup);
        return wrap;
    }

    /** 普通点击「＋子节点 / ＋兄弟」：插入普通文本节点。 */
    private addQuick(placement: 'child' | 'sibling'): void {
        this.insertNodeSpec(placement, { type: 'text' });
    }

    /** 悬浮菜单项：把 data-* 解析成 NewNodeSpec 后插入。 */
    private addFromMenu(placement: 'child' | 'sibling', item: HTMLElement): void {
        const add = item.dataset.add;
        let spec: NewNodeSpec | null = null;
        switch (add) {
            case 'text':
                spec = { type: 'text' };
                break;
            case 'heading':
                spec = { type: 'heading', level: Number(item.dataset.level) || 1 };
                break;
            case 'list':
                spec = { type: 'list' };
                break;
            case 'code':
                spec = { type: 'code' };
                break;
            case 'math':
                spec = { type: 'math' };
                break;
            case 'mermaid':
                spec = { type: 'mermaid' };
                break;
            case 'table':
                spec = {
                    type: 'table',
                    rows: Number(item.dataset.rows) || 1,
                    cols: Number(item.dataset.cols) || 1,
                };
                break;
            default:
                return;
        }
        this.insertNodeSpec(placement, spec);
    }

    /** 统一插入入口：结束编辑 → addNode → commit（新节点自动进入编辑）。 */
    private insertNodeSpec(placement: 'child' | 'sibling', spec: NewNodeSpec): void {
        if (!this.selectedUid || !this.currentTree) return;
        this.endEditBeforeStructuralOp();
        this.commit(
            addNode(
                this.markdown,
                this.currentTree,
                this.selectedUid,
                placement,
                spec
            )
        );
    }

    /** 显示工具条并按节点种类禁用不适用的按钮。 */
    private showToolbar(uid: string): void {
        if (!this.toolbarEl) return;
        const node = this.canvas.getNode(uid);
        if (!node) {
            this.toolbarEl.style.display = 'none';
            return;
        }
        const kind = node.kind;
        const media = isMediaKind(kind);
        const setDisabled = (act: string, disabled: boolean): void => {
            const button = this.toolbarEl?.querySelector<HTMLButtonElement>(
                `button[data-act="${act}"]`
            );
            if (button) button.disabled = disabled;
        };
        // 禁用时整个悬浮菜单一起藏起来（按钮 disabled 但 hover 菜单还能弹会误导）
        const setMenuDisabled = (act: string, disabled: boolean): void => {
            const menu = this.toolbarEl?.querySelector<HTMLElement>(
                `.lwm-tool-menu[data-menu="${act}"]`
            );
            if (menu) menu.classList.toggle('lwm-menu-disabled', disabled);
        };
        const childDisabled = kind === 'para' || kind === 'meta' || media;
        // 段落 / 媒体现在支持加兄弟（普通文本节点），root 与元数据仍不行
        const siblingDisabled = kind === 'root' || kind === 'meta';
        setDisabled('child', childDisabled);
        setDisabled('sibling', siblingDisabled);
        setDisabled('delete', kind === 'root');
        setMenuDisabled('child', childDisabled);
        setMenuDisabled('sibling', siblingDisabled);
        this.toolbarEl.style.display = 'flex';
        this.positionToolbar();
        if (this.toolbarTimer) clearInterval(this.toolbarTimer);
        // 画布平移/缩放时跟随（onViewChange 已经即时定位，这里是兜底）
        this.toolbarTimer = setInterval(() => this.positionToolbar(), 120);
    }

    /** 工具条定位到选中节点右下方；菜单会按容器边界翻转方向。 */
    private positionToolbar(): void {
        if (!this.toolbarEl || !this.selectedUid || this.toolbarEl.style.display === 'none') {
            return;
        }
        const rect = this.canvas.getNodeRect(this.selectedUid);
        if (!rect) return;
        const bar = this.toolbarEl;
        const below = rect.bottom + 6;
        bar.style.left = `${rect.left}px`;
        bar.style.top = `${below}px`;
        // 容器尺寸用缓存的：positionToolbar 在平移时每帧都会被调用，
        // clientWidth/clientHeight 会强制同步布局（上一轮刚挂载/卸载过
        // 节点），大文档下每帧白烧一次整树排版。ResizeObserver 已经维护
        // 了这两个值，这里直接读。
        const viewWidth = this.lastContainerWidth || this.container.clientWidth;
        const viewHeight = this.lastContainerHeight || this.container.clientHeight;
        // 二级菜单向下展开约 260px：底部放不下就向上翻
        bar.classList.toggle('lwm-toolbar-up', below + 260 > viewHeight);
        // 节点靠近右边缘时，菜单向左展开，避免被画布裁掉
        bar.classList.toggle('lwm-toolbar-flip-x', rect.left + 200 > viewWidth);
    }

    /**
     * 进入编辑：显示 CM 原地翻转成编辑态（不重渲染、不重排画布）。
     *
     * @param uid 节点 uid
     * @param x 触发点击的视口 X（键盘入口无坐标）
     * @param y 触发点击的视口 Y
     */
    private startEdit(uid: string, x?: number, y?: number): void {
        const node = this.canvas.getNode(uid);
        if (!node || node.kind === 'root') return;
        if (this.editSession?.uid === uid) {
            // 已在编辑同一节点：只补焦点，绝不重设选区。
            // focusAt() 会把选区塌成光标 —— 双击选词、拖选到一半再触发
            // 编辑入口时，刚选中的文字会被它清掉（加粗 / 行内代码里的
            // 内容看起来就「选不上」）。正常编辑态本来就有焦点，这里
            // 只兜住少数焦点已丢但会话还没提交的瞬间。
            if (!this.editSession.display.view.hasFocus) {
                this.editSession.display.view.focus();
            }
            return;
        }
        this.commitEditSession();
        // 占位节点 / 被 LRU 逐出的节点：强制建一个真实显示实例。
        // ensureEditDisplay 无视缩放降级档，保证拿到的是**全量**实例
        // （轻量档没有 live preview 显示扩展，纯文本档根本没有实例）。
        const display = this.canvas.ensureEditDisplay(uid);
        if (!display) return;
        // commitEditSession 可能刚整树重建过：上面那个 node 可能是旧模型的
        // 对象，高度/种类都取最新的（ensureEditDisplay 还会补量一次尺寸）。
        const current = this.canvas.getNode(uid) ?? node;
        const session: EditSession = {
            uid,
            kind: current.kind,
            initialText: display.getText(),
            // 进编辑前的高度：文本没变时用它把编辑期间撑高的盒子收回去
            baseHeight: current.height,
            display,
        };
        this.editSession = session;
        this.selectedUid = uid;
        this.canvas.setSelected(uid);
        this.canvas.setEditing(uid);
        display.enterEdit({
            kind: node.kind,
            onCommit: (text) => this.finishEdit(session, text),
            // Shift+Enter（文本节点）= 提交当前项 + 新起一个同级节点：
            // 先把当前格的编辑内容提交，再走工具条同一个 addSibling 通道
            // （同级类型 / 缩进由 addSiblingNode 继承），commit() 会自动
            // 选中新节点并进入编辑。
            onShiftEnter: TEXT_NODE_KINDS.has(node.kind)
                ? () => {
                      this.finishEdit(session, display.getText());
                      this.addSibling();
                  }
                : undefined,
            // 回车换行 / 自动折行让内容变高时撑高盒子。
            onDocChanged: () => this.scheduleGrowEditingNode(session),
        });
        // 等一帧让 CM 完成重配与布局，再按点击坐标落光标（不全选）
        requestAnimationFrame(() => display.focusAt(x, y));
    }

    /**
     * 编辑中内容变高时撑高单元格（合并到下一帧，每帧最多量一次）。
     *
     * 段落里按回车新增一行、列表项太长自动折行，都会让 mini-CM 的内容
     * 高于节点盒子；不撑高的话编辑态的内部滚动会把新行裁掉，看起来
     * 像「回车没反应」。媒体节点（代码/表格/公式）不参与，保持盒内滚动。
     */
    private scheduleGrowEditingNode(session: EditSession): void {
        if (this.growFrame !== null) return;
        this.growFrame = requestAnimationFrame(() => {
            this.growFrame = null;
            if (this.editSession !== session) return;
            if (!TEXT_NODE_KINDS.has(session.kind)) return;
            this.canvas.growNodeHeight(session.uid, session.display.contentHeight());
        });
    }

    /** 取消待执行的撑高帧（会话结束/销毁时调用）。 */
    private cancelGrowEditingNode(): void {
        if (this.growFrame === null) return;
        cancelAnimationFrame(this.growFrame);
        this.growFrame = null;
    }

    /**
     * 在选中节点上执行 live 模式的行内格式快捷键（Ctrl/Cmd+B/I/G）。
     *
     * 导图平时的节点是只读 mini-CM，命令本身只改 EditorState，不会自动
     * 进入编辑；所以这里先翻转成编辑态，再对同一个 view 执行命令。
     *
     * 有个时序坑：`startEdit` 内部排了一帧 rAF 调 `focusAt()`，键盘入口
     * 没有坐标 → 光标被甩到文末（显示文档末尾还有一行哨兵换行）。如果
     * 直接执行命令，`**` 会插进隐藏的哨兵行，源文档里多出一对看不见的
     * 标记。所以：
     * 1. 进编辑前先记下显示态选区（用户可能已经拖选了一段文字）；
     * 2. 我们的 rAF 排在 startEdit 的 focusAt 之后，先把选区恢复回来；
     * 3. 空选区且停在文末时，把光标左移一个字符（哨兵换行之前），
     *    这样空标记落在正文末尾，和 live 里「光标处插一对空标记、
     *    光标停在中间」的行为一致。
     */
    private applyInlineFormat(
        uid: string,
        command: (view: EditorView) => boolean,
    ): void {
        const node = this.canvas.getNode(uid);
        if (!node) return;
        // root 不可编辑；代码/表格/公式/YAML 里插行内标记只会破坏语法
        if (node.kind === 'root' || node.kind === 'meta' || isMediaKind(node.kind)) {
            return;
        }
        const display = this.canvas.getDisplay(uid);
        const saved = display && !display.editing ? display.view.state.selection : null;
        this.startEdit(uid);
        const session = this.editSession;
        if (!session || session.uid !== uid) return;
        requestAnimationFrame(() => {
            if (this.editSession !== session) return;
            const view = session.display.view;
            let selection = saved ?? view.state.selection;
            try {
                if (
                    selection.main.empty &&
                    selection.main.head >= view.state.doc.length
                ) {
                    // 文末哨兵换行不属于正文：光标挪到正文末尾
                    selection = EditorSelection.single(
                        Math.max(0, view.state.doc.length - 1),
                    );
                }
                view.dispatch({ selection });
            } catch {
                /* 视图已销毁：忽略 */
            }
            command(view);
            // dispatch 不会自动给焦点，编辑态没焦点就没法接着打字
            view.focus();
        });
    }

    /** 提交当前编辑会话（如有）。 */
    private commitEditSession(): void {
        const session = this.editSession;
        if (!session) return;
        this.finishEdit(session, session.display.getText());
    }

    /** 结束编辑会话：文本有变化走 renameNode → commit。 */
    private finishEdit(session: EditSession, text: string | null): void {
        if (this.editSession !== session) return;
        this.editSession = null;
        // 会话结束后不再撑高（提交路径会完整重测，允许回缩）
        this.cancelGrowEditingNode();
        session.display.exitEdit();
        this.canvas.setEditing(null);
        if (text !== null && text !== session.initialText && this.currentTree) {
            this.commit(renameNode(this.markdown, this.currentTree, session.uid, text));
            return;
        }
        // 编辑期间到达的外部更新：setData 会整树重建并复用/重建各节点内容，
        // 以前先 refreshNode 再 setData，等于把同一个节点重建两遍。直接整树替换。
        if (this.pendingTree) {
            const tree = this.pendingTree;
            this.pendingTree = null;
            this.currentTree = tree;
            this.canvas.setData(this.bakeExpandState(tree));
            this.toggleEmptyHint(tree.children.length === 0);
            return;
        }
        // 文本没变：全量档下显示实例本来就是完整的，exitEdit 已经切回显示态，
        // 就地收尾即可（只把编辑时撑高的盒子收回去）。轻量 / 纯文本档才需要
        // 重建降档，finishEditDisplay 返回 false 时再走 refreshNode。
        if (this.canvas.finishEditDisplay(session.uid, session.baseHeight)) return;
        this.canvas.refreshNode(session.uid, true);
    }

    // ==================================================================
    // 编辑回写 / 结构操作
    // ==================================================================

    /** 提交一次导图编辑：本地重建 + onEdit 回写源文档。 */
    private commit(result: { text: string; newNodeUid?: string }): void {
        if (!result) return;
        if (result.text === this.markdown && !result.newNodeUid) return;
        this.setMarkdown(result.text);
        const tree = buildMindMapTree(result.text, this.fileName);
        this.currentTree = tree;
        if (this.editSession) {
            this.pendingTree = tree;
        } else {
            this.canvas.setData(this.bakeExpandState(tree));
            this.toggleEmptyHint(tree.children.length === 0);
        }
        this.options.onEdit(result.text);
        this.searchBar.refreshAfterDocumentChange();
        if (result.newNodeUid) {
            const uid = result.newNodeUid;
            this.selectedUid = uid;
            this.canvas.setSelected(uid);
            this.showToolbar(uid);
            // 新节点已在同步渲染里就位，直接进编辑
            requestAnimationFrame(() => this.startEdit(uid));
        }
    }

    /**
     * 工具条结构操作前先落掉编辑会话。
     *
     * 点击节点会直接进入编辑态；此时点工具条，commit() 只会把新树塞进
     * pendingTree（要等编辑结束才应用），表现就是「点了删除/新增没反应」。
     * 所以结构操作一律先把当前编辑提交掉，让 canvas 立即重建。
     */
    private endEditBeforeStructuralOp(): void {
        if (this.editSession) this.commitEditSession();
    }

    /** 新增子节点。 */
    private addChild(): void {
        if (!this.selectedUid || !this.currentTree) return;
        this.endEditBeforeStructuralOp();
        this.commit(addChildNode(this.markdown, this.currentTree, this.selectedUid));
    }

    /** 新增兄弟节点。 */
    private addSibling(): void {
        if (!this.selectedUid || !this.currentTree) return;
        this.endEditBeforeStructuralOp();
        this.commit(addSiblingNode(this.markdown, this.currentTree, this.selectedUid));
    }

    /**
     * 删除选中节点整棵子树。
     *
     * 有子项（或元数据整块）的节点要「两次点击」：
     * - 第一次：不删，只把工具条上的删除按钮变红并改成「确认删除」；
     * - 4 秒内再点一次：真正删除；
     * - 超时 / 选中别的节点 / 点空白：红色待确认态自动复位。
     *
     * 叶子节点仍然一次点击直接删（没有误删风险，保持顺手）。
     * 这里不再用 window.confirm —— webview 里原生确认框不显示，
     * 用户看到的就是「点删除没反应」。
     */
    private deleteSelected(): void {
        if (!this.selectedUid || !this.currentTree) return;
        // 删除前先结束编辑：否则 commit() 只写 pendingTree，点了删除看不到变化
        this.endEditBeforeStructuralOp();
        const uid = this.selectedUid;
        const found = findTreeNodeByUid(this.currentTree, uid);
        if (!found) return;
        const childCount = countSubtreeNodes(found.node);
        const needsConfirm = childCount >= 1 || found.node.data._kind === 'meta';
        if (needsConfirm && this.pendingDeleteUid !== uid) {
            // 键盘 Delete 入口也要能看到红按钮：先确保工具条显示在节点上
            this.showToolbar(uid);
            this.armDelete(uid, childCount);
            return;
        }
        this.clearPendingDelete();
        this.clearSelection();
        this.commit(deleteNode(this.markdown, this.currentTree, uid));
    }

    /** 把删除按钮切成红色「确认删除」态（4 秒后自动复位）。 */
    private armDelete(uid: string, childCount: number): void {
        this.pendingDeleteUid = uid;
        if (this.pendingDeleteTimer !== null) clearTimeout(this.pendingDeleteTimer);
        const button = this.toolbarEl?.querySelector<HTMLButtonElement>(
            'button[data-act="delete"]'
        );
        if (button) {
            button.classList.add('lwm-danger');
            // 文案带子项数量，点之前就知道会连带删掉多少
            button.textContent = childCount > 0 ? `确认删除（${childCount} 项）` : '确认删除';
        }
        this.pendingDeleteTimer = setTimeout(() => {
            this.pendingDeleteTimer = null;
            this.clearPendingDelete();
        }, 4000);
    }

    /** 复位「待确认删除」状态与按钮外观。 */
    private clearPendingDelete(): void {
        this.pendingDeleteUid = null;
        if (this.pendingDeleteTimer !== null) {
            clearTimeout(this.pendingDeleteTimer);
            this.pendingDeleteTimer = null;
        }
        const button = this.toolbarEl?.querySelector<HTMLButtonElement>(
            'button[data-act="delete"]'
        );
        if (button) {
            button.classList.remove('lwm-danger');
            button.textContent = '删除';
        }
    }

    /** 展开按钮事件：同步 collapsedUids 与数据树的 expand 标记。 */
    private handleExpandChange(uid: string, expanded: boolean, recursive: boolean): void {
        const apply = (tree: MindMapTreeNode): void => {
            tree.data.expand = expanded;
            if (expanded) this.collapsedUids.delete(tree.data.uid);
            else this.collapsedUids.add(tree.data.uid);
            if (recursive) tree.children.forEach(apply);
        };
        if (!this.currentTree) return;
        const found = findTreeNodeByUid(this.currentTree, uid);
        if (found) {
            apply(found.node);
        } else if (expanded) {
            this.collapsedUids.delete(uid);
        } else {
            this.collapsedUids.add(uid);
        }
    }

    /** 全部展开（右键菜单）。 */
    private expandAllNodes(): void {
        if (!this.currentTree) return;
        this.collapsedUids.clear();
        const walk = (tree: MindMapTreeNode): void => {
            tree.data.expand = true;
            tree.children.forEach(walk);
        };
        walk(this.currentTree);
        this.canvas.expandAll();
    }

    // ==================================================================
    // 大纲联动 / 搜索
    // ==================================================================

    /**
     * 大纲点击联动：选中对应标题节点并画布居中。
     *
     * @param line0 0-based 行号（标题行）
     * @returns 找到对应标题节点时返回 true
     */
    selectNodeAtLine(line0: number): boolean {
        if (!this.currentTree || !this.active) return false;
        let targetUid: string | null = null;
        const walk = (node: MindMapTreeNode): void => {
            if (targetUid) return;
            if (node.data._kind === 'heading' && node.data._lineRange?.fromLine === line0) {
                targetUid = node.data.uid;
                return;
            }
            node.children.forEach(walk);
        };
        walk(this.currentTree);
        if (!targetUid) return false;
        this.selectAndCenterUid(targetUid);
        return true;
    }

    /** 选中并居中（目标被折叠祖先藏住时先展开祖先）。 */
    private selectAndCenterUid(uid: string): void {
        const parts = uid.split('/');
        let prefix = '';
        for (let i = 0; i < parts.length - 1; i += 1) {
            prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
            this.collapsedUids.delete(prefix);
        }
        this.canvas.revealUid(uid);
        if (!this.canvas.getNode(uid)) return;
        this.selectNode(uid);
        this.canvas.centerOn(uid);
    }

    /** 应用搜索高亮（命中节点描边，当前项加深）。 */
    private applySearchHighlight(uids: string[], currentUid: string | null): void {
        // 画布自己记住命中集合：节点重新挂载 / 重建后会自动补类名
        this.canvas.setSearchHighlight(uids, currentUid);
    }

    /**
     * 行号 → 节点 uid（搜索映射）：取包含该行的最深节点。
     */
    private findNodeUidAtLine(line0: number): string | null {
        if (!this.currentTree) return null;
        // 用对象包一层：回调里的赋值不会被 TS 的控制流分析跟踪，
        // 直接写 let best 会在 walk() 之后被误收窄成 never
        const state: { best: { uid: string; span: number } | null } = { best: null };
        const walk = (node: MindMapTreeNode): void => {
            const range = node.data._lineRange;
            if (range && line0 >= range.fromLine && line0 <= range.toLine) {
                const span = range.toLine - range.fromLine;
                if (!state.best || span < state.best.span) {
                    state.best = { uid: node.data.uid, span };
                }
            }
            node.children.forEach(walk);
        };
        walk(this.currentTree);
        return state.best?.uid ?? null;
    }

    // ==================================================================
    // 拖动
    // ==================================================================

    /** 落点预校验：类型不变、各走各的链，para/root 不可拖。 */
    private validateDropParent(dragUid: string, parentUid: string): boolean {
        const drag = this.canvas.getNode(dragUid);
        const parent = this.canvas.getNode(parentUid);
        if (!drag || !parent) return false;
        const kind = drag.kind;
        const media = isMediaKind(kind);
        if (kind !== 'heading' && kind !== 'list' && !media) return false;
        const parentKind = parent.kind;
        if (
            (kind === 'heading' || kind === 'list' || media) &&
            parentKind !== 'root' &&
            parentKind !== 'heading' &&
            parentKind !== 'list'
        ) {
            return false;
        }
        // 禁止拖进自己的子树
        let ancestor: MapNode | null = parent;
        while (ancestor) {
            if (ancestor.uid === dragUid) return false;
            ancestor = ancestor.parent;
        }
        return true;
    }

    /**
     * 拖动结束：按落点回写 md，然后按「旧 uid → 新 uid」映射复用 DOM。
     */
    private handleDrop(payload: DropPayload): void {
        if (!this.currentTree) return;
        const { dragUid, parentUid, prevUid, nextUid } = payload;
        if (!this.validateDropParent(dragUid, parentUid)) {
            // 非法落点：用当前树重排一次，让被拖节点回到原位
            this.canvas.setData(this.bakeExpandState(this.currentTree), { keepView: true });
            return;
        }
        const result = moveNode({
            markdown: this.markdown,
            tree: this.currentTree,
            dragUid,
            newParentUid: parentUid,
            anchorUid: prevUid,
            nextUid,
        });
        if (!result.text || result.text === this.markdown) {
            // 原地放下（位置没变）：重排一次即可
            this.canvas.setData(this.bakeExpandState(this.currentTree), { keepView: true });
            return;
        }

        const previousTree = this.currentTree;
        const newTree = buildMindMapTree(result.text, this.fileName);
        const remap = this.computeDropRemap(dragUid, parentUid, previousTree, newTree);
        // uid 是路径，拖动后整棵被拖子树都会换 uid：把按 uid 记的
        // 展开/折叠/已知集合与画布标记一起重定向，否则折叠态会丢。
        this.remapUidSets(remap);
        this.canvas.remapFlags(remap);
        this.setMarkdown(result.text);
        this.currentTree = newTree;
        this.canvas.setData(this.bakeExpandState(newTree), {
            uidRemap: remap,
            keepView: true,
        });
        this.options.onEdit(result.text);
        this.searchBar.refreshAfterDocumentChange();
        // 拖动后选中被移动的节点（uid 可能变了）
        const newUid = remap.get(dragUid) ?? dragUid;
        if (this.canvas.getNode(newUid)) {
            this.selectedUid = newUid;
            this.canvas.setSelected(newUid);
            this.showToolbar(newUid);
        }
        void previousTree;
    }

    /** 拖动后把按 uid 记账的本地集合整体重定向。 */
    private remapUidSets(remap: Map<string, string>): void {
        if (remap.size === 0) return;
        const remapSet = (set: Set<string>): void => {
            const next = new Set<string>();
            for (const uid of set) next.add(remap.get(uid) ?? uid);
            set.clear();
            for (const uid of next) set.add(uid);
        };
        remapSet(this.expandedUids);
        remapSet(this.collapsedUids);
        remapSet(this.knownUids);
        if (this.selectedUid) this.selectedUid = remap.get(this.selectedUid) ?? this.selectedUid;
    }

    /**
     * 拖动后计算旧 uid → 新 uid。
     *
     * uid 是结构路径，移动会让整棵被拖子树的路径变化；但子树形状不变，
     * 因此只要在新父节点下找到「同文本 + 同形状」的那棵子树，就能逐层配对。
     * 配对成功时画布直接把旧 wrapper / mini-CM 搬过去，拖动后零重建。
     */
    private computeDropRemap(
        dragUid: string,
        parentUid: string,
        oldTree: MindMapTreeNode,
        newTree: MindMapTreeNode
    ): Map<string, string> {
        const remap = new Map<string, string>();
        // 匹配签名只认「类型 + 文本」：标题拖动后层级会变（# → ##），
        // 文本不变，仍然应该复用原来的显示实例（内容重建交给 ensureContent）。
        const signature = (node: MindMapTreeNode): string =>
            `${node.data._kind}\u0000${node.data.text}`;

        /**
         * 对齐两棵树上同一父节点下的子节点。
         *
         * 拖动一个节点会让它后面所有兄弟的 uid 整体前移（0/2 → 0/1 …），
         * 只按相同 uid 复用的话，这些兄弟全部「内容不匹配 → 销毁重建」，
         * 大文档一次 drop 要重建几十个 mini-CM（实测 ~900ms）。
         * 用 LCS 按内容对齐后，除被拖走的子树外都能原地复用。
         */
        const alignChildren = (oldParent: MindMapTreeNode, newParent: MindMapTreeNode): void => {
            const a = oldParent.children;
            const b = newParent.children;
            const n = a.length;
            const m = b.length;
            if (n === 0 || m === 0) return;
            if (n * m > 200_000) {
                // 极端宽的层级：退回按签名分桶的顺序匹配，避免 DP 占内存
                const buckets = new Map<string, MindMapTreeNode[]>();
                for (const node of b) {
                    const key = signature(node);
                    const list = buckets.get(key);
                    if (list) list.push(node);
                    else buckets.set(key, [node]);
                }
                for (const oldChild of a) {
                    const match = buckets.get(signature(oldChild))?.shift();
                    if (match) {
                        remap.set(oldChild.data.uid, match.data.uid);
                        alignChildren(oldChild, match);
                    }
                }
                return;
            }
            // DP：dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度
            const dp: number[][] = Array.from({ length: n + 1 }, () =>
                new Array<number>(m + 1).fill(0)
            );
            for (let i = n - 1; i >= 0; i -= 1) {
                for (let j = m - 1; j >= 0; j -= 1) {
                    dp[i][j] =
                        signature(a[i]) === signature(b[j])
                            ? dp[i + 1][j + 1] + 1
                            : Math.max(dp[i + 1][j], dp[i][j + 1]);
                }
            }
            let i = 0;
            let j = 0;
            while (i < n && j < m) {
                if (signature(a[i]) === signature(b[j])) {
                    remap.set(a[i].data.uid, b[j].data.uid);
                    alignChildren(a[i], b[j]);
                    i += 1;
                    j += 1;
                } else if (dp[i + 1][j] >= dp[i][j + 1]) {
                    i += 1;
                } else {
                    j += 1;
                }
            }
        };

        // 根节点 uid 恒为 "0"
        remap.set(oldTree.data.uid, newTree.data.uid);
        alignChildren(oldTree, newTree);

        // 被拖子树单独配对：它跨了父层，上面的按兄弟对齐匹配不到。
        // 落到新父节点下找「同文本 + 同类型 + 同子节点数」的那棵。
        const oldNode = this.canvas.getNode(dragUid);
        const newParent = findTreeNodeByUid(newTree, parentUid)?.node;
        if (!oldNode || !newParent) return remap;
        let target: MindMapTreeNode | null = null;
        for (const child of newParent.children) {
            if (
                child.data.text === oldNode.text &&
                child.data._kind === oldNode.kind &&
                child.children.length === oldNode.children.length
            ) {
                target = child;
                break;
            }
        }
        if (!target) return remap;
        const pair = (from: MapNode, to: MindMapTreeNode): void => {
            remap.set(from.uid, to.data.uid);
            const count = Math.min(from.children.length, to.children.length);
            for (let i = 0; i < count; i += 1) {
                pair(from.children[i], to.children[i]);
            }
        };
        pair(oldNode, target);
        return remap;
    }

    // ==================================================================
    // 右键菜单 / 导出
    // ==================================================================

    /** 创建全局右键菜单（导出 / 适应画布 / 全部展开）。 */
    private createContextMenu(): void {
        this.container.addEventListener('contextmenu', this.onContainerContextMenu);
        document.addEventListener('click', this.onDocumentClick);
        document.addEventListener('keydown', this.onDocumentKeyDown);
        window.addEventListener('blur', this.onWindowBlur);
    }

    /** 打开右键菜单（贴不住右下就往左/上翻）。 */
    private openContextMenu(
        event: MouseEvent,
        table: { uid: string; display: NodeDisplay } | null = null
    ): void {
        this.closeContextMenu();
        // 本轮的表格上下文：菜单项点击时用它执行命令
        this.tableMenuContext = table;
        const menu = document.createElement('div');
        menu.className = 'lwm-context-menu';
        const items: Array<{ label: string; action: () => void } | 'sep'> = [];
        // 表格节点：增删行列与 live 模式完全同一组菜单项（含顺序/文案）
        if (table) {
            for (const item of TABLE_MENU_ITEMS) {
                items.push({
                    label: item.label,
                    action: () => this.runTableMenuCommand(item.action),
                });
            }
            items.push('sep');
        }
        if (this.options.onExport) {
            items.push(
                { label: '导出 PNG', action: () => void this.handleExport('png') },
                { label: '导出 SVG', action: () => void this.handleExport('svg') },
                { label: '导出 PDF', action: () => void this.handleExport('pdf') },
                'sep'
            );
        }
        items.push(
            { label: '适应画布', action: () => this.canvas.fit() },
            { label: '全部展开', action: () => this.expandAllNodes() }
        );
        for (const item of items) {
            if (item === 'sep') {
                const sep = document.createElement('div');
                sep.className = 'lwm-context-sep';
                menu.appendChild(sep);
                continue;
            }
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = item.label;
            button.addEventListener('click', (e) => {
                e.stopPropagation();
                // 保留表格上下文：命令要用 display 执行，执行完自己收尾并降档；
                // 这里要是走默认关闭，临时全量实例会先被销毁，命令就作用在
                // 一个已经 destroy 的 EditorView 上。
                this.closeContextMenu(true);
                item.action();
            });
            menu.appendChild(button);
        }
        document.body.appendChild(menu);
        const rect = menu.getBoundingClientRect();
        let x = event.clientX;
        let y = event.clientY;
        if (x + rect.width > window.innerWidth - 4) x = window.innerWidth - rect.width - 4;
        if (y + rect.height > window.innerHeight - 4) y = window.innerHeight - rect.height - 4;
        menu.style.left = `${Math.max(4, x)}px`;
        menu.style.top = `${Math.max(4, y)}px`;
        this.contextMenuEl = menu;
    }

    /**
     * 关闭右键菜单。
     *
     * @param keepTableContext - true = 保留表格上下文（菜单项点击后由命令
     *        自己收尾）。默认 false：顺手把右键时临时提升的全量显示实例
     *        降回当前渲染档，避免「只看了一眼菜单，节点就一直全量渲染」。
     */
    private closeContextMenu(keepTableContext = false): void {
        this.contextMenuEl?.remove();
        this.contextMenuEl = null;
        if (keepTableContext) return;
        const table = this.tableMenuContext;
        this.tableMenuContext = null;
        // 编辑会话里的 display 不能动（refreshNode 会重建 DOM 打断输入）
        if (table && this.editSession?.uid !== table.uid) {
            // 右键把选区挪进了格子（表格 widget 会暂时变回源码），先复位
            table.display.resetSelection();
            this.canvas.refreshNode(table.uid, true);
        }
    }

    /**
     * 解析右键落点是否落在表格节点的某一格上。
     *
     * 与 live 模式的行为对齐（main.ts 的 resolveTableContext）：
     * 不进入编辑态、不弹 node 自己的菜单，而是把**整格**变成选区，
     * 后续增删行列作用在「选区覆盖的格子」上。
     *
     * @param event - contextmenu 事件
     * @returns 表格节点 uid + 可执行命令的显示实例；不是表格格子时返回 null
     */
    private resolveTableMenuContext(
        event: MouseEvent
    ): { uid: string; display: NodeDisplay } | null {
        const target = event.target instanceof Element ? event.target : null;
        const wrapper = target?.closest<HTMLElement>('.lwm-node[data-kind="table"]');
        if (!wrapper || !wrapper.closest('.lwm-node-layer')) return null;
        const uid = wrapper.dataset.uid;
        if (!uid) return null;
        // 缩放降级档下节点可能只有占位文本，没有表格 widget / 可定位的 CM：
        // 强制建一个全量实例（菜单关闭或命令执行完再按档降回去）
        const modeBefore = this.canvas.getDisplayMode(uid);
        const display = this.canvas.ensureEditDisplay(uid);
        if (!display) return null;
        const pos = this.tablePosAtEvent(display.view, event);
        const cell = pos == null ? null : cellAt(display.view.state, pos);
        if (!cell) {
            // 点在节点边框 / 表格外面：菜单照常弹，但别把临时全量实例留着
            if (modeBefore !== 'full' && this.editSession?.uid !== uid) {
                this.canvas.refreshNode(uid, true);
            }
            return null;
        }
        const selection = display.view.state.selection.main;
        // 已经框选了一片格子、右键又落在选区里：保持框选（与 live 一致）
        const insideSelection =
            !selection.empty && selection.from <= cell.to && cell.from <= selection.to;
        if (!insideSelection) {
            display.view.dispatch({ selection: { anchor: cell.from, head: cell.to } });
        }
        return { uid, display };
    }

    /**
     * 右键落点 → 表格源码里的文档位置。
     *
     * 不能只靠 `view.posAtCoords`：导图节点的 mini-CM 里，表格行被 live
     * 预览的行装饰撑高（实测约 30px 一行），而 CM 的高度缓存还停在装饰
     * 生效前的 14px。posAtCoords 是「y → 高度缓存里的行 → 行内扫描」，
     * 缓存对不上时要么返回 null，要么落到分隔行（cellAt 按设计返回 null）。
     *
     * 这里优先用真实 DOM：`event.target` 往上找 `.cm-line`，再用
     * `posAtDOM` 换成文档位置 —— 行一定是对的；列再按点击 x 与这一行
     * 各格子在屏幕上的左右区间比较，取最近的一格（`coordsAtPos` 直接读
     * 行内 DOM，不受高度缓存影响）。
     *
     * @param view - 表格节点的 mini-CM
     * @param event - contextmenu 事件
     * @returns 文档位置；完全定位不到时返回 null
     */
    private tablePosAtEvent(view: EditorView, event: MouseEvent): number | null {
        const target = event.target instanceof Element ? event.target : null;
        // event.target 可能已经脱离 DOM：降级档里右键的是占位文本，
        // ensureEditDisplay 刚把它整块 replaceChildren 成真实 CM，旧节点
        // 已经不在文档里。这时按坐标重新做一次命中测试，拿到新的 .cm-line。
        const targetLine = target?.closest('.cm-line') ?? null;
        const hit =
            targetLine && view.contentDOM.contains(targetLine)
                ? targetLine
                : (document
                      .elementFromPoint(event.clientX, event.clientY)
                      ?.closest('.cm-line') ?? null);
        const lineEl =
            hit && view.contentDOM.contains(hit) ? hit : null;
        if (lineEl) {
            try {
                // 行首位置（posAtDOM 按真实 DOM 结构映射，不走高度缓存）
                const linePos = view.posAtDOM(lineEl, 0);
                return this.nearestCellPosByX(view, linePos, event.clientX) ?? linePos;
            } catch {
                // DOM 映射失败（例如行正在被替换）：退回原生坐标命中
            }
        }
        // CM 的 posAtCoords 类型是 number | null，实测在高度缓存异常时
        // 会真的返回 undefined，这里统一归一成 null
        return view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? null;
    }

    /**
     * 在一行里按点击 x 找最接近的格子起点。
     *
     * @param view - 编辑器视图
     * @param linePos - 这一行的任意文档位置
     * @param x - 点击的视口 x
     * @returns 最近格子的行内起点；不是表格行时返回 null
     */
    private nearestCellPosByX(
        view: EditorView,
        linePos: number,
        x: number
    ): number | null {
        const line = view.state.doc.lineAt(linePos);
        const segments = splitRowText(line.text);
        if (segments.length === 0) return null;
        let best: number | null = null;
        let bestDist = Number.POSITIVE_INFINITY;
        for (const seg of segments) {
            const from = line.from + seg.from;
            const to = line.from + seg.to;
            // 格子左右边界：首字符右侧 / 末字符右侧；取不到就跳过
            const startRect = view.coordsAtPos(from, 1) ?? view.coordsAtPos(from);
            const endRect = view.coordsAtPos(to, -1) ?? view.coordsAtPos(to);
            if (!startRect) continue;
            const left = startRect.left;
            const right = endRect ? endRect.right : startRect.right;
            const dist = x < left ? left - x : x > right ? x - right : 0;
            if (dist < bestDist) {
                bestDist = dist;
                best = from;
            }
        }
        return best;
    }

    /**
     * 执行一项表格命令并把结果写回源文档。
     *
     * 显示态 mini-CM 是只读的，runTableCommand 会检查 editable，所以用
     * withEditable 临时放开；命令改的是同一份 EditorState，执行完
     * getText() 就是新表格源码，走 renameNode → commit 给宿主回写。
     *
     * @param command - 表格命令（增删行列）
     */
    private runTableMenuCommand(command: TableCommand): void {
        const table = this.tableMenuContext;
        this.tableMenuContext = null;
        if (!table || !this.currentTree) return;
        const { uid, display } = table;
        const view = display.view;
        // 正在编辑同一个表格节点：命令直接改编辑会话的 view。与 live 模式
        // 一致，改完**保持编辑态**，走失焦 / Esc 的统一提交链路
        // （finishEdit 里 renameNode → commit），不在这里额外退出编辑。
        const session = this.editSession?.uid === uid ? this.editSession : null;
        const changed = display.withEditable(() =>
            runTableCommand(view, command, view.state.selection.main.from)
        );
        if (changed) {
            if (session) return;
            const text = display.getText();
            const next = renameNode(this.markdown, this.currentTree, uid, text);
            if (next.text !== this.markdown) {
                this.commit({ text: next.text });
                return;
            }
        }
        // 没改动（例如只剩一列不能删）或文档内容碰巧没变：
        // 编辑会话保持原样，否则把临时全量实例降回当前档
        if (!session) this.canvas.refreshNode(uid, true);
    }

    /**
     * 执行导出：画布克隆 → SVG / PNG / PDF → onExport 交宿主存盘。
     */
    private async handleExport(format: 'png' | 'svg' | 'pdf'): Promise<void> {
        if (!this.options.onExport || this.exportInFlight) return;
        this.exportInFlight = true;
        const name = this.fileName || 'mindmap';
        try {
            const { svg, width, height } = this.canvas.buildExportSvg();
            if (format === 'svg') {
                this.options.onExport({ format, name, svgText: svg });
            } else {
                const raster = await rasterizeSvg(svg, width, height, format === 'png' ? 2 : 1.5);
                const dataUrl =
                    format === 'png' ? toPngDataUrl(raster.canvas) : toPdfDataUrl(raster.canvas);
                this.options.onExport({ format, name, dataUrl });
            }
        } catch (error) {
            const notice = document.createElement('div');
            notice.className = 'lwm-perf-notice';
            notice.textContent = `导出失败: ${
                error instanceof Error ? error.message : String(error)
            }`;
            this.container.appendChild(notice);
            setTimeout(() => notice.remove(), 3000);
        } finally {
            this.exportInFlight = false;
        }
    }

    // ==================================================================
    // 键盘 / 浮层
    // ==================================================================

    /** 导图内快捷键：Ctrl+Z/Y、Ctrl+F/H、Tab、Enter、F2、Delete。 */
    private handleWindowKeyDown = (event: KeyboardEvent): void => {
        if (!this.active || this.editSession) return;
        const target = event.target as HTMLElement | null;
        if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

        const key = event.key.toLowerCase();
        if ((event.ctrlKey || event.metaKey) && !event.altKey) {
            if (key === 'f') {
                event.preventDefault();
                event.stopPropagation();
                this.searchBar.open(false);
                return;
            }
            if (key === 'h') {
                event.preventDefault();
                event.stopPropagation();
                this.searchBar.open(true);
                return;
            }
            if (key === 'z' && !event.shiftKey && this.options.onUndo) {
                event.preventDefault();
                event.stopPropagation();
                this.options.onUndo();
                return;
            }
            if ((key === 'y' || (key === 'z' && event.shiftKey)) && this.options.onRedo) {
                event.preventDefault();
                event.stopPropagation();
                this.options.onRedo();
                return;
            }
            // live 模式的行内格式三连：加粗 / 斜体 / 行内代码。
            // 必须排在 redo 之后：Ctrl+Shift+Z 是重做，不能被当成别的键。
            if (!event.shiftKey && (key === 'b' || key === 'i' || key === 'g')) {
                // 没选中节点时放行，避免把快捷键吞掉却什么都不做
                if (!this.selectedUid) return;
                event.preventDefault();
                event.stopPropagation();
                this.applyInlineFormat(
                    this.selectedUid,
                    key === 'b' ? toggleBold : key === 'i' ? toggleItalic : toggleInlineCode,
                );
                return;
            }
        }
        if (!this.selectedUid) return;
        const node = this.canvas.getNode(this.selectedUid);
        if (!node) return;
        const kind = node.kind;
        const media = isMediaKind(kind);
        if (event.key === 'Tab' && kind !== 'para' && kind !== 'meta' && !media) {
            event.preventDefault();
            this.addChild();
        } else if (
            event.key === 'Enter' &&
            kind !== 'para' &&
            kind !== 'meta' &&
            kind !== 'root' &&
            !media
        ) {
            event.preventDefault();
            this.addSibling();
        } else if (event.key === 'F2') {
            event.preventDefault();
            this.startEdit(this.selectedUid);
        } else if ((event.key === 'Delete' || event.key === 'Backspace') && kind !== 'root') {
            event.preventDefault();
            this.deleteSelected();
        }
    };

    /** 空文档提示浮层。 */
    private toggleEmptyHint(empty: boolean): void {
        const existing = this.container.querySelector<HTMLElement>('.lwm-empty-hint');
        existing?.remove();
        if (!empty || !this.active) return;
        const hint = document.createElement('div');
        hint.className = 'lwm-empty-hint';
        hint.textContent =
            '文档还没有标题或列表：选中根节点后按 Tab（或工具条「＋子节点」）开始编写。';
        this.container.appendChild(hint);
    }

}

/**
 * 去掉列表项源码的公共行首缩进（导图单元格渲染用）。
 *
 * 嵌套列表项在源文档里带父级缩进（空格或 Tab），但单元格本身已经是
 * 独立的节点，缩进再画进去就会在格子左侧多出一截空白（有序 / 无序同此）。
 *
 * 以首行为基准整体左移，续行保留相对缩进：
 * ```
 *   - foo          ->  - foo
 *     bar          ->    bar
 * ```
 * 首行没有缩进（顶层列表项）时原样返回，避免无谓的字符串复制。
 *
 * @param source 列表项自身的源码行（`_selfLineRange` 切片）
 * @returns 去掉公共缩进后的源码
 */
function dedentListSource(source: string): string {
    const lines = source.split('\n');
    const indent = /^[ \t]*/.exec(lines[0] ?? '')?.[0] ?? '';
    if (!indent) return source;
    return lines
        .map((line) =>
            line.startsWith(indent)
                ? line.slice(indent.length)
                : // 懒续行可能比首行缩进更浅：兜底去掉自己的行首空白
                  line.replace(/^[ \t]+/, '')
        )
        .join('\n');
}
