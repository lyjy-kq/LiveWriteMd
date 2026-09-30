/**
 * 直播预览 Widget 集合。
 *
 * 这个文件集中承载 Markdown 各类渲染 Widget 的实现，避免单个文件继续膨胀。
 * Mermaid 预览相关的复制入口会复用预览浮层中的统一实现。
 *
 * @module webview/codemirror/extensions/livePreview/widgets
 */

import { Transaction } from '@codemirror/state';
import { EditorView, WidgetType } from '@codemirror/view';
import {
    applySafeFontStyles,
    measureText,
    renderInlineMarkdown,
    resolvePreviewImageUrl,
} from './helpers.js';
import {
    copyToClipboard,
    foldedListItems,
    foldToggleEffect,
    getMermaidTheme,
    sourceModeEffect,
    mermaidHeightCache,
    mermaidInitialized,
    mermaidRenderPromises,
    mermaidSvgCache,
    setMermaidInitialized,
    rememberMermaidSvg,
    rememberWidgetHeight,
    widgetHeightCache,
} from './state.js';
import {
    createMediaResizeGroup,
    createPreviewActionGroup,
    copyMermaidRenderedImageSafely,
    openImagePreviewOverlay,
    openMermaidPreviewOverlay,
} from './previewOverlay.js';
import { DEFAULT_MEDIA_WIDTH_PERCENT, stepMediaWidthPercent } from './mediaWidth.js';
import type { FrontmatterProperty } from './types.js';

// =============================================================================
// 媒体宽度调整（图片 / Mermaid 共用）
// =============================================================================

/**
 * 判断事件是否来自宽度调整按钮。
 *
 * CodeMirror 的 WidgetType.ignoreEvent 决定要不要让编辑器接着处理这个事件，
 * 缩放按钮必须返回 true，否则按钮自己的 mousedown 会被编辑器吞掉。
 *
 * @param event - 待判断的事件
 * @returns 事件是否发生在缩放按钮组内
 */
function isMediaResizeEvent(event: Event): boolean {
    const target = event.target;
    return target instanceof Element && target.closest('.cm-md-resize-actions') !== null;
}

/**
 * 把宽度调整按钮组追加到预览操作胶囊里。
 *
 * 拿不到回写通道时（例如源码范围不全的图片分支）就不放按钮，
 * 避免用户点了没反应。图片和 Mermaid 的处理完全一致，所以两处共用。
 *
 * @param actionGroup - createPreviewActionGroup 返回的胶囊容器
 * @param percent - 当前宽度百分比
 * @param subject - 被调整的对象名称，用于按钮提示
 * @param onWidthCommit - 宽度变化后的回写回调
 * @param view - 当前编辑器视图，由 widget 在渲染时注入
 * @returns void
 */
function appendMediaResizeGroup(
    actionGroup: HTMLElement,
    percent: number,
    subject: string,
    onWidthCommit: ((view: EditorView, percent: number) => void) | null,
    view: EditorView
): void {
    if (!onWidthCommit) {
        return;
    }

    actionGroup.appendChild(
        createMediaResizeGroup(percent, subject, (delta: number) => {
            const next = stepMediaWidthPercent(percent, delta);
            if (next !== percent) {
                onWidthCommit(view, next);
            }
        })
    );
}

// =============================================================================
// Simple Widgets
// =============================================================================

/**
 * Widget that renders a horizontal rule (---).
 */
export class HorizontalRuleWidget extends WidgetType {
    toDOM(): HTMLElement {
        const hr = document.createElement('hr');
        hr.className = 'cm-md-hr';
        return hr;
    }

    ignoreEvent(event: Event): boolean {
        // 默认实现会忽略 widget 里的所有事件，那样点到分隔线上光标不进这一行，
        // 也就永远看不到 `---` 的源码。单击放行给编辑器，光标落到这一行即展开。
        return event.type !== 'mousedown';
    }

    eq(): boolean {
        return true;
    }
}

/**
 * \u65e0\u5e8f\u5217\u8868\u7684\u5706\u70b9\u3002
 *
 * \u5706\u70b9\u9876\u6389\u7684\u662f\u6e90\u7801\u91cc\u7684 `- `\uff08\u6807\u8bb0\u7b26 + \u4e00\u4e2a\u7a7a\u683c\uff09\uff0c\u5982\u679c\u5bbd\u5ea6\u5199\u6b7b\uff08\u539f\u6765\u5199\u7684\u662f 1.2em\uff09\uff0c
 * \u6e32\u67d3\u6001\u548c\u6587\u672c\u6001\u7684\u884c\u5185\u8d77\u70b9\u5c31\u4f1a\u5dee\u51e0\u4e2a\u50cf\u7d20\uff0c\u6253\u5b57\u65f6\u540e\u9762\u7684\u6587\u5b57\u4f1a\u6a2a\u7740\u8df3\u3002
 * \u6240\u4ee5\u8fd9\u91cc\u6309\u5b9e\u9645\u91cf\u51fa\u6765\u7684 `- ` \u5bbd\u5ea6\u7ed9\u5706\u70b9\u5b9a\u5bbd\uff0c\u8ba9\u4e24\u79cd\u72b6\u6001\u5de6\u53f3\u5b8c\u5168\u5bf9\u9f50\u3002
 */
export class BulletWidget extends WidgetType {
    /** \u6807\u8bb0\u7b26\u81ea\u8eab\u5bbd\u5ea6\uff08px\uff09\uff0c\u5706\u70b9\u5706\u5fc3\u8981\u7528 */
    private readonly markerWidth: number;
    /** \u7a7a\u683c\u5bbd\u5ea6\uff08px\uff09 */
    private readonly spaceWidth: number;
    /** \u76d2\u5b50\u603b\u5bbd = \u6807\u8bb0\u7b26 + \u7a7a\u683c\uff08px\uff09 */
    private readonly width: number;

