/**
 * 编辑器/导图应用状态与模式切换（从 main.ts 拆出）。
 *
 * 模块级共享状态全部落在 webviewContext.ctx 上，这里是操作这些状态的
 * 一组自由函数：导图模式进出、导图编辑回写隐藏 CM、大纲联动等。
 *
 * @module webview/host/appState
 */

import { undo, redo } from '@codemirror/commands';
import { codeLanguages } from '../codemirror/editor.js';
import {
    copyToClipboard,
    tableRemeasureEffect,
} from '../codemirror/extensions/livePreview/state.js';
import { MESSAGE_TYPES } from '../../shared/messageTypes.js';
// 只取类型：真正的实现改为进入对应模式时才动态 import（见下方 enter 函数）。
// 静态 import 会把导图 / 幻灯片整套代码塞进入口 bundle，每个 md 文件首屏
// 都要为「还没进入的模式」付编译成本。
import type { MindMapApp } from '../mindmap/mindmapApp.js';
import type {
    QuickCardRail,
    QuickCardRailOptions,
} from '../mindmap/quickCardRail.js';
import type { MindMapRuntimeSettings } from '../mindmap/types.js';
import type { SlidesApp } from '../slides/slidesApp.js';
import { settingsState } from '../settings/settingsState.js';
import type { EditorMode } from '../editing/editorContextMenu.js';
import { ctx } from './webviewContext.js';
import { sendLog } from './logForward.js';

/**
 * 获取或创建编辑器宿主容器。
 *
 * @returns 编辑器宿主 DOM 节点。
 */
export function getOrCreateEditorHost(): HTMLElement {
    let container = document.getElementById('editor');
    if (!container) {
        container = document.createElement('div');
        container.id = 'editor';
        document.body.appendChild(container);
    }
    return container;
}

/**
 * 获取导图挂载容器（HTML 壳子里已预置 #mindmap）。
     */
export function getMindmapHost(): HTMLElement {
    return document.getElementById('mindmap') as HTMLElement;
}

/**
 * 获取幻灯片挂载容器（HTML 壳子里已预置 #slides）。
 */
export function getSlidesHost(): HTMLElement {
    return document.getElementById('slides') as HTMLElement;
}

/**
 * 从文档 URI 推导文件名（不含扩展名），作为导图虚拟根文本。
 *
 * @param uri 文档 URI
 * @returns 去扩展名后的文件名
 */
export function fileNameFromUri(uri: string): string {
    try {
        const withoutQuery = decodeURIComponent(uri.split('?')[0] ?? uri);
        const base = withoutQuery.split(/[\\/]/).pop() ?? '';
        return base.replace(/\.(md|markdown)$/i, '');
    } catch {
        const fallback = uri.split(/[\\/]/).pop() ?? '';
        return fallback.replace(/\.(md|markdown)$/i, '');
    }
}

/**
 * 从 settingsState 读取导图运行时设置。
     */
export function readMindmapSettings(): MindMapRuntimeSettings {
    return {
        mindmapTheme: settingsState.getString('mindmapTheme') || 'auto',
        mindmapDefaultExpandLevel: settingsState.getNumber('mindmapDefaultExpandLevel'),
        // 节点尺寸上限：getNumber 缺省/异常时回退 0，这里兜底成默认值
        mindmapNodeMaxWidth: settingsState.getNumber('mindmapNodeMaxWidth') || 20,
        mindmapNodeMaxLines: settingsState.getNumber('mindmapNodeMaxLines') || 3,
        // 代码块宽度：40–100 列，0 / 缺失时回退 schema 默认值 60
        mindmapCodeWidth: settingsState.getNumber('mindmapCodeWidth') || 60,
        // 手势期清晰度优先：默认关闭（关闭 = 手势期提升合成层，帧率优先）
        mindmapGestureCrisp: settingsState.getBoolean('mindmapGestureCrisp'),
        // 内链箭头层：默认开启（schema 默认值即 true）
        mindmapInternalLinks: settingsState.getBoolean('mindmapInternalLinks'),
        // 快速卡片：开关 + 宽高（0 视为没读到，回退 schema 默认值）
        quickCardEnabled: settingsState.getBoolean('quickCardEnabled'),
        quickCardWidth: settingsState.getNumber('quickCardWidth') || 280,
    };
}

/**
 * 导图编辑回写：把导图算出的新全文同步进隐藏的 CodeMirror 实例。
 *
 * 走 CM dispatch 而不是直发 CONTENT_CHANGE，是为了让导图操作进入 CM 撤销栈
 * （Ctrl+Z / 切回文本 undo 都能撤销，一次导图操作 = 一步 undo），
 * 随后由现有 contentChange 监听防抖上报给扩展（设计文档 §3.3）。
 *
 * dispatch 的变更范围是「新旧全文的公共前后缀之间的最小差异」，
 * 不是整篇替换：全量替换会让 CM 重建整篇语法树与块装饰，大文档拖动
 * 松手时会明显卡顿；最小差异的开销只和改动块的大小相关。
 *
 * @param newFullText 导图操作算出的新全文
 */
