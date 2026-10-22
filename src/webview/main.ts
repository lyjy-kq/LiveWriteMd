/**
 * LiveWriteMD Webview Entry Point
 *
 * This module serves as the entry point for the Webview side of the LiveWriteMD editor.
 * It handles:
 * - VS Code API acquisition
 * - DOMContentLoaded initialization
 * - Ready message sending to Extension
 * - Message reception and routing via WebviewMessageHandler
 * - CodeMirror 6 editor integration
 * - Theme management
 * - Image handler integration
 *
 * Updated for CodeMirror 6:
 * - Replaced MilkdownEditor with CodeMirrorEditor
 * - Using WebviewMessageSender and WebviewMessageHandler from messageHandler.ts
 * - Theme switching via switchTheme() from theme extension
 * - Error handling with error message sending to Extension
 *
 * @module webview/main
 *
 * Design References:
 * - DES-A-002: Extension-Webview communication architecture
 * - DES-A-004: CodeMirror 6 editor design
 * - DES-F-003: Webview file responsibilities
 *
 * Requirements:
 * - REQ-F-002: Webview initialization
 * - REQ-F-003: File loading and CodeMirror display
 * - REQ-F-008: Dark/Light theme support
 * - REQ-F-010: Image display
 */

import { CodeMirrorEditor, codeLanguages } from './codemirror/editor.js';
import { undo, redo } from '@codemirror/commands';
import { switchTheme } from './codemirror/extensions/theme.js';
import { setDocumentBaseUri } from './codemirror/extensions/livePreview/index.js';
import { setMermaidTheme, setPostMessage } from './codemirror/extensions/livePreview/state.js';
import { WebviewMessageSender, WebviewMessageHandler } from './messageHandler.js';
import { WebviewThemeManager } from './theme.js';
import { OutlinePanel } from './outlinePanel.js';
import { EditorContextMenu, type EditorMode } from './editorContextMenu.js';
import { cellAt } from './codemirror/extensions/livePreview/tableRender.js';
import { runTableCommand } from './codemirror/extensions/livePreview/tableCommands.js';
import type { SettingValue } from '../shared/settingsSchema.js';
import { settingsState } from './settingsState.js';
import { settingsPanel } from './settingsPanel.js';
import { createSearchHistoryController, type SearchHistoryController } from './codemirror/extensions/searchHistory.js';
import {
    setupImageDropHandler,
    createImagePasteHandler,
    handleImageSaved,
    handleImageSaveError,
} from './imageDropHandler.js';
import type { ThemeType, LiveWriteMdEditorSettings } from '../shared/types.js';
import type { SearchHistoryState } from '../shared/searchHistory.js';
import { MESSAGE_TYPES } from '../shared/messageTypes.js';
import { MindMapApp } from './mindmap/mindmapApp.js';
import type { MindMapRuntimeSettings } from './mindmap/types.js';

// =============================================================================
// Type Declarations for VS Code Webview API
// =============================================================================

/**
 * VS Code API interface as available in Webview context.
 * Declared globally by VS Code when running in Webview.
 *
 * Note: Interface name does not follow "I" prefix convention as it mirrors
 * the actual VS Code API interface naming.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
interface IVsCodeApi {
    /**
     * Send a message to the Extension host
     * @param message - The message to send
     */
    postMessage(message: unknown): void;

    /**
     * Get the persisted state for this Webview
     * @returns The persisted state or undefined
     */
    getState(): unknown;

    /**
     * Set the persisted state for this Webview
     * @param state - The state to persist
     */
    setState(state: unknown): void;
}

/**
 * Global function provided by VS Code to acquire the VS Code API.
 * Must be called exactly once per Webview.
 */
declare function acquireVsCodeApi(): IVsCodeApi;

// =============================================================================
// VS Code API Acquisition
// =============================================================================

/**
 * The VS Code API instance.
 * Acquired once at module load and stored for reuse.
 */
const vscode: IVsCodeApi = acquireVsCodeApi();

// Register postMessage for clipboard operations in widgets
setPostMessage((message: unknown) => vscode.postMessage(message));

// =============================================================================
// 控制台日志转发
// =============================================================================

/**
 * Webview 控制台镜像开关。
 *
 * 当前为黑屏问题排查阶段，保持开启以便把启动链路写入 LiveWriteMD 输出。
 * 待启动问题完全稳定后，可再按发布策略评估是否恢复关闭。
 */
const SHOULD_MIRROR_WEBVIEW_CONSOLE = false;

/**
 * 将 Webview 侧日志转成可发送到扩展侧的消息。
 *
 * 当控制台镜像开关关闭时，只保留错误和告警的消息桥接，
 * 避免正式包把 INFO / DEBUG 级别日志带到输出面板。
 *
 * @param level - 日志级别
 * @param args - 控制台原始参数
 * @returns void
 */
function forwardLog(level: 'DEBUG' | 'ERROR' | 'WARN' | 'INFO', args: unknown[]): void {
    if (!SHOULD_MIRROR_WEBVIEW_CONSOLE && level !== 'ERROR' && level !== 'WARN') {
        return;
    }

    const msg = args
        .map((a) => (typeof a === 'object' ? JSON.stringify(a, null, 0) : String(a)))
        .join(' ');
    if (msg.includes('[LiveWriteMD]')) {
        vscode.postMessage({ type: 'webviewLog', level, msg });
    }
}

