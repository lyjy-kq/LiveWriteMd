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
    applyAlignment,
    applySafeFontStyles,
    renderInlineMarkdown,
    resolvePreviewImageUrl,
} from './helpers.js';
import {
    copyToClipboard,
    foldedListItems,
    foldToggleEffect,
    getMermaidTheme,
    mermaidHeightCache,
    mermaidInitialized,
    mermaidRenderPromises,
    mermaidSvgCache,
    setMermaidInitialized,
    setTableDragging,
    tableCellSelections,
    tableCellSelectEffect,
    type TableCellRange,
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
import type { FrontmatterProperty, TableData } from './types.js';

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

    eq(): boolean {
        return true;
    }
}

/**
 * Widget that renders a bullet point for unordered list items.
 */
export class BulletWidget extends WidgetType {
    toDOM(): HTMLElement {
        const span = document.createElement('span');
        span.className = 'cm-md-bullet';
        span.textContent = '\u2022';
        return span;
    }

    eq(): boolean {
        return true;
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
                    if (h > 0) widgetHeightCache.set(this.cacheKey, h);
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
        return isMediaResizeEvent(event);
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
                    if (h > 0) widgetHeightCache.set(this.cacheKey, h);
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
// Table Widget
// =============================================================================

/**
 * Apply cell selection highlight to table cells.
 * Cells within the rectangular [startRow..endRow, startCol..endCol] range
 * receive the `cm-md-table-cell-selected` class; others have it removed.
 */
function applyCellSelectionHighlight(table: HTMLTableElement, sel: TableCellRange): void {
    const minRow = Math.min(sel.startRow, sel.endRow);
    const maxRow = Math.max(sel.startRow, sel.endRow);
    const minCol = Math.min(sel.startCol, sel.endCol);
    const maxCol = Math.max(sel.startCol, sel.endCol);
    table.querySelectorAll('td[data-row], th[data-row]').forEach((cell) => {
        const el = cell as HTMLElement;
        const row = parseInt(el.dataset.row ?? '-1');
        const col = parseInt(el.dataset.col ?? '-1');
        const selected = row >= minRow && row <= maxRow && col >= minCol && col <= maxCol;
        el.classList.toggle('cm-md-table-cell-selected', selected);
        // Border on selection rectangle edges
        el.classList.toggle('cm-md-table-cell-sel-top', selected && row === minRow);
        el.classList.toggle('cm-md-table-cell-sel-bottom', selected && row === maxRow);
        el.classList.toggle('cm-md-table-cell-sel-left', selected && col === minCol);
        el.classList.toggle('cm-md-table-cell-sel-right', selected && col === maxCol);
    });
}

function clearCellSelectionHighlight(table: HTMLTableElement): void {
    table.querySelectorAll('td[data-row], th[data-row]').forEach((cell) => {
        const el = cell as HTMLElement;
        el.classList.remove(
            'cm-md-table-cell-selected',
            'cm-md-table-cell-sel-top',
            'cm-md-table-cell-sel-bottom',
            'cm-md-table-cell-sel-left',
            'cm-md-table-cell-sel-right'
        );
    });
}

/**
 * Widget that renders a GFM table with interactive add-row/add-column bars.
 * Supports cell drag-selection (rect highlight) and Delete-key row/col/cell deletion.
 */
export class TableWidget extends WidgetType {
    private cacheKey: string;
    constructor(
        private data: TableData,
        private cellSelection: TableCellRange | null = null
    ) {
        super();
        this.cacheKey = 'tb-' + JSON.stringify(data.headers) + '-r' + data.rows.length;
    }
    get estimatedHeight(): number {
        return widgetHeightCache.get(this.cacheKey) || 100 + this.data.rows.length * 30;
    }

    eq(other: TableWidget): boolean {
        if (JSON.stringify(this.data) !== JSON.stringify(other.data)) return false;
        const s1 = this.cellSelection;
        const s2 = other.cellSelection;
        if (s1 === null && s2 === null) return true;
        if (s1 === null || s2 === null) return false;
        return (
            s1.startRow === s2.startRow &&
            s1.startCol === s2.startCol &&
            s1.endRow === s2.endRow &&
            s1.endCol === s2.endCol
        );
    }

    destroy(dom: HTMLElement): void {
        // Clean up viewer-mode drag listeners if widget is removed mid-drag
        const cleanup = (dom as any)._viewerCleanup;
        if (typeof cleanup === 'function') cleanup();
    }

    ignoreEvent(event: Event): boolean {
        // Let CM6 handle wheel/scroll so Alt+wheel fast-scroll works over tables
        if (event.type === 'wheel' || event.type === 'scroll') return false;
        if (event.target instanceof HTMLElement) {
            if (
                event.target.closest('.cm-md-table-add-row-bar') ||
                event.target.closest('.cm-md-table-add-col-bar') ||
                event.target.classList.contains('cm-md-table-checkbox')
            ) {
                return true;
            }
            // Cell clicks are handled by our own mousedown handler
            if (event.target.closest('td[data-row], th[data-row]')) {
                return true;
            }
        }
        return false;
    }

    toDOM(view: EditorView): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'cm-md-table-wrapper';

        // Store position info on DOM for ViewPlugin (tableExtentSelectionPlugin)
        const tableFrom = this.data.positions.tableFrom;
        wrapper.dataset.tableFrom = String(tableFrom);
        wrapper.dataset.tableTo = String(this.data.positions.tableTo);

        // Top row: table + column add bar (side by side)
        const topRow = document.createElement('div');
        topRow.className = 'cm-md-table-top-row';

        const table = document.createElement('table');
        table.className = 'cm-md-table';

        // Build thead with data-row/col attributes for cell selection
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        this.data.headers.forEach((text, i) => {
            const th = document.createElement('th');
            th.className = 'cm-md-table-th';
            th.innerHTML = renderInlineMarkdown(text);
            applyAlignment(th, this.data.alignments[i]);
            th.dataset.row = '0';
            th.dataset.col = String(i);
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Build tbody with data-row/col attributes
        const tbody = document.createElement('tbody');
        this.data.rows.forEach((row, rowIdx) => {
            const tr = document.createElement('tr');
            row.forEach((text, i) => {
                const td = document.createElement('td');
                td.className = 'cm-md-table-td';
                td.innerHTML = renderInlineMarkdown(text);
                applyAlignment(td, this.data.alignments[i]);
                td.dataset.row = String(rowIdx + 1); // 0=header, 1+=data
                td.dataset.col = String(i);
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);

        // Attach checkbox toggle handlers
        const checkboxes = table.querySelectorAll('.cm-md-table-checkbox');
        checkboxes.forEach((cb) => {
            cb.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                const input = cb as HTMLInputElement;
                const isChecked = input.checked;
                const newText = isChecked ? '[ ]' : '[x]';
                const oldText = isChecked ? /\[[xX]\]/ : /\[ \]/;
                const td = input.closest('td, th');
                if (!td) return;
                const tr = td.closest('tr');
                if (!tr) return;
                const tbodyEl = tr.closest('tbody');
                const theadEl = tr.closest('thead');
                let lineIdx: number;
                if (theadEl) {
                    lineIdx = 0;
                } else if (tbodyEl) {
                    const rowIdx = Array.from(tbodyEl.children).indexOf(tr);
                    lineIdx = rowIdx + 2; // skip header + delimiter
                } else {
                    return;
                }
                const { linePositions } = this.data.positions;
                if (lineIdx >= linePositions.length) return;
                const { from: lineFrom, to: lineTo } = linePositions[lineIdx];
                const lineText = view.state.doc.sliceString(lineFrom, lineTo);
                const match = lineText.match(oldText);
                if (match && match.index !== undefined) {
                    const pos = lineFrom + match.index;
                    view.dispatch({
                        changes: { from: pos, to: pos + 3, insert: newText },
                        annotations: Transaction.userEvent.of('input.checkbox-toggle'),
                    });
                }
            });
        });

        // Apply initial highlight if a cell selection was passed in
        if (this.cellSelection) {
            applyCellSelectionHighlight(table, this.cellSelection);
        }

        // =========================================================
        // Cell drag-selection
        // - mousedown on td/th: start selection, block CM6 bubbling
        // - mousemove (captured on document): extend selection, update DOM highlight
        // - mouseup (captured on document): commit selection via StateEffect
        // =========================================================
        table.addEventListener(
            'mousedown',
            (e) => {
                const cell = (e.target as HTMLElement).closest(
                    'td[data-row], th[data-row]'
                ) as HTMLElement | null;
                if (!cell) return;
                // Don't interfere with checkbox handlers
                if ((e.target as HTMLElement).classList.contains('cm-md-table-checkbox')) return;

                // Prevent CM6 from selecting the whole decoration range
                e.stopPropagation();
                // Prevent text selection cursor on drag
                e.preventDefault();

                // Live Preview mode: click on cell → place cursor in source to show raw Markdown
                if (view.state.facet(EditorView.editable)) {
                    tableCellSelections.clear();
                    const rowAttr = parseInt(cell.dataset.row ?? '0');
                    // Map data-row to linePositions index (skip delimiter line)
                    // data-row=0 → linePositions[0] (header), data-row=N → linePositions[N+1]
                    const lineIdx = rowAttr === 0 ? 0 : rowAttr + 1;
                    const { linePositions } = this.data.positions;
                    if (lineIdx < linePositions.length) {
                        const { from: lineFrom } = linePositions[lineIdx];
                        const lineText = view.state.doc.sliceString(
                            lineFrom,
                            linePositions[lineIdx].to
                        );
                        const colIdx = parseInt(cell.dataset.col ?? '0');
                        // Find cursor position at the target column by counting pipes
                        let pipeCount = 0;
                        let cursorPos = lineFrom;
                        for (let i = 0; i < lineText.length; i++) {
                            if (lineText[i] === '|') {
                                pipeCount++;
                                if (pipeCount === colIdx + 1) {
                                    // Position after the pipe and any leading whitespace
                                    let j = i + 1;
                                    while (j < lineText.length && lineText[j] === ' ') j++;
                                    cursorPos = lineFrom + j;
                                    break;
                                }
                            }
                        }
                        view.dispatch({ selection: { anchor: cursorPos } });
                        view.focus();
                    }
                    return;
                }

                // === Viewer mode: cell drag selection ===

                // Ensure webview has focus so keyboard events (Ctrl+C etc.) reach our
                // document-level handler. preventDefault() above blocks the browser's
                // default focus-on-mousedown, so without this the webview iframe never
                // receives focus if the user hasn't clicked elsewhere first.
                // Use view.dom (the outer .cm-editor div) because view.focus() targets
                // contentDOM which fails when contenteditable=false (Viewer mode).
                if (!view.dom.hasAttribute('tabindex')) {
                    view.dom.setAttribute('tabindex', '-1');
                }
                view.dom.focus({ preventScroll: true });

                // Clear ALL cell selections and immediately remove visual highlights from
                // other tables via direct DOM manipulation (no dispatch — dispatching during
                // mousedown causes a synchronous widget rebuild that detaches this table's DOM).
                for (const key of tableCellSelections.keys()) {
                    if (key !== tableFrom) {
                        const otherWrapper = view.contentDOM.querySelector(
                            `[data-table-from="${key}"]`
                        );
                        if (otherWrapper) {
                            const otherTable = otherWrapper.querySelector('table');
                            if (otherTable)
                                clearCellSelectionHighlight(otherTable as HTMLTableElement);
                        }
                    }
                }
                tableCellSelections.clear();

                const startRow = parseInt(cell.dataset.row ?? '0');
                const startCol = parseInt(cell.dataset.col ?? '0');
                let curSel: TableCellRange = {
                    tableFrom,
                    startRow,
                    startCol,
                    endRow: startRow,
                    endCol: startCol,
                };
                // Immediately register the initial single-cell selection so that
                // Ctrl+C works even before mouseup fires.
                tableCellSelections.set(tableFrom, curSel);
                applyCellSelectionHighlight(table, curSel);
                setTableDragging(true);
                console.debug(`[FlowMD] table cell select start: row=${startRow} col=${startCol}`);

                const finishDrag = () => {
                    document.removeEventListener('mousemove', onMouseMove);
                    document.removeEventListener('mouseup', finishDrag);
                    setTableDragging(false);
                    tableCellSelections.set(tableFrom, curSel);
                    view.dispatch({ effects: tableCellSelectEffect.of(null) });
                    console.debug(
                        `[FlowMD] table cell select commit: rows=${curSel.startRow}-${curSel.endRow} cols=${curSel.startCol}-${curSel.endCol}`
                    );
                };

                const onMouseMove = (ev: MouseEvent) => {
                    // If mouse button was released outside the webview iframe,
                    // the mouseup event is lost — detect it via buttons property.
                    if (ev.buttons === 0) {
                        finishDrag();
                        return;
                    }
                    const el = document.elementFromPoint(ev.clientX, ev.clientY);
                    const hovered = el?.closest('td[data-row], th[data-row]') as HTMLElement | null;
                    // Outside table: keep last selection as-is (Obsidian behavior)
                    if (!hovered || !table.contains(hovered)) return;
                    const endRow = parseInt(hovered.dataset.row ?? '0');
                    const endCol = parseInt(hovered.dataset.col ?? '0');
                    curSel = {
                        tableFrom,
                        startRow: Math.min(startRow, endRow),
                        startCol: Math.min(startCol, endCol),
                        endRow: Math.max(startRow, endRow),
                        endCol: Math.max(startCol, endCol),
                    };
                    tableCellSelections.set(tableFrom, curSel);
                    applyCellSelectionHighlight(table, curSel);
                };

                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', finishDrag);
            },
            false
        );

        // =========================================================
        // Viewer mode: drag-from-outside cell selection
        // Triggered when mouse enters the wrapper while dragging (buttons=1).
        // Uses document-level mousemove + elementFromPoint (same as Live Preview drag).
        // view.state.facet() is used (not isContentEditable) to avoid DOM timing issues.
        // =========================================================
        if (!view.state.facet(EditorView.editable)) {
            let viewerStartRow = -1;
            let viewerStartCol = -1;
            let viewerCurSel: TableCellRange | null = null;

            const onViewerMouseMove = (ev: MouseEvent) => {
                // Detect mouse button released outside webview iframe
                if (ev.buttons === 0) {
                    stopViewerDrag();
                    return;
                }
                if (ev.buttons !== 1) return;
                const el = document.elementFromPoint(ev.clientX, ev.clientY);
                const cell = el?.closest('td[data-row], th[data-row]') as HTMLElement | null;
                // Outside table: keep last selection as-is (Obsidian behavior)
                if (!cell || !table.contains(cell)) return;

                const row = parseInt(cell.dataset.row ?? '0');
                const col = parseInt(cell.dataset.col ?? '0');

                if (viewerStartRow === -1) {
                    viewerStartRow = row;
                    viewerStartCol = col;
                }

                const newSel: TableCellRange = {
                    tableFrom,
                    startRow: Math.min(viewerStartRow, row),
                    startCol: Math.min(viewerStartCol, col),
                    endRow: Math.max(viewerStartRow, row),
                    endCol: Math.max(viewerStartCol, col),
                };
                if (
                    !viewerCurSel ||
                    viewerCurSel.startRow !== newSel.startRow ||
                    viewerCurSel.startCol !== newSel.startCol ||
                    viewerCurSel.endRow !== newSel.endRow ||
                    viewerCurSel.endCol !== newSel.endCol
                ) {
                    viewerCurSel = newSel;
                    tableCellSelections.set(tableFrom, viewerCurSel);
                    applyCellSelectionHighlight(table, viewerCurSel);
                }
            };

            const stopViewerDrag = () => {
                document.removeEventListener('mousemove', onViewerMouseMove);
                document.removeEventListener('mouseup', stopViewerDrag);
                setTableDragging(false);
                (wrapper as any)._viewerCleanup = null;
                if (viewerCurSel) {
                    tableCellSelections.set(tableFrom, viewerCurSel);
                    view.dispatch({ effects: tableCellSelectEffect.of(null) });
                    console.debug(
                        `[FlowMD] viewer cell select commit: rows=${viewerCurSel.startRow}-${viewerCurSel.endRow} cols=${viewerCurSel.startCol}-${viewerCurSel.endCol}`
                    );
                }
                viewerStartRow = -1;
                viewerStartCol = -1;
                viewerCurSel = null;
            };

            wrapper.addEventListener('mouseenter', (e: Event) => {
                const me = e as MouseEvent;
                if (me.buttons !== 1) return; // Not dragging
                // Ensure webview has focus for keyboard events (Ctrl+C)
                if (!view.dom.hasAttribute('tabindex')) {
                    view.dom.setAttribute('tabindex', '-1');
                }
                view.dom.focus({ preventScroll: true });
                setTableDragging(true);
                document.addEventListener('mousemove', onViewerMouseMove);
                document.addEventListener('mouseup', stopViewerDrag);
                (wrapper as any)._viewerCleanup = stopViewerDrag;
            });

            // Store cleanup ref so destroy() can remove listeners if widget is removed mid-drag
            (wrapper as any)._viewerCleanup = null;
        }

        // Clear cell selection when clicking outside table cells (on wrapper)
        wrapper.addEventListener(
            'mousedown',
            (e) => {
                const target = e.target as HTMLElement;
                if (
                    target.closest('.cm-md-table-add-row-bar') ||
                    target.closest('.cm-md-table-add-col-bar') ||
                    target.classList.contains('cm-md-table-checkbox') ||
                    target.closest('td[data-row]') ||
                    target.closest('th[data-row]')
                )
                    return;
                e.stopPropagation();
            },
            false
        );

        topRow.appendChild(table);

        // Column add bar (right - stretches full table height)
        const colBar = document.createElement('div');
        colBar.className = 'cm-md-table-add-col-bar';
        const colIcon = document.createElement('span');
        colIcon.className = 'cm-md-table-add-icon';
        colIcon.textContent = '+';
        colBar.appendChild(colIcon);
        colBar.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            this.addColumn(view);
        });
        topRow.appendChild(colBar);
        wrapper.appendChild(topRow);

        // Row add bar (bottom - full width)
        const rowBar = document.createElement('div');
        rowBar.className = 'cm-md-table-add-row-bar';
        const rowIcon = document.createElement('span');
        rowIcon.className = 'cm-md-table-add-icon';
        rowIcon.textContent = '+';
        rowBar.appendChild(rowIcon);
        rowBar.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            this.addRow(view);
        });
        wrapper.appendChild(rowBar);

        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver((entries) => {
                for (let entry of entries) {
                    const h = entry.borderBoxSize?.[0]?.blockSize || entry.contentRect.height;
                    if (h > 0) widgetHeightCache.set(this.cacheKey, h);
                }
                view.requestMeasure();
            });
            requestAnimationFrame(() => {
                if (wrapper.isConnected) ro.observe(wrapper);
            });
        }
        return wrapper;
    }

    private addRow(view: EditorView): void {
        const { positions, headers } = this.data;
        const colCount = headers.length;
        let rowText = '\n|';
        for (let i = 0; i < colCount; i++) {
            rowText += '  |';
        }
        const insertPos = positions.tableTo;
        view.dispatch({
            changes: { from: insertPos, insert: rowText },
            selection: { anchor: insertPos },
            annotations: Transaction.userEvent.of('input.table-add-row'),
        });
    }

    private addColumn(view: EditorView): void {
        const { positions } = this.data;
        const { linePositions } = positions;
        const changes: Array<{ from: number; insert: string }> = [];

        for (let i = 0; i < linePositions.length; i++) {
            const { from: lineFrom, to: lineEnd } = linePositions[i];
            const lineText = view.state.doc.sliceString(lineFrom, lineEnd);
            const endsWithPipe = lineText.trimEnd().endsWith('|');

            if (i === 1) {
                // Delimiter line
                changes.push({ from: lineEnd, insert: endsWithPipe ? ' --- |' : ' | --- |' });
            } else {
                // Header or data row
                changes.push({ from: lineEnd, insert: endsWithPipe ? '  |' : ' |  |' });
            }
        }

        const lastChange = changes[changes.length - 1];
        view.dispatch({
            changes,
            selection: { anchor: lastChange ? lastChange.from : positions.linePositions[0].from },
            annotations: Transaction.userEvent.of('input.table-add-col'),
        });
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
        return isMediaResizeEvent(event);
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
        // 浮层的 onTitleCommit 只回传标题文本，这里把渲染时的 view 补进去。
        const commitTitle = this.onTitleCommit;
        const actionGroup = createPreviewActionGroup(
            '放大查看图表',
            '复制 Mermaid 图',
            () => {
                openMermaidPreviewOverlay({
                    source: this.source,
                    titleText: null,
                    onTitleCommit: commitTitle
                        ? (title: string) => commitTitle(view, title)
                        : undefined,
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
                mermaidSvgCache.set(this.source, svg);
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
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - esbuild text loader handles .css imports
import katexCssRaw from 'katex/dist/katex.min.css';

/** Flag to track whether KaTeX CSS has been injected into the document */
let katexCssInjected = false;

/**
 * Inject KaTeX CSS into the document for HTML+MathML rendering.
 * Strips @font-face rules (fonts unavailable in webview) and uses system font fallback.
 */
function ensureKatexCss(): void {
    if (katexCssInjected) return;
    katexCssInjected = true;

    // Strip @font-face rules (KaTeX fonts can't be loaded in webview)
    let css = (katexCssRaw as string).replace(/@font-face\s*\{[^}]*\}/g, '');
    // Replace KaTeX font families with system math fonts
    css = css.replace(/font-family:\s*KaTeX_[A-Za-z_]+/g, 'font-family:Times New Roman,serif');
    css = css.replace(/font-family:\s*"KaTeX_[A-Za-z_]+"/g, 'font-family:"Times New Roman",serif');

    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    console.debug('[FlowMD] KaTeX CSS injected, length:', css.length);
}

/**
 * Widget that renders an inline math expression ($...$).
 */
export class InlineMathWidget extends WidgetType {
    constructor(private tex: string) {
        super();
    }

    eq(other: InlineMathWidget): boolean {
        return this.tex === other.tex;
    }

    toDOM(): HTMLElement {
        const span = document.createElement('span');
        span.className = 'cm-md-math-inline';
        try {
            ensureKatexCss();
            console.debug('[FlowMD] InlineMath rendering:', this.tex.substring(0, 50));
            katex.render(this.tex, span, {
                throwOnError: false,
                output: 'htmlAndMathml',
            });
            console.debug('[FlowMD] InlineMath rendered OK, children:', span.childNodes.length);
        } catch (e) {
            console.error('[FlowMD] InlineMath KaTeX render error:', e, 'tex:', this.tex);
            span.textContent = `$${this.tex}$`;
        }
        return span;
    }
}

/**
 * Widget that renders a block math expression ($$...$$).
 */
export class BlockMathWidget extends WidgetType {
    constructor(private tex: string) {
        super();
    }
    get estimatedHeight(): number {
        return widgetHeightCache.get('math-' + this.tex) || 50;
    }

    eq(other: BlockMathWidget): boolean {
        return this.tex === other.tex;
    }

    toDOM(view: EditorView): HTMLElement {
        const div = document.createElement('div');
        div.className = 'cm-md-math-block';
        try {
            ensureKatexCss();
            console.debug('[FlowMD] BlockMath rendering:', this.tex.substring(0, 50));
            katex.render(this.tex, div, {
                throwOnError: false,
                displayMode: true,
                output: 'htmlAndMathml',
            });
            console.debug('[FlowMD] BlockMath rendered OK, children:', div.childNodes.length);
            if (typeof ResizeObserver !== 'undefined') {
                const ro = new ResizeObserver((entries) => {
                    for (let entry of entries) {
                        const h = entry.borderBoxSize?.[0]?.blockSize || entry.contentRect.height;
                        if (h > 0) widgetHeightCache.set('math-' + this.tex, h);
                    }
                    view.requestMeasure();
                });
                requestAnimationFrame(() => {
                    if (div.isConnected) ro.observe(div);
                });
            }
        } catch (e) {
            console.error('[FlowMD] BlockMath KaTeX render error:', e, 'tex:', this.tex);
            div.textContent = `$$${this.tex}$$`;
        }
        return div;
    }
}
