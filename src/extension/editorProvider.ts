/**
 * FlowMD Editor Provider
 *
 * This module implements the CustomTextEditorProvider for the FlowMD extension.
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

import * as fs from 'fs';
import * as vscode from 'vscode';
import * as path from 'path';
import type {
    OutlineWidthChangeMessage,
    FontScaleChangeMessage,
    EditorActionMessage,
    SearchHistoryChangeMessage,
    UpdateSettingMessage,
    WebviewToExtensionMessage,
    ThemeType,
} from '../shared/types.js';
import { MESSAGE_TYPES } from '../shared/messageTypes.js';
import { checkFileSize, openWithTextEditor } from './fileSizeChecker.js';
import { getHtmlForWebview } from './webviewContent.js';
import { Logger } from './logger.js';
import { ConfigManager } from './configManager.js';
import { exportMarkdownAsHtml } from './htmlExporter.js';
import { exportMarkdownAsPdf } from './pdfExporter.js';
import { handleSaveImage } from './imageSaveHandler.js';
import { downloadRemoteImagesToAssets } from './remoteImageDownloadHandler.js';
import { resolveFileLinkTarget } from './fileLinkResolver.js';
import { getSavedSearchHistory, saveSearchHistory } from './searchHistoryStore.js';

// =============================================================================
// Constants
// =============================================================================

/**
 * View type identifier for the FlowMD custom editor.
 * Must match the viewType in package.json contributes.customEditors.
 */
export const VIEW_TYPE = 'flowMd.editor';

/**
 * 澶х翰闈㈡澘瀹藉害鍦ㄦ墿灞曞叏灞€瀛樺偍涓殑閿悕銆? * 鐢ㄤ簬鍦?VS Code 閲嶅惎鍚庢仮澶嶇敤鎴蜂笂涓€娆¤皟鏁寸殑瀹藉害銆? */
const OUTLINE_PANEL_WIDTH_STORAGE_KEY = 'flowMd.outlineWidth';

/**
 * 澶х翰闈㈡澘瀹藉害鐨勯粯璁ゅ€笺€? * 褰撳瓨鍌ㄧ己澶辨垨鍊奸潪娉曟椂浣跨敤銆? */
const DEFAULT_OUTLINE_PANEL_WIDTH = 280;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get the current theme type based on VS Code's color theme kind.
 *
 * @returns 'light' or 'dark' based on the current VS Code theme
 */
function getThemeType(): ThemeType {
    const override = ConfigManager.getThemeOverride();
    if (override !== 'auto') {
        return override;
    }
    const kind = vscode.window.activeColorTheme?.kind;
    switch (kind) {
        case vscode.ColorThemeKind.Light:
        case vscode.ColorThemeKind.HighContrastLight:
            return 'light';
        case vscode.ColorThemeKind.Dark:
        case vscode.ColorThemeKind.HighContrast:
        default:
            return 'dark';
    }
}

/**
 * 把 1-based 的文件链接范围转换为 VS Code 可用的 Range。
 *
 * @param selection - 文件链接解析得到的行列范围
 * @returns VS Code Range；未提供范围时返回 undefined
 */
function createSelectionRange(selection: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
} | null): vscode.Range | undefined {
    if (!selection) {
        return undefined;
    }

    return new vscode.Range(
        Math.max(0, selection.startLine - 1),
        Math.max(0, selection.startColumn - 1),
        Math.max(0, selection.endLine - 1),
        Math.max(0, selection.endColumn - 1)
    );
}

/**
 * 浠庢墿灞曞叏灞€瀛樺偍涓鍙栧ぇ绾查潰鏉垮搴︺€? *
 * @param context - 鎵╁睍涓婁笅鏂囷紝鐢ㄤ簬璁块棶 workspaceState
 * @returns 澶х翰闈㈡澘瀹藉害锛屽崟浣嶄负鍍忕礌
 */
function getSavedOutlinePanelWidth(context: vscode.ExtensionContext): number {
    const raw = context.workspaceState.get<number>(OUTLINE_PANEL_WIDTH_STORAGE_KEY);
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return DEFAULT_OUTLINE_PANEL_WIDTH;
    }
    return Math.min(480, Math.max(220, Math.round(raw)));
}

