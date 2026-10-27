/**
 * Live Preview 装饰管线（从 plugin.ts 拆出）：块级后处理收集器：脚注引用/定义 + details 折叠块装饰。
 *
 * @module webview/codemirror/extensions/livePreview/collectBlocks
 */

import { footnoteDefLineDeco } from './decor/decorations.js';
import { windowLines } from './ranges.js';
import type { ILineRange } from './types.js';
import { HtmlBlockWidget } from './widgets/htmlBlockWidget.js';
import { DetailsWidget, FootnoteDefWidget, FootnoteRefWidget } from './widgets/simpleWidgets.js';
import type { EditorState } from '@codemirror/state';
import { Decoration } from '@codemirror/view';


// =============================================================================
// Post-Processing Functions (extracted from buildDecorations)
// =============================================================================

/**
 * Collect footnote decorations (definitions and references).
 * Pre-scans the full document to build a label→index map,
 * then decorates definition lines and inline references.
 */
export function collectFootnoteDecorations(
    state: EditorState,
    decos: Array<ReturnType<Decoration['range']>>,
    range: ILineRange,
    focusedRange: ILineRange
): void {
    // 快速跳过：窗口里连 `[^` 都没有，就不可能有关联的引用或定义（两种写法都带这个记号）。
    // 这一条让「没有脚注的文档」在这个 pass 上花 0 时间 —— 它原本是整篇扫两遍，实测 2.4ms。
    let hasFootnoteMark = false;
    const win = windowLines(state, range);
    for (let ln = win.first; ln <= win.last && !hasFootnoteMark; ln++) {
        if (state.doc.line(ln).text.includes('[^')) hasFootnoteMark = true;
    }
    if (!hasFootnoteMark) return;

    // Single-pass: collect footnote labels and build decorations together.
    // First pass collects labels only (needed for numbering).
    const footnoteLabels: string[] = [];
    const defRegex = /^\[\^([^\]]+)\]:/;
    for (let ln = 1; ln <= state.doc.lines; ln++) {
        const defMatch = state.doc.line(ln).text.match(defRegex);
        if (defMatch && !footnoteLabels.includes(defMatch[1])) {
            footnoteLabels.push(defMatch[1]);
        }
    }

    // Second pass: build decorations（只看窗口内的行）
    const refRegex = /\[\^([^\]]+)\]/g;
    const defFullRegex = /^\[\^([^\]]+)\]:\s?/;
    for (let ln = win.first; ln <= win.last; ln++) {
        const line = state.doc.line(ln);

        if (line.from < focusedRange.to && line.to > focusedRange.from) {
            continue;
        }

        // Footnote definition
        const defMatch = line.text.match(defFullRegex);
        if (defMatch) {
            const label = defMatch[1];
            const index = footnoteLabels.indexOf(label) + 1 || footnoteLabels.length + 1;
            decos.push(footnoteDefLineDeco.range(line.from));
            decos.push(
                Decoration.replace({
                    widget: new FootnoteDefWidget(label, index),
                }).range(line.from, line.from + defMatch[0].length)
            );
            continue;
        }

        // Footnote references in text
        refRegex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = refRegex.exec(line.text)) !== null) {
            const label = match[1];
            const refFrom = line.from + match.index;
            const refTo = refFrom + match[0].length;
            const index = footnoteLabels.indexOf(label) + 1 || footnoteLabels.length + 1;
            decos.push(
                Decoration.replace({
                    widget: new FootnoteRefWidget(label, index),
                }).range(refFrom, refTo)
            );
        }
    }
}


/**
 * HTML 块是否交给 {@link HtmlBlockWidget} 渲染。
 *
 * 只放行「至少有一个可渲染展示标签」的块：
 * - `<details>` 由 collectDetailsDecorations 的折叠 widget 负责，跳过避免双重替换；
 * - 注释 / `<script>` / `<style>` 渲染出来是空的，保持源码显示更诚实。
 *
 * @param raw - HTML 块原文
 * @returns 是否渲染成 widget
 */
export function isRenderableHtmlBlock(raw: string): boolean {
    const text = raw.trim();
    if (!text) return false;
    if (/^<details\b/i.test(text)) return false;
    if (text.startsWith('<!--')) return false;
    if (/<(?:script|style)\b/i.test(text)) return false;
    return /<(?:p|div|center|b|strong|i|em|img|a|br|span|h[1-6]|table|ul|ol|li|blockquote|figure)\b/i.test(
        text
    );
}


/**
 * Collect details/summary decorations.
 * Handles both single-line and multi-line <details> blocks.
 */
export function collectDetailsDecorations(
    state: EditorState,
    decos: Array<ReturnType<Decoration['range']>>,
    range: ILineRange,
    focusedRange: ILineRange
): void {
    const win = windowLines(state, range);
    for (let ln = win.first; ln <= win.last; ln++) {
        const line = state.doc.line(ln);

        if (line.from < focusedRange.to && line.to > focusedRange.from) {
            continue;
        }

        const lineLower = line.text.trimStart().toLowerCase();
        if (!lineLower.startsWith('<details')) continue;

        // Single-line details
        if (lineLower.includes('</details>')) {
            const fullText = line.text;
            const summaryMatch = fullText.match(/<summary>(.*?)<\/summary>/is);
            const summaryText = summaryMatch ? summaryMatch[1].trim() : 'Details';
            const contentMatch = fullText.match(/<\/summary>([\s\S]*?)<\/details>/i);
            const contentText = contentMatch ? contentMatch[1].trim() : '';
            decos.push(
                Decoration.replace({
                    widget: new DetailsWidget(summaryText, contentText),
                }).range(line.from, line.to)
            );
            continue;
        }

        // Multi-line details: find closing </details>
        let closingLn = ln + 1;
        let found = false;
        while (closingLn <= state.doc.lines) {
            if (state.doc.line(closingLn).text.toLowerCase().includes('</details>')) {
                found = true;
                break;
            }
            closingLn++;
        }
        if (!found) continue;

        const closingLine = state.doc.line(closingLn);
        if (closingLine.from < focusedRange.to && closingLine.to > focusedRange.from) {
            continue;
        }

        const fullText = state.doc.sliceString(line.from, closingLine.to);
        const summaryMatch = fullText.match(/<summary>(.*?)<\/summary>/is);
        const summaryText = summaryMatch ? summaryMatch[1].trim() : 'Details';
        const contentMatch = fullText.match(/<\/summary>([\s\S]*?)<\/details>/i);
        const contentText = contentMatch ? contentMatch[1].trim() : '';

        decos.push(
            Decoration.replace({
                widget: new DetailsWidget(summaryText, contentText),
                block: true,
            }).range(line.from, closingLine.to)
        );
        ln = closingLn;
    }
}
