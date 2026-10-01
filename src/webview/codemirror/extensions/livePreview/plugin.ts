/**
 * Live Preview Plugin
 *
 * Core ViewPlugin for Obsidian-style live preview.
 * Manages decorations: hides Markdown markers in non-focused blocks
 * and renders widgets (tables, math, mermaid, etc.).
 *
 * @module webview/codemirror/extensions/livePreview/plugin
 */

import { ensureSyntaxTree, indentUnit, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, type Transaction, RangeSet, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';
import type { SyntaxNode, Tree } from '@lezer/common';
import { findFileLinkAtText, findFileLinkMatches } from '../../../../shared/fileLink.js';

import {
    blockquoteLevelDecos,
    boldMarkDeco,
    codeMarkDeco,
    flowMdDarkHighlight,
    flowMdLightHighlight,
    footnoteDefLineDeco,
    headingLineDecos,
    hideDeco,
    imageLineDeco,
    italicMarkDeco,
    hiddenSourceDeco,
    strikethroughMarkDeco,
} from './decorations.js';
import {
    extractFencedCodeContent,
    extractFencedCodeLanguage,
    extractSafeFontStyles,
    createCodeBlockIndentStyle,
    createListIndentStyle,
    detectIndentUnit,
    getCodeBlockIndentInfo,
    getListIndent,
    measureBulletDotOffsetPx,
    measureIndentUnitPx,
    measureText,
    parseFrontmatter,
    splitMarkdownImageDestination,
} from './helpers.js';
import {
    collectFocusDecorations,
    computeFocusSignature,
    findActiveInlineNode,
    isInlineRenderable,
    isWithinActiveInline,
} from './focusMarks.js';
import {
    DEFAULT_MEDIA_WIDTH_PERCENT,
    formatMediaWidthAttribute,
    measureTrailingWidthAttribute,
    parseMediaWidthPercent,
    splitTrailingWidthAttribute,
} from './mediaWidth.js';
import {
    getSourceRange,
    isSetextBeforeFence,
    overlaps,
    renderRange,
    windowLines,
} from './ranges.js';
import {
    collectCodeSpanMathDecorations,
    collectMathDecorations,
    collectMathSourceRanges,
} from './mathCollect.js';
import { scrollPreserverExtension } from './scrollHack.js';
import {
    hasUnmeasuredTables,
    collectTableDecorations,
    isInTableCell,
    isTableLikeBlock,
    tableCellSelection,
    tablePipeEscaper,
    tableResizePlugin,
    tableSourceModeHandler,
} from './tableRender.js';
import { autoPairBrackets } from './autoPair.js';
import {
    exitPinnedForceIfOutside,
    exitSourceModeIfOutside,
    foldToggleEffect,
    foldedListItems,
    isForcedSourceRange,
    isInSourceMode,
    lineForceEffect,
    mapForceRanges,
    patchLineForce,
    setSourceModeRange,
    sourceModeEffect,
    tableRemeasureEffect,
} from './state.js';
import { lineForcePlugin, nativeAnchoredMouseSelection } from './lineForce.js';
import { createBaseThemeStyles } from './styles.js';
import type { ILineRange } from './types.js';
import {
    BulletWidget,
    CheckboxWidget,
    CodeBlockCopyWidget,
    DetailsWidget,
    FoldArrowWidget,
    FootnoteDefWidget,
    FootnoteRefWidget,
    FrontmatterWidget,
    HorizontalRuleWidget,
    ImageWidget,
    FontTextWidget,
    MermaidWidget,
} from './widgets.js';

/**
 * 使用源文本中的范围替换指定区间内容。
 *
 * 这个 helper 统一封装 WorkspaceEdit 风格的文本替换操作，避免在各个 widget
 * 回写入口里重复拼接 dispatch 细节。
 *
 * @param view - 当前 CodeMirror 视图
 * @param from - 需要替换的起始位置
 * @param to - 需要替换的结束位置
 * @param insert - 需要写回的新文本
 * @returns void
 */
function replaceSourceRange(view: EditorView, from: number, to: number, insert: string): void {
    if (from >= to) {
        return;
    }

    if (view.state.sliceDoc(from, to) === insert) {
        return;
    }

    view.dispatch({
        changes: { from, to, insert },
    });
}

/**
 * 回写 Markdown 图片语法中的 alt 文本。
 *
 * 该函数兼容 wiki 图片和标准 Markdown 图片两种写法：
 * - wiki 图片：`![[target|alias]]`
 * - Markdown 图片：`![alt](url)`
 *
 * @param view - 当前 CodeMirror 视图
 * @param from - 图片语法起始位置
 * @param to - 图片语法结束位置
 * @param rawImageText - 图片块的原始文本
 * @param nextTitle - 用户提交的新标题
 * @returns void
 */
function updateImageTitleInSource(
    view: EditorView,
    from: number,
    to: number,
    rawImageText: string,
    nextTitle: string
): void {
    // 先把宽度属性剥出来，改完标题再原样接回去，避免编辑标题时把宽度丢掉。
    const { base, attribute } = splitTrailingWidthAttribute(rawImageText);

    const wikiMatch = base.match(/^!\[\[([^\]\n]+?)\]\]$/);
    if (wikiMatch) {
        const [rawTarget] = wikiMatch[1].split('|', 2);
        const title = nextTitle.trim();
        const nextValue = title ? `![[${rawTarget.trim()}|${title}]]` : `![[${rawTarget.trim()}]]`;
        replaceSourceRange(view, from, to, `${nextValue}${attribute}`);
        return;
    }

    const markdownMatch = base.match(/^!\[([^\]]*?)\]\(([^)\n]+)\)$/);
    if (markdownMatch) {
        const destination = markdownMatch[2];
        const title = nextTitle.trim();
        const nextValue = `![${title}](${destination})`;
        replaceSourceRange(view, from, to, `${nextValue}${attribute}`);
    }
}

/**
 * 回写图片的宽度属性。
 *
 * `from`/`to` 已经覆盖了原有的宽度属性（decoration 范围特意往后多圈了一段），
 * 所以这里在去掉属性后的基础语法上重新追加，不会出现属性叠加。
 *
 * @param view - 当前 CodeMirror 视图
 * @param from - 图片语法起始位置（含尾随属性）
 * @param to - 图片语法结束位置（含尾随属性）
 * @param rawImageText - 整段原始文本
 * @param nextPercent - 新的宽度百分比
 * @returns void
 */
function updateImageWidthInSource(
    view: EditorView,
    from: number,
    to: number,
    rawImageText: string,
    nextPercent: number
): void {
    const { base } = splitTrailingWidthAttribute(rawImageText);
    replaceSourceRange(view, from, to, `${base}${formatMediaWidthAttribute(nextPercent)}`);
}

/**
 * 回写 Mermaid 代码块 info 行里的宽度属性。
 *
 * info 行同时承载标题（`mermaid 标题`）和宽度（`{width=50%}`），
 * 重写时先把宽度剥掉，再把新属性接到标题后面。
 *
 * @param view - 当前 CodeMirror 视图
 * @param codeInfoFrom - CodeInfo 节点起始位置
 * @param lineTo - fenced code opener 行尾部位置
 * @param nextPercent - 新的宽度百分比
 * @returns void
 */
function updateMermaidWidthInSource(
    view: EditorView,
    codeInfoFrom: number,
    lineTo: number,
    nextPercent: number
): void {
    const rawInfo = view.state.sliceDoc(codeInfoFrom, lineTo);
    const baseInfo = splitTrailingWidthAttribute(rawInfo).base.trimEnd();
    const attribute = formatMediaWidthAttribute(nextPercent);
    replaceSourceRange(view, codeInfoFrom, lineTo, attribute ? `${baseInfo} ${attribute}` : baseInfo);
}

/**
 * 回写 Mermaid 代码块的标题文本。
 *
 * 这里采用 fenced code block info 行的扩展写法：
 * `mermaid` 后面允许追加一个标题词组，便于在预览标题中编辑后同步保存。
 *
 * @param view - 当前 CodeMirror 视图
 * @param codeInfoFrom - CodeInfo 节点起始位置
 * @param lineTo - 当前 fenced code opener 行尾部位置
 * @param nextTitle - 用户提交的新标题
 * @returns void
 */
function updateMermaidTitleInSource(
    view: EditorView,
    codeInfoFrom: number,
    lineTo: number,
    nextTitle: string
): void {
    const title = nextTitle.trim();
    const nextValue = title ? `mermaid ${title}` : 'mermaid';
    // 同图片：标题写在 info 行前面，宽度属性原样保留在后面。
    const attribute = splitTrailingWidthAttribute(view.state.sliceDoc(codeInfoFrom, lineTo)).attribute;
    replaceSourceRange(view, codeInfoFrom, lineTo, `${nextValue}${attribute}`);
}

// =============================================================================
// Post-Processing Functions (extracted from buildDecorations)
// =============================================================================

/**
 * Collect footnote decorations (definitions and references).
 * Pre-scans the full document to build a label→index map,
 * then decorates definition lines and inline references.
 */
