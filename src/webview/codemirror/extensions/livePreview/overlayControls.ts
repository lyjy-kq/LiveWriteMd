/**
 * 预览浮层（从 previewOverlay.ts 拆出）：操作按钮组与拖拽缩放（attachPanZoom）。
 *
 * @module webview/codemirror/extensions/livePreview/overlayControls
 */

import { canStepMediaWidth } from './mediaWidth.js';
import { PreviewActionOptions, flashButtonState, showPreviewActionStatus } from './overlayShell.js';

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
export function attachPanZoom(viewport: HTMLElement, stage: HTMLElement): {
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
export function queuePreviewFit(fitToViewport: () => boolean): void {
    requestAnimationFrame(() => {
        fitToViewport();
    });
}

/**
 * 把浮层挂进宿主，并在必要时补一层「主题传送门」。
 *
 * CodeMirror 的 baseTheme / EditorView.theme 生成的 CSS 选择器都带
 * `.<ͼN> ...` 作用域前缀（`ͼ` = U+037C，style-mod 自动生成的类名）。
 * 浮层挂在 `view.dom` 里时天然继承这些类；但导图节点的 mini-CM 位于
 * world(translate)+scaler(scale) 变换层，`position: fixed` 会相对变换祖先
 * 定位并可能被裁掉，只能挂 `document.body` —— 此时祖先链上没有主题类，
 * 浮层会退化成无样式的文档流块（放大按钮看起来「没反应」）。
 *
 * 这里复制编辑器根上的全部 `ͼ*` 主题类到一个 portal 上，既保住样式作用域，
 * 又不把 `cm-editor`（position: relative / flex 布局）带到 body 上。
 *
 * @param host - 挂载容器
 * @param root - 浮层根节点
 * @param themeScope - 编辑器根节点（可选）
 * @returns 实际挂进宿主的节点（portal 或 root），关闭时删它即可
 */
