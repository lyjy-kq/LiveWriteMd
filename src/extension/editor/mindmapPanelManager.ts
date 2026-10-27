/**
 * 独立导图面板管理器（设计文档 §3.2）。
 *
 * 职责：
 * - 每个 Markdown 文档最多一个 WebviewPanel（重复执行命令直接 reveal）；
 * - 面板与 customEditor 共享 INIT / UPDATE / CONTENT_CHANGE 协议；
 * - 面板回写 = 整篇 WorkspaceEdit.replace；customEditor 打开着时，
 *   editorProvider 的 onDidChangeTextDocument 会自然收到变更并推给编辑器 webview；
 * - 外部（文本编辑器 / customEditor）改动通过 onDidChangeTextDocument 广播给面板；
 * - 面板自身触发的变更用 lastIncomingContent 做等值防环（与 editorProvider 同款思路）。
 *
 * @module extension/mindmapPanelManager
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { MESSAGE_TYPES } from '../../shared/messageTypes.js';
import { ConfigManager } from './configManager.js';
import { getMindmapPanelHtml } from './webviewContent.js';
import { getThemeType } from './editorProvider.js';
import { saveMindmapExport } from '../export/mindmapExport.js';
import { Logger } from '../logger.js';

/** 面板 viewType（普通 WebviewPanel，无需在 package.json 注册）。 */
const PANEL_VIEW_TYPE = 'liveWriteMd.mindmapPanel';

/** 单个面板的运行时状态。 */
interface PanelEntry {
    /** WebviewPanel 实例。 */
    panel: vscode.WebviewPanel;
    /** 面板对应的文档 uri。 */
    uri: vscode.Uri;
    /** 面板最近上报的全文；文档变化与之相同则不回推 UPDATE（防环）。 */
    lastIncomingContent: string | null;
}

/** 面板发来的消息（按本管理器关心的字段宽松声明）。 */
interface PanelIncomingMessage {
    type?: string;
    content?: string;
    message?: string;
    stack?: string;
}

/**
 * 按文档维护独立导图面板。
 */
