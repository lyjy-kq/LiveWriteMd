/**
 * LiveWriteMD Extension Entry Point
 *
 * This module is the main entry point for the LiveWriteMD VS Code extension.
 * It handles extension activation, registration of the CustomTextEditorProvider,
 * and command registration.
 *
 * @module extension/index
 *
 * Design References:
 * - DES-F-002: Extension-side file responsibilities
 * - DES-A-002: Extension-Webview communication architecture
 * - DES-A-008: Log output design
 *
 * Requirements:
 * - REQ-F-001: CustomTextEditorProvider implementation
 * - REQ-F-007: Editor startup methods
 */

import * as vscode from 'vscode';

import { LiveWriteMdEditorProvider, VIEW_TYPE } from './editor/editorProvider.js';
import { Logger } from './logger.js';
import { BUILD_STAMP } from '../shared/buildStamp.js';
import { ConfigManager } from './editor/configManager.js';
import { exportMarkdownAsHtml } from './export/htmlExporter.js';
import { exportMarkdownAsPdf } from './export/pdfExporter.js';

// =============================================================================
// Constants
// =============================================================================

/**
 * Command identifier for opening files with LiveWriteMD.
 * Must match the command in package.json contributes.commands.
 */
const COMMAND_OPEN_WITH = 'liveWriteMd.openWith';
const COMMAND_ENTER_VIEWER = 'liveWriteMd.enterViewerMode';
const COMMAND_EXIT_VIEWER = 'liveWriteMd.exitViewerMode';
const COMMAND_ENTER_SOURCE = 'liveWriteMd.enterSourceMode';
const COMMAND_ENTER_LIVE = 'liveWriteMd.enterLiveMode';
const COMMAND_ENTER_MINDMAP = 'liveWriteMd.enterMindmapMode';
const COMMAND_ENTER_SLIDES = 'liveWriteMd.enterSlidesMode';
const COMMAND_CYCLE_EDITOR_MODE = 'liveWriteMd.cycleEditorMode';
const COMMAND_TOGGLE_MINDMAP_MODE = 'liveWriteMd.toggleMindmapMode';
const COMMAND_TOGGLE_SLIDES_MODE = 'liveWriteMd.toggleSlidesMode';
const COMMAND_EXPORT_HTML = 'liveWriteMd.exportAsHtml';
const COMMAND_EXPORT_PDF = 'liveWriteMd.exportAsPdf';
const COMMAND_TOGGLE_OUTLINE = 'liveWriteMd.toggleOutline';
const COMMAND_INSERT_IMAGE = 'liveWriteMd.insertImage';
const COMMAND_INSERT_IMAGE_FROM_EXPLORER = 'liveWriteMd.insertImageFromExplorer';

// =============================================================================
// Command Handlers
// =============================================================================

/**
 * Handler for the liveWriteMd.openWith command.
 * Opens a Markdown file with the LiveWriteMD editor.
 *
 * @param uri - Optional URI of the file to open
 */
async function openWithLiveWriteMd(uri?: vscode.Uri): Promise<void> {
    try {
        // If no URI provided, prompt user to select a file
        if (!uri) {
            const fileUris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    // eslint-disable-next-line @typescript-eslint/naming-convention
                    'Markdown files': ['md', 'markdown'],
                },
            });

            if (!fileUris || fileUris.length === 0) {
                return;
            }
            uri = fileUris[0];
        }

        Logger.info(`Opening with LiveWriteMD: ${uri.fsPath}`);

        // Open the file with LiveWriteMD custom editor
        await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        Logger.error(
            `Failed to open file with LiveWriteMD: ${errorMessage}`,
            error instanceof Error ? error : undefined
        );
        await vscode.window.showErrorMessage(`LiveWriteMD: Failed to open file: ${errorMessage}`);
    }
}

// =============================================================================
// Extension Lifecycle
// =============================================================================

/**
 * Activates the LiveWriteMD extension.
 * Called when the extension is activated (e.g., when a .md file is opened with LiveWriteMD).
 *
 * @param context - The extension context provided by VS Code
 *
 * Design References:
 * - DES-F-002: Extension entry point responsibilities
 * - DES-A-002: Extension-Webview communication setup
 * - DES-A-008: Log output design
 * - DES-A-009: Configuration management design
 *
 * Requirements:
 * - REQ-F-001: Register CustomTextEditorProvider
 * - REQ-F-007: Register commands for editor startup
 */
