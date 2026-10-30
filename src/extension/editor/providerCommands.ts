/**
 * LiveWriteMdEditorProvider 的命令方法（从 editorProvider.ts 拆出）。
 *
 * 全部是「对当前激活面板发消息 / 弹窗 / 读写配置」的公开命令实现，
 * 第一个参数统一是 provider 实例；editorProvider.ts 里的类只留
 * 同名薄包装，保证 index.ts 的命令注册代码不变。
 *
 * @module extension/editor/providerCommands
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { EditorMode } from '../../shared/types.js';
import { MESSAGE_TYPES } from '../../shared/messageTypes.js';
import { Logger } from '../logger.js';
import { ConfigManager } from './configManager.js';
import { downloadRemoteImagesToAssets } from '../assets/remoteImageDownloadHandler.js';
import { getSystemFonts } from '../systemFonts.js';
import type { LiveWriteMdEditorProvider } from './editorProvider.js';

/**
 * 「记住每个文件的模式」在 globalState 中的键前缀，后接文档 uri.toString()。
 * 开启 rememberLastMode 后，打开文档优先恢复这里记录的上次模式。
 */
export const EDITOR_MODE_STORAGE_PREFIX = 'liveWriteMd.editorMode.';

/**
 * Sets the editor mode for the active LiveWriteMD editor.
 * Cycles through: live 鈫?viewer 鈫?source 鈫?live
 *
 * @param mode - The target mode ('live' | 'viewer' | 'source' | 'mindmap')
 */
export function setEditorMode(provider: LiveWriteMdEditorProvider, mode: EditorMode): void  {
    if (!provider.activePanelInfo) return;
    const { panel, docUri } = provider.activePanelInfo;
    provider.editorModeMap.set(docUri, mode);

    // rememberLastMode：把该文档的模式写入 globalState，下次打开优先恢复
    if (ConfigManager.getRememberLastMode()) {
        void provider.context.globalState.update(EDITOR_MODE_STORAGE_PREFIX + docUri, mode);
    }

    panel.webview.postMessage({
        type: MESSAGE_TYPES.EDITOR_MODE,
        mode,
    });

    vscode.commands.executeCommand('setContext', 'liveWriteMd.editorMode', mode);
    Logger.info(`Editor mode set to '${mode}' for: ${docUri}`);
}

/**
 * 标题栏单按钮循环切换：live -> viewer -> source -> mindmap -> live。
 *
 * @returns void
 */
export function cycleEditorMode(provider: LiveWriteMdEditorProvider): void  {
    if (!provider.activePanelInfo) return;
    const order: EditorMode[] = ['live', 'viewer', 'source', 'mindmap'];
    const current = (provider.editorModeMap.get(provider.activePanelInfo.docUri) ??
        'live') as EditorMode;
    const next = order[(order.indexOf(current) + 1) % order.length];
    provider.setEditorMode(next);
}

/**
 * 标题栏按钮 A：实时模式 ⇄ 导图模式互切。
 *
 * 导图模式下点击返回实时模式；其余任何文本模式（live/viewer/source）
 * 下点击进入导图模式。
 *
 * @returns void
 */
export function toggleMindmapMode(provider: LiveWriteMdEditorProvider): void  {
    if (!provider.activePanelInfo) return;
    const current = (provider.editorModeMap.get(provider.activePanelInfo.docUri) ??
        'live') as EditorMode;
    provider.setEditorMode(current === 'mindmap' ? 'live' : 'mindmap');
}

/**
 * 标题栏按钮 B：文本模式三态循环 live -> viewer -> source -> live。
 *
 * 导图模式下不可用（package.json 里用 when 子句禁用），这里仍兜底：
 * 处于导图模式时不动。
 *
 * @returns void
 */
export function cycleTextMode(provider: LiveWriteMdEditorProvider): void  {
    if (!provider.activePanelInfo) return;
    const order: EditorMode[] = ['live', 'viewer', 'source'];
    const current = (provider.editorModeMap.get(provider.activePanelInfo.docUri) ??
        'live') as EditorMode;
    if (current === 'mindmap') return;
    const next = order[(order.indexOf(current) + 1) % order.length];
    provider.setEditorMode(next);
}

