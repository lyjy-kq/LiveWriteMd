/**
 * Live Preview State
 *
 * todo.md 任务 4（live 扩展实例化）之后，**与文档区间相关的可变状态全部
 * 收进按 EditorState 隔离的实例状态**（{@link livePreviewInstanceField}）：
 * 同一套扩展同时挂在主编辑器与导图节点的 mini-CM 上时，源码模式区间 /
 * 行级强制源码态 / 折叠行集合互不串扰。
 *
 * 设计要点：
 * - 实例状态对象在 StateField.create 里建一次，update 原样透传（沿用既有
 *   「外部 mutate + StateEffect 触发装饰重建」的模式，改动面最小）；
 * - 所有读写都要带 `state`（`state.field(livePreviewInstanceField)`），
 *   不再存在模块级单例；
 * - 缓存类（mermaid / 高度 / baseUri / postMessage）是内容寻址或应用级
 *   全局资源，**有意保持模块级共享**。
 *
 * @module webview/codemirror/extensions/livePreview/state
 */

import { StateEffect, StateField, type ChangeDesc, type EditorState } from '@codemirror/state';

// =============================================================================
// 实例状态（按 EditorState 隔离）
// =============================================================================

/**
 * 一个编辑器实例的可变状态（create 一次、全程同一对象引用）。
 */
export interface LivePreviewInstanceState {
    /**
     * 当前处于源码模式的块（用它的文档区间标识），没有就是 null。
     *
     * 图片和 Mermaid 默认一直保持渲染态——单击它们只会把光标放进源码里，
     * 外观不变；只有**双击**才切到源码模式，把原文摊开给你改结构。
     * 光标离开这个区间（点到别处）就自动退出。
     * （表格以前也走这套，现在改成保留源码 + 就地装饰，不再需要源码模式。）
     */
    sourceModeRange: { from: number; to: number } | null;
    /** 拖拽展开行区间（鼠标移动超阈值后设置，mouseup 清除），没有就是 null。 */
    pendingForceRange: { from: number; to: number } | null;
    /** 钉住行区间（双击后保持源码），没有就是 null。 */
    pinnedForceRange: { from: number; to: number } | null;
    /**
     * 已折叠行的行首位置集合（line.from）。
     * 同时用于：列表项折叠、标题章节折叠。
     */
    foldedLines: Set<number>;
}

/**
 * 实例状态字段。之所以用「可变对象 + 原样透传」而不是「不可变值 + effect 更新」：
 * 现有代码有 60+ 处直接读写（含 widget 事件回调里拿不到最新 state 的地方），
 * 对象引用在整个编辑器生命周期不变，任何时刻拿到的都是同一份。
 */
export const livePreviewInstanceField = StateField.define<LivePreviewInstanceState>({
    create: () => ({
        sourceModeRange: null,
        pendingForceRange: null,
        pinnedForceRange: null,
        foldedLines: new Set<number>(),
    }),
    update: (value) => value,
});

/**
 * 没挂实例字段的编辑器（极少见：单独挂 gutterFold 之类）用的兜底实例，
 * 行为与旧的模块级单例一致。
 */
const FALLBACK_INSTANCE: LivePreviewInstanceState = {
    sourceModeRange: null,
    pendingForceRange: null,
    pinnedForceRange: null,
    foldedLines: new Set<number>(),
};

/** 取当前编辑器的实例状态（没挂字段时给兜底实例）。 */
export function instanceOf(state: EditorState): LivePreviewInstanceState {
    return state.field(livePreviewInstanceField, false) ?? FALLBACK_INSTANCE;
}

// =============================================================================
// Widget Source Mode (图片 / Mermaid 的「双击进入源码模式」)
// =============================================================================

/**
 * StateEffect：进入 / 退出源码模式。
 * payload 为 null 表示退出，否则是目标块的文档区间。
 */
export const sourceModeEffect = StateEffect.define<{ from: number; to: number } | null>();

/** 设置当前处于源码模式的块区间（null 表示退出）。 */
export function setSourceModeRange(
    state: EditorState,
    range: { from: number; to: number } | null
): void {
    instanceOf(state).sourceModeRange = range;
}

/** 读取当前处于源码模式的块区间。 */
export function getSourceModeRange(state: EditorState): { from: number; to: number } | null {
    return instanceOf(state).sourceModeRange;
}

