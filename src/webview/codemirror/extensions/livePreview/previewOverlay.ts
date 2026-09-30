/**
 * 预览浮层工具。
 *
 * 这个模块负责图片与 Mermaid 预览的放大查看、缩放、拖动和平铺按钮创建。
 * 设计目标是把“查看器”逻辑从 widget 渲染逻辑中拆出来，避免 widgets.ts 继续膨胀。
 */

import {
    copyToClipboard,
    getMermaidTheme,
    mermaidInitialized,
    mermaidRenderPromises,
    mermaidSvgCache,
    rememberMermaidSvg,
    setMermaidInitialized,
} from './state.js';
import { canStepMediaWidth } from './mediaWidth.js';

/**
 * 预览浮层中图片查看器所需的信息。
 */ 
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
}

/**
 * 操作按钮的配置项。
 */
interface PreviewActionOptions {
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
interface PreviewTitleOptions {
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
let mermaidRenderSequence = 0;

/**
 * 右侧代码改动后多久重渲染（ms）。
 *
 * 太短会在连着敲字时反复启动 mermaid 渲染（它内部有布局计算，不便宜），
 * 太长又会显得"改完半天不动"。0.3 秒是「看着像即时」和「不卡」的折中。
 */
const MERMAID_LIVE_RENDER_DELAY_MS = 300;

/**
 * 右侧代码改动后多久把源码写回文档（ms）。
 *
 * 回写会触发整篇装饰重建，比渲染还贵，所以比渲染再慢一拍；
 * 反正用户的注意力在左边的图上，晚一点落盘看不出来。
 */
const MERMAID_LIVE_COMMIT_DELAY_MS = 800;

/**
 * 关闭当前活动的预览浮层。
 *
 * @returns void
 */
function closeActivePreviewOverlay(): void {
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
function flashButtonState(
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
function showPreviewActionStatus(group: HTMLElement, text: string, isError: boolean): void {
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
function resolvePreviewTitle(explicitTitle: string | null | undefined, fallbackTitle: string): string {
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
function bindEditablePreviewTitle(titleNode: HTMLSpanElement, title: PreviewTitleOptions): void {
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
function readSvgCanvasSize(svg: string): { width: number; height: number } {
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
function normalizeSvgMarkup(svg: string): string {
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
            console.debug('[FlowMD] Mermaid copy aborted: SVG element not found');
            return false;
        }

        const svg = new XMLSerializer().serializeToString(svgElement);
        console.debug(`[FlowMD] Mermaid copy found SVG, length=${svg.length}`);
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
                console.debug('[FlowMD] Mermaid PNG copy result: success');
                return true;
            }

            const success = await copyTextSafely(svg);
            console.debug(`[FlowMD] Mermaid PNG copy fallback text result: ${success ? 'success' : 'failed'}`);
            return success;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.debug(`[FlowMD] Mermaid PNG copy failed, fallback to text: ${errorMessage}`);
            return copyTextSafely(svg);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.debug(`[FlowMD] Mermaid copy failed in webview: ${errorMessage}`);
        return false;
    }
}

/**
 * 创建一个小型圆角操作按钮。
 *
 * @param options - 按钮配置
 * @returns 按钮元素
 */
function createPreviewActionButton(options: PreviewActionOptions): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cm-md-preview-action';
    button.textContent = options.icon;
    button.title = options.title;
    button.setAttribute('aria-label', options.ariaLabel);
    let suppressNextClick = false;

    button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        if (event.pointerType === 'mouse' && event.button !== 0) {
            return;
        }

        suppressNextClick = true;
        void Promise.resolve(options.onClick());
    });

    button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        if (suppressNextClick) {
            suppressNextClick = false;
            return;
        }

        await options.onClick();
    });

    return button;
}

/**
 * 创建右下角操作按钮组。
 *
 * @param expandTitle - 放大按钮提示
 * @param copyTitle - 复制按钮提示
 * @param onExpand - 放大按钮点击回调
 * @param onCopy - 复制按钮点击回调
 * @returns 按钮组容器
 */
