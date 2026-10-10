/**
 * LiveWriteMD Image Save Handler
 *
 * Handles image file saving for drag & drop and clipboard paste operations.
 * All file system operations are performed on the Extension side for security.
 *
 * @module extension/imageSaveHandler
 *
 * Design Reference: DES-API-002
 * Requirements: REQ-3A-001, REQ-3A-002, REQ-3A-003
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { Logger } from './logger.js';
import { ConfigManager } from './configManager.js';

// =============================================================================
// Public API
// =============================================================================

/**
 * Handle a saveImage request from the Webview.
 *
 * Processing flow:
 * 1. Get and validate image save folder (path traversal check)
 * 2. Create directory if it doesn't exist
 * 3. Sanitize file name
 * 4. Find unique file name (sequential numbering if duplicate)
 * 5. Decode base64 data
 * 6. Write file to disk
 * 7. Send success/error response back to Webview
 *
 * @param data - base64-encoded image data (data:image/xxx;base64,... format)
 * @param fileName - original file name (D&D) or timestamp-based name (paste)
 * @param documentUri - URI of the .md file being edited
 * @param webview - Webview instance for sending response messages
 */
export async function handleSaveImage(
    data: string,
    fileName: string,
    documentUri: vscode.Uri,
    webview: vscode.Webview
): Promise<void> {
    try {
        const docDir = path.dirname(documentUri.fsPath);

        // 1. Get and validate save folder (path traversal prevention)
        const folderName = getValidatedSaveFolder(docDir);
        const saveDir = path.join(docDir, folderName);

        // 2. Create directory if it doesn't exist
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(saveDir));

        // 3. Sanitize file name
        const sanitizedName = sanitizeFileName(fileName);

        // 4. Find unique file name (sequential numbering)
        const finalName = await getUniqueFileName(saveDir, sanitizedName);

        // 5. Decode base64 data
        const binaryData = decodeBase64Data(data);

        // 6. Write file to disk
        const filePath = path.join(saveDir, finalName);
        await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), binaryData);

        // 7. Build relative path with normalized separators (Windows support)
        const normalizedFolderName = folderName.replace(/\\/g, '/');
        const relativePath = normalizedFolderName + '/' + finalName;

        Logger.info(`Image saved: ${relativePath}`);

        // 8. Send success response
        await webview.postMessage({
            type: 'imageSaved',
            relativePath,
            fileName: finalName,
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        Logger.error(`Image save failed: ${errorMessage}`);

        await webview.postMessage({
            type: 'imageSaveError',
            error: errorMessage,
        });
    }
}

// =============================================================================
// Internal Functions (exported for testing)
// =============================================================================

/**
 * Sanitize a file name for safe file system use.
 *
 * 1. path.basename() to strip path separators
 * 2. Replace control characters and forbidden characters (/\:*?"<>|) with _
 * 3. Fallback to 'image.png' if result is empty
 *
 * @param fileName - original file name
 * @returns sanitized file name
 */
export function sanitizeFileName(fileName: string): string {
    // Strip path separators
    let name = path.basename(fileName);

    // Replace control characters + forbidden characters with _
    name = name.replace(/[\x00-\x1f/\\:*?"<>|]/g, '_');

    // Fallback for empty result
    if (!name || name === '') {
        name = 'image.png';
    }

    return name;
}

/**
 * Get a unique file name by appending a sequential number if needed.
 *
 * Example: image.png -> image-1.png -> image-2.png
 * Max attempts: 1000
 *
 * @param dir - absolute path to the save directory
 * @param fileName - desired file name
 * @returns unique file name
 * @throws Error if no unique name found after 1000 attempts
 */
export async function getUniqueFileName(dir: string, fileName: string): Promise<string> {
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);

    // Try original file name first
    const firstPath = vscode.Uri.file(path.join(dir, fileName));
    try {
        await vscode.workspace.fs.stat(firstPath);
    } catch {
        // File doesn't exist - use as is
        return fileName;
    }

    // Try sequential numbers
    for (let i = 1; i <= 1000; i++) {
        const candidate = `${base}-${i}${ext}`;
        const candidatePath = vscode.Uri.file(path.join(dir, candidate));
        try {
            await vscode.workspace.fs.stat(candidatePath);
        } catch {
            return candidate;
        }
    }

    throw new Error(`Cannot find unique filename for ${fileName} (tried 1000 sequential numbers)`);
}

/**
 * Decode base64 data URI to binary Uint8Array.
 *
 * @param dataUri - data:image/xxx;base64,... format string
 * @returns decoded binary data
 * @throws Error if the data URI format is invalid
 */
export function decodeBase64Data(dataUri: string): Uint8Array {
    const match = dataUri.match(/^data:[^;]+;base64,(.+)$/);
    if (!match) {
        throw new Error('Invalid base64 data URI format');
    }
    const base64 = match[1];
    const buffer = Buffer.from(base64, 'base64');
    return new Uint8Array(buffer);
}

/**
 * Validate and return the image save folder name.
 *
 * Performs path traversal prevention:
 * 1. Resolve the full path from docDir + folderName
 * 2. Verify the resolved path is under docDir
 * 3. Fallback to 'assets' if path traversal is detected
 *
 * @param docDir - absolute path of the .md file's directory
 * @returns validated folder name
 */
export function getValidatedSaveFolder(docDir: string): string {
    const folderName = ConfigManager.getImageSaveFolder();
    const resolved = path.resolve(docDir, folderName);

    if (!resolved.startsWith(docDir + path.sep) && resolved !== docDir) {
        Logger.error(
            `Path traversal detected in imageSaveFolder: '${folderName}'. Falling back to 'assets'.`
        );
        return 'assets';
    }

    return folderName;
}