export function applyDocumentEdit(
    newFullText: string,
    source: 'mindmap' | 'slides' | 'live' = 'mindmap'
): void {
    const view = ctx.editor?.getView();
    if (!view) {
        // CM 还没就绪 / 正在 INIT 重建：不能把改动丢掉，直接把全文发扩展侧。
        // INIT 重建时应用 destroy() 会先把未提交的编辑写回这里，
        // 这条兜底保证「刚打开文件就编辑」的那一下也送得出去。
        sendLog(
            'WARN',
            `${source} edit: CodeMirror view is not ready, sending content directly`
        );
        ctx.debouncedSendContentChange(newFullText);
        ctx.debouncedSendContentChange.flush();
        return;
    }
    const oldText = view.state.doc.toString();
    if (oldText === newFullText) return;
    // 不再全量替换：拖动一次通常只动一小块，算出公共前后缀后只替换中间。
    // 全量 dispatch 会让隐藏的 CM 重建整篇语法树/块装饰，文档大时拖动
    // 松手会明显卡一下；最小变更把这块成本压到与改动块同量级。
    let start = 0;
    const minLength = Math.min(oldText.length, newFullText.length);
    while (
        start < minLength &&
        oldText.charCodeAt(start) === newFullText.charCodeAt(start)
    ) {
        start += 1;
    }
    let oldEnd = oldText.length;
    let newEnd = newFullText.length;
    while (
        oldEnd > start &&
        newEnd > start &&
        oldText.charCodeAt(oldEnd - 1) === newFullText.charCodeAt(newEnd - 1)
    ) {
        oldEnd -= 1;
        newEnd -= 1;
    }
    view.dispatch({
        changes: {
            from: start,
            to: oldEnd,
            insert: newFullText.slice(start, newEnd),
        },
    });
    // 导图编辑是离散操作（提交一次 = 一步），不必等 300ms 防抖：
    // 立即把全文发给扩展侧。否则「提交完马上切走/关面板」时改动会
    // 卡在防抖定时器里，表现为「失焦后没写回」。
    ctx.debouncedSendContentChange.flush();
}

/** 导图编辑回写（兼容旧调用点）。 */
export function applyMindmapEdit(newFullText: string): void {
    applyDocumentEdit(newFullText, 'mindmap');
}

/**
 * 导图模式的撤销 / 重做（todo.md 任务 7）。
 *
 * 导图编辑本来就通过 applyMindmapEdit 走「隐藏 CM 的最小差异 dispatch」进
 * CM 撤销栈，所以导图里的 Ctrl+Z/Y 等价于对隐藏 CM 执行 undo/redo；
 * 完成后立即把新文档喂回导图重建（UPDATE 防抖回环太慢，等不起）。
 */
export function applyMindmapUndoRedo(kind: 'undo' | 'redo'): void {
    const view = ctx.editor?.getView();
    if (!view) return;
    const applied = kind === 'undo' ? undo(view) : redo(view);
    if (applied) {
        ctx.mindmapApp?.setDocument(view.state.doc.toString(), ctx.mindmapFileName);
    }
}

// ==================================================================
// 快速卡片栏（live / 幻灯片）
//
// 导图里那条卡片栏（quickCardRail）本身不依赖画布：卡片内容直接读写
// Markdown 的 `<<<` / `>>>` 块。这里把它挂到两种视图的右侧：
// - live：挂 #editor-pane，和正文共用同一份文档；
// - 幻灯片：挂 .slides-stage-wrap（顶部工具栏之下、舞台 scale 之外），
//   parseDeck 会把卡片行掩码掉，卡片不会变成幻灯片正文。
//
// 两边共用同一套行为：
// - 卡片提交 = applyDocumentEdit（最小差异 dispatch，进 CM 撤销栈）→
//   立即刷新卡片；幻灯片额外 setDocument 同步它自己的模型；
// - 正文打字 / 外部更新 → 防抖刷新卡片；
// - 拖卡片进正文只支持 live（幻灯片第一版不做拖放）。
// ==================================================================

/** 卡片栏宿主：live 与 slides 各一份。 */
interface QuickCardsHost {
    mode: 'live' | 'slides';
    /** 卡片栏实例（懒建）。 */
    rail: QuickCardRail | null;
    /** 正在加载实现模块（防并发重复创建）。 */
    loading: Promise<QuickCardRail | null> | null;
    /** 创建代次：INIT 销毁时 +1，丢弃还在加载中的旧实例。 */
    generation: number;
    /** 正文打字时的刷新防抖（每键都重建 mini-CM 会把打字拖卡）。 */
    refreshTimer: number;
    /** 防抖期间攒下的最新全文。 */
    pendingMarkdown: string | null;
    /** 容器尺寸变化 → 重新摆放。 */
    resizeObserver: ResizeObserver | null;
    /** 幻灯片：放映态监听（#slides 的 class 变化）。 */
    presentingObserver: MutationObserver | null;
}

/** live 模式卡片栏宿主（挂在 #editor-pane）。 */
const liveCardsHost: QuickCardsHost = {
    mode: 'live',
    rail: null,
    loading: null,
    generation: 0,
    refreshTimer: 0,
    pendingMarkdown: null,
    resizeObserver: null,
    presentingObserver: null,
};

/** 幻灯片模式卡片栏宿主（挂在 .slides-stage-wrap）。 */
const slidesCardsHost: QuickCardsHost = {
    mode: 'slides',
    rail: null,
    loading: null,
    generation: 0,
    refreshTimer: 0,
    pendingMarkdown: null,
    resizeObserver: null,
    presentingObserver: null,
};

