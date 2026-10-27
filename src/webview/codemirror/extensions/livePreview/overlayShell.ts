/**
 * 预览浮层（从 previewOverlay.ts 拆出）：共享基础设施：单例状态、关闭、标题、SVG 工具、浮层外壳。
 *
 * @module webview/codemirror/extensions/livePreview/overlayShell
 */

import { copyToClipboard } from './state.js';

export interface ImagePreviewOverlayOptions {
    /** 原始图片地址，用于复制。 */
    rawUrl: string;
    /** 已解析后的 webview 可访问地址，解析失败时可为空。 */
    resolvedUrl: string | null;
    /** 图片替代文本。 */
    altText: string;
    /** 图片预览标题，缺省时由调用方或本模块回退生成。 */
    titleText?: string | null;
    /** 标题提交后的回写回调。 */
    onTitleCommit?: (title: string) => void;
    /** 浮层挂载容器，用于继承 CodeMirror baseTheme 样式作用域。 */
    mountHost: HTMLElement;
    /**
     * 主题作用域节点（编辑器根 `view.dom`）。
     *
     * 浮层挂到 `document.body` 时，祖先链上没有 CodeMirror 的 `ͼN` 主题类，
     * 所有 baseTheme/theme 规则全部失效（position 退化成 static，浮层变成
     * 文档流里的一块）。传入后会用一层 portal 把主题类带过去。
     */
    themeScope?: HTMLElement | null;
}

/**
 * 预览浮层中 Mermaid 查看器所需的信息。
 */
export interface MermaidPreviewOverlayOptions {
    /** Mermaid 源文本，用于渲染。 */
    source: string;
    /** Mermaid 预览标题，缺省时显示占位文本。 */
    titleText?: string | null;
    /** 标题提交后的回写回调。 */
    onTitleCommit?: (title: string) => void;
    /** 右侧代码区改动后把新源码写回文档的回调（做了防抖，关闭浮层时会补一次）。 */
    onSourceCommit?: (source: string) => void;
    /** 浮层挂载容器，用于继承 CodeMirror baseTheme 样式作用域。 */
    mountHost: HTMLElement;
    /** 主题作用域节点（编辑器根 `view.dom`），见 {@link ImagePreviewOverlayOptions.themeScope}。 */
    themeScope?: HTMLElement | null;
}

/**
 * 操作按钮的配置项。
 */
export interface PreviewActionOptions {
    /** 按钮提示文案。 */
    title: string;
    /** 按钮无障碍标签。 */
    ariaLabel: string;
    /** 按钮点击后的处理逻辑。 */
    onClick: () => void | Promise<void>;
    /** 按钮展示的符号。 */
    icon: string;
}

/**
 * 浮层标题配置。
 */
export interface PreviewTitleOptions {
    /** 当前标题文本。 */
    text: string | null;
    /** 是否允许编辑标题。 */
    editable: boolean;
    /** 标题提交后的回调。 */
    onCommit?: (title: string) => void;
}

/**
 * 剪贴板图片条目的构造函数类型。
 *
 * 浏览器规范允许 ClipboardItem 的数据值是 Blob 或 Promise<Blob>，但部分 TypeScript DOM
 * 类型版本没有完整声明 Promise 形态，因此在本模块内补齐最小可用类型。
 */
type ClipboardItemConstructorWithPromise = new (
    items: Record<string, Blob | Promise<Blob>>
) => ClipboardItem;

/**
 * 按钮组与状态条的映射。
 *
 * 用于在复制失败时给出可见提示，不必把状态逻辑散落到调用处。
 */
const previewActionStatusByGroup = new WeakMap<HTMLElement, HTMLElement>();

/**
 * 预览复制失败时显示的统一状态文案。
 *
 * 该文案用于图片与 Mermaid 预览的复制失败场景，保持提示简短且不过度打扰内容区域。
 */
const previewCopyFailureText = '复制失败';