/**
 * 瑙勮寖鍖栧ぇ绾查潰鏉垮搴︼紝闃叉寮傚父鍊煎啓鍏ュ瓨鍌ㄣ€? *
 * @param width - Webview 涓婃姤鐨勫搴? * @returns 缁忚繃瑁佸壀鍚庣殑鏈夋晥瀹藉害
 */
function normalizeOutlinePanelWidth(width: number): number {
    if (!Number.isFinite(width)) {
        return DEFAULT_OUTLINE_PANEL_WIDTH;
    }
    return Math.min(480, Math.max(220, Math.round(width)));
}

// =============================================================================
// FlowMdEditorProvider
// =============================================================================

/**
 * Custom text editor provider for FlowMD.
 *
 * Implements VS Code's CustomTextEditorProvider interface to provide
 * a WYSIWYG Markdown editing experience using Milkdown in a Webview.
 *
 * Design Reference: DES-A-003
 */
export class FlowMdEditorProvider implements vscode.CustomTextEditorProvider {
    /** Currently active webview panel info */
    private activePanelInfo: { panel: vscode.WebviewPanel; docUri: string } | null = null;

    /** Editor mode per document: 'live' | 'viewer' | 'source' */
    private editorModeMap = new Map<string, string>();

    /**
     * Creates a new instance of FlowMdEditorProvider.
     *
     * @param context - The extension context
     */
    constructor(private readonly context: vscode.ExtensionContext) {}

    /**
     * Sets the editor mode for the active FlowMD editor.
     * Cycles through: live 鈫?viewer 鈫?source 鈫?live
     *
     * @param mode - The target mode ('live' | 'viewer' | 'source')
     */
    public setEditorMode(mode: 'live' | 'viewer' | 'source'): void {
        if (!this.activePanelInfo) return;
        const { panel, docUri } = this.activePanelInfo;
        this.editorModeMap.set(docUri, mode);

        panel.webview.postMessage({
            type: MESSAGE_TYPES.EDITOR_MODE,
            mode,
        });

        vscode.commands.executeCommand('setContext', 'flowMd.editorMode', mode);
        Logger.info(`Editor mode set to '${mode}' for: ${docUri}`);
    }

    /**
     * 切换当前文档右侧大纲面板的显示状态。
     *
     * 可见性由 Webview 侧持有，这里只负责把切换意图转发过去，避免两边各存一份
     * 状态造成不一致。
     *
     * @returns void
     */
    public toggleOutline(): void {
        if (!this.activePanelInfo) {
            vscode.window.showWarningMessage('FlowMD: 请在 FlowMD 编辑器中切换大纲。');
            return;
        }

        const { panel, docUri } = this.activePanelInfo;
        panel.webview.postMessage({ type: MESSAGE_TYPES.OUTLINE_TOGGLE });
        Logger.info(`Outline toggled for: ${docUri}`);
    }

    /**
     * 打开当前 FlowMD 编辑器内的设置面板。
     *
     * 面板 UI 在 Webview 侧，这里只发一个打开信号。
     */
    public openSettings(): void {
        if (!this.activePanelInfo) {
            vscode.window.showWarningMessage('FlowMD: 请先打开一个 FlowMD 编辑器。');
            return;
        }
        const { panel, docUri } = this.activePanelInfo;
        panel.webview.postMessage({ type: MESSAGE_TYPES.OPEN_SETTINGS });
        Logger.info(`Settings panel opened for: ${docUri}`);
    }

