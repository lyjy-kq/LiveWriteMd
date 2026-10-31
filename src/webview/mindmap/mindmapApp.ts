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
import { cellAt } from '../codemirror/extensions/livePreview/table/tableCellSelection.js';
import { splitRowText } from '../codemirror/extensions/livePreview/table/tableDetect.js';
import {
    runTableCommand,
    type TableCommand,
} from '../codemirror/extensions/livePreview/table/tableCommands.js';
import type { NodeDisplay } from './miniCm.js';
import { MindmapSearchBar } from './searchBar.js';
import { ensureMindMapCss } from './styles/index.js';
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
import { addChildNode, addNode, addSiblingNode } from './edit/add.js';
import type { NewNodeSpec } from './edit/add.js';
import { extractSubtreeText, insertSubtreeFromText } from './edit/clipboard.js';
import { moveNode } from './edit/move.js';
import { deleteChildNodes, deleteNode, deleteNodes, deleteSelfKeepChildren } from './edit/remove.js';
import { isMediaKind, renameNode } from './edit/rename.js';
import { countSubtreeNodes, findNodeByUid as findTreeNodeByUid } from './edit/shared.js';
// 写剪贴板走扩展侧 relay（webview 直接写剪贴板在 VS Code 里不稳定）；
// 探针 / 纯浏览器环境没注入 postMessage 时退回 navigator.clipboard
import { copyToClipboard } from '../codemirror/extensions/livePreview/state.js';
// 内链（[[#标题]] / [文字](#标题)）的提取与标题匹配规则与 live 侧共用
import {
    extractInternalLinkTargets,
    matchHeadingIndex,
} from '../../shared/link/internalLink.js';
import * as appClipboard from './app/appClipboard.js';
import * as appDragDrop from './app/appDragDrop.js';
import * as appEditSession from './app/appEditSession.js';
import * as appKeys from './app/appKeys.js';
import * as appLinkage from './app/appLinkage.js';
import * as appMenus from './app/appMenus.js';
import * as appSelection from './app/appSelection.js';
import * as appDocument from './app/appDocument.js';
import * as appStructureEdit from './app/appStructureEdit.js';
import * as appToolbar from './app/appToolbar.js';

/** 默认运行时设置（与 settingsSchema 默认值对齐）。 */
const DEFAULT_RUNTIME_SETTINGS: MindMapRuntimeSettings = {
    mindmapTheme: 'auto',
    mindmapDefaultExpandLevel: 2,
    mindmapNodeMaxWidth: 20,
    mindmapNodeMaxLines: 3,
    mindmapCodeMinWidth: 10,
    // 手势期清晰度优先：默认开启。实测平移帧间隔与提升模式一致、
    // 滚轮缩放反而少了 41ms 的建层尖峰，所以默认不提升。
    mindmapGestureCrisp: true,
    // 内链箭头层：默认开启
    mindmapInternalLinks: true,
    // 性能监测浮层：默认关闭（开了才有采样开销）
    mindmapPerfMonitor: 'off',
};

/**
 * 文本节点：编辑中内容变高（回车换行 / 长行折行）时要把单元格撑高。
 * 代码、表格、公式等媒体节点不在此列 —— 它们编辑时保持盒内滚动。
 */
export const TEXT_NODE_KINDS = new Set<MindMapNodeKind>(['heading', 'list', 'para', 'quote']);

/** 导图应用构造参数。 */
export interface MindMapAppOptions {
    /** 导图编辑产生新全文时回调（模式内由宿主 dispatch 到隐藏的 CM）。 */
    onEdit: MindMapEditCallback;
    /**
     * Ctrl/Cmd+S 强制写回 + 保存（参数是当前全文）。
     *
     * 不复用 onEdit：onEdit 走的是「写回文档」通道，宿主可能还要等防抖
     * 才发给扩展；这里要的是**立即落盘**，而且不能被同步环路跳过。
     * 不传时 Ctrl+S 退化成只提交编辑会话。
     */
    onSave?: (fullText: string) => void;
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
export interface EditSession {
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
export interface SplitCapture {
    uid: string;
    from: number;
    to: number;
    /** 选中文字（换行已压成空格的单行） */
    text: string;
    /** 快照时节点的完整文本（去哨兵行） */
    fullText: string;
}

export class MindMapApp {
    public readonly container: HTMLElement;
    public readonly options: MindMapAppOptions;
    /** 自研画布引擎。 */
    public readonly canvas: MapCanvas;
    /** 导图内搜索条。 */
    public readonly searchBar: MindmapSearchBar;
    /** 性能监控浮层（设置开启时非 null）。 */
    public perfHud: PerfHud | null = null;