function collectFootnoteDecorations(
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
 * Collect details/summary decorations.
 * Handles both single-line and multi-line <details> blocks.
 */
function collectDetailsDecorations(
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

/**
 * 收集普通文本中的文件路径装饰，用于提示可 Ctrl/Cmd+点击跳转。
 *
 * @param state - 当前编辑器状态
 * @param decos - 待写入的装饰数组
 * @param focusedRange - 当前正在编辑的聚焦区间
 * @returns void
 */
function collectFileLinkDecorations(
    state: EditorState,
    decos: Array<ReturnType<Decoration['range']>>,
    range: ILineRange,
    focusedRange: ILineRange
): void {
    const fileLinkDeco = Decoration.mark({ class: 'cm-md-file-link' });
    const win = windowLines(state, range);

    for (let ln = win.first; ln <= win.last; ln++) {
        const line = state.doc.line(ln);
        if (line.from < focusedRange.to && line.to > focusedRange.from) {
            continue;
        }
        // 快速跳过：路径匹配式的第一段必然含斜杠（盘符 `C:\`、`/`、`a/b` 都算），
        // 中文正文里几乎没有任何一行含斜杠 —— 这一条把整篇的逐行正则省掉了（实测 1.9ms → 0）。
        if (!line.text.includes('/') && !line.text.includes('\\')) continue;

        for (const fileLinkMatch of findFileLinkMatches(line.text)) {
            decos.push(
                fileLinkDeco.range(line.from + fileLinkMatch.start, line.from + fileLinkMatch.end)
            );
        }
    }
}

/**
 * 收集标题中的 `<font>` 装饰。
 *
 * 这里只恢复标题级场景，避免把正文段落里的 `<font>` 行为一并放开。
 *
 * @param state - 当前编辑器状态。
 * @param decos - 待追加的装饰数组。
 * @param focusedRange - 当前聚焦的源码区间。
 * @param tree - 当前语法树。
 * @returns void
 */
function collectHeadingFontDecorations(
    state: EditorState,
    decos: Array<ReturnType<Decoration['range']>>,
    range: ILineRange,
    focusedRange: ILineRange,
    tree: Tree
): void {
    const win = windowLines(state, range);
    /**
     * 判断指定位置是否落在需要保护的源码区域内。
     *
     * 这里会屏蔽行内代码、代码块、表格等区域，避免把 `<font>` widget 错误地
     * 嵌入到源码示例或结构化内容里。
     *
     * @param pos - 需要检测的文档位置。
     * @returns 是否位于保护区域。
     */
    const isInsideProtectedNode = (pos: number): boolean => {
        let node = tree.resolveInner(pos, 1);
        while (node) {
            const name = node.type.name;
            if (
                name === 'InlineCode' ||
                name === 'CodeMark' ||
                name === 'FencedCode' ||
                name === 'CodeText' ||
                name === 'CodeBlock' ||
                name === 'CodeInfo' ||
                name === 'Table' ||
                name.startsWith('Table')
            ) {
                return true;
            }
            if (!node.parent || node.parent === node) {
                break;
            }
            node = node.parent;
        }

        return false;
    };

    /**
     * 判断当前行是否属于标题行。
     *
     * 兼容 ATX 标题与 Setext 标题，确保 `test2.md` 里的标题写法都能进入渲染分支。
     *
     * @param lineText - 当前行文本。
     * @param nextLineText - 下一行文本，用于判断 Setext 标题。
     * @returns 是否为标题行。
     */
    const isHeadingLine = (lineText: string, nextLineText: string | undefined): boolean => {
        if (/^\s{0,3}(#{1,6})\s+.+$/.test(lineText)) {
            return true;
        }

        if (!nextLineText) {
            return false;
        }

        return /^\s*=+\s*$/.test(nextLineText) || /^\s*-+\s*$/.test(nextLineText);
    };

    const fontRegex = /<font\b([^>]*)>([\s\S]*?)<\/font>/gi;

    for (let ln = win.first; ln <= win.last; ln++) {
        const line = state.doc.line(ln);
        const nextLineText = ln < state.doc.lines ? state.doc.line(ln + 1).text : undefined;

        if (line.from < focusedRange.to && line.to > focusedRange.from) {
            continue;
        }

        const lineText = line.text;
        if (!lineText.includes('<font')) continue;
        if (!isHeadingLine(lineText, nextLineText)) continue;
        if (isInsideProtectedNode(line.from)) continue;

        fontRegex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = fontRegex.exec(lineText)) !== null) {
            const innerText = match[2];
            if (!innerText.trim()) continue;

            const fontFrom = line.from + match.index;
            const fontTo = fontFrom + match[0].length;
            if (fontFrom < focusedRange.to && fontTo > focusedRange.from) continue;
            if (isInsideProtectedNode(fontFrom)) continue;

            const styles = extractSafeFontStyles(match[1]);
            decos.push(
                Decoration.replace({
                    widget: new FontTextWidget(styles, innerText),
                }).range(fontFrom, fontTo)
            );
        }
    }
}

/**
 * Collect inline checkbox decorations.
 * Matches [ ], [x], [X] outside of list TaskMarkers, code spans, and links.
 */
function collectCheckboxDecorations(
    state: EditorState,
    decos: Array<ReturnType<Decoration['range']>>,
    range: ILineRange,
    focusedRange: ILineRange,
    tree: Tree,
    taskMarkerPositions: Set<number>
): void {
    const cbRegex = /\[([ xX])\]/g;
    const win = windowLines(state, range);
    for (let ln = win.first; ln <= win.last; ln++) {
        const line = state.doc.line(ln);

        if (line.from < focusedRange.to && line.to > focusedRange.from) {
            continue;
        }

        // Quick skip: lines without [ can't contain checkboxes
        if (!line.text.includes('[')) continue;

        cbRegex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = cbRegex.exec(line.text)) !== null) {
            const cbFrom = line.from + match.index;
            const cbTo = cbFrom + 3; // [ ] or [x] is always 3 chars

            // Skip if already handled as TaskMarker in list items
            if (taskMarkerPositions.has(cbFrom)) continue;

            // 上下文边界检查：任务复选框只该出现在行首/列表标记之后，
            // 且 `]` 后面按 CommonMark 规定必须跟空白或位于行尾。
            // 不检查的话算法笔记里的数组下标会被误渲染：
            // `dp[x]` → 勾选框、`a[ ]` → 空框。
            const charBefore = state.doc.sliceString(cbFrom - 1, cbFrom);
            if (/[\p{L}\p{N}_]/u.test(charBefore)) continue;
            const charAfter = state.doc.sliceString(cbTo, cbTo + 1);
            // 非空白且不是行尾就跳过（链接 `[x](url)` 的 `(` 也一并被排除）
            if (charAfter !== '' && !/\s/.test(charAfter)) continue;

            // Skip if inside code span (InlineCode node)
            let node = tree.resolveInner(cbFrom, 1);
            let inCode = false;
            while (node) {
                if (
                    node.name === 'InlineCode' ||
                    node.name === 'FencedCode' ||
                    node.name === 'CodeBlock'
                ) {
                    inCode = true;
                    break;
                }
                if (!node.parent || node.parent === node) break;
                node = node.parent;
            }
            if (inCode) continue;

            const checked = match[1] === 'x' || match[1] === 'X';
            // 和行内公式同一套：源码盖住（压 0 宽）+ widget 夹在中间。
            // 不能用整段 replace —— 单元格里的「格子」是 mark 包出来的盒子，
            // 格子里整段都是 replace 的话，CodeMirror 会连盒子一起丢掉。
            decos.push(hiddenSourceDeco.range(cbFrom, cbFrom + 1));
            decos.push(hiddenSourceDeco.range(cbFrom + 1, cbTo));
            decos.push(
                Decoration.widget({
                    widget: new CheckboxWidget(checked, cbFrom),
                    side: -1,
                }).range(cbFrom + 1)
            );
        }
    }
}

/**
 * 收集 wiki 图片与包含空格的 Markdown 图片装饰。
 *
 * 这里保留原有标准 Markdown 图片渲染分支，同时补上 Wiki 图片语法
 * 与空格文件名场景，避免预览端只认一种写法。
 *
 * @param state - 当前编辑器状态
 * @param decos - 装饰集合输出容器
 * @param focusedRange - 当前正在编辑的块范围
 */
function collectImageDecorations(
    state: EditorState,
    decos: Array<ReturnType<Decoration['range']>>,
    range: ILineRange,
    focusedRange: ILineRange,
    tree: Tree
): void {
    const wikiImageRegex = /!\[\[([^\]\n]+?)\]\]/g;
    const markdownImageRegex = /!\[([^\]]*?)\]\(([^)\n]+)\)/g;

    treeLikeIterateTextBlocks(
        state,
        // 夹到窗口内：公共遍历是按聚焦范围走语法树的，这里只关心窗口里的图
        { from: Math.max(focusedRange.from, range.from), to: Math.min(focusedRange.to, range.to) },
        tree,
        (from, to, text) => {
        wikiImageRegex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = wikiImageRegex.exec(text)) !== null) {
            const inner = match[1];
            const [rawTarget, alias] = inner.split('|', 2);
            const imageUrl = rawTarget.trim();
            if (!imageUrl) {
                continue;
            }

            const altText = alias ?? '';
            // wiki 图片同样支持尾随宽度属性，范围要把属性一起圈进来。
            const wikiFrom = from + match.index;
            const wikiTo =
                wikiFrom +
                match[0].length +
                measureTrailingWidthAttribute(text.slice(match.index + match[0].length));
            // 单元格里不渲染图片：格子是 mark 包出来的，整段 replace 会把盒子顶掉
            if (isInTableCell(tree, wikiFrom)) continue;
            const wikiRawText = state.doc.sliceString(wikiFrom, wikiTo);
            const wikiWidth =
                parseMediaWidthPercent(wikiRawText) ?? DEFAULT_MEDIA_WIDTH_PERCENT;

            addImageLineDecoration(state, decos, wikiFrom, wikiTo);
            decos.push(
                Decoration.replace({
                    widget: new ImageWidget(
                        imageUrl,
                        altText,
                        wikiFrom,
                        wikiTo,
                        null,
                        wikiWidth,
                        (widgetView: EditorView, nextPercent: number) => {
                            updateImageWidthInSource(
                                widgetView,
                                wikiFrom,
                                wikiTo,
                                wikiRawText,
                                nextPercent
                            );
                        }
                    ),
                }).range(wikiFrom, wikiTo)
            );
        }

        markdownImageRegex.lastIndex = 0;
        while ((match = markdownImageRegex.exec(text)) !== null) {
            const altText = match[1];
            const rawDestination = splitMarkdownImageDestination(match[2]);

            // 标准无空格的 Markdown 图片保留给原有 syntax tree 分支处理，
            // 这里只补充空格路径，避免重复装饰。
            if (!/\s/.test(rawDestination)) {
                continue;
            }

            if (!rawDestination) {
                continue;
            }

            const spacedFrom = from + match.index;
            // 单元格里不渲染图片：格子是 mark 包出来的，整段 replace 会把盒子顶掉
            if (isInTableCell(tree, spacedFrom)) continue;
            const spacedTo =
                spacedFrom +
                match[0].length +
                measureTrailingWidthAttribute(text.slice(match.index + match[0].length));
            const spacedRawText = state.doc.sliceString(spacedFrom, spacedTo);
            const spacedWidth =
                parseMediaWidthPercent(spacedRawText) ?? DEFAULT_MEDIA_WIDTH_PERCENT;

            addImageLineDecoration(state, decos, spacedFrom, spacedTo);
            decos.push(
                Decoration.replace({
                    widget: new ImageWidget(
                        rawDestination,
                        altText,
                        spacedFrom,
                        spacedTo,
                        null,
                        spacedWidth,
                        (widgetView: EditorView, nextPercent: number) => {
                            updateImageWidthInSource(
                                widgetView,
                                spacedFrom,
                                spacedTo,
                                spacedRawText,
                                nextPercent
                            );
                        }
                    ),
                }).range(spacedFrom, spacedTo)
            );
        }
    });
}

