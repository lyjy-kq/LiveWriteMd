/**
 * FlowMD Webview Entry Point
 *
 * This module serves as the entry point for the Webview side of the FlowMD editor.
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

import { CodeMirrorEditor } from './codemirror/editor.js';
import { switchTheme } from './codemirror/extensions/theme.js';
import { setDocumentBaseUri } from './codemirror/extensions/livePreview/index.js';
import { setMermaidTheme, setPostMessage } from './codemirror/extensions/livePreview/state.js';
import { WebviewMessageSender, WebviewMessageHandler } from './messageHandler.js';
import { WebviewThemeManager } from './theme.js';
import { OutlinePanel } from './outlinePanel.js';
import { EditorContextMenu, type EditorMode } from './editorContextMenu.js';
import { cellAt } from './codemirror/extensions/livePreview/tableRender.js';
import { runTableCommand } from './codemirror/extensions/livePreview/tableCommands.js';
import { createSearchHistoryController, type SearchHistoryController } from './codemirror/extensions/searchHistory.js';
import {
    setupImageDropHandler,
    createImagePasteHandler,
    handleImageSaved,
    handleImageSaveError,
} from './imageDropHandler.js';
import type { ThemeType, FlowMdEditorSettings } from '../shared/types.js';
import type { SearchHistoryState } from '../shared/searchHistory.js';
import { MESSAGE_TYPES } from '../shared/messageTypes.js';

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
 * 当前为黑屏问题排查阶段，保持开启以便把启动链路写入 FlowMD 输出。
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
    if (msg.includes('[FlowMD]')) {
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
 * 获取右侧大纲面板的初始宽度。
 *
 * 优先读取 HTML 注入的 CSS 变量，这样页面首次渲染时就能直接使用
 * 扩展端保存的宽度；如果读取失败，则回退到默认值。
 *
 * @returns 右侧大纲面板初始宽度，单位像素
 */
function getInitialOutlineWidth(): number {
    const rawWidth = getComputedStyle(document.documentElement).getPropertyValue(
        '--flowmd-outline-width'
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
        console.error(`[FlowMD Webview] ${msg}`);
    } else if (level === 'WARN' && SHOULD_MIRROR_WEBVIEW_CONSOLE) {
        console.warn(`[FlowMD Webview] ${msg}`);
    } else if (SHOULD_MIRROR_WEBVIEW_CONSOLE) {
        console.log(`[FlowMD Webview] ${msg}`);
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
(window as unknown as { flowmdLog: typeof sendLog }).flowmdLog = sendLog;

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
    settings?: FlowMdEditorSettings,
    mode?: 'live' | 'viewer' | 'source',
    outlineWidth?: number
): Promise<void> {
    hasReceivedInit = true;
    updateBootStatus('已收到 INIT，正在创建 CodeMirror 编辑器。');
    sendLog('INFO', `INIT received: contentLength=${content.length}, theme=${theme}`);

    try {
        // Destroy any stale search history controller before rebuilding the editor.
        searchHistoryController?.destroy();
        searchHistoryController = null;

        // Store document URI for image path resolution
        currentDocumentUri = documentUri;

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
        if (mode && mode !== 'live') {
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
        `[FlowMD] handleUpdate: contentLen=${content.length} editorReady=${editor?.isReady()}`
    );

    if (!editor || !editor.isReady()) {
        sendLog('ERROR', 'Cannot update: editor not ready');
        return;
    }

    try {
        console.debug(`[FlowMD] handleUpdate: calling setContent...`);
        // setContent() does NOT trigger onChange (feedback loop prevention)
        editor.setContent(content);
        outlinePanel?.setContent(content);
        syncOutlineActiveLine();
        sendLog('DEBUG', 'UPDATE applied successfully');
        console.debug(`[FlowMD] handleUpdate: setContent completed`);
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
        sendLog('INFO', 'Outline panel initialized');
    } else {
        sendLog('ERROR', 'Outline panel DOM is missing, right-side outline is unavailable');
    }

    // Markdown 正文右键菜单只绑定到编辑器正文容器，不覆盖大纲和其它 UI。
    editorContextMenu = new EditorContextMenu({
        getCurrentMode: () => currentEditorMode,
        onInsertImage: () => messageSender.sendEditorAction('insertImage'),
        onChangeMode: (mode: EditorMode) => messageSender.sendEditorAction('setMode', mode),
        onExportAsHtml: () => messageSender.sendEditorAction('exportAsHtml'),
        onExportAsPdf: () => messageSender.sendEditorAction('exportAsPdf'),
        onDownloadRemoteImages: () => messageSender.sendEditorAction('downloadRemoteImages'),
        onToggleOutline: () => outlinePanel?.toggleVisible(),
        isOutlineVisible: () => outlinePanel?.isOutlineVisible() ?? true,
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
            if (editor && editor.isReady()) {
                editor.setMode(msg.mode);
                sendLog('INFO', `Editor mode: ${msg.mode}`);
            }
            currentEditorMode = msg.mode;
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
            settings?: FlowMdEditorSettings,
            mode?: 'live' | 'viewer' | 'source',
            outlineWidth?: number
        ): void => {
            void handleInit(
                content,
                theme,
                documentUri,
                searchHistory,
                settings,
                mode,
                outlineWidth
            );
        },
        onUpdate: handleUpdate,
        onThemeChange: handleThemeChange,
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