    /** 当前文档全文与按行缓存（computeDoc 高频调用，避免反复 split）。 */
    public markdown = '';
    public markdownLines: string[] = [];
    /** 当前文件名（不含扩展名），虚拟根文本。 */
    public fileName = '';

    /** 当前明暗主题（auto 时用）。 */
    public theme: ThemeType = 'dark';
    /** 导图运行时设置。 */
    public settings: MindMapRuntimeSettings = { ...DEFAULT_RUNTIME_SETTINGS };

    /** 容器当前是否显示（display:none 时不量尺寸）。 */
    public active = false;
    /** 容器尺寸观察器。 */
    public resizeObserver: ResizeObserver | null = null;
    public lastContainerWidth = 0;
    public lastContainerHeight = 0;

    /** 已经出现过的 uid（新 uid 按默认展开层级初始化）。 */
    public readonly knownUids = new Set<string>();
    /** 用户收起的 uid 集合；重建树后据此恢复展开状态。 */
    public readonly collapsedUids = new Set<string>();
    /** 被用户点开「展开到最大行数」的 uid 集合。 */
    public readonly expandedUids = new Set<string>();

    /** 隐藏状态下改设置：等 setActive(true) 再量尺寸/重排。 */
    public pendingSettingsRefresh: {
        size: boolean;
        expand: boolean;
    } | null = null;

    /** 最近一次喂给画布的树（编辑操作以它为基准）。 */
    public currentTree: MindMapTreeNode | null = null;
    /** 编辑期间到来的外部更新：只保留最新一棵，会话结束后补发。 */
    public pendingTree: MindMapTreeNode | null = null;

    public selectedUid: string | null = null;
    /**
     * 最近一次「单击才刚选中」的节点 uid（双击手势的判定依据）。
     *
     * 双击 = click(1) → click(2) → dblclick：第一下只负责选中，第二下和
     * dblclick 都**不该**直接进编辑 —— 编辑入口是「节点已经选中后再点」。
     * 否则手快双击一个没选中的节点会当场变成源码编辑态，想「选中后
     * 拖拽 / 剪切」的人会被打断。由 handleNodeClick 写入，双击路径消费。
     */
    public selectOnlyUid: string | null = null;
    /** selectOnlyUid 的记录时间：只有紧随其后的双击才按「只选中」处理。 */
    public selectOnlyAt = 0;
    public editSession: EditSession | null = null;
    /**
     * 「拆分到子节点」的最新选区快照（选区变化时刷新）。
     * 按钮点击时编辑会话可能已被 blur 提交掉，只能用这份快照。
     */
    public splitCapture: SplitCapture | null = null;
    /** 编辑中撑高节点的合并帧：每帧最多量一次内容高度，别每个按键都强制布局。 */
    public growFrame: number | null = null;