/**
 * 判断节点是不是「单击保持渲染、双击才进源码」的块级内容。
 *
 * 表格、图片、Mermaid 图这三类在渲染态是一个完整的 widget，
 * 光标一进去就把整块摊成源码会很难看（表格尤其乱），所以改成：
 * 单击只把光标放进源码里（表格因此能就地改单元格），双击才切换成源码。
 *
 * @param node - 语法节点
 * @param state - 编辑器状态，用来读 fenced code 的语言
 * @returns 属于这三类内容时返回 true
 */
function isWidgetBackedNode(node: SyntaxNode, state: EditorState): boolean {
    // 表格不算：它现在是「保留源码 + 就地装饰」，光标进得去，也不再有源码模式
    if (node.name === 'Image') return true;
    if (node.name === 'FencedCode') {
        return extractFencedCodeLanguage(node, state) === 'mermaid';
    }
    return false;
}

/**
 * 图片独占一行时，给这一行挂上居中装饰。
 *
 * 判断依据是源码：这一行「除了图片语法本身」没有别的可视文字。
 * 之所以不在 CSS 里用 `:has(> .cm-md-image-wrapper:only-child)`，
 * 是因为 CM6 会在行内 widget 前插一个 `cm-widgetBuffer` 占位元素，
 * `:only-child` 永远不成立，图片实际上一直是左对齐的（实测确认）。
 *
 * @param state - 当前编辑器状态
 * @param decos - 待写入的装饰数组
 * @param from - 图片语法起点（含宽度属性前后的完整范围起点）
 * @param to - 图片语法终点（宽度属性也算在内）
 */
function addImageLineDecoration(
    state: EditorState,
    decos: Array<ReturnType<Decoration['range']>>,
    from: number,
    to: number
): void {
    const line = state.doc.lineAt(from);
    // 跨行的图片语法不处理，保持原样
    if (state.doc.lineAt(to).number !== line.number) return;
    // 行里还有别的文字（比如「文字 ![图](x.png) 文字」）时不居中，
    // 免得把普通段落整个推到中间
    if (line.text.trim() !== state.doc.sliceString(from, to).trim()) return;
    decos.push(imageLineDeco.range(line.from));
}

/**
 * 遍历适合做图片识别的文本块。
 *
 * 目前只扫描段落与标题，避免把 fenced code、inline code 等内容
 * 误识别为图片语法。
 *
 * @param state - 当前编辑器状态
 * @param focusedRange - 当前正在编辑的块范围
 * @param visit - 回调：接收块起点、终点和块文本
 */
function treeLikeIterateTextBlocks(
    state: EditorState,
    focusedRange: ILineRange,
    tree: Tree,
    visit: (from: number, to: number, text: string) => void
): void {
    // (临时插桩误伤点已移除)
    tree.iterate({
        from: 0,
        to: state.doc.length,
        enter: (nodeRef): boolean | void => {
            const { from, to, name } = nodeRef;

            if (from < focusedRange.to && to > focusedRange.from) {
                return;
            }

            if (from >= to) {
                return;
            }

            if (
                name === 'Paragraph' ||
                name === 'ATXHeading1' ||
                name === 'ATXHeading2' ||
                name === 'ATXHeading3' ||
                name === 'ATXHeading4' ||
                name === 'ATXHeading5' ||
                name === 'ATXHeading6' ||
                name === 'SetextHeading1' ||
                name === 'SetextHeading2'
            ) {
                visit(from, to, state.doc.sliceString(from, to));
            }
        },
    });
}

// =============================================================================
// Live Preview Plugin
// =============================================================================

/**
 * 主遍历：把语法树上的各类节点变成装饰。
 *
 * 要跑两遍，所以抽成函数：
 *
 * - `mode = 'block'`：整篇跑，**只处理会产出 block 装饰的少数情况**
 *   （mermaid 整块替换、折叠列表把子行藏起来的块级替换）。CodeMirror 不允许
 *   ViewPlugin 产出 block 装饰，这些必须由 StateField 提供；而它们影响文档高度，
 *   又不能只算视口，否则滚到那儿高度会跳。
 * - `mode = 'inline'`：按**渲染窗口**跑，处理其余所有情况（行内标记、标题、引用、
 *   代码块外框、水平线……）。这些占绝大多数，都不影响块结构，可以只算视口。
 *
 * @param state - 编辑器状态
 * @param decos - 待写入的装饰数组
 * @param range - 这一遍要处理的范围（block 那遍是整篇，inline 那遍是窗口）
 * @param mode - 这一遍只处理 block 装饰，还是只处理非 block 的
 * @param tree - 语法树
 * @param focusedRange - 当前聚焦块（聚焦块里的块级标记要压 0 宽）
 * @param activeInlineNode - 光标所在的行内元素
 * @param taskMarkerPositions - 列表任务标记的位置集合（遍历时顺带填）
 */
/** 某个列表项是不是折叠着（key 是它所在行的行首位置）。 */
function isFoldedOf(lineFrom: number): boolean {
    return foldedListItems.has(lineFrom);
}

/**
 * 数学公式源码里需要**屏蔽**的其他 Markdown 修饰节点。
 *
 * 公式文本对 lezer 是普通文本，`_`/`*`/`~~`/链接/反引号都会被照常解析；
 * 它们落在 collectMathSourceRanges 给出的公式区间内时一律不装饰
 * （见 applyTreeDecorations 开头的判断）。
 */
const OTHER_MARKUP_NODES = new Set([
    // 强调：`*`、`_`（含标记节点本身，双保险 —— 跨公式边界的半配对
    // Emphasis 整体不在区间内时，区间内那个 EmphasisMark 仍要单独屏蔽）
    'Emphasis',
    'StrongEmphasis',
    'EmphasisMark',
    // 删除线
    'Strikethrough',
    'StrikethroughMark',
    // 链接（含 LinkMark 与 Autolink）
    'Link',
    'Autolink',
    'LinkMark',
    // 行内代码（反引号在公式源码里按原样字符处理）
    'InlineCode',
    'CodeMark',
]);