const _origDebug = console.debug;
const _origLog = console.log;
const _origError = console.error;
const _origWarn = console.warn;

console.debug = (...args: unknown[]) => {
    if (SHOULD_MIRROR_WEBVIEW_CONSOLE) {
        _origDebug.apply(console, args);
        forwardLog('DEBUG', args);
    }
};
console.log = (...args: unknown[]) => {
    if (SHOULD_MIRROR_WEBVIEW_CONSOLE) {
        _origLog.apply(console, args);
        forwardLog('INFO', args);
    }
};
console.error = (...args: unknown[]) => {
    _origError.apply(console, args);
    if (SHOULD_MIRROR_WEBVIEW_CONSOLE) {
        forwardLog('ERROR', args);
    }
};
console.warn = (...args: unknown[]) => {
    if (SHOULD_MIRROR_WEBVIEW_CONSOLE) {
        _origWarn.apply(console, args);
        forwardLog('WARN', args);
    }
};

/**
 * The WebviewMessageSender instance for sending messages to Extension.
 */
const messageSender: WebviewMessageSender = new WebviewMessageSender(vscode);

/**
 * Debounced content change sender (300ms default).
 */
const debouncedSendContentChange = messageSender.createDebouncedSendContentChange();

/**
 * 大纲内容更新的防抖包装（250ms）。
 *
 * 只在「用户打字」这条路上用；打开文档、外部改动那种一次性更新仍然直接调 setContent。
 */
const debouncedSetOutlineContent = (() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let latest = '';
    return (content: string): void => {
        latest = content;
        if (timer !== null) return;
        timer = setTimeout(() => {
            timer = null;
            outlinePanel?.setContent(latest);
        }, 250);
    };
})();

/**
 * The CodeMirrorEditor instance.
 * Created when the INIT message is received.
 */
let editor: CodeMirrorEditor | null = null;

/**
 * 导图应用实例（mindmap 模式）。
 * 惰性创建：第一次进入导图模式时才实例化自研画布（不再有第三方 chunk）。
 */
let mindmapApp: MindMapApp | null = null;

/** 当前文档文件名（不含扩展名），导图虚拟根使用。 */
let mindmapFileName = '';

/** webview 当前明暗主题，导图主题 auto 时跟随。 */
let currentTheme: ThemeType = 'dark';

/**
 * 搜索/替换历史控制器实例。
 * 用于给 CodeMirror 搜索面板挂载 datalist 并回传历史变更。
 */
let searchHistoryController: SearchHistoryController | null = null;

/**
 * 是否已经收到扩展侧 INIT 消息。
 * 用于 READY 重试逻辑判断，避免 READY 丢失后 Webview 永久等待内容。
 */
let hasReceivedInit = false;

/**
 * Webview 初始化是否已经执行。
 * 用于兼容脚本加载较晚时直接初始化，避免 DOMContentLoaded 监听漏触发。
 */
let hasInitialized = false;

/**
 * 当前编辑器模式，用于正文右键菜单的禁用态同步。
 */
let currentEditorMode: EditorMode = 'live';

/**
 * The WebviewThemeManager instance.
 * Created during initialization, defaults to dark theme.
 */
let themeManager: WebviewThemeManager | null = null;

/**
 * Markdown 正文右键菜单实例。
 */
let editorContextMenu: EditorContextMenu | null = null;

/**
 * 右侧大纲管理器实例。
 * 负责布局、标题树渲染、分隔条拖拽与跳转交互。
 */
let outlinePanel: OutlinePanel | null = null;

/**
 * Current document URI for image path resolution.
 * Note: Used by imageHandler integration for local image URL transformation.
 */
let currentDocumentUri: string = '';

// =============================================================================
// Export Functions for Testing
// =============================================================================

/**
 * Get the current document URI.
 * Exported for imageHandler to use for local image path resolution.
 *
 * @returns The current document URI
 */
export function getCurrentDocumentUri(): string {
    return currentDocumentUri;
}

/**
 * Get the VS Code API instance.
 * Exported for testing purposes.
 *
 * @returns The VS Code API instance
 */
export function getVsCodeApi(): IVsCodeApi {
    return vscode;
}

/**
 * Get the CodeMirrorEditor instance.
 * Exported for testing purposes.
 *
 * @returns The CodeMirrorEditor instance or null if not created
 */
export function getEditor(): CodeMirrorEditor | null {
    return editor;
}

/**
 * Get the WebviewThemeManager instance.
 * Exported for testing purposes.
 *
 * @returns The WebviewThemeManager instance or null if not created
 */
export function getThemeManager(): WebviewThemeManager | null {
    return themeManager;
}

/**
 * 获取或创建编辑器宿主容器。
 *
 * @returns 编辑器宿主 DOM 节点。
 */