/**
 * 预览标题的占位文本。
 *
 * 当没有可展示的名称时，使用这段文案提醒用户当前内容没有命名信息。
 */
const previewTitleFallbackText = '未命名预览';

/**
 * 浮层根节点引用。
 *
 * 同一时刻只允许打开一个预览浮层，因此使用模块级状态保存当前活动节点。
 */
let activeOverlayRoot: HTMLElement | null = null;

/**
 * Mermaid 渲染序号。
 *
 * 这个值用于生成渲染 ID，避免并发渲染时产生冲突。
 */

export function closeActivePreviewOverlay(): void {
    if (!activeOverlayRoot) {
        return;
    }

    activeOverlayRoot.remove();
    activeOverlayRoot = null;
}

/**
 * 为按钮添加短暂反馈。
 *
 * @param button - 需要更新状态的按钮
 * @param icon - 反馈阶段显示的图标
 * @param title - 反馈阶段显示的提示文案
 * @param resetIcon - 恢复后的图标
 * @param resetTitle - 恢复后的提示文案
 * @returns void
 */
export function flashButtonState(
    button: HTMLButtonElement,
    icon: string,
    title: string,
    resetIcon: string,
    resetTitle: string
): void {
    button.textContent = icon;
    button.title = title;
    button.setAttribute('aria-label', title);
    window.setTimeout(() => {
        button.textContent = resetIcon;
        button.title = resetTitle;
        button.setAttribute('aria-label', resetTitle);
    }, 1200);
}

/**
 * 显示按钮组的状态提示。
 *
 * @param group - 需要显示提示的按钮组
 * @param text - 提示文案
 * @param isError - 是否为错误态
 * @returns void
 */
export function showPreviewActionStatus(group: HTMLElement, text: string, isError: boolean): void {
    const status = previewActionStatusByGroup.get(group);
    if (!status) {
        return;
    }

    if (!text) {
        status.textContent = '';
        status.hidden = true;
        status.removeAttribute('data-state');
        return;
    }

    status.textContent = text;
    status.setAttribute('data-state', isError ? 'error' : 'info');
    status.hidden = false;
    window.clearTimeout(Number(status.dataset.hideTimer ?? '0'));
    status.dataset.hideTimer = String(
        window.setTimeout(() => {
            status.hidden = true;
            status.textContent = '';
            status.removeAttribute('data-state');
        }, 2400)
    );
}

/**
 * 安全复制文本到剪贴板。
 *
 * 优先复用 Webview 到扩展的消息链路；如果链路不可用，则退回到浏览器原生剪贴板。
 *
 * @param text - 需要复制的文本
 * @returns 复制是否成功
 */
async function copyTextSafely(text: string): Promise<boolean> {
    try {
        await copyToClipboard(text);
        return true;
    } catch {
        if (navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch {
                return false;
            }
        }

        return false;
    }
}

/**
 * 将图片内容复制到系统剪贴板。
 *
 * @param imageUrl - 可被当前 webview 访问到的图片地址
 * @returns 图片复制是否成功
 */
async function copyImageSafely(imageUrl: string | null): Promise<boolean> {
    if (!imageUrl) {
        return false;
    }

    try {
        const response = await fetch(imageUrl);
        if (!response.ok) {
            return false;
        }

        const blob = await response.blob();
        if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
            return false;
        }

        const mimeType = blob.type || 'image/png';
        await navigator.clipboard.write([new ClipboardItem({ [mimeType]: blob })]);
        return true;
    } catch {
        return false;
    }
}

/**
 * 将 Blob 图片复制到系统剪贴板。
 *
 * @param blob - 需要复制的图片 Blob
 * @returns 图片复制是否成功
 */
async function copyBlobImageSafely(blob: Blob): Promise<boolean> {
    try {
        if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
            return false;
        }

        const mimeType = blob.type || 'image/png';
        await navigator.clipboard.write([new ClipboardItem({ [mimeType]: blob })]);
        return true;
    } catch {
        return false;
    }
}