function applyTreeDecorations(
    state: EditorState,
    decos: Array<ReturnType<Decoration['range']>>,
    range: ILineRange,
    mode: 'block' | 'inline',
    tree: Tree,
    focusedRange: ILineRange,
    activeInlineNode: SyntaxNode | null,
    taskMarkerPositions: Set<number>
): void {
    // 本范围内所有公式源码区间：下面 enter 用它屏蔽其他修饰。
    // 两遍（block 整篇 / inline 窗口）各算一次，与 range 对齐。
    const mathSourceRanges = collectMathSourceRanges(state, range);

    tree.iterate({
        from: range.from,
        to: range.to,
        enter: (nodeRef): boolean | void => {
            const { from, to, name } = nodeRef;

            // Document node spans everything - always process children
            if (name === 'Document') return;

            // 公式源码区间内的其他修饰节点一律不处理（连同子节点一起跳过）。
            // 公式里的 `_`（下标）、`*` 是数学记号：被 hideDeco 替换后文本模式下
            // `x*y` 会直接变成 `xy`、被上 italic 样式后源码也不再是原文。
            // 判定用「节点整体在区间内」；跨边界的半配对由 EmphasisMark 单条兜底。
            if (
                OTHER_MARKUP_NODES.has(name) &&
                mathSourceRanges.some((r) => from >= r.from && to <= r.to)
            ) {
                return false;
            }

            // block 那一遍只处理「会产出 block 装饰」的两种情况，其余一律下探不处理 ——
            // 否则两遍会把同一批装饰各产一份（等于白干一遍，还多出一堆重复装饰）。
            if (mode === 'block') {
                const isMermaidFence =
                    name === 'FencedCode' &&
                    extractFencedCodeLanguage(nodeRef.node, state) === 'mermaid';
                const isFoldedItem =
                    name === 'ListItem' && foldedListItems.has(state.doc.lineAt(from).from);
                if (!isMermaidFence && !isFoldedItem) return;
            }

            // 与聚焦块重叠的节点：默认按「显示源码」处理，直接跳过。
            //
            // 两种「让开」的规矩不一样，按选区空不空来分：
            //
            // - **光标（空选区）**：行内格式照旧渲染（标记隐藏、内容上样式），只有光标
            //   所在的那一个元素展开成源码（见 focusMarks.ts）。否则在正文里点一下，
            //   整行的加粗、行内代码全变回源码，看着像文件坏了。
            // - **拖选（非空选区）**：选中的文字一律变回纯文本 —— 行内格式也不例外，
            //   这是「选中即文本模式」的规则（表格除外，见下面的 keepWidgetRendered：
            //   表格散架了就没法选格子里的字了，但格子**里**的行内格式照样变源码）。
            //
            // 双击进过源码模式的块，不管光标在不在里面，都摊开成源码渲染。
            // （它自己的单击/双击逻辑见 widgets.ts 里的 sourceModeEffect）
            if (isWidgetBackedNode(nodeRef.node, state) && isInSourceMode(from, to)) {
                return;
            }

            // 表格进了源码模式：整块按源码显示，里面的行内元素一个都不处理
            // （不然加粗、公式还是渲染态，看着不像源码）
            if (name === 'Table' && isInSourceMode(from, to)) {
                return false;
            }

            if (from < focusedRange.to && to > focusedRange.from) {
                // 落在行级强制区间（mousedown 待选 / 双击钉住）时，即使是空选区
                // 也不许走渲染态：整行必须是源码，坐标和长度才能稳定
                const canRenderInFocus =
                    state.selection.main.empty &&
                    !isForcedSourceRange(from, to) &&
                    isInlineRenderable(nodeRef.node) &&
                    !isWithinActiveInline(nodeRef.node, activeInlineNode);
                // 表格 / 图片 / Mermaid：单击保持渲染态，只有双击进源码模式才显示原文
                const keepWidgetRendered = isWidgetBackedNode(nodeRef.node, state);
                if (!canRenderInFocus && !keepWidgetRendered) {
                    return;
                }
            }

            // Skip empty ranges
            if (from >= to) return;

            switch (name) {
                // === HIDE MARKERS ===

                case 'HeaderMark': {
                    // Setext 标题的下划线（`---` / `===`）也是一个 HeaderMark。
                    const parent = nodeRef.node.parent;
                    if (parent && parent.name.startsWith('SetextHeading')) {
                        // 如果这一块其实是「表格 + 分隔线」，那条线交给 tableRender 按水平线画，
                        // 这里不能再把它压 0 宽（否则那一行会整行消失）
                        if (isTableLikeBlock(state, parent.from, parent.to)) break;
                        // 下划线后面紧跟着围栏的（正文、`---`、``` 三行紧挨）同理：
                        // 这块不按标题渲染，这条线就照正文里的 `---` 一样画成一条水平线。
                        // 压 0 宽的话整行都会没掉 —— 那正是「这一行不见了」。
                        if (isSetextBeforeFence(state, parent.from, parent.to)) {
                            decos.push(
                                Decoration.replace({
                                    widget: new HorizontalRuleWidget(),
                                }).range(from, to)
                            );
                            break;
                        }
                    }
                    // Hide # marks and trailing space
                    const after = state.doc.sliceString(to, to + 1);
                    const hideEnd = after === ' ' ? to + 1 : to;
                    decos.push(hideDeco.range(from, hideEnd));
                    break;
                }

                case 'EmphasisMark':
                case 'StrikethroughMark':
                case 'CodeMark':
                case 'CodeInfo': {
                    decos.push(hideDeco.range(from, to));
                    break;
                }

                case 'QuoteMark': {
                    // Hide > mark and trailing space
                    const after = state.doc.sliceString(to, to + 1);
                    const hideEnd = after === ' ' ? to + 1 : to;
                    decos.push(hideDeco.range(from, hideEnd));
                    break;
                }

                case 'ListMark': {
                    const text = state.doc.sliceString(from, to);
                    const after = state.doc.sliceString(to, to + 1);
                    const hideEnd = after === ' ' ? to + 1 : to;

                    // Unordered list markers → bullet widget
                    if (text === '-' || text === '*' || text === '+') {
                        decos.push(
                            Decoration.replace({
                                widget: new BulletWidget(text),
                            }).range(from, hideEnd)
                        );
                    }
                    // Ordered list markers stay visible (numbers are meaningful)
                    break;
                }

                case 'TaskMarker': {
                    const markerText = state.doc.sliceString(from, to);
                    const checked = markerText === '[x]' || markerText === '[X]';
                    const afterChar = state.doc.sliceString(to, to + 1);
                    const replaceEnd = afterChar === ' ' ? to + 1 : to;
                    taskMarkerPositions.add(from);
                    decos.push(
                        Decoration.replace({
                            widget: new CheckboxWidget(checked, from),
                        }).range(from, replaceEnd)
                    );
                    break;
                }

                // === LINE-LEVEL DECORATIONS ===

                case 'ATXHeading1':
                case 'ATXHeading2':
                case 'ATXHeading3':
                case 'ATXHeading4':
                case 'ATXHeading5':
                case 'ATXHeading6': {
                    const level = parseInt(name.replace('ATXHeading', ''));
                    const line = state.doc.lineAt(from);
                    decos.push(headingLineDecos[level].range(line.from));
                    break;
                }

                case 'SetextHeading1':
                case 'SetextHeading2': {
                    // 形状是表格的（表格后面紧跟一条 ---，被解析成了 Setext 标题）：
                    // 让给表格渲染。不能按标题涂样式，更不能把那条 --- 当行下划线藏起来
                    // ——那正是「第 44 行不见了」的原因。
                    if (isTableLikeBlock(state, from, to)) break;
                    // 下划线后面紧跟着围栏（正文、---、``` 三行紧挨）同理：这块不是标题，
                    // 不涂标题样式、也不折叠那条下划线（折叠 = 整行消失）。
                    // 那条下划线本身由下面的 HeaderMark 分支画成水平线。
                    if (isSetextBeforeFence(state, from, to)) break;
                    const level = name === 'SetextHeading1' ? 1 : 2;
                    const contentLine = state.doc.lineAt(from);
                    decos.push(headingLineDecos[level].range(contentLine.from));

                    // Collapse the underline line visually (=== or ---)
                    const endLine = state.doc.lineAt(to);
                    if (endLine.number > contentLine.number) {
                        decos.push(
                            Decoration.line({ class: 'cm-md-setext-underline' }).range(endLine.from)
                        );
                    }
                    break;
                }

                case 'Blockquote': {
                    // Only process outermost Blockquote to avoid duplicate line decos
                    if (nodeRef.node.parent?.name === 'Blockquote') break;

                    const startLine = state.doc.lineAt(from);
                    const endLine = state.doc.lineAt(to);
                    for (let ln = startLine.number; ln <= endLine.number; ln++) {
                        const line = state.doc.line(ln);
                        if (line.text.trim() === '') continue;
                        // Count > marks to determine nesting level
                        const gtMatches = line.text.match(/^(\s*>)+/);
                        const level = gtMatches ? (gtMatches[0].match(/>/g) || []).length : 1;
                        const idx = Math.min(level, 5) - 1;
                        decos.push(blockquoteLevelDecos[idx].range(line.from));
                    }
                    break;
                }

                case 'ListItem': {
                    const itemLine = state.doc.lineAt(from);
                    // 缩进引导线不在这里加：它必须「渲染态和编辑态长得一样」，
                    // 而这里的遍历会把聚焦块整块跳过。统一挪到
                    // collectListIndentDecorations，那边按行扫全文，两种状态下都在。

                    // Check if this list item has child list (sub-items)
                    const syntaxNode = nodeRef.node;
                    const hasChildList =
                        syntaxNode.getChild('BulletList') || syntaxNode.getChild('OrderedList');
                    if (hasChildList && mode === 'inline') {
                        // 折角箭头属于渲染态，由 inline 那一遍画
                        decos.push(
                            Decoration.widget({
                                widget: new FoldArrowWidget(itemLine.from, isFoldedOf(itemLine.from)),
                                side: -1,
                            }).range(itemLine.from)
                        );
                    }
                    if (hasChildList) {
                        const isFolded = isFoldedOf(itemLine.from);
                        if (isFolded) {
                            if (mode === 'inline') {
                                decos.push(
                                    Decoration.line({ class: 'cm-md-fold-collapsed-line' }).range(
                                        itemLine.from
                                    )
                                );
                            }
                            // Process ListMark → BulletWidget
                            const listMark = syntaxNode.getChild('ListMark');
                            if (listMark) {
                                const markText = state.doc.sliceString(listMark.from, listMark.to);
                                const afterChar = state.doc.sliceString(
                                    listMark.to,
                                    listMark.to + 1
                                );
                                const hideEnd = afterChar === ' ' ? listMark.to + 1 : listMark.to;
                                if (markText === '-' || markText === '*' || markText === '+') {
                                    decos.push(
                                        Decoration.replace({
                                            widget: new BulletWidget(markText),
                                        }).range(listMark.from, hideEnd)
                                    );
                                }
                            }
                            // Process TaskMarker → CheckboxWidget
                            const taskMarker = syntaxNode.getChild('TaskMarker');
                            if (taskMarker) {
                                const markerText = state.doc.sliceString(
                                    taskMarker.from,
                                    taskMarker.to
                                );
                                const checked = markerText === '[x]' || markerText === '[X]';
                                const afterChar = state.doc.sliceString(
                                    taskMarker.to,
                                    taskMarker.to + 1
                                );
                                const replaceEnd =
                                    afterChar === ' ' ? taskMarker.to + 1 : taskMarker.to;
                                decos.push(
                                    Decoration.replace({
                                        widget: new CheckboxWidget(checked, taskMarker.from),
                                    }).range(taskMarker.from, replaceEnd)
                                );
                            }
                            // Hide child lines：块级替换，只由 block 那一遍产出
                            if (mode === 'block') {
                                const endLine = state.doc.lineAt(to);
                                if (itemLine.to < endLine.to) {
                                    decos.push(
                                        Decoration.replace({ block: true }).range(
                                            itemLine.to,
                                            endLine.to
                                        )
                                    );
                                }
                            }
                            return false; // Skip children（两遍都跳，子行不装饰）
                        }
                    }
                    break;
                }

                case 'Table': {
                    // 表格不再是替换 widget：格子骨架（管道线压 0 宽、单元格定宽、
                    // 分隔行折叠）由 collectTableDecorations 按行处理，格子里的行内元素
                    // 由下面的 StrongEmphasis / Emphasis / InlineCode 等分支照常渲染。
                    // 这里直接下探子节点，让单元格里的行内节点都能被处理到。
                    return;
                }

                case 'FencedCode': {
                    const syntaxNode = nodeRef.node;
                    const language = extractFencedCodeLanguage(syntaxNode, state);
                    // mermaid 是整块替换（block 装饰）：只由 block 那一遍产出。
                    // 这一遍直接跳过整棵子树，否则同一个代码块会被替换两次、撞在一起。
                    if (language === 'mermaid' && mode === 'inline') return false;
                    if (language === 'mermaid') {
                        const content = extractFencedCodeContent(syntaxNode, state);
                        if (content) {
                            const firstLine = state.doc.lineAt(from);
                            const endLine = state.doc.lineAt(to);
                            const codeInfoNode = syntaxNode.getChild('CodeInfo');
                            const codeInfoFrom = codeInfoNode ? codeInfoNode.from : firstLine.from + 3;
                            // info 行形如 `mermaid 标题 {width=50%}`，宽度属性也在这里读。
                            const widthPercent =
                                parseMediaWidthPercent(
                                    state.doc.sliceString(codeInfoFrom, firstLine.to)
                                ) ?? DEFAULT_MEDIA_WIDTH_PERCENT;
                            decos.push(
                                Decoration.replace({
                                    widget: new MermaidWidget(
                                        content,
                                        state.facet(EditorView.darkTheme),
                                        firstLine.from,
                                        endLine.to,
                                        (widgetView: EditorView, nextTitle: string) => {
                                            updateMermaidTitleInSource(
                                                widgetView,
                                                codeInfoFrom,
                                                firstLine.to,
                                                nextTitle
                                            );
                                        },
                                        widthPercent,
                                        (widgetView: EditorView, nextPercent: number) => {
                                            updateMermaidWidthInSource(
                                                widgetView,
                                                codeInfoFrom,
                                                firstLine.to,
                                                nextPercent
                                            );
                                        }
                                    ),
                                    block: true,
                                }).range(firstLine.from, endLine.to)
                            );
                            return false;
                        }
                    }

                    // 普通代码块只保留边框、语言按钮和缩进导引线。
                    {
                        const startLine = state.doc.lineAt(from);
                        const endLine = state.doc.lineAt(to);
                        for (let ln = startLine.number; ln <= endLine.number; ln++) {
                            const line = state.doc.line(ln);
                            const classes = ['cm-md-codeblock'];
                            const attributes: Record<string, string> = {};
                            if (ln === startLine.number) {
                                classes.push('cm-md-codeblock-first');
                            }
                            if (ln === endLine.number) {
                                classes.push('cm-md-codeblock-last');
                            }
                            if (ln > startLine.number && ln < endLine.number) {
                                // 行首空白的视觉列数（Tab 按 state.tabSize 的
                                // tab-stop 算），样式函数据此把色带精确停在文字前。
                                const indentColumns = getCodeBlockIndentInfo(
                                    line.text,
                                    state.tabSize
                                ).columns;
                                // 一个缩进单位占几列：默认 indentUnit = 2 空格，
                                // 色带按它轮换（每按一次 Tab 换一种颜色）。
                                // indentUnit 允许配成 Tab，那时一个单位宽 = tabSize。
                                const unitText = state.facet(indentUnit);
                                const indentUnitColumns =
                                    unitText.charCodeAt(0) === 9
                                        ? state.tabSize * unitText.length
                                        : unitText.length;
                                classes.push('cm-md-codeblock-indent');
                                attributes.style = createCodeBlockIndentStyle(
                                    indentColumns,
                                    indentUnitColumns
                                );
                            }
                            decos.push(
                                Decoration.line({
                                    class: classes.join(' '),
                                    attributes,
                                }).range(line.from)
                            );
                        }
                        const codeContent = extractFencedCodeContent(nodeRef.node, state);
                        if (codeContent !== null) {
                            decos.push(
                                Decoration.widget({
                                    widget: new CodeBlockCopyWidget(codeContent, language),
                                    side: 1,
                                }).range(startLine.to)
                            );
                        }
                    }
                    break;
                }

                // === INLINE STYLING ===

                case 'StrongEmphasis': {
                    const syntaxNode = nodeRef.node;
                    const marks = syntaxNode.getChildren('EmphasisMark');
                    if (marks.length >= 2) {
                        const contentFrom = marks[0].to;
                        const contentTo = marks[marks.length - 1].from;
                        if (contentFrom < contentTo) {
                            decos.push(boldMarkDeco.range(contentFrom, contentTo));
                        }
                    }
                    break;
                }

                case 'Emphasis': {
                    const syntaxNode = nodeRef.node;
                    const marks = syntaxNode.getChildren('EmphasisMark');
                    if (marks.length >= 2) {
                        const contentFrom = marks[0].to;
                        const contentTo = marks[marks.length - 1].from;
                        if (contentFrom < contentTo) {
                            decos.push(italicMarkDeco.range(contentFrom, contentTo));
                        }
                    }
                    break;
                }

                case 'Strikethrough': {
                    const syntaxNode = nodeRef.node;
                    const marks = syntaxNode.getChildren('StrikethroughMark');
                    if (marks.length >= 2) {
                        const contentFrom = marks[0].to;
                        const contentTo = marks[marks.length - 1].from;
                        if (contentFrom < contentTo) {
                            decos.push(strikethroughMarkDeco.range(contentFrom, contentTo));
                        }
                    }
                    break;
                }

                case 'InlineCode': {
                    const syntaxNode = nodeRef.node;
                    const marks = syntaxNode.getChildren('CodeMark');
                    if (marks.length >= 2) {
                        const contentFrom = marks[0].to;
                        const contentTo = marks[marks.length - 1].from;
                        if (contentFrom < contentTo) {
                            decos.push(codeMarkDeco.range(contentFrom, contentTo));
                        }
                    }
                    break;
                }

                case 'Link': {
                    const linkNode = nodeRef.node;

                    const marks = linkNode.getChildren('LinkMark');

                    // 只支持内联链接 `[text](url)`：带着 `[` `]` `(` `)`
                    // 共 4 个 LinkMark。只有 2 个的 `[i]` 是普通字面文本
                    // （数组下标），不藏括号、不加链接类。
                    if (marks.length < 4) return false;
                    // 链接文本区间 = `[` 之后、`]` 之前
                    const textFrom = marks[0].to;
                    const textTo = marks[1].from;
                    const urlNode = linkNode.getChild('URL');
                    // 空链接 `[text]()` 没有 URL 子节点，targetUrl 保持空串
                    const targetUrl = urlNode
                        ? state.doc.sliceString(urlNode.from, urlNode.to)
                        : '';

                    // 藏掉 `[` `]` `(` `)` 四个标记字符
                    marks.forEach((mark) => {
                        decos.push(hideDeco.range(mark.from, mark.to));
                    });
                    // 藏掉括号里的网址文本本身。
                    // 只藏括号字符不藏 URL 的话，网址会原样露在链接文字后面。
                    if (urlNode) {
                        decos.push(hideDeco.range(urlNode.from, urlNode.to));
                    }

                    if (textFrom < textTo) {
                        // 空链接不加 data-href：有链接样式但点不开
                        const attrs: Record<string, string> = {};
                        if (targetUrl) {
                            attrs['data-href'] = targetUrl;
                            attrs['title'] = `${targetUrl} (Ctrl+Click to open)`;
                        }
                        decos.push(
                            Decoration.mark({
                                class: 'cm-md-link',
                                attributes: attrs,
                            }).range(textFrom, textTo)
                        );
                    }
                    return false;
                }

                case 'Autolink': {
                    const autoNode = nodeRef.node;
                    const autoUrlChild = autoNode.getChild('URL');
                    if (autoUrlChild) {
                        const autoUrl = state.doc.sliceString(autoUrlChild.from, autoUrlChild.to);
                        const autoMarks = autoNode.getChildren('LinkMark');
                        for (const mark of autoMarks) {
                            decos.push(hideDeco.range(mark.from, mark.to));
                        }
                        decos.push(
                            Decoration.mark({
                                class: 'cm-md-link',
                                attributes: {
                                    'data-href': autoUrl,
                                    title: `${autoUrl} (Ctrl+Click to open)`,
                                },
                            }).range(autoUrlChild.from, autoUrlChild.to)
                        );
                    }
                    return false;
                }

                case 'URL': {
                    // 内联链接的地址子节点：渲染态已在 Link 分支处理，
                    // 聚焦行时它以源码文字显示——都不走这里的裸网址渲染，
                    // 否则聚焦时括号里的网址会被涂成绿色链接样式
                    if (nodeRef.node.parent?.name === 'Link') break;
                    const bareUrl = state.doc.sliceString(from, to);
                    if (bareUrl.startsWith('http://') || bareUrl.startsWith('https://')) {
                        decos.push(
                            Decoration.mark({
                                class: 'cm-md-link',
                                attributes: {
                                    'data-href': bareUrl,
                                    title: `${bareUrl} (Ctrl+Click to open)`,
                                },
                            }).range(from, to)
                        );
                    }
                    break;
                }

                case 'Image': {
                    const syntaxNode = nodeRef.node;
                    const imgUrlNode = syntaxNode.getChild('URL');
                    const imgUrl = imgUrlNode
                        ? state.doc.sliceString(imgUrlNode.from, imgUrlNode.to)
                        : '';
                    // 宽度属性挂在 Image 节点之外，decoration 要往后多圈一段，
                    // 否则 `{width=50%}` 会以字面量形式留在图片旁边。
                    const imageTo =
                        to +
                        measureTrailingWidthAttribute(
                            state.doc.sliceString(to, Math.min(to + 32, state.doc.length))
                        );
                    const rawImageText = state.doc.sliceString(from, imageTo);
                    // 标题编辑只认 `![alt](url)`，比较时先去掉宽度属性。
                    const imgText = splitTrailingWidthAttribute(rawImageText).base;
                    const altMatch = imgText.match(/!\[([^\]]*)\]/);
                    const altText = altMatch ? altMatch[1] : '';
                    const widthPercent =
                        parseMediaWidthPercent(rawImageText) ?? DEFAULT_MEDIA_WIDTH_PERCENT;

                    if (imgUrl || altText) {
                        addImageLineDecoration(state, decos, from, imageTo);
                        decos.push(
                            Decoration.replace({
                                widget: new ImageWidget(
                                    imgUrl,
                                    altText,
                                    from,
                                    imageTo,
                                    (widgetView: EditorView, nextTitle: string) => {
                                        updateImageTitleInSource(
                                            widgetView,
                                            from,
                                            imageTo,
                                            rawImageText,
                                            nextTitle
                                        );
                                    },
                                    widthPercent,
                                    (widgetView: EditorView, nextPercent: number) => {
                                        updateImageWidthInSource(
                                            widgetView,
                                            from,
                                            imageTo,
                                            rawImageText,
                                            nextPercent
                                        );
                                    }
                                ),
                            }).range(from, imageTo)
                        );
                    }
                    return false;
                }

                case 'HorizontalRule': {
                    decos.push(
                        Decoration.replace({
                            widget: new HorizontalRuleWidget(),
                        }).range(from, to)
                    );
                    break;
                }

                case 'HTMLBlock': {
                    // <details> is handled by post-processing
                    break;
                }
            }
        },
    });
}

