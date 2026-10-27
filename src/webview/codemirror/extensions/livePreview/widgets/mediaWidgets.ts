/**
 * Live Preview Widget（从 widgets.ts 拆出）：图片与媒体 widget：媒体宽度调整助手 + ImageWidget + InlineHtmlImageWidget。
 *
 * @module webview/codemirror/extensions/livePreview/mediaWidgets
 */

import { renderInlineMarkdown } from '../inline/inlineEngine.js';
import { DEFAULT_MEDIA_WIDTH_PERCENT, stepMediaWidthPercent } from '../mediaWidth.js';
import { openImagePreviewOverlay } from '../overlay/imagePreview.js';
import { createMediaResizeGroup, createPreviewActionGroup } from '../overlay/overlayControls.js';
import { resolvePreviewImageUrl, sourceModeEffect } from '../state.js';
import { EditorView, WidgetType } from '@codemirror/view';
import type { InlineImageAttrs } from '../inline/inlineEngine.js';

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
export function isMediaResizeEvent(event: Event): boolean {
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
export function appendMediaResizeGroup(
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
        // 同时给一个无单位小数：导图图片节点要把档位换算成「节点上限 × 比例」
        // （calc 里不能用百分比当乘数），live 模式不消费这个变量。
        wrapper.style.setProperty('--cm-md-media-ratio', String(this.widthPercent / 100));
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
                    // 与 mermaid 浮层同理：导图节点的 mini-CM 在变换层里，fixed 浮层
                    // 挂 view.dom 会被变换祖先定位/裁剪，只能挂 body；再由 themeScope
                    // 把 CodeMirror 的主题类带到 portal 上，否则浮层没有样式。
                    mountHost: document.body,
                    themeScope: view.dom,
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
 * 行内 `<img>` 的渲染 widget。
 *
 * 用途：GFM 表格格子里放海报缩略图 ——
 * `[<img src="preview.jpg" width="170">](poster.png)`。
 * 语法树上它是 Link 里的一个 HTMLTag 节点，这里只负责把标签换成图片，
 * 链接样式与点击（Ctrl+点击打开 / 相对路径直接打开）仍由 Link 分支的
 * `.cm-md-link` mark 负责，两者范围完全重合。
 *
 * 为什么不用 ImageWidget：ImageWidget 带放大/复制/缩放整组操作、双击进源码、
 * 按正文宽度百分比缩放，那是「独占一行的图片」的交互。表格格子里的缩略图
 * 需要的是按标签 width 属性定尺寸、跟在文字流里的一个元素，交互越少越好。
 */
export class InlineHtmlImageWidget extends WidgetType {
    /**
     * @param attrs - 解析后的图片属性
     * @param href - 外层 Markdown 链接地址（空串 = 图片没有被链接包住）
     */
    constructor(
        private readonly attrs: InlineImageAttrs,
        private readonly href: string = ''
    ) {
        super();
    }

    eq(other: InlineHtmlImageWidget): boolean {
        // 所有会影响渲染/尺寸的属性都参与比较；漏一个就会出现
        // 「源码改了但 widget 被复用、画面不变」
        return (
            this.attrs.src === other.attrs.src &&
            this.attrs.alt === other.attrs.alt &&
            this.attrs.title === other.attrs.title &&
            this.attrs.width === other.attrs.width &&
            this.attrs.height === other.attrs.height &&
            this.href === other.href
        );
    }

    ignoreEvent(event: Event): boolean {
        // mousedown 放行给编辑器：点图片能把光标落进所在单元格（表格要编辑）；
        // 链接的拦截由 plugin.ts 的 mousedown 处理器完成（相对路径直接打开）。
        return event.type !== 'mousedown';
    }

    toDOM(view: EditorView): HTMLElement {
        const resolved = resolvePreviewImageUrl(this.attrs.src);
        if (!resolved) {
            // 地址解析不出来（没有 baseUri / 非法地址）：显示 alt，避免一片空白
            const fallback = document.createElement('span');
            fallback.className = 'cm-md-image-fallback';
            fallback.textContent = this.attrs.alt || '[image]';
            return fallback;
        }

        const img = document.createElement('img');
        img.className = 'cm-md-inline-image';
        img.src = resolved;
        if (this.attrs.alt !== undefined) img.alt = this.attrs.alt;
        if (this.attrs.title !== undefined) img.title = this.attrs.title;
        // width / height 直接用标签属性：格子列宽就是按这两个值量的
        // （见 tableRender 的 measureCells -> renderInlineMarkdown），
        // 两者必须同一口径，否则图片会撑破或缩在格子里。
        if (this.attrs.width) img.setAttribute('width', this.attrs.width);
        if (this.attrs.height) img.setAttribute('height', this.attrs.height);
        img.loading = 'lazy';

        // 外层链接：直接挂在图片上。不用「再套一层 .cm-md-link mark」——
        // mark 与 replace 同区间时，widget 是否被 mark 的 span 包住由 CM
        // 内部决定，自己带上链接类最稳，点击处理（plugin.ts 的 mousedown）
        // 通过 closest('.cm-md-link') 一样能命中。
        if (this.href) {
            img.classList.add('cm-md-link');
            img.setAttribute('data-href', this.href);
            img.setAttribute('title', `${this.href} (Ctrl+Click to open)`);
        }

        // 图片异步加载：高度定下来后让 CM 重量一次，表格行高/滚动位置才准
        img.addEventListener('load', () => view.requestMeasure(), { once: true });
        img.addEventListener('error', () => view.requestMeasure(), { once: true });
        return img;
    }
}
