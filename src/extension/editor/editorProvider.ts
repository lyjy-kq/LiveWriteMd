/**
 * LiveWriteMD Editor Provider
 *
 * This module implements the CustomTextEditorProvider for the LiveWriteMD extension.
 * It manages the Webview panel, TextDocument synchronization, and handles
 * communication between the Extension and Webview via postMessage.
 *
 * @module extension/editorProvider
 *
 * Design References:
 * - DES-A-003: CustomTextEditorProvider design
 * - DES-A-007: Large file warning design
 * - DES-A-008: Logging design
 * - DES-S-002: Resource access restriction settings
 *
 * Requirements:
 * - REQ-F-001: CustomTextEditorProvider implementation
 * - REQ-F-006: Undo/Redo VS Code integration
 * - REQ-F-009: Large file warning display
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type {
    WebviewToExtensionMessage,
    ThemeType,
    EditorMode,
} from '../../shared/types.js';
import { MESSAGE_TYPES } from '../../shared/messageTypes.js';
import { checkFileSize, openWithTextEditor } from './fileSizeChecker.js';
import { getHtmlForWebview } from './webviewContent.js';
import { Logger } from '../logger.js';
import { ConfigManager } from './configManager.js';
import * as commands from './providerCommands.js';
import { EDITOR_MODE_STORAGE_PREFIX } from './providerCommands.js';
import {
    handleWebviewMessage as handleWebviewMessageImpl,
    getSavedOutlinePanelWidth,
} from './providerMessages.js';
import { getThemeType } from './themeType.js';

// mindmapPanelManager 等历史调用方从本模块取 getThemeType，保持 re-export 不变
export { getThemeType } from './themeType.js';

// =============================================================================
// Constants
// =============================================================================

/**
 * View type identifier for the LiveWriteMD custom editor.
 * Must match the viewType in package.json contributes.customEditors.
 */
export const VIEW_TYPE = 'liveWriteMd.editor';

// =============================================================================
// LiveWriteMdEditorProvider
// =============================================================================

/**
 * Custom text editor provider for LiveWriteMD.
 *
 * Implements VS Code's CustomTextEditorProvider interface to provide
 * a WYSIWYG Markdown editing experience using Milkdown in a Webview.
 *
 * Design Reference: DES-A-003
 */
export class LiveWriteMdEditorProvider implements vscode.CustomTextEditorProvider {
    /** Currently active webview panel info */
    public activePanelInfo: { panel: vscode.WebviewPanel; docUri: string } | null = null;

    /** Editor mode per document: 'live' | 'viewer' | 'source' | 'mindmap' */
    public editorModeMap = new Map<string, string>();

    /**
     * Creates a new instance of LiveWriteMdEditorProvider.
     *
     * @param context - The extension context
     */
    constructor(public readonly context: vscode.ExtensionContext) {}

    // =========================================================================
    // 命令方法薄包装
    //
    // 实现全部在 providerCommands.ts（拆出去前是这里的类方法）。
    // 保留同名公开方法是为了 index.ts 的命令注册与类内部调用不用改。
    // =========================================================================

    /** 设置当前文档的编辑模式（实现见 providerCommands）。 */
    public setEditorMode(mode: EditorMode): void {
        commands.setEditorMode(this, mode);
    }

    /** 标题栏单按钮循环切换模式（实现见 providerCommands）。 */
    public cycleEditorMode(): void {
        commands.cycleEditorMode(this);
    }

    /** 实时模式 ⇄ 导图模式互切（实现见 providerCommands）。 */
    public toggleMindmapMode(): void {
        commands.toggleMindmapMode(this);
    }

    /** 文本模式三态循环（实现见 providerCommands）。 */
    public cycleTextMode(): void {
        commands.cycleTextMode(this);
    }

    /** 获取当前激活文档 uri（实现见 providerCommands）。 */
    public getActiveDocumentUri(): vscode.Uri | null {
        return commands.getActiveDocumentUri(this);
    }

