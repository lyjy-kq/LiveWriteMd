/**
 * LiveWriteMD Webview Message Handler
 *
 * This module implements the message sending and receiving functionality
 * for Webview-Extension communication via postMessage.
 *
 * Updated for CodeMirror 6 integration:
 * - handleInit() provides data to initialize CodeMirrorEditor
 * - handleUpdate() provides data for setContent() calls
 * - handleThemeChange() provides data for theme switching
 * - sendContentChange(), sendReady(), sendError() send WebviewToExtensionMessage
 * - Debounce processing (300ms) is applied via createDebouncedSendContentChange()
 *
 * @module webview/messageHandler
 *
 * Design References:
 * - DES-A-002: Extension-Webview communication design
 * - DES-API-003: Webview side message receiving implementation
 * - DES-F-003: Webview file responsibilities
 *
 * Requirements:
 * - REQ-F-003: File loading and CodeMirror display
 * - REQ-F-004: CodeMirror edit content file save
 * - REQ-F-005: Bidirectional sync with VS Code editor
 * - REQ-F-008: Dark/Light theme support
 */

import type {
    ThemeType,
    LiveWriteMdEditorSettings,
    ContentChangeMessage,
    FontScaleChangeMessage,
    ReadyMessage,
    ErrorMessage,
    ExtensionToWebviewMessage,
    SearchHistoryChangeMessage,
    SearchHistoryState,
    SettingsChangeMessage,
    SystemFontsMessage,
} from '../../shared/types.js';
import type { SettingValue } from '../../shared/settings/index.js';
import { MESSAGE_TYPES } from '../../shared/messageTypes.js';
import { debounce } from '../../shared/utils.js';
import { DEFAULT_CONFIG } from '../../shared/types.js';

// =============================================================================
// Type Declarations
// =============================================================================

/**
 * Interface for VS Code API in Webview context.
 *
 * Note: Interface name does not follow "I" prefix convention as it mirrors
 * the actual VS Code API interface naming.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export interface IVsCodeApi {
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

// =============================================================================
// DES-API-003: Callback Interface for Message Handling
// =============================================================================

/**
 * Callback interface for Webview message handler events.
 *
 * These callbacks are invoked when corresponding messages are received
 * from the Extension host.
 *
 * Design Reference: DES-API-003
 */
export interface IWebviewMessageCallbacks {
    /**
     * Called when INIT message is received.
     * Sets up the editor with initial content and theme.
     *
     * @param content - The initial markdown content
     * @param theme - The initial theme setting
     * @param documentUri - The document URI for image path resolution
     * @param settings - Optional editor settings
     */
    onInit: (
        content: string,
        theme: ThemeType,
        documentUri: string,
        searchHistory: SearchHistoryState,
        settings?: LiveWriteMdEditorSettings,
        mode?: import('../shared/types.js').EditorMode,
        outlineWidth?: number,
        allSettings?: Record<string, SettingValue>
    ) => void;

    /**
     * Called when SETTINGS_CHANGE message is received.
     * Any liveWriteMd configuration change re-sends the full settings.
     */
    onSettingsChange: (message: SettingsChangeMessage) => void;

    /**
     * Called when OPEN_SETTINGS message is received.
     * The extension asks the webview to show its settings panel.
     */
    onOpenSettings: () => void;

    /**
     * Called when SYSTEM_FONTS message is received.
     * Extension host has enumerated locally installed font families.
     * 可选：导图独立面板等不显示设置面板的入口可以不实现。
     */
    onSystemFonts?: (fonts: string[]) => void;

    /**
     * Called when UPDATE message is received.
     * Updates the editor content when external changes occur.
     *
     * @param content - The updated markdown content
     */
    onUpdate: (content: string) => void;

    /**
     * Called when THEME_CHANGE message is received.
     * Updates the editor theme to match VS Code theme.
     *
     * @param theme - The new theme setting
     */
    onThemeChange: (theme: ThemeType) => void;
}

// =============================================================================
// DES-API-004: Webview Side Message Sending
// =============================================================================

/**
 * Webview side message sender class.
 *
 * Provides type-safe methods for sending messages from Webview to Extension.
 * All methods use satisfies operator to ensure type safety at compile time.
 *
 * Design Reference: DES-API-004
 *
 * @example
 * ```typescript
 * const sender = new WebviewMessageSender(vscode);
 * sender.sendReady();
 * sender.sendContentChange('# New content');
 * sender.sendError('Something went wrong', error.stack);
 * ```
 */