    /** 浮动工具条。 */
    public toolbarEl: HTMLDivElement | null = null;
    public toolbarTimer: ReturnType<typeof setInterval> | null = null;
    /**
     * 多选浮动操作条（顶部居中）。
     *
     * Ctrl 多选 / 框选之后必须有一个明确的「删除全部选中项」入口：
     * 单节点工具条上那个「删除」的语义是按当前节点算的，多选时显示它
     * 既容易误点、也看不出到底会删几个。这条独立的操作条只在多选集合
     * 非空时出现，文案直接带数量。
     */
    public multiBarEl: HTMLDivElement | null = null;
    /**
     * 「待确认删除」的节点 uid（第一次点删除后按钮变红）。
     *
     * 不用 window.confirm：VS Code webview 里原生确认框会被吞掉，
     * 有子项的节点点删除看起来就像完全没反应。改成按钮内二次确认：
     * 第一次点击把按钮变红（文案「确认删除」），4 秒内再点一次才真正删。
     */
    public pendingDeleteUid: string | null = null;
    public pendingDeleteTimer: ReturnType<typeof setTimeout> | null = null;
    /**
     * 多选集合（Ctrl 点切换 / Ctrl 拖拽框选）。
     *
     * 和 selectedUid 并存：selectedUid 决定工具条锚在哪个节点上，
     * multiSelected 决定 Delete 一次删哪些。框选结束后把 selectedUid
     * 置为最后命中的一个，工具条仍可用。
     */
    public multiSelected = new Set<string>();
    /** 多选删除的「再按一次确认」状态（复用 4 秒自动复位）。 */
    public pendingDeleteMulti = false;
    /** 右键菜单。 */
    public contextMenuEl: HTMLDivElement | null = null;
    /**
     * 右键落在表格节点上时的上下文（菜单项据此增删行列）。
     *
     * 只有真的点到表格格子才非空；菜单关闭时若没执行命令，要把临时
     * 创建的全量显示实例刷新回占位（见 closeContextMenu）。
     */
    public tableMenuContext: { uid: string; display: NodeDisplay } | null = null;
    /** 右键菜单的全局关闭监听（destroy 时要摘掉，避免实例泄漏）。 */
    public readonly onContainerContextMenu = (event: MouseEvent): void => {
        event.preventDefault();
        event.stopPropagation();
        // 先关旧菜单（会把上一轮临时提升的全量显示实例降档），再解析新落点：
        // 反过来的话，连续右键同一个表格时 close 会把刚解析出来的 display 销毁。
        this.closeContextMenu();
        // 在右键落点上解析表格格子（顺便把整格选起来），再拼菜单
        const table = this.resolveTableMenuContext(event);
        this.openContextMenu(event, table);
    };
    public readonly onDocumentClick = (): void => this.closeContextMenu();
    public readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') this.closeContextMenu();
    };
    /**
     * 窗口失焦：收起右键菜单 + 提交编辑会话。
     *
     * 「失焦提交」不能只靠 mini-CM contentDOM 上的 blur 事件 —— 点到
     * webview 外面（VS Code 标题栏 / 别的编辑器 / 另一个窗口）时，
     * Electron 的 iframe 有时收不到元素级 blur，编辑就停在半路，
     * 表现为「明明点走了却没写回」。窗口级 blur 是最后一层兜底。
     */
    public readonly onWindowBlur = (): void => {
        this.closeContextMenu();
        this.commitEditSession();
    };
    /**
     * 编辑会话兜底提交（document 捕获阶段，任何 pointerdown 都先过这里）。
     *
     * 有些手势不会让焦点离开编辑区：画布上的链接箭头 / 缩略图在
     * pointerdown 里 preventDefault，节点拖动会 setPointerCapture，
     * 工具栏按钮也刻意 preventDefault 保焦点 —— 这些情况下 mini-CM
     * 收不到 blur，会话就一直挂着。只要按下的不是编辑区本身，就先提交。
     */
    public readonly onDocumentPointerDown = (event: PointerEvent): void => {
        const session = this.editSession;
        if (!session) return;
        const target = event.target;
        if (target instanceof Node) {
            // 点在编辑区自己身上（含行内 widget）：保持会话
            if (session.display.container.contains(target)) return;
            // 浮动工具条 / 多选条 / 右键菜单 / 搜索条：它们的 mousedown
            // 刻意 preventDefault 保住焦点，提前提交会把「拆分到子节点」
            // 的菜单当场收起来（点击还没落到菜单项上）
            if (
                target instanceof Element &&
                target.closest('.lwm-toolbar, .lwm-context-menu, .lwm-searchbar-host')
            ) {
                return;
            }
        }
        this.commitEditSession();
    };
    /** 页面被隐藏（切标签页 / 面板收到后台）：兜底提交，别把改动留在内存里。 */
    public readonly onVisibilityChange = (): void => {
        if (document.hidden) this.commitEditSession();
    };
    /**
     * 双击手势收尾（容器捕获阶段，先于画布 nodeLayer 上的 dblclick）。
     *
     * 交互约定：单击 = 选中；**已经选中**的节点再单击 / 双击才进编辑。
     * 但双击的两下 click 都是普通单击：第一下会把未选中节点选中，第二下
     * 就满足「已选中」直接进了编辑 —— 用户看到的就是「手快双击一个
     * 没选中的节点，当场跳进源码编辑态」。
     *
     * 这里在 dblclick 到达时把这种「刚选中」的双击撤回：退出刚建立的
     * 编辑会话（文本没变，只是切回显示态），并截住事件，别让画布的
     * dblclick 处理再把它带进编辑。已选中的节点双击不受影响。
     */
    public readonly onContainerDoubleClick = (event: MouseEvent): void => {
        const target = event.target as Element | null;
        const wrapper = target?.closest?.('.lwm-node[data-uid]') as HTMLElement | null;
        const uid = wrapper?.dataset.uid ?? '';
        if (!uid || this.selectOnlyUid !== uid) return;
        // 只认「紧随其后」的双击：隔了很久的残留标记不算（真正的双击
        // 由浏览器在系统阈值内送达，这里给一倍余量）
        if (performance.now() - this.selectOnlyAt > 700) {
            this.selectOnlyUid = null;
            return;
        }
        this.selectOnlyUid = null;
        // 第二下 click 可能已经把节点带进编辑态：撤回（无文本改动 → 只退出）
        if (this.editSession?.uid === uid) this.commitEditSession();
        // 本轮双击到此为止：画布的 dblclick → startEdit 不能再执行
        event.stopPropagation();
        event.preventDefault();
    };