/**
 * 解析可展示的预览标题。
 *
 * @param explicitTitle - 调用方显式传入的标题
 * @param fallbackTitle - 无显式标题时使用的回退文本
 * @returns 可展示标题或回退文本
 */
export function resolvePreviewTitle(explicitTitle: string | null | undefined, fallbackTitle: string): string {
    const title = explicitTitle?.trim();
    return title || fallbackTitle;
}

/**
 * 从预览地址中提取一个可读的展示名称。
 *
 * 该名称用于图片预览标题的回退显示，尽量把路径、查询参数和锚点清理掉。
 *
 * @param sourceUrl - 原始预览地址
 * @returns 可展示的文件名，提取失败时返回 null
 */
export function extractPreviewDisplayName(sourceUrl: string | null | undefined): string | null {
    const trimmed = sourceUrl?.trim();
    if (!trimmed) {
        return null;
    }

    const withoutQuery = trimmed.split('?')[0];
    const withoutHash = withoutQuery.split('#')[0];
    const normalized = withoutHash.replace(/\\/g, '/');
    const lastSegment = normalized.split('/').filter(Boolean).pop()?.trim();
    if (!lastSegment) {
        return null;
    }

    try {
        return decodeURIComponent(lastSegment);
    } catch {
        return lastSegment;
    }
}

/**
 * 设置预览浮层标题节点内容。
 *
 * @param titleNode - 需要更新的标题节点
 * @param titleText - 要展示的标题文本
 * @param isPlaceholder - 是否为占位标题
 * @returns void
 */
function setPreviewOverlayTitle(
    titleNode: HTMLSpanElement,
    titleText: string,
): void {
    titleNode.textContent = titleText;
}

/**
 * 为可编辑的预览标题绑定输入与提交行为。
 *
 * 标题默认使用“失焦提交”的交互模式，避免在预览过程中反复写入源码。
 * 当标题被清空时，会恢复为占位文本，并向回写回调提交空字符串。
 *
 * @param titleNode - 需要绑定编辑行为的标题节点
 * @param title - 标题配置
 * @returns void
 */
export function bindEditablePreviewTitle(titleNode: HTMLSpanElement, title: PreviewTitleOptions): void {
    if (!title.editable) {
        return;
    }

    const normalizeTitleText = (): string => titleNode.textContent?.trim() ?? '';
    let lastCommittedText = title.text?.trim() ?? '';
    let dirty = false;

    /**
     * 提交当前编辑结果到外部回写回调。
     *
     * @returns void
     */
    const commitTitle = (): void => {
        const nextText = normalizeTitleText();
        if (!dirty && nextText === lastCommittedText) {
            setPreviewOverlayTitle(titleNode, lastCommittedText);
            return;
        }

        lastCommittedText = nextText;
        dirty = false;
        title.onCommit?.(nextText);
        setPreviewOverlayTitle(titleNode, nextText);
    };

    titleNode.contentEditable = 'true';
    titleNode.spellcheck = false;
    titleNode.classList.add('cm-md-preview-title-editable');
    titleNode.setAttribute('role', 'textbox');
    titleNode.setAttribute('aria-label', '可编辑预览标题');
    titleNode.addEventListener('focus', () => {
        titleNode.textContent = normalizeTitleText();
    });
    titleNode.addEventListener('input', () => {
        dirty = true;
    });
    titleNode.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            titleNode.blur();
            return;
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            dirty = false;
            setPreviewOverlayTitle(titleNode, lastCommittedText);
            titleNode.blur();
        }
    });
    titleNode.addEventListener('blur', () => {
        commitTitle();
    });
}

/**
 * 从 SVG 文本中读取可用于画布的尺寸。
 *
 * @param svg - Mermaid 渲染得到的 SVG 字符串
 * @returns 画布尺寸
 */