    /**
     * @param marker - \u6e90\u7801\u91cc\u7684\u6807\u8bb0\u7b26\uff08`-` / `*` / `+`\uff09\uff0c\u7528\u6765\u91cf\u5b83\u52a0\u4e0a\u7a7a\u683c\u6709\u591a\u5bbd
     *
     * \u5bbd\u5ea6\u5728**\u6784\u9020\u65f6**\u5c31\u91cf\u597d\u7f13\u5b58\uff1a\u4e00\u65b9\u9762 toDOM \u76f4\u63a5\u7528\uff0c\u53e6\u4e00\u65b9\u9762 eq \u8981\u9760\u5b83\u3002
     * \u9996\u6b21\u6784\u5efa\u53d1\u751f\u5728\u89c6\u56fe\u6302\u8f7d\u524d\uff0cgetMeasureContext \u53ea\u80fd\u9000\u56de body \u5b57\u4f53\uff0c
     * \u91cf\u51fa\u6765\u7684\u662f\u9519\u7684\u7a84\u5bbd\u5ea6\uff1b\u6302\u8f7d\u540e\u8865\u7b97\uff08\u89c1 plugin.ts \u7684 bootstrap\uff09
     * \u4f1a\u91cd\u5efa\u88c5\u9970\u3001\u65b0\u5efa\u672c\u7c7b\u5b9e\u4f8b\uff0ceq \u5fc5\u987b\u8bc6\u522b\u51fa\u5bbd\u5ea6\u53d8\u4e86\uff0c
     * \u65e7 DOM \u624d\u4e0d\u4f1a\u88ab\u590d\u7528\u3002
     */
    constructor(private marker = '-') {
        super();
        // \u91cf\u4e0d\u5230\uff08\u6781\u5c11\u89c1\uff09\u5c31\u4fdd\u6301 0\uff0ctoDOM \u9000\u56de\u6837\u5f0f\u8868\u91cc\u7684 em \u515c\u5e95\u503c
        this.markerWidth = measureText(this.marker, '400');
        this.spaceWidth = measureText(' ', '400');
        this.width = this.markerWidth + this.spaceWidth;
    }

    toDOM(): HTMLElement {
        const span = document.createElement('span');
        span.className = 'cm-md-bullet';
        span.textContent = '\u2022';
        if (this.width > 0) {
            span.style.width = `${this.width.toFixed(2)}px`;
            // \u5706\u70b9\u8981\u4ee5 **`-` \u7684\u4e2d\u70b9** \u4e3a\u5706\u5fc3\uff08\u9700\u6c42 3\uff09\u3002
            // \u76d2\u5b50\u91cc text-align: center \u628a\u5706\u70b9\u653e\u5728 `- ` \u7684\u6b63\u4e2d\uff0c
            // \u6bd4 `-` \u7684\u4e2d\u70b9\u504f\u53f3\u4e86\u534a\u4e2a\u7a7a\u683c\uff08\u7a7a\u683c\u4e0d\u53c2\u4e0e\u201c\u4e2d\u70b9\u201d\uff09\uff0c
            // \u6240\u4ee5\u6574\u4f53\u5de6\u79fb\u534a\u4e2a\u7a7a\u683c\u5bbd\u3002
            // \u7528 transform \u800c\u4e0d\u6539 width\uff1a\u76d2\u5b50\u5bbd\u5ea6\u4e0d\u80fd\u53d8\uff0c
            // \u5b83\u8fd8\u8981\u628a\u540e\u9762\u7684\u6b63\u6587\u9876\u5230\u6e90\u7801\u91cc\u90a3\u4e2a\u4f4d\u7f6e\u4e0a\u3002
            span.style.transform = `translateX(${(-this.spaceWidth / 2).toFixed(2)}px)`;
        }
        return span;
    }

    ignoreEvent(event: Event): boolean {
        // \u9ed8\u8ba4\u5b9e\u73b0\u4f1a\u5ffd\u7565 widget \u91cc\u7684\u6240\u6709\u4e8b\u4ef6\uff0c\u70b9\u5230\u5706\u70b9\u4e0a\u5149\u6807\u4e0d\u52a8\u3001\u8fd9\u4e00\u884c\u4e5f\u8fdb\u4e0d\u4e86\u7f16\u8f91\u6001\u3002
        // \u5355\u51fb\u653e\u884c\uff1a\u5149\u6807\u843d\u5230\u8fd9\u4e00\u884c\uff0c\u5c31\u80fd\u770b\u5230 `- ` \u7684\u6e90\u7801\uff08\u4e00\u6b21\u53ea\u6709\u4e00\u884c\u5c55\u5f00\uff09\u3002
        return event.type !== 'mousedown';
    }

    eq(other: BulletWidget): boolean {
        // marker \u76f8\u540c\u8fd8\u4e0d\u591f\uff1a\u5b57\u4f53\u6d4b\u91cf\u4e0a\u4e0b\u6587\u4ece body \u5207\u5230\u6b63\u6587\u540e\u5bbd\u5ea6\u4f1a\u53d8\uff0c
        // \u5bbd\u5ea6\u4e0d\u540c\u5fc5\u987b\u91cd\u5efa DOM\uff0c\u5426\u5219\u65e7\u7684\u9519\u8bef\u7a84\u5bbd\u5ea6\u4f1a\u4e00\u76f4\u7559\u7740
        return (
            this.marker === other.marker &&
            // \u91cf\u5316\u5230 0.01px \u518d\u6bd4\uff0c\u907f\u5f00\u6d6e\u70b9\u5c3e\u5dee\u5bfc\u81f4\u7684\u65e0\u8c13\u91cd\u5efa
            Math.round(this.width * 100) === Math.round(other.width * 100)
        );
    }
}

/**
 * 渲染标题中 `<font>` 包裹文本的安全内联 widget。
 */
export class FontTextWidget extends WidgetType {
    /** 经过白名单过滤后的 CSS 声明。 */
    private readonly styles: Array<[string, string]>;
    /** `<font>` 标签内的原始文本内容。 */
    private readonly content: string;

    /**
     * 创建字体文本 widget。
     *
     * @param styles - 解析后的安全 CSS 声明列表。
     * @param content - `<font>` 标签内的原始文本内容。
     */
    constructor(styles: Array<[string, string]>, content: string) {
        super();
        this.styles = styles;
        this.content = content;
    }

    /**
     * 比较两个 widget 是否可以复用。
     *
     * @param other - 需要比较的另一个 widget。
     * @returns 两个 widget 是否表示同一段内容。
     */
    eq(other: FontTextWidget): boolean {
        return (
            this.styles.length === other.styles.length &&
            this.styles.every(
                ([property, value], index) =>
                    property === other.styles[index]?.[0] && value === other.styles[index]?.[1]
            ) &&
            this.content === other.content
        );
    }

    /**
     * 生成用于预览的 DOM 节点。
     *
     * @returns 渲染后的 span 节点。
     */
    toDOM(): HTMLElement {
        const span = document.createElement('span');
        span.className = 'cm-md-font-text';
        applySafeFontStyles(span, this.styles);
        span.innerHTML = renderInlineMarkdown(this.content);
        return span;
    }
}

// =============================================================================
// Frontmatter Widget
// =============================================================================

/**
 * Widget that renders YAML frontmatter as an Obsidian-style properties panel.
 */