/** 拖卡片进正文时的落点指示线（挂在 #editor-pane 上）。 */
let liveDropMark: HTMLElement | null = null;
/** 指示线当前画在哪一行（同一行不重复写 DOM）。 */
let liveDropLine = -1;

/** 当前模式对应的卡片栏宿主；非卡片模式返回 null。 */
function activeQuickCardsHost(): QuickCardsHost | null {
    if (ctx.currentEditorMode === 'live') return liveCardsHost;
    if (ctx.currentEditorMode === 'slides') return slidesCardsHost;
    return null;
}

/** 该模式下卡片栏是否应该显示。 */
function shouldShowQuickCards(host: QuickCardsHost): boolean {
    if (ctx.currentEditorMode !== host.mode) return false;
    if (!settingsState.getBoolean('quickCardEnabled')) return false;
    if (!ctx.editor?.isReady()) return false;
    if (host.mode === 'slides') {
        if (!ctx.slidesApp) return false;
        // 放映时舞台铺满，卡片栏让位（CSS 里还有一份即时隐藏）
        const slidesHost = document.getElementById('slides');
        if (slidesHost?.classList.contains('slides-presenting')) return false;
    }
    return true;
}

/** 卡片栏挂载容器。 */
function quickCardsContainer(mode: QuickCardsHost['mode']): HTMLElement | null {
    if (mode === 'live') return document.getElementById('editor-pane');
    // 舞台区在工具栏下方，且不会被 .slides-stage 的 scale 带走
    return document.querySelector<HTMLElement>('#slides .slides-stage-wrap');
}

/** 按宿主模式拼 QuickCardRail 的回调。 */
function createQuickCardOptions(host: QuickCardsHost): QuickCardRailOptions {
    return {
        // 主编辑器的文档就是唯一数据源（幻灯片回写也先同步进隐藏 CM）
        getMarkdown: () => ctx.editor?.getContent() ?? '',
        commit: (text) => {
            // 最小差异 dispatch + 立即上报扩展侧，卡片改动进 CM 撤销栈
            applyDocumentEdit(text, host.mode);
            // 幻灯片的模型是独立一份 fullText：不同步的话 Ctrl+S 与块回写
            // 都会用旧全文覆盖卡片改动（setDocument 不回调 onEdit，无环）
            if (host.mode === 'slides') {
                ctx.slidesApp?.setDocument(text, ctx.mindmapFileName);
            }
            // 卡片栏自己改的内容立即重画，不等主编辑器 onChange 的防抖
            host.rail?.refresh(text);
        },
        getSettings: () => ({
            enabled: settingsState.getBoolean('quickCardEnabled'),
            width: settingsState.getNumber('quickCardWidth') || 280,
        }),
        getTheme: () => ctx.currentTheme,
        codeLanguages,
        getFileName: () => ctx.mindmapFileName,
        onResize: (width) => {
            settingsState.set('quickCardWidth', width);
            ctx.vscode.postMessage({
                type: MESSAGE_TYPES.UPDATE_SETTING,
                key: 'quickCardWidth',
                value: width,
            });
        },
        // 复制 / 粘贴走扩展侧 relay（webview 原生剪贴板在 VS Code 里不稳）
        copyText: async (text) => {
            try {
                await copyToClipboard(text);
                return true;
            } catch {
                try {
                    await navigator.clipboard.writeText(text);
                    return true;
                } catch {
                    return false;
                }
            }
        },
        readText: async () => {
            try {
                return await navigator.clipboard.readText();
            } catch {
                return '';
            }
        },
        // 拖放只有 live 有落点（正文行）；幻灯片第一版不做拖放：
        // 传 undefined 时 rail 拖出栏外不会删卡，只会清掉选中。
        onCardDragPreview:
            host.mode === 'live'
                ? (at) => {
                      if (at) previewLiveCardDrop(at);
                      else clearLiveCardDrop();
                  }
                : undefined,
        onCardDropOnMap:
            host.mode === 'live'
                ? (index, clientX, clientY) => {
                      void dropLiveCardOnEditor(index, clientX, clientY);
                  }
                : undefined,
    };
}

/** 创建（或复用）某个模式的卡片栏。不可见 / 加载失败时返回 null。 */
export async function ensureQuickCards(
    mode: QuickCardsHost['mode']
): Promise<QuickCardRail | null> {
    const host = mode === 'live' ? liveCardsHost : slidesCardsHost;
    if (host.rail) return host.rail;
    if (!shouldShowQuickCards(host)) return null;
    if (host.loading) return host.loading;
    const container = quickCardsContainer(mode);
    if (!container) return null;

    const generation = host.generation;
    host.loading = (async () => {
        try {
            // 卡片正文与导图节点共用同一套只读 mini-CM 与节点样式；
            // 这两块只在真正需要卡片栏时才加载，不进入普通首屏。
            const [{ QuickCardRail }, { ensureMindMapCss }] = await Promise.all([
                import('../mindmap/quickCardRail.js'),
                import('../mindmap/styles/index.js'),
            ]);
            // 加载期间可能已切模式 / INIT 重建 / 关掉设置：放弃这次创建
            if (
                generation !== host.generation ||
                !shouldShowQuickCards(host)
            ) {
                return null;
            }
            ensureMindMapCss();

            const rail = new QuickCardRail(container, createQuickCardOptions(host));
            host.rail = rail;
            rail.setHostVisible(true);
            rail.refresh();
            // 窗口缩放 / 拖动大纲宽度都会改变摆放区高度：重新平铺或重叠
            host.resizeObserver?.disconnect();
            host.resizeObserver = new ResizeObserver(() =>
                host.rail?.relayout()
            );
            host.resizeObserver.observe(container);
            if (mode === 'slides') watchSlidesPresenting();
            return rail;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendLog('ERROR', `${mode} quick cards init failed: ${message}`);
            return null;
        } finally {
            host.loading = null;
        }
    })();
    return host.loading;
}