export function readSvgCanvasSize(svg: string): { width: number; height: number } {
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const svgElement = parsed.documentElement;
    const widthAttr = parseFloat(svgElement.getAttribute('width') ?? '');
    const heightAttr = parseFloat(svgElement.getAttribute('height') ?? '');

    if (Number.isFinite(widthAttr) && widthAttr > 0 && Number.isFinite(heightAttr) && heightAttr > 0) {
        return { width: Math.ceil(widthAttr), height: Math.ceil(heightAttr) };
    }

    const viewBox = svgElement.getAttribute('viewBox')?.trim().split(/\s+/).map(Number);
    if (viewBox && viewBox.length === 4 && viewBox.every((value) => Number.isFinite(value))) {
        return {
            width: Math.max(1, Math.ceil(viewBox[2])),
            height: Math.max(1, Math.ceil(viewBox[3])),
        };
    }

    return { width: 800, height: 600 };
}

/**
 * 为 SVG 补齐适合浏览器加载的基础命名空间。
 *
 * @param svg - Mermaid 渲染得到的 SVG 字符串
 * @returns 补齐后的 SVG 字符串
 */
export function normalizeSvgMarkup(svg: string): string {
    if (svg.includes('xmlns=')) {
        return svg;
    }

    return svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
}

/**
 * 将 SVG 字符串转换为 PNG 图片 Blob。
 *
 * @param svg - Mermaid 渲染得到的 SVG 字符串
 * @returns 转换后的 PNG Blob
 */
async function convertSvgToPngBlob(svg: string): Promise<Blob> {
    const normalizedSvg = normalizeSvgMarkup(svg);
    const size = readSvgCanvasSize(normalizedSvg);
    const encodedSvg = encodeURIComponent(normalizedSvg)
        .replace(/'/g, '%27')
        .replace(/"/g, '%22');
    const svgUrl = `data:image/svg+xml;charset=utf-8,${encodedSvg}`;
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');

    if (!context) {
        throw new Error('canvas 2d context unavailable');
    }

    try {
        const image = new Image();
        image.decoding = 'async';
        image.src = svgUrl;
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error('failed to load svg image'));
        });

        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);

        const pngBlob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob((result) => {
                if (result) {
                    resolve(result);
                    return;
                }
                reject(new Error('canvas toBlob returned null'));
            }, 'image/png');
        });

        return pngBlob;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`failed to convert svg to png: ${errorMessage}`);
    }
}

/**
 * 将 Mermaid 已渲染的 SVG 节点复制到系统剪贴板。
 *
 * 这个实现直接读取当前 DOM 中已经显示出来的图表，避免在点击时重新渲染或转码，
 * 以免丢失浏览器对剪贴板写入所需的用户激活。
 * 复制内容优先使用 PNG 图片，并保留纯文本 SVG 作为回退。
 *
 * @param renderedRoot - 包含 Mermaid SVG 的容器节点
 * @returns 复制是否成功
 */
export async function copyMermaidRenderedImageSafely(renderedRoot: ParentNode): Promise<boolean> {
    try {
        const svgElement = renderedRoot.querySelector('svg');
        if (!svgElement) {
            console.debug('[LiveWriteMD] Mermaid copy aborted: SVG element not found');
            return false;
        }

        const svg = new XMLSerializer().serializeToString(svgElement);
        console.debug(`[LiveWriteMD] Mermaid copy found SVG, length=${svg.length}`);
        try {
            if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
                const clipboardItemFactory = ClipboardItem as ClipboardItemConstructorWithPromise;
                const pngBlobPromise = convertSvgToPngBlob(svg);
                await navigator.clipboard.write([
                    new clipboardItemFactory({
                        'image/png': pngBlobPromise,
                        'text/plain': new Blob([svg], { type: 'text/plain;charset=utf-8' }),
                    }),
                ]);
                console.debug('[LiveWriteMD] Mermaid PNG copy result: success');
                return true;
            }

            const success = await copyTextSafely(svg);
            console.debug(`[LiveWriteMD] Mermaid PNG copy fallback text result: ${success ? 'success' : 'failed'}`);
            return success;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.debug(`[LiveWriteMD] Mermaid PNG copy failed, fallback to text: ${errorMessage}`);
            return copyTextSafely(svg);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.debug(`[LiveWriteMD] Mermaid copy failed in webview: ${errorMessage}`);
        return false;
    }
}