export class FrontmatterWidget extends WidgetType {
    private cacheKey: string;
    constructor(private properties: FrontmatterProperty[]) {
        super();
        this.cacheKey = 'fm-' + JSON.stringify(properties);
    }
    get estimatedHeight(): number {
        return widgetHeightCache.get(this.cacheKey) || 100;
    }

    eq(other: FrontmatterWidget): boolean {
        if (this.properties.length !== other.properties.length) return false;
        return this.properties.every(
            (p, i) => p.key === other.properties[i].key && p.value === other.properties[i].value
        );
    }

    ignoreEvent(): boolean {
        return false;
    }

    toDOM(view: EditorView): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'cm-md-frontmatter';

        // Header
        const header = document.createElement('div');
        header.className = 'cm-md-frontmatter-header';
        const headerIcon = document.createElement('span');
        headerIcon.className = 'cm-md-frontmatter-header-icon';
        headerIcon.textContent = '\u{1F4C4}'; // 📄
        header.appendChild(headerIcon);
        const headerText = document.createElement('span');
        headerText.textContent = '\u30D7\u30ED\u30D1\u30C6\u30A3'; // プロパティ
        header.appendChild(headerText);
        wrapper.appendChild(header);

        // Properties grid
        const grid = document.createElement('div');
        grid.className = 'cm-md-frontmatter-grid';

        for (const prop of this.properties) {
            // Icon cell
            const icon = document.createElement('div');
            icon.className = 'cm-md-frontmatter-icon';
            icon.textContent = '\u2261'; // ≡
            grid.appendChild(icon);

            // Key cell
            const key = document.createElement('div');
            key.className = 'cm-md-frontmatter-key';
            key.textContent = prop.key;
            grid.appendChild(key);

            // Value cell
            const value = document.createElement('div');
            value.className = 'cm-md-frontmatter-value';
            value.textContent = prop.value;
            grid.appendChild(value);
        }

        wrapper.appendChild(grid);
        // Measure height after mount and notify CM6 to update line height map
        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver((entries) => {
                for (let entry of entries) {
                    const h = entry.borderBoxSize?.[0]?.blockSize || entry.contentRect.height;
                    if (h > 0) rememberWidgetHeight(this.cacheKey, h);
                }
                view.requestMeasure();
            });
            requestAnimationFrame(() => {
                if (wrapper.isConnected) ro.observe(wrapper);
            });
        }
        return wrapper;
    }
}

// =============================================================================
// Interactive Widgets
// =============================================================================

/**
 * Widget that renders a checkbox for task list items.
 * Clicking toggles between [ ] and [x] in the document.
 */
export class CheckboxWidget extends WidgetType {
    constructor(
        private checked: boolean,
        private pos: number
    ) {
        super();
    }

    eq(other: CheckboxWidget): boolean {
        return this.checked === other.checked;
    }

    ignoreEvent(event: Event): boolean {
        return event.type === 'mousedown';
    }

    toDOM(view: EditorView): HTMLElement {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = this.checked;
        input.className = 'cm-md-checkbox';
        input.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const newText = this.checked ? '[ ]' : '[x]';
            view.dispatch({
                changes: { from: this.pos, to: this.pos + 3, insert: newText },
                annotations: Transaction.userEvent.of('input.checkbox-toggle'),
            });
        });
        return input;
    }
}

/**
 * Widget that renders an inline image preview.
 * Only supports https:// and data: URLs, or relative paths via documentBaseUri.
 */
export class ImageWidget extends WidgetType {
    /** 图片原始地址。 */
    constructor(
        private url: string,
        /** 图片替代文本。 */
        private alt: string,
        /** 图片在源码中的位置范围。 */
        private sourceFrom: number,
        /** 图片在源码中的结束位置。 */
        private sourceTo: number,
        /**
         * 图片标题提交后的回写函数。
         *
         * 回调第一个参数是 EditorView：decoration 由 StateField 构建，那一层拿不到
         * 视图，只有 widget 的 toDOM(view) 才有，所以在渲染时注入。
         */
        private onTitleCommit: ((view: EditorView, title: string) => void) | null = null,
        /** 图片宽度占正文宽度的百分比。 */
        private widthPercent: number = DEFAULT_MEDIA_WIDTH_PERCENT,
        /** 宽度调整后的回写函数，同样由渲染时注入 EditorView。 */
        private onWidthCommit: ((view: EditorView, percent: number) => void) | null = null
    ) {
        super();
    }

    eq(other: ImageWidget): boolean {
        // 宽度也要参与比较：宽度变化时源码变了，但 url/alt 没变，
        // 少了这一项 CodeMirror 会复用旧 widget，DOM 上的宽度就不会更新。
        return (
            this.url === other.url &&
            this.alt === other.alt &&
            this.widthPercent === other.widthPercent
        );
    }

    ignoreEvent(event: Event): boolean {
        // 宽度调整按钮要走自己的 mousedown 逻辑，不能被 CodeMirror 当成普通点击吞掉。
        if (isMediaResizeEvent(event)) return true;
        // 双击自己处理（进源码模式），不能被当成选词。
        // 滚轮不再拦截：图片没有缩放功能，滚轮应该照常滚文档。
        return event.type === 'dblclick';
    }