/**
 * 判断某个节点区间是否处于源码模式。
 *
 * @param state - 编辑器状态（实例隔离）
 * @param from - 节点起点
 * @param to - 节点终点
 * @returns 该节点与源码模式区间有重叠时返回 true
 */
export function isInSourceMode(state: EditorState, from: number, to: number): boolean {
    const range = instanceOf(state).sourceModeRange;
    if (!range) return false;
    // 用「有重叠」而不是「完全包含」：widget 记的是行区间、语法节点记的是节点区间，
    // 两者可能差一两个字符（比如围栏前的空行），完全包含会漏判。
    return from < range.to && to > range.from;
}

/**
 * 光标 / 选区离开源码模式区间时自动退出。
 *
 * @param state - 编辑器状态（实例隔离）
 * @param selFrom - 选区起点
 * @param selTo - 选区终点
 * @returns 是否发生了状态变化（调用方据此决定要不要重建装饰）
 */
export function exitSourceModeIfOutside(state: EditorState, selFrom: number, selTo: number): boolean {
    const inst = instanceOf(state);
    if (!inst.sourceModeRange) return false;
    // 闭区间：双击时光标会停在块首/块尾，那两个端点也算「还在块里」
    const inside = selFrom <= inst.sourceModeRange.to && selTo >= inst.sourceModeRange.from;
    if (inside) return false;
    inst.sourceModeRange = null;
    return true;
}

// =============================================================================
// 行级强制源码态（mousedown 待选 / 双击钉住）
// =============================================================================

/**
 * 为什么要多这一层（2026-09-22 反馈，同日第二次纠正触发时机）：
 *
 * 行内公式是 widget 替换（宽度和源码完全不同）、加粗 / 行内代码的标记被压 0 宽，
 * 整行展开后长度会变。**mousedown 时不能先展开再算坐标**：否则 CodeMirror 记下的
 * 拖拽锚点是文本态坐标下的字符，不是用户在渲染态看到、按下的字符，起点就错了。
 *
 * 正确时序：
 *
 * 1. mousedown：不展开，CodeMirror 按渲染态固定拖拽锚点；光标落下后只展开
 *    点击位置的那一个元素（常态逻辑）；
 * 2. 鼠标真正拖动超过阈值：整行全部展开，锚点字符不变 —— 这就是
 *    `pendingForceRange`：**拖拽已确认、进行中**的行；mouseup 时清除，
 *    若选区非空则由 getSourceRange 的拖选分支继续给整行源码；
 * 3. 双击：`pinnedForceRange` 把整行**钉住**，直到选区不再与该行相交
 *    （失去这一行的焦点）、或者再次双击该行。
 */

/**
 * StateEffect：修改行级强制源码态。
 *
 * payload 里哪个字段给了就改哪个 —— 显式传 `null` 表示清空该档，
 * 字段缺省（undefined）表示不动。两个字段可以同时给。
 */
export const lineForceEffect = StateEffect.define<{
    pending?: { from: number; to: number } | null;
    pinned?: { from: number; to: number } | null;
}>();

/**
 * 按 patch 更新两档强制区间。
 *
 * @param state - 编辑器状态（实例隔离）
 * @param patch - pending / pinned 的新值；undefined 的字段保持不变
 * @returns 是否真的发生了变化（调用方据此判断要不要触发重建）
 */
export function patchLineForce(
    state: EditorState,
    patch: {
        pending?: { from: number; to: number } | null;
        pinned?: { from: number; to: number } | null;
    }
): boolean {
    const inst = instanceOf(state);
    let changed = false;

    // undefined = 不动；null = 清空；对象 = 替换
    if (patch.pending !== undefined) {
        const next = patch.pending;
        const prev = inst.pendingForceRange;
        // 区间相同就不标记变化，免得同位置重复触发重建
        if (!prev !== !next || (prev && next && (prev.from !== next.from || prev.to !== next.to))) {
            inst.pendingForceRange = next;
            changed = true;
        }
    }
    if (patch.pinned !== undefined) {
        const next = patch.pinned;
        const prev = inst.pinnedForceRange;
        if (!prev !== !next || (prev && next && (prev.from !== next.from || prev.to !== next.to))) {
            inst.pinnedForceRange = next;
            changed = true;
        }
    }
    return changed;
}

/** 读取待选行区间。 */
export function getPendingForceRange(state: EditorState): { from: number; to: number } | null {
    return instanceOf(state).pendingForceRange;
}