export class WebviewMessageSender {
    /**
     * Creates a new WebviewMessageSender instance.
     *
     * @param vscode - The VS Code API instance acquired via acquireVsCodeApi()
     */
    constructor(private readonly vscode: IVsCodeApi) {}

    /**
     * Send content change message to Extension.
     *
     * Called when user edits content in the CodeMirror editor.
     * The Extension will apply these changes to the TextDocument.
     *
     * @param content - The updated markdown content
     *
     * Design Reference: DES-D-003 (ContentChangeMessage)
     * Requirement: REQ-F-004
     */
    public sendContentChange(content: string): void {
        const message: ContentChangeMessage = {
            type: MESSAGE_TYPES.CONTENT_CHANGE,
            content,
        } satisfies ContentChangeMessage;

        this.vscode.postMessage(message);
    }

    /**
     * Send ready message to Extension.
     *
     * Called when Webview initialization is complete.
     * The Extension waits for this message before sending content updates.
     *
     * Design Reference: DES-D-003 (ReadyMessage)
     * Requirement: REQ-F-003
     */
    public sendReady(): void {
        const message: ReadyMessage = {
            type: MESSAGE_TYPES.READY,
        } satisfies ReadyMessage;

        this.vscode.postMessage(message);
    }

    /**
     * Send error message to Extension.
     *
     * Called when an error occurs in the Webview.
     * Allows the Extension to display error messages to the user.
     *
     * @param message - Error description
     * @param stack - Optional stack trace for debugging
     * @param code - Optional error code for categorizing errors (e.g., 'EDITOR_INIT_ERROR', 'SYNC_ERROR')
     *
     * Design Reference: DES-D-003 (ErrorMessage)
     */
    public sendError(message: string, stack?: string, code?: string): void {
        const errorMessage: ErrorMessage = {
            type: MESSAGE_TYPES.ERROR,
            message,
            stack,
            code,
        } satisfies ErrorMessage;

        this.vscode.postMessage(errorMessage);
    }

    /**
     * Send an editor action message to the Extension.
     *
     * Used by the Markdown正文 right-click menu to request insert-image
     * and editor mode changes without touching the editor content logic.
     *
     * @param action - The requested editor action
     * @param mode - Optional target mode for mode-switch actions
     * @returns void
     */
    public sendEditorAction(
        action: 'insertImage' | 'setMode' | 'exportAsHtml' | 'exportAsPdf' | 'downloadRemoteImages',
        mode?: import('../shared/types.js').EditorMode
    ): void {
        this.vscode.postMessage({
            type: 'editorAction',
            action,
            mode,
        });
    }

    /**
     * 发送编辑器字体缩放变更消息到扩展侧。
     *
     * 当用户通过 Ctrl+滚轮调整字号后调用，用于把最新缩放倍率写回配置。
     *
     * @param fontScale - 新的字体缩放倍率
     * @returns void
     */
    public sendFontScaleChange(fontScale: number): void {
        const message: FontScaleChangeMessage = {
            type: 'fontScaleChange',
            fontScale,
        } satisfies FontScaleChangeMessage;

        this.vscode.postMessage(message);
    }

    /**
     * 发送搜索/替换历史变更消息到扩展侧。
     *
     * @param history - 最新的搜索/替换历史状态。
     * @returns void
     */
    public sendSearchHistoryChange(history: SearchHistoryState): void {
        const message: SearchHistoryChangeMessage = {
            type: MESSAGE_TYPES.SEARCH_HISTORY_CHANGE,
            history,
        } satisfies SearchHistoryChangeMessage;

        this.vscode.postMessage(message);
    }

    /**
     * Create a debounced version of sendContentChange.
     *
     * This is useful for reducing message frequency during rapid typing.
     * The default debounce delay is 300ms as per DES-D-005.
     *
     * @param delay - Debounce delay in milliseconds (default: 300ms)
     * @returns A debounced function that sends content changes
     *
     * Design Reference: DES-API-006
     * Requirement: REQ-NF-001
     *
     * @example
     * ```typescript
     * const debouncedSend = sender.createDebouncedSendContentChange(300);
     * editor.onChange((content) => debouncedSend(content));
     * ```
     */
    public createDebouncedSendContentChange(
        delay: number = DEFAULT_CONFIG.debounceDelay
    ): (content: string) => void {
        return debounce((content: string) => {
            this.sendContentChange(content);
        }, delay);
    }
}