    /**
     * Insert an image via file picker dialog.
     * Alternative to drag & drop (which doesn't work in VS Code webviews).
     * Copies the selected image to the configured save folder and notifies the webview.
     */
    public async insertImage(): Promise<void> {
        if (!this.activePanelInfo) return;
        const { panel, docUri } = this.activePanelInfo;

        // Find the document URI from the stored string
        const documents = vscode.workspace.textDocuments;
        const document = documents.find((d) => d.uri.toString() === docUri);
        if (!document) return;

        const result = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectMany: false,
            filters: {
                Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'],
            },
            title: 'Insert Image',
        });

        if (!result || result.length === 0) return;

        const sourceUri = result[0];
        const fileName = path.basename(sourceUri.fsPath);
        const docDir = path.dirname(document.uri.fsPath);

        try {
            // Use imageSaveHandler's validation and unique name logic
            const { getValidatedSaveFolder, sanitizeFileName, getUniqueFileName } =
                await import('./imageSaveHandler.js');

            const folderName = getValidatedSaveFolder(docDir);
            const saveDir = path.join(docDir, folderName);

            // Create directory if needed
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(saveDir));

            // Sanitize and get unique name
            const sanitized = sanitizeFileName(fileName);
            const finalName = await getUniqueFileName(saveDir, sanitized);

            // Copy file (more efficient than base64 encode/decode)
            const destPath = path.join(saveDir, finalName);
            await vscode.workspace.fs.copy(sourceUri, vscode.Uri.file(destPath));

            // Calculate relative path
            const normalizedFolder = folderName.replace(/\\/g, '/');
            const relativePath = normalizedFolder + '/' + finalName;

            Logger.info(`Image inserted via picker: ${relativePath}`);

            // Notify webview (reuses existing handleImageSaved in webview)
            await panel.webview.postMessage({
                type: 'imageSaved',
                relativePath,
                fileName: finalName,
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            Logger.error(`Image insert failed: ${errorMessage}`);
            vscode.window.showErrorMessage(`FlowMD: 图片插入失败：${errorMessage}`);
        }
    }

    /**
     * Insert an image from Explorer context menu.
     * Copies the image file to the configured save folder and notifies the webview.
     *
     * @param sourceUri - URI of the image file from Explorer
     */
    public async insertImageFromExplorer(sourceUri: vscode.Uri): Promise<void> {
        if (!this.activePanelInfo) {
            vscode.window.showWarningMessage(
                'FlowMD: No active editor. Open a .md file with FlowMD first.'
            );
            return;
        }
        const { panel, docUri } = this.activePanelInfo;

        const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === docUri);
        if (!document) return;

        const fileName = path.basename(sourceUri.fsPath);
        const docDir = path.dirname(document.uri.fsPath);

        try {
            const { getValidatedSaveFolder, sanitizeFileName, getUniqueFileName } =
                await import('./imageSaveHandler.js');

            const folderName = getValidatedSaveFolder(docDir);
            const saveDir = path.join(docDir, folderName);

            await vscode.workspace.fs.createDirectory(vscode.Uri.file(saveDir));

            const sanitized = sanitizeFileName(fileName);
            const finalName = await getUniqueFileName(saveDir, sanitized);
            const destPath = path.join(saveDir, finalName);

            await vscode.workspace.fs.copy(sourceUri, vscode.Uri.file(destPath));

            const normalizedFolder = folderName.replace(/\\/g, '/');
            const relativePath = normalizedFolder + '/' + finalName;

            Logger.info(`Image inserted from Explorer: ${relativePath}`);

            await panel.webview.postMessage({
                type: 'imageSaved',
                relativePath,
                fileName: finalName,
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            Logger.error(`Image insert from Explorer failed: ${errorMessage}`);
            vscode.window.showErrorMessage(`FlowMD: 图片插入失败：${errorMessage}`);
        }
    }

    /**
     * Download remote images in the current Markdown document and rewrite links.
     *
     * @param document - Current Markdown text document
     * @returns Promise<void>
     */
    public async downloadRemoteImages(document: vscode.TextDocument): Promise<void> {
        try {
            const originalContent = document.getText();
            const result = await downloadRemoteImagesToAssets(originalContent, document.uri);

            if (result.downloadedCount === 0) {
                await vscode.window.showInformationMessage('FlowMD: 没有找到可下载的网络图片。');
                return;
            }

            const success = await this.updateTextDocument(document, result.content);
            if (!success) {
                await vscode.window.showErrorMessage('FlowMD: 图片下载成功，但正文回写失败。');
                return;
            }

            if (result.failedUrls.length > 0) {
                await vscode.window.showWarningMessage(
                    `FlowMD: 已下载 ${result.downloadedCount} 张网络图片，但有 ${result.failedUrls.length} 张失败。`
                );
                return;
            }

            await vscode.window.showInformationMessage(
                `FlowMD: 已下载 ${result.downloadedCount} 张网络图片到 assets。`
            );
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            Logger.error(`Download remote images failed: ${errorMessage}`);
            await vscode.window.showErrorMessage(`FlowMD: 下载网络图片失败：${errorMessage}`);
        }
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

        // fileSizeResult.action === 'proceed' - proceed with FlowMD editor
        Logger.info(`Proceeding with FlowMD editor: ${document.uri.fsPath}`);

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
        const defaultMode = ConfigManager.getDefaultMode();
        this.editorModeMap.set(docUriStr, defaultMode);
        this.activePanelInfo = { panel: webviewPanel, docUri: docUriStr };
        vscode.commands.executeCommand('setContext', 'flowMd.editorMode', defaultMode);

        webviewPanel.onDidChangeViewState(() => {
            if (webviewPanel.active) {
                this.activePanelInfo = { panel: webviewPanel, docUri: docUriStr };
                const editorMode = this.editorModeMap.get(docUriStr) ?? 'live';
                vscode.commands.executeCommand('setContext', 'flowMd.editorMode', editorMode);
            }
        });

        // =================================================================
        // Configuration Change Listener
        // =================================================================
        const configChangeSubscription = vscode.workspace.onDidChangeConfiguration(
            (e: vscode.ConfigurationChangeEvent) => {
                if (!e.affectsConfiguration('flowMd')) return;

                // 任何 flowMd 设置变化：统一重发完整设置（结构化 + 全量），
                // Webview 侧据此更新编辑器配置与 CSS 变量。
                Logger.info('FlowMD settings changed');
                webviewPanel.webview.postMessage({
                    type: MESSAGE_TYPES.SETTINGS_CHANGE,
                    settings: ConfigManager.getEditorSettings(),
                    allSettings: ConfigManager.getAllSettings(),
                });

                // theme 还涉及明暗切换（不只 CSS 变量），额外发一次主题消息。
                if (e.affectsConfiguration('flowMd.theme')) {
                    Logger.info(
                        `FlowMD theme override changed to: ${ConfigManager.getThemeOverride()}`
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
     * Handle messages received from the webview.
     *
     * @param message - The message from the webview
     * @param document - The text document
     * @param webviewPanel - The webview panel
     * @param state - State management callbacks
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
        Logger.debug(
            `Received message: type=${message.type}, file=${path.basename(document.uri.fsPath)}`
        );

        switch (message.type) {
            case MESSAGE_TYPES.READY: {
                Logger.info(`Webview ready for: ${document.uri.fsPath}`);
                state.setWebviewReady(true);

                // Send initial content to webview
                const initContent = document.getText();
                Logger.debug(
                    `Sending INIT: contentLength=${initContent.length}, theme=${getThemeType()}`
                );
                // Compute webview-accessible URI for document directory (for image loading)
                const docDir = path.dirname(document.uri.fsPath);
                const docDirWebviewUri = webviewPanel.webview
                    .asWebviewUri(vscode.Uri.file(docDir))
                    .toString();
                const outlineWidth = getSavedOutlinePanelWidth(this.context);
                const searchHistory = getSavedSearchHistory(this.context);

                const initDelivered = await webviewPanel.webview.postMessage({
                    type: MESSAGE_TYPES.INIT,
                    content: initContent,
                    theme: getThemeType(),
                    documentUri: document.uri.toString(),
                    documentBaseUri: docDirWebviewUri,
                    searchHistory,
                    settings: ConfigManager.getEditorSettings(),
                    allSettings: ConfigManager.getAllSettings(),
                    mode: ConfigManager.getDefaultMode(),
                    outlineWidth,
                });
                Logger.info(
                    `INIT postMessage completed: delivered=${initDelivered}, mode=${ConfigManager.getDefaultMode()}, documentBaseUri=${docDirWebviewUri}`
                );
                break;
            }

            case MESSAGE_TYPES.CONTENT_CHANGE: {
                // Skip if we're in the middle of an extension-initiated update
                if (state.isExtensionUpdating()) {
                    Logger.debug('Skipping CONTENT_CHANGE: extension is updating');
                    return;
                }

                const contentLength = message.content?.length ?? 0;
                Logger.debug(`CONTENT_CHANGE received: contentLength=${contentLength}`);
                state.setWebviewUpdating(true);
                // Store content BEFORE applying edit to prevent sync loop
                state.setLastWebviewContent(message.content);

                try {
                    // Use WorkspaceEdit for Undo/Redo integration (REQ-F-006)
                    const success = await this.updateTextDocument(document, message.content);
                    if (success) {
                        Logger.debug(
                            `Document updated successfully: ${path.basename(document.uri.fsPath)}`
                        );
                    } else {
                        Logger.error(`Failed to update document: ${document.uri.fsPath}`);
                    }
                } finally {
                    state.setWebviewUpdating(false);
                }
                break;
            }

            case MESSAGE_TYPES.ERROR:
                Logger.error(`Webview error: ${message.message}`, new Error(message.stack));
                await vscode.window.showErrorMessage(`FlowMD: ${message.message}`);
                break;

            // 处理来自 Webview 的搜索/替换历史变更消息。
            case MESSAGE_TYPES.SEARCH_HISTORY_CHANGE as typeof MESSAGE_TYPES.READY: {
                const historyMsg = message as SearchHistoryChangeMessage;
                await saveSearchHistory(this.context, historyMsg.history);
                Logger.debug('Search history saved to workspace state');
                break;
            }

            // 处理来自 Webview 的大纲面板宽度更新消息。
            case MESSAGE_TYPES.OUTLINE_WIDTH_CHANGE as typeof MESSAGE_TYPES.READY: {
                const outlineMsg = message as OutlineWidthChangeMessage;
                const width = normalizeOutlinePanelWidth(outlineMsg.width);
                await this.context.workspaceState.update(OUTLINE_PANEL_WIDTH_STORAGE_KEY, width);
                Logger.debug(`Outline panel width saved: ${width}px`);
                break;
            }

            case 'fontScaleChange' as typeof MESSAGE_TYPES.READY: {
                const scaleMsg = message as FontScaleChangeMessage;
                const clampedScale = Math.min(
                    2,
                    Math.max(0.5, Math.round(scaleMsg.fontScale * 100) / 100)
                );
                await vscode.workspace
                    .getConfiguration('flowMd')
                    .update('fontScale', clampedScale, vscode.ConfigurationTarget.Global);
                Logger.debug(`Editor font scale saved: ${clampedScale}`);
                break;
            }

            // 设置面板改动 → 持久化单项设置
            case MESSAGE_TYPES.UPDATE_SETTING: {
                const settingMsg = message as UpdateSettingMessage;
                if (settingMsg.key) {
                    try {
                        await ConfigManager.updateSetting(
                            settingMsg.key,
                            settingMsg.value
                        );
                        Logger.debug(
                            `Setting updated: ${settingMsg.key}=${String(settingMsg.value)}`
                        );
                    } catch (err) {
                        Logger.error(
                            `Failed to persist setting ${settingMsg.key}: ${err instanceof Error ? err.message : String(err)}`
                        );
                    }
                }
                break;
            }

            // Handle clipboard write from webview (table cell copy etc.)
            case 'copyToClipboard' as typeof MESSAGE_TYPES.READY: {
                const clipMsg = message as unknown as { text: string };
                if (clipMsg.text) {
                    await vscode.env.clipboard.writeText(clipMsg.text);
                    Logger.debug(`Clipboard write: ${clipMsg.text.length} chars`);
                }
                break;
            }

            // Handle正文右键菜单动作
            case 'editorAction' as typeof MESSAGE_TYPES.READY: {
                const actionMsg = message as EditorActionMessage;
                if (actionMsg.action === 'insertImage') {
                    await this.insertImage();
                } else if (actionMsg.action === 'downloadRemoteImages') {
                    await this.downloadRemoteImages(document);
                } else if (actionMsg.action === 'exportAsHtml') {
                    await exportMarkdownAsHtml(document.uri);
                } else if (actionMsg.action === 'exportAsPdf') {
                    await exportMarkdownAsPdf(document.uri);
                } else if (actionMsg.action === 'setMode' && actionMsg.mode) {
                    this.setEditorMode(actionMsg.mode);
                }
                break;
            }

            // Handle openUrl messages (Ctrl+click links)
            case 'openUrl' as typeof MESSAGE_TYPES.READY: {
                const urlMsg = message as unknown as { url: string };
                if (urlMsg.url) {
                    Logger.info(`Opening URL: ${urlMsg.url}`);
                    await vscode.env.openExternal(vscode.Uri.parse(urlMsg.url));
                }
                break;
            }

            // Handle openFile messages (relative file links)
            case 'openFile' as typeof MESSAGE_TYPES.READY: {
                const fileMsg = message as unknown as { path: string };
                if (fileMsg.path) {
                    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
                    const resolvedTarget = resolveFileLinkTarget(
                        fileMsg.path,
                        document.uri.fsPath,
                        workspaceFolder ? [workspaceFolder.uri.fsPath] : [],
                        (candidate) => fs.existsSync(candidate)
                    );
                    const selection = createSelectionRange(resolvedTarget.selection);
                    Logger.info(`Opening file: ${resolvedTarget.filePath}`);
                    try {
                        const fileUri = vscode.Uri.file(resolvedTarget.filePath);
                        await vscode.commands.executeCommand('vscode.open', fileUri, {
                            selection,
                        });
                    } catch (err) {
                        Logger.error(
                            `Failed to open file: ${resolvedTarget.filePath}`,
                            err instanceof Error ? err : new Error(String(err))
                        );
                    }
                }
                break;
            }

            // Handle webview log messages.
            case 'webviewLog' as typeof MESSAGE_TYPES.READY: {
                const logMsg = message as unknown as { level: string; msg: string };
                if (logMsg.level === 'ERROR') {
                    Logger.error(`[Webview] ${logMsg.msg}`);
                } else if (logMsg.level === 'WARN') {
                    Logger.warn(`[Webview] ${logMsg.msg}`);
                } else {
                    Logger.debug(`[Webview] [${logMsg.level}] ${logMsg.msg}`);
                }
                break;
            }

            // Handle reload content request (re-read file from disk)
            case MESSAGE_TYPES.RELOAD_CONTENT as typeof MESSAGE_TYPES.READY: {
                Logger.info('Reload content requested from Webview');
                // 先执行 revert，再把最新的文档内容回推给 Webview。
                // onDidChangeTextDocument 会先触发，所以这里直接重新发送当前内容。
                try {
                    await vscode.commands.executeCommand('workbench.action.files.revert');
                } catch {
                    // 忽略 revert 失败，继续把当前 TextDocument 内容同步给 Webview。
                }
                await webviewPanel.webview.postMessage({
                    type: MESSAGE_TYPES.UPDATE,
                    content: document.getText(),
                });
                break;
            }

            // Handle image save from webview (drag & drop / clipboard paste)
            case MESSAGE_TYPES.SAVE_IMAGE as typeof MESSAGE_TYPES.READY: {
                const saveMsg = message as unknown as { data: string; fileName: string };
                if (saveMsg.data && saveMsg.fileName) {
                    await handleSaveImage(
                        saveMsg.data,
                        saveMsg.fileName,
                        document.uri,
                        webviewPanel.webview
                    );
                }
                break;
            }

            default:
                // Unknown message type - log for debugging
                Logger.info(`Unknown message type received: ${(message as { type: string }).type}`);
                break;
        }
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
    private async updateTextDocument(
        document: vscode.TextDocument,
        content: string
    ): Promise<boolean> {
        const edit = new vscode.WorkspaceEdit();

        // Replace the entire document content
        edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), content);

        return vscode.workspace.applyEdit(edit);
    }
}