    /** 切换大纲面板显示（实现见 providerCommands）。 */
    public toggleOutline(): void {
        commands.toggleOutline(this);
    }

    /** 「显示内存占用」命令（实现见 providerCommands）。 */
    public showMemoryUsage(): void {
        commands.showMemoryUsage(this);
    }

    /** 展示内存统计弹窗（实现见 providerCommands）。 */
    public async presentMemoryStats(stats: Record<string, unknown>): Promise<void> {
        return commands.presentMemoryStats(stats);
    }

    /** 打开设置面板（实现见 providerCommands）。 */
    public openSettings(): void {
        commands.openSettings(this);
    }

    /** 下发系统字体列表（实现见 providerCommands）。 */
    public sendSystemFonts(panel: vscode.WebviewPanel): void {
        commands.sendSystemFonts(panel);
    }

    /** 通过文件选择器插入图片（实现见 providerCommands）。 */
    public async insertImage(): Promise<void> {
        return commands.insertImage(this);
    }

    /** 从资源管理器右键插入图片（实现见 providerCommands）。 */
    public async insertImageFromExplorer(sourceUri: vscode.Uri): Promise<void> {
        return commands.insertImageFromExplorer(this, sourceUri);
    }

    /** 下载文中的网络图片到 assets（实现见 providerCommands）。 */
    public async downloadRemoteImages(document: vscode.TextDocument): Promise<void> {
        return commands.downloadRemoteImages(this, document);
    }


    /**
     * Resolves a custom text editor for the given document.
     * Called by VS Code when a file needs to be opened with this custom editor.
     *
     * @param document - The text document to edit
     * @param webviewPanel - The webview panel to use for the editor UI
     * @param _token - Cancellation token
     *
     * Design References:
     * - DES-A-003: CustomTextEditorProvider design
     * - DES-A-007: Large file warning design
     * - DES-S-002: localResourceRoots settings
     */
    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        Logger.info(
            `Opening document: ${document.uri.toString()} (scheme: ${document.uri.scheme})`
        );

        // =================================================================
        // File Size Check (DES-A-007, REQ-F-009)
        // =================================================================
        const fileSizeResult = await checkFileSize(document);

        if (fileSizeResult.action === 'standardEditor') {
            // User chose to open with standard text editor
            Logger.info(`User chose text editor for large file: ${document.uri.fsPath}`);
            await openWithTextEditor(document.uri);
            return;
        }

        if (fileSizeResult.action === 'cancel') {
            // User cancelled - do nothing, just return
            Logger.info(`User cancelled large file dialog: ${document.uri.fsPath}`);
            return;
        }

        // fileSizeResult.action === 'proceed' - proceed with LiveWriteMD editor
        Logger.info(`Proceeding with LiveWriteMD editor: ${document.uri.fsPath}`);

