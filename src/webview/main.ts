/**
 * LiveWriteMD Webview Entry Point
 *
 * webview 侧打包入口，只做装配与启动：
 * - 共享运行态在 host/webviewContext.ts（ctx 对象）
 * - 日志转发 host/logForward.ts；启动诊断与 READY 握手 host/bootStatus.ts
 * - 模式切换与导图联动 host/appState.ts；INIT/UPDATE/THEME_CHANGE host/messageCallbacks.ts
 * - 本文件保留：initialize() 装配（大纲面板 / 右键菜单 / 消息路由 / 焦点与滚动按钮）
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
 *
 * @module webview/main
 */

import { setDocumentBaseUri } from './codemirror/extensions/livePreview/index.js';
import { setPostMessage } from './codemirror/extensions/livePreview/state.js';
import { cellAt } from './codemirror/extensions/livePreview/tableRender.js';
import { runTableCommand } from './codemirror/extensions/livePreview/tableCommands.js';
import { WebviewMessageHandler } from './host/messageHandler.js';
import { OutlinePanel } from './outline/outlinePanel.js';
import { EditorContextMenu, type EditorMode } from './editing/editorContextMenu.js';
import { settingsState } from './settings/settingsState.js';
import { settingsPanel } from './settings/settingsPanel.js';
import {
    handleImageSaved,
    handleImageSaveError,
} from './editing/imageDropHandler.js';
import type { ThemeType, LiveWriteMdEditorSettings } from '../shared/types.js';
import type { SearchHistoryState } from '../shared/searchHistory.js';
import type { SettingValue } from '../shared/settings/index.js';
import { MESSAGE_TYPES } from '../shared/messageTypes.js';
import { BUILD_STAMP } from '../shared/buildStamp.js';
import { collectMemoryStats } from './memoryStats.js';
import { ctx, type IVsCodeApi } from './host/webviewContext.js';
import { sendLog } from './host/logForward.js';
import {
    registerGlobalErrorDiagnostics,
    sendReadyWithDiagnostics,
    scheduleReadyRetry,
    runInitializeOnce,
} from './host/bootStatus.js';
import {
    applyEditorMode,
    getInitialOutlineWidth,
    isInteractiveFocusTarget,
    readMindmapSettings,
} from './host/appState.js';
import { handleInit, handleUpdate, handleThemeChange } from './host/messageCallbacks.js';
import type { CodeMirrorEditor } from './codemirror/editor.js';
import type { WebviewThemeManager } from './theme.js';

// Register postMessage for clipboard operations in widgets
setPostMessage((message: unknown) => ctx.vscode.postMessage(message));

// 构建戳：webview 启动即回写「输出 → LiveWriteMD」，排查跑的是不是最新包。
// 用 WARN 级（sendLog 只把 ERROR/WARN 转发给宿主，INFO 会被丢掉）
sendLog('WARN', `[build] webview ${BUILD_STAMP}`);

registerGlobalErrorDiagnostics();
sendLog('INFO', 'Webview script loaded and diagnostics registered');

// Expose log function globally for plugins
(window as unknown as { livewritemdLog: typeof sendLog }).livewritemdLog = sendLog;

// Expose vscode API globally for livePreview link handling
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).__vscodeApi = ctx.vscode;

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
    return ctx.currentDocumentUri;
}

/**
 * Get the VS Code API instance.
 * Exported for testing purposes.
 *
 * @returns The VS Code API instance
 */
export function getVsCodeApi(): IVsCodeApi {
    return ctx.vscode;
}

/**
 * Get the CodeMirrorEditor instance.
 * Exported for testing purposes.
 *
 * @returns The CodeMirrorEditor instance or null if not created
 */
export function getEditor(): CodeMirrorEditor | null {
    return ctx.editor;
}

/**
 * Get the WebviewThemeManager instance.
 * Exported for testing purposes.
 *
 * @returns The WebviewThemeManager instance or null if not created
 */