/**
 * The Live Preview ViewPlugin.
 *
 * Manages decorations for Obsidian-style live preview.
 * Hides Markdown markers and applies styling in non-focused blocks.
 * Shows raw Markdown source in the focused block.
 */
function buildBlockDecorations(state: EditorState): DecorationSet {
    const decos: Array<ReturnType<Decoration['range']>> = [];
    // 这部分必须整篇算：block 装饰由 StateField 提供，而 StateField 看不到视口
    const range: ILineRange = { from: 0, to: state.doc.length };
    // 源码区间：空选区看光标所在的块，有选区就看选区覆盖的那几行（见 ranges.ts）。
    // 以前拖选时是「沿用上一次光标所在的块」，于是选中的那几行还是渲染态，
    // 用户看不到自己选的是什么；现在选中即源码。
    const focusedRange = getSourceRange(state);
    // Try to get a fully parsed tree within a short budget.
    // If parsing isn't done yet, fall back to the current incremental tree;
    // treeChanged detection in update() will trigger a rebuild with the complete tree.
    const tree = ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
    const taskMarkerPositions = new Set<number>();
    // 光标所在的行内元素（加粗/斜体/行内代码）——它会被 focusMarks 展开成源码，
    // 同一行里其它行内元素照常渲染，这样点一下不会让整行都变样。
    const activeInlineNode = findActiveInlineNode(state, tree);
    // 表格 / 图片 / Mermaid 的源码模式：光标点去别处就自动退出。
    // 必须在下面的树遍历之前清掉，否则这一轮还会按「源码模式」渲染。
    exitSourceModeIfOutside(state.selection.main.from, state.selection.main.to);

    // === FRONTMATTER DETECTION ===
    // Check if document starts with --- (YAML frontmatter)
    let frontmatterEndLine = -1;
    // frontmatter 在文档最开头：窗口没盖住开头就跳过（它是个替换 widget，
    // 离开视口时靠 estimatedHeight 撑高度就够了，不必每轮都算）
    if (state.doc.lines >= 2 && range.from === 0) {
        const firstLine = state.doc.line(1);
        if (firstLine.text.trim() === '---') {
            for (let ln = 2; ln <= state.doc.lines; ln++) {
                if (state.doc.line(ln).text.trim() === '---') {
                    frontmatterEndLine = ln;
                    break;
                }
            }
            if (frontmatterEndLine > 0) {
                const fmFrom = firstLine.from;
                const fmTo = state.doc.line(frontmatterEndLine).to;
                // Only render widget if frontmatter is not inside focused range
                if (!(fmFrom < focusedRange.to && fmTo > focusedRange.from)) {
                    const yamlText = state.doc.sliceString(
                        state.doc.line(2).from,
                        state.doc.line(frontmatterEndLine).from
                    );
                    const properties = parseFrontmatter(yamlText);
                    if (properties.length > 0) {
                        decos.push(
                            Decoration.replace({
                                widget: new FrontmatterWidget(properties),
                                block: true,
                            }).range(firstLine.from, fmTo)
                        );
                    }
                }
            }
        }
    }



    // 会产出 **block 装饰** 的收集器只能待在这里（CM6 不允许 ViewPlugin 产出 block 装饰）：
    // 公式的多行 `$$`、`<details>`、表格下面那条加行条，都是块级 replace / 块级 widget。
    const full: ILineRange = { from: 0, to: state.doc.length };
    applyTreeDecorations(
        state,
        decos,
        full,
        'block',
        tree,
        focusedRange,
        activeInlineNode,
        taskMarkerPositions
    );
    collectMathDecorations(state, decos, full, focusedRange, tree);
    collectDetailsDecorations(state, decos, full, focusedRange);

    void taskMarkerPositions;
    void activeInlineNode;
    return RangeSet.of(decos, true);
}

