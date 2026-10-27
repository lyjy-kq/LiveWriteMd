/**
 * 表格（从 tableRender.ts 拆出）：语法树读表格骨架：readTable / readRow / findTables。
 *
 * @module webview/codemirror/extensions/livePreview/tableRead
 */

import { TableBlock, TableLine } from './tableTypes.js';
import { parseAlignments } from '../measure/sourceParse.js';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';

// =============================================================================
// 从语法树里读表格骨架
// =============================================================================

/**
 * 读一个 `Table` 节点，整理成渲染要用的骨架。
 *
 * 节点结构（@lezer/markdown 的 GFM 表格扩展）：
 * `Table` → `TableHeader`（表头行，里面是 TableCell / TableDelimiter）、
 * `TableDelimiter`（**整行**分隔线，父节点才是 Table，别和行内的管道线混了）、
 * `TableRow`（数据行）。`TableCell` 的区间已经去掉了两侧空白，可以直接当格子用。
 *
 * @param state - 编辑器状态
 * @param node - Table 语法节点
 * @returns 表格骨架；结构不完整（比如只有一行）时返回 null
 */
function readTable(state: EditorState, node: SyntaxNode): TableBlock | null {
    const rows: TableBlock['rows'] = [];
    let delimiter: TableLine | null = null;
    let alignments: Array<string | null> = [];

    let child = node.firstChild;
    while (child) {
        if (child.name === 'TableHeader' || child.name === 'TableRow') {
            rows.push({
                line: readRow(state, child),
                isHeader: child.name === 'TableHeader',
            });
        } else if (child.name === 'TableDelimiter') {
            const line = state.doc.lineAt(child.from);
            delimiter = { lineFrom: line.from, lineTo: line.to, cells: [] };
            alignments = parseAlignments(state.doc.sliceString(child.from, child.to));
        }
        child = child.nextSibling;
    }

    if (rows.length === 0) return null;
    let colCount = 0;
    for (const row of rows) colCount = Math.max(colCount, row.line.cells.length);
    if (colCount === 0) return null;

    return { from: node.from, to: node.to, rows, delimiter, alignments, colCount };
}

/**
 * 读一行里的格子。
 *
 * **不能只看 `TableCell` 节点**：lezer 会把空的格子整段跳过（`|  |  |  |` 这种行
 * 一个 `TableCell` 都没有），照着读的话空行、空列会整块消失。
 * 所以按**管道线**切：相邻两条管道线之间就是一个格子，里面有没有字都算一格，
 * 空的记成零长区间（渲染时用一个空盒子占位）。
 *
 * 行首（第一条管道线之前）和行尾（最后一条之后）的空白段只是边框，不算格子 ——
 * `| a | b |` 是两格不是三格，这和 GFM 的算法一致。
 *
 * @param state - 编辑器状态
 * @param node - TableHeader / TableRow 节点
 * @returns 这一行的行号区间与各格子区间（可能为空区间）
 */
export function readRow(state: EditorState, node: SyntaxNode): TableLine {
    const line = state.doc.lineAt(node.from);
    const delimiters: number[] = [];
    let child = node.firstChild;
    while (child) {
        if (child.name === 'TableDelimiter') delimiters.push(child.from);
        child = child.nextSibling;
    }

    // 理论上表格行一定有管道线；真没有就整行算一格，别崩
    if (delimiters.length === 0) {
        const from = state.doc.sliceString(node.from, line.to).search(/\S/);
        const start = from < 0 ? node.from : node.from + from;
        return { lineFrom: line.from, lineTo: line.to, cells: [{ from: start, to: start }] };
    }

    const segments: Array<{ from: number; to: number }> = [];
    let cursor = node.from;
    for (const delimiter of delimiters) {
        segments.push({ from: cursor, to: delimiter });
        cursor = delimiter + 1;
    }
    segments.push({ from: cursor, to: line.to });

    const isBlank = (seg: { from: number; to: number }): boolean =>
        state.doc.sliceString(seg.from, seg.to).trim() === '';
    if (segments.length > 1 && isBlank(segments[0])) segments.shift();
    if (segments.length > 1 && isBlank(segments[segments.length - 1])) segments.pop();

    // 收紧到非空白部分；全是空白的格子也照样占一格
    const cells = segments.map((seg) => {
        const text = state.doc.sliceString(seg.from, seg.to);
        const leading = text.length - text.trimStart().length;
        const trailing = text.length - text.trimEnd().length;
        const from = seg.from + leading;
        const to = Math.max(from, seg.to - trailing);
        // 空格子（全空白、零长区间）：位置放在 seg 内**最后一个空白字符**处，
        // 而不是 seg.to（那是后面管道符的位置）。装饰时这个空格会被「借」进
        // tcell 盒子，光标和输入法组合就有了正常字号的落脚点 ——
        // 否则空格子光标只能落在 font-size:0 的缝隙里，输入时格子边框还会消失
        if (from === to && from === seg.to && seg.to > seg.from) {
            return { from: seg.to - 1, to: seg.to - 1 };
        }
        return { from, to };
    });
    return { lineFrom: line.from, lineTo: line.to, cells };
}

/**
 * 找出全文所有表格。
 *
 * @param state - 编辑器状态
 * @param tree - 语法树（可能是增量解析中的不完整树，那也只是少渲染一点）
 * @returns 表格骨架列表
 */
export function findTables(
    state: EditorState,
    tree: Tree,
    range: { from: number; to: number }
): TableBlock[] {
    const tables: TableBlock[] = [];
    tree.iterate({
        from: range.from,
        to: range.to,
        enter: (nodeRef) => {
            if (nodeRef.name !== 'Table') return;
            const block = readTable(state, nodeRef.node);
            if (block) tables.push(block);
            return false; // 表里不会再有表，不用往下找
        },
    });
    return tables;
}
