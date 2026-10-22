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
    LINE_PADDING_PX,
    measureBulletWidth,
    measureBulletYCorrection,
    measureTextIn,
    type MeasureEnv,
    renderInlineMarkdown,
    resolvePreviewImageUrl,
} from './helpers.js';
import {
    copyToClipboard,
    foldedLinesOf,
    foldToggleEffect,
    sourceModeEffect,
    mermaidHeightCache,
    mermaidSvgCache,
    rememberWidgetHeight,
    widgetHeightCache,
} from './state.js';
import { renderMermaidSvg } from './mermaidRender.js';
import {
    createMediaResizeGroup,
    createPreviewActionGroup,
    copyMermaidRenderedImageSafely,
    openImagePreviewOverlay,
    openMermaidPreviewOverlay,
} from './previewOverlay.js';
import { DEFAULT_MEDIA_WIDTH_PERCENT, stepMediaWidthPercent } from './mediaWidth.js';
import { parseInlineImageTag, type InlineImageAttrs } from './inlineEngine.js';
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
 * 无序列表的圆点。
 *
 * 圆点顶掉源码里的 `- `（标记符 + 一个空格），盒子按实测宽度定宽、
 * 把正文顶到原位；圆点是 SVG circle：
 * - 水平圆心落在 `-` 的中点（CSS 变量 --cm-mark-center = markerWidth/2）；
 * - 垂直圆心定位在**行盒中心**（距行顶 lineHeight/2）。不能靠
 *   `vertical-align:middle` 隐式命中 —— 空 inline-block 的 middle 对齐点
 *   与行盒中心有亚像素差，构造时把实测差值写进 --cm-dot-y-correction，
 *   dot 用 top: calc(50% + 修正) 补偿（见 helpers.ts 的
 *   measureBulletYCorrection）。
 *
 * 折叠交互已移到行号位置（见 gutterFold.ts）：点圆点/行内容一律
 * 进入文本模式，看到源码 `-`。
 */
export class BulletWidget extends WidgetType {
    private readonly markerWidth: number;
    private readonly width: number;
    /** 圆点垂直修正量（px，负=向上挪），见 measureBulletYCorrection */
    private readonly yCorrection: number;

    /**
     * @param marker - 源码标记符（`-` / `*` / `+`）
     * @param env - 量字用的字体环境（导图节点传自己的 mini-CM 字体；
     *              主编辑器不传则走全局正文口径）。渲染态圆点必须精确
     *              顶掉源码里的 `- `，字体不对就会让进编辑态时正文横跳。
     */
    constructor(
        private marker = '-',
        env: MeasureEnv | null = null
    ) {
        super();
        this.markerWidth = measureTextIn(env, this.marker, '400');
        this.width = measureBulletWidth(this.marker, env);
        this.yCorrection = measureBulletYCorrection(this.marker, env);
    }

    toDOM(): HTMLElement {
        const span = document.createElement('span');
        span.className = 'cm-md-bullet';
        span.innerHTML =
            '<span class="cm-md-bullet-dot">' +
            '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">' +
            '<circle cx="6" cy="6" r="3.4" fill="currentColor"/></svg></span>';
        span.style.width = `${this.width.toFixed(2)}px`;
        span.style.setProperty(
            '--cm-mark-center',
            `${(this.markerWidth / 2).toFixed(2)}px`
        );
        span.style.setProperty(
            '--cm-dot-y-correction',
            `${this.yCorrection.toFixed(2)}px`
        );
        return span;
    }

    // 放行 mousedown：点圆点进入该行文本模式（光标落进 `-`）
    ignoreEvent(event: Event): boolean {
        return event.type !== 'mousedown';
    }

