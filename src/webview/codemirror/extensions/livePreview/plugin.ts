/**
 * Live Preview Plugin
 *
 * Core ViewPlugin for Obsidian-style live preview.
 * Manages decorations: hides Markdown markers in non-focused blocks
 * and renders widgets (tables, math, mermaid, etc.).
 *
 * @module webview/codemirror/extensions/livePreview/plugin
 */

import { ensureSyntaxTree, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, RangeSet } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';
import type { Tree } from '@lezer/common';
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
    italicMarkDeco,
    strikethroughMarkDeco,
} from './decorations.js';
import {
    extractFencedCodeContent,
    extractFencedCodeLanguage,
    extractSafeFontStyles,
    createCodeBlockIndentStyle,
    getCodeBlockIndentLevel,
    parseFrontmatter,
    parseTableNode,
    splitMarkdownImageDestination,
} from './helpers.js';
import {
    DEFAULT_MEDIA_WIDTH_PERCENT,
    formatMediaWidthAttribute,
    measureTrailingWidthAttribute,
    parseMediaWidthPercent,
    splitTrailingWidthAttribute,
} from './mediaWidth.js';
import { getMarkdownBlockRange } from './ranges.js';
import { scrollPreserverExtension } from './scrollHack.js';
import {
    foldToggleEffect,
    foldedListItems,
    isTableDragging,
    tableCellSelections,
    tableCellSelectEffect,
    tableDataCache,
} from './state.js';
import { createBaseThemeStyles } from './styles.js';
import type { ILineRange } from './types.js';
import {
    BlockMathWidget,
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
    InlineMathWidget,
    FontTextWidget,
    MermaidWidget,
    TableWidget,
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
    focusedRange: ILineRange
): void {
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

    // Second pass: build decorations
    const refRegex = /\[\^([^\]]+)\]/g;
    const defFullRegex = /^\[\^([^\]]+)\]:\s?/;
    for (let ln = 1; ln <= state.doc.lines; ln++) {
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
    focusedRange: ILineRange
): void {
    for (let ln = 1; ln <= state.doc.lines; ln++) {
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
 * 收集数学公式对应的 KaTeX 装饰。
 *
 * @param state - 当前编辑器状态
 * @param decos - 待写入的装饰数组
 * @param focusedRange - 当前正在编辑的聚焦区间
 * @param tree - 当前语法树
 * @returns void
 */
function collectMathDecorations(
    state: EditorState,
    decos: Array<ReturnType<Decoration['range']>>,
    focusedRange: ILineRange,
    tree: Tree
): void {
    const isInsideCode = (pos: number): boolean => {
        const node = tree.resolveInner(pos, 1);
        const n = node.type.name;
        return (
            n === 'InlineCode' ||
            n === 'CodeMark' ||
            n === 'FencedCode' ||
            n === 'CodeText' ||
            n === 'CodeBlock' ||
            n === 'CodeInfo'
        );
    };

    // 预编译行内公式正则，允许分隔符内外出现常见空格。
    const inlineRegex = /(?<!\$)\$(?!\$)\s*(.+?)\s*\$(?!\$|\d)/g;

    for (let ln = 1; ln <= state.doc.lines; ln++) {
        const line = state.doc.line(ln);

        if (line.from < focusedRange.to && line.to > focusedRange.from) {
            continue;
        }

        const lineText = line.text;
        const trimmedLine = lineText.trim();

        // 没有美元符号的行不可能包含数学公式，直接跳过。
        if (!lineText.includes('$')) continue;

        // 代码块内不做数学公式渲染，避免误伤源码。
        if (isInsideCode(line.from)) continue;

        // 同行块级公式：只有整行都由 $$ 包围时，才保留块级渲染。
        const sameLineMatch = lineText.match(/^\s*\$\$\s*(.+?)\s*\$\$\s*$/);
        if (sameLineMatch) {
            const tex = sameLineMatch[1].trim();
            if (tex) {
                decos.push(
                    Decoration.replace({
                        widget: new BlockMathWidget(tex),
                    }).range(line.from, line.to)
                );
            }
            continue;
        }

        // 多行块级公式：只有整行是 $$ 时才继续向下寻找闭合行。
        if (trimmedLine === '$$') {
            let closingLn = ln + 1;
            let found = false;
            while (closingLn <= state.doc.lines) {
                if (/^\s*\$\$\s*$/.test(state.doc.line(closingLn).text)) {
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

            const texContent = state.doc
                .sliceString(state.doc.line(ln + 1).from, state.doc.line(closingLn).from)
                .trim();
            if (texContent) {
                decos.push(
                    Decoration.replace({
                        widget: new BlockMathWidget(texContent),
                        block: true,
                    }).range(line.from, closingLine.to)
                );
            }
            ln = closingLn;
            continue;
        }

        // 同行 display 公式：允许出现在普通文本或列表项中。
        const embeddedBlockRegex = /(?<!\$)\$\$\s*(.+?)\s*\$\$(?!\$)/g;
        embeddedBlockRegex.lastIndex = 0;
        let embeddedBlockMatch: RegExpExecArray | null;
        while ((embeddedBlockMatch = embeddedBlockRegex.exec(lineText)) !== null) {
            const tex = embeddedBlockMatch[1];
            if (!tex.trim()) continue;
            const mathFrom = line.from + embeddedBlockMatch.index;
            const mathTo = mathFrom + embeddedBlockMatch[0].length;
            if (mathFrom < focusedRange.to && mathTo > focusedRange.from) continue;
            if (isInsideCode(mathFrom)) continue;
            decos.push(
                Decoration.replace({
                    widget: new InlineMathWidget(tex),
                }).range(mathFrom, mathTo)
            );
        }

        // 行内公式：允许 $ 与内容之间留空格，但仍排除 $$。
        inlineRegex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = inlineRegex.exec(lineText)) !== null) {
            const tex = match[1];
            if (!tex.trim()) continue;
            const mathFrom = line.from + match.index;
            const mathTo = mathFrom + match[0].length;
            if (mathFrom < focusedRange.to && mathTo > focusedRange.from) continue;
            // 行内代码片段中的美元符号不参与公式渲染。
            if (isInsideCode(mathFrom)) continue;
            decos.push(
                Decoration.replace({
                    widget: new InlineMathWidget(tex),
                }).range(mathFrom, mathTo)
            );
        }
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
    focusedRange: ILineRange
): void {
    const fileLinkDeco = Decoration.mark({ class: 'cm-md-file-link' });

    for (let ln = 1; ln <= state.doc.lines; ln++) {
        const line = state.doc.line(ln);
        if (line.from < focusedRange.to && line.to > focusedRange.from) {
            continue;
        }

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
    focusedRange: ILineRange,
    tree: Tree
): void {
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

    for (let ln = 1; ln <= state.doc.lines; ln++) {
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
    focusedRange: ILineRange,
    tree: Tree,
    taskMarkerPositions: Set<number>
): void {
    const cbRegex = /\[([ xX])\]/g;
    for (let ln = 1; ln <= state.doc.lines; ln++) {
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

            // Skip if followed by ( — likely a link like [x](url)
            const charAfter = state.doc.sliceString(cbTo, cbTo + 1);
            if (charAfter === '(') continue;

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
            decos.push(
                Decoration.replace({
                    widget: new CheckboxWidget(checked, cbFrom),
                }).range(cbFrom, cbTo)
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
    focusedRange: ILineRange,
    tree: Tree
): void {
    const wikiImageRegex = /!\[\[([^\]\n]+?)\]\]/g;
    const markdownImageRegex = /!\[([^\]]*?)\]\(([^)\n]+)\)/g;

    treeLikeIterateTextBlocks(state, focusedRange, tree, (from, to, text) => {
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
            const wikiRawText = state.doc.sliceString(wikiFrom, wikiTo);
            const wikiWidth =
                parseMediaWidthPercent(wikiRawText) ?? DEFAULT_MEDIA_WIDTH_PERCENT;

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
            const spacedTo =
                spacedFrom +
                match[0].length +
                measureTrailingWidthAttribute(text.slice(match.index + match[0].length));
            const spacedRawText = state.doc.sliceString(spacedFrom, spacedTo);
            const spacedWidth =
                parseMediaWidthPercent(spacedRawText) ?? DEFAULT_MEDIA_WIDTH_PERCENT;

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
 * The Live Preview ViewPlugin.
 *
 * Manages decorations for Obsidian-style live preview.
 * Hides Markdown markers and applies styling in non-focused blocks.
 * Shows raw Markdown source in the focused block.
 */
// Remember last focused range so range selection (drag/keyboard) keeps it stable
let lastFocusedRange: ILineRange = { from: -1, to: -1 };

function buildDecorations(state: EditorState): DecorationSet {
    const decos: Array<ReturnType<Decoration['range']>> = [];
    // Clear table data cache (will be repopulated below)
    tableDataCache.clear();
    const isEditable = state.facet(EditorView.editable);
    let focusedRange: ILineRange;
    if (isEditable && state.selection.main.empty) {
        focusedRange = getMarkdownBlockRange(state);
        lastFocusedRange = focusedRange;
    } else if (isEditable) {
        // During range selection, keep the previously focused block
        focusedRange = lastFocusedRange;
    } else {
        focusedRange = { from: -1, to: -1 };
    }
    // Try to get a fully parsed tree within a short budget.
    // If parsing isn't done yet, fall back to the current incremental tree;
    // treeChanged detection in update() will trigger a rebuild with the complete tree.
    const tree = ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
    const taskMarkerPositions = new Set<number>();

    // === FRONTMATTER DETECTION ===
    // Check if document starts with --- (YAML frontmatter)
    let frontmatterEndLine = -1;
    if (state.doc.lines >= 2) {
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

    tree.iterate({
        from: 0,
        to: state.doc.length,
        enter: (nodeRef): boolean | void => {
            const { from, to, name } = nodeRef;

            // Document node spans everything - always process children
            if (name === 'Document') return;

            // Skip nodes that overlap with the focused range (show raw source)
            if (from < focusedRange.to && to > focusedRange.from) {
                return;
            }

            // Skip empty ranges
            if (from >= to) return;

            switch (name) {
                // === HIDE MARKERS ===

                case 'HeaderMark': {
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
                                widget: new BulletWidget(),
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
                    const lineText = itemLine.text;

                    // Add indent guide lines based on indentation level
                    const leadingSpaces = lineText.match(/^(\s*)/);
                    const indentChars = leadingSpaces ? leadingSpaces[1].length : 0;
                    const indentLevel =
                        indentChars >= 4
                            ? Math.floor(indentChars / 4)
                            : Math.floor(indentChars / 2);
                    if (indentLevel > 0) {
                        const cappedLevel = Math.min(indentLevel, 6);
                        decos.push(
                            Decoration.line({
                                class: `cm-md-indent cm-md-indent-${cappedLevel}`,
                            }).range(itemLine.from)
                        );
                    }

                    // Check if this list item has child list (sub-items)
                    const syntaxNode = nodeRef.node;
                    const hasChildList =
                        syntaxNode.getChild('BulletList') || syntaxNode.getChild('OrderedList');
                    if (hasChildList) {
                        const isFolded = foldedListItems.has(itemLine.from);
                        decos.push(
                            Decoration.widget({
                                widget: new FoldArrowWidget(itemLine.from, isFolded),
                                side: -1,
                            }).range(itemLine.from)
                        );
                        if (isFolded) {
                            decos.push(
                                Decoration.line({ class: 'cm-md-fold-collapsed-line' }).range(
                                    itemLine.from
                                )
                            );
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
                                        Decoration.replace({ widget: new BulletWidget() }).range(
                                            listMark.from,
                                            hideEnd
                                        )
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
                            // Hide child lines
                            const endLine = state.doc.lineAt(to);
                            if (itemLine.to < endLine.to) {
                                decos.push(
                                    Decoration.replace({ block: true }).range(
                                        itemLine.to,
                                        endLine.to
                                    )
                                );
                            }
                            return false; // Skip children
                        }
                    }
                    break;
                }

                case 'Table': {
                    const syntaxNode = nodeRef.node;
                    const tableData = parseTableNode(syntaxNode, state);
                    if (tableData) {
                        // Cache table data for copy handler (avoids tree re-traversal)
                        tableDataCache.set(tableData.positions.tableFrom, tableData);
                        const firstLine = state.doc.lineAt(from);
                        const endLine = state.doc.lineAt(to);
                        const cellSel =
                            tableCellSelections.get(tableData.positions.tableFrom) ?? null;
                        decos.push(
                            Decoration.replace({
                                widget: new TableWidget(tableData, cellSel),
                                block: true,
                            }).range(firstLine.from, endLine.to)
                        );
                    }
                    return false;
                }

                case 'FencedCode': {
                    const syntaxNode = nodeRef.node;
                    const language = extractFencedCodeLanguage(syntaxNode, state);
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
                                const indentLevel = getCodeBlockIndentLevel(line.text);
                                classes.push('cm-md-codeblock-indent');
                                attributes.style = createCodeBlockIndentStyle(indentLevel);
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
                    const syntaxNode = nodeRef.node;
                    const marks = syntaxNode.getChildren('LinkMark');
                    const urlNode = syntaxNode.getChild('URL');
                    const linkUrl = urlNode ? state.doc.sliceString(urlNode.from, urlNode.to) : '';

                    if (marks.length >= 2) {
                        const openMark = marks[0];
                        const closeMark = marks[1];

                        decos.push(hideDeco.range(openMark.from, openMark.to));

                        if (openMark.to < closeMark.from) {
                            const attrs: Record<string, string> = {};
                            if (linkUrl) {
                                attrs['data-href'] = linkUrl;
                                attrs['title'] = `${linkUrl} (Ctrl+Click to open)`;
                            }
                            decos.push(
                                Decoration.mark({
                                    class: 'cm-md-link',
                                    attributes: attrs,
                                }).range(openMark.to, closeMark.from)
                            );
                        }

                        if (closeMark.from < to) {
                            decos.push(hideDeco.range(closeMark.from, to));
                        }
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

    // === POST-PROCESSING ===
    collectFootnoteDecorations(state, decos, focusedRange);
    collectDetailsDecorations(state, decos, focusedRange);
    collectMathDecorations(state, decos, focusedRange, tree);
    collectHeadingFontDecorations(state, decos, focusedRange, tree);
    collectCheckboxDecorations(state, decos, focusedRange, tree, taskMarkerPositions);
    collectImageDecorations(state, decos, focusedRange, tree);
    collectFileLinkDecorations(state, decos, focusedRange);

    // Remember focused range for next update comparison
    return RangeSet.of(decos, true);
}

// =============================================================================
// Exported Plugin & Extension Factory
// =============================================================================

/**
 * The exported ViewPlugin for live preview.
 */

import { StateField } from '@codemirror/state';

export const livePreviewPlugin = StateField.define<DecorationSet>({
    create(state) {
        return buildDecorations(state);
    },
    update(value, tr) {
        const isEditable = tr.state.facet(EditorView.editable);
        const oldSel = tr.startState.selection.main;
        const newSel = tr.state.selection.main;
        const oldFocused =
            isEditable && oldSel.empty
                ? getMarkdownBlockRange(tr.startState)
                : { from: -1, to: -1 };
        const newFocused =
            isEditable && newSel.empty ? getMarkdownBlockRange(tr.state) : { from: -1, to: -1 };

        const focusChanged = oldFocused.from !== newFocused.from || oldFocused.to !== newFocused.to;
        const editableChanged =
            tr.startState.facet(EditorView.editable) !== tr.state.facet(EditorView.editable);
        const hasFoldToggle = tr.effects.some((e) => e.is(foldToggleEffect));
        const hasTableCellSelect = tr.effects.some((e) => e.is(tableCellSelectEffect));
        // Detect Lezer incremental parsing completion (large files parsed in background)
        const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);

        if (
            tr.docChanged ||
            focusChanged ||
            editableChanged ||
            hasFoldToggle ||
            treeChanged ||
            hasTableCellSelect
        ) {
            return buildDecorations(tr.state);
        }
        return value;
    },
    provide: (f) => EditorView.decorations.from(f),
});

/**
 * ViewPlugin that highlights table widgets when CM6 selection extends over them
 * from outside (e.g. drag-selecting from a paragraph through a table).
 * Works by toggling a CSS class directly on the widget DOM.
 */
const tableExtentSelectionPlugin = EditorView.updateListener.of((update) => {
    if (!update.selectionSet && !update.docChanged && !update.viewportChanged) return;
    const { from, to } = update.view.state.selection.main;
    const hasSelection = from !== to;

    // Don't clear cell selection when this update was caused by tableCellSelectEffect
    const isTableSelectEffect = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(tableCellSelectEffect))
    );

    const wrappers = update.view.contentDOM.querySelectorAll('[data-table-from]');
    let needsDispatch = false;

    wrappers.forEach((el) => {
        const tableFrom = parseInt((el as HTMLElement).dataset.tableFrom ?? '0');
        const tableTo = parseInt((el as HTMLElement).dataset.tableTo ?? '0');
        const hasCellSel = tableCellSelections.has(tableFrom);

        // Show extent-selected only when no active cell selection and CM6 range covers table
        const covered = !hasCellSel && hasSelection && from < tableTo && to > tableFrom;
        el.classList.toggle('cm-md-table-extent-selected', covered);

        // Clear stale cell selection when CM6 selection moves away from this table
        // (but not while the user is drag-selecting inside a table)
        if (!isTableSelectEffect && !isTableDragging && update.selectionSet && hasCellSel) {
            const selCoversTable = hasSelection && from < tableTo && to > tableFrom;
            if (!selCoversTable) {
                tableCellSelections.delete(tableFrom);
                needsDispatch = true;
                console.debug(`[FlowMD] table cell select cleared: tableFrom=${tableFrom}`);
            }
        }
    });

    if (needsDispatch) {
        update.view.dispatch({ effects: tableCellSelectEffect.of(null) });
    }
});

/**
 * Creates the live preview extension bundle.
 *
 * Returns all extensions needed for Obsidian-style live preview,
 * including the ViewPlugin, syntax highlighting, link handler, and base theme styles.
 */
export function createLivePreviewExtension(): Extension[] {
    return [
        scrollPreserverExtension,
        livePreviewPlugin,
        tableExtentSelectionPlugin,
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