/**
 * 窗口部分：只产出 mark / line / 行内 widget 的那些收集器。
 *
 * 它们按**渲染窗口**（视口 ± 余量）算，不算整篇 —— 这是长文档里最大的一笔省：
 * 1547 行的文档，整篇算一次重建要 7ms 上下，按窗口算不到 0.3ms。
 *
 * @param state - 编辑器状态
 * @param range - 渲染窗口
 * @returns 这部分的装饰集
 */
function buildWindowDecorations(state: EditorState, range: ILineRange): DecorationSet {
    const decos: Array<ReturnType<Decoration['range']>> = [];
    const tree = ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
    // 和 block 那一遍用同一套规则算源码区间，两边的判断才不会打架
    const focusedRange = getSourceRange(state);
    const activeInlineNode = findActiveInlineNode(state, tree);

    // 窗口内的任务标记位置：列表项里的 `[ ]` 由主遍历渲染，这里的正则要避开它们
    const taskMarkerPositions = new Set<number>();
    tree.iterate({
        from: range.from,
        to: range.to,
        enter: (nodeRef) => {
            if (nodeRef.name === 'TaskMarker') taskMarkerPositions.add(nodeRef.from);
        },
    });

    applyTreeDecorations(
        state,
        decos,
        range,
        'inline',
        tree,
        focusedRange,
        activeInlineNode,
        taskMarkerPositions
    );
    collectFootnoteDecorations(state, decos, range, focusedRange);
    collectHeadingFontDecorations(state, decos, range, focusedRange, tree);
    collectCheckboxDecorations(state, decos, range, focusedRange, tree, taskMarkerPositions);
    collectImageDecorations(state, decos, range, focusedRange, tree);
    collectFileLinkDecorations(state, decos, range, focusedRange);
    // 行内代码里写的公式（`$$…$$` / `$…$` / 不带定界符的 `A_e`）：
    // 保持反引号的盒子，里面换成 KaTeX。它**不收 focusedRange** ——
    // 让不让开看光标在不在这一格里，见 mathCollect.ts 的说明。
    collectCodeSpanMathDecorations(state, decos, range, tree);
    // 表格骨架：管道线压 0 宽、单元格定宽、分隔行折叠、被框选的格子高亮。
    // mark/line/行内 widget 都不影响块结构，所以可以只算窗口。
    collectTableDecorations(state, decos, tree, range);
    // 列表缩进：层级引导线 + 行首空白对齐（两种状态下长得一样）
    collectListIndentDecorations(state, decos, range);
    // 聚焦块处理：块级标记压 0 宽、行级样式补齐、光标所在的行内元素就地展开
    // 并整体缩放补偿宽度（详见 focusMarks.ts）
    collectFocusDecorations(
        state,
        decos,
        {
            from: Math.max(focusedRange.from, range.from),
            to: Math.min(focusedRange.to, range.to),
        },
        tree,
        activeInlineNode
    );
    return RangeSet.of(decos, true);
}

/**
 * 收集列表缩进的装饰：层级引导线 + 行首空白对齐。
 *
 * 两件事一起做：
 *
 * 1. **行首空白对齐**——把行首空白包成一个定宽的占位块，宽度 = 层级 × 缩进单位。
 *    于是「两个空格」「四个空格」「一个 Tab」写出来的缩进都会落到同一档上，
 *    不会再出现「空格缩进和 Tab 缩进看起来不一样」。
 * 2. **层级引导线**——行级样式里画竖线（两层背景，见 styles.ts 的 `.cm-md-indent`）：
 *    - 祖先那几条（第 0 … 自己层级-1 条）铺满整行，把上一行的线接过来；
 *    - **自己那条从圆点中心往下垂**（只画下半行），一直垂到最后一级 ——
 *      所以这里要先往后看「自己还有没有更深的子级」，没有就不画那半截。
 *
 * 之所以不在主遍历里跟 ListItem 一起处理：主遍历会把**聚焦块整块跳过**，
 * 那样点进某一行时缩进会突然变样。这里按行扫全文，两种状态下结果完全一致。
 *
 * @param state - 当前编辑器状态
 * @param decos - 待写入的装饰数组
 * @returns void，结果直接 push 进 decos
 */
function collectListIndentDecorations(
    state: EditorState,
    decos: Array<ReturnType<Decoration['range']>>,
    range: ILineRange
): void {
    const win = windowLines(state, range);
    const lineCount = win.last;

    // 先探缩进单位：2 空格文档出 2、4 空格文档出 4、Tab 文档出 4。
    // 取样用「窗口里的行 + 开头 200 行」——整篇扫一遍在长文档上白花时间，
    // 而缩进单位这种东西同一份文档里基本是统一的。
    const sampleTexts: string[] = [];
    for (let ln = win.first; ln <= win.last; ln++) sampleTexts.push(state.doc.line(ln).text);
    for (let ln = 1; ln <= Math.min(200, state.doc.lines); ln++) {
        sampleTexts.push(state.doc.line(ln).text);
    }
    const unit = detectIndentUnit(sampleTexts);
    const unitPx = measureIndentUnitPx(unit);

    // 每行的缩进层级与行首空白长度；层级 -1 表示这一行根本不是列表行。
    // 数组下标按「行号 - 窗口起始行号」算，所以下面一律用 ln - win.first 取。
    const levels: number[] = [];
    const indentChars: number[] = [];
    const lineTexts: string[] = [];
    for (let ln = win.first; ln <= win.last; ln++) {
        const text = state.doc.line(ln).text;
        lineTexts.push(text);
        const info = getListIndent(text, unit);
        levels.push(info.isList ? info.level : -1);
        indentChars.push(info.chars);
    }

    // 圆点圆心离行左边缘多远：竖线要长在圆点正下方（需求 3），横向位置由它定
    const dotPx = measureBulletDotOffsetPx();

    for (let ln = win.first; ln <= win.last; ln++) {
        const line = state.doc.line(ln);
        const ownLevel = levels[ln - win.first];
        if (ownLevel < 0) continue;

        // 往后看「自己这一段子级最深到第几层」。子级段落 = 后面那些缩进更深的列表行，
        // 中途的空行不算断（松散列表也要连起来），碰到同级或更外层的列表行就结束。
        let deepest = ownLevel;
        for (let n = ln + 1; n <= lineCount; n++) {
            const next = levels[n - win.first];
            if (next < 0) {
                if (lineTexts[n - win.first].trim() === '') continue; // 空行：继续往后看
                break; // 普通正文行：这一段子级到此为止
            }
            if (next <= ownLevel) break;
            if (next > deepest) deepest = next;
        }
        // 自己那条竖线只在「下面还有更深的子级」时才画：它要从圆点中心往下垂，
        // 垂下去却什么都没连，那就是光杆条目
        const ownLine = deepest > ownLevel;
        // 光杆的根条目（没缩进、也没子级）什么都不用画
        if (ownLevel <= 0 && !ownLine) continue;

        // 层级引导线（行级）：祖先线铺满整行，自己的那条画下半行
        decos.push(
            Decoration.line({
                class: 'cm-md-indent',
                attributes: { style: createListIndentStyle(ownLevel, unitPx, ownLine, dotPx) },
            }).range(line.from)
        );

        // 行首空白压成定宽占位块。用 mark 而不是 replace：
        // 光标仍然能停在缩进里（方向键可以走过去改缩进），不会变成一块跳不过去的原子。
        const chars = indentChars[ln - win.first];
        if (chars > 0 && unitPx > 0) {
            decos.push(
                Decoration.mark({
                    class: 'cm-md-indent-space',
                    attributes: { style: `width:${(ownLevel * unitPx).toFixed(2)}px` },
                }).range(line.from, line.from + chars)
            );
        }
    }
}

// =============================================================================
// Exported Plugin & Extension Factory
// =============================================================================

/**
 * The exported ViewPlugin for live preview.
 */