    /**
     * 创建图片预览 DOM。
     *
     * 图片本体仍保持内联渲染，右下角追加放大与复制按钮。
     *
     * @returns 图片预览节点
     */
    toDOM(view: EditorView): HTMLElement {
        const wrapper = document.createElement('span');
        wrapper.className = 'cm-md-image-wrapper';
        // 宽度通过 CSS 变量下发，样式表里统一用 max-width 消费，
        // 这样默认档位和小图不会被拉伸变形。
        wrapper.style.setProperty('--cm-md-media-width', `${this.widthPercent}%`);
        const contentHost = document.createElement('span');
        contentHost.className = 'cm-md-image-content';
        wrapper.appendChild(contentHost);
        // 单击不改外观：图片始终保持在渲染态，只有双击才摊开成 `![alt](url)` 源码
        wrapper.addEventListener('dblclick', (event: MouseEvent) => {
            // 只读模式（Viewer）只看不改，双击不切源码
            if (!view.state.facet(EditorView.editable)) return;
            event.preventDefault();
            event.stopPropagation();
            view.dispatch({
                selection: { anchor: this.sourceFrom },
                effects: sourceModeEffect.of({ from: this.sourceFrom, to: this.sourceTo }),
            });
        });

        wrapper.addEventListener('click', (event: MouseEvent) => {
            if (!(event.ctrlKey || event.metaKey)) {
                return;
            }

            const rawUrl = this.url.trim();
            if (
                !rawUrl ||
                rawUrl.startsWith('http://') ||
                rawUrl.startsWith('https://') ||
                rawUrl.startsWith('data:')
            ) {
                return;
            }

            const openPath = rawUrl.split('#')[0].split('?')[0].trim();
            if (!openPath) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const vscodeApi = (window as any).__vscodeApi;
            if (vscodeApi) {
                vscodeApi.postMessage({ type: 'openFile', path: openPath });
            }
        });

        // 统一把远程地址与本地相对路径解析成 webview 可访问地址。
        const resolvedUrl = resolvePreviewImageUrl(this.url);
        // 浮层的 onTitleCommit 只回传标题文本，这里把渲染时的 view 补进去。
        const commitTitle = this.onTitleCommit;
        const actionGroup = createPreviewActionGroup(
            '放大查看图片',
            '复制图片',
            () => {
                openImagePreviewOverlay({
                    rawUrl: this.url,
                    resolvedUrl,
                    altText: this.alt,
                    titleText: this.alt || null,
                    onTitleCommit: commitTitle ? (title: string) => commitTitle(view, title) : undefined,
                    mountHost: view.dom,
                });
            },
            async () => {
                if (!resolvedUrl) {
                    throw new Error('image url not resolved');
                }

                const response = await fetch(resolvedUrl);
                if (!response.ok) {
                    throw new Error('image fetch failed');
                }

                const blob = await response.blob();
                if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
                    throw new Error('clipboard image write unavailable');
                }

                const mimeType = blob.type || 'image/png';
                await navigator.clipboard.write([new ClipboardItem({ [mimeType]: blob })]);
            }
        );
        // 缩放按钮并进右下角同一个胶囊，共用现成的定位与底色。
        appendMediaResizeGroup(actionGroup, this.widthPercent, '图片', this.onWidthCommit, view);
        wrapper.appendChild(actionGroup);

        if (resolvedUrl) {
            const img = document.createElement('img');
            img.src = resolvedUrl;
            img.alt = this.alt;
            img.className = 'cm-md-image';
            // 图片是异步加载的，加载完高度才定下来。这里让 CodeMirror 重新量一次，
            // 否则它按加载前的高度算总高度，滚动条位置会对不上。
            img.addEventListener('load', () => view.requestMeasure());
            img.onerror = () => {
                contentHost.replaceChildren();
                const fallback = document.createElement('span');
                fallback.className = 'cm-md-image-fallback';
                fallback.textContent = this.alt || '[image]';
                contentHost.appendChild(fallback);
            };
            contentHost.appendChild(img);
        } else {
            const fallback = document.createElement('span');
            fallback.className = 'cm-md-image-fallback';
            fallback.textContent = this.alt || '[image]';
            contentHost.appendChild(fallback);
        }

        return wrapper;
    }
}

/**
 * Widget that renders a fold arrow for parent list items.
 * Clicking toggles the fold state and forces a view re-render.
 */
export class FoldArrowWidget extends WidgetType {
    constructor(
        private lineFrom: number,
        private folded: boolean
    ) {
        super();
    }

    eq(other: FoldArrowWidget): boolean {
        return this.lineFrom === other.lineFrom && this.folded === other.folded;
    }

    ignoreEvent(event: Event): boolean {
        return event.type === 'mousedown';
    }

    toDOM(view: EditorView): HTMLElement {
        const span = document.createElement('span');
        span.className =
            'cm-md-fold-arrow' +
            (this.folded ? ' cm-md-fold-arrow-collapsed' : ' cm-md-fold-arrow-open');
        span.textContent = '\u25BC'; // Always ▼, rotated via CSS for collapsed
        span.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            if (foldedListItems.has(this.lineFrom)) {
                foldedListItems.delete(this.lineFrom);
            } else {
                foldedListItems.add(this.lineFrom);
            }
            // Force decoration rebuild via StateEffect
            view.dispatch({ effects: foldToggleEffect.of(null) });
        });
        return span;
    }
}

// =============================================================================
// Code Block Copy Widget
// =============================================================================

/**
 * Widget that renders a "Copy" button on code blocks.
 * Clicking copies the code content to the clipboard.
 */
export class CodeBlockCopyWidget extends WidgetType {
    /** 按钮显示文案，默认使用代码块语言 */
    private label: string;
    /** 代码块正文，用于复制到剪贴板 */
    constructor(private codeContent: string, label: string) {
        super();
        this.label = label || 'go';
    }

    eq(other: CodeBlockCopyWidget): boolean {
        return this.codeContent === other.codeContent && this.label === other.label;
    }

    ignoreEvent(): boolean {
        return true;
    }

    toDOM(): HTMLElement {
        const btn = document.createElement('span');
        btn.className = 'cm-md-codeblock-copy';
        btn.textContent = this.label;
        btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            copyToClipboard(this.codeContent)
                .then(() => {
                    btn.textContent = 'Copied!';
                    setTimeout(() => {
                        btn.textContent = this.label;
                    }, 1500);
                })
                .catch(() => {
                    btn.textContent = 'Failed';
                    setTimeout(() => {
                        btn.textContent = this.label;
                    }, 1500);
                });
        });
        return btn;
    }
}

// =============================================================================
// Footnote Widgets
// =============================================================================

/**
 * Widget that renders a footnote reference as a superscript number.
 */
export class FootnoteRefWidget extends WidgetType {
    constructor(
        private label: string,
        private index: number
    ) {
        super();
    }

    eq(other: FootnoteRefWidget): boolean {
        return this.label === other.label && this.index === other.index;
    }

    ignoreEvent(event: Event): boolean {
        return event.type === 'mousedown';
    }

    toDOM(view: EditorView): HTMLElement {
        const sup = document.createElement('sup');
        sup.className = 'cm-md-footnote-ref';
        sup.textContent = String(this.index);
        sup.title = `[^${this.label}] (Click to jump)`;
        sup.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            // Search for footnote definition [^label]:
            const doc = view.state.doc;
            const pattern = `[^${this.label}]:`;
            for (let i = 1; i <= doc.lines; i++) {
                const line = doc.line(i);
                const trimmed = line.text.trimStart();
                if (trimmed.startsWith(pattern)) {
                    view.dispatch({
                        selection: { anchor: line.from },
                        scrollIntoView: true,
                    });
                    view.focus();
                    return;
                }
            }
        });
        return sup;
    }
}

/**
 * Widget that renders a footnote definition label as a styled badge.
 */
export class FootnoteDefWidget extends WidgetType {
    constructor(
        private label: string,
        private index: number
    ) {
        super();
    }

    eq(other: FootnoteDefWidget): boolean {
        return this.label === other.label && this.index === other.index;
    }

