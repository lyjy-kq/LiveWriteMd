/**
 * FlowMD Extension Entry Point
 *
 * This module is the main entry point for the FlowMD VS Code extension.
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

import { FlowMdEditorProvider, VIEW_TYPE } from './editorProvider.js';
import { Logger } from './logger.js';
import { ConfigManager } from './configManager.js';
import { exportMarkdownAsHtml } from './htmlExporter.js';
import { exportMarkdownAsPdf } from './pdfExporter.js';

// =============================================================================
// Constants
// =============================================================================

/**
 * Command identifier for opening files with FlowMD.
 * Must match the command in package.json contributes.commands.
 */
const COMMAND_OPEN_WITH = 'flowMd.openWith';
const COMMAND_ENTER_VIEWER = 'flowMd.enterViewerMode';
const COMMAND_EXIT_VIEWER = 'flowMd.exitViewerMode';
const COMMAND_ENTER_SOURCE = 'flowMd.enterSourceMode';
const COMMAND_ENTER_LIVE = 'flowMd.enterLiveMode';
const COMMAND_EXPORT_HTML = 'flowMd.exportAsHtml';
const COMMAND_EXPORT_PDF = 'flowMd.exportAsPdf';
const COMMAND_TOGGLE_OUTLINE = 'flowMd.toggleOutline';
const COMMAND_INSERT_IMAGE = 'flowMd.insertImage';
const COMMAND_INSERT_IMAGE_FROM_EXPLORER = 'flowMd.insertImageFromExplorer';

// =============================================================================
// Command Handlers
// =============================================================================

/**
 * Handler for the flowMd.openWith command.
 * Opens a Markdown file with the FlowMD editor.
 *
 * @param uri - Optional URI of the file to open
 */
async function openWithFlowMd(uri?: vscode.Uri): Promise<void> {
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

        Logger.info(`Opening with FlowMD: ${uri.fsPath}`);

        // Open the file with FlowMD custom editor
        await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        Logger.error(
            `Failed to open file with FlowMD: ${errorMessage}`,
            error instanceof Error ? error : undefined
        );
        await vscode.window.showErrorMessage(`FlowMD: Failed to open file: ${errorMessage}`);
    }
}

// =============================================================================
// Extension Lifecycle
// =============================================================================

/**
 * Activates the FlowMD extension.
 * Called when the extension is activated (e.g., when a .md file is opened with FlowMD).
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
    // Initialize Logger (creates VS Code Output Channel "FlowMD")
    Logger.initialize();

    // Check debug log configuration from ConfigManager
    const isDebugEnabled = ConfigManager.isDebugLogEnabled();
    if (isDebugEnabled) {
        const logFilePath = Logger.enableFileLogging();
        Logger.debug('Debug logging is enabled');
        Logger.info(`Debug log file: ${logFilePath}`);
    }

    Logger.info('FlowMD Extension activating...');

    // Register the CustomTextEditorProvider
    const provider = new FlowMdEditorProvider(context);
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
    const openWithCommand = vscode.commands.registerCommand(COMMAND_OPEN_WITH, openWithFlowMd);
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
    Logger.debug('Registered editor mode commands');

    // Register noop command to prevent VS Code's undo/redo from conflicting with CM6's history
    context.subscriptions.push(
        vscode.commands.registerCommand('flowMd.noop', () => {
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

    // Register insert image from Explorer context menu
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMAND_INSERT_IMAGE_FROM_EXPLORER, (uri: vscode.Uri) => {
            if (uri) {
                provider.insertImageFromExplorer(uri);
            }
        })
    );
    Logger.debug(`Registered command: ${COMMAND_INSERT_IMAGE_FROM_EXPLORER}`);

    Logger.info('FlowMD Extension activated successfully');
}

/**
 * Deactivates the FlowMD extension.
 * Called when the extension is deactivated (e.g., when VS Code is closed).
 * Cleanup is handled automatically via context.subscriptions.
 *
 * Design References:
 * - DES-A-008: Log output design (Logger cleanup)
 */
export function deactivate(): void {
    Logger.info('FlowMD Extension deactivating...');

    // Cleanup Logger resources
    Logger.dispose();

    // Cleanup is handled automatically by VS Code disposing of items
    // in context.subscriptions
}
