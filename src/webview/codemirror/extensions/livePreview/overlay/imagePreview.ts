/**
 * 预览浮层（从 previewOverlay.ts 拆出）：图片预览入口 openImagePreviewOverlay。
 *
 * @module webview/codemirror/extensions/livePreview/imagePreview
 */

import { ImagePreviewOverlayOptions, closeActivePreviewOverlay, createOverlayShell, extractPreviewDisplayName, mountOverlayRoot, setActiveOverlayRoot } from './overlayShell.js';
import { attachPanZoom, createPreviewActionGroup, queuePreviewFit } from './overlayControls.js';

export function openImagePreviewOverlay(options: ImagePreviewOverlayOptions): void {
    closeActivePreviewOverlay();

    const cleanupBag: Array<() => void> = [];
    const imageDisplayName = options.titleText?.trim() || options.altText?.trim() || extractPreviewDisplayName(options.rawUrl);
    const imageTitleText = imageDisplayName || previewTitleFallbackText;
    const overlay = createOverlayShell(
        {
            text: imageTitleText,
            editable: false,
        },
        () => {
            for (const cleanup of cleanupBag.reverse()) {
                cleanup();
            }
            closeActivePreviewOverlay();
        }
    );

    const close = overlay.root;
    // 挂载时可能套一层 portal（挂 body 的情况），关闭要连同 portal 一起删
    const mounted = mountOverlayRoot(options.mountHost, close, options.themeScope);
    cleanupBag.push(() => mounted.remove());
    setActiveOverlayRoot(mounted);

    const contentHost = overlay.contentHost;
    const viewport = overlay.viewport;
    const stage = overlay.stage;
    const panZoom = attachPanZoom(viewport, stage);
    cleanupBag.push(panZoom.cleanup);

    const resolvedUrl = options.resolvedUrl ?? options.rawUrl;
    if (resolvedUrl) {
        const img = document.createElement('img');
        img.className = 'cm-md-preview-image';
        img.addEventListener('load', () => {
            contentHost.classList.add('cm-md-preview-image-loaded');
            queuePreviewFit(() => panZoom.fitToViewport());
        });
        img.addEventListener('error', () => {
            contentHost.replaceChildren(createPreviewFallback(options.altText || '[image]'));
        });
        img.src = resolvedUrl;
        img.alt = options.altText || '[image]';
        img.draggable = false;
        contentHost.replaceChildren(img);

        if (img.complete && img.naturalWidth > 0) {
            queuePreviewFit(() => panZoom.fitToViewport());
        }
    } else {
        contentHost.replaceChildren(createPreviewFallback(options.altText || '[image]'));
    }

    const actions = createPreviewActionGroup('放大图片', '复制图片', panZoom.zoomIn, async () => {
        if (!resolvedUrl) {
            throw new Error('image url not resolved');
        }

        const blob = await fetch(resolvedUrl).then(async (response) => {
            if (!response.ok) {
                throw new Error('image fetch failed');
            }
            return response.blob();
        });

        const success = await copyBlobImageSafely(blob);
        if (!success) {
            throw new Error('copy failed');
        }
    });
    contentHost.appendChild(actions);

    close.tabIndex = -1;
    close.focus({ preventScroll: true });
}

/**
 * 打开 Mermaid 预览浮层。
 *
 * 版式是 **2:1 分栏**：左边（2 份宽）是渲染出来的图，右边（1 份宽）是 Mermaid 源码，
 * 在右边改代码左边即时重渲染，关掉浮层时改动已经写回文档。
 *
 * @param options - Mermaid 预览参数
 * @returns void
 */