export function createPreviewActionGroup(
    expandTitle: string,
    copyTitle: string,
    onExpand: () => void,
    onCopy: () => Promise<void> | void
): HTMLElement {
    const group = document.createElement('div');
    group.className = 'cm-md-preview-actions';

    const status = document.createElement('div');
    status.className = 'cm-md-preview-action-status';
    status.hidden = true;
    group.appendChild(status);
    previewActionStatusByGroup.set(group, status);

    const expandButton = createPreviewActionButton({
        title: expandTitle,
        ariaLabel: expandTitle,
        icon: '⤢',
        onClick: onExpand,
    });
    group.appendChild(expandButton);

    const copyButton = createPreviewActionButton({
        title: copyTitle,
        ariaLabel: copyTitle,
        icon: '⧉',
        onClick: async () => {
            const success = await Promise.resolve(onCopy()).then(() => true, () => false);
            if (success) {
                showPreviewActionStatus(group, '已复制', false);
                flashButtonState(copyButton, '✓', '已复制', '⧉', copyTitle);
            } else {
                showPreviewActionStatus(group, previewCopyFailureText, true);
                flashButtonState(copyButton, '!', '复制失败', '⧉', copyTitle);
            }
        },
    });
    group.appendChild(copyButton);

    return group;
}

/**
 * 创建媒体宽度调整按钮组（− / 百分比 / +）。
 *
 * 这个组会被塞进 createPreviewActionGroup 返回的同一个胶囊里，共用右下角
 * 定位和底色，所以这里只负责按钮本身。
 *
 * @param percent - 当前宽度百分比
 * @param subject - 被调整的对象名称，用于按钮提示，如“图片”“图表”
 * @param onStep - 步进回调，参数为 -1（缩小）或 1（放大）
 * @returns 按钮组容器
 */
export function createMediaResizeGroup(
    percent: number,
    subject: string,
    onStep: (delta: number) => void
): HTMLElement {
    const group = document.createElement('div');
    group.className = 'cm-md-resize-actions';

    const shrinkButton = createPreviewActionButton({
        title: `缩小${subject}宽度（当前 ${percent}%）`,
        ariaLabel: `缩小${subject}宽度`,
        icon: '−',
        onClick: () => onStep(-1),
    });
    shrinkButton.classList.add('cm-md-resize-btn');
    // 已经到最小档位时直接禁用，避免用户点到没有反应的按钮。
    shrinkButton.disabled = !canStepMediaWidth(percent, -1);

    const value = document.createElement('span');
    value.className = 'cm-md-resize-value';
    value.textContent = `${percent}%`;
    value.title = `${subject}宽度为正文宽度的 ${percent}%`;

    const growButton = createPreviewActionButton({
        title: `放大${subject}宽度（当前 ${percent}%）`,
        ariaLabel: `放大${subject}宽度`,
        icon: '+',
        onClick: () => onStep(1),
    });
    growButton.classList.add('cm-md-resize-btn');
    growButton.disabled = !canStepMediaWidth(percent, 1);

    group.appendChild(shrinkButton);
    group.appendChild(value);
    group.appendChild(growButton);
    return group;
}

/**
 * 绑定浮层内容的拖动与缩放交互。
 *
 * 交互方式：
 * - 鼠标滚轮缩放
 * - 按住左键拖动平移
 *
 * @param viewport - 用于接收滚轮与拖拽事件的可视区域
 * @param stage - 需要被平移/缩放的内容容器
 * @returns 浮层交互控制器
 */
