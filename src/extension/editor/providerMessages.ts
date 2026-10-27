/**
 * Webview → 扩展的消息分发（从 editorProvider.ts 拆出）。
 *
 * handleWebviewMessage 是 resolveCustomTextEditor 里 onDidReceiveMessage
 * 的唯一去处：每个 case 对应一种 webview 消息。拆成自由函数后第一个参数
 * 是 provider 实例（需要它的 context / editorModeMap / 命令包装）。
 *
 * @module extension/editor/providerMessages
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
    EditorMode,
} from '../../shared/types.js';
import { MESSAGE_TYPES } from '../../shared/messageTypes.js';
import { Logger } from '../logger.js';
import { ConfigManager } from './configManager.js';
import { exportMarkdownAsHtml } from '../export/htmlExporter.js';
import { exportMarkdownAsPdf } from '../export/pdfExporter.js';
import { handleSaveImage } from '../assets/imageSaveHandler.js';
import { saveMindmapExport } from '../export/mindmapExport.js';
import { resolveFileLinkTarget } from '../assets/fileLinkResolver.js';
import { getSavedSearchHistory, saveSearchHistory } from '../searchHistoryStore.js';
import { getThemeType } from './themeType.js';
import type { LiveWriteMdEditorProvider } from './editorProvider.js';

/**
 * 澶х翰闈㈡澘瀹藉害鍦ㄦ墿灞曞叏灞€瀛樺偍涓殑閿悕銆? * 鐢ㄤ簬鍦?VS Code 閲嶅惎鍚庢仮澶嶇敤鎴蜂笂涓€娆¤皟鏁寸殑瀹藉害銆? */
const OUTLINE_PANEL_WIDTH_STORAGE_KEY = 'liveWriteMd.outlineWidth';

/**
 * 澶х翰闈㈡澘瀹藉害鐨勯粯璁ゅ€笺€? * 褰撳瓨鍌ㄧ己澶辨垨鍊奸潪娉曟椂浣跨敤銆? */
const DEFAULT_OUTLINE_PANEL_WIDTH = 280;

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
export function getSavedOutlinePanelWidth(context: vscode.ExtensionContext): number {
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

/**
 * Handle messages received from the webview.
 *
 * @param message - The message from the webview
 * @param document - The text document
 * @param webviewPanel - The webview panel
 * @param state - State management callbacks
 */
export async function handleWebviewMessage(
    provider: LiveWriteMdEditorProvider,
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
            const outlineWidth = getSavedOutlinePanelWidth(provider.context);
            const searchHistory = getSavedSearchHistory(provider.context);

            // initialMode 是 resolveCustomTextEditor 内的局部变量，本方法作用域取不到；
            // 面板创建时已把初始模式写入 editorModeMap，缺失时回落到默认模式。
            const initialMode =
                (provider.editorModeMap.get(document.uri.toString()) as EditorMode | undefined) ??
                ConfigManager.getDefaultMode();

            const initDelivered = await webviewPanel.webview.postMessage({
                type: MESSAGE_TYPES.INIT,
                content: initContent,
                theme: getThemeType(),
                documentUri: document.uri.toString(),
                documentBaseUri: docDirWebviewUri,
                searchHistory,
                settings: ConfigManager.getEditorSettings(),
                allSettings: ConfigManager.getAllSettings(),
                mode: initialMode,
                outlineWidth,
            });
            Logger.info(
                `INIT postMessage completed: delivered=${initDelivered}, mode=${initialMode}, documentBaseUri=${docDirWebviewUri}`
            );
            // 字体列表不阻塞 INIT；枚举完成后单独补一条消息，面板打开时就有数据
            provider.sendSystemFonts(webviewPanel);
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
                const success = await provider.updateTextDocument(document, message.content);
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
            await vscode.window.showErrorMessage(`LiveWriteMD: ${message.message}`);
            break;

        // 处理来自 Webview 的搜索/替换历史变更消息。
        case MESSAGE_TYPES.SEARCH_HISTORY_CHANGE as typeof MESSAGE_TYPES.READY: {
            const historyMsg = message as SearchHistoryChangeMessage;
            await saveSearchHistory(provider.context, historyMsg.history);
            Logger.debug('Search history saved to workspace state');
            break;
        }

        // 处理来自 Webview 的大纲面板宽度更新消息。
        case MESSAGE_TYPES.OUTLINE_WIDTH_CHANGE as typeof MESSAGE_TYPES.READY: {
            const outlineMsg = message as OutlineWidthChangeMessage;
            const width = normalizeOutlinePanelWidth(outlineMsg.width);
            await provider.context.workspaceState.update(OUTLINE_PANEL_WIDTH_STORAGE_KEY, width);
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
                .getConfiguration('liveWriteMd')
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

        // 导图导出（迭代 N3）：webview 渲染好的 PNG/SVG/PDF 存盘
        case 'saveMindmapExport' as typeof MESSAGE_TYPES.READY: {
            await saveMindmapExport(
                message as unknown as Parameters<typeof saveMindmapExport>[0]
            );
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
                await provider.insertImage();
            } else if (actionMsg.action === 'downloadRemoteImages') {
                await provider.downloadRemoteImages(document);
            } else if (actionMsg.action === 'exportAsHtml') {
                await exportMarkdownAsHtml(document.uri);
            } else if (actionMsg.action === 'exportAsPdf') {
                await exportMarkdownAsPdf(document.uri);
            } else if (actionMsg.action === 'setMode' && actionMsg.mode) {
                provider.setEditorMode(actionMsg.mode);
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

        // Webview 回发的内存占用统计（「显示内存占用」命令的应答）
        case 'memoryStatsReport' as typeof MESSAGE_TYPES.READY: {
            const report = message as unknown as { stats: Record<string, unknown> };
            void provider.presentMemoryStats(report.stats);
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