export function getThemeManager(): WebviewThemeManager | null {
    return ctx.themeManager;
}

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
        ctx.outlinePanel = new OutlinePanel(panelEl, contentEl, resizerEl, {
            initialWidth: getInitialOutlineWidth(),
            onWidthChange: (width: number) => {
                ctx.vscode.postMessage({
                    type: MESSAGE_TYPES.OUTLINE_WIDTH_CHANGE,
                    width,
                });
            },
            onNavigateToLine: (line: number) => {
                // 任务 16：导图模式下大纲点击 → 选中对应标题节点并画布居中
                // （大纲行号是 1-based，导图 _lineRange 是 0-based）
                if (ctx.currentEditorMode === 'mindmap' && ctx.mindmapApp) {
                    if (ctx.mindmapApp.selectNodeAtLine(line - 1)) return;
                }
                ctx.editor?.scrollToLine(line);
            },
            isEditable: () => ctx.editor?.isEditable() ?? false,
            getDocument: () => ctx.editor?.getContent() ?? '',
            onApplyHeadingEdits: (edits) => {
                const view = ctx.editor?.getView();
                if (!view || edits.length === 0) return;
                // 一批替换一次性 dispatch；编号只动各标题行首，互不重叠
                view.dispatch({ changes: edits });
            },
        });
        // 注册设置改动的持久化回调；设置面板的打开入口在编辑器标题栏（openSettings 命令）。
        settingsPanel.registerChangeHandler((key, value) => {
            ctx.vscode.postMessage({ type: MESSAGE_TYPES.UPDATE_SETTING, key, value });
            // 导图设置在本 webview 立即生效，不等扩展侧回环：
            // UPDATE_SETTING → 写配置 → onDidChangeConfiguration → 再广播回来，
            // 隔着两次 IPC，拖滑杆时节点要滞后一拍才变（用户看到的就是
            // 「代码块最小宽度改了没反应，再动一下才生效」）。
            // settingsState 已在面板 commit 时更新过，这里直接重测重排。
            if (key.startsWith('mindmap') && ctx.mindmapApp) {
                ctx.mindmapApp.setSettings(readMindmapSettings());
            }
        });
        sendLog('INFO', 'Outline panel initialized');
    } else {
        sendLog('ERROR', 'Outline panel DOM is missing, right-side outline is unavailable');
    }

    // Markdown 正文右键菜单只绑定到编辑器正文容器，不覆盖大纲和其它 UI。
    // 模式切换与大纲开关已收编到编辑器标题栏，右键菜单只剩正文编辑相关动作。
    ctx.editorContextMenu = new EditorContextMenu({
        onInsertImage: () => ctx.messageSender.sendEditorAction('insertImage'),
        onExportAsHtml: () => ctx.messageSender.sendEditorAction('exportAsHtml'),
        onExportAsPdf: () => ctx.messageSender.sendEditorAction('exportAsPdf'),
        onDownloadRemoteImages: () => ctx.messageSender.sendEditorAction('downloadRemoteImages'),
        // 右键落在表格格子上时，先把这一格变成选区再弹菜单 ——
        // 后面的增删行列都作用在「当前选区覆盖的格子」上，这样点哪儿动哪儿。
        // 已经框选了一片格子、右键又落在选区里的话就别动它，否则一右键就把框选弄丢了。
        resolveTableContext: (event: MouseEvent) => {
            const view = ctx.editor?.getView();
            if (!view || !ctx.editor?.isEditable()) return false;
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
            const view = ctx.editor?.getView();
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
            if (msg.settings && ctx.editor && ctx.editor.isReady()) {
                ctx.editor.applySettings(msg.settings);
            }
        }
        if (msg && msg.type === 'viewerMode') {
            if (ctx.editor && ctx.editor.isReady()) {
                ctx.editor.setEditable(!msg.readOnly);
                sendLog('INFO', `Viewer mode: ${msg.readOnly ? 'ON' : 'OFF'}`);
            }
            if (msg.readOnly) {
                ctx.currentEditorMode = 'viewer';
            } else if (ctx.currentEditorMode === 'viewer') {
                ctx.currentEditorMode = 'live';
            }
        }
        if (msg && msg.type === 'editorMode') {
            void applyEditorMode(msg.mode as EditorMode);
        }
        if (msg && msg.type === 'settingsChange') {
            if (ctx.editor && ctx.editor.isReady() && msg.settings) {
                ctx.editor.applySettings(msg.settings);
                sendLog(
                    'INFO',
                    `Settings updated: lineNumbers=${msg.settings.lineNumbers}, wordWrap=${msg.settings.wordWrap}, readableLineLength=${msg.settings.readableLineLength}, fontScale=${msg.settings.fontScale}`
                );
            }
        }
        // 编辑器标题栏的“显示/隐藏大纲”按钮走这条消息，可见性状态仍由 Webview 持有。
        if (msg && msg.type === 'outlineToggle') {
            ctx.outlinePanel?.toggleVisible();
            sendLog('INFO', `Outline visibility toggled: ${ctx.outlinePanel?.isOutlineVisible()}`);
        }
        if (msg && msg.type === 'imageSaved') {
            handleImageSaved(msg, () => ctx.editor?.getView() ?? null);
        }
        if (msg && msg.type === 'imageSaveError') {
            handleImageSaveError(msg, (m) => ctx.vscode.postMessage(m));
        }
        // 「显示内存占用」命令：收集 webview 统计回发扩展侧
        if (msg && msg.type === 'collectMemoryStats') {
            const view = ctx.editor?.getView();
            ctx.vscode.postMessage({
                type: 'memoryStatsReport',
                stats: collectMemoryStats({
                    docLength: view?.state.doc.length ?? 0,
                    docLines: view?.state.doc.lines ?? 0,
                    mode: ctx.currentEditorMode,
                    mapStats: ctx.mindmapApp ? ctx.mindmapApp.debugStats() : null,
                }),
            });
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
            ctx.mindmapApp?.setSettings(readMindmapSettings());
            // 结构化设置（行号 / 换行等）重配置编辑器
            if (msg.settings && ctx.editor?.isReady()) {
                ctx.editor.applySettings(msg.settings);
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

    // Set up focus listener to restore ctx.editor focus when webview receives focus
    // This fixes the issue where clicking on webview from outside (e.g., desktop)
    // doesn't properly focus the CodeMirror ctx.editor
    //
    window.addEventListener('focus', () => {
        sendLog('DEBUG', 'Window focus event received');
        if (isInteractiveFocusTarget(document.activeElement)) {
            sendLog('DEBUG', 'Editor focus restore skipped for interactive element');
            return;
        }
        if (ctx.editor && ctx.editor.isReady()) {
            ctx.editor.focus();
            sendLog('DEBUG', 'Editor focus restored');
        }
    });

    // Also handle click on the ctx.editor container to ensure focus
    document.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        const editorContainer = document.getElementById('editor');
        if (editorContainer && editorContainer.contains(target)) {
            if (isInteractiveFocusTarget(target)) {
                return;
            }

            if (ctx.editor && ctx.editor.isReady()) {
                // Small delay to let CodeMirror handle the click first
                setTimeout(() => {
                    if (isInteractiveFocusTarget(document.activeElement)) {
                        return;
                    }
                    ctx.editor?.focus();
                }, 10);
            }
        }
    });

    // Reload content button
    const reloadBtn = document.getElementById('reload-content');
    if (reloadBtn) {
        reloadBtn.addEventListener('click', () => {
            reloadBtn.classList.add('spinning');
            ctx.vscode.postMessage({ type: 'reloadContent' });
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
    document.addEventListener('DOMContentLoaded', () => runInitializeOnce('DOMContentLoaded', initialize));
} else {
    runInitializeOnce(`readyState-${document.readyState}`, initialize);
}