function attachPanZoom(viewport: HTMLElement, stage: HTMLElement): {
    /** 释放事件监听器的清理函数。 */
    cleanup: () => void;
    /** 主动放大一次当前内容。 */
    zoomIn: () => void;
    /** 尝试将当前内容适配到视口尺寸。 */
    fitToViewport: () => boolean;
} {
    let scale = 1;
    let translateX = 0;
    let translateY = 0;
    let dragging = false;
    let pointerId: number | null = null;
    let dragStartX = 0;
    let dragStartY = 0;
    let originTranslateX = 0;
    let originTranslateY = 0;

    /**
     * 应用当前平移与缩放状态。
     *
     * @returns void
     */
    function applyTransform(): void {
        stage.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
    }

    /**
     * 更新拖动视觉状态。
     *
     * @param isDragging - 是否正在拖动
     * @returns void
     */
    function setDragging(isDragging: boolean): void {
        dragging = isDragging;
        viewport.classList.toggle('cm-md-preview-dragging', isDragging);
    }

    /**
     * 处理缩放。
     *
     * @param deltaY - 鼠标滚轮位移
     * @returns void
     */
    function zoomBy(factor: number): void {
        const nextScale = scale * factor;
        scale = Math.min(15, Math.max(0.2, nextScale));
        applyTransform();
    }

    /**
     * 尝试将当前内容按视口尺寸自动适配。
     *
     * 适配失败时返回 `false`，调用方可以回退到当前默认方案。
     *
     * @returns 是否成功完成适配
     */
    function fitToViewport(): boolean {
        const contentHost = stage.firstElementChild as HTMLElement | null;
        if (!contentHost) {
            return false;
        }

        const viewportWidth = viewport.clientWidth;
        const viewportHeight = viewport.clientHeight;
        const contentWidth = contentHost.scrollWidth;
        const contentHeight = contentHost.scrollHeight;

        if (viewportWidth <= 0 || viewportHeight <= 0 || contentWidth <= 0 || contentHeight <= 0) {
            return false;
        }

        const nextScale = Math.min(viewportWidth / contentWidth, viewportHeight / contentHeight);
        if (!Number.isFinite(nextScale) || nextScale <= 0) {
            return false;
        }

        scale = Math.min(15, Math.max(0.2, nextScale));
        applyTransform();
        return true;
    }

    /**
     * 处理缩放。
     *
     * @param deltaY - 鼠标滚轮位移
     * @returns void
     */
    function handleWheel(deltaY: number): void {
        zoomBy(deltaY < 0 ? 1.12 : 1 / 1.12);
    }

    /**
     * 处理拖动开始。
     *
     * @param event - 指针事件
     * @returns void
     */
    function handlePointerDown(event: PointerEvent): void {
        if (event.button !== 0) {
            return;
        }

        setDragging(true);
        pointerId = event.pointerId;
        dragStartX = event.clientX;
        dragStartY = event.clientY;
        originTranslateX = translateX;
        originTranslateY = translateY;
        viewport.setPointerCapture(pointerId);
    }

    /**
     * 处理拖动移动。
     *
     * @param event - 指针事件
     * @returns void
     */
    function handlePointerMove(event: PointerEvent): void {
        if (!dragging || pointerId !== event.pointerId) {
            return;
        }

        translateX = originTranslateX + (event.clientX - dragStartX);
        translateY = originTranslateY + (event.clientY - dragStartY);
        applyTransform();
    }

    /**
     * 处理拖动结束。
     *
     * @param event - 指针事件
     * @returns void
     */
    function handlePointerUp(event: PointerEvent): void {
        if (pointerId !== event.pointerId) {
            return;
        }

        if (pointerId !== null && viewport.hasPointerCapture(pointerId)) {
            viewport.releasePointerCapture(pointerId);
        }

        setDragging(false);
        pointerId = null;
    }

    viewport.addEventListener('wheel', (event) => {
        event.preventDefault();
        handleWheel(event.deltaY);
    });
    viewport.addEventListener('pointerdown', handlePointerDown);
    viewport.addEventListener('pointermove', handlePointerMove);
    viewport.addEventListener('pointerup', handlePointerUp);
    viewport.addEventListener('pointercancel', handlePointerUp);

    applyTransform();

    return {
        cleanup: () => {
            viewport.removeEventListener('pointerdown', handlePointerDown);
            viewport.removeEventListener('pointermove', handlePointerMove);
            viewport.removeEventListener('pointerup', handlePointerUp);
            viewport.removeEventListener('pointercancel', handlePointerUp);
            viewport.classList.remove('cm-md-preview-dragging');
        },
        zoomIn: () => {
            zoomBy(1.25);
        },
        fitToViewport,
    };
}

/**
 * 在下一帧尝试将预览内容适配到视口。
 *
 * 这样可以等待图片解码或 Mermaid SVG 布局完成，再读取实际尺寸。
 *
 * @param fitToViewport - 具体的适配动作
 * @returns void
 */
function queuePreviewFit(fitToViewport: () => boolean): void {
    requestAnimationFrame(() => {
        fitToViewport();
    });
}

/**
 * 创建预览浮层的通用外壳。
 *
 * @param title - 浮层标题
 * @param onClose - 关闭回调
 * @returns 浮层所需的关键 DOM 节点
 */
