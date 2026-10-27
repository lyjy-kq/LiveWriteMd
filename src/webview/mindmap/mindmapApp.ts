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
import { TABLE_MENU_ITEMS } from '../editing/editorContextMenu.js';
import { cellAt, splitRowText } from '../codemirror/extensions/livePreview/tableRender.js';
import {
    runTableCommand,
    type TableCommand,
} from '../codemirror/extensions/livePreview/tableCommands.js';
import type { NodeDisplay } from './miniCm.js';
import { MindmapSearchBar } from './searchBar.js';
import { ensureMindMapCss } from './mindmapStyles.js';
import { PerfHud } from './perfHud.js';
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
    deleteChildNodes,
    deleteNode,
    deleteNodes,
    deleteSelfKeepChildren,
    extractSubtreeText,
    findNodeByUid as findTreeNodeByUid,
    insertSubtreeFromText,
    isMediaKind,
    moveNode,
    renameNode,
    type NewNodeSpec,
} from './markdownEdit.js';
// 写剪贴板走扩展侧 relay（webview 直接写剪贴板在 VS Code 里不稳定）；
// 探针 / 纯浏览器环境没注入 postMessage 时退回 navigator.clipboard
import { copyToClipboard } from '../codemirror/extensions/livePreview/state.js';
// 内链（[[#标题]] / [文字](#标题)）的提取与标题匹配规则与 live 侧共用
import {
    extractInternalLinkTargets,
    matchHeadingIndex,
} from '../../shared/link/internalLink.js';

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
    // 内链箭头层：默认开启
    mindmapInternalLinks: true,
    // 性能监控浮层：默认关闭（开了才有采样开销）
    mindmapPerfHud: false,
};

/**
 * 文本节点：编辑中内容变高（回车换行 / 长行折行）时要把单元格撑高。
 * 代码、表格、公式等媒体节点不在此列 —— 它们编辑时保持盒内滚动。
 */
const TEXT_NODE_KINDS = new Set<MindMapNodeKind>(['heading', 'list', 'para', 'quote']);

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
    /**
     * 进入编辑前的节点宽度。
     *
     * 数学块在编辑态会按源码自然宽度撑宽（LaTeX 比渲染后的公式长），
     * 文本没变时退出编辑要退回这个宽度，避免节点越编辑越宽。
     */
    baseWidth: number;
    display: NonNullable<ReturnType<MapCanvas['getDisplay']>>;
}

/**
 * 「拆分到子节点」的选区快照。
 *
 * 必须在选区变化的那一刻备好：点击工具条按钮会让编辑区失焦，
 * mini-CM 的 blur 处理器会立刻把编辑会话提交掉（editSession 变 null），
 * 等 click 的 action 执行时再读选区已经来不及了。
 */
interface SplitCapture {
    uid: string;
    from: number;
    to: number;
    /** 选中文字（换行已压成空格的单行） */
    text: string;
    /** 快照时节点的完整文本（去哨兵行） */
    fullText: string;
}

export class MindMapApp {
    private readonly container: HTMLElement;
    private readonly options: MindMapAppOptions;
    /** 自研画布引擎。 */
    private readonly canvas: MapCanvas;
    /** 导图内搜索条。 */
    private readonly searchBar: MindmapSearchBar;
    /** 性能监控浮层（设置开启时非 null）。 */
    private perfHud: PerfHud | null = null;

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
    /**
     * 「拆分到子节点」的最新选区快照（选区变化时刷新）。
     * 按钮点击时编辑会话可能已被 blur 提交掉，只能用这份快照。
     */
    private splitCapture: SplitCapture | null = null;
    /** 编辑中撑高节点的合并帧：每帧最多量一次内容高度，别每个按键都强制布局。 */
    private growFrame: number | null = null;