function getOrCreateEditorHost(): HTMLElement {
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
function getMindmapHost(): HTMLElement {
    return document.getElementById('mindmap') as HTMLElement;
}

/**
 * 从文档 URI 推导文件名（不含扩展名），作为导图虚拟根文本。
 *
 * @param uri 文档 URI
 * @returns 去扩展名后的文件名
 */
function fileNameFromUri(uri: string): string {
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
function readMindmapSettings(): MindMapRuntimeSettings {
    return {
        mindmapTheme: settingsState.getString('mindmapTheme') || 'auto',
        mindmapDefaultExpandLevel: settingsState.getNumber('mindmapDefaultExpandLevel'),
        mindmapPerformanceMode: settingsState.getBoolean('mindmapPerformanceMode'),
        // 离屏实例 LRU 淘汰：默认关闭
        mindmapDisplayCache: settingsState.getBoolean('mindmapDisplayCache'),
        // 节点尺寸上限：getNumber 缺省/异常时回退 0，这里兜底成默认值
        mindmapNodeMaxWidth: settingsState.getNumber('mindmapNodeMaxWidth') || 20,
        mindmapNodeMaxLines: settingsState.getNumber('mindmapNodeMaxLines') || 3,
        // 代码块最小宽度：0 是合法值（不设），不能 || 兜底
        mindmapCodeMinWidth: settingsState.getNumber('mindmapCodeMinWidth'),
        // 缩放降级开关：默认关闭，关闭时阈值不参与判断
        mindmapLiteEnabled: settingsState.getBoolean('mindmapLiteEnabled'),
        mindmapPlainEnabled: settingsState.getBoolean('mindmapPlainEnabled'),
        // 缩放降级阈值（百分比）：0 不是合法值（等于任何时候都降级），兜底默认
        mindmapLiteZoom: settingsState.getNumber('mindmapLiteZoom') || 70,
        mindmapPlainZoom: settingsState.getNumber('mindmapPlainZoom') || 40,
        // 手势期清晰度优先：默认关闭（关闭 = 手势期提升合成层，帧率优先）
        mindmapGestureCrisp: settingsState.getBoolean('mindmapGestureCrisp'),
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
function applyMindmapEdit(newFullText: string): void {
    const view = editor?.getView();
    if (!view) {
        sendLog('WARN', 'Mindmap edit ignored: CodeMirror view is not ready');
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
}

/**
 * 导图模式的撤销 / 重做（todo.md 任务 7）。
 *
 * 导图编辑本来就通过 applyMindmapEdit 走「隐藏 CM 的最小差异 dispatch」进
 * CM 撤销栈，所以导图里的 Ctrl+Z/Y 等价于对隐藏 CM 执行 undo/redo；
 * 完成后立即把新文档喂回导图重建（UPDATE 防抖回环太慢，等不起）。
 */
function applyMindmapUndoRedo(kind: 'undo' | 'redo'): void {
    const view = editor?.getView();
    if (!view) return;
    const applied = kind === 'undo' ? undo(view) : redo(view);
    if (applied) {
        mindmapApp?.setDocument(view.state.doc.toString(), mindmapFileName);
    }
}

/**
 * 进入导图模式：隐藏文本容器（CM 实例保留），惰性创建/复用导图应用。
 */
async function enterMindmapMode(): Promise<void> {
    const host = getMindmapHost();
    const editorHost = getOrCreateEditorHost();
    // 必须在隐藏编辑器之前量：容器 hidden 之后 clientHeight = 0，
    // lineBlockAtHeight 拿不到当前屏
    const middleLine = editor?.getViewportMiddleLine() ?? null;
    editorHost.hidden = true;
    host.hidden = false;

    if (!mindmapApp) {
        mindmapApp = new MindMapApp(host, {
            onEdit: applyMindmapEdit,
            onUndo: () => applyMindmapUndoRedo('undo'),
            onRedo: () => applyMindmapUndoRedo('redo'),
            // mini-CM 的代码块嵌套高亮语言表（主编辑器同款）
            codeLanguages,
            // 任务 16：导图选中节点 → 大纲高亮对应行
            onSelectLine: (line: number) => outlinePanel?.setActiveLine(line),
            // 迭代 N3：导图导出 → extension 存盘
            onExport: (payload) => {
                vscode.postMessage({ type: 'saveMindmapExport', ...payload });
            },
        });
        mindmapApp.setTheme(currentTheme);
        mindmapApp.setSettings(readMindmapSettings());
    }
    if (editor && editor.isReady()) {
        mindmapApp.setDocument(editor.getContent(), mindmapFileName);
    }
    await mindmapApp.whenReady();
    mindmapApp.setActive(true);
    // 从文本模式「当前看到的这一屏中间」开始，并固定 100% 缩放。
    // setActive 内部的 fit() 会按整棵树自动缩放，focusLineFromEditor 覆盖它。
    if (middleLine !== null) mindmapApp.focusLineFromEditor(middleLine - 1);
    sendLog('INFO', 'Mindmap mode activated');
}

/**
 * 退出导图模式：隐藏导图容器、恢复文本容器；CM 状态（撤销栈/光标/滚动）原样保留。
 */
function leaveMindmapMode(): void {
    // 必须在 setActive(false) 之前取：它会 clearSelection()，之后就只剩
    // 「视口中心」这一条线索了。优先级：选中/编辑节点 → 视口中心节点。
    const focusLine = mindmapApp?.getFocusLine0() ?? null;
    getMindmapHost().hidden = true;
    getOrCreateEditorHost().hidden = false;
    mindmapApp?.setActive(false);
    // 容器从 display:none 恢复后让 CM 重新测量
    requestAnimationFrame(() => {
        const view = editor?.getView();
        view?.requestMeasure();
        // 回到导图里最后看的那一项（行号是 0-based，scrollToLine 要 1-based）
        if (focusLine !== null) editor?.scrollToLine(focusLine + 1);
    });
}

/**
 * 应用扩展侧下发的模式切换（live / viewer / source / mindmap）。
 *
 * @param mode 目标模式
 */
async function applyEditorMode(mode: EditorMode): Promise<void> {
    currentEditorMode = mode;
    if (mode === 'mindmap') {
        await enterMindmapMode();
        return;
    }
    leaveMindmapMode();
    if (editor && editor.isReady()) {
        editor.setMode(mode);
    }
}

/**
 * 获取右侧大纲面板的初始宽度。
 *
 * 优先读取 HTML 注入的 CSS 变量，这样页面首次渲染时就能直接使用
 * 扩展端保存的宽度；如果读取失败，则回退到默认值。
 *
 * @returns 右侧大纲面板初始宽度，单位像素
 */
function getInitialOutlineWidth(): number {
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
function syncOutlineActiveLine(): void {
    if (!editor || !editor.isReady()) {
        return;
    }

    try {
        outlinePanel?.setActiveLine(editor.getCurrentLine());
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
function isInteractiveFocusTarget(target: EventTarget | Element | null): boolean {
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

// =============================================================================
// Logging
// =============================================================================

/**
 * 向扩展侧发送 Webview 日志。
 *
 * @param level - 日志级别。
 * @param msg - 日志内容。
 * @returns void
 */
function sendLog(level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', msg: string): void {
    if (level === 'ERROR' || level === 'WARN') {
        vscode.postMessage({ type: 'webviewLog', level, msg });
    }

    // 正式包默认不把普通信息回写到 Webview 控制台，只保留错误和必要告警。
    if (level === 'ERROR') {
        console.error(`[LiveWriteMD Webview] ${msg}`);
    } else if (level === 'WARN' && SHOULD_MIRROR_WEBVIEW_CONSOLE) {
        console.warn(`[LiveWriteMD Webview] ${msg}`);
    } else if (SHOULD_MIRROR_WEBVIEW_CONSOLE) {
        console.log(`[LiveWriteMD Webview] ${msg}`);
    }
}

/**
 * 更新启动状态提示文本。
 *
 * @param detail - 展示给用户的启动阶段说明。
 * @returns void
 */
function updateBootStatus(detail: string): void {
    const bootStatus = document.getElementById('boot-status');
    if (!bootStatus) {
        return;
    }

    const detailEl = bootStatus.querySelector('.boot-status-detail');
    if (detailEl) {
        detailEl.textContent = detail;
    }
}

/**
 * 隐藏启动状态提示。
 *
 * @returns void
 */
function hideBootStatus(): void {
    document.getElementById('boot-status')?.setAttribute('hidden', 'true');
}

/**
 * 注册 Webview 全局异常监听。
 *
 * @returns void
 */
function registerGlobalErrorDiagnostics(): void {
    window.addEventListener('error', (event: ErrorEvent) => {
        const message = event.error instanceof Error ? event.error.message : event.message;
        // ResizeObserver 的「loop completed with undelivered notifications」是
        // 浏览器已知的良性告警（回调里改了布局而已），没有调用栈也没有
        // 可恢复动作；不往扩展主机刷 ERROR，免得掩盖真正的异常。
        if (message.includes('ResizeObserver loop')) return;
        const stack = event.error instanceof Error ? event.error.stack : undefined;
        sendLog(
            'ERROR',
            `Global error captured: message=${message}, source=${event.filename}, line=${event.lineno}, column=${event.colno}`
        );
        messageSender.sendError(message, stack, 'WEBVIEW_GLOBAL_ERROR');
    });

    window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
        const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
        const stack = event.reason instanceof Error ? event.reason.stack : undefined;
        sendLog('ERROR', `Unhandled promise rejection captured: ${reason}`);
        messageSender.sendError(reason, stack, 'WEBVIEW_UNHANDLED_REJECTION');
    });
}

/**
 * 发送 READY 并记录来源。
 *
 * @param source - READY 发送来源，区分首次发送与重试。
 * @returns void
 */
function sendReadyWithDiagnostics(source: string): void {
    sendLog(
        'INFO',
        `Sending READY to extension: source=${source}, hasReceivedInit=${hasReceivedInit}`
    );
    messageSender.sendReady();
}

/**
 * 在未收到 INIT 时安排 READY 重试。
 *
 * @param delayMs - 延迟发送 READY 的毫秒数。
 * @param attempt - 当前重试序号。
 * @returns void
 */
function scheduleReadyRetry(delayMs: number, attempt: number): void {
    setTimeout(() => {
        if (hasReceivedInit) {
            sendLog('DEBUG', `READY retry skipped because INIT arrived: attempt=${attempt}`);
            return;
        }

        sendLog(
            'WARN',
            `INIT not received yet, retrying READY: attempt=${attempt}, delayMs=${delayMs}`
        );
        updateBootStatus(`Webview 脚本已运行，但还没有收到 INIT，正在第 ${attempt} 次重发 READY。`);
        sendReadyWithDiagnostics(`retry-${attempt}`);
    }, delayMs);
}

/**
 * 只执行一次 Webview 初始化。
 *
 * @param source - 初始化触发来源，用于区分 DOMContentLoaded 或直接启动。
 * @returns void
 */
function runInitializeOnce(source: string): void {
    if (hasInitialized) {
        sendLog('DEBUG', `Webview initialize skipped because it already ran: source=${source}`);
        return;
    }

    hasInitialized = true;
    updateBootStatus(`Webview 脚本已运行，初始化来源：${source}，正在等待扩展侧 INIT。`);
    sendLog('INFO', `Running Webview initialize: source=${source}`);
    initialize();
}

registerGlobalErrorDiagnostics();
sendLog('INFO', 'Webview script loaded and diagnostics registered');

// Expose log function globally for plugins
(window as unknown as { livewritemdLog: typeof sendLog }).livewritemdLog = sendLog;

// Expose vscode API globally for livePreview link handling
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).__vscodeApi = vscode;

// =============================================================================
// Message Handler Callbacks
// =============================================================================

/**
 * Handle INIT message from Extension.
 * Sets up the CodeMirror editor with initial content and theme.
 *
 * @param content - The initial markdown content
 * @param theme - The initial theme setting
 * @param documentUri - The document URI for image path resolution
 *
 * Design Reference: DES-A-004, DES-API-003
 */
async function handleInit(
    content: string,
    theme: ThemeType,
    documentUri: string,
    searchHistory: SearchHistoryState,
    settings?: LiveWriteMdEditorSettings,
    mode?: EditorMode,
    outlineWidth?: number,
    allSettings?: Record<string, SettingValue>
): Promise<void> {
    hasReceivedInit = true;
    updateBootStatus('已收到 INIT，正在创建 CodeMirror 编辑器。');
    sendLog('INFO', `INIT received: contentLength=${content.length}, theme=${theme}`);

    currentTheme = theme;
    mindmapFileName = fileNameFromUri(documentUri);

    try {
        // Destroy any stale search history controller before rebuilding the editor.
        searchHistoryController?.destroy();
        searchHistoryController = null;

        // Store document URI for image path resolution
        currentDocumentUri = documentUri;

        // 在创建编辑器前，把全部设置（颜色 / 个性化项）写入 settingsState，
        // CSS 变量先就位，首屏即按用户设置渲染、不闪。
        settingsState.replaceAll(allSettings ?? {});

        // Make sure the right-side outline starts at the saved width.
        if (Number.isFinite(outlineWidth ?? NaN)) {
            outlinePanel?.setWidth(outlineWidth as number);
        }

        // Get or create the editor container
        const container = getOrCreateEditorHost();
        sendLog(
            'INFO',
            `Editor host prepared: id=${container.id}, childCount=${container.childElementCount}, documentUri=${documentUri}`
        );

        // Destroy existing editor if any
        if (editor) {
            sendLog('DEBUG', 'Destroying existing CodeMirror editor before INIT rebuild');
            editor.destroy();
            editor = null;
        }
        // 导图实例同样重建，容器可见性复位到文本态
        mindmapApp?.destroy();
        mindmapApp = null;
        getMindmapHost().hidden = true;
        getOrCreateEditorHost().hidden = false;

        // Create new CodeMirror editor
        sendLog('INFO', 'Creating CodeMirror editor instance');
        editor = new CodeMirrorEditor(container);
        editor.setFontScaleChangeHandler((fontScale: number) => {
            messageSender.sendFontScaleChange(fontScale);
        });
        editor.onSelectionChange((lineNumber: number) => {
            outlinePanel?.setActiveLine(lineNumber);
        });
        editor.onViewportLineChange((lineNumber: number) => {
            outlinePanel?.setActiveLine(lineNumber);
        });

        // Initialize the editor with content
        sendLog('INFO', `Calling CodeMirrorEditor.create: contentLength=${content.length}`);
        await editor.create(content);
        sendLog('INFO', 'CodeMirrorEditor.create completed');

        // Initialize search/replace history UI and persistence hooks.
        searchHistoryController?.destroy();
        const editorView = editor.getView();
        if (!editorView) {
            throw new Error('Cannot initialize search history controller: editor view is missing.');
        }
        searchHistoryController = createSearchHistoryController(
            editorView,
            searchHistory,
            (history: SearchHistoryState) => {
                messageSender.sendSearchHistoryChange(history);
            }
        );

        hideBootStatus();
        currentEditorMode = mode ?? 'live';
        editorContextMenu?.attach(editor.getView()?.contentDOM ?? null);

        // Register change callback to send updates to Extension (debounced)
        editor.onChange((newContent: string) => {
            // 大纲内容**防抖**更新：setContent 会把整篇重扫一遍标题、再把大纲整棵重建，
            // 1547 行的文档实测一次 3.4ms —— 每敲一个字都做一次是白花的（打字延迟里
            // 它占了三分之一）。内容晚 250ms 跟上完全够用；「高亮当前行」走的是另一条
            // 路（setActiveLine），仍然是实时的。
            debouncedSetOutlineContent(newContent);
            debouncedSendContentChange(newContent);
        });

        // Keep the outline aligned with the freshly loaded Markdown document
        outlinePanel?.setContent(content);
        syncOutlineActiveLine();
        if (Number.isFinite(outlineWidth ?? NaN)) {
            outlinePanel?.setWidth(outlineWidth as number);
        }

        // Apply initial theme using ThemeManager (for CSS classes)
        if (!themeManager) {
            themeManager = new WebviewThemeManager(theme);
        } else {
            themeManager.setTheme(theme);
        }

        // Apply theme to CodeMirror editor and Mermaid
        setMermaidTheme(theme);
        if (editor.isReady()) {
            const view = (editor as unknown as { view: { dispatch: (tr: unknown) => void } }).view;
            if (view) {
                switchTheme(view as Parameters<typeof switchTheme>[0], theme);
            }
        }

        // Set up image drag & drop handler (document.body level)
        setupImageDropHandler(
            () => editor?.getView() ?? null,
            (msg) => vscode.postMessage(msg)
        );

        // Set up image paste handler via CM6 domEventHandlers
        const pasteHandler = createImagePasteHandler((msg) => vscode.postMessage(msg));
        editor.setPasteHandler(pasteHandler);

        // Apply editor settings (word wrap, readable line length)
        if (settings) {
            editor.applySettings(settings);
            sendLog(
                'INFO',
                `Settings applied: lineNumbers=${settings.lineNumbers}, wordWrap=${settings.wordWrap}, readableLineLength=${settings.readableLineLength}, fontScale=${settings.fontScale}`
            );
        }

        // Apply default editor mode
        if (mode === 'mindmap') {
            await enterMindmapMode();
            currentEditorMode = 'mindmap';
            sendLog('INFO', 'Default editor mode applied: mindmap');
        } else if (mode && mode !== 'live') {
            editor.setMode(mode);
            currentEditorMode = mode;
            sendLog('INFO', `Default editor mode applied: ${mode}`);
        }

        sendLog('INFO', 'CodeMirror editor initialized successfully');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        sendLog('ERROR', `Editor initialization failed: ${errorMessage}`);
        messageSender.sendError(errorMessage, errorStack, 'EDITOR_INIT_ERROR');
    }
}

/**
 * Handle UPDATE message from Extension.
 * Updates the editor content when external changes occur.
 *
 * @param content - The updated markdown content
 *
 * Design Reference: DES-API-003
 */
function handleUpdate(content: string): void {
    sendLog('DEBUG', `UPDATE received: contentLength=${content.length}`);
    console.debug(
        `[LiveWriteMD] handleUpdate: contentLen=${content.length} editorReady=${editor?.isReady()}`
    );

    if (!editor || !editor.isReady()) {
        sendLog('ERROR', 'Cannot update: editor not ready');
        return;
    }

    try {
        console.debug(`[LiveWriteMD] handleUpdate: calling setContent...`);
        // setContent() does NOT trigger onChange (feedback loop prevention)
        editor.setContent(content);
        outlinePanel?.setContent(content);
        // 外部变更同步给导图（导图自身回写不会触发 UPDATE，无环）
        mindmapApp?.setDocument(content, mindmapFileName);
        syncOutlineActiveLine();
        sendLog('DEBUG', 'UPDATE applied successfully');
        console.debug(`[LiveWriteMD] handleUpdate: setContent completed`);
        // Stop reload spinner if it was active
        document.getElementById('reload-content')?.classList.remove('spinning');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        sendLog('ERROR', `Update failed: ${errorMessage}`);
        messageSender.sendError(errorMessage, errorStack, 'SYNC_ERROR');
    }
}

/**
 * Handle THEME_CHANGE message from Extension.
 * Updates the editor theme to match VS Code theme.
 *
 * @param theme - The new theme setting
 *
 * Design Reference: DES-A-006
 * Requirements: REQ-F-008
 */
function handleThemeChange(theme: ThemeType): void {
    sendLog('DEBUG', `THEME_CHANGE received: theme=${theme}`);
    currentTheme = theme;
    mindmapApp?.setTheme(theme);

    try {
        // Apply theme change using ThemeManager (for CSS classes)
        if (themeManager) {
            themeManager.setTheme(theme);
        } else {
            themeManager = new WebviewThemeManager(theme);
        }

        // Apply theme to CodeMirror editor and Mermaid
        setMermaidTheme(theme);
        if (editor && editor.isReady()) {
            const view = (editor as unknown as { view: { dispatch: (tr: unknown) => void } }).view;
            if (view) {
                switchTheme(view as Parameters<typeof switchTheme>[0], theme);
            }
        }

        sendLog('DEBUG', 'Theme applied successfully');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        sendLog('ERROR', `Theme change failed: ${errorMessage}`);
    }
}

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize the Webview when DOM is ready.
 *
 * This function:
 * 1. Sets up the WebviewMessageHandler with callbacks
 * 2. Sets up focus event listener to handle external focus restoration
 * 3. Sends the READY message to the Extension
 *
 * Design Reference: DES-A-002
 */
function initialize(): void {
    sendLog(
        'INFO',
        `Webview initializing: readyState=${document.readyState}, hasEditor=${Boolean(document.getElementById('editor'))}`
    );

    // 右侧大纲面板直接复用 HTML 里准备好的壳子，只负责渲染和交互。
    const panelEl = document.getElementById('outline-pane');
    const contentEl = document.getElementById('outline-content');
    const resizerEl = document.getElementById('outline-resizer');
    if (panelEl && contentEl && resizerEl) {
        outlinePanel = new OutlinePanel(panelEl, contentEl, resizerEl, {
            initialWidth: getInitialOutlineWidth(),
            onWidthChange: (width: number) => {
                vscode.postMessage({
                    type: MESSAGE_TYPES.OUTLINE_WIDTH_CHANGE,
                    width,
                });
            },
            onNavigateToLine: (line: number) => {
                // 任务 16：导图模式下大纲点击 → 选中对应标题节点并画布居中
                // （大纲行号是 1-based，导图 _lineRange 是 0-based）
                if (currentEditorMode === 'mindmap' && mindmapApp) {
                    if (mindmapApp.selectNodeAtLine(line - 1)) return;
                }
                editor?.scrollToLine(line);
            },
            isEditable: () => editor?.isEditable() ?? false,
            getDocument: () => editor?.getContent() ?? '',
            onApplyHeadingEdits: (edits) => {
                const view = editor?.getView();
                if (!view || edits.length === 0) return;
                // 一批替换一次性 dispatch；编号只动各标题行首，互不重叠
                view.dispatch({ changes: edits });
            },
        });
        // 注册设置改动的持久化回调；设置面板的打开入口在编辑器标题栏（openSettings 命令）。
        settingsPanel.registerChangeHandler((key, value) => {
            vscode.postMessage({ type: MESSAGE_TYPES.UPDATE_SETTING, key, value });
            // 导图设置在本 webview 立即生效，不等扩展侧回环：
            // UPDATE_SETTING → 写配置 → onDidChangeConfiguration → 再广播回来，
            // 隔着两次 IPC，拖滑杆时节点要滞后一拍才变（用户看到的就是
            // 「代码块最小宽度改了没反应，再动一下才生效」）。
            // settingsState 已在面板 commit 时更新过，这里直接重测重排。
            if (key.startsWith('mindmap') && mindmapApp) {
                mindmapApp.setSettings(readMindmapSettings());
            }
        });
        sendLog('INFO', 'Outline panel initialized');
    } else {
        sendLog('ERROR', 'Outline panel DOM is missing, right-side outline is unavailable');
    }

    // Markdown 正文右键菜单只绑定到编辑器正文容器，不覆盖大纲和其它 UI。
    // 模式切换与大纲开关已收编到编辑器标题栏，右键菜单只剩正文编辑相关动作。
    editorContextMenu = new EditorContextMenu({
        onInsertImage: () => messageSender.sendEditorAction('insertImage'),
        onExportAsHtml: () => messageSender.sendEditorAction('exportAsHtml'),
        onExportAsPdf: () => messageSender.sendEditorAction('exportAsPdf'),
        onDownloadRemoteImages: () => messageSender.sendEditorAction('downloadRemoteImages'),
        // 右键落在表格格子上时，先把这一格变成选区再弹菜单 ——
        // 后面的增删行列都作用在「当前选区覆盖的格子」上，这样点哪儿动哪儿。
        // 已经框选了一片格子、右键又落在选区里的话就别动它，否则一右键就把框选弄丢了。
        resolveTableContext: (event: MouseEvent) => {
            const view = editor?.getView();
            if (!view || !editor?.isEditable()) return false;
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos === null) return false;
            const cell = cellAt(view.state, pos);
            if (!cell) return false;
            const selection = view.state.selection.main;
            const insideSelection =
                !selection.empty && selection.from <= cell.to && cell.from <= selection.to;
            if (!insideSelection) {
                view.dispatch({ selection: { anchor: cell.from, head: cell.to } });
            }
            return true;
        },
        onTableCommand: (command) => {
            const view = editor?.getView();
            if (!view) return;
            // 作用对象是当前选区：框选了一片格子就整片动，只点了一格就动那一格
            runTableCommand(view, command, view.state.selection.main.from);
        },
    });

    // Capture documentBaseUri and handle viewerMode from raw messages
    window.addEventListener('message', (event: MessageEvent) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msg = event.data as any;
        if (msg?.type) {
            sendLog('DEBUG', `Raw window message received: type=${msg.type}`);
        }
        if (msg && msg.type === 'init') {
            if (msg.documentBaseUri) {
                setDocumentBaseUri(msg.documentBaseUri);
                sendLog('DEBUG', `documentBaseUri set: ${msg.documentBaseUri}`);
            }
            if (msg.settings && editor && editor.isReady()) {
                editor.applySettings(msg.settings);
            }
        }
        if (msg && msg.type === 'viewerMode') {
            if (editor && editor.isReady()) {
                editor.setEditable(!msg.readOnly);
                sendLog('INFO', `Viewer mode: ${msg.readOnly ? 'ON' : 'OFF'}`);
            }
            if (msg.readOnly) {
                currentEditorMode = 'viewer';
            } else if (currentEditorMode === 'viewer') {
                currentEditorMode = 'live';
            }
        }
        if (msg && msg.type === 'editorMode') {
            void applyEditorMode(msg.mode as EditorMode);
        }
        if (msg && msg.type === 'settingsChange') {
            if (editor && editor.isReady() && msg.settings) {
                editor.applySettings(msg.settings);
                sendLog(
                    'INFO',
                    `Settings updated: lineNumbers=${msg.settings.lineNumbers}, wordWrap=${msg.settings.wordWrap}, readableLineLength=${msg.settings.readableLineLength}, fontScale=${msg.settings.fontScale}`
                );
            }
        }
        // 编辑器标题栏的“显示/隐藏大纲”按钮走这条消息，可见性状态仍由 Webview 持有。
        if (msg && msg.type === 'outlineToggle') {
            outlinePanel?.toggleVisible();
            sendLog('INFO', `Outline visibility toggled: ${outlinePanel?.isOutlineVisible()}`);
        }
        if (msg && msg.type === 'imageSaved') {
            handleImageSaved(msg, () => editor?.getView() ?? null);
        }
        if (msg && msg.type === 'imageSaveError') {
            handleImageSaveError(msg, (m) => vscode.postMessage(m));
        }
    });

    // Set up message handler with CodeMirror integration callbacks
    const messageHandler = new WebviewMessageHandler({
        onInit: (
            content: string,
            theme: ThemeType,
            documentUri: string,
            searchHistory: SearchHistoryState,
            settings?: LiveWriteMdEditorSettings,
            mode?: EditorMode,
            outlineWidth?: number,
            allSettings?: Record<string, SettingValue>
        ): void => {
            void handleInit(
                content,
                theme,
                documentUri,
                searchHistory,
                settings,
                mode,
                outlineWidth,
                allSettings
            );
        },
        onUpdate: handleUpdate,
        onThemeChange: handleThemeChange,
        onSettingsChange: (msg) => {
            // 完整设置 → CSS 变量 / 运行时读取
            if (msg.allSettings) settingsState.replaceAll(msg.allSettings);
            // 导图三项设置（主题 / 默认展开层级 / 性能模式）
            mindmapApp?.setSettings(readMindmapSettings());
            // 结构化设置（行号 / 换行等）重配置编辑器
            if (msg.settings && editor?.isReady()) {
                editor.applySettings(msg.settings);
            }
            sendLog('INFO', 'Settings change applied');
        },
        onOpenSettings: () => {
            // registerChangeHandler 时已保存持久化回调，直接打开即可
            settingsPanel.open();
        },
        onSystemFonts: (fonts) => {
            // 扩展宿主枚举的本机字体；设置面板的字体输入框用它做候选列表
            settingsPanel.setSystemFonts(fonts);
        },
    });

    // Register message listener
    sendLog('INFO', 'Registering WebviewMessageHandler listener');
    messageHandler.setup();
    sendLog('INFO', 'WebviewMessageHandler listener registered');

    // Set up focus listener to restore editor focus when webview receives focus
    // This fixes the issue where clicking on webview from outside (e.g., desktop)
    // doesn't properly focus the CodeMirror editor
    //
    window.addEventListener('focus', () => {
        sendLog('DEBUG', 'Window focus event received');
        if (isInteractiveFocusTarget(document.activeElement)) {
            sendLog('DEBUG', 'Editor focus restore skipped for interactive element');
            return;
        }
        if (editor && editor.isReady()) {
            editor.focus();
            sendLog('DEBUG', 'Editor focus restored');
        }
    });

    // Also handle click on the editor container to ensure focus
    document.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        const editorContainer = document.getElementById('editor');
        if (editorContainer && editorContainer.contains(target)) {
            if (isInteractiveFocusTarget(target)) {
                return;
            }

            if (editor && editor.isReady()) {
                // Small delay to let CodeMirror handle the click first
                setTimeout(() => {
                    if (isInteractiveFocusTarget(document.activeElement)) {
                        return;
                    }
                    editor?.focus();
                }, 10);
            }
        }
    });

    // Reload content button
    const reloadBtn = document.getElementById('reload-content');
    if (reloadBtn) {
        reloadBtn.addEventListener('click', () => {
            reloadBtn.classList.add('spinning');
            vscode.postMessage({ type: 'reloadContent' });
            // Auto-stop spinner after 3s as safety net
            setTimeout(() => reloadBtn.classList.remove('spinning'), 3000);
        });
    }

    // Scroll jump buttons
    const scrollTopBtn = document.getElementById('scroll-top');
    const scrollBottomBtn = document.getElementById('scroll-bottom');
    if (scrollTopBtn) {
        scrollTopBtn.addEventListener('click', () => {
            const scroller = document.querySelector('.cm-scroller');
            if (scroller) {
                scroller.scrollTo({ top: 0, behavior: 'instant' });
            }
        });
    }
    if (scrollBottomBtn) {
        scrollBottomBtn.addEventListener('click', () => {
            const scroller = document.querySelector('.cm-scroller');
            if (scroller) {
                scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'instant' });
            }
        });
    }

    // Notify Extension that Webview is ready to receive messages
    sendReadyWithDiagnostics('initial');
    scheduleReadyRetry(250, 1);
    scheduleReadyRetry(1000, 2);
    scheduleReadyRetry(2500, 3);

    sendLog('INFO', 'READY handshake scheduled');
}

// Register DOMContentLoaded listener
sendLog('INFO', `Registering DOMContentLoaded listener: readyState=${document.readyState}`);
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => runInitializeOnce('DOMContentLoaded'));
} else {
    runInitializeOnce(`readyState-${document.readyState}`);
}