function createOverlayShell(title: PreviewTitleOptions, onClose: () => void): {
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
    cleanupBag.push(() => close.remove());
    activeOverlayRoot = close;

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

    options.mountHost.appendChild(close);
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
export function openMermaidPreviewOverlay(options: MermaidPreviewOverlayOptions): void {
    closeActivePreviewOverlay();

    const cleanupBag: Array<() => void> = [];
    const overlay = createOverlayShell(
        {
            text: resolvePreviewTitle(options.titleText, previewTitleFallbackText),
            editable: false,
        },
        () => {
            for (const cleanup of cleanupBag.reverse()) {
                cleanup();
            }
            closeActivePreviewOverlay();
        }
    );

    const root = overlay.root;
    activeOverlayRoot = root;

    const viewport = overlay.viewport;
    const stage = overlay.stage;
    const contentHost = overlay.contentHost;
    const panZoom = attachPanZoom(viewport, stage);
    cleanupBag.push(panZoom.cleanup);

    // -------------------------------------------------------------------------
    // 2:1 分栏：viewport 整体搬进左栏，右栏放一个 textarea
    // -------------------------------------------------------------------------
    // 搬 viewport 而不是重建：缩放 / 拖动那一整套（attachPanZoom、stage、content）
    // 一行都不用改，而且变换只作用在左栏里，右栏的 textarea 不受影响。
    const split = document.createElement('div');
    split.className = 'cm-md-preview-split';
    const mainColumn = document.createElement('div');
    mainColumn.className = 'cm-md-preview-split-main';
    const sideColumn = document.createElement('div');
    sideColumn.className = 'cm-md-preview-split-side';
    const editor = document.createElement('textarea');
    editor.className = 'cm-md-preview-mermaid-editor';
    editor.spellcheck = false;
    editor.setAttribute('aria-label', 'Mermaid 源码');
    editor.value = options.source;
    sideColumn.appendChild(editor);
    // viewport 原本是 panel 的直接子节点：先用 split 把它换下来，再收进左栏
    viewport.replaceWith(split);
    mainColumn.appendChild(viewport);
    split.append(mainColumn, sideColumn);

    // 左栏的三个常驻节点：图、提示条（加载中 / 渲染失败 / 空图表）、右下角按钮组
    const rendered = document.createElement('div');
    rendered.className = 'cm-md-preview-mermaid-rendered';
    const message = createPreviewFallback('正在渲染 Mermaid 图表...');
    message.classList.add('cm-md-preview-loading');
    const actions = createPreviewActionGroup('放大图表', '复制 Mermaid 图', panZoom.zoomIn, async () => {
        const success = await copyMermaidRenderedImageSafely(contentHost);
        if (!success) {
            throw new Error('copy failed');
        }
    });
    contentHost.replaceChildren(rendered, message, actions);

    /**
     * 显示 / 隐藏左栏的提示条。
     *
     * @param text - 提示文案；空串表示不提示
     * @param isError - 是否是错误提示（红色）
     */
    const showMessage = (text: string, isError: boolean): void => {
        message.textContent = text;
        message.classList.toggle('cm-md-preview-error', isError);
        message.style.display = text ? '' : 'none';
    };

    // -------------------------------------------------------------------------
    // 即时渲染
    // -------------------------------------------------------------------------
    /** 渲染序号：mermaid 渲染是异步的，连着敲字会有好几次同时在飞，只认最后一次。 */
    let renderSeq = 0;
    /** 用户自己滚轮缩放过 / 拖动过之后，实时渲染不再自动回正。 */
    let userAdjusted = false;
    const markUserAdjusted = (): void => {
        userAdjusted = true;
    };
    viewport.addEventListener('wheel', markUserAdjusted, { passive: true });
    viewport.addEventListener('mousedown', markUserAdjusted);
    cleanupBag.push(() => {
        viewport.removeEventListener('wheel', markUserAdjusted);
        viewport.removeEventListener('mousedown', markUserAdjusted);
    });

    /**
     * 渲染一份 Mermaid 源码并换掉左栏的图。
     *
     * 失败不抛给外面：语法错是编辑过程中的常态，左边红字提示、右边继续编辑即可。
     *
     * @param source - 要渲染的源码
     */
    const applySource = async (source: string): Promise<void> => {
        const seq = ++renderSeq;
        if (!source.trim()) {
            rendered.innerHTML = '';
            showMessage('（空图表）', false);
            return;
        }
        try {
            const svg = await renderMermaidSource(source);
            // 期间又有更新的输入 → 这一次的结果已经过期，丢掉
            if (seq !== renderSeq) return;
            rendered.innerHTML = svg;
            showMessage('', false);
            // 只在用户没自己调过视角时回正：不然每敲一个字，画面就弹回默认缩放
            if (!userAdjusted) queuePreviewFit(() => panZoom.fitToViewport());
        } catch (error) {
            if (seq !== renderSeq) return;
            const detail = error instanceof Error ? error.message : String(error);
            showMessage(`Mermaid 渲染失败: ${detail}`, true);
        }
    };

    // -------------------------------------------------------------------------
    // 输入：重渲染（300ms）与回写文档（800ms）两条防抖链
    // -------------------------------------------------------------------------
    let renderTimer = 0;
    let commitTimer = 0;
    cleanupBag.push(() => {
        window.clearTimeout(renderTimer);
        window.clearTimeout(commitTimer);
        // 关闭前把还没写回的那一次补上，否则最后不到 0.8 秒里敲的字会丢
        if (options.onSourceCommit) {
            options.onSourceCommit(editor.value);
        }
    });

    editor.addEventListener('input', () => {
        window.clearTimeout(renderTimer);
        renderTimer = window.setTimeout(
            () => void applySource(editor.value),
            MERMAID_LIVE_RENDER_DELAY_MS
        );

        // 回写会重建整篇装饰（比渲染贵），所以更慢一拍
        if (options.onSourceCommit) {
            window.clearTimeout(commitTimer);
            commitTimer = window.setTimeout(() => {
                options.onSourceCommit?.(editor.value);
            }, MERMAID_LIVE_COMMIT_DELAY_MS);
        }
    });
    // 代码框自己吃键盘事件，别冒泡到编辑器的快捷键上；**Esc 要放行**，
    // 那是在外壳上监听的"关闭浮层"
    editor.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') {
            event.stopPropagation();
        }
    });

    options.mountHost.appendChild(root);
    root.tabIndex = -1;
    root.focus({ preventScroll: true });

    void applySource(options.source);
}