        // =================================================================
        // Webview Configuration (DES-S-002)
        // =================================================================
        // Get document directory for image loading
        const documentDir = path.dirname(document.uri.fsPath);

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                // Extension dist folder (for scripts and styles)
                vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
                // Document folder (for image loading) - DES-S-002
                vscode.Uri.file(documentDir),
            ],
        };
        Logger.info(
            `Webview options configured: enableScripts=true, documentDir=${documentDir}, extensionDist=${vscode.Uri.joinPath(this.context.extensionUri, 'dist').toString()}`
        );
        // Webview 脚本探针用于确认 dist/webview.js 是否真实存在，以及转换后的 URI 是否符合 CSP。
        const webviewScriptDiskUri = vscode.Uri.joinPath(
            this.context.extensionUri,
            'dist',
            'webview.js'
        );
        const webviewScriptUri = webviewPanel.webview.asWebviewUri(webviewScriptDiskUri);
        try {
            const webviewScriptStat = await vscode.workspace.fs.stat(webviewScriptDiskUri);
            Logger.info(
                `Webview script probe: exists=true, size=${webviewScriptStat.size}, diskUri=${webviewScriptDiskUri.toString()}, fsPath=${webviewScriptDiskUri.fsPath}, webviewUri=${webviewScriptUri.toString()}, cspSource=${webviewPanel.webview.cspSource}`
            );
        } catch (error) {
            Logger.error(
                `Webview script probe failed: diskUri=${webviewScriptDiskUri.toString()}, fsPath=${webviewScriptDiskUri.fsPath}, webviewUri=${webviewScriptUri.toString()}, cspSource=${webviewPanel.webview.cspSource}`,
                error instanceof Error ? error : new Error(String(error))
            );
        }

        // =================================================================
        // State Management
        // =================================================================
        let isWebviewReady = false;
        let isExtensionUpdating = false;
        let isWebviewUpdating = false;
        // Track last content received from webview to prevent sync loops
        let lastWebviewContent: string | null = null;
        // READY 超时计时器用于定位 Webview 脚本未运行或 READY 消息丢失导致的黑屏。
        let readyTimeout: ReturnType<typeof setTimeout> | undefined;

        // =================================================================
        // Webview Message Handler
        // =================================================================
        Logger.info(
            `Registering Webview message listener before HTML injection: ${document.uri.fsPath}`
        );
        const messageSubscription = webviewPanel.webview.onDidReceiveMessage(
            async (message: WebviewToExtensionMessage) => {
                Logger.info(
                    `Webview message received before dispatch: type=${message.type}, file=${path.basename(document.uri.fsPath)}`
                );
                try {
                    await this.handleWebviewMessage(message, document, webviewPanel, {
                        isExtensionUpdating: () => isExtensionUpdating,
                        setWebviewUpdating: (value: boolean) => {
                            isWebviewUpdating = value;
                        },
                        setWebviewReady: (value: boolean) => {
                            isWebviewReady = value;
                            if (value && readyTimeout) {
                                clearTimeout(readyTimeout);
                                readyTimeout = undefined;
                                Logger.info(`READY timeout cleared: ${document.uri.fsPath}`);
                            }
                        },
                        setLastWebviewContent: (content: string) => {
                            lastWebviewContent = content;
                        },
                    });
                } catch (error) {
                    Logger.error(
                        `Webview message handling failed: type=${message.type}, file=${document.uri.fsPath}`,
                        error instanceof Error ? error : new Error(String(error))
                    );
                }
            }
        );
        Logger.info(`Webview message listener registered: ${document.uri.fsPath}`);

        // =================================================================
        // Webview HTML Setup
        // =================================================================
        const webviewHtml = getHtmlForWebview(
            webviewPanel.webview,
            this.context.extensionUri,
            getSavedOutlinePanelWidth(this.context)
        );
        // 先让当前调用栈和 VS Code 的 webview 初始化流程完成一轮，
        // 再注入 HTML，尽量规避某些平台在“文档仍处于无效状态”时注册
        // service worker 失败的问题。
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
        readyTimeout = setTimeout(() => {
            if (!isWebviewReady) {
                Logger.error(
                    `Webview READY timeout: no READY received within 3000ms after HTML injection. file=${document.uri.fsPath}, htmlLength=${webviewHtml.length}`
                );
            }
        }, 3000);
        Logger.info(
            `Injecting Webview HTML: file=${document.uri.fsPath}, htmlLength=${webviewHtml.length}`
        );
        webviewPanel.webview.html = webviewHtml;
        Logger.info(`Webview HTML injected: ${document.uri.fsPath}`);

        // =================================================================
        // TextDocument Change Listener
        // =================================================================

        const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(
            (e: vscode.TextDocumentChangeEvent) => {
                // Only process changes for this document
                if (e.document.uri.toString() !== document.uri.toString()) {
                    return;
                }

                const currentContent = document.getText();

                // Detailed debug log for bug investigation
                Logger.debug(
                    `onDidChangeTextDocument: isWebviewUpdating=${isWebviewUpdating} isExtensionUpdating=${isExtensionUpdating} isWebviewReady=${isWebviewReady} isDirty=${document.isDirty} reason=${e.reason ?? 'none'} changeCount=${e.contentChanges.length}`
                );
                for (const change of e.contentChanges) {
                    Logger.debug(
                        `  change: offset=${change.rangeOffset} len=${change.rangeLength} text=${JSON.stringify(change.text.slice(0, 100))}`
                    );
                }

                // Skip if we're in the middle of a webview-initiated update
                if (isWebviewUpdating) {
                    Logger.debug('Skipping: isWebviewUpdating=true');
                    return;
                }

                // Skip if webview is not ready
                if (!isWebviewReady) {
                    Logger.debug('Skipping: isWebviewReady=false');
                    return;
                }

                // Skip if content matches what webview just sent (prevents sync loop)
                if (lastWebviewContent !== null && currentContent === lastWebviewContent) {
                    Logger.debug(
                        'Skipping UPDATE: content matches lastWebviewContent (sync loop prevention)'
                    );
                    return;
                }

                // Skip auto-save formatting changes (trimTrailingWhitespace, insertFinalNewline, trimFinalNewlines).
                // These VS Code features modify the document on save, but the webview content should be authoritative.
                // Without this guard, the trimmed content gets sent back to the webview, causing cursor/scroll resets.
                if (lastWebviewContent !== null) {
                    const normalize = (s: string): string =>
                        s
                            .split('\n')
                            .map((l) => l.trimEnd())
                            .join('\n')
                            .replace(/\n+$/, '');
                    if (normalize(currentContent) === normalize(lastWebviewContent)) {
                        Logger.debug(
                            'Skipping UPDATE: diff is only trailing whitespace/newlines (auto-save formatting)'
                        );
                        lastWebviewContent = currentContent;
                        return;
                    }
                }

                Logger.info(`Document changed externally: ${document.uri.fsPath}`);
                Logger.debug(
                    `  contentLength=${currentContent.length} lastWebviewContentLength=${lastWebviewContent?.length ?? 'null'}`
                );
                if (lastWebviewContent !== null) {
                    // Log the diff to help identify what changed
                    const maxLen = Math.max(currentContent.length, lastWebviewContent.length);
                    for (let i = 0; i < maxLen; i++) {
                        if (
                            i >= currentContent.length ||
                            i >= lastWebviewContent.length ||
                            currentContent[i] !== lastWebviewContent[i]
                        ) {
                            const ctx = 20;
                            const start = Math.max(0, i - ctx);
                            const end = Math.min(maxLen, i + ctx);
                            Logger.debug(
                                `  first diff at pos=${i}: current=${JSON.stringify(currentContent.slice(start, end))} lastWebview=${JSON.stringify(lastWebviewContent.slice(start, end))}`
                            );
                            break;
                        }
                    }
                }

                // Send update to webview
                isExtensionUpdating = true;
                webviewPanel.webview
                    .postMessage({
                        type: MESSAGE_TYPES.UPDATE,
                        content: document.getText(),
                    })
                    .then(
                        () => {
                            isExtensionUpdating = false;
                        },
                        () => {
                            isExtensionUpdating = false;
                        }
                    );
            }
        );

        // =================================================================
        // Panel Tracking for Editor Mode
        // =================================================================
        const docUriStr = document.uri.toString();
        // 初始模式：rememberLastMode 开启时优先恢复该文档上次使用的模式
        const defaultMode = ConfigManager.getDefaultMode();
        const rememberedMode = ConfigManager.getRememberLastMode()
            ? this.context.globalState.get<EditorMode>(EDITOR_MODE_STORAGE_PREFIX + docUriStr)
            : undefined;
        const initialMode = rememberedMode ?? defaultMode;
        this.editorModeMap.set(docUriStr, initialMode);
        this.activePanelInfo = { panel: webviewPanel, docUri: docUriStr };
        vscode.commands.executeCommand('setContext', 'liveWriteMd.editorMode', initialMode);

        webviewPanel.onDidChangeViewState(() => {
            if (webviewPanel.active) {
                this.activePanelInfo = { panel: webviewPanel, docUri: docUriStr };
                const editorMode = this.editorModeMap.get(docUriStr) ?? 'live';
                vscode.commands.executeCommand('setContext', 'liveWriteMd.editorMode', editorMode);
            }
        });

        // =================================================================
        // Configuration Change Listener
        // =================================================================
        const configChangeSubscription = vscode.workspace.onDidChangeConfiguration(
            (e: vscode.ConfigurationChangeEvent) => {
                if (!e.affectsConfiguration('liveWriteMd')) return;

                // 任何 liveWriteMd 设置变化：统一重发完整设置（结构化 + 全量），
                // Webview 侧据此更新编辑器配置与 CSS 变量。
                Logger.info('LiveWriteMD settings changed');
                webviewPanel.webview.postMessage({
                    type: MESSAGE_TYPES.SETTINGS_CHANGE,
                    settings: ConfigManager.getEditorSettings(),
                    allSettings: ConfigManager.getAllSettings(),
                });

                // theme 还涉及明暗切换（不只 CSS 变量），额外发一次主题消息。
                if (e.affectsConfiguration('liveWriteMd.theme')) {
                    Logger.info(
                        `LiveWriteMD theme override changed to: ${ConfigManager.getThemeOverride()}`
                    );
                    webviewPanel.webview.postMessage({
                        type: MESSAGE_TYPES.THEME_CHANGE,
                        theme: getThemeType(),
                    });
                }
            }
        );

        // =================================================================
        // VS Code Theme Change Listener
        // =================================================================
        const themeChangeSubscription = vscode.window.onDidChangeActiveColorTheme(() => {
            const newTheme = getThemeType();
            Logger.info(`VS Code theme changed, sending to webview: ${newTheme}`);
            webviewPanel.webview.postMessage({
                type: MESSAGE_TYPES.THEME_CHANGE,
                theme: newTheme,
            });
        });

        // =================================================================
        // Dispose Handler
        // =================================================================
        webviewPanel.onDidDispose(() => {
            Logger.info(`Webview disposed for: ${document.uri.fsPath}`);
            if (readyTimeout) {
                clearTimeout(readyTimeout);
                readyTimeout = undefined;
            }
            changeDocumentSubscription.dispose();
            messageSubscription.dispose();
            configChangeSubscription.dispose();
            themeChangeSubscription.dispose();
            this.editorModeMap.delete(docUriStr);
            if (this.activePanelInfo?.docUri === docUriStr) {
                this.activePanelInfo = null;
            }
        });

        // =================================================================
        // Send Initial Content
        // =================================================================
        // Note: We wait for the 'ready' message from webview before sending init
        // For now, with placeholder HTML, we just log
        Logger.info(`Editor initialized for: ${document.uri.fsPath}`);
    }

    /**
     * Webview 消息分发入口。
     *
     * 各消息分支的实现在 providerMessages.ts（拆出去前是这里的私有方法），
     * 这里只做转发；state 回调由 resolveCustomTextEditor 注入。
     */
    private async handleWebviewMessage(
        message: WebviewToExtensionMessage,
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        state: {
            isExtensionUpdating: () => boolean;
            setWebviewUpdating: (value: boolean) => void;
            setWebviewReady: (value: boolean) => void;
            setLastWebviewContent: (content: string) => void;
        }
    ): Promise<void> {
        return handleWebviewMessageImpl(this, message, document, webviewPanel, state);
    }


    /**
     * Update the TextDocument with new content using WorkspaceEdit.
     * This ensures proper Undo/Redo integration with VS Code.
     *
     * @param document - The document to update
     * @param content - The new content
     * @returns Promise resolving to true if the edit was applied successfully
     *
     * Design Reference: DES-A-003 (Undo/Redo integration)
     * Requirement: REQ-F-006
     */
    public async updateTextDocument(
        document: vscode.TextDocument,
        content: string
    ): Promise<boolean> {
        const edit = new vscode.WorkspaceEdit();

        // Replace the entire document content
        edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), content);

        return vscode.workspace.applyEdit(edit);
    }
}