/** 读取钉住行区间。 */
export function getPinnedForceRange(state: EditorState): { from: number; to: number } | null {
    return instanceOf(state).pinnedForceRange;
}

/**
 * 判断一个节点区间是否落在强制源码行上（与任一档相交就算）。
 *
 * 给主遍历 / 公式收集器用：命中时即使是空选区，也按「整行源码」处理。
 *
 * @param state - 编辑器状态（实例隔离）
 * @param from - 节点起点
 * @param to - 节点终点
 * @returns 与待选行或钉住行相交时返回 true
 */
export function isForcedSourceRange(state: EditorState, from: number, to: number): boolean {
    const inst = instanceOf(state);
    // 相交判据和 isInSourceMode 保持一致：半开区间的严格重叠
    const hit = (range: { from: number; to: number } | null): boolean =>
        !!range && from < range.to && to > range.from;
    return hit(inst.pendingForceRange) || hit(inst.pinnedForceRange);
}

/**
 * 选区 / 光标不再与钉住行相交时，自动取消钉住（「失去这一行的焦点」）。
 *
 * 和 exitSourceModeIfOutside 同一套规则：闭区间判定，双击后选区停在行首 /
 * 行尾那两个端点也算「还在行上」。
 *
 * @param state - 编辑器状态（实例隔离）
 * @param selFrom - 选区起点
 * @param selTo - 选区终点
 * @returns 是否发生了状态变化（调用方据此决定要不要重建装饰）
 */
export function exitPinnedForceIfOutside(state: EditorState, selFrom: number, selTo: number): boolean {
    const inst = instanceOf(state);
    if (!inst.pinnedForceRange) return false;
    const inside = selFrom <= inst.pinnedForceRange.to && selTo >= inst.pinnedForceRange.from;
    if (inside) return false;
    inst.pinnedForceRange = null;
    return true;
}

/**
 * 文档变化后把两档区间映射到新坐标。
 *
 * 实例状态不会像不可变 StateField 那样自动跟随事务，所以每次 docChanged 时
 * 由 plugin.ts 主动调一次；映射后区间塌成 0 长（所在行被删掉）就清空。
 *
 * @param state - 事务后的编辑器状态（实例隔离）
 * @param changes - 当前事务的 change 描述（tr.changes）
 */
export function mapForceRanges(state: EditorState, changes: ChangeDesc): void {
    const inst = instanceOf(state);
    /** 把一个区间映射过去；端点重合（被删没了）时返回 null。 */
    const mapRange = (
        range: { from: number; to: number } | null
    ): { from: number; to: number } | null => {
        if (!range) return null;
        // 必须用 mapPos：参数 changes 是 ChangeDesc，只保证有 mapPos。
        // ChangeSet.map 接收的是**另一个变更集**（用于组合），不是位置——
        // 传数字进去会在内部迭代器里读到 (number).sections=undefined 而崩溃。
        // 向外偏置：from 贴左（-1）、to 贴右（1），这样编辑发生在区间
        // 内部时端点不会动，只有区间被整体删除时两端才收敛、返回 null
        const from = changes.mapPos(range.from, -1);
        const to = changes.mapPos(range.to, 1);
        return from < to ? { from, to } : null;
    };
    inst.pendingForceRange = mapRange(inst.pendingForceRange);
    inst.pinnedForceRange = mapRange(inst.pinnedForceRange);
}

// =============================================================================
// Document Base URI (for image relative path resolution)
// =============================================================================

let _documentBaseUri = '';

/**
 * Set the webview-accessible base URI for the document directory.
 * Called from main.ts when INIT message is received.
 */
export function setDocumentBaseUri(uri: string): void {
    _documentBaseUri = uri;
}

/**
 * Get the current document base URI.
 */
export function getDocumentBaseUri(): string {
    return _documentBaseUri;
}

/**
 * 把图片原始地址解析成 webview 能直接访问的地址。
 *
 * 放在 state.ts 而不是 helpers.ts：行内引擎（inlineEngine）也要用它，
 * 而 helpers 已经 import 了 inlineEngine，反过来再依赖会形成循环。
 * 这里只依赖本文件里的 baseUri，是最底层的实现。
 *
 * 支持远程地址、data URI 与文档目录下的相对路径。
 *
 * @param rawUrl - 图片原始链接或相对路径
 * @returns 可直接赋值给 img.src 的地址；无法解析时返回空串
 */