// =============================================================================
// DES-API-003: Webview Side Message Receiving
// =============================================================================

/**
 * Webview side message handler class.
 *
 * Handles incoming messages from Extension and dispatches them to
 * appropriate callbacks. Provides type-safe message handling with
 * proper error handling.
 *
 * Design Reference: DES-API-003
 *
 * @example
 * ```typescript
 * const handler = new WebviewMessageHandler({
 *     onInit: (content, theme, documentUri) => {
 *         editor.setContent(content);
 *         themeManager.setTheme(theme);
 *     },
 *     onUpdate: (content) => editor.setContent(content),
 *     onThemeChange: (theme) => themeManager.setTheme(theme)
 * });
 * handler.setup();
 * ```
 */
export class WebviewMessageHandler {
    private readonly callbacks: IWebviewMessageCallbacks;

    /**
     * Creates a new WebviewMessageHandler instance.
     *
     * @param callbacks - Callback functions for handling different message types
     */
    constructor(callbacks: IWebviewMessageCallbacks) {
        this.callbacks = callbacks;
    }

    /**
     * Set up the message listener on window.
     *
     * Registers addEventListener('message', ...) listener to handle
     * incoming messages from the Extension.
     *
     * Design Reference: DES-API-003
     */
    public setup(): void {
        window.addEventListener('message', (event: MessageEvent<unknown>) => {
            const message = event.data as ExtensionToWebviewMessage;
            this.handleMessage(message);
        });
    }

    /**
     * Handle incoming message from Extension.
     *
     * Dispatches the message to the appropriate callback based on
     * message type. Unknown message types are silently ignored.
     *
     * @param message - The message received from the Extension
     *
     * Design Reference: DES-API-003
     */
    private handleMessage(message: ExtensionToWebviewMessage): void {
        switch (message.type) {
            case MESSAGE_TYPES.INIT:
                this.handleInit(message);
                break;

            case MESSAGE_TYPES.UPDATE:
                this.handleUpdate(message);
                break;

            case MESSAGE_TYPES.THEME_CHANGE:
                this.handleThemeChange(message);
                break;

            case MESSAGE_TYPES.SETTINGS_CHANGE:
                this.callbacks.onSettingsChange(message);
                break;

            case MESSAGE_TYPES.OPEN_SETTINGS:
                this.callbacks.onOpenSettings();
                break;

            case MESSAGE_TYPES.SYSTEM_FONTS:
                this.callbacks.onSystemFonts?.((message as SystemFontsMessage).fonts ?? []);
                break;

            default:
                // Unknown message type - silently ignore
                // This provides forward compatibility if new message types
                // are added in the future
                break;
        }
    }

    /**
     * Handle INIT message.
     *
     * Called when the editor starts with document content,
     * initial theme, and document URI for image path resolution.
     *
     * @param message - The INIT message
     *
     * Design Reference: DES-D-002 (InitMessage)
     * Requirement: REQ-F-003
     */
    private handleInit(message: {
        content: string;
        theme: ThemeType;
        documentUri: string;
        searchHistory: SearchHistoryState;
        settings?: LiveWriteMdEditorSettings;
        mode?: import('../shared/types.js').EditorMode;
        outlineWidth?: number;
        outlinePanelWidth?: number;
        allSettings?: Record<string, SettingValue>;
    }): void {
        this.callbacks.onInit(
            message.content,
            message.theme,
            message.documentUri,
            message.searchHistory,
            message.settings,
            message.mode,
            message.outlineWidth ?? message.outlinePanelWidth,
            message.allSettings
        );
    }

    /**
     * Handle UPDATE message.
     *
     * Called when document content changes externally (e.g., from VS Code
     * text editor or external file modification).
     *
     * @param message - The UPDATE message
     *
     * Design Reference: DES-D-002 (UpdateMessage)
     * Requirement: REQ-F-005
     */
    private handleUpdate(message: { content: string }): void {
        this.callbacks.onUpdate(message.content);
    }

    /**
     * Handle THEME_CHANGE message.
     *
     * Called when VS Code's color theme changes to allow the Webview
     * to adapt its appearance.
     *
     * @param message - The THEME_CHANGE message
     *
     * Design Reference: DES-D-002 (ThemeChangeMessage)
     * Requirement: REQ-F-008
     */
    private handleThemeChange(message: { theme: ThemeType }): void {
        this.callbacks.onThemeChange(message.theme);
    }
}
