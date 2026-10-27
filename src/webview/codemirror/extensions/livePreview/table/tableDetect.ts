/**
 * 表格（从 tableRender.ts 拆出）：文本形状兜底识别（语法树认不出的表格）：splitRowText / looksLikeTable / findTextTables。
 *
 * @module webview/codemirror/extensions/livePreview/tableDetect
 */

import { readRow } from './tableRead.js';
import { TableBlock, TableLine } from './tableTypes.js';
import { parseAlignments } from '../measure/sourceParse.js';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';

// =============================================================================
// 兜底：语法树没认成表格、但文本形状确实是表格的块
// =============================================================================
//
// 典型场景是「表格后面紧跟一条 `---`」：因为「一段文字 + 下一行 `---`」在 Markdown
// 里就是 Setext 二级标题的下划线，@lezer/markdown 会优先按 Setext 标题解析（块级
// 解析器的先后顺序决定的），于是整块表格变成一个标题——
// 树上连 `Table` 节点都没有，谁也渲染不出表格，那条 `---` 还会被当成下划线压成 0 高
// （连行号都不显示）。
//
// 但 GFM 的表格规则写的是「表格遇到下一个块级结构就结束」：这里应该解析成
// 「表格 + 一条分隔线」，GitHub、VS Code 自带预览都是这么显示的。
// 所以这里按文本再兜一层：形状对得上就当表格画，并把 Setext 标题那套行级装饰让开。

/**
 * 一行用管道线切出来的格子区间（`\|` 转义的不算分隔符），偏移相对行首。
 *
 * 表格渲染（按语法树）和增删行列（改文本，见 tableCommands.ts）都要切格子，
 * 这里导出给后者用，省得两处各写一套切法、空格子对不上号。
 *
 * @param lineText - 整行原文（不含换行符）
 * @returns 各格子的区间（已去掉两侧空白，可能为零长）
 */
export function splitRowText(lineText: string): Array<{ from: number; to: number }> {
    const pipes: number[] = [];
    for (let i = 0; i < lineText.length; i++) {
        if (lineText[i] === '\\') {
            i++;
            continue;
        }
        if (lineText[i] === '|') pipes.push(i);
    }
    if (pipes.length === 0) return [];

    const segments: Array<{ from: number; to: number }> = [];
    let cursor = 0;
    for (const pipe of pipes) {
        segments.push({ from: cursor, to: pipe });
        cursor = pipe + 1;
    }
    segments.push({ from: cursor, to: lineText.length });

    const isBlank = (seg: { from: number; to: number }): boolean =>
        lineText.slice(seg.from, seg.to).trim() === '';
    if (segments.length > 1 && isBlank(segments[0])) segments.shift();
    if (segments.length > 1 && isBlank(segments[segments.length - 1])) segments.pop();

    return segments.map((seg) => {
        const text = lineText.slice(seg.from, seg.to);
        const leading = text.length - text.trimStart().length;
        const trailing = text.length - text.trimEnd().length;
        const from = seg.from + leading;
        const to = Math.max(from, seg.to - trailing);
        // 同 readRow：空格子位置钉在最后一个空白字符上（借位锚点）
        if (from === to && from === seg.to && seg.to > seg.from) {
            return { from: seg.to - 1, to: seg.to - 1 };
        }
        return { from, to };
    });
}

/** 分隔行的一格是不是 `---` / `:--:` / `--:` 这种。 */
function isDelimiterCell(text: string): boolean {
    return /^:?-+:?$/.test(text.trim());
}

/**
 * 前两行长不长得像「表头 + 分隔行」。
 *
 * @param headerText - 第一行原文
 * @param delimiterText - 第二行原文
 * @returns 像表格时返回 true
 */
function looksLikeTable(headerText: string, delimiterText: string): boolean {
    const header = splitRowText(headerText);
    const delimiter = splitRowText(delimiterText);
    if (header.length < 2 || delimiter.length !== header.length) return false;
    return delimiter.every((seg) => isDelimiterCell(delimiterText.slice(seg.from, seg.to)));
}