/**
 * 获取当前激活的 LiveWriteMD 文档 uri（独立导图面板命令复用）。
 *
 * @returns 文档 uri；没有激活的 LiveWriteMD 编辑器时返回 null
 */
export function getActiveDocumentUri(provider: LiveWriteMdEditorProvider): vscode.Uri | null  {
    if (!provider.activePanelInfo) return null;
    try {
        return vscode.Uri.parse(provider.activePanelInfo.docUri);
    } catch {
        return null;
    }
}

/**
 * 切换当前文档右侧大纲面板的显示状态。
 *
 * 可见性由 Webview 侧持有，这里只负责把切换意图转发过去，避免两边各存一份
 * 状态造成不一致。
 *
 * @returns void
 */
export function toggleOutline(provider: LiveWriteMdEditorProvider): void  {
    if (!provider.activePanelInfo) {
        vscode.window.showWarningMessage('LiveWriteMD: 请在 LiveWriteMD 编辑器中切换大纲。');
        return;
    }

    const { panel, docUri } = provider.activePanelInfo;
    panel.webview.postMessage({ type: MESSAGE_TYPES.OUTLINE_TOGGLE });
    Logger.info(`Outline toggled for: ${docUri}`);
}

/**
 * 「显示内存占用」命令：让当前编辑器的 webview 收集统计并回发。
 * 结果在 handleWebviewMessage 的 memoryStatsReport 分支展示。
 */
export function showMemoryUsage(provider: LiveWriteMdEditorProvider): void  {
    if (!provider.activePanelInfo) {
        vscode.window.showWarningMessage('LiveWriteMD: 请先聚焦一个 LiveWriteMD 编辑器。');
        return;
    }
    provider.activePanelInfo.panel.webview.postMessage({
        type: MESSAGE_TYPES.COLLECT_MEMORY_STATS,
    });
}

/**
 * 展示 webview 回发的内存统计（summary 弹窗 + 完整明细进日志，可复制）。
 *
 * 顺带把扩展宿主自己的 RSS 加进去：webview 堆只是占用的一部分，
 * 任务管理器里看到的进程内存大头往往在扩展宿主一侧。
 */
export async function presentMemoryStats(provider: LiveWriteMdEditorProvider, stats: Record<string, unknown>): Promise<void>  {
    const hostMB = Math.round(process.memoryUsage().rss / 1048576);
    const caches = (stats.caches ?? {}) as Record<string, number>;
    const map = (stats.map ?? null) as Record<string, unknown> | null;
    const cacheLine = Object.entries(caches)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
    const lines = [
        `文档: ${stats.docKB} KB / ${stats.docLines} 行（模式: ${stats.mode}）`,
        `Webview JS 堆: ${stats.heapUsedMB} MB / 已分配上限 ${stats.heapTotalMB} MB`,
        `DOM 节点: ${stats.domNodes}`,
        map
            ? `导图: 节点 ${map.nodes} / 已挂载 ${map.mounted} / 显示实例 ${map.displays} / 连线 ${map.links}`
            : '导图: 未激活',
        `缓存: ${cacheLine}`,
        `扩展宿主 RSS: ${hostMB} MB`,
    ];
    const detail = lines.join('\n');
    Logger.info(`内存占用统计:\n${detail}`);
    const copy = '复制详情';
    const choice = await vscode.window.showInformationMessage(
        `LiveWriteMD: webview 堆 ${stats.heapUsedMB} MB · DOM ${stats.domNodes} · ` +
            `扩展宿主 ${hostMB} MB`,
        copy
    );
    if (choice === copy) {
        await vscode.env.clipboard.writeText(detail);
    }
}

/**
 * 打开当前 LiveWriteMD 编辑器内的设置面板。
 *
 * 面板 UI 在 Webview 侧，这里只发一个打开信号。
 */