import { ViewPlugin, type ViewUpdate } from '@codemirror/view';

/**
 * live preview 的装饰插件。
 *
 * ## 为什么是 ViewPlugin 而不是 StateField
 *
 * 装饰集按**当前视口 ± 余量**（见 renderRange）算，而不是整篇 —— 视口只有 CM6 的
 * `view.visibleRanges` 知道，StateField 拿不到。长文档上这个差别很大：1547 行的
 * 文档实测一次全量重建 7ms 以上，按窗口算只剩不到 1ms。
 *
 * 只算窗口的代价是：滚出窗口时要重算一次。所以窗口上下各留了 60 行余量，
 * 一屏之内随便滚都不会触发；窗口外的内容 CM6 用 widget 的 estimatedHeight 估高度，
 * 这也是各个 widget 都实现 estimatedHeight 的原因。
 */
export const livePreviewPlugin = ViewPlugin.fromClass(
    class {
        /** 当前这轮装饰。 */
        decorations: DecorationSet;
        /** 上面这轮装饰是按哪个窗口算的；视口跑出这个窗口才需要重算。 */
        private window: ILineRange;

        constructor(view: EditorView) {
            this.window = renderRange(view);
            this.decorations = buildWindowDecorations(view.state, this.window);
        }

        update(update: ViewUpdate): void {
            if (!needsRebuild(update)) return;
            const next = renderRange(update.view);
            // 视口还在上一轮的窗口里（只是滚了一点）：不用重建
            if (
                update.viewportChanged &&
                !update.docChanged &&
                !update.selectionSet &&
                next.from >= this.window.from &&
                next.to <= this.window.to
            ) {
                return;
            }
            this.window = next;
            this.decorations = buildWindowDecorations(update.view.state, next);
        }
    },
    { decorations: (value) => value.decorations }
);

/**
 * block 装饰集（StateField）。
 *
 * CodeMirror 不允许 ViewPlugin 产出 block 装饰，所以「会产出块级 replace / 块级 widget」
 * 的那几个收集器留在这里，整篇算；其余按窗口算的部分在下面的 ViewPlugin 里。
 * 实测这部分在 1547 行的文档上约 1ms（主遍历 0.5ms + 公式 0.2ms + 表格 0.7ms，
 * 表格那条已经被「按内容缓存列宽」压到很便宜）。
 */
/**
 * 视图挂上 DOM 之后补一次重建 —— 表格的列宽需要它。
 *
 * 表格列宽要按「正文有多宽」分配（见 tableRender 的 availableWidth），可 block 装饰
 * 是在 `EditorState.create` 阶段算出来的，那时视图还没有 DOM，可用宽度量到 0，
 * 表格只能按「谁都不许折行」的自然宽画 —— 于是撑出正文列，而且**只要没人动它就一直撑着**
 * （短文档不会有视口变化，谁也不会触发重建）。
 *
 * 所以挂载时探一次：量不到宽度就排一个任务，等能量到了补一次重建，让表格回到
 * 「按可见宽度分配」的那一版。只排这一次，不是轮询。
 *
 * 用 setTimeout 而不是 `view.requestMeasure`：无头 Chrome 在 `--dump-dom` 之前
 * 不保证出帧，rAF 回调可能一次都不跑（复现页里就没法验证了）。
 */

/**
 * 检查已渲染的 bullet 是不是在视图挂载前**用错字体**量的宽度。
 *
 * 首次装饰构建发生在 EditorState.create 阶段、视图还没进 DOM，
 * getMeasureContext 退回 body 的 UI 字体（比例字体），给 `- ` 量出
 * 一个偏窄的宽度；挂载后正文实际用编辑器字体（通常等宽），
 * 真实 `- ` 更宽。这个函数在挂载后运行，逐个对照：
 * bullet DOM 上写死的旧宽度 vs 现在按正文重新量出的目标宽度。
 *
 * @param view - 已挂载的编辑器视图
 * @returns 只要有一个 bullet 宽度偏差超过 0.5px 就返回 true
 */
function hasMismeasuredBullets(view: EditorView): boolean {
    const bullets = view.contentDOM.querySelectorAll<HTMLElement>('.cm-md-bullet');

    for (const bullet of bullets) {
        const currentWidth = Number.parseFloat(bullet.style.width);
        if (!Number.isFinite(currentWidth)) continue;

        // 反查这个 bullet 在源码里对应的标记符（`-` / `*` / `+`），
        // 三种字符在比例字体下宽度不一定相同，不能一律按 '-' 量
        let marker = '-';
        try {
            const pos = view.posAtDOM(bullet, 0);
            const line = view.state.doc.lineAt(pos);
            const ch = line.text[pos - line.from];
            if (ch === '-' || ch === '*' || ch === '+') marker = ch;
        } catch {
            /* 取不到就退回按 '-' 比对 */
        }

        // 此刻 getMeasureContext 因正文已进 DOM（fromContent 不匹配）
        // 作废了旧的 body 缓存，量到的是正确的正文宽度
        const targetWidth = measureText(marker, '400') + measureText(' ', '400');
        if (targetWidth > 0 && Math.abs(currentWidth - targetWidth) > 0.5) {
            return true;
        }
    }
    return false;
}

export const tableWidthBootstrap = ViewPlugin.fromClass(
    class {
        /**
         * @param view - 编辑器视图
         */
        constructor(view: EditorView) {
            // 只排一次任务，判据留到**那时候**再算 —— 三个坑都在这儿：
            // 1. 这个构造函数跑在「算窗口装饰」之前，此刻列宽缓存还是空的，
            //    在这里判会永远判成「不用补」；
            // 2. 判据是「刚算的那批表格是不是在量不到宽度的时候算的」，不是「现在量得到吗」
            //    —— 视图建好之后宽度早就有了；
            // 3. 视图要是已经销毁（或压根没挂上去），dispatch 会炸，也不该补。
            setTimeout(() => {
                if (!view.dom.isConnected) return;
                // 两类首屏补算共用这一个 effect：
                // ① 表格列宽（见 hasUnmeasuredTables）；
                // ② bullet 首次用 body 错字体量的窄宽度（见 hasMismeasuredBullets）
                if (!hasUnmeasuredTables() && !hasMismeasuredBullets(view)) return;
                view.dispatch({ effects: tableRemeasureEffect.of(null) });
            }, 0);
        }
    }
);

export const livePreviewBlockDecorations = StateField.define<DecorationSet>({
    create(state) {
        return buildBlockDecorations(state);
    },
    update(value, tr) {
        // 双击切换源码模式 / 行级强制态：效果里带来新的区间（null 表示退出），
        // 先落到共享状态里，下面的重算才会按新模式渲染。
        for (const effect of tr.effects) {
            if (effect.is(sourceModeEffect)) {
                setSourceModeRange(effect.value);
            } else if (effect.is(lineForceEffect)) {
                patchLineForce(effect.value);
            }
        }
        if (blockNeedsRebuild(tr)) return buildBlockDecorations(tr.state);
        return value;
    },
    provide: (f) => EditorView.decorations.from(f),
});

/**
 * block 装饰集的更新判据（StateField 版：拿不到 viewport，所以只能看事务）。
 *
 * @param tr - 当前事务
 * @returns 需要重算时返回 true
 */
function blockNeedsRebuild(tr: Transaction): boolean {
    const state = tr.state;
    const startState = tr.startState;
    const oldSel = startState.selection.main;
    const newSel = state.selection.main;
    void oldSel;
    void newSel;

    // 文档变化：先把行级强制区间映射到新坐标（StateField 一定会重建，
    // 但共享状态本身得保持准确）
    if (tr.docChanged) mapForceRanges(tr.changes);
    // 钉住行失去焦点：在这里清掉，下面 getSourceRange 才不会继续按钉住行算
    const exitedPinned = exitPinnedForceIfOutside(newSel.from, newSel.to);

    // 源码区间变了（拖选范围变了、光标换了块）就得重算
    const oldFocused = getSourceRange(startState);
    const newFocused = getSourceRange(state);
    const focusChanged = oldFocused.from !== newFocused.from || oldFocused.to !== newFocused.to;
    const focusSignatureChanged =
        computeFocusSignature(startState, syntaxTree(startState)) !==
        computeFocusSignature(state, syntaxTree(state));
    const editableChanged = startState.facet(EditorView.editable) !== state.facet(EditorView.editable);
    const hasFoldToggle = tr.effects.some((e) => e.is(foldToggleEffect));
    const hasSourceModeToggle = tr.effects.some((e) => e.is(sourceModeEffect));
    // mousedown 待选 / 双击钉住的切换：不改文档也不改选区，必须单独触发重建
    const hasLineForceToggle = tr.effects.some((e) => e.is(lineForceEffect));
    // 挂载后补算（表格/bullet）：折叠列表项的 bullet 由本 block 遍产出，
    // 同样可能在首屏用错字体量宽，需要跟着重建
    const hasTableRemeasure = tr.effects.some((e) => e.is(tableRemeasureEffect));
    const treeChanged = syntaxTree(startState) !== syntaxTree(state);
    if (tr.docChanged) return true;
    return (
        focusChanged ||
        focusSignatureChanged ||
        editableChanged ||
        hasFoldToggle ||
        treeChanged ||
        hasSourceModeToggle ||
        hasLineForceToggle ||
        hasTableRemeasure ||
        exitedPinned
    );
}

/**
 * 这次更新要不要重算装饰。
 *
 * 判据和以前（StateField 版）一致，额外多了一条 `viewportChanged`：
 * 装饰只覆盖窗口范围，滚出窗口必须重算。
 *
 * @param update - CodeMirror 的视图更新
 * @returns 需要重算时返回 true
 */