/** 销毁一条卡片栏宿主（INIT 换文档 / 退出编辑器时）。 */
function destroyQuickCardsHost(host: QuickCardsHost): void {
    host.generation += 1;
    host.loading = null;
    // destroy 里会提交正在编辑的卡片 → applyDocumentEdit → onChange 可能
    // 又排一个刷新定时器，所以定时器要在 destroy 之后再清
    host.rail?.destroy();
    host.rail = null;
    host.resizeObserver?.disconnect();
    host.resizeObserver = null;
    host.presentingObserver?.disconnect();
    host.presentingObserver = null;
    window.clearTimeout(host.refreshTimer);
    host.refreshTimer = 0;
    host.pendingMarkdown = null;
}

/** 销毁两条卡片栏（INIT 换文档 / 退出编辑器时）。 */
export function destroyQuickCards(): void {
    destroyQuickCardsHost(liveCardsHost);
    destroyQuickCardsHost(slidesCardsHost);
    clearLiveCardDrop();
    liveDropMark?.remove();
    liveDropMark = null;
}

/** 立即刷新当前模式的卡片栏（文档 / 主题变化）。 */
export function refreshQuickCards(markdown?: string, force = false): void {
    const host = activeQuickCardsHost();
    if (!host) return;
    refreshQuickCardsHost(host, markdown, force);
}

function refreshQuickCardsHost(
    host: QuickCardsHost,
    markdown?: string,
    force = false
): void {
    if (!host.rail) return;
    window.clearTimeout(host.refreshTimer);
    host.refreshTimer = 0;
    host.pendingMarkdown = null;
    host.rail.refresh(markdown, force);
}

/** 主编辑器打字后的防抖刷新（180ms：卡片栏不是每次按键都肉眼可见在变）。 */
export function scheduleQuickCardsRefresh(markdown: string): void {
    const host = activeQuickCardsHost();
    if (!host?.rail) return;
    host.pendingMarkdown = markdown;
    if (host.refreshTimer) return;
    host.refreshTimer = window.setTimeout(() => {
        host.refreshTimer = 0;
        const pending = host.pendingMarkdown;
        host.pendingMarkdown = null;
        host.rail?.refresh(pending ?? undefined);
    }, 180);
}

/** 收起两条卡片栏（模式切换前先失焦提交正在编辑的卡片）。 */
function hideQuickCards(): void {
    liveCardsHost.rail?.setHostVisible(false);
    slidesCardsHost.rail?.setHostVisible(false);
    clearLiveCardDrop();
}

/**
 * 监听 #slides 的放映类名（slides-presenting）。
 *
 * 放映时舞台铺满，卡片栏要收起；退出放映再按模式 / 设置恢复。监听与
 * 卡片栏实例分开建立：即使卡片栏因为设置关闭还没创建，退出放映后也能
 * 在设置重新打开时按正确状态补建。
 */
function watchSlidesPresenting(): void {
    const host = slidesCardsHost;
    const slidesHost = document.getElementById('slides');
    if (!slidesHost) return;
    host.presentingObserver?.disconnect();
    host.presentingObserver = new MutationObserver(() =>
        syncQuickCardsVisibility()
    );
    host.presentingObserver.observe(slidesHost, {
        attributes: true,
        attributeFilter: ['class'],
    });
}

/** 模式 / 设置 / 放映状态变化后同步两条卡片栏的显隐。 */
export function syncQuickCardsVisibility(): void {
    syncQuickCardsHost(liveCardsHost);
    syncQuickCardsHost(slidesCardsHost);
}

function syncQuickCardsHost(host: QuickCardsHost): void {
    if (!shouldShowQuickCards(host)) {
        host.rail?.setHostVisible(false);
        if (host.mode === 'live') clearLiveCardDrop();
        return;
    }
    if (!host.rail) {
        void ensureQuickCards(host.mode);
        return;
    }
    host.rail.setHostVisible(true);
    host.rail.applySettings();
    // 模式切换期间主编辑器可能已被 UPDATE 换过文档：按当前文本重取一次
    refreshQuickCardsHost(host);
}