    /** 浮动工具条。 */
    private toolbarEl: HTMLDivElement | null = null;
    private toolbarTimer: ReturnType<typeof setInterval> | null = null;
    /**
     * 多选浮动操作条（顶部居中）。
     *
     * Ctrl 多选 / 框选之后必须有一个明确的「删除全部选中项」入口：
     * 单节点工具条上那个「删除」的语义是按当前节点算的，多选时显示它
     * 既容易误点、也看不出到底会删几个。这条独立的操作条只在多选集合
     * 非空时出现，文案直接带数量。
     */
    private multiBarEl: HTMLDivElement | null = null;
    /**
     * 「待确认删除」的节点 uid（第一次点删除后按钮变红）。
     *
     * 不用 window.confirm：VS Code webview 里原生确认框会被吞掉，
     * 有子项的节点点删除看起来就像完全没反应。改成按钮内二次确认：
     * 第一次点击把按钮变红（文案「确认删除」），4 秒内再点一次才真正删。
     */
    private pendingDeleteUid: string | null = null;
    private pendingDeleteTimer: ReturnType<typeof setTimeout> | null = null;
    /**
     * 多选集合（Ctrl 点切换 / Ctrl 拖拽框选）。
     *
     * 和 selectedUid 并存：selectedUid 决定工具条锚在哪个节点上，
     * multiSelected 决定 Delete 一次删哪些。框选结束后把 selectedUid
     * 置为最后命中的一个，工具条仍可用。
     */
    private multiSelected = new Set<string>();
    /** 多选删除的「再按一次确认」状态（复用 4 秒自动复位）。 */
    private pendingDeleteMulti = false;
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
            onMarqueeSelect: (uids) => this.applyMarqueeSelection(uids),
            onDisplayEdit: (node, text) => this.handleDisplayEdit(node, text),
            // 内链：节点里的 #锚点 链接（Ctrl+点击）与内链箭头共用同一套跳转
            resolveInternalLink: (target) => this.resolveInternalLinkUid(target),
            onInternalLinkNavigate: (uid) => this.handleInternalLinkNavigate(uid),
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
        // 性能监控浮层：按初始设置挂/摘
        this.syncPerfHud();
        this.createToolbar();
        this.createMultiToolbar();
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
     * 内存统计用：导图内部计数（节点/已挂载/显示实例/连线等）。
     * 字段口径见 MapCanvas.debugState。
     */
    debugStats(): Record<string, unknown> {
        return this.canvas.debugState();
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
        // 外部文档更新可能已删掉 / 移动了节点：多选集合里的 uid 不再可信，
        // 留着会让 Delete 删到同名路径上的另一个节点，直接清空。
        if (this.multiSelected.size > 0) {
            this.multiSelected.clear();
            this.canvas.setMultiSelected(this.multiSelected);
            this.updateMultiBar();
        }
        // 编辑中（输入法组合态）：外部更新延后，保护编辑 DOM
        if (this.editSession) {
            this.pendingTree = tree;
            return;
        }
        this.canvas.setData(this.bakeExpandState(tree));
        // 树变了：内链箭头按新内容重算
        this.syncInternalLinks();
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

        // 内链箭头开关：只影响箭头层（不量尺寸、不动布局），随时可切
        if (previous.mindmapInternalLinks !== this.settings.mindmapInternalLinks) {
            this.syncInternalLinks();
        }

        // 性能监控浮层：开关切换即挂/摘（HUD 内部是 rAF + 500ms 定时器，
        // 隐藏时整个销毁，不留后台采样）
        if (previous.mindmapPerfHud !== this.settings.mindmapPerfHud) {
            this.syncPerfHud();
        }

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
        // 性能监控浮层：停采样、恢复 gBCR 包装
        this.perfHud?.destroy();
        this.perfHud = null;
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
        this.multiBarEl?.remove();
        this.multiBarEl = null;
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
            case 'quote':
                // 引用块：整段源码（含 > 标记）喂给 mini-CM，渲染与 live 一致；
                // 列表项里的引用行带父级缩进，与媒体节点一样先去掉
                return {
                    doc: selfRange ? dedentNodeSource(sliceRange(selfRange)) : node.text,
                    sentinel: true,
                };
            case 'list':
                // 只渲染列表项自身（含首段续行），子列表是独立节点。
                // 必须先去掉父级缩进：嵌套项在源文档里带 2 空格 / 1 个 Tab，
                // 单元格是独立节点，直接把缩进画进去会在格子左边多出一截空白。
                return {
                    doc: selfRange
                        ? dedentNodeSource(sliceRange(selfRange))
                        : node.text,
                    sentinel: true,
                };
            default:
                // code / table / math / mermaid / image / meta：叶子，整段源码。
                // 与列表节点一样去掉公共行首缩进：列表项里的围栏在源文档中
                // 为了挂进列表会缩进到内容列（有序列表嵌套时能到 7 格）。
                // 节点是独立的 mini-CM，缩进 ≥4 格的围栏会被 CommonMark 判成
                // 「缩进代码块」而不是 FencedCode —— mermaid 的块级 widget
                // 根本不会生成，表现就是「mermaid 不渲染」。提交时
                // renameNode 会把缩进按原样补回去。
                return {
                    doc: range ? dedentNodeSource(sliceRange(range)) : node.text,
                    sentinel: true,
                };
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
        // Ctrl / Cmd 点：切换多选，不进入编辑（用户正在组一批节点做批量删除）
        if (event.ctrlKey || event.metaKey) {
            this.toggleMultiSelection(uid);
            return;
        }
        // 单击 = 选中（并且可以顺手拖动节点）；
        // 再点一次**已经选中的**节点才进入编辑。
        //
        // 以前单击直接 startEdit，结果是「想拖节点却先进了编辑」，
        // 而且刚拖选完文字松手也会被当成点击。现在第一下只负责选中，
        // 编辑入口保留在：再次单击、双击、F2 / 工具条。
        // 多选状态下的普通单击要先清掉多选、切回单选，不算「再次点击」。
        const wasSelected = this.selectedUid === uid && this.multiSelected.size === 0;
        this.selectNode(uid);
        if (node.kind === 'root') return;
        if (wasSelected) this.startEdit(uid, event.clientX, event.clientY);
    }

    /**
     * Ctrl 点：把一个节点加入 / 移出多选集合。
     *
     * 集合为空时回落到普通单选，避免「取消最后一个多选后什么都点不了」。
     */
    private toggleMultiSelection(uid: string): void {
        if (this.multiSelected.has(uid)) this.multiSelected.delete(uid);
        else this.multiSelected.add(uid);
        this.canvas.setMultiSelected(this.multiSelected);
        if (this.multiSelected.size > 0) {
            // 多选期间只显示顶部的批量操作条；单节点工具条上的
            // ＋子节点 / ＋兄弟 对一批节点没有意义，先藏起来。
            this.selectedUid = uid;
            this.canvas.setSelected(uid);
            if (this.toolbarEl) this.toolbarEl.style.display = 'none';
            this.updateMultiBar();
        } else {
            this.clearSelection();
        }
    }

    /**
     * 框选结果（画布每次 pointermove 回调）。
     *
     * 框选期间直接覆盖集合；松手后集合保留，按 Delete 删除。
     * 单选 selectedUid 同步到最后一个命中项，工具条跟随。
     */
    private applyMarqueeSelection(uids: string[]): void {
        this.multiSelected = new Set(uids);
        this.canvas.setMultiSelected(this.multiSelected);
        // 多选时不显示工具条：按钮语义（＋子节点 / ＋兄弟）对一批节点没有
        // 意义，删除走键盘 Delete 或右键；这里只同步逻辑选中项。
        // 框选过程中每次都隐藏（可能上一次单选留下的工具条还挂着）。
        this.selectedUid = uids.length > 0 ? uids[uids.length - 1] : null;
        this.canvas.setSelected(this.selectedUid);
        if (this.toolbarEl) this.toolbarEl.style.display = 'none';
        this.updateMultiBar();
    }