function needsRebuild(update: ViewUpdate): boolean {
    const tr = update.transactions.length > 0 ? update.transactions[update.transactions.length - 1] : null;
    // 双击切换源码模式 / 行级强制态：效果里带来新的区间（null 表示退出），
    // 先落到共享状态里，下面的 buildDecorations 才会按新模式渲染。
    for (const effect of update.transactions.flatMap((t) => t.effects)) {
        if (effect.is(sourceModeEffect)) {
            setSourceModeRange(effect.value);
        } else if (effect.is(lineForceEffect)) {
            patchLineForce(effect.value);
        }
    }

    // 文档变化：把行级强制区间映射到新坐标。必须放在 viewportChanged 提前返回
    // 之前，否则那一支不映射、共享状态会变陈旧
    for (const t of update.transactions) {
        if (t.docChanged) mapForceRanges(t.changes);
    }
    // 钉住行失去焦点：同样提前清掉，viewportChanged 那一支也得带着新状态重建
    const earlyNewSel = update.state.selection.main;
    const exitedPinned = exitPinnedForceIfOutside(earlyNewSel.from, earlyNewSel.to);

    if (update.viewportChanged) return true;

    const state = update.state;
    const startState = update.startState;
    const newSel = state.selection.main;
    // 光标/选区离开源码模式的块就退出。必须每次更新都查一遍：
    // 「光标移出表格」本身可能不会让聚焦范围变化（源码模式下聚焦范围是整张表），
    // 不查的话表格会卡在源码模式里出不来。
    const exitedSourceMode = exitSourceModeIfOutside(newSel.from, newSel.to);

    const oldFocused = getSourceRange(startState);
    const newFocused = getSourceRange(state);
    const focusChanged = oldFocused.from !== newFocused.from || oldFocused.to !== newFocused.to;
    // 同一块内移动光标也要重建：换了活动行内元素（点同一行的另一个加粗）、
    // 或者光标进出标题行（决定 `#` 露不露），外观都得跟着变。
    const focusSignatureChanged =
        computeFocusSignature(startState, syntaxTree(startState)) !==
        computeFocusSignature(state, syntaxTree(state));
    const editableChanged =
        startState.facet(EditorView.editable) !== state.facet(EditorView.editable);
    const hasFoldToggle = update.transactions.some((t) =>
        t.effects.some((e) => e.is(foldToggleEffect))
    );
    // 表格 / 图片 / Mermaid 双击进（出）源码模式：本身不改文档，但外观要重建
    const hasSourceModeToggle = update.transactions.some((t) =>
        t.effects.some((e) => e.is(sourceModeEffect))
    );
    // mousedown 待选 / 双击钉住的切换：不改文档也不改选区，必须单独触发重建
    const hasLineForceToggle = update.transactions.some((t) =>
        t.effects.some((e) => e.is(lineForceEffect))
    );
    // 视图挂上 DOM 之后的那次补算：表格列宽要按可见宽度重新分配（见 tableWidthBootstrap）。
    // 表格的装饰在**窗口**这一份里（不是 block 那一份），所以判据写在这里。
    const hasTableRemeasure = update.transactions.some((t) =>
        t.effects.some((e) => e.is(tableRemeasureEffect))
    );
    // Lezer 增量解析完成（大文件后台解析）也会换树
    const treeChanged = syntaxTree(startState) !== syntaxTree(state);
    // 选区两端变了也要重建：被框选的格子高亮是跟着选区加的（见 collectTableDecorations）。
    // 只关心「有范围的选区」—— 光标在空选区里挪来挪去不必重算。
    const selChanged =
        (!startState.selection.main.empty || !newSel.empty) &&
        (startState.selection.main.from !== newSel.from ||
            startState.selection.main.to !== newSel.to);
    void tr;

    return (
        update.docChanged ||
        selChanged ||
        focusChanged ||
        focusSignatureChanged ||
        editableChanged ||
        hasFoldToggle ||
        treeChanged ||
        hasSourceModeToggle ||
        hasLineForceToggle ||
        hasTableRemeasure ||
        exitedSourceMode ||
        exitedPinned
    );
}

/**
 * ViewPlugin that highlights table widgets when CM6 selection extends over them
 * from outside (e.g. drag-selecting from a paragraph through a table).
 * Works by toggling a CSS class directly on the widget DOM.
 */
/**
 * Creates the live preview extension bundle.
 *
 * Returns all extensions needed for Obsidian-style live preview,
 * including the ViewPlugin, syntax highlighting, link handler, and base theme styles.
 */
export function createLivePreviewExtension(): Extension[] {
    return [
        scrollPreserverExtension,
        // block 装饰必须由 StateField 提供（CodeMirror 的硬限制）
        livePreviewBlockDecorations,
        // 挂载后补一次表格重建（首次构建时视图还没进 DOM，量不到可用宽度）
        tableWidthBootstrap,
        // 滚动容器宽度变化时主动重建：定宽列自己不会感知 scroller 变窄
        tableResizePlugin,
        livePreviewPlugin,
        // mousedown 记录起点、移动超阈值整行展开、双击钉住（见 lineForce.ts）
        lineForcePlugin,
        // 单击锚点用浏览器原生 hit-test（从公式后起拖不错位）
        nativeAnchoredMouseSelection(),
        // 在格子上拖鼠标 = 整格框选（选区两端吸到格子边界）
        tableCellSelection(),
        // 单元格里输入 `|` 自动转义，免得把表格切碎
        tablePipeEscaper(),
        // 输入左括号自动补全右半（[ { ( 【 《 <）
        autoPairBrackets(),
        // 双击表格 → 整张表切源码模式（改结构时看源码更直接）
        tableSourceModeHandler(),
        syntaxHighlighting(flowMdDarkHighlight),
        syntaxHighlighting(flowMdLightHighlight),
        // Click handler for links
        EditorView.domEventHandlers({
            mousedown(event: MouseEvent, view: EditorView) {
                const target = event.target;
                const targetElement =
                    target instanceof HTMLElement
                        ? target
                        : target instanceof Node
                          ? target.parentElement
                          : null;
                if (!targetElement) return false;

                // 水平分割线 `---` 在渲染态被替换成一条 `.cm-md-hr`。
                // 不拦截的话，CodeMirror 默认把光标落在被替换区间的**行首**
                // （无头实测：点线的正中央 head=line.from），而用户要的是
                // 「渲染态转回文本态时，光标聚焦到文本末尾」——所以在这里
                // 主动把光标送到这一行的行尾。
                const hrEl = targetElement.closest('.cm-md-hr');
                if (
                    hrEl &&
                    // 只接管左键的普通点击：右键要留给原生上下文菜单，
                    // Shift/Ctrl/Meta 点击要留给原生的选区扩展/多光标行为
                    event.button === 0 &&
                    !event.shiftKey &&
                    !event.ctrlKey &&
                    !event.metaKey
                ) {
                    // 优先按点击坐标取文档位置；取不到时退回 widget DOM 对应位置。
                    // 两种取法都只用来定位「这是哪一行」，真正的落点统一给行尾。
                    let pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
                    if (pos === null) pos = view.posAtDOM(hrEl, 0);
                    const lineEnd = view.state.doc.lineAt(pos).to;
                    event.preventDefault();
                    event.stopPropagation();
                    // 编辑器可能还没拿到焦点（preventDefault 会挡掉默认的焦点转移），
                    // 先主动聚焦，再把光标放到行尾
                    view.focus();
                    view.dispatch({ selection: { anchor: lineEnd } });
                    return true;
                }

                const linkEl = targetElement.closest('.cm-md-link');
                if (!linkEl) return false;
                const href = linkEl.getAttribute('data-href');
                if (!href) return false;

                // Anchor links (#heading) — plain click to jump within document
                if (href.startsWith('#')) {
                    event.preventDefault();
                    event.stopPropagation();
                    const slug = href.slice(1);
                    const tree = syntaxTree(view.state);
                    let targetPos = -1;
                    tree.iterate({
                        enter(node) {
                            if (targetPos >= 0) return false;
                            const n = node.name;
                            if (n.startsWith('ATXHeading') || n.startsWith('SetextHeading')) {
                                const headingText = view.state.doc
                                    .sliceString(node.from, node.to)
                                    .replace(/^#{1,6}\s+/, '') // strip ATX markers
                                    .replace(/\n[=\-]+$/, ''); // strip Setext underlines
                                const headingSlug = headingText
                                    .trim()
                                    .toLowerCase()
                                    .replace(/[^\w\s\u3000-\u9fff\uf900-\ufaff-]/g, '')
                                    .replace(/\s+/g, '-');
                                if (headingSlug === slug) {
                                    targetPos = node.from;
                                    return false;
                                }
                            }
                            return true;
                        },
                    });
                    if (targetPos >= 0) {
                        view.dispatch({
                            selection: { anchor: targetPos },
                            effects: EditorView.scrollIntoView(targetPos, {
                                y: 'start',
                                yMargin: 20,
                            }),
                        });
                    }
                    return true;
                }

                // Relative file link — plain click to open in VS Code
                if (!href.startsWith('http://') && !href.startsWith('https://')) {
                    event.preventDefault();
                    event.stopPropagation();
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const vscodeApi = (window as any).__vscodeApi;
                    if (vscodeApi) {
                        vscodeApi.postMessage({ type: 'openFile', path: href });
                    }
                    return true;
                }

                // External URL — Ctrl+click to open in VS Code
                if (!(event.ctrlKey || event.metaKey)) return false;
                event.preventDefault();
                event.stopPropagation();
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const vscodeApi = (window as any).__vscodeApi;
                if (vscodeApi) {
                    vscodeApi.postMessage({ type: 'openUrl', url: href });
                }
                return true;
            },
            /**
             * 处理普通文本中的文件路径 Ctrl/Cmd+点击跳转。
             *
             * 该分支只在未命中现有 Markdown 链接时执行，避免改变既有链接行为。
             *
             * @param event - 浏览器鼠标事件
             * @param view - 当前 CodeMirror 视图
             * @returns 命中文件路径并已拦截默认行为时返回 true
             */
            click(event: MouseEvent, view: EditorView) {
                const target = event.target;
                const targetElement =
                    target instanceof HTMLElement
                        ? target
                        : target instanceof Node
                          ? target.parentElement
                          : null;
                if (!targetElement) {
                    return false;
                }

                if (targetElement.closest('.cm-md-link')) {
                    return false;
                }

                if (!(event.ctrlKey || event.metaKey)) {
                    return false;
                }

                const clickPos = view.posAtCoords({
                    x: event.clientX,
                    y: event.clientY,
                });
                if (clickPos === null) {
                    return false;
                }

                const line = view.state.doc.lineAt(clickPos);
                const fileLinkMatch = findFileLinkAtText(line.text, clickPos - line.from);
                if (!fileLinkMatch) {
                    return false;
                }

                event.preventDefault();
                event.stopPropagation();

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const vscodeApi = (window as any).__vscodeApi;
                if (vscodeApi) {
                    vscodeApi.postMessage({
                        type: 'openFile',
                        path: fileLinkMatch.rawText,
                    });
                }

                return true;
            },
        }),
        createBaseThemeStyles(),
    ];
}
