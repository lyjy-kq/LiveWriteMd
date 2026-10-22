/**
 * 导图导出文件的保存助手（迭代 N3）。
 *
 * webview 侧用自研画布把导图序列化成 PNG dataURL / SVG 文本 / PDF dataURL，
 * 经 postMessage 发到这里，统一弹保存对话框并写盘
 * （主编辑器 webview 与导图面板 webview 共用）。
 */

import * as vscode from 'vscode';
import { Logger } from './logger';

/** webview 发来的导图导出载荷。 */
export interface MindmapExportPayload {
    /** 导出格式。 */
    format: 'png' | 'svg' | 'pdf';
    /** 默认文件名（不含扩展名）。 */
    name: string;
    /** 位图类格式（png/pdf）的 dataURL。 */
    dataUrl?: string;
    /** SVG 文本（format=svg 时）。 */
    svgText?: string;
}

/**
 * 弹保存对话框并把导出内容写盘；用户取消时静默返回。
 */
export async function saveMindmapExport(payload: MindmapExportPayload): Promise<void> {
    const ext = payload.format;
    const filters: Record<string, string[]> =
        ext === 'svg' ? { SVG: ['svg'] } : ext === 'pdf' ? { PDF: ['pdf'] } : { PNG: ['png'] };
    try {
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`${payload.name || 'mindmap'}.${ext}`),
            filters,
        });
        if (!uri) return;
        if (payload.svgText !== undefined) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(payload.svgText, 'utf8'));
        } else if (payload.dataUrl) {
            // dataURL → base64 → 二进制
            const base64 = payload.dataUrl.split(',')[1] ?? '';
            await vscode.workspace.fs.writeFile(uri, Buffer.from(base64, 'base64'));
        } else {
            vscode.window.showErrorMessage('导图导出失败：导出内容为空');
            return;
        }
        Logger.info(`Mind map exported: ${uri.fsPath}`);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`Mind map export failed: ${message}`);
        vscode.window.showErrorMessage(`导图导出失败：${message}`);
    }
}