    eq(other: BulletWidget): boolean {
        return (
            this.marker === other.marker &&
            Math.round(this.width * 100) ===
                Math.round(other.width * 100) &&
            // 字体环境变化（首次构建走 body、正文挂载后重建）会改变修正量，
            // 不纳入 eq 的话 CM 复用旧 DOM，补偿值停在错的那份上
            Math.round(this.yCorrection * 100) ===
                Math.round(other.yCorrection * 100)
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

/** 元数据卡片的折叠状态（模块级：一篇文档只有一处 front matter）。 */
let frontmatterCollapsed = false;

/**
 * 渲染 YAML frontmatter 的元数据卡片（折叠条 + 键值表）。
 *
 * 关键设计——**展开态高度 = 源码行数 × 行高**：卡片用 min-height 占住与
 * 源码 YAML（含两行 `---`）完全相等的高度，于是点击卡片进入源码态时
 * 是等高替换：元素开头不动、后面的文字位置不动、不额外占行；失焦后
 * 卡片恢复。键值少时卡片下方留白，键值多时网格内部滚动。
 */
export class FrontmatterWidget extends WidgetType {
    private cacheKey: string;
    constructor(
        private properties: FrontmatterProperty[],
        /** front matter 整块（含两行 ---）占的源码行数，用于等高 */
        private sourceLineCount: number,
        /** front matter 起点（点击卡片时光标落这里，从而显出源码） */
        private sourceFrom: number
    ) {
        super();
        this.cacheKey = 'fm-' + sourceLineCount + '-' + JSON.stringify(properties);
    }
    get estimatedHeight(): number {
        return widgetHeightCache.get(this.cacheKey) || 100;
    }

    eq(other: FrontmatterWidget): boolean {
        if (this.sourceLineCount !== other.sourceLineCount) return false;
        if (this.properties.length !== other.properties.length) return false;
        return this.properties.every(
            (p, i) => p.key === other.properties[i].key && p.value === other.properties[i].value
        );
    }

    ignoreEvent(): boolean {
        return false;
    }

    /** 展开态的等高 min-height（折叠时撤掉，只留一条标题栏）。 */
    private expandedMinHeight(): string {
        return `calc(${this.sourceLineCount} * var(--livewritemd-line-height, 1.7em))`;
    }

    toDOM(view: EditorView): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'cm-md-frontmatter';
        wrapper.title = '点击进入源码';
        if (!frontmatterCollapsed) {
            wrapper.style.minHeight = this.expandedMinHeight();
        } else {
            wrapper.classList.add('cm-md-frontmatter-collapsed');
        }

        // Header
        const header = document.createElement('div');
        header.className = 'cm-md-frontmatter-header';
        const headerIcon = document.createElement('span');
        headerIcon.className = 'cm-md-frontmatter-header-icon';
        headerIcon.textContent = '\u{1F4C4}'; // 📄
        header.appendChild(headerIcon);
        const headerText = document.createElement('span');
        headerText.className = 'cm-md-frontmatter-header-text';
        headerText.textContent = `\u5143\u6570\u636E \u00B7 ${this.properties.length} \u9879`;
        header.appendChild(headerText);
        // \u6298\u53E0\u7BAD\u5934\uFF1A\u53EA\u6536\u8D77\u952E\u503C\u8868\uFF08\u5361\u7247\u9AD8\u5EA6\u968F\u4E4B\u53D8\u4E3A\u4E00\u6761\u6807\u9898\u680F\uFF09\uFF0C
        // \u4E0E\u300C\u70B9\u8FDB\u6E90\u7801\u300D\u662F\u4E24\u56DE\u4E8B\uFF0C\u6240\u4EE5\u963B\u6B62\u5192\u6CE1\u3002
        const toggle = document.createElement('span');
        toggle.className = 'cm-md-frontmatter-toggle';
        toggle.textContent = frontmatterCollapsed ? '\u25B8' : '\u25BE';
        toggle.title = frontmatterCollapsed ? '\u5C55\u5F00\u5143\u6570\u636E' : '\u6536\u8D77\u5143\u6570\u636E';
        toggle.addEventListener('click', (event) => {
            event.stopPropagation();
            frontmatterCollapsed = !frontmatterCollapsed;
            wrapper.classList.toggle('cm-md-frontmatter-collapsed', frontmatterCollapsed);
            wrapper.style.minHeight = frontmatterCollapsed ? '' : this.expandedMinHeight();
            toggle.textContent = frontmatterCollapsed ? '\u25B8' : '\u25BE';
            toggle.title = frontmatterCollapsed ? '\u5C55\u5F00\u5143\u6570\u636E' : '\u6536\u8D77\u5143\u6570\u636E';
        });
        header.appendChild(toggle); // プロパティ
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

        // 点击卡片任意处（除折叠箭头）→ 光标落进 front matter 区间，
        // 聚焦区间与之相交后本 widget 不再挂载，源码 YAML 原样显出——
        // 等高替换，不位移。失焦（光标移走）后自动恢复卡片。
        wrapper.addEventListener('mousedown', (event) => {
            event.preventDefault();
            view.dispatch({ selection: { anchor: this.sourceFrom } });
            view.focus();
        });

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
// Gutter fold widget（折叠箭头统一放在行号位置）
// =============================================================================

/**
 * 行号位置的折叠箭头 widget，列表项与标题章节共用。
 *
 * 折叠交互从正文内容里彻底剥离：点行内容永远进入文本模式（看到 `-`/`#`），
 * 只有悬停**行号**时，行号淡出、换成折叠箭头；折叠态箭头常驻行号位、
 * 旋转朝右、用 accent 色。
 *
 * 本 widget 由 gutter 的 lineNumberMarker 替换逻辑注入（见 gutterFold.ts），
 * 根元素填满 gutter 格子，内部 chevron 居中。
 */
export class GutterFoldWidget extends WidgetType {
    /**
     * @param folded - 当前是否折叠态
     */
    constructor(private folded = false) {
        super();
    }

    eq(other: GutterFoldWidget): boolean {
        return this.folded === other.folded;
    }

    ignoreEvent(): boolean {
        // gutter 在 contentDOM 之外，事件不会进编辑器，无需放行
        return true;
    }

    toDOM(view: EditorView): HTMLElement {
        const root = document.createElement('span');
        root.className =
            'cm-md-gutter-fold' + (this.folded ? ' is-folded' : '');
        root.innerHTML =
            '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">' +
            '<polyline points="3,4.5 6,7.5 9,4.5" fill="none" ' +
            'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
            'stroke-linejoin="round"/></svg>';
        // mousedown 切换折叠：行号不在 content 内，本来也不会放置光标
        root.addEventListener('mousedown', (e: MouseEvent) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            const lineFrom = view.state.doc.lineAt(
                view.posAtDOM(root, 0)
            ).from;
            // 折叠集合按编辑器实例隔离（任务 4）：mini-CM 与主编辑器互不串扰
            const folded = foldedLinesOf(view.state);
            if (folded.has(lineFrom)) {
                folded.delete(lineFrom);
            } else {
                folded.add(lineFrom);
            }
            view.dispatch({ effects: foldToggleEffect.of(null) });
        });
        return root;
    }
}

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
                    // 挂到 <body>，不要挂 view.dom：导图节点的 mini-CM 位于
                    // 画布的 world(translate)+scaler(scale) 变换层里，浮层又是
                    // position:fixed。fixed 在变换祖先下会相对该祖先定位、还会
                    // 被节点/画布的 overflow 裁掉 —— 放大查看在导图里直接失效。
                    // body 是文档根，无变换、无裁剪，live 与导图共用同一份。
                    // themeScope 负责把 CM 的 `ͼN` 主题类搬进 portal：
                    // 不传的话浮层在 body 下会丢掉全部 baseTheme 样式（无法放大显示）。
                    mountHost: document.body,
                    themeScope: view.dom,
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

    private async renderAsync(container: HTMLElement, view: EditorView): Promise<void> {
        try {
            // 渲染本体已抽去 mermaidRender.ts（导图 mermaid 媒体节点共用）：
            // 动态 import / 初始化 / inflight 去重 / SVG 缓存都在那边
            const svg = await renderMermaidSvg(this.source);
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
            console.error('[LiveWriteMD] InlineMath KaTeX render error:', e, 'tex:', this.tex);
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
 * `--livewritemd-editor-font-size × --livewritemd-font-scale`，这里照抄一遍 ——
 * 只用在「连正文行都还没有」的首次构建里给行高兜底。
 *
 * @returns 正文字号（px），两个变量都读不到时按主题默认的 14px
 */
function contentFontSizePx(): number {
    const root = getComputedStyle(document.documentElement);
    const base = Number.parseFloat(root.getPropertyValue('--livewritemd-editor-font-size'));
    const scale = Number.parseFloat(root.getPropertyValue('--livewritemd-font-scale'));
    return Number.isFinite(base) ? base * (Number.isFinite(scale) ? scale : 1) : 14;
}

/**
 * 正文的行高（px）。
 *
 * 三级来源，越靠前越准：
 * 1. 页面上已经有正文行 —— 量它的计算行高（行高是用户可配的，量出来的最准）；
 * 2. 还没有（视图**首次构建**时一行都没有）—— 按 CSS 里用的同一个变量现算：
 *    `--livewritemd-line-height` 是 `1.7em` 这种带 em 的写法时乘上正文字号，
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
        .getPropertyValue('--livewritemd-line-height')
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
 * 框的真实高度由 CSS 算（styles.ts 里 `calc(2.5 * var(--livewritemd-line-height))`），
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
        // 高度**不写行内 style**：由 styles.ts 的 `calc(2.5 * var(--livewritemd-line-height))` 算。
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
            console.error('[LiveWriteMD] BlockMath KaTeX render error:', e, 'tex:', this.tex);
            inner.textContent = `$$${this.tex}$$`;
        }
        div.appendChild(inner);
        // 比外框高的公式整体缩小（首帧量不到，会在下一帧补上）
        fitMathToBox(inner, this.tex);
        return div;
    }
}

// =============================================================================
// HTML Block Widget
// =============================================================================

/** HTML 块里允许保留的标签（README 徽章 / 居中排版那一类）。 */
const HTML_BLOCK_TAGS = new Set([
    'p', 'div', 'center', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'del',
    'ins', 'mark', 'small', 'sub', 'sup', 'kbd', 'code', 'pre', 'br', 'hr',
    'img', 'a', 'picture', 'source', 'figure', 'figcaption',
    'blockquote', 'ul', 'ol', 'li',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

/** 允许保留的属性：全部是展示属性，`on*` / `style` 一律丢弃。 */
const HTML_BLOCK_ATTRS = new Set([
    'align', 'valign', 'width', 'height', 'src', 'alt', 'title',
    'href', 'colspan', 'rowspan', 'start', 'type',
]);

/**
 * 内容本身就不该出现的标签：连同子树整个丢掉。
 *
 * 其它不认识的标签（比如自定义元素）走「保留子节点」的降级路径，
 * 这样 `<unknown><b>粗体</b></unknown>` 至少还能显示粗体文字。
 */
const HTML_BLOCK_DROP_TAGS = new Set([
    'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta',
    'base', 'form', 'input', 'button', 'textarea', 'select', 'option',
]);

/** 链接允许的协议（其它（尤其是 javascript:）直接丢掉 href）。 */
function safeHtmlHref(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.startsWith('#')) return trimmed;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (/^mailto:/i.test(trimmed)) return trimmed;
    return '';
}

/**
 * 把一段 HTML 块源码变成安全的 DOM 片段。
 *
 * 用 DOMParser 解析（不会执行脚本），再按白名单**重建**一棵树：
 * 只保留展示标签与无害属性，图片地址经 resolvePreviewImageUrl 换成
 * webview 可访问地址。返回 null 表示这段块没有可渲染内容，调用方应保持
 * 源码显示（避免把普通文本 / 注释替换成一片空白）。
 *
 * @param raw - HTML 块原文
 * @returns 安全片段；没有可渲染元素时为 null
 */
export function buildHtmlBlockFragment(raw: string): DocumentFragment | null {
    let parsed: Document;
    try {
        parsed = new DOMParser().parseFromString(raw, 'text/html');
    } catch {
        return null;
    }
    const fragment = document.createDocumentFragment();
    /** 成功保留的元素数量：0 表示没东西可画。 */
    let kept = 0;

    const copy = (source: Node, target: Node): void => {
        if (source.nodeType === Node.TEXT_NODE) {
            target.appendChild(document.createTextNode(source.textContent ?? ''));
            return;
        }
        if (source.nodeType !== Node.ELEMENT_NODE) return;
        const sourceEl = source as HTMLElement;
        const tag = sourceEl.tagName.toLowerCase();
        if (HTML_BLOCK_DROP_TAGS.has(tag)) return;
        if (!HTML_BLOCK_TAGS.has(tag)) {
            // 不认识的包装标签：保留里面的内容
            for (const child of Array.from(sourceEl.childNodes)) copy(child, target);
            return;
        }

        const el = document.createElement(tag);
        for (const attr of Array.from(sourceEl.attributes)) {
            const name = attr.name.toLowerCase();
            if (!HTML_BLOCK_ATTRS.has(name)) continue;
            if (name === 'src') {
                // 相对路径 / 远程地址 / data URI 统一交给已有的图片解析
                const resolved = resolvePreviewImageUrl(attr.value);
                if (resolved) el.setAttribute('src', resolved);
            } else if (name === 'href') {
                const href = safeHtmlHref(attr.value);
                if (href) {
                    // 复用 live 的链接点击逻辑（Ctrl+点击打开 / #锚点跳转），
                    // 但不保留真实 href，防止 webview 里整页跳转
                    el.classList.add('cm-md-link');
                    el.setAttribute('data-href', href);
                    el.setAttribute('title', `${href} (Ctrl+Click to open)`);
                }
            } else {
                el.setAttribute(name, attr.value);
            }
        }
        // align 是过时属性但浏览器仍认；显式映射成 inline style，主题覆盖时更稳
        const align = sourceEl.getAttribute('align');
        if (align) el.style.textAlign = align;

        for (const child of Array.from(sourceEl.childNodes)) copy(child, el);
        target.appendChild(el);
        kept += 1;
    };

    for (const child of Array.from(parsed.body.childNodes)) copy(child, fragment);
    return kept > 0 ? fragment : null;
}

/**
 * HTML 块渲染 widget。
 *
 * HTML 块（`<p align="center">…</p>` / shields.io 徽章行）在非聚焦时
 * 整体替换成渲染结果；点一下（mousedown 放行）光标进入该块，
 * 聚焦区间覆盖它时 applyTreeDecorations 会跳过，源码自然展开 ——
 * 与水平线 widget 的交互一致。
 *
 * 导图节点用的是同一套 live 扩展，所以 html 媒体节点里的内容无需
 * 额外渲染逻辑，mini-CM 会自动走到这里。
 */
export class HtmlBlockWidget extends WidgetType {
    constructor(private readonly raw: string) {
        super();
    }

    eq(other: HtmlBlockWidget): boolean {
        return this.raw === other.raw;
    }

    ignoreEvent(event: Event): boolean {
        // 只放行 mousedown：让点击能把光标放进块里，从而展开源码。
        return event.type !== 'mousedown';
    }

    toDOM(view: EditorView): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'cm-md-html-block';
        const fragment = buildHtmlBlockFragment(this.raw);
        if (fragment) {
            wrapper.appendChild(fragment);
        } else {
            // 理论上调用方已经筛过；兜底仍然显示原文，绝不吞内容
            wrapper.textContent = this.raw;
        }
        // 图片是异步加载的：加载完高度才定，通知 CM 重新量一次
        for (const img of Array.from(wrapper.querySelectorAll('img'))) {
            if (!img.complete) {
                img.addEventListener('load', () => view.requestMeasure(), {
                    once: true,
                });
                img.addEventListener('error', () => view.requestMeasure(), {
                    once: true,
                });
            }
        }
        return wrapper;
    }
}
