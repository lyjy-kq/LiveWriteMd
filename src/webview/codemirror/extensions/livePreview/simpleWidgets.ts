/**
 * Live Preview Widget（从 widgets.ts 拆出）：小件 widget 集合：分割线 / 列表圆点 / 字体文本 / gutter 折叠 / 复选框 / 代码块复制 / 脚注 / Details。
 *
 * @module webview/codemirror/extensions/livePreview/simpleWidgets
 */

import { measureBulletYCorrection } from './bulletAlign.js';
import { renderInlineMarkdown } from './inlineEngine.js';
import { applySafeFontStyles } from './sourceParse.js';
import { copyToClipboard, foldToggleEffect, foldedLinesOf, rememberWidgetHeight, widgetHeightCache } from './state.js';
import { measureBulletWidth, measureTextIn } from './textMeasure.js';
import type { MeasureEnv } from './textMeasure.js';
import { Transaction } from '@codemirror/state';
import { EditorView, WidgetType } from '@codemirror/view';

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