export function openSettings(provider: LiveWriteMdEditorProvider): void  {
    if (!provider.activePanelInfo) {
        vscode.window.showWarningMessage('LiveWriteMD: 请先打开一个 LiveWriteMD 编辑器。');
        return;
    }
    const { panel, docUri } = provider.activePanelInfo;
    panel.webview.postMessage({ type: MESSAGE_TYPES.OPEN_SETTINGS });
    // 字体下拉需要完整系统字体列表；面板每次打开补发一次，防止
    // READY 时那次消息因为时序问题没赶上（枚举结果有缓存，不会重复扫描）。
    provider.sendSystemFonts(panel);
    Logger.info(`Settings panel opened for: ${docUri}`);
}

/**
 * 把本机字体列表发给 Webview 的设置面板。
 *
 * 枚举在扩展宿主做（webview 拿不到系统字体），失败时返回空数组，
 * 此时不发消息，面板继续用 schema 里的常用字体兜底。
 *
 * @param panel 目标 webview 面板
 */
export function sendSystemFonts(provider: LiveWriteMdEditorProvider, panel: vscode.WebviewPanel): void  {
    void getSystemFonts().then((fonts) => {
        if (fonts.length === 0) return;
        void panel.webview.postMessage({
            type: MESSAGE_TYPES.SYSTEM_FONTS,
            fonts,
        });
    });
}

/**
 * Insert an image via file picker dialog.
 * Alternative to drag & drop (which doesn't work in VS Code webviews).
 * Copies the selected image to the configured save folder and notifies the webview.
 */
export async function insertImage(provider: LiveWriteMdEditorProvider): Promise<void>  {
    if (!provider.activePanelInfo) return;
    const { panel, docUri } = provider.activePanelInfo;

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
            await import('../assets/imageSaveHandler.js');

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
        vscode.window.showErrorMessage(`LiveWriteMD: 图片插入失败：${errorMessage}`);
    }
}

/**
 * Insert an image from Explorer context menu.
 * Copies the image file to the configured save folder and notifies the webview.
 *
 * @param sourceUri - URI of the image file from Explorer
 */
export async function insertImageFromExplorer(provider: LiveWriteMdEditorProvider, sourceUri: vscode.Uri): Promise<void>  {
    if (!provider.activePanelInfo) {
        vscode.window.showWarningMessage(
            'LiveWriteMD: No active editor. Open a .md file with LiveWriteMD first.'
        );
        return;
    }
    const { panel, docUri } = provider.activePanelInfo;

    const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === docUri);
    if (!document) return;

    const fileName = path.basename(sourceUri.fsPath);
    const docDir = path.dirname(document.uri.fsPath);

    try {
        const { getValidatedSaveFolder, sanitizeFileName, getUniqueFileName } =
            await import('../assets/imageSaveHandler.js');

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
        vscode.window.showErrorMessage(`LiveWriteMD: 图片插入失败：${errorMessage}`);
    }
}

/**
 * Download remote images in the current Markdown document and rewrite links.
 *
 * @param document - Current Markdown text document
 * @returns Promise<void>
 */
export async function downloadRemoteImages(provider: LiveWriteMdEditorProvider, document: vscode.TextDocument): Promise<void>  {
    try {
        const originalContent = document.getText();
        const result = await downloadRemoteImagesToAssets(originalContent, document.uri);

        if (result.downloadedCount === 0) {
            await vscode.window.showInformationMessage('LiveWriteMD: 没有找到可下载的网络图片。');
            return;
        }

        const success = await provider.updateTextDocument(document, result.content);
        if (!success) {
            await vscode.window.showErrorMessage('LiveWriteMD: 图片下载成功，但正文回写失败。');
            return;
        }

        if (result.failedUrls.length > 0) {
            await vscode.window.showWarningMessage(
                `LiveWriteMD: 已下载 ${result.downloadedCount} 张网络图片，但有 ${result.failedUrls.length} 张失败。`
            );
            return;
        }

        await vscode.window.showInformationMessage(
            `LiveWriteMD: 已下载 ${result.downloadedCount} 张网络图片到 assets。`
        );
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        Logger.error(`Download remote images failed: ${errorMessage}`);
        await vscode.window.showErrorMessage(`LiveWriteMD: 下载网络图片失败：${errorMessage}`);
    }
}