    toDOM(): HTMLElement {
        const span = document.createElement('span');
        span.className = 'cm-md-footnote-def-label';
        span.textContent = String(this.index);
        span.title = `[^${this.label}]`;
        return span;
    }
}

// =============================================================================
// Details Widget
// =============================================================================

/**
 * Widget that renders a foldable <details>/<summary> block.
 */
export class DetailsWidget extends WidgetType {
    private cacheKey: string;
    constructor(
        private summary: string,
        private content: string
    ) {
        super();
        // hash the content briefly
        this.cacheKey = 'dt-' + this.summary + '-' + this.content.substring(0, 20);
    }
    get estimatedHeight(): number {
        return widgetHeightCache.get(this.cacheKey) || 40;
    }

    eq(other: DetailsWidget): boolean {
        return this.summary === other.summary && this.content === other.content;
    }

    ignoreEvent(event: Event): boolean {
        return event.type === 'mousedown' || event.type === 'click';
    }

    toDOM(view: EditorView): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'cm-md-details';

        const header = document.createElement('div');
        header.className = 'cm-md-details-summary';

        const arrow = document.createElement('span');
        arrow.className = 'cm-md-details-arrow';
        arrow.textContent = '\u25B6'; // ▶
        header.appendChild(arrow);

        const label = document.createElement('span');
        label.textContent = this.summary || 'Details';
        header.appendChild(label);
        wrapper.appendChild(header);

        const content = document.createElement('div');
        content.className = 'cm-md-details-content';
        content.style.display = 'none';
        // Render each line with inline Markdown support
        const lines = this.content.split('\n');
        content.innerHTML = lines.map((line) => `<p>${renderInlineMarkdown(line)}</p>`).join('');
        wrapper.appendChild(content);

        header.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            const isOpen = content.style.display !== 'none';
            content.style.display = isOpen ? 'none' : 'block';
            arrow.textContent = isOpen ? '\u25B6' : '\u25BC'; // ▶ or ▼
            wrapper.classList.toggle('cm-md-details-open', !isOpen);
            view.requestMeasure();
        });

        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver((entries) => {
                for (let entry of entries) {
                    const h = entry.borderBoxSize?.[0]?.blockSize || entry.contentRect.height;
                    if (h > 0) rememberWidgetHeight(this.cacheKey, h);
                }
                view.requestMeasure();
            });
            requestAnimationFrame(() => {
                if (wrapper.isConnected) ro.observe(wrapper);
            });
        }

        return wrapper;
    }
}

// =============================================================================
// Mermaid Widget
// =============================================================================

/**
 * Mermaid 预览 Widget。
 *
 * 这个 Widget 负责在正文中渲染 Mermaid 图表，并挂载放大与复制按钮。
 * 复制按钮会复用统一复制入口，把当前渲染出的 SVG 作为纯文本复制。
 */
export class MermaidWidget extends WidgetType {
    /** Mermaid 源文本。 */
    constructor(
        private source: string,
        /** 是否使用深色 Mermaid 主题。 */
        private isDark: boolean,
        /** Mermaid 在源码中的起始位置。 */
        private sourceFrom: number,
        /** Mermaid 在源码中的结束位置。 */
        private sourceTo: number,
        /** Mermaid 标题提交后的回写函数，EditorView 由渲染时注入。 */
        private onTitleCommit: ((view: EditorView, title: string) => void) | null = null,
        /** 图表宽度占正文宽度的百分比。 */
        private widthPercent: number = DEFAULT_MEDIA_WIDTH_PERCENT,
        /** 宽度调整后的回写函数，同样由渲染时注入 EditorView。 */
        private onWidthCommit: ((view: EditorView, percent: number) => void) | null = null
    ) {
        super();
    }

    eq(other: MermaidWidget): boolean {
        // 和 ImageWidget 同理，宽度必须参与比较，否则调整后 DOM 不会重建。
        return (
            this.source === other.source &&
            this.isDark === other.isDark &&
            this.widthPercent === other.widthPercent
        );
    }

    get estimatedHeight(): number {
        return mermaidHeightCache.get(this.source) || 350;
    }

    ignoreEvent(event: Event): boolean {
        // 宽度调整按钮要自己处理 mousedown，不能被编辑器吞掉。
        if (isMediaResizeEvent(event)) return true;
        // 双击自己处理（进源码模式），不能被当成选词。
        // 滚轮不再拦截：图表没有缩放功能，滚轮应该照常滚文档。
        return event.type === 'dblclick';
    }

    /**
     * 创建 Mermaid 预览 DOM。
     *
     * 右下角提供放大与复制按钮，放大后进入独立浮层查看器。
     *
     * @param view - 当前 CodeMirror 视图
     * @returns Mermaid 预览节点
     */
    toDOM(view: EditorView): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'cm-md-mermaid-wrapper';
        // 宽度通过 CSS 变量下发，和图片保持同一套消费方式。
        wrapper.style.setProperty('--cm-md-media-width', `${this.widthPercent}%`);
        const contentHost = document.createElement('div');
        contentHost.className = 'cm-md-mermaid-content';
        wrapper.appendChild(contentHost);

        // 单击不改外观，双击才摊开成 ```mermaid 源码
        wrapper.addEventListener('dblclick', (event: MouseEvent) => {
            // 只读模式（Viewer）只看不改，双击不切源码
            if (!view.state.facet(EditorView.editable)) return;
            event.preventDefault();
            event.stopPropagation();
            view.dispatch({
                selection: { anchor: this.sourceFrom },
                effects: sourceModeEffect.of({ from: this.sourceFrom, to: this.sourceTo }),
            });
        });

        // 浮层的 onTitleCommit 只回传标题文本，这里把渲染时的 view 补进去。
        const commitTitle = this.onTitleCommit;
        const actionGroup = createPreviewActionGroup(
            '放大查看图表',
            '复制 Mermaid 图',
            () => {
                // 正文区间在**打开浮层的这一刻**定位：比 toDOM 那一刻更贴近当前文档，
                // 之后由 commitMermaidSource 每次回写时就地维护终点
                const range = this.contentRangeOf(view);
                openMermaidPreviewOverlay({
                    source: this.source,
                    titleText: null,
                    onTitleCommit: commitTitle
                        ? (title: string) => commitTitle(view, title)
                        : undefined,
                    // 浮层里改完代码，把新源码写回围栏之间（见 commitMermaidSource）
                    onSourceCommit: (next: string) => this.commitMermaidSource(view, next, range),
                    mountHost: view.dom,
                });
            },
            async () => {
                const success = await copyMermaidRenderedImageSafely(contentHost);
                if (!success) {
                    throw new Error('copy failed');
                }
            }
        );
        appendMediaResizeGroup(actionGroup, this.widthPercent, '图表', this.onWidthCommit, view);
        wrapper.appendChild(actionGroup);