    /** 选中节点、显示工具条、联动大纲。 */
    private selectNode(uid: string): void {
        // 换了节点：上一条「待确认删除」作废，避免红按钮跟到别的节点上
        if (this.pendingDeleteUid !== null && this.pendingDeleteUid !== uid) {
            this.clearPendingDelete();
        }
        // 普通点击 = 回到单选，清掉上一轮框选 / 多选
        if (this.multiSelected.size > 0) {
            this.multiSelected.clear();
            this.canvas.setMultiSelected(this.multiSelected);
            this.updateMultiBar();
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
        this.multiSelected.clear();
        this.pendingDeleteMulti = false;
        this.canvas.setMultiSelected(this.multiSelected);
        this.selectedUid = null;
        this.canvas.setSelected(null);
        this.resetDisplaySelections(null);
        if (this.toolbarEl) this.toolbarEl.style.display = 'none';
        this.updateMultiBar();
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
        // 「粘贴」：剪贴板文本解析成子节点挂到当前节点下（Ctrl+V）。
        // meta / 媒体节点没有子节点的概念，showToolbar 里会禁用它
        const pasteButton = document.createElement('button');
        pasteButton.type = 'button';
        pasteButton.dataset.act = 'paste';
        pasteButton.textContent = '粘贴';
        pasteButton.title = '把剪贴板内容解析成节点，挂到当前节点下面（Ctrl+V）';
        bar.appendChild(pasteButton);
        bar.appendChild(this.createDeleteMenu());
        // 「拆分」：只在编辑态选中了文字时出现（见 refreshSplitButton）。
        // 主按钮 = 拆到子节点；悬停二级菜单可选拆到兄弟节点。
        bar.appendChild(this.createSplitMenu());
        // 工具条上的按下事件不要漏给画布（避免触发平移/选中）。
        // 还要 preventDefault 挡住默认的焦点转移：点按钮时编辑中的节点
        // 不该失焦（失焦会立刻 blur 提交会话，「拆分到子节点」这类
        // 依赖选区的操作就会被打断；按钮在 mousedown 时被 hide 还会
        // 连 click 都发不出来）。
        bar.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
            event.preventDefault();
        });
        bar.addEventListener('mousedown', (event) => event.preventDefault());
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
            // 删除的二级菜单项（只删自己 / 只删子节点 / 连同子树）
            const delItem = target.closest<HTMLElement>('[data-del]');
            if (delItem) {
                // class 禁用的项（self：含非标题子节点的标题）：点了不执行
                if (delItem.classList.contains('lwm-item-disabled')) return;
                this.deleteFromMenu(delItem);
                return;
            }
            // 拆分的二级菜单项（拆到子节点 / 拆到兄弟节点）
            const splitItem = target.closest<HTMLElement>('[data-split]');
            if (splitItem) {
                if (this.splitCapture) {
                    this.splitSelection(
                        this.splitCapture,
                        splitItem.dataset.split === 'sibling' ? 'sibling' : 'child'
                    );
                }
                return;
            }
            const button = target.closest<HTMLButtonElement>('button[data-act]');
            if (!button) return;
            if (button.dataset.act === 'split') {
                // 拆分不依赖 selectedUid（编辑会话可能已被失焦提交掉），
                // 全靠选区变化时备好的快照；主按钮 = 拆到子节点
                if (this.splitCapture) {
                    this.splitSelection(this.splitCapture, 'child');
                }
                return;
            }
            if (button.dataset.act === 'paste') {
                // 粘贴是异步的（要读系统剪贴板），且不依赖编辑会话
                void this.pasteFromClipboard();
                return;
            }
            if (!this.selectedUid) return;
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

    /**
     * 多选操作条（顶部居中，独立于单节点工具条）。
     *
     * 只放一个按钮：删除 N 项。第一次点击变红并改成「确认删除 N 项」，
     * 4 秒内再点一次才真正删除 —— 和多选常常一次十几个节点，误删代价
     * 比单节点大得多，和单节点删除保持同一套两段式确认。
     */
    private createMultiToolbar(): void {
        if (this.multiBarEl) return;
        const bar = document.createElement('div');
        bar.className = 'lwm-toolbar lwm-multi-toolbar';
        bar.style.display = 'none';
        // 复制 / 剪切 / 粘贴 + 删除。剪贴板三件套作用在整个多选集合上；
        // 粘贴的落点是最早选中的那个节点（pasteFromClipboard 的口径）
        const addButton = (act: string, label: string, title: string): void => {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.act = act;
            button.textContent = label;
            button.title = title;
            bar.appendChild(button);
        };
        addButton('multi-copy', '复制', '把选中子树以 Markdown 源码复制到剪贴板（Ctrl+C）');
        addButton('multi-cut', '剪切', '复制选中子树并删除（Ctrl+X）');
        addButton('multi-paste', '粘贴', '把剪贴板内容解析成节点，挂到最早选中的节点下面（Ctrl+V）');
        addButton('multi-delete', '删除 0 项', '删除选中的所有节点（再次点击确认）');
        // 操作条自己的事件不能漏给画布（否则点击会被当成空白点击 → 清空多选）
        bar.addEventListener('pointerdown', (event) => event.stopPropagation());
        bar.addEventListener('click', (event) => {
            event.stopPropagation();
            const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
            if (!button) return;
            switch (button.dataset.act) {
                case 'multi-copy':
                    void this.copySelection();
                    break;
                case 'multi-cut':
                    void this.cutSelection();
                    break;
                case 'multi-paste':
                    void this.pasteFromClipboard();
                    break;
                default:
                    this.deleteSelected();
                    break;
            }
        });
        this.container.appendChild(bar);
        this.multiBarEl = bar;
    }

    /** 同步多选操作条的可见性 / 数量 / 待确认态。 */
    private updateMultiBar(): void {
        const bar = this.multiBarEl;
        if (!bar) return;
        const count = this.multiSelected.size;
        if (count === 0) {
            bar.style.display = 'none';
            this.pendingDeleteMulti = false;
            return;
        }
        const button = bar.querySelector<HTMLButtonElement>('button[data-act="multi-delete"]');
        if (button) {
            button.textContent = this.pendingDeleteMulti
                ? `确认删除 ${count} 项`
                : `删除 ${count} 项`;
            button.classList.toggle('lwm-danger', this.pendingDeleteMulti);
        }
        bar.style.display = 'flex';
        this.positionMultiBar();
    }