/**
 * 判断某个块是不是「被解析成标题 / 段落、其实是表格」的那种。
 *
 * 给 Setext 标题相关的装饰用：命中的话要放行给表格渲染，不能按标题处理
 * （否则整块被涂成标题样式，末尾那条 `---` 还会被当成下划线藏起来）。
 *
 * @param state - 编辑器状态
 * @param from - 块起点
 * @param to - 块终点
 * @returns 是表格形状时返回 true
 */
export function isTableLikeBlock(state: EditorState, from: number, to: number): boolean {
    const first = state.doc.lineAt(from);
    if (first.number >= state.doc.lines) return false;
    const second = state.doc.line(first.number + 1);
    if (second.to > to) return false;
    return looksLikeTable(first.text, second.text);
}

/**
 * 找出所有「语法树没认成表格、但文本形状是表格」的块。
 *
 * 只看段落和 Setext 标题（真表格已经有 Table 节点了，不用兜）；而且只从**块的第一行**
 * 开始看，免得在一段普通文字中间误判出一张表。
 *
 * @param state - 编辑器状态
 * @param tree - 语法树
 * @returns 表格骨架列表
 */
export function findTextTables(
    state: EditorState,
    tree: Tree,
    range: { from: number; to: number }
): TableBlock[] {
    const blocks: TableBlock[] = [];
    tree.iterate({
        from: range.from,
        to: range.to,
        enter: (nodeRef) => {
            const name = nodeRef.name;
            if (name !== 'Paragraph' && name !== 'SetextHeading1' && name !== 'SetextHeading2') {
                return;
            }
            const block = readTextTable(state, nodeRef.node);
            if (block) blocks.push(block);
            return false;
        },
    });
    return blocks;
}

/**
 * 把一个「其实是表格」的块读成表格骨架。
 *
 * @param state - 编辑器状态
 * @param node - Paragraph / SetextHeading 节点
 * @returns 表格骨架；形状对不上时返回 null
 */
function readTextTable(state: EditorState, node: SyntaxNode): TableBlock | null {
    const doc = state.doc;
    const first = doc.lineAt(node.from);
    if (first.number >= doc.lines) return null;
    const second = doc.line(first.number + 1);
    if (second.to > node.to) return null;
    if (!looksLikeTable(first.text, second.text)) return null;

    const toLine = (lineText: string, lineFrom: number): TableLine => ({
        lineFrom,
        lineTo: lineFrom + lineText.length,
        cells: splitRowText(lineText).map((seg) => ({
            from: lineFrom + seg.from,
            to: lineFrom + seg.to,
        })),
    });

    const rows: TableBlock['rows'] = [{ line: toLine(first.text, first.from), isHeader: true }];
    let lastLine = second;
    // 分隔行之后，只要还是以管道线开头的行就算数据行；碰到别的（比如那条 `---`）就收工
    for (let ln = second.number + 1; ln <= doc.lines; ln++) {
        const line = doc.line(ln);
        if (line.to > node.to) break;
        const text = line.text.trim();
        if (!text.startsWith('|') || !text.includes('|')) break;
        rows.push({ line: toLine(line.text, line.from), isHeader: false });
        lastLine = line;
    }

    let colCount = 0;
    for (const row of rows) colCount = Math.max(colCount, row.line.cells.length);
    if (colCount === 0) return null;

    // 紧跟表格的那条 `---` / `===`：它是把这块拖成「Setext 标题」的元凶，
    // 按 GFM 它其实是表格后面的分隔线，这里记下来单独按水平线画
    let underline: { from: number; to: number } | undefined;
    const underlineLine = doc.line(lastLine.number < doc.lines ? lastLine.number + 1 : lastLine.number);
    if (
        underlineLine.number > lastLine.number &&
        underlineLine.to <= node.to &&
        /^\s*(=+|-+)\s*$/.test(underlineLine.text)
    ) {
        underline = { from: underlineLine.from, to: underlineLine.to };
    }

    return {
        from: first.from,
        to: lastLine.to,
        rows,
        delimiter: toLine(second.text, second.from),
        alignments: parseAlignments(second.text),
        colCount,
        ...(underline ? { underline } : {}),
    };
}
