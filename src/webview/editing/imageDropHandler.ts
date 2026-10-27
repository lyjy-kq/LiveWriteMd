/**
 * LiveWriteMD Image Drop Handler
 *
 * Handles image drag & drop and clipboard paste in the Webview.
 * Communicates with Extension via postMessage for file saving.
 *
 * @module webview/imageDropHandler
 *
 * Design Reference: DES-API-001
 * Requirements: REQ-3A-001, REQ-3A-002
 */

import { EditorView } from '@codemirror/view';

// =============================================================================
// Constants
// =============================================================================

/** Maximum image file size in bytes (10MB) */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/** Supported image MIME types */
const SUPPORTED_IMAGE_TYPES = [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'image/bmp',
];

/** Supported image file extensions (for D&D fallback check) */
const SUPPORTED_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'];

// =============================================================================
// Types
// =============================================================================

/** Pending image insertion info */
interface PendingInsertion {
    pos: number;
    altText: string;
}

/** 图片插入语法风格。 */
type ImageLinkStyle = 'markdown' | 'wiki';

// =============================================================================
// Module State
// =============================================================================

/**
 * fileName -> insertion info map
 *
 * Design constraint: In Phase 1, D&D handles single file only,
 * so typically 1 entry is pending at a time. On imageSaved/imageSaveError,
 * the first entry (FIFO order) is consumed. Extension may sanitize/rename
 * the fileName, so key matching is not used.
 */
const pendingInsertions = new Map<string, PendingInsertion>();

/** Last paste timestamp for same-second collision detection */
let lastPasteTimestamp = '';

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Handle dragover event to allow drop.
 * Registered on document.body by setupImageDropHandler.
 */
function handleDragOver(event: DragEvent): void {
    if (event.dataTransfer?.types.includes('Files')) {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
    }
}

/**
 * 将相对图片路径规范化为 webview 插入语法可直接使用的形式。
 *
 * 例如 assets/foo.png 会被转换为 ./assets/foo.png，避免相对路径
 * 在不同语法里表现不一致。
 *
 * @param relativePath - 扩展侧返回的相对图片路径
 * @returns 规范化后的相对路径
 */
function normalizeImagePath(relativePath: string): string {
    const normalized = relativePath.replace(/\\/g, '/').trim();
    if (
        normalized.startsWith('./') ||
        normalized.startsWith('../') ||
        normalized.startsWith('/')
    ) {
        return normalized;
    }

    return `./${normalized}`;
}

/**
 * 统计文本中指定正则的命中次数。
 *
 * @param text - 待检查文本
 * @param pattern - 全局匹配正则
 * @returns 命中次数
 */
function countMatches(text: string, pattern: RegExp): number {
    const matches = text.match(pattern);
    return matches ? matches.length : 0;
}

/**
 * 根据当前文档内容判断应使用的图片插入语法。
 *
 * 如果文档里已经大量使用 `![[...]]`，则延续 wiki 风格；
 * 否则默认使用标准 Markdown 图片语法。
 *
 * @param docText - 当前 Markdown 文档内容
 * @returns 图片插入语法风格
 */