/** 拖卡片进正文时的落点指示线：画在指针所在行的上边缘。 */
function previewLiveCardDrop(at: { clientX: number; clientY: number }): void {
    const pane = document.getElementById('editor-pane');
    const view = ctx.editor?.getView();
    if (!pane || !view) return;
    const pos = view.posAtCoords({ x: at.clientX, y: at.clientY });
    if (pos === null) {
        clearLiveCardDrop();
        return;
    }
    const line = view.state.doc.lineAt(pos);
    // 同一行内移动：指示线不动，省掉拖动中的重复写样式
    if (line.number === liveDropLine && liveDropMark?.isConnected) return;
    const coords = view.coordsAtPos(line.from);
    if (!coords) {
        clearLiveCardDrop();
        return;
    }
    let mark = liveDropMark;
    if (!mark || !mark.isConnected) {
        mark = document.createElement('div');
        mark.className = 'lwm-qcards-live-dropmark';
        pane.appendChild(mark);
        liveDropMark = mark;
    }
    const paneRect = pane.getBoundingClientRect();
    const contentRect = view.contentDOM.getBoundingClientRect();
    const left = Math.max(0, contentRect.left - paneRect.left);
    liveDropLine = line.number;
    mark.style.display = 'block';
    mark.style.left = `${Math.round(left)}px`;
    mark.style.width = `${Math.round(
        Math.max(0, Math.min(contentRect.width, paneRect.width - left))
    )}px`;
    mark.style.top = `${Math.round(coords.top - paneRect.top)}px`;
}

/** 撤掉落点指示线（拖动结束 / 指针离开正文）。 */
function clearLiveCardDrop(): void {
    liveDropLine = -1;
    if (liveDropMark) liveDropMark.style.display = 'none';
}

/**
 * 拖卡片进正文：把卡片内容插到指针所在行，并删除原卡片。
 *
 * 两次修改合成一份新全文，再走 applyDocumentEdit → 一步撤销。
 * 指针不在正文上（落在大纲 / 编辑器外）时什么也不做 —— 不能把卡片删了
 * 却没地方放内容。
 */
async function dropLiveCardOnEditor(
    index: number,
    clientX: number,
    clientY: number
): Promise<void> {
    const view = ctx.editor?.getView();
    if (!view) return;
    const pos = view.posAtCoords({ x: clientX, y: clientY });
    // 不在正文上：当作取消拖放
    if (pos === null) return;

    const markdown = view.state.doc.toString();
    const lineIndex = view.state.doc.lineAt(pos).number - 1;
    // 纯编辑函数与卡片栏同源（已经在卡片栏 chunk 里，这里直接取用）
    const { parseQuickCards, deleteQuickCard } = await import(
        '../mindmap/edit/staging.js'
    );
    // 等待加载期间文档可能被外部改过（INIT / UPDATE）：按最新文本重算
    const current = ctx.editor?.getView();
    if (!current || current.state.doc.toString() !== markdown) return;
    const card = parseQuickCards(markdown)[index];
    if (!card || !card.text.trim()) return;
    // 落在卡片自己身上：原地放下，不删也不插
    if (lineIndex >= card.fromLine && lineIndex <= card.toLine) return;

    // 卡片删除会带走块本身 + 块上下多余的连续空行（deleteQuickCard 的
    // 整理逻辑）。目标行在「受影响的空行段」之后时，要按实际删掉的行数
    // 整体上移；落在空行段里则插到压剩下的那个空行位置。
    const original = markdown.split('\n');
    let blankAboveStart = card.fromLine;
    while (blankAboveStart > 0 && original[blankAboveStart - 1]!.trim() === '') {
        blankAboveStart -= 1;
    }
    let blankBelowEnd = card.toLine + 1;
    while (blankBelowEnd < original.length && original[blankBelowEnd]!.trim() === '') {
        blankBelowEnd += 1;
    }
    const keepBlank = blankAboveStart > 0 && blankBelowEnd < original.length ? 1 : 0;
    const removedLines =
        card.toLine - card.fromLine + 1 +
        (card.fromLine - blankAboveStart) +
        (blankBelowEnd - card.toLine - 1) -
        keepBlank;
    let targetLine: number;
    if (lineIndex < blankAboveStart) targetLine = lineIndex;
    else if (lineIndex >= blankBelowEnd) targetLine = lineIndex - removedLines;
    // 卡片下方全是空行（直到文末）：删卡会把尾部空行一起收掉，直接落到文末
    else if (blankBelowEnd >= original.length) targetLine = Number.MAX_SAFE_INTEGER;
    else targetLine = blankAboveStart;

    const without = deleteQuickCard(markdown, index);
    const next = insertPlainBlock(without, targetLine, card.text);
    if (next !== markdown) applyDocumentEdit(next, 'live');
}

/** 在指定行之前插入一段普通 Markdown（需要时两侧各补一个空行）。 */
function insertPlainBlock(
    markdown: string,
    lineIndex: number,
    content: string
): string {
    const lines = markdown.split('\n');
    const at = Math.max(0, Math.min(lineIndex, lines.length));
    const block = content.replace(/\r\n?/g, '\n').split('\n');
    const out = lines.slice(0, at);
    const previous = out[out.length - 1];
    // 与上一段之间隔一个空行（贴文首 / 上一行本来为空就不补）
    if (previous !== undefined && previous.trim() !== '') out.push('');
    out.push(...block);
    const rest = lines.slice(at);
    const nextLine = rest[0];
    if (nextLine !== undefined && nextLine.trim() !== '') out.push('');
    out.push(...rest);
    return out.join('\n');
}