    /**
     * 多选操作条定位到「最下面的选中节点」的下方。
     *
     * 多选经常跨越好几层（框选一列 / Ctrl 点散点），固定在顶部会离
     * 操作对象很远；贴到最下面那个节点的下缘，和单节点工具条
     * 「跟着节点走」的体感一致。
     */
    private positionMultiBar(): void {
        const bar = this.multiBarEl;
        if (!bar || bar.style.display === 'none' || this.multiSelected.size === 0) {
            return;
        }
        let bottom = -Infinity;
        let left = 0;
        for (const uid of this.multiSelected) {
            const rect = this.canvas.getNodeRect(uid);
            if (!rect) continue;
            if (rect.bottom > bottom) {
                bottom = rect.bottom;
                left = rect.left;
            }
        }
        if (bottom === -Infinity) return;
        bar.style.left = `${left}px`;
        bar.style.top = `${bottom + 6}px`;
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

    /**
     * 造「删除」按钮 + 悬浮二级菜单。
     *
     * 普通点击保留原来的默认行为（删整棵子树，有子项时先变红要二次确认），
     * 悬停展开的二级菜单提供导图里另外两种常见删法：
     * - 只删除自己：子节点整体上移一级，接替当前节点的位置；
     * - 只删除子节点：保留当前节点，清空它下面的分支。
     *
     * 实现方式与「＋子节点 / ＋兄弟」完全一致（`.lwm-tool-menu`），
     * 显示/隐藏交给 CSS 的 :hover，不额外维护开关状态。
     */
    /**
     * 「拆分」按钮 + 悬浮二级菜单（拆到子节点 / 拆到兄弟节点）。
     *
     * 主按钮点击 = 拆到子节点（最常用）。整个菜单只在编辑态有文字
     * 选区时可见（refreshSplitButton 控制），因为拆分作用的对象是
     * 选区而不是节点本身。
     */
    private createSplitMenu(): HTMLDivElement {
        const wrap = document.createElement('div');
        wrap.className = 'lwm-tool-menu';
        wrap.dataset.menu = 'split';
        wrap.style.display = 'none';
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.act = 'split';
        button.textContent = '拆分';
        button.title = '把选中的文字剪到一个新的子节点里；悬停可选拆到兄弟节点';
        wrap.appendChild(button);

        const popup = document.createElement('div');
        popup.className = 'lwm-tool-popup';
        const addItem = (act: 'child' | 'sibling', text: string, title: string): void => {
            const item = document.createElement('button');
            item.type = 'button';
            item.dataset.split = act;
            item.textContent = text;
            item.title = title;
            popup.appendChild(item);
        };
        addItem('child', '拆分到子节点', '选中文字剪成一个新子节点');
        addItem('sibling', '拆分到兄弟节点', '选中文字剪成当前节点后面的同级节点');
        wrap.appendChild(popup);
        return wrap;
    }

    private createDeleteMenu(): HTMLDivElement {
        const wrap = document.createElement('div');
        wrap.className = 'lwm-tool-menu';
        wrap.dataset.menu = 'delete';
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.act = 'delete';
        button.textContent = '删除';
        button.title = '点击删除节点及子节点；悬停选择其它删除方式';
        wrap.appendChild(button);

        const popup = document.createElement('div');
        popup.className = 'lwm-tool-popup';
        const addItem = (
            act: 'subtree' | 'self' | 'children',
            text: string,
            title: string
        ): void => {
            const item = document.createElement('button');
            item.type = 'button';
            item.dataset.del = act;
            item.textContent = text;
            item.title = title;
            popup.appendChild(item);
        };
        // 文案里的数量由 showToolbar 动态补（「（共 N 项）」）
        addItem('subtree', '删除节点及子节点', '连同整棵子树一起删除（与点击「删除」相同）');
        addItem(
            'self',
            '只删除自己',
            '保留子节点，让它们接替当前节点的位置'
        );
        addItem('children', '只删除子节点', '保留当前节点，删掉它下面的所有分支');
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
        // 段落（文本叶子）也能加子节点：addNode 会先把它升级成列表项。
        // 媒体 / meta 仍是真叶子（代码块、表格里塞不进子节点）。
        const childDisabled = kind === 'meta' || media;
        // 段落 / 媒体现在支持加兄弟（普通文本节点），root 与元数据仍不行
        const siblingDisabled = kind === 'root' || kind === 'meta';
        setDisabled('child', childDisabled);
        setDisabled('sibling', siblingDisabled);
        // 粘贴 = 加子节点的一种，禁用口径与「＋子节点」一致（root 除外：
        // root 可以往文末/第一个标题前粘，而 addChild 走的是同一条 root 分支）
        setDisabled('paste', kind === 'meta' || media);
        setDisabled('delete', kind === 'root');
        setMenuDisabled('child', childDisabled);
        setMenuDisabled('sibling', siblingDisabled);
        // 根节点不能删：整个删除菜单（含悬停展开）一起禁用
        setMenuDisabled('delete', kind === 'root');

        // 删除二级菜单：文案带子项数量，「只删除子节点」在没有分支时禁用
        const treeNode =
            this.currentTree && this.selectedUid
                ? findTreeNodeByUid(this.currentTree, this.selectedUid)
                : null;
        const childCount = treeNode ? countSubtreeNodes(treeNode.node) : 0;
        const deleteMenu = this.toolbarEl.querySelector<HTMLElement>(
            '.lwm-tool-menu[data-menu="delete"]'
        );
        const subtreeItem = deleteMenu?.querySelector<HTMLButtonElement>(
            '[data-del="subtree"]'
        );
        if (subtreeItem) {
            subtreeItem.textContent =
                childCount > 0 ? `删除节点及子节点` : '删除节点';
        }
        const childrenItem = deleteMenu?.querySelector<HTMLButtonElement>(
            '[data-del="children"]'
        );
        if (childrenItem) {
            childrenItem.disabled = childCount === 0;
            childrenItem.title =
                childCount === 0
                    ? '当前节点没有子节点'
                    : '保留当前节点，删掉它下面的所有分支';
        }
        // 「只删除自己」的前提是子节点能整体上移一级。标题的子标题可以
        //（## 升 #，天然还是根的子节点），但**非标题**子节点不行：
        // Markdown 没有「节结束」标记，文档中部的顶层段落/列表/表格必然
        // 归入前一个标题的章节 —— 提升出去就挂到了上一个兄弟标题下面
        //（看着像「删了 B，内容全跑进 A」）。这种标题禁用该项并说明原因。
        // 注意用 class 而不是 disabled 属性：禁用按钮不派发鼠标事件，
        // title 里的原因提示会永远看不到。
        const selfItem = deleteMenu?.querySelector<HTMLButtonElement>(
            '[data-del="self"]'
        );
        if (selfItem) {
            const hasNonHeadingChild =
                treeNode?.node.data._kind === 'heading' &&
                treeNode.node.children.some(
                    (child) => child.data._kind !== 'heading'
                );
            selfItem.classList.toggle('lwm-item-disabled', !!hasNonHeadingChild);
            selfItem.title = hasNonHeadingChild
                ? '子节点含段落 / 表格 / 代码等非标题内容：Markdown 里它们无法提升到顶层（会归入上一个标题的章节），请改用其它删除方式'
                : '保留子节点，让它们接替当前节点的位置';
        }
        this.toolbarEl.style.display = 'flex';
        this.positionToolbar();
        if (this.toolbarTimer) clearInterval(this.toolbarTimer);
        // 画布平移/缩放时跟随（onViewChange 已经即时定位，这里是兜底）
        this.toolbarTimer = setInterval(() => this.positionToolbar(), 120);
    }

    /** 工具条定位到选中节点右下方；菜单会按容器边界翻转方向。 */
    private positionToolbar(): void {
        // 多选操作条也要跟帧（它独立显隐，不受单节点工具条状态影响）
        this.positionMultiBar();
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
        // 进入编辑 = 回到单节点操作，框选集合清掉
        if (this.multiSelected.size > 0) {
            this.multiSelected.clear();
            this.canvas.setMultiSelected(this.multiSelected);
            this.updateMultiBar();
        }
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
            // 宽度同理：数学块编辑时按源码撑宽，退出时收回
            baseWidth: current.width,
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
            // 选中一段文字 → 工具条出现「拆分到子节点」；塌回光标 → 收起来
            onSelectionChange: () => this.refreshSplitButton(),
        });
        // 等一帧让 CM 完成重配与布局，再按点击坐标落光标（不全选）。
        // 这一帧里会话可能已经被提交/重建（外部 UPDATE、整树 setData），
        // 那时旧 display 已销毁，再 focusAt 会向已销毁视图派发选区事务。
        requestAnimationFrame(() => {
            if (this.editSession !== session || display.destroyed) return;
            // 媒体节点（公式 / HTML 块 / mermaid / 代码 / 表格 / 图片）：
            // 编辑态显示的是 Markdown 源码，通常比渲染结果宽得多
            // （LaTeX、`<img src="...">`、表格管道行尤其明显）。
            // 进编辑这一帧按源码自然宽度重算一次，**只撑宽不缩窄**
            // （宽度不得低于显示时的宽度）；**高度保持不变**，
            // 装不下的部分在编辑区箱内纵向滚动（见 mindmapStyles）。
            //
            // 但必须有上限（仿 live：源码再长也不该改变排版宽度，
            // 超长的行折行显示）：
            // - 表格：封顶在节点自身的显示上限（60em，与列宽预算同一条
            //   CSS 规则）——宽表的管道源码动辄上千 px，不限会把节点
            //   拉成横跨整个画布；
            // - 其它媒体：允许撑宽看源码，但给一个 60em 的绝对天花板。
            if (isMediaKind(session.kind)) {
                const needed = this.measureEditingSourceWidth(display);
                if (needed > session.baseWidth) {
                    const nodeEl = display.container.closest('.lwm-node');
                    const computedMax = nodeEl
                        ? Number.parseFloat(getComputedStyle(nodeEl).maxWidth)
                        : NaN;
                    const fontSize = Number.parseFloat(
                        getComputedStyle(display.view.contentDOM).fontSize
                    );
                    // 节点没写死上限（或量不到）时用 60em 兜底
                    const fallbackCap = (Number.isFinite(fontSize) ? fontSize : 14) * 60;
                    const nodeCap =
                        Number.isFinite(computedMax) && computedMax > 0
                            ? computedMax
                            : fallbackCap;
                    const cap =
                        session.kind === 'table'
                            ? nodeCap
                            : Math.max(nodeCap, fallbackCap);
                    this.canvas.setNodeWidth(session.uid, Math.min(needed, cap));
                }
            }
            display.focusAt(x, y);
        });
    }

    /**
     * 估算编辑态源码需要多宽（px）。
     *
     * 不用 DOM 量：编辑区的 .cm-line 是自动折行的，scrollWidth 永远等于
     * 盒子宽度，量不出「一整行源码有多长」。用 canvas 按 .cm-content 的
     * 实际字体逐行 measureText（与排版用的是同一套字体，误差只有几个 px），
     * 取最长一行再加上节点左右留白。
     *
     * @param display 已经翻成编辑态的节点显示实例
     * @returns 需要的宽度；拿不到 2D 上下文时返回 0（调用方会跳过撑宽）
     */
    private measureEditingSourceWidth(
        display: NonNullable<ReturnType<MapCanvas['getDisplay']>>
    ): number {
        const content = display.view.contentDOM;
        const style = getComputedStyle(content);
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return 0;
        // 字体必须与 CM 内容一致；canvas 的 font 语法与 CSS 一致
        ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        let max = 0;
        for (const line of display.getText().split('\n')) {
            if (line.length === 0) continue;
            max = Math.max(max, ctx.measureText(line).width);
        }
        if (max <= 0) return 0;
        // 节点内边距 + 光标/滚动条的安全余量
        return Math.ceil(max) + 28;
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
            // 会话可能已经结束，或者显示实例在 rAF 之前被 setData / 换档
            // 销毁（销毁后的 view 仍接受 dispatch，但会带着旧文档位置把
            // CM 的内部状态搞坏，后续 lineAt 越界）。两种情况都直接放弃。
            if (this.editSession !== session || session.display.destroyed) return;
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

    /**
     * 显示态按钮改动了节点本地文档（mermaid 宽度档位 / 表格加行加列）。
     *
     * 这些操作不经过编辑会话，改动只存在于节点的 mini-CM 里。这里按 uid
     * 走 renameNode → commit 回写 markdown；放到微任务里执行，避免在上面的
     * CM dispatch 过程中同步重建整棵树（会把正在派发的 view 销毁掉）。
     * 编辑会话里不处理：那种改动由 blur/Esc 的提交路径统一回写。
     */
    private handleDisplayEdit(node: MapNode, text: string): void {
        if (this.editSession) return;
        const uid = node.uid;
        queueMicrotask(() => {
            if (this.editSession || !this.currentTree) return;
            // 期间可能整树重建过：按 uid 重新确认节点还在
            if (!this.canvas.getNode(uid)) return;
            this.commit(renameNode(this.markdown, this.currentTree, uid, text));
        });
    }

    /** 提交当前编辑会话（如有）。 */
    private commitEditSession(): void {
        const session = this.editSession;
        if (!session) return;
        this.finishEdit(session, session.display.getText());
    }

    /**
     * 刷新「拆分到子节点」按钮：备快照 + 按有无选区显隐。
     *
     * 调用时机：编辑态选区变化（miniCm 的 onSelectionChange）、
     * 会话结束（清空）。选中文字 → 按钮出现；塌成光标 → 按钮消失。
     */
    private refreshSplitButton(): void {
        this.splitCapture = this.captureSplitSelection();
        // 整个「拆分」菜单（主按钮 + 二级菜单）一起显隐
        const menu = this.toolbarEl?.querySelector<HTMLElement>(
            '.lwm-tool-menu[data-menu="split"]'
        );
        if (menu) menu.style.display = this.splitCapture ? '' : 'none';
    }

    /** 「拆分到子节点」当前的选区快照（没有可拆分选区时返回 null）。 */
    private captureSplitSelection(): SplitCapture | null {
        const session = this.editSession;
        // 限文本节点：媒体节点（代码/表格/公式…）编辑的是源码，
        // 从中剪一段走只会得到一截坏语法。
        if (!session || !TEXT_NODE_KINDS.has(session.kind)) return null;
        if (session.display.destroyed) return null;
        const sel = session.display.view.state.selection.main;
        if (sel.empty) return null;
        const text = session.display.view.state
            .sliceDoc(sel.from, sel.to)
            .replace(/\s*\n\s*/g, ' ')
            .trim();
        if (!text) return null;
        return {
            uid: session.uid,
            from: sel.from,
            to: sel.to,
            text,
            fullText: session.display.getText(),
        };
    }

    /**
     * 「拆分到子节点」：把编辑态选中的文字从当前节点剪掉，作为新子节点的内容。
     *
     * 为什么要捕获而不是点菜单时再读选区：点击菜单按钮必然让编辑区
     * **失焦**，而 mini-CM 的 blur 处理器会立刻提交编辑会话 ——
     * 轮到菜单 action 执行时 editSession 已经是 null，现场读的方案
     * 会静默什么都不做（实测「点了没反应」）。所以打开菜单时就把
     * 选区位置 / 选中文字 / 节点全文都快照下来。
     *
     * 执行时按会话是否还活着分两条路：
     * 1. 会话还活着（无头测试 / 焦点没丢）：先在 mini-CM 里挖掉选区，
     *    连同其它未提交改动一起提交；
     * 2. 会话已被失焦提交（真实点击）：源文档里是「剪掉前」的全文，
     *    按快照位置算出删掉选中段后的文本，直接 renameNode 写回。
     * 最后用剪下来的文字新建子节点 / 兄弟节点 —— commit 会自动选中并进编辑。
     *
     * @param placement - child = 新子节点；sibling = 当前节点后面的同级节点
     */
    private splitSelection(captured: SplitCapture, placement: 'child' | 'sibling'): void {
        const session = this.editSession;
        if (
            session &&
            session.uid === captured.uid &&
            !session.display.destroyed
        ) {
            session.display.view.dispatch({
                changes: { from: captured.from, to: captured.to },
            });
            this.commitEditSession();
        } else if (this.currentTree) {
            const newText =
                captured.fullText.slice(0, captured.from) +
                captured.fullText.slice(captured.to);
            this.commit(
                renameNode(this.markdown, this.currentTree, captured.uid, newText)
            );
        }
        if (!this.currentTree) return;
        this.commit(
            placement === 'sibling'
                ? addSiblingNode(
                      this.markdown,
                      this.currentTree,
                      captured.uid,
                      captured.text
                  )
                : addChildNode(
                      this.markdown,
                      this.currentTree,
                      captured.uid,
                      captured.text
                  )
        );
    }

    /** 结束编辑会话：文本有变化走 renameNode → commit。 */
    private finishEdit(session: EditSession, text: string | null): void {
        if (this.editSession !== session) return;
        this.editSession = null;
        // 会话结束：拆分快照作废，按钮收起
        this.splitCapture = null;
        this.refreshSplitButton();
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
            // 树变了：内链箭头按新内容重算
            this.syncInternalLinks();
            this.toggleEmptyHint(tree.children.length === 0);
            return;
        }
        // 文本没变：全量档下显示实例本来就是完整的，exitEdit 已经切回显示态，
        // 就地收尾即可（只把编辑时撑高的盒子收回去）。轻量 / 纯文本档才需要
        // 重建降档，finishEditDisplay 返回 false 时再走 refreshNode。
        if (this.canvas.finishEditDisplay(session.uid, session.baseHeight, session.baseWidth)) {
            return;
        }
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
            // 树变了：内链箭头按新内容重算
            this.syncInternalLinks();
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
        // 多选优先：Ctrl 点 / 框选之后 Delete 一次删一批（二次确认见下）
        if (this.multiSelected.size > 0) {
            this.deleteMultiSelected();
            return;
        }
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

    /**
     * 二级删除菜单：按选项执行不同的删法。
     *
     * 菜单本身已经是一次「明确选择」，所以这里直接提交，不再走键盘 Delete
     * 的两段式确认；节点还在的「只删除子节点」保持选中，工具条继续贴着它。
     *
     * @param item - 带 `data-del` 的菜单项（subtree / self / children）
     */
    private deleteFromMenu(item: HTMLElement): void {
        if (!this.selectedUid) return;
        const act = item.dataset.del;
        // 结构操作前先落掉编辑会话，否则 commit 只会写 pendingTree
        this.endEditBeforeStructuralOp();
        const tree = this.currentTree;
        if (!tree) return;
        const uid = this.selectedUid;
        const found = findTreeNodeByUid(tree, uid);
        if (!found || found.node.data._kind === 'root') return;
        const childCount = countSubtreeNodes(found.node);

        let result: { text: string };
        switch (act) {
            case 'self':
                // 只删自己：子节点上移一级
                result = deleteSelfKeepChildren(this.markdown, tree, uid);
                break;
            case 'children':
                if (childCount === 0) return;
                result = deleteChildNodes(this.markdown, tree, uid);
                // 节点还在，重建后保持选中（不要把工具条一起收掉）
                this.clearPendingDelete();
                this.commit(result);
                if (this.selectedUid === uid) this.showToolbar(uid);
                return;
            default:
                // 含子树：与点击「删除」一致
                result = deleteNode(this.markdown, tree, uid);
                break;
        }
        this.clearPendingDelete();
        this.clearSelection();
        this.commit(result);
    }

    /**
     * 删除多选集合。
     *
     * 与单节点删除同样的「两步确认」：第一次只提示并变红，4 秒内再按一次
     * 才真正删除。框选常常一次选中十几个节点，误删的代价比单节点大得多，
     * 所以不提供「一按就删」。
     */
    private deleteMultiSelected(): void {
        if (!this.currentTree) return;
        this.endEditBeforeStructuralOp();
        // 根节点永远不可删；祖先 + 后代同时选中时 deleteNodes 会去重
        const uids = [...this.multiSelected].filter((uid) => {
            const found = findTreeNodeByUid(this.currentTree!, uid);
            return !!found && found.parent && found.node.data._kind !== 'root';
        });
        if (uids.length === 0) {
            this.clearSelection();
            return;
        }
        if (!this.pendingDeleteMulti) {
            this.pendingDeleteMulti = true;
            // 操作条自己的按钮变红并改成「确认删除 N 项」—— 提示直接
            // 落在用户刚才点的那个按钮上，不用再飘一条独立的提示。
            this.updateMultiBar();
            if (this.pendingDeleteTimer !== null) clearTimeout(this.pendingDeleteTimer);
            this.pendingDeleteTimer = setTimeout(() => {
                this.pendingDeleteTimer = null;
                this.pendingDeleteMulti = false;
                this.updateMultiBar();
            }, 4000);
            return;
        }
        this.pendingDeleteMulti = false;
        if (this.pendingDeleteTimer !== null) {
            clearTimeout(this.pendingDeleteTimer);
            this.pendingDeleteTimer = null;
        }
        // 先清选中再重建：setData 后旧 uid 已失效，留着只会选中错节点
        const tree = this.currentTree;
        this.multiSelected.clear();
        this.canvas.setMultiSelected(this.multiSelected);
        this.selectedUid = null;
        this.canvas.setSelected(null);
        this.clearPendingDelete();
        if (this.toolbarEl) this.toolbarEl.style.display = 'none';
        this.updateMultiBar();
        this.commit(deleteNodes(this.markdown, tree, uids));
    }

    // ==================================================================
    // 剪贴板（复制 / 剪切 / 粘贴）
    //
    // 设计要点：剪贴板里只放**纯 Markdown 源码**（extractSubtreeText），
    // 粘到文本框是普通文本，粘回导图由 insertSubtreeFromText 解析成
    // 子节点挂到目标下面 —— 一种格式同时满足两个世界。
    // ==================================================================

    /** 写剪贴板：优先扩展侧 relay，失败退回 webview 自带剪贴板。 */
    private async writeClipboardText(text: string): Promise<boolean> {
        try {
            await copyToClipboard(text);
            return true;
        } catch {
            /* relay 不可用（探针 / 纯浏览器），走浏览器剪贴板 */
        }
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            return false;
        }
    }

    /** 读剪贴板；读不到（权限/无焦点）返回空串。 */
    private async readClipboardText(): Promise<string> {
        try {
            return await navigator.clipboard.readText();
        } catch {
            return '';
        }
    }

    /**
     * 剪贴板操作的对象集合：多选优先（按加入顺序），否则单选节点。
     * root 不可复制（整篇文档没有可提取的区间）。
     */
    private clipboardTargetUids(): string[] {
        const uids =
            this.multiSelected.size > 0
                ? [...this.multiSelected]
                : this.selectedUid
                  ? [this.selectedUid]
                  : [];
        return uids.filter((uid) => uid !== '0');
    }

    /** 复制选中子树到剪贴板（纯 Markdown）。 */
    private async copySelection(): Promise<void> {
        if (!this.currentTree) return;
        const uids = this.clipboardTargetUids();
        if (uids.length === 0) return;
        const text = extractSubtreeText(this.markdown, this.currentTree, uids);
        if (text) await this.writeClipboardText(text);
    }

    /**
     * 剪切 = 复制 + 删除。
     *
     * 不走红按钮两段确认：内容已经进了剪贴板，误操作可以 Ctrl+Z 撤销，
     * 再确认一次纯属打断。
     */
    private async cutSelection(): Promise<void> {
        if (!this.currentTree) return;
        const uids = this.clipboardTargetUids();
        if (uids.length === 0) return;
        const text = extractSubtreeText(this.markdown, this.currentTree, uids);
        if (!text) return;
        await this.writeClipboardText(text);
        this.endEditBeforeStructuralOp();
        const tree = this.currentTree;
        // 同 deleteMultiSelected 的顺序：先清选中再重建
        this.multiSelected.clear();
        this.canvas.setMultiSelected(this.multiSelected);
        this.selectedUid = null;
        this.canvas.setSelected(null);
        this.clearPendingDelete();
        if (this.toolbarEl) this.toolbarEl.style.display = 'none';
        this.updateMultiBar();
        this.commit(deleteNodes(this.markdown, tree, uids));
    }

    /**
     * 粘贴：剪贴板文本解析成子节点，挂到目标下面。
     *
     * 落点：唯一选中节点；多选时取最早点选的那个（多选条上的粘贴）；
     * 什么都没选时落到根（追加到文末 / 第一个标题之前，由
     * insertSubtreeFromText 按块类型决定）。
     */
    private async pasteFromClipboard(): Promise<void> {
        if (!this.currentTree) return;
        const targetUid =
            this.selectedUid ?? [...this.multiSelected][0] ?? '0';
        const clip = await this.readClipboardText();
        if (!clip.trim()) return;
        this.endEditBeforeStructuralOp();
        this.commit(
            insertSubtreeFromText(this.markdown, this.currentTree, targetUid, clip)
        );
    }

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
        // 多选删除的待确认态一并复位（顶部操作条恢复成「删除 N 项」）
        this.pendingDeleteMulti = false;
        this.updateMultiBar();
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

    /**
     * 从文本模式切进导图后的定位。
     *
     * - 固定 100% 缩放（需求：进入导图时 100%，不按整棵树 fit 后缩小）；
     * - 选中视口中线所在的节点并居中（行号 → 最深节点）。
     * 必须先 setActive(true)（容器可见、节点已测量），再做这两步。
     *
     * @param line0 0-based 正文行号
     */
    focusLineFromEditor(line0: number): void {
        if (!this.active) return;
        // 先定缩放，再居中：centerOn 用的是当前 zoom
        this.canvas.setZoomPercent(100);
        const uid = this.findNodeUidAtLine(line0);
        if (uid) this.selectAndCenterUid(uid);
    }

    /**
     * 离开导图前取「用户正在看的位置」对应的 0-based 行号。
     *
     * 优先级：选中/正在编辑的节点 → 视口中心所在节点。调用方必须在
     * setActive(false) **之前**取（那时会清空选中）。
     *
     * @returns 行号；没有可用节点时返回 null
     */
    getFocusLine0(): number | null {
        if (!this.currentTree) return null;
        const selected = this.selectedUid ? this.canvas.getNode(this.selectedUid) : null;
        const selectedRange = selected?.data._lineRange as NodeLineRange | undefined;
        if (selectedRange) return selectedRange.fromLine;
        const centered = this.canvas.getNodeAtViewportCenter();
        const centeredRange = centered?.data._lineRange as NodeLineRange | undefined;
        return centeredRange?.fromLine ?? null;
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

    // ==================================================================
    // 文档内链接（内链）
    // ==================================================================

    /**
     * 收集当前树的标题目录（文档顺序的文字 + uid）。
     *
     * 内链的两种消费方共用同一份目录：箭头配对（syncInternalLinks）与
     * 节点内 #锚点 链接的点击解析（resolveInternalLinkUid）。
     */
    private collectHeadings(): { texts: string[]; uids: string[] } {
        const texts: string[] = [];
        const uids: string[] = [];
        if (!this.currentTree) return { texts, uids };
        const walk = (node: MindMapTreeNode): void => {
            // 标题节点的 text 已去掉 `#` 标记，可直接参与匹配
            if (node.data._kind === 'heading') {
                texts.push(node.data.text);
                uids.push(node.data.uid);
            }
            node.children.forEach(walk);
        };
        walk(this.currentTree);
        return { texts, uids };
    }

    /**
     * 同步内链箭头层：扫全部文本节点的源码，提取内链并解析到目标标题。
     *
     * 断链（目标标题不存在）/ 自指不画；同一对节点多条内链只画一条；
     * 设置关闭时清空。每次整树重建 / 编辑回写后都要调用一次。
     */
    private syncInternalLinks(): void {
        if (!this.currentTree || !this.settings.mindmapInternalLinks) {
            this.canvas.setInternalLinks([]);
            return;
        }
        const { texts, uids } = this.collectHeadings();
        const pairs: Array<{ fromUid: string; toUid: string }> = [];
        const seen = new Set<string>();
        const walk = (node: MindMapTreeNode): void => {
            const kind = node.data._kind;
            // 只有文本类节点可能出现内链；媒体节点（代码块 / 表格等）的内容
            // 在 live 里同样不产生链接，两边口径一致
            if (kind === 'heading' || kind === 'list' || kind === 'para' || kind === 'quote') {
                const range = node.data._selfLineRange ?? node.data._lineRange;
                const source = range
                    ? this.markdownLines.slice(range.fromLine, range.toLine + 1).join('\n')
                    : '';
                for (const target of extractInternalLinkTargets(source)) {
                    const index = matchHeadingIndex(texts, target);
                    if (index < 0) continue; // 断链不画
                    const toUid = uids[index];
                    if (toUid === node.data.uid) continue; // 自指不画
                    const key = `${node.data.uid}->${toUid}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    pairs.push({ fromUid: node.data.uid, toUid });
                }
            }
            node.children.forEach(walk);
        };
        walk(this.currentTree);
        this.canvas.setInternalLinks(pairs);
    }

    /** 内链目标标题文字 → 导图节点 uid（精确优先 + slug 回退）。 */
    private resolveInternalLinkUid(target: string): string | null {
        const { texts, uids } = this.collectHeadings();
        const index = matchHeadingIndex(texts, target);
        return index >= 0 ? uids[index] : null;
    }

    /** 内链跳转：展开祖先、选中并居中（不改缩放）、1 秒高亮。 */
    private handleInternalLinkNavigate(uid: string): void {
        this.selectAndCenterUid(uid);
        this.canvas.flashNode(uid);
    }

    // ==================================================================
    // 性能监控浮层
    // ==================================================================

    /** 按设置挂/摘性能监控浮层（幂等）。 */
    private syncPerfHud(): void {
        if (this.settings.mindmapPerfHud && !this.perfHud) {
            this.perfHud = new PerfHud(this.container, () => ({
                ...this.canvas.debugState(),
                docKB: Math.round(this.markdown.length / 1024),
            }));
        } else if (!this.settings.mindmapPerfHud && this.perfHud) {
            this.perfHud.destroy();
            this.perfHud = null;
        }
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
            this.syncInternalLinks();
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
            this.syncInternalLinks();
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
        this.syncInternalLinks();
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
            // 剪贴板三件套：子树级复制/剪切/粘贴。
            // 编辑会话里不会走到这里（函数开头已 return），编辑态的
            // Ctrl+C/X/V 由 mini-CM 原生处理（文本级）。
            if (key === 'c' || key === 'x') {
                if (this.clipboardTargetUids().length === 0) return;
                event.preventDefault();
                event.stopPropagation();
                if (key === 'c') void this.copySelection();
                else void this.cutSelection();
                return;
            }
            if (key === 'v') {
                event.preventDefault();
                event.stopPropagation();
                void this.pasteFromClipboard();
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
        // Tab = 加子节点；段落也放行（addChildNode 会先把它升级成列表项）
        if (event.key === 'Tab' && kind !== 'meta' && !media) {
            event.preventDefault();
            this.addChild();
        } else if (
            event.key === 'Enter' &&
            // 段落与引用不加兄弟节点（文本类叶节点，直接编辑内容即可）
            kind !== 'para' &&
            kind !== 'quote' &&
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
 * 去掉节点源码的公共行首缩进（导图单元格渲染用）。
 *
 * 列表项及列表项里的媒体块在源文档里带父级缩进（空格或 Tab），但单元格
 * 本身已经是独立的节点，缩进再画进去就会在格子左侧多出一截空白
 * （有序 / 无序 / 代码块 / 表格 / mermaid 同此）。
 *
 * 对媒体块还有一层语义影响：围栏缩进 ≥4 格时，独立的 mini-CM 会把它
 * 解析成「缩进代码块」，mermaid 的块级 widget 不会生成。去掉缩进后
 * 才是普通 FencedCode（提交时 renameNode 会补回去）。
 *
 * 以首行为基准整体左移，续行保留相对缩进：
 * ```
 *   - foo          ->  - foo
 *     bar          ->    bar
 * ```
 * 首行没有缩进（顶层列表项）时原样返回，避免无谓的字符串复制。
 *
 * @param source 节点自身的源码行（`_selfLineRange` / `_lineRange` 切片）
 * @returns 去掉公共缩进后的源码
 */
function dedentNodeSource(source: string): string {
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