    /** 导出进行中（菜单连点防重）。 */
    public exportInFlight = false;

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
        // 视口虚拟化恒开（画布内的默认值），不再提供开关
        // 性能监测浮层：按初始设置挂/摘
        this.syncPerfHud();
        this.createToolbar();
        this.createMultiToolbar();
        this.createContextMenu();

        window.addEventListener('keydown', this.handleWindowKeyDown, true);
        // 双击手势收尾（必须在容器捕获阶段，抢在画布 nodeLayer 的 dblclick 前）
        this.container.addEventListener('dblclick', this.onContainerDoubleClick, true);
        // 编辑会话的兜底提交钩子（blur 之外的几条遗漏路径，见各字段注释）
        document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
        document.addEventListener('visibilitychange', this.onVisibilityChange);
        this.resizeObserver = new ResizeObserver(() => this.handleContainerResize());
        this.resizeObserver.observe(container);
    }

    // ---- 薄包装：实现已拆到 app/ 协作模块，签名不变 ----

    // appDocument
    public setMarkdown(text: string) : void { return appDocument.setMarkdown(this, text); }
    public resolveTheme() : ThemeType { return appDocument.resolveTheme(this); }
    public bakeExpandState(tree: MindMapTreeNode) : MindMapTreeNode { return appDocument.bakeExpandState(this, tree); }
    public computeNodeDoc(node: MapNode) : { doc: string; sentinel: boolean } { return appDocument.computeNodeDoc(this, node); }
    // appSelection
    public handleNodeClick(node: MapNode, event: MouseEvent) : void { return appSelection.handleNodeClick(this, node, event); }
    public toggleMultiSelection(uid: string) : void { return appSelection.toggleMultiSelection(this, uid); }
    public applyMarqueeSelection(uids: string[]) : void { return appSelection.applyMarqueeSelection(this, uids); }
    public selectNode(uid: string) : void { return appSelection.selectNode(this, uid); }
    public outlineLineOf(uid: string) : number | null { return appSelection.outlineLineOf(this, uid); }
    public clearSelection() : void { return appSelection.clearSelection(this); }
    public resetDisplaySelections(exceptUid: string | null) : void { return appSelection.resetDisplaySelections(this, exceptUid); }
    // appToolbar
    public createToolbar() : void { return appToolbar.createToolbar(this); }
    public createMultiToolbar() : void { return appToolbar.createMultiToolbar(this); }
    public updateMultiBar() : void { return appToolbar.updateMultiBar(this); }
    public positionMultiBar() : void { return appToolbar.positionMultiBar(this); }
    public createAddMenu(act: 'child' | 'sibling', label: string) : HTMLDivElement { return appToolbar.createAddMenu(this, act, label); }
    public createSplitMenu() : HTMLDivElement { return appToolbar.createSplitMenu(this); }
    public createDeleteMenu() : HTMLDivElement { return appToolbar.createDeleteMenu(this); }
    public addQuick(placement: 'child' | 'sibling') : void { return appToolbar.addQuick(this, placement); }
    public addFromMenu(placement: 'child' | 'sibling', item: HTMLElement) : void { return appToolbar.addFromMenu(this, placement, item); }
    public insertNodeSpec(placement: 'child' | 'sibling', spec: NewNodeSpec) : void { return appToolbar.insertNodeSpec(this, placement, spec); }
    public showToolbar(uid: string) : void { return appToolbar.showToolbar(this, uid); }
    public positionToolbar() : void { return appToolbar.positionToolbar(this); }
    // appEditSession
    public startEdit(uid: string, x?: number, y?: number) : void { return appEditSession.startEdit(this, uid, x, y); }
    public measureEditingSourceWidth(display: NonNullable<ReturnType<MapCanvas['getDisplay']>>) : number { return appEditSession.measureEditingSourceWidth(this, display); }
    public scheduleGrowEditingNode(session: EditSession) : void { return appEditSession.scheduleGrowEditingNode(this, session); }
    public cancelGrowEditingNode() : void { return appEditSession.cancelGrowEditingNode(this); }
    public applyInlineFormat(uid: string, command: (view: EditorView) => boolean,) : void { return appEditSession.applyInlineFormat(this, uid, command); }
    public handleDisplayEdit(node: MapNode, text: string) : void { return appEditSession.handleDisplayEdit(this, node, text); }
    public commitEditSession() : void { return appEditSession.commitEditSession(this); }
    public forceWrite() : void { return appEditSession.forceWrite(this); }
    public flushEditBeforeDestroy() : void { return appEditSession.flushEditBeforeDestroy(this); }
    public refreshSplitButton() : void { return appEditSession.refreshSplitButton(this); }
    public captureSplitSelection() : SplitCapture | null { return appEditSession.captureSplitSelection(this); }
    public splitSelection(captured: SplitCapture, placement: 'child' | 'sibling') : void { return appEditSession.splitSelection(this, captured, placement); }
    public finishEdit(session: EditSession, text: string | null) : void { return appEditSession.finishEdit(this, session, text); }
    // appStructureEdit
    public commit(result: { text: string; newNodeUid?: string }) : void { return appStructureEdit.commit(this, result); }
    public endEditBeforeStructuralOp() : void { return appStructureEdit.endEditBeforeStructuralOp(this); }
    public addChild() : void { return appStructureEdit.addChild(this); }
    public addSibling() : void { return appStructureEdit.addSibling(this); }
    public deleteSelected() : void { return appStructureEdit.deleteSelected(this); }
    public deleteFromMenu(item: HTMLElement) : void { return appStructureEdit.deleteFromMenu(this, item); }
    public deleteMultiSelected() : void { return appStructureEdit.deleteMultiSelected(this); }
    // appClipboard
    public clipboardTargetUids() : string[] { return appClipboard.clipboardTargetUids(this); }
    public async copySelection() : Promise<void> { return appClipboard.copySelection(this); }
    public async pasteFromClipboard() : Promise<void> { return appClipboard.pasteFromClipboard(this); }
    public armDelete(uid: string, childCount: number) : void { return appClipboard.armDelete(this, uid, childCount); }
    public clearPendingDelete() : void { return appClipboard.clearPendingDelete(this); }
    public handleExpandChange(uid: string, expanded: boolean, recursive: boolean) : void { return appClipboard.handleExpandChange(this, uid, expanded, recursive); }
    public expandAllNodes() : void { return appClipboard.expandAllNodes(this); }
    // appLinkage
    public selectNodeAtLine(line0: number) : boolean { return appLinkage.selectNodeAtLine(this, line0); }
    public focusLineFromEditor(line0: number) : void { return appLinkage.focusLineFromEditor(this, line0); }
    public getFocusLine0() : number | null { return appLinkage.getFocusLine0(this); }
    public selectAndCenterUid(uid: string) : void { return appLinkage.selectAndCenterUid(this, uid); }
    public collectHeadings() : { texts: string[]; uids: string[] } { return appLinkage.collectHeadings(this); }
    public syncInternalLinks() : void { return appLinkage.syncInternalLinks(this); }
    public resolveInternalLinkUid(target: string) : string | null { return appLinkage.resolveInternalLinkUid(this, target); }
    public handleInternalLinkNavigate(uid: string) : void { return appLinkage.handleInternalLinkNavigate(this, uid); }
    public syncPerfHud() : void { return appLinkage.syncPerfHud(this); }
    public applySearchHighlight(uids: string[], currentUid: string | null) : void { return appLinkage.applySearchHighlight(this, uids, currentUid); }
    public findNodeUidAtLine(line0: number) : string | null { return appLinkage.findNodeUidAtLine(this, line0); }
    // appDragDrop
    public validateDropParent(dragUid: string, parentUid: string) : boolean { return appDragDrop.validateDropParent(this, dragUid, parentUid); }
    public handleDrop(payload: DropPayload) : void { return appDragDrop.handleDrop(this, payload); }
    public remapUidSets(remap: Map<string, string>) : void { return appDragDrop.remapUidSets(this, remap); }
    public computeDropRemap(dragUid: string, parentUid: string, oldTree: MindMapTreeNode, newTree: MindMapTreeNode) : Map<string, string> { return appDragDrop.computeDropRemap(this, dragUid, parentUid, oldTree, newTree); }
    // appMenus
    public createContextMenu() : void { return appMenus.createContextMenu(this); }
    public openContextMenu(event: MouseEvent, table: { uid: string; display: NodeDisplay } | null = null) : void { return appMenus.openContextMenu(this, event, table); }
    public closeContextMenu(keepTableContext = false) : void { return appMenus.closeContextMenu(this, keepTableContext); }
    public resolveTableMenuContext(event: MouseEvent) : { uid: string; display: NodeDisplay } | null { return appMenus.resolveTableMenuContext(this, event); }
    public tablePosAtEvent(view: EditorView, event: MouseEvent) : number | null { return appMenus.tablePosAtEvent(this, view, event); }
    public nearestCellPosByX(view: EditorView, linePos: number, x: number) : number | null { return appMenus.nearestCellPosByX(this, view, linePos, x); }
    public runTableMenuCommand(command: TableCommand) : void { return appMenus.runTableMenuCommand(this, command); }
    public async handleExport(format: 'png' | 'svg' | 'pdf') : Promise<void> { return appMenus.handleExport(this, format); }
    // appKeys
    public handleWindowKeyDown = (event: KeyboardEvent): void => { appKeys.handleWindowKeyDown(this, event); };
    public toggleEmptyHint(empty: boolean) : void { return appKeys.toggleEmptyHint(this, empty); }


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