        const cached = mermaidSvgCache.get(this.source);
        if (cached) {
            contentHost.innerHTML = cached;
            return wrapper;
        }

        const placeholder = document.createElement('div');
        placeholder.className = 'cm-md-mermaid-placeholder';
        placeholder.textContent = 'Rendering diagram...';
        contentHost.appendChild(placeholder);

        this.renderAsync(contentHost, view);
        return wrapper;
    }

    /**
     * 算出文档里「围栏之间的正文」区间。
     *
     * 起点 = 首行围栏的换行之后；终点 = 末行围栏行首的换行之前。空代码块时两者相等，
     * 往这个空区间里插内容正好落在两个围栏中间。
     *
     * 返回的是**可变对象**：浮层里每写回一次，正文长度就变一次，终点由
     * commitMermaidSource 就地改写，不用每次重新扫文档找闭合围栏
     * （那样还可能被正文里恰好出现的一行 ``` 骗到）。
     *
     * @param view - 当前 CodeMirror 视图
     * @returns 正文区间（`from` 固定、`to` 会被回写逻辑改写）
     */
    private contentRangeOf(view: EditorView): { from: number; to: number } {
        const doc = view.state.doc;
        const startLine = doc.lineAt(Math.min(this.sourceFrom, doc.length));
        const endLine = doc.lineAt(Math.min(this.sourceTo, doc.length));
        const from = Math.min(startLine.to + 1, doc.length);
        return { from, to: Math.max(from, endLine.from - 1) };
    }

    /**
     * 把放大浮层里编辑好的源码写回文档：**只换围栏之间的正文**。
     *
     * 围栏本身（```mermaid + 标题 + `{width=50%}`）一个字都不动 ——
     * 那是 info 行的内容，和图表正文是两回事。
     *
     * @param view - 当前 CodeMirror 视图
     * @param next - 浮层右侧编辑框里的最新源码
     * @param range - contentRangeOf 给出的正文区间，会被就地更新
     */
    private commitMermaidSource(
        view: EditorView,
        next: string,
        range: { from: number; to: number }
    ): void {
        const doc = view.state.doc;
        // widget 记的是创建时的位置，万一文档在别处变短了，越界就静静放弃改写
        if (range.from > doc.length) return;
        // 起点前面应该是那个换了行的围栏：对不上号说明位置已经失效，宁可不写
        const fenceLine = doc.lineAt(range.from).number > 1 ? doc.line(doc.lineAt(range.from).number - 1) : null;
        if (!fenceLine || !fenceLine.text.trimStart().startsWith('```')) return;

        const to = Math.min(range.to, doc.length);
        if (doc.sliceString(range.from, to) === next) return; // 内容没变，别白打扰一次编辑器
        view.dispatch({ changes: { from: range.from, to, insert: next } });
        // 终点跟着新内容走：起点不会被自己的改写影响（改的永远是起点之后的部分）
        range.to = range.from + next.length;
    }

    private static renderCounter = 0;

    private async renderAsync(container: HTMLElement, view: EditorView): Promise<void> {
        try {
            // If the same source is already being rendered, wait for it
            const inflight = mermaidRenderPromises.get(this.source);
            if (inflight) {
                const svg = await inflight;
                container.innerHTML = svg;
                container.classList.add('cm-md-mermaid-rendered');
                return;
            }

            const mermaid = await import('mermaid');
            if (!mermaidInitialized) {
                const isDark = getMermaidTheme() === 'dark';
                mermaid.default.initialize({
                    startOnLoad: false,
                    securityLevel: 'strict',
                    theme: isDark ? 'dark' : 'default',
                    themeVariables: isDark
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

            // Use unique ID to prevent Mermaid render collisions
            const uniqueId = `mermaid-${MermaidWidget.renderCounter++}`;
            const promise = mermaid.default.render(uniqueId, this.source).then(({ svg }) => {
                rememberMermaidSvg(this.source, svg);
                return svg;
            });
            mermaidRenderPromises.set(this.source, promise);

            try {
                const svg = await promise;
                container.innerHTML = svg;
                container.classList.add('cm-md-mermaid-rendered');

                // Track actual rendered height via ResizeObserver (more reliable than getBoundingClientRect at render time)
                const src = this.source;
                if (typeof ResizeObserver !== 'undefined') {
                    const ro = new ResizeObserver((entries) => {
                        for (const entry of entries) {
                            const h =
                                entry.borderBoxSize?.[0]?.blockSize || entry.contentRect.height;
                            if (h > 0) {
                                mermaidHeightCache.set(src, h);
                                ro.disconnect();
                            }
                        }
                        view.requestMeasure();
                    });
                    requestAnimationFrame(() => {
                        if (container.isConnected) ro.observe(container);
                    });
                }
            } finally {
                mermaidRenderPromises.delete(this.source);
            }
        } catch (error) {
            container.innerHTML = '';
            const errorEl = document.createElement('div');
            errorEl.className = 'cm-md-mermaid-error';
            errorEl.textContent = `Diagram error: ${error instanceof Error ? error.message : String(error)}`;
            container.appendChild(errorEl);
        }
    }
}

// =============================================================================
// Math Widgets (KaTeX)
// =============================================================================

import katex from 'katex';
// KaTeX 样式注入与字符串渲染统一放在 mathRender.ts，表格单元格那边的公式
// 走的是同一个入口，样式只注入一次。
import { ensureKatexCss } from './mathRender.js';

/**
 * 「探针色」：KaTeX 用它去画自己没认下来的部分（未定义命令、解析错误）。
 *
 * 反引号里那段内容要不要当公式，是**猜**出来的 —— 猜错了不能把红字摆在正文中间
 * （见 InlineMathWidget），可这个失败又没有别的信号：`throwOnError: false` 既不抛异常，
 * 未定义命令连 `.katex-error` 节点都不给，只是一段红字裹在正常输出里。
 * 于是那一遍渲染特意把 errorColor 换成这个颜色，渲染完在 DOM 里搜它就行。
 *
 * 特意**不用** KaTeX 的默认错误色 `#cc0000`：用户完全可能自己在公式里写
 * `\textcolor{#cc0000}{…}`（那也是红的），换成这个洋红色就不会跟正常公式撞上。
 */
const MATH_PROBE_COLOR = '#ff00ff';

/**
 * 点击公式时，把光标放到「点击处对应的源码字符」上，从而切到文本模式。
 *
 * 为什么必须自己接管：公式是整段**替换**成 widget 的，而 `WidgetType.ignoreEvent`
 * 默认对所有事件返回 true（编辑器一律忽略 widget 里面的事件），所以点公式既不会
 * 移动光标、也不会展开源码——这就是「点公式没反应」的原因。
 *
 * 位置**由构造方传进来**（sourceFrom / sourceTo 是公式原文的准确区间），不去猜：
 * 早先的写法是拿 `posAtDOM(host, 0)` 当起点、再用 `indexOf(tex)` 往后找，
 * 多行公式一带缩进、或者块级 widget 的位置落在别处，就找不到、光标落到公式外面，
 * 表现就是「点中间没反应」。
 *
 * @param view - 当前编辑器视图
 * @param host - 公式 widget 的根节点
 * @param tex - 公式源码（不含定界符）
 * @param sourceFrom - 公式源码在文档里的起点
 * @param sourceTo - 公式源码在文档里的终点
 * @param event - 触发定位的鼠标事件
 */
function placeMathCaret(
    view: EditorView,
    host: HTMLElement,
    tex: string,
    sourceFrom: number,
    sourceTo: number,
    event: MouseEvent
): void {
    // 只读模式（Viewer）只让 CM6 照常处理，不动光标
    if (!view.state.facet(EditorView.editable)) return;

    const doc = view.state.doc;
    if (sourceFrom < 0 || sourceTo > doc.length || sourceFrom >= sourceTo) return;

    const rect = host.getBoundingClientRect();
    const ratioX = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    const ratioY = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0;

    // 多行公式：先按纵向比例选出第几行，再在那一行里按横向比例选字符
    const lines = tex.split('\n');
    const lineIndex = Math.max(0, Math.min(lines.length - 1, Math.round(ratioY * (lines.length - 1))));
    let offset = 0;
    for (let i = 0; i < lineIndex; i++) offset += lines[i].length + 1;
    offset += Math.round(ratioX * lines[lineIndex].length);

    // 落在公式区间内，别越界跑到别的段落上去
    const pos = Math.max(sourceFrom, Math.min(sourceTo, sourceFrom + offset));
    view.dispatch({ selection: { anchor: pos } });
    view.focus();
}

/**
 * Widget that renders an inline math expression ($...$).
 */
export class InlineMathWidget extends WidgetType {
    /**
     * @param tex - 公式源码（不含定界符）
     * @param sourceFrom - 公式源码在文档里的起点
     * @param sourceTo - 公式源码在文档里的终点
     * @param fallbackText - KaTeX 认不出这段内容时改显示的原文；null 表示照旧显示红字报错。
     *   只有**反引号那一路**会传（那里的内容本来是按代码写的，猜错了该显示得像没开这个功能，
     *   见 mathCollect.ts 的 collectCodeSpanMathDecorations）。
     */
    constructor(
        private tex: string,
        private sourceFrom: number,
        private sourceTo: number,
        private fallbackText: string | null = null
    ) {
        super();
    }

    eq(other: InlineMathWidget): boolean {
        return (
            this.tex === other.tex &&
            this.sourceFrom === other.sourceFrom &&
            this.sourceTo === other.sourceTo &&
            this.fallbackText === other.fallbackText
        );
    }

    toDOM(view: EditorView): HTMLElement {
        const span = document.createElement('span');
        span.className = 'cm-md-math-inline';
        // 点击公式 → 光标落在点击处 → 这一行进入文本模式（显示 $...$ 源码）
        span.addEventListener('mousedown', (event: MouseEvent) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            placeMathCaret(view, span, this.tex, this.sourceFrom, this.sourceTo, event);
        });
        let failed = false;
        try {
            ensureKatexCss();
            katex.render(this.tex, span, {
                throwOnError: false,
                output: 'htmlAndMathml',
                // 反引号那一路（fallbackText 非空）额外带上探针色，见下面的判定
                ...(this.fallbackText !== null ? { errorColor: MATH_PROBE_COLOR } : {}),
            });
        } catch (e) {
            console.error('[FlowMD] InlineMath KaTeX render error:', e, 'tex:', this.tex);
            failed = true;
        }

        // 反引号那一路还要挡住 KaTeX「不抛异常地失败」：throwOnError 为 false 时它不报错，
        // 而是把认不出来的部分用 errorColor 画成红字（解析错误给一个 `.katex-error` 节点，
        // 未定义命令 —— 比如 `` `C:\Users` `` 里的 `\Users` —— 则只是裹在正常输出里的一段红字），
        // 上面那个 try 一个都抓不到。所以那一遍特意换了个探针色，渲染完在 DOM 里搜一下：
        // 搜到就说明这段内容 KaTeX 没真认下来，退回原样的代码文本 ——
        // 那段内容本来就是按代码写的，猜错了就该看起来跟没开这个功能一样，
        // 而不是在正文中间摆一段红字。`$…$` 那一路不传 fallbackText，照旧显示红字报错
        // （那是用户自己写出来的公式，报错有用）。
        if (this.fallbackText !== null && (failed || span.innerHTML.includes(MATH_PROBE_COLOR))) {
            span.textContent = this.fallbackText;
        }
        return span;
    }
}

// =============================================================================
// 块级公式：固定 2.5 行高 + 超高缩放
// =============================================================================

/** 块级公式外框占几行正文。 */
const MATH_BLOCK_LINES = 2.5;

/**
 * 公式缩放比例缓存：key 是「框高 + 公式源码」。
 *
 * 量自然高度必须等元素挂进 DOM（toDOM 里量不到），所以第一次渲染是
 * 「先按原样挂上、下一帧量完再缩」。存下来之后，同一个公式再渲染就直接套缓存，
 * 首帧就是缩好的，不会闪。
 */
const mathScaleCache = new Map<string, number>();

/**
 * 正文的字号（px）。
 *
 * `.cm-content` 的 font-size 就是 `.cm-content` 那条规则算出来的
 * `--flowmd-editor-font-size × --flowmd-font-scale`，这里照抄一遍 ——
 * 只用在「连正文行都还没有」的首次构建里给行高兜底。
 *
 * @returns 正文字号（px），两个变量都读不到时按主题默认的 14px
 */
function contentFontSizePx(): number {
    const root = getComputedStyle(document.documentElement);
    const base = Number.parseFloat(root.getPropertyValue('--flowmd-editor-font-size'));
    const scale = Number.parseFloat(root.getPropertyValue('--flowmd-font-scale'));
    return Number.isFinite(base) ? base * (Number.isFinite(scale) ? scale : 1) : 14;
}

/**
 * 正文的行高（px）。
 *
 * 三级来源，越靠前越准：
 * 1. 页面上已经有正文行 —— 量它的计算行高（行高是用户可配的，量出来的最准）；
 * 2. 还没有（视图**首次构建**时一行都没有）—— 按 CSS 里用的同一个变量现算：
 *    `--flowmd-line-height` 是 `1.7em` 这种带 em 的写法时乘上正文字号，
 *    写成 `22px` 时直接用；
 * 3. 变量也读不到 —— 字号 × 1.7，即主题里那个兜底值。
 *
 * @returns 行高（px）
 */
function mathLineHeightPx(): number {
    const line = document.querySelector('#editor .cm-line');
    if (line) {
        const measured = Number.parseFloat(getComputedStyle(line).lineHeight);
        if (Number.isFinite(measured) && measured > 0) return measured;
    }
    const raw = getComputedStyle(document.documentElement)
        .getPropertyValue('--flowmd-line-height')
        .trim();
    const value = Number.parseFloat(raw);
    if (Number.isFinite(value) && value > 0) {
        return raw.endsWith('px') ? value : value * contentFontSizePx();
    }
    return contentFontSizePx() * 1.7;
}

/**
 * 块级公式外框的高度（px）= 2.5 行正文。
 *
 * 只给两件事用：**视口外的高度估算**（`estimatedHeight`）和缩放缓存的 key。
 * 框的真实高度由 CSS 算（styles.ts 里 `calc(2.5 * var(--flowmd-line-height))`），
 * 两边是同一条公式，所以这里算出来的和页面上量到的一致。
 *
 * **别拿它去写行内 style 的高度**：首次构建时 `.cm-line` 还不存在，
 * 行高只能猜（而且 `getMeasureContext()` 那时退到 body，字号是界面的 16px 而不是
 * 正文的 14px），猜出来的 68px 会被 CM 连同 DOM 一起缓存住 ——
 * widget.eq 为真时 DOM 复用、toDOM 不再跑，框就一直比正文高 8.5px，
 * 下面所有行的行号、点击落点跟着往上偏（2026-09-21 反馈）。
 *
 * @returns 外框高度（px）
 */
function mathBoxHeightPx(): number {
    return MATH_BLOCK_LINES * mathLineHeightPx();
}

/**
 * 把公式缩放到外框里。
 *
 * 缩放比例 = min(1, 可用高度 / 公式自然高度)：矮的公式原样显示（绝不放大小公式），
 * 比框高的（多行 aligned 之类）整体缩小后居中。transform 不影响布局，
 * 所以外面那 2.5 行的高度永远是稳定的。
 *
 * @param inner - 包着 KaTeX 输出的缩放层
 * @param tex - 公式源码（当缓存 key 用）
 * @returns void
 */
function fitMathToBox(inner: HTMLElement, tex: string): void {
    // 外框上下各 1px 边框要扣掉，公式才不会贴着边（框内上下没有 padding，见 styles.ts）
    const avail = mathBoxHeightPx() - 2;
    const key = `${Math.round(avail)}|${tex}`;

    const applyScale = (scale: number): void => {
        inner.style.transform = `scale(${scale.toFixed(4)})`;
    };

    const cached = mathScaleCache.get(key);
    if (cached !== undefined) {
        applyScale(cached);
        return;
    }

    // 第一帧量不到（元素还没进 DOM）：下一帧补量。
    // 外框高度是固定的，所以这一帧的量与不量都不会让下面的内容移位。
    requestAnimationFrame(() => {
        if (!inner.isConnected) return;
        const natural = inner.getBoundingClientRect().height;
        if (natural <= 0) return;
        const scale = Math.min(1, avail / natural);
        if (mathScaleCache.size > 200) mathScaleCache.clear();
        mathScaleCache.set(key, scale);
        applyScale(scale);
    });
}

/**
 * Widget that renders a block math expression ($$...$$).
 */
export class BlockMathWidget extends WidgetType {
    /**
     * @param tex - 公式源码（不含 `$$` 定界符）
     * @param sourceFrom - 公式源码在文档里的起点
     * @param sourceTo - 公式源码在文档里的终点
     */
    constructor(
        private tex: string,
        private sourceFrom: number,
        private sourceTo: number
    ) {
        super();
    }
    /**
     * 高度是**固定**的 2.5 行，不用量也知道 —— 视口外的公式靠它估高度，
     * 估得准，滚动条才不会跳。
     *
     * 这只是个估算：视口里的公式 CM 会拿真实盒高盖掉它（见 styles.ts 上的说明）。
     */
    get estimatedHeight(): number {
        return mathBoxHeightPx();
    }

    eq(other: BlockMathWidget): boolean {
        return (
            this.tex === other.tex &&
            this.sourceFrom === other.sourceFrom &&
            this.sourceTo === other.sourceTo
        );
    }

    /**
     * 让 CodeMirror 照常处理公式里的事件。
     *
     * 默认（返回 true）是「widget 里的事件编辑器一律不管」，那样点公式只会被我们
     * 自己的 mousedown 兜住；万一那一下没算准位置，用户就完全点不进去了。
     * 返回 false 之后，就算我们的计算失败，CodeMirror 也会把光标放到公式边界上，
     * 至少能进文本模式（只是光标没那么准），不会出现「点了没反应」。
     *
     * @returns 恒为 false
     */
    ignoreEvent(): boolean {
        return false;
    }

    toDOM(view: EditorView): HTMLElement {
        const div = document.createElement('div');
        div.className = 'cm-md-math-block';
        // 高度**不写行内 style**：由 styles.ts 的 `calc(2.5 * var(--flowmd-line-height))` 算。
        // 这里写死一段 px 会永久生效（widget.eq 为真时 CM 复用 DOM、toDOM 不再跑），
        // 而首次构建那一刻量不到行高，写下去的就是个错值 —— 下面每一行都会跟着偏。
        // 点击公式 → 光标落在点击处 → 整段公式进入文本模式
        div.addEventListener('mousedown', (event: MouseEvent) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            placeMathCaret(view, div, this.tex, this.sourceFrom, this.sourceTo, event);
        });

        // KaTeX 的输出包一层：缩放只作用在这一层，外框高度不受影响
        const inner = document.createElement('div');
        inner.className = 'cm-md-math-inner';
        try {
            ensureKatexCss();
            katex.render(this.tex, inner, {
                throwOnError: false,
                displayMode: true,
                output: 'htmlAndMathml',
            });
        } catch (e) {
            console.error('[FlowMD] BlockMath KaTeX render error:', e, 'tex:', this.tex);
            inner.textContent = `$$${this.tex}$$`;
        }
        div.appendChild(inner);
        // 比外框高的公式整体缩小（首帧量不到，会在下一帧补上）
        fitMathToBox(inner, this.tex);
        return div;
    }
}