/**
 * 卡片快捷键（window 捕获阶段，live / 幻灯片共用）。
 *
 * - Ctrl/Cmd+S 且正在编辑卡片：先提交卡片再强制落盘（与导图 onSave 一致）；
 *   没在编辑卡片时不拦截，交给 VS Code / 幻灯片正常保存；
 * - Delete / Ctrl+C/X/V：卡片被选中时焦点往往还留在正文里（卡片
 *   pointerdown 被 preventDefault），这里转发给卡片栏，和导图的分流一致；
 * - 幻灯片：卡片只选中时，翻页键 / 换主题键会被幻灯片抢走，这里吞掉。
 */
function onQuickCardsKeyDown(event: KeyboardEvent): void {
    const host = activeQuickCardsHost();
    const rail = host?.rail;
    if (!host || !rail) return;
    const target = event.target instanceof Element ? event.target : null;
    // 幻灯片块编辑器优先：块编辑中（焦点在幻灯片块的 mini-CM 里）不抢键。
    // 卡片选中态不可能与块编辑同时存在（点卡片会先让块编辑器失焦提交），
    // 这里只防极端时序。卡片自己的 mini-CM 在卡片栏内，不受这条影响。
    if (
        host.mode === 'slides' &&
        target?.closest('.cm-editor') &&
        !target.closest('.lwm-qcards')
    ) {
        return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        if (event.key.toLowerCase() === 's' && rail.debugState().editing) {
            event.preventDefault();
            event.stopPropagation();
            // 幻灯片：commit 回调已把新全文同步进 slidesApp.fullText
            rail.flushEdit();
            ctx.vscode.postMessage({
                type: MESSAGE_TYPES.SAVE_DOCUMENT,
                content: ctx.editor?.getContent() ?? '',
            });
            return;
        }
    }
    rail.handleKey(event);
    // 幻灯片：卡片只选中（焦点不在卡内）时，方向键/空格/Home/End/t 会被
    // 幻灯片拿去翻页或换主题；在捕获阶段吞掉。上下键留给卡片栏自己的
    // 键盘导航；编辑中或焦点在任意 mini-CM 里不拦（光标要动）。
    if (host.mode !== 'slides') return;
    const state = rail.debugState();
    if (state.activeIndex === null || state.editing) return;
    if (target?.closest('.cm-editor')) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (
        event.key === 'ArrowLeft' ||
        event.key === 'ArrowRight' ||
        event.key === 'PageUp' ||
        event.key === 'PageDown' ||
        event.key === 'Home' ||
        event.key === 'End' ||
        event.key === ' ' ||
        event.key === 't' ||
        event.key === 'T'
    ) {
        event.preventDefault();
        event.stopPropagation();
    }
}
window.addEventListener('keydown', onQuickCardsKeyDown, true);

/**
 * 进入导图模式：隐藏文本容器（CM 实例保留），惰性创建/复用导图应用。
 */
export async function enterMindmapMode(): Promise<void> {
    const host = getMindmapHost();
    const editorHost = getOrCreateEditorHost();
    // 必须在隐藏编辑器之前量：容器 hidden 之后 clientHeight = 0，
    // lineBlockAtHeight 拿不到当前屏
    const middleLine = ctx.editor?.getViewportMiddleLine() ?? null;
    editorHost.hidden = true;
    host.hidden = false;

    if (!ctx.mindmapApp) {
        // 首次进导图才加载实现模块：画布引擎 / 样式模板 / 快速卡片栏加起来
        // 约 200KB，和文本编辑器首屏无关，没必要让每次打开文件都等它。
        const { MindMapApp } = await import('../mindmap/mindmapApp.js');
        ctx.mindmapApp = new MindMapApp(host, {
            onEdit: applyMindmapEdit,
            // Ctrl+S：强制写回并保存。
            // 先把最新全文同步进隐藏 CM（进撤销栈，也和后续 UPDATE 对齐），
            // 再让扩展侧直接落盘 —— 不走 CONTENT_CHANGE 的跳过分支，
            // 这样 webview 里「还没提交/被防抖压着」的改动也不会丢。
            onSave: (fullText: string) => {
                applyMindmapEdit(fullText);
                ctx.vscode.postMessage({
                    type: MESSAGE_TYPES.SAVE_DOCUMENT,
                    content: fullText,
                });
            },
            onUndo: () => applyMindmapUndoRedo('undo'),
            onRedo: () => applyMindmapUndoRedo('redo'),
            // mini-CM 的代码块嵌套高亮语言表（主编辑器同款）
            codeLanguages,
            // 任务 16：导图选中节点 → 大纲高亮对应行
            onSelectLine: (line: number) => ctx.outlinePanel?.setActiveLine(line),
            // 迭代 N3：导图导出 → extension 存盘
            onExport: (payload) => {
                ctx.vscode.postMessage({ type: 'saveMindmapExport', ...payload });
            },
            // 画布上改的设置（拖动快速卡片左边界 = quickCardWidth）：
            // 先写本地 settingsState（下次 readMindmapSettings 拿得到），
            // 再走设置面板同一条 UPDATE_SETTING 通道落盘
            onPersistSetting: (key, value) => {
                settingsState.set(key, value);
                ctx.vscode.postMessage({ type: MESSAGE_TYPES.UPDATE_SETTING, key, value });
            },
        });
        ctx.mindmapApp.setTheme(ctx.currentTheme);
        ctx.mindmapApp.setSettings(readMindmapSettings());
    }
    if (ctx.editor && ctx.editor.isReady()) {
        ctx.mindmapApp.setDocument(ctx.editor.getContent(), ctx.mindmapFileName);
    }
    await ctx.mindmapApp.whenReady();
    ctx.mindmapApp.setActive(true);
    // 从文本模式「当前看到的这一屏中间」开始，并固定 100% 缩放。
    // setActive 内部的 fit() 会按整棵树自动缩放，focusLineFromEditor 覆盖它。
    if (middleLine !== null) ctx.mindmapApp.focusLineFromEditor(middleLine - 1);
    sendLog('INFO', 'Mindmap mode activated');
}