function detectImageLinkStyle(docText: string): ImageLinkStyle {
    const wikiCount = countMatches(docText, /!\[\[/g);
    const markdownCount = countMatches(docText, /!\[[^\]]*?\]\(/g);
    return wikiCount > markdownCount ? 'wiki' : 'markdown';
}

/**
 * 构造图片插入文本。
 *
 * @param relativePath - 保存后的相对图片路径
 * @param altText - 图片替代文本
 * @param style - 图片链接语法风格
 * @returns 可直接插入到正文中的 Markdown 文本
 */
function buildImageInsertText(
    relativePath: string,
    altText: string,
    style: ImageLinkStyle
): string {
    const normalizedPath = normalizeImagePath(relativePath);
    const normalizedAltText = altText.trim().replace(/]/g, '\\]').replace(/\[/g, '\\[');

    if (style === 'wiki') {
        const wikiAlt = normalizedAltText.replace(/\|/g, '\\|');
        return wikiAlt ? `![[${normalizedPath}|${wikiAlt}]]\n` : `![[${normalizedPath}]]\n`;
    }

    return `![${normalizedAltText}](${normalizedPath})\n`;
}

/**
 * Handle drop event for image files.
 *
 * @param event - The drop event
 * @param getView - Function to get the current EditorView
 * @param postMessage - Function to send messages to Extension
 */
function handleDrop(
    event: DragEvent,
    getView: () => EditorView | null,
    postMessage: (msg: unknown) => void
): void {
    // 1. Get file from drop
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;

    // 2. Image check (MIME type or extension)
    const isImageMime = SUPPORTED_IMAGE_TYPES.includes(file.type);
    const ext = '.' + file.name.split('.').pop()?.toLowerCase();
    const isImageExt = SUPPORTED_IMAGE_EXTENSIONS.includes(ext);
    if (!isImageMime && !isImageExt) return;

    event.preventDefault();

    // 3. File size validation
    if (file.size > MAX_IMAGE_SIZE) {
        postMessage({ type: 'error', message: '画像サイズが大きすぎます（上限: 10MB）' });
        return;
    }

    // 4. Calculate drop position
    const view = getView();
    if (!view) return;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return;

    // 5. base64 encode + send
    const reader = new FileReader();
    reader.onload = () => {
        const data = reader.result as string;
        pendingInsertions.set(file.name, { pos, altText: file.name });
        postMessage({ type: 'saveImage', data, fileName: file.name });
    };
    reader.onerror = () => {
        console.debug('[LiveWriteMD] FileReader error during D&D');
    };
    reader.readAsDataURL(file);
}

/**
 * Handle paste event for clipboard images.
 *
 * @param event - The clipboard event
 * @param view - The EditorView instance
 * @param postMessage - Function to send messages to Extension
 * @returns true if the event was consumed, false otherwise
 */
function handlePaste(
    event: ClipboardEvent,
    view: EditorView,
    postMessage: (msg: unknown) => void
): boolean {
    // 0. IME composing guard
    if (view.composing) return false;

    const items = event.clipboardData?.items;
    if (!items) return false;

    // 1. Search for image/* type first so clipboard images win even when
    // the clipboard also contains text/plain metadata.
    let imageItem: DataTransferItem | null = null;
    for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
            imageItem = items[i];
            break;
        }
    }
    if (!imageItem) return false;

    // 2. Get File object
    const file = imageItem.getAsFile();
    if (!file) {
        console.debug('[LiveWriteMD] getAsFile() returned null, falling back to default paste');
        return false;
    }

    event.preventDefault();

    // 3. File size validation
    if (file.size > MAX_IMAGE_SIZE) {
        postMessage({ type: 'error', message: '画像サイズが大きすぎます（上限: 10MB）' });
        return true;
    }

    // 4. Generate timestamp-based filename
    const fileName = generatePasteFileName();

    // 5. Remember cursor position
    const pos = view.state.selection.main.head;

    // 6. base64 encode + send
    const reader = new FileReader();
    reader.onload = () => {
        const data = reader.result as string;
        pendingInsertions.set(fileName, { pos, altText: '' });
        postMessage({ type: 'saveImage', data, fileName });
    };
    reader.onerror = () => {
        console.debug('[LiveWriteMD] FileReader error during paste');
    };
    reader.readAsDataURL(file);

    return true;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Setup image drop handlers on document.body.
 *
 * Called from main.ts after the editor is initialized.
 * Registers:
 * - dragover event on document.body (prevent default to allow drop)
 * - drop event on document.body
 *
 * @param getView - Function to get the current EditorView (may be null)
 * @param postMessage - Function to send messages to Extension
 */
export function setupImageDropHandler(
    getView: () => EditorView | null,
    postMessage: (message: unknown) => void
): void {
    // Use capture phase to intercept events before VS Code's handlers
    document.body.addEventListener(
        'dragenter',
        (event: DragEvent) => {
            if (event.dataTransfer?.types.includes('Files')) {
                event.preventDefault();
                event.stopPropagation();
            }
        },
        { capture: true }
    );
    document.body.addEventListener('dragover', handleDragOver, { capture: true });
    document.body.addEventListener(
        'drop',
        (event: DragEvent) => {
            // Prevent default for all file drops to stop VS Code from opening the file
            if (event.dataTransfer?.types.includes('Files')) {
                event.preventDefault();
                event.stopPropagation();
            }
            handleDrop(event, getView, postMessage);
        },
        { capture: true }
    );
    console.debug('[LiveWriteMD] Image drop handler registered on document.body (capture phase)');
}

/**
 * Create a CM6 paste event handler for clipboard image paste.
 *
 * Returns an event handler compatible with EditorView.domEventHandlers.
 * Integrates with CM6's event system for proper IME compatibility.
 *
 * @param postMessage - Function to send messages to Extension
 * @returns paste event handler function
 */
export function createImagePasteHandler(
    postMessage: (message: unknown) => void
): (event: ClipboardEvent, view: EditorView) => boolean {
    return (event: ClipboardEvent, view: EditorView): boolean => {
        return handlePaste(event, view, postMessage);
    };
}

/**
 * Handle imageSaved message from Extension.
 * Inserts Markdown image syntax at the previously recorded position.
 *
 * Called from main.ts message listener.
 *
 * @param message - imageSaved message payload
 * @param getView - Function to get the current EditorView
 */
export function handleImageSaved(
    message: { relativePath: string; fileName: string },
    getView: () => EditorView | null
): void {
    const view = getView();
    if (!view) return;

    // Get first entry from pendingInsertions (FIFO order)
    // Extension may sanitize/rename fileName, so key matching is not used
    let pending: PendingInsertion | undefined;
    for (const [key, value] of pendingInsertions) {
        pending = value;
        pendingInsertions.delete(key);
        break;
    }

    const pos = pending?.pos ?? view.state.selection.main.head;
    const altText = pending?.altText ?? '';
    const style = detectImageLinkStyle(view.state.doc.toString());
    const insertText = buildImageInsertText(message.relativePath, altText, style);

    // Insert via CM6 dispatch (Undo/Redo compatible, works in Viewer Mode too)
    view.dispatch({
        changes: { from: pos, insert: insertText },
    });

    console.debug(`[LiveWriteMD] Image inserted: ${message.relativePath} at pos ${pos}`);
}

/**
 * Handle imageSaveError message from Extension.
 * Shows error via vscode.postMessage -> showErrorMessage.
 *
 * Called from main.ts message listener.
 *
 * @param message - imageSaveError message payload
 * @param postMessage - Function to send messages to Extension
 */
export function handleImageSaveError(
    message: { error: string },
    postMessage: (msg: unknown) => void
): void {
    postMessage({ type: 'error', message: `画像の保存に失敗しました: ${message.error}` });

    // Remove first pending entry only (FIFO: error corresponds to oldest request)
    for (const key of pendingInsertions.keys()) {
        pendingInsertions.delete(key);
        break;
    }
}

/**
 * Generate a timestamp-based filename for pasted images.
 * Format: paste-YYYYMMDD-HHMMSS.png
 * Same-second collision: paste-YYYYMMDD-HHMMSS-mmm.png
 *
 * @returns Generated filename
 */
export function generatePasteFileName(): string {
    const now = new Date();
    const pad2 = (n: number): string => n.toString().padStart(2, '0');
    const dateStr = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
    const timeStr = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
    const base = `paste-${dateStr}-${timeStr}`;

    if (lastPasteTimestamp === base) {
        const ms = now.getMilliseconds().toString().padStart(3, '0');
        lastPasteTimestamp = base;
        return `${base}-${ms}.png`;
    }
    lastPasteTimestamp = base;
    return `${base}.png`;
}
