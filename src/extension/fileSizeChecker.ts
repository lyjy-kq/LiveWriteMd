/**
 * File Size Checker for LiveWriteMD
 *
 * This module provides functionality to check file sizes and warn users
 * when opening large files in the LiveWriteMD WYSIWYG editor. Large files
 * may cause performance issues in the Webview-based editor.
 *
 * File Size Categories (DES-P-002):
 * - Small files (<= 100KB): No warning, display within 2 seconds
 * - Medium files (100KB to threshold): Show info message, continue after acknowledgment
 * - Large files (> threshold): User choice (continue/standard editor/cancel)
 *
 * @module extension/fileSizeChecker
 *
 * Design Reference: DES-A-007, DES-P-002
 * Requirement: REQ-F-009, REQ-NF-001
 */

import * as vscode from 'vscode';
import { ConfigManager } from './configManager';
import { Logger } from './logger';

// =============================================================================
// Constants
// =============================================================================

/**
 * Small file threshold in bytes (100KB).
 * Files under this size will not trigger any warning.
 *
 * Design Reference: DES-P-002
 */
export const SMALL_FILE_THRESHOLD: number = 100 * 1024; // 100KB

// =============================================================================
// Types
// =============================================================================

/**
 * Result of file size check.
 *
 * Design Reference: DES-A-007
 *
 * @property shouldProceed - Whether to proceed with LiveWriteMD editor
 * @property fileSize - The file size in bytes
 * @property action - The action to take: 'proceed', 'standardEditor', or 'cancel'
 * @property warning - Optional warning message that was shown
 */
export interface IFileSizeCheckResult {
    /** Whether to proceed with LiveWriteMD editor */
    shouldProceed: boolean;
    /** The file size in bytes */
    fileSize: number;
    /** The action to take */
    action: 'proceed' | 'standardEditor' | 'cancel';
    /** Optional warning message that was shown */
    warning?: string;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Format file size in human-readable format.
 *
 * @param bytes - File size in bytes
 * @returns Formatted string (e.g., "1.50 MB")
 */
export function formatFileSize(bytes: number): string {
    if (bytes === 0) {
        return '0 B';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    if (i === 0) {
        return `${bytes} B`;
    }

    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${units[i]}`;
}

/**
 * Get file size in bytes from document content.
 * Uses Buffer.byteLength for accurate UTF-8 byte counting.
 *
 * @param document - Object with getText() method (TextDocument-like)
 * @returns File size in bytes
 */
export function getFileSizeBytes(document: { getText(): string }): number {
    const text = document.getText();
    return Buffer.byteLength(text, 'utf8');
}

// =============================================================================
// Main Check Function
// =============================================================================

/**
 * Check file size and show appropriate warning dialog based on file size.
 *
 * File size categories (DES-P-002):
 * - Small (<= 100KB): No warning, display within 2 seconds
 * - Medium (100KB to threshold): Info message, proceed after acknowledgment
 * - Large (> threshold): Warning with user choice
 *
 * @param document - The VS Code TextDocument to check
 * @returns Promise resolving to FileSizeCheckResult
 *
 * Design Reference: DES-A-007, DES-P-002
 * Requirement: REQ-F-009, REQ-NF-001
 *
 * @example
 * ```typescript
 * const result = await checkFileSize(document);
 * if (result.shouldProceed) {
 *     // Proceed with LiveWriteMD editor
 * } else if (result.action === 'standardEditor') {
 *     // Open with text editor
 *     await openWithTextEditor(document.uri);
 * } else {
 *     // User cancelled - do nothing
 * }
 * ```
 */
export async function checkFileSize(document: vscode.TextDocument): Promise<IFileSizeCheckResult> {
    const fileSize = getFileSizeBytes(document);
    const largeFileThreshold = ConfigManager.getLargeFileThreshold();

    // 按用户要求：不再弹任何大小提醒，一律直接用 LiveWriteMD 打开。
    // 大文件的性能由 webview 侧的虚拟化 / 降级渲染兜底，
    // 弹窗只会打断「双击即开」的节奏。保留日志便于排查性能问题。
    if (fileSize > SMALL_FILE_THRESHOLD) {
        Logger.info(
            `Large file opened without prompt: ${formatFileSize(fileSize)} ` +
                `(threshold: ${formatFileSize(largeFileThreshold)})`
        );
    }
    return {
        shouldProceed: true,
        fileSize,
        action: 'proceed',
    };
}

/**
 * Open document with standard VS Code text editor.
 * Used when user chooses to not use LiveWriteMD for large files.
 *
 * @param uri - The document URI to open
 * @returns Promise that resolves when command is executed
 */
export async function openWithTextEditor(uri: vscode.Uri): Promise<void> {
    await vscode.commands.executeCommand('vscode.open', uri);
}