/**
 * 创建一个小型圆角操作按钮。
 *
 * @param options - 按钮配置
 * @returns 按钮元素
 */

export function mountOverlayRoot(
    host: HTMLElement,
    root: HTMLElement,
    themeScope?: HTMLElement | null
): HTMLElement {
    // 宿主本身就在主题作用域里（live 模式挂 view.dom 的旧路径）→ 直接挂
    if (!themeScope || themeScope.contains(host)) {
        host.appendChild(root);
        return root;
    }

    const portal = document.createElement('div');
    portal.className = 'cm-md-preview-portal';
    for (const cls of Array.from(themeScope.classList)) {
        // 只搬 CodeMirror 自动生成的样式类，别把 cm-editor / cm-focused 带过去
        if (cls.startsWith('ͼ')) portal.classList.add(cls);
    }
    portal.appendChild(root);
    host.appendChild(portal);
    return portal;
}

/**
 * 创建预览浮层的通用外壳。
 *
 * @param title - 浮层标题
 * @param onClose - 关闭回调
 * @returns 浮层所需的关键 DOM 节点
 */
export function createOverlayShell(title: PreviewTitleOptions, onClose: () => void): {
    /** 浮层根节点。 */
    root: HTMLElement;
    /** 浮层内容可视区。 */
    viewport: HTMLElement;
    /** 浮层可拖拽的内容容器。 */
    stage: HTMLElement;
    /** 浮层中放置实际内容的节点。 */
    contentHost: HTMLElement;
    /** 标题文本节点。 */
    titleNode: HTMLSpanElement;
} {
    const root = document.createElement('div');
    root.className = 'cm-md-preview-overlay';

    const backdrop = document.createElement('div');
    backdrop.className = 'cm-md-preview-backdrop';
    root.appendChild(backdrop);

    const panel = document.createElement('div');
    panel.className = 'cm-md-preview-panel';
    root.appendChild(panel);

    const header = document.createElement('div');
    header.className = 'cm-md-preview-header';
    panel.appendChild(header);

    const titleNode = document.createElement('span');
    titleNode.className = 'cm-md-preview-title';
    setPreviewOverlayTitle(titleNode, title.text ?? '');
    bindEditablePreviewTitle(titleNode, title);
    header.appendChild(titleNode);

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'cm-md-preview-close';
    closeButton.textContent = '×';
    closeButton.title = '关闭';
    closeButton.setAttribute('aria-label', '关闭');
    closeButton.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
    });
    closeButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        onClose();
    });
    header.appendChild(closeButton);

    const viewport = document.createElement('div');
    viewport.className = 'cm-md-preview-viewport';
    panel.appendChild(viewport);

    const stage = document.createElement('div');
    stage.className = 'cm-md-preview-stage';
    viewport.appendChild(stage);

    const contentHost = document.createElement('div');
    contentHost.className = 'cm-md-preview-content';
    stage.appendChild(contentHost);

    backdrop.addEventListener('click', onClose);
    root.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
        }
    });

    return { root, viewport, stage, contentHost, titleNode };
}

/**
 * 打开图片预览浮层。
 *
 * @param options - 图片预览参数
 * @returns void
 */

/**
 * 登记当前激活的浮层根节点（全局只允许一个浮层）。
 * 两个入口（imagePreview / mermaidPreview）挂载后通过它登记，
 * closeActivePreviewOverlay 据此关闭。
 */
export function setActiveOverlayRoot(root: HTMLElement | null): void {
    activeOverlayRoot = root;
}