/**
 * 退出导图模式：隐藏导图容器、恢复文本容器；CM 状态（撤销栈/光标/滚动）原样保留。
 */
export function leaveMindmapMode(): void {
    // 必须在 setActive(false) 之前取：它会 clearSelection()，之后就只剩
    // 「视口中心」这一条线索了。优先级：选中/编辑节点 → 视口中心节点。
    const focusLine = ctx.mindmapApp?.getFocusLine0() ?? null;
    getMindmapHost().hidden = true;
    getOrCreateEditorHost().hidden = false;
    ctx.mindmapApp?.setActive(false);
    // 容器从 display:none 恢复后让 CM 重新测量
    requestAnimationFrame(() => {
        const view = ctx.editor?.getView();
        view?.requestMeasure();
        // 回到导图里最后看的那一项（行号是 0-based，scrollToLine 要 1-based）
        if (focusLine !== null) ctx.editor?.scrollToLine(focusLine + 1);
    });
}

/**
 * 进入幻灯片模式：隐藏文本容器（CM 实例保留），惰性创建 / 复用幻灯片应用。
 *
 * 顺序很重要：先把文档喂给应用（非激活状态只记录），再 setActive 一次性
 * 解析 / 测量 / 渲染，避免先跑一轮空文档。
 */
export async function enterSlidesMode(): Promise<void> {
    const host = getSlidesHost();
    const editorHost = getOrCreateEditorHost();
    // 容器隐藏后拿不到光标行，进入前先取（1-based → 0-based）
    const currentLine =
        ctx.editor && ctx.editor.isReady()
            ? Math.max(0, ctx.editor.getCurrentLine() - 1)
            : null;
    editorHost.hidden = true;
    host.hidden = false;

    if (!ctx.slidesApp) {
        // 幻灯片同理：解析 / 分页 / 样式的整套代码只在第一次进幻灯片时加载。
        const { SlidesApp } = await import('../slides/slidesApp.js');
        ctx.slidesApp = new SlidesApp(host, {
            onEdit: (fullText) => {
                applyDocumentEdit(fullText, 'slides');
                // PPT 内编辑块后，右侧卡片栏跟着重解析（隐藏/未建时 no-op）
                slidesCardsHost.rail?.refresh(fullText);
            },
            // Ctrl+S：强制写回并落盘，和导图同一条路径
            onSave: (fullText) => {
                applyDocumentEdit(fullText, 'slides');
                ctx.vscode.postMessage({
                    type: MESSAGE_TYPES.SAVE_DOCUMENT,
                    content: fullText,
                });
            },
            onPersistSetting: (key, value) => {
                settingsState.set(key, value);
                ctx.vscode.postMessage({
                    type: MESSAGE_TYPES.UPDATE_SETTING,
                    key,
                    value,
                });
            },
            // mini-CM 的代码块嵌套高亮语言表（主编辑器同款）
            codeLanguages,
            // PPT 模式复用右侧大纲：分页一变就重渲染页码标注
            onPagesChange: () => ctx.outlinePanel?.refresh(),
            // 大纲高亮跟着当前页走（PPT 页面里没有正文光标）
            onActiveLineChange: (line0) => {
                if (line0 !== null) {
                    ctx.outlinePanel?.setActiveLine(line0 + 1);
                }
            },
            // 物理屏幕全屏：webview 是沙箱 iframe，requestFullscreen 被拒时
            // 让扩展宿主执行 F11 同款的窗口全屏命令
            onWindowFullscreen: (on) => {
                ctx.vscode.postMessage({
                    type: MESSAGE_TYPES.SLIDES_FULLSCREEN,
                    on,
                });
            },
        });
        ctx.slidesApp.setEditorTheme(ctx.currentTheme);
        ctx.slidesApp.applySettings();
    }

    // 大纲右侧的「行号」换成页码（P8 / P8,9）。分页还没算完时返回空串，
    // 大纲会自动回退显示行号。
    ctx.outlinePanel?.setMetaProvider(
        (line) => ctx.slidesApp?.getOutlinePageLabel(line) ?? ''
    );

    ctx.slidesApp.setDocument(
        ctx.editor?.getContent() ?? '',
        ctx.mindmapFileName
    );
    ctx.slidesApp.setActive(true, currentLine);
    await ctx.slidesApp.whenReady();
    // 幻灯片应用就绪后补建 / 显示右侧卡片栏（容器 .slides-stage-wrap 已存在）
    watchSlidesPresenting();
    syncQuickCardsVisibility();
    sendLog('INFO', 'Slides mode activated');
}