export class MindmapPanelManager implements vscode.Disposable {
    /** docUri.toString() -> 面板条目。 */
    private readonly entries = new Map<string, PanelEntry>();

    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly context: vscode.ExtensionContext) {
        // 文档变化：广播 UPDATE 给对应面板（跳过面板自身回写引起的变化）
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument((event) => {
                if (event.contentChanges.length === 0) return;
                this.broadcastUpdate(event.document);
            })
        );
        // 设置变化：重发完整设置；theme 覆盖项变化时再补发一次主题
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (!event.affectsConfiguration('liveWriteMd')) return;
                this.broadcastSettings();
                if (event.affectsConfiguration('liveWriteMd.theme')) {
                    this.broadcastTheme();
                }
            })
        );
        // VS Code 明暗主题切换
        this.disposables.push(
            vscode.window.onDidChangeActiveColorTheme(() => this.broadcastTheme())
        );
    }

    /**
     * 释放订阅并关闭全部面板。
     */
    public dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables.length = 0;
        for (const entry of this.entries.values()) {
            entry.panel.dispose();
        }
        this.entries.clear();
    }

    /**
     * 打开（或激活）指定文档的导图面板。
     *
     * @param uri Markdown 文档 uri
     */
    public async open(uri: vscode.Uri): Promise<void> {
        const key = uri.toString();
        const existing = this.entries.get(key);
        if (existing) {
            existing.panel.reveal(vscode.ViewColumn.Beside);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            PANEL_VIEW_TYPE,
            `${path.basename(uri.fsPath)}（导图）`,
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
                    vscode.Uri.file(path.dirname(uri.fsPath)),
                ],
            }
        );
        panel.webview.html = getMindmapPanelHtml(panel.webview, this.context.extensionUri);

        const entry: PanelEntry = { panel, uri, lastIncomingContent: null };
        this.entries.set(key, entry);
        panel.onDidDispose(() => {
            if (this.entries.get(key) === entry) {
                this.entries.delete(key);
            }
        });
        panel.webview.onDidReceiveMessage((message: PanelIncomingMessage) => {
            void this.handleMessage(entry, message);
        });
        Logger.info(`Mindmap panel opened for: ${uri.fsPath}`);
    }

    /**
     * 处理面板 webview 发来的消息。
     *
     * @param entry 面板条目
     * @param message 消息内容
     */
    private async handleMessage(
        entry: PanelEntry,
        message: PanelIncomingMessage
    ): Promise<void> {
        if (!message?.type) return;
        switch (message.type) {
            case MESSAGE_TYPES.READY: {
                // READY 时现读文档，确保拿到的是最新内容（面板 HTML 早于脚本就绪）
                let content = '';
                try {
                    const document = await vscode.workspace.openTextDocument(entry.uri);
                    content = document.getText();
                } catch (error) {
                    Logger.error(
                        `Mindmap panel failed to read document: ${entry.uri.fsPath}`,
                        error instanceof Error ? error : new Error(String(error))
                    );
                }
                void entry.panel.webview.postMessage({
                    type: MESSAGE_TYPES.INIT,
                    content,
                    theme: getThemeType(),
                    documentUri: entry.uri.toString(),
                    allSettings: ConfigManager.getAllSettings(),
                });
                break;
            }

            case MESSAGE_TYPES.CONTENT_CHANGE: {
                if (typeof message.content !== 'string') return;
                // 先记账再 applyEdit：随后的 onDidChangeTextDocument 据此跳过回推
                entry.lastIncomingContent = message.content;
                try {
                    const document = await vscode.workspace.openTextDocument(entry.uri);
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(
                        document.uri,
                        new vscode.Range(0, 0, document.lineCount, 0),
                        message.content
                    );
                    await vscode.workspace.applyEdit(edit);
                } catch (error) {
                    Logger.error(
                        `Mindmap panel writeback failed: ${entry.uri.fsPath}`,
                        error instanceof Error ? error : new Error(String(error))
                    );
                    await vscode.window.showErrorMessage(
                        'LiveWriteMD: 导图编辑写回文档失败，请重试。'
                    );
                }
                break;
            }

            // 面板导图撤销/重做（迭代 N8）：面板没有 CM 撤销栈，
            // 用文档自己的编辑器执行 undo/redo；preserveFocus 让焦点留在面板
            case 'mindmapUndoRedo' as typeof MESSAGE_TYPES.READY: {
                const kind = (message as unknown as { kind?: string }).kind;
                if (kind !== 'undo' && kind !== 'redo') return;
                try {
                    const document = await vscode.workspace.openTextDocument(entry.uri);
                    await vscode.window.showTextDocument(document, {
                        preserveFocus: true,
                        preview: false,
                    });
                    await vscode.commands.executeCommand(kind);
                } catch (error) {
                    Logger.error(
                        `Mindmap panel ${kind} failed: ${entry.uri.fsPath}`,
                        error instanceof Error ? error : new Error(String(error))
                    );
                }
                break;
            }

            // 导图导出（迭代 N3）：面板 webview 渲染好的 PNG/SVG/PDF 存盘
            case 'saveMindmapExport' as typeof MESSAGE_TYPES.READY: {
                await saveMindmapExport(
                    message as unknown as Parameters<typeof saveMindmapExport>[0]
                );
                break;
            }

            case MESSAGE_TYPES.ERROR: {
                if (message.message) {
                    Logger.error(
                        `[MindmapPanel] ${message.message}`,
                        new Error(message.stack ?? message.message)
                    );
                    await vscode.window.showErrorMessage(`LiveWriteMD: ${message.message}`);
                }
                break;
            }

            default:
                break;
        }
    }

    /**
     * 文档变化时向对应面板广播 UPDATE（面板自身回写引发的变化跳过）。
     *
     * @param document 发生变化的文本文档
     */
    private broadcastUpdate(document: vscode.TextDocument): void {
        const entry = this.entries.get(document.uri.toString());
        if (!entry) return;
        const content = document.getText();
        if (entry.lastIncomingContent !== null && content === entry.lastIncomingContent) {
            return;
        }
        void entry.panel.webview.postMessage({ type: MESSAGE_TYPES.UPDATE, content });
    }

    /** 向所有面板广播最新设置。 */
    private broadcastSettings(): void {
        for (const entry of this.entries.values()) {
            void entry.panel.webview.postMessage({
                type: MESSAGE_TYPES.SETTINGS_CHANGE,
                settings: ConfigManager.getEditorSettings(),
                allSettings: ConfigManager.getAllSettings(),
            });
        }
    }

    /** 向所有面板广播明暗主题变化。 */
    private broadcastTheme(): void {
        const theme = getThemeType();
        for (const entry of this.entries.values()) {
            void entry.panel.webview.postMessage({ type: MESSAGE_TYPES.THEME_CHANGE, theme });
        }
    }
}