/**
 * 创建预览失败或加载中的提示块。
 *
 * @param text - 提示文案
 * @returns 提示节点
 */
function createPreviewFallback(text: string): HTMLElement {
    const fallback = document.createElement('div');
    fallback.className = 'cm-md-preview-fallback';
    fallback.textContent = text;
    return fallback;
}

/**
 * 渲染 Mermaid 源码为 SVG。
 *
 * @param source - Mermaid 源文本
 * @returns SVG 字符串
 */
async function renderMermaidSource(source: string): Promise<string> {
    const cached = mermaidSvgCache.get(source);
    if (cached) {
        return cached;
    }

    const inflight = mermaidRenderPromises.get(source);
    if (inflight) {
        return inflight;
    }

    const mermaid = await import('mermaid');
    if (!mermaidInitialized) {
        const theme = getMermaidTheme();
        mermaid.default.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: theme === 'dark' ? 'dark' : 'default',
            themeVariables:
                theme === 'dark'
                    ? {
                          primaryColor: '#1f2020',
                          primaryBorderColor: '#555',
                          primaryTextColor: '#d4d4d4',
                          lineColor: '#666',
                          secondaryColor: '#2a2d35',
                          tertiaryColor: '#30353f',
                      }
                    : {
                          primaryColor: '#ffffff',
                          primaryBorderColor: '#d0d7de',
                          primaryTextColor: '#24292e',
                          lineColor: '#656d76',
                          secondaryColor: '#f6f8fa',
                          tertiaryColor: '#eff1f3',
                      },
        });
        setMermaidInitialized(true);
    }

    const renderId = `mermaid-preview-${mermaidRenderSequence++}`;
    const promise = mermaid.default.render(renderId, source).then(({ svg }) => {
        rememberMermaidSvg(source, svg);
        return svg;
    });
    mermaidRenderPromises.set(source, promise);

    try {
        return await promise;
    } finally {
        mermaidRenderPromises.delete(source);
    }
}