/**
 * 退出幻灯片模式：提交未完成的编辑、隐藏容器、恢复文本容器。
 *
 * 切回文本时尽量回到当前页第一行，保持和导图一致的「位置连续」体验。
 */
export function leaveSlidesMode(): void {
    const host = getSlidesHost();
    // 先收起卡片栏（内部会失焦提交正在编辑的卡片），再离开幻灯片
    slidesCardsHost.rail?.setHostVisible(false);
    const line = ctx.slidesApp?.getCurrentLine0() ?? null;
    ctx.slidesApp?.setActive(false);
    // 大纲恢复成普通行号显示
    ctx.outlinePanel?.setMetaProvider(null);
    host.hidden = true;
    getOrCreateEditorHost().hidden = false;
    requestAnimationFrame(() => {
        const view = ctx.editor?.getView();
        view?.requestMeasure();
        // 幻灯片期间表格列宽可能是按块编辑器的字体口径量的（测量根被
        // setMeasureRootOverride 临时切走过），回到正文后强制重排一次表格
        if (view) view.dispatch({ effects: tableRemeasureEffect.of(null) });
        // 回到幻灯片里最后看的那一页第一行（行号是 0-based，scrollToLine 要 1-based）
        if (line !== null) ctx.editor?.scrollToLine(line + 1);
    });
}

/**
 * 应用扩展侧下发的模式切换（live / viewer / source / mindmap / slides）。
 *
 * @param mode 目标模式
 */
export async function applyEditorMode(mode: EditorMode): Promise<void> {
    const previousMode = ctx.currentEditorMode;
    ctx.currentEditorMode = mode;
    // 卡片栏挂在视图容器上，不随 #editor 隐藏：切模式先收起
    // （setHostVisible(false) 会先失焦提交正在编辑的卡片）
    hideQuickCards();
    if (mode === 'mindmap') {
        leaveSlidesMode();
        await enterMindmapMode();
        return;
    }
    if (mode === 'slides') {
        leaveMindmapMode();
        // enterSlidesMode 末尾会 sync：等 .slides-stage-wrap 就绪后再建栏
        await enterSlidesMode();
        return;
    }
    leaveSlidesMode();
    leaveMindmapMode();
    if (ctx.editor && ctx.editor.isReady()) {
        ctx.editor.setMode(mode);
        // 三个文本模式互切：永远回到最近一次光标 / 鼠标位置。
        // 切出 / 切入导图、幻灯片时不插手 —— 它们有自己的位置恢复逻辑。
        // setMode 重配了装饰，行高与折行都会变，等一帧重新测量后再滚，
        // 否则滚到的是旧布局的行位置。
        const isTextMode = (value: EditorMode | null | undefined): boolean =>
            value === 'live' || value === 'viewer' || value === 'source';
        if (
            previousMode !== mode &&
            isTextMode(previousMode) &&
            isTextMode(mode)
        ) {
            const line = ctx.editor.getCurrentLine();
            requestAnimationFrame(() => {
                const view = ctx.editor?.getView();
                view?.requestMeasure();
                ctx.editor?.revealLine(line);
            });
        }
    }
    // live 补建 / 显示；viewer / source 保持收起
    syncQuickCardsVisibility();
}

/**
 * 获取右侧大纲面板的初始宽度。
 *
 * 优先读取 HTML 注入的 CSS 变量，这样页面首次渲染时就能直接使用
 * 扩展端保存的宽度；如果读取失败，则回退到默认值。
 *
 * @returns 右侧大纲面板初始宽度，单位像素
 */
export function getInitialOutlineWidth(): number {
    const rawWidth = getComputedStyle(document.documentElement).getPropertyValue(
        '--livewritemd-outline-width'
    );
    const parsedWidth = Number.parseFloat(rawWidth);
    if (!Number.isFinite(parsedWidth) || parsedWidth <= 0) {
        return 280;
    }
    return Math.round(parsedWidth);
}

/**
 * 同步当前编辑器光标所在行到右侧大纲。
 *
 * 这样大纲高亮会跟随正文光标移动，而不是长期停留在第一条标题上。
 *
 * @returns void
 */
export function syncOutlineActiveLine(): void {
    if (!ctx.editor || !ctx.editor.isReady()) {
        return;
    }

    try {
        ctx.outlinePanel?.setActiveLine(ctx.editor.getCurrentLine());
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        sendLog('ERROR', `Sync outline active line skipped: ${errorMessage}`);
    }
}

/**
 * 判断事件目标是否属于需要自行保留焦点的交互控件。
 *
 * @param target - 待检查的事件目标或当前激活元素。
 * @returns 如果目标属于搜索面板、表单控件或可编辑元素则返回 true。
 */
export function isInteractiveFocusTarget(target: EventTarget | Element | null): boolean {
    if (!(target instanceof Element)) {
        return false;
    }

    // 搜索面板和原生表单控件需要保留自身焦点，避免被正文编辑器抢走。
    return Boolean(
        target.closest(
            '.cm-search, input, textarea, select, button, [contenteditable="true"], [role="textbox"]'
        )
    );
}