        // 性能监测浮层：开关 / 档位切换即挂、摘或重建（HUD 内部是 rAF +
        // 500ms 定时器，关闭时整个销毁，不留后台采样）
        if (previous.mindmapPerfMonitor !== this.settings.mindmapPerfMonitor) {
            this.syncPerfHud();
        }

        const sizeChanged =
            previous.mindmapNodeMaxWidth !== this.settings.mindmapNodeMaxWidth ||
            previous.mindmapNodeMaxLines !== this.settings.mindmapNodeMaxLines ||
            previous.mindmapCodeMinWidth !== this.settings.mindmapCodeMinWidth;
        if (sizeChanged) this.applyNodeSizeVars();
        const expandChanged =
            previous.mindmapDefaultExpandLevel !== this.settings.mindmapDefaultExpandLevel;

        if (!sizeChanged && !expandChanged) {
            return;
        }

        // 隐藏时量出来的尺寸是 0：挂起，激活后补做
        if (!this.active) {
            const pending = this.pendingSettingsRefresh ?? {
                size: false,
                expand: false,
            };
            pending.size ||= sizeChanged;
            pending.expand ||= expandChanged;
            this.pendingSettingsRefresh = pending;
            return;
        }
        this.applySettingsRefresh(sizeChanged, expandChanged);
    }

    /** 把设置变更落到已渲染的画布上。 */
    public applySettingsRefresh(sizeChanged: boolean, expandChanged: boolean): void {
        if (sizeChanged) this.canvas.remeasureAll();
        if (expandChanged) this.applyExpandLevel();
        // 尺寸 / 展开层级变化都可能改变可见集合
        this.canvas.resize();
    }

    /** 按新的默认展开层级重置整棵树的展开状态。 */
    public applyExpandLevel(): void {
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
    public applyNodeSizeVars(): void {
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
                this.applySettingsRefresh(pending.size, pending.expand);
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
    public handleContainerResize(): void {
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
        this.container.removeEventListener('dblclick', this.onContainerDoubleClick, true);
        document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
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
        // 销毁前把未提交的编辑写回文档（直接 exitEdit 会丢掉用户刚输入的内容）
        this.flushEditBeforeDestroy();
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






    /** 写剪贴板：优先扩展侧 relay，失败退回 webview 自带剪贴板。 */
    public async writeClipboardText(text: string): Promise<boolean> {
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
    public async readClipboardText(): Promise<string> {
        try {
            return await navigator.clipboard.readText();
        } catch {
            return '';
        }
    }


    /**
     * 剪切 = 复制 + 删除。
     *
     * 不走红按钮两段确认：内容已经进了剪贴板，误操作可以 Ctrl+Z 撤销，
     * 再确认一次纯属打断。
     */
    public async cutSelection(): Promise<void> {
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






























}