export function activate(context: vscode.ExtensionContext): void {
    // Initialize Logger (creates VS Code Output Channel "LiveWriteMD")
    Logger.initialize();

    // Check debug log configuration from ConfigManager
    const isDebugEnabled = ConfigManager.isDebugLogEnabled();
    if (isDebugEnabled) {
        const logFilePath = Logger.enableFileLogging();
        Logger.debug('Debug logging is enabled');
        Logger.info(`Debug log file: ${logFilePath}`);
    }

    Logger.info('LiveWriteMD Extension activating...');
    // 构建戳：排查扩展宿主跑的是不是最新包（与 webview 侧各一行，见 buildStamp.ts）
    Logger.info(`[build] extension ${BUILD_STAMP}`);

    // 设置键重命名 / 功能提升为全局时的旧值迁移（例如 mindmapPerfMonitor
    // → perfMonitor）。异步写入，不阻塞激活；写完后 VS Code 会广播设置变化。
    void ConfigManager.migrateLegacySettings();

    // Register the CustomTextEditorProvider
    const provider = new LiveWriteMdEditorProvider(context);
    const providerRegistration = vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
        // WebviewPanelOptions
        webviewOptions: {
            retainContextWhenHidden: true,
        },
        // Only allow one editor per document
        supportsMultipleEditorsPerDocument: false,
    });
    context.subscriptions.push(providerRegistration);
    Logger.info(`Registered CustomTextEditorProvider for viewType: ${VIEW_TYPE}`);

    // Register the openWith command
    const openWithCommand = vscode.commands.registerCommand(COMMAND_OPEN_WITH, openWithLiveWriteMd);
    context.subscriptions.push(openWithCommand);
    Logger.debug(`Registered command: ${COMMAND_OPEN_WITH}`);

    // Register editor mode commands (cycle: live → viewer → source → live)
    const enterViewerCommand = vscode.commands.registerCommand(COMMAND_ENTER_VIEWER, () =>
        provider.setEditorMode('viewer')
    );
    context.subscriptions.push(enterViewerCommand);

    const exitViewerCommand = vscode.commands.registerCommand(COMMAND_EXIT_VIEWER, () =>
        provider.setEditorMode('live')
    );
    context.subscriptions.push(exitViewerCommand);

    const enterSourceCommand = vscode.commands.registerCommand(COMMAND_ENTER_SOURCE, () =>
        provider.setEditorMode('source')
    );
    context.subscriptions.push(enterSourceCommand);

    const enterLiveCommand = vscode.commands.registerCommand(COMMAND_ENTER_LIVE, () =>
        provider.setEditorMode('live')
    );
    context.subscriptions.push(enterLiveCommand);

    const enterMindmapCommand = vscode.commands.registerCommand(COMMAND_ENTER_MINDMAP, () =>
        provider.setEditorMode('mindmap')
    );
    context.subscriptions.push(enterMindmapCommand);

    const enterSlidesCommand = vscode.commands.registerCommand(COMMAND_ENTER_SLIDES, () =>
        provider.setEditorMode('slides')
    );
    context.subscriptions.push(enterSlidesCommand);

    // 标题栏「单按钮循环」形态：live -> viewer -> source -> slides -> mindmap -> live
    const cycleEditorModeCommand = vscode.commands.registerCommand(
        COMMAND_CYCLE_EDITOR_MODE,
        () => provider.cycleEditorMode()
    );
    context.subscriptions.push(cycleEditorModeCommand);

    // 标题栏按钮 A：实时 ⇄ 导图互切
    const toggleMindmapModeCommand = vscode.commands.registerCommand(
        COMMAND_TOGGLE_MINDMAP_MODE,
        () => provider.toggleMindmapMode()
    );
    context.subscriptions.push(toggleMindmapModeCommand);

    // 标题栏按钮：幻灯片 ⇄ 实时
    const toggleSlidesModeCommand = vscode.commands.registerCommand(
        COMMAND_TOGGLE_SLIDES_MODE,
        () => provider.toggleSlidesMode()
    );
    context.subscriptions.push(toggleSlidesModeCommand);

    Logger.debug('Registered editor mode commands');

    // Register noop command to prevent VS Code's undo/redo from conflicting with CM6's history
    context.subscriptions.push(
        vscode.commands.registerCommand('liveWriteMd.noop', () => {
            /* intentionally empty */
        })
    );

    // Register HTML export command
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMAND_EXPORT_HTML, exportMarkdownAsHtml)
    );
    Logger.debug(`Registered command: ${COMMAND_EXPORT_HTML}`);

    // Register PDF export command
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMAND_EXPORT_PDF, exportMarkdownAsPdf)
    );
    Logger.debug(`Registered command: ${COMMAND_EXPORT_PDF}`);

    // Register outline toggle command (editor title bar button + command palette)
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMAND_TOGGLE_OUTLINE, () => provider.toggleOutline())
    );
    Logger.debug(`Registered command: ${COMMAND_TOGGLE_OUTLINE}`);

    // Register insert image command (alternative to drag & drop)
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMAND_INSERT_IMAGE, () => provider.insertImage())
    );
    Logger.debug(`Registered command: ${COMMAND_INSERT_IMAGE}`);

    // Register open-settings command (LiveWriteMD 设置)
    context.subscriptions.push(
        vscode.commands.registerCommand('liveWriteMd.openSettings', () => provider.openSettings())
    );
    Logger.debug('Registered command: liveWriteMd.openSettings');

    // Register memory-usage report command（排查「大文件占内存」类问题用：
    // webview 堆 / DOM / 导图实例 / 各缓存计数 + 扩展宿主 RSS）
    context.subscriptions.push(
        vscode.commands.registerCommand('liveWriteMd.showMemoryUsage', () =>
            provider.showMemoryUsage()
        )
    );
    Logger.debug('Registered command: liveWriteMd.showMemoryUsage');

    // Register insert image from Explorer context menu
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMAND_INSERT_IMAGE_FROM_EXPLORER, (uri: vscode.Uri) => {
            if (uri) {
                provider.insertImageFromExplorer(uri);
            }
        })
    );
    Logger.debug(`Registered command: ${COMMAND_INSERT_IMAGE_FROM_EXPLORER}`);

    Logger.info('LiveWriteMD Extension activated successfully');
}

/**
 * Deactivates the LiveWriteMD extension.
 * Called when the extension is deactivated (e.g., when VS Code is closed).
 * Cleanup is handled automatically via context.subscriptions.
 *
 * Design References:
 * - DES-A-008: Log output design (Logger cleanup)
 */
export function deactivate(): void {
    Logger.info('LiveWriteMD Extension deactivating...');

    // Cleanup Logger resources
    Logger.dispose();

    // Cleanup is handled automatically by VS Code disposing of items
    // in context.subscriptions
}
