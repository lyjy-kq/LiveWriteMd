/**
 * Selection Highlight Plugin
 *
 * Renders selection highlights using mark decorations instead of drawSelection()
 * rectangles in ALL modes (live preview, viewer, source).
 *
 * drawSelection() renders at z-index:-2, which causes selection rectangles to
 * be hidden behind elements with background-color. Mark decorations render at
 * inline level, so they always appear above backgrounds and only cover actual
 * text characters — no padding bleed into line padding areas.
 *
 * Additionally, widget elements (math, mermaid, table, image, etc.) that fall
 * within the selection range are highlighted via a CSS class on their DOM node,
 * since mark decorations cannot visually cover replace-decoration widgets.
 *
 * The drawSelection() selection layer (.cm-selectionLayer) is hidden by CSS
 * (see styles.ts 的「选区高亮层」), **不能**靠这里设一次内联 display:none ——
 * CodeMirror 的 LayerView 每次重画都会把内联 display 改回去，实测会留出
 * 一条通栏色块和 mark 高亮叠成两重选择框。
 * The cursor layer (.cm-cursorLayer) is unaffected and remains visible.
 *
 * @module webview/codemirror/extensions/livePreview/codeBlockSelection
 */

import { RangeSet } from '@codemirror/state';
import {
    Decoration,
    type DecorationSet,
    EditorView,
    ViewPlugin,
    type ViewUpdate,
} from '@codemirror/view';

const selMark = Decoration.mark({ class: 'cm-codeblock-selected' });

/** CSS classes of widget root elements that should show selection highlight */
const WIDGET_SELECTORS = [
    '.cm-md-math-inline',
    '.cm-md-math-block',
    '.cm-md-mermaid-wrapper',
    '.cm-md-frontmatter',
    '.cm-md-image-wrapper',
    '.cm-md-details',
].join(',');

const WIDGET_SELECTED_CLASS = 'cm-widget-selected';

class SelectionHighlightValue {
    decorations: DecorationSet;

    constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view);
        this.updateWidgetSelection(view);
    }

    update(update: ViewUpdate): void {
        if (update.docChanged || update.selectionSet) {
            this.decorations = this.buildDecorations(update.view);
            // Defer widget selection until after CM6 finishes DOM update,
            // since decoration rebuild may create new widget DOM nodes.
            requestAnimationFrame(() => this.updateWidgetSelection(update.view));
        }
    }

    private buildDecorations(view: EditorView): DecorationSet {
        const activeRanges = view.state.selection.ranges.filter((r) => r.from !== r.to);
        if (activeRanges.length === 0) return Decoration.none;

        const decos: ReturnType<Decoration['range']>[] = [];
        for (const sel of activeRanges) {
            if (sel.from < sel.to) {
                decos.push(selMark.range(sel.from, sel.to));
            }
        }
        if (decos.length === 0) return Decoration.none;
        return RangeSet.of(decos, true);
    }

    /**
     * Add/remove selection highlight class on widget DOM elements
     * that overlap with the current selection ranges.
     */
    private updateWidgetSelection(view: EditorView): void {
        const activeRanges = view.state.selection.ranges.filter((r) => r.from !== r.to);

        // Clear previous
        view.contentDOM.querySelectorAll('.' + WIDGET_SELECTED_CLASS).forEach((el) => {
            el.classList.remove(WIDGET_SELECTED_CLASS);
        });

        if (activeRanges.length === 0) return;

        const widgets = view.contentDOM.querySelectorAll(WIDGET_SELECTORS);
        for (const el of Array.from(widgets)) {
            try {
                const pos = view.posAtDOM(el);
                if (activeRanges.some((r) => pos >= r.from && pos < r.to)) {
                    el.classList.add(WIDGET_SELECTED_CLASS);
                }
            } catch {
                // posAtDOM may throw for detached nodes — ignore
            }
        }
    }
}

export const codeBlockSelectionPlugin = ViewPlugin.fromClass(SelectionHighlightValue, {
    decorations: (v) => v.decorations,
});