export function resolvePreviewImageUrl(rawUrl: string): string {
    const trimmed = rawUrl.trim();
    if (!trimmed) return '';

    if (
        trimmed.startsWith('http://') ||
        trimmed.startsWith('https://') ||
        trimmed.startsWith('data:')
    ) {
        return trimmed;
    }

    if (!_documentBaseUri) return '';

    try {
        const normalizedBase = _documentBaseUri.endsWith('/')
            ? _documentBaseUri
            : `${_documentBaseUri}/`;
        const normalizedPath = trimmed.replace(/\\/g, '/');
        return new URL(normalizedPath, normalizedBase).href;
    } catch {
        return '';
    }
}

// =============================================================================
// List Fold State
// =============================================================================

/** StateEffect to signal a fold toggle (triggers decoration rebuild) */
export const foldToggleEffect = StateEffect.define<null>();

/**
 * 视图挂上 DOM 之后补一次重建（本身不改文档，只是要求装饰重算一次）。
 *
 * 表格列宽必须知道「正文有多宽」，而 block 装饰是在 EditorState.create 阶段
 * 就算出来的 —— 那时视图还没有 DOM，可用宽度量到 0，表格只能按「不收缩」画，
 * 直接撑出正文列。见 plugin.ts 的 tableWidthBootstrap。
 */
export const tableRemeasureEffect = StateEffect.define<null>();

/**
 * 读取当前编辑器的折叠行集合（line.from）。
 *
 * 集合本身可变：现有代码直接 add/delete 后 dispatch foldToggleEffect 触发重建，
 * 该模式保留；多实例时各自拿各自的集合，互不串扰。
 */
export function foldedLinesOf(state: EditorState): Set<number> {
    return instanceOf(state).foldedLines;
}

// =============================================================================
// Mermaid Cache
// =============================================================================

/** Cache for rendered Mermaid SVGs（同样加上限，超了整体清空） */
export const mermaidSvgCache = new Map<string, string>();

/** 往 Mermaid 缓存里写渲染结果，超过上限就先清空。 */
export function rememberMermaidSvg(source: string, svg: string): void {
    if (mermaidSvgCache.size > 200) mermaidSvgCache.clear();
    mermaidSvgCache.set(source, svg);
}
/** Cache for Mermaid rendered heights to prevent scroll jumps */
export const mermaidHeightCache = new Map<string, number>();
/**
 * 其它 widget 的高度缓存（key 是内容指纹）。
 *
 * 加个上限：长会话里一直写不清理的话会慢慢涨；超了就整体清空（重建一次而已，
 * 比做 LRU 简单得多，代价只是滚动位置估得不准一小会儿）。
 */
export const widgetHeightCache = new Map<string, number>();

/** 往缓存里写高度，超过上限就先清空。 */
export function rememberWidgetHeight(key: string, height: number): void {
    if (widgetHeightCache.size > 500) widgetHeightCache.clear();
    widgetHeightCache.set(key, height);
}

/** In-flight render promises keyed by source (prevents duplicate concurrent renders) */
export const mermaidRenderPromises = new Map<string, Promise<string>>();
export let mermaidInitialized = false;
/** Theme Mermaid was last initialized with */
let mermaidCurrentTheme: 'dark' | 'light' = 'dark';

export function setMermaidInitialized(value: boolean): void {
    mermaidInitialized = value;
}

/**
 * Update the Mermaid rendering theme.
 * Resets initialization flag and clears SVG cache when theme changes,
 * so diagrams get re-rendered with correct colors.
 */
export function setMermaidTheme(theme: 'dark' | 'light'): void {
    if (mermaidCurrentTheme !== theme) {
        mermaidCurrentTheme = theme;
        mermaidInitialized = false;
        mermaidSvgCache.clear();
    }
}

export function getMermaidTheme(): 'dark' | 'light' {
    return mermaidCurrentTheme;
}

// =============================================================================
// Clipboard (via Extension postMessage)
// =============================================================================

let _postMessage: ((message: unknown) => void) | null = null;

export function setPostMessage(fn: (message: unknown) => void): void {
    _postMessage = fn;
}

export function copyToClipboard(text: string): Promise<void> {
    if (_postMessage) {
        _postMessage({ type: 'copyToClipboard', text });
        return Promise.resolve();
    }
    return Promise.reject(new Error('postMessage not available'));
}
