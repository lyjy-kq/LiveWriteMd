/**
 * 表格的结构操作：增删行列。
 *
 * 这些东西**改的是文档**，和渲染（tableRender.ts）是两码事，所以单独放一个模块：
 * 渲染那边只管把源码画成格子，这边只管在管道线上增删格子。右键菜单
 * （webview/editorContextMenu.ts）是唯一的调用方。
 *
 * ## 两条约定
 *
 * 1. **格子一律按文本切**（`splitRowText`），不查语法树：lezer 会把空格子跳过，
 *    拿它数格子的话空列会对不上号，删错列是最难查的那种错。
 * 2. **改造一行就整行重拼成 `| a | b |`**。比「抠掉第 k 格的区间」啰嗦一点，
 *    但行首行尾少写管道线、格子数不齐这些情况全都不用单独处理 ——
 *    反正渲染时格子两侧空白会被吃掉，重拼不会改变看到的样子。
 *
 * @module webview/codemirror/extensions/livePreview/tableCommands
 */

import type { ChangeSpec, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { cellAt, tableBlockAt } from './tableCellSelection.js';
import { splitRowText } from './tableDetect.js';
import type { TableBlock, TableLine } from './tableTypes.js';

/** 右键菜单里的表格操作。 */
export type TableCommand =
    | 'row-above'
    | 'row-below'
    | 'col-left'
    | 'col-right'
    | 'delete-row'
    | 'delete-col';

/**
 * 表格里的一行（重排过的）：真正参与增删的单位。
 *
 * 表头行和分隔行的位置固定（分隔行永远紧跟表头），所以带上 kind 才好判断
 * 「这行能不能删」「往这行上面插行该插到哪儿」。
 */
interface Row {
    kind: 'header' | 'delimiter' | 'data';
    /** 行首 / 行尾的文档位置（不含换行符） */
    from: number;
    to: number;
    /** 各格子的原文（已去两侧空白） */
    cells: string[];
}

/**
 * 把表格骨架摊平成「一行一条」的列表（表头、分隔行、数据行按文档顺序）。
 *
 * @param state - 编辑器状态
 * @param block - 表格骨架
 * @returns 行列表
 */
function readRows(state: EditorState, block: TableBlock): Row[] {
    const toRow = (line: TableLine, kind: Row['kind']): Row => ({
        kind,
        from: line.lineFrom,
        to: line.lineTo,
        cells: splitRowText(state.doc.sliceString(line.lineFrom, line.lineTo)).map((seg) =>
            state.doc.sliceString(line.lineFrom + seg.from, line.lineFrom + seg.to)
        ),
    });

    const rows: Row[] = [];
    for (const row of block.rows) {
        // 表头行永远是第一行；分隔行紧跟其后（GFM 的规定），所以这里插在表头后面
        rows.push(toRow(row.line, row.isHeader ? 'header' : 'data'));
        if (row.isHeader && block.delimiter) {
            rows.push(toRow(block.delimiter, 'delimiter'));
        }
    }
    // 兜底表格（被解析成 Setext 标题那种）没有 delimiter 字段以外的特殊情况，
    // 真缺分隔行也别让行序乱掉：这里什么都不用补，渲染时按 kind 找得到就行。
    return rows;
}

/**
 * 用标准形式拼回一行（`| a | b |`）。
 *
 * @param cells - 各格子的原文
 * @returns 整行文本
 */
function buildRow(cells: string[]): string {
    return `| ${cells.join(' | ')} |`;
}

/**
 * 一次表格操作的落点：要动哪张表、哪几行、哪几列。
 *
 * `rows` / `cols` 都是**下标**，行下表按 readRows 的顺序（表头 0、分隔行 1、数据行往后），
 * 列下表从 0 开始。框选了多个格子时它们就是整片范围，只点了一个格子时就各有一个元素。
 *
 * 注意两者的用途不一样：`rows` 只给行操作（增删行）用，`cols` 只给列操作用 ——
 * 列操作是整张表一起改的，不看 `rows`，不然改完行与行的格子数就对不上了。
 */
export interface TableContext {
    /** 表格骨架 */
    block: TableBlock;
    /** 参与操作的行下标（升序，已去掉分隔行） */
    rows: number[];
    /** 参与操作的列下标（升序） */
    cols: number[];
    /** 右键落点所在的格子 */
    cell: { from: number; to: number };
    /** 全部行（含分隔行） */
    allRows: Row[];
    /** 列数 */
    colCount: number;
}

/**
 * 解析一次右键（或一次命令）要作用的表格范围。
 *
 * **框选优先**：选区里框了几个格子，操作就作用到这几行几列上；
 * 没框选（只有一个光标）时就作用到光标所在的那一格。
 *
 * @param state - 编辑器状态
 * @param pos - 右键落点的文档位置
 * @returns 操作上下文；不在表格里时返回 null
 */
export function resolveTableContext(state: EditorState, pos: number): TableContext | null {
    const block = tableBlockAt(state, pos);
    if (!block) return null;
    const cell = cellAt(state, pos);
    if (!cell) return null;

    const allRows = readRows(state, block);
    const colCount = allRows.reduce((max, row) => Math.max(max, row.cells.length), 0);

    const selection = state.selection.main;
    // 没框选就是「就这一格」：起止都取右键落点
    const from = selection.empty ? pos : selection.from;
    const to = selection.empty ? pos : selection.to;

    // 行：和选区有交集的都算（分隔行除外 —— 删了表就废了）
    const rows: number[] = [];
    for (let i = 0; i < allRows.length; i++) {
        const row = allRows[i];
        if (row.kind === 'delimiter') continue;
        if (row.to < from || row.from > to) continue;
        rows.push(i);
    }
    if (rows.length === 0) return null;

    // 列：先看选区的两个端点各落在哪一列 —— 框选出来的范围两端正好压在格子边界上，
    // 两个端点的列号区间就是用户框住的那几列。
    // 不能图省事用「文本范围有交集」去扫：框选 a1..b2 的文本范围是一条连续区间，
    // 中间整行（c1）也被它盖住，扫出来会变成「所有列」，删列就被安全阀挡回去了。
    const cols: number[] = [];
    const startRow = rows.length > 0 ? allRows[rows[0]] : null;
    const endRow = rows.length > 0 ? allRows[rows[rows.length - 1]] : null;
    const startCol = startRow ? columnAt(state, startRow, from) : null;
    const endCol = endRow ? columnAt(state, endRow, to) : null;

    if (startCol !== null && endCol !== null) {
        for (let col = Math.min(startCol, endCol); col <= Math.max(startCol, endCol); col++) {
            cols.push(col);
        }
    } else {
        // 端点算不出列号（选区一头扎在表格外之类）就退回扫描：和选区有交集的格子都算。
        // 空格子（零长区间）用「闭区间有交集」判，正好落在空列上时也能选中它。
        for (const rowIndex of rows) {
            const row = allRows[rowIndex];
            const line = state.doc.lineAt(row.from);
            splitRowText(line.text).forEach((seg, col) => {
                const cellFrom = line.from + seg.from;
                const cellTo = line.from + seg.to;
                if (cellTo < from || cellFrom > to) return;
                if (!cols.includes(col)) cols.push(col);
            });
        }
        cols.sort((x, y) => x - y);
    }

    return { block, rows, cols, cell, allRows, colCount };
}

/**
 * 某个文档位置落在这一行的第几列（下标）。
 *
 * 和列检测一样按文本切，不看语法树；落在格子之间（管道线、两侧空白）时归属
 * 相邻的那一格，这样「正好点在格子边界上」也不会算出 null。
 *
 * @param state - 编辑器状态
 * @param row - 行
 * @param pos - 文档位置
 * @returns 列下标；这行没有格子时返回 null
 */
function columnAt(state: EditorState, row: Row, pos: number): number | null {
    const line = state.doc.lineAt(row.from);
    const segments = splitRowText(line.text);
    if (segments.length === 0) return null;

    for (let col = 0; col < segments.length; col++) {
        const segment = segments[col];
        if (line.from + segment.to < pos || line.from + segment.from > pos) continue;
        return col;
    }
    // 落在最后一格右边（行尾管道线之后）时算最后一列
    return segments.length - 1;
}

/**
 * 在某一行**内容末尾**插一行进去（换行符放在新行前面）。
 *
 * 为什么不把 `\n` 放在新行后面：`at` 取的是行内容的末尾，也就是**原行换行符的前一位**。
 * 在这里插 `\n新行`，得到的是「原行 / 新行 / 原行后面那行」，正好；
 * 插 `新行\n` 就会把新行接到原行尾巴上变成 `| a | b ||  |  |`，这是踩过的坑。
 * 文档最后一行没有换行符也不影响：在末尾插 `\n新行` 就是纯粹追加一行。
 *
 * @param changes - 待应用的改动列表
 * @param at - 插入位置（某一行的 `lineTo`）
 * @param cells - 新行各格的原文
 */
function pushRowInsert(changes: ChangeSpec[], at: number, cells: string[]): void {
    changes.push({ from: at, insert: `\n${buildRow(cells)}` });
}

/**
 * 执行一次表格操作。
 *
 * @param view - 编辑器视图
 * @param command - 要做的操作
 * @param pos - 右键落点（放在哪一格上）
 * @returns 真的改了文档时返回 true；条件不满足（比如只剩一列）时返回 false
 */
export function runTableCommand(view: EditorView, command: TableCommand, pos: number): boolean {
    const state = view.state;
    if (!state.facet(EditorView.editable)) return false;
    const context = resolveTableContext(state, pos);
    if (!context) return false;

    const changes: ChangeSpec[] = [];
    const { allRows, colCount } = context;

    if (command === 'delete-row') {
        // 表头不能凭空消失：把第一个数据行提上来当表头（用户看到的就是「整块往上挪一行」）
        const targets = [...context.rows].sort((a, b) => a - b);
        const headerIndex = allRows.findIndex((row) => row.kind === 'header');
        const deletingHeader = headerIndex >= 0 && targets.includes(headerIndex);
        const survivors = allRows
            .map((row, index) => ({ row, index }))
            .filter((item) => item.row.kind !== 'delimiter' && !targets.includes(item.index));

        if (deletingHeader) {
            const next = survivors.find((item) => item.row.kind === 'data');
            // 一个数据行都不剩：表头 + 分隔行凑不出表格，干脆不动
            if (!next) return false;
            const header = allRows[headerIndex];
            changes.push({ from: header.from, to: header.to, insert: buildRow(next.row.cells) });
            // 表头那一行**不删**（只换内容），删的是被提上来的那一行
            targets.splice(targets.indexOf(headerIndex), 1);
            targets.push(next.index);
        }
        if (targets.length === 0) return false;
        for (const index of targets) deleteLine(changes, state, allRows[index]);
        if (changes.length === 0) return false;
        view.dispatch({ changes });
        return true;
    }

    if (command === 'delete-col') {
        // 一列都不剩的话表格就没了，直接不动（比删出一堆空壳子安全）
        if (context.cols.length === 0 || context.cols.length >= colCount) return false;
        // 列是整张表的属性，**每一行都得改**（表头、分隔行、数据行一个不落）：
        // 只改右键点中的那几行，表头行数就跟别的行对不上了，整张表当场散架。
        for (const row of allRows) {
            const cells = row.cells.filter((_, col) => !context.cols.includes(col));
            // 删到一格不剩的行（本来就只有一列）跳过，留着比删干净安全
            if (cells.length === 0) continue;
            changes.push({ from: row.from, to: row.to, insert: buildRow(cells) });
        }
        if (changes.length === 0) return false;
        view.dispatch({ changes });
        return true;
    }

    if (command === 'col-left' || command === 'col-right') {
        const insertAt = command === 'col-left' ? context.cols[0] : context.cols[context.cols.length - 1] + 1;
        // 同样地：插列也是整张表的事，每一行都要跟着插一格
        for (const row of allRows) {
            const cells = [...row.cells];
            while (cells.length < insertAt) cells.push(''); // 这一行本来就写得短，先补齐再插
            // 新列的格子：数据行留空，分隔行给一个 `---`（默认左对齐）
            cells.splice(insertAt, 0, row.kind === 'delimiter' ? '---' : '');
            changes.push({ from: row.from, to: row.to, insert: buildRow(cells) });
        }
        if (changes.length === 0) return false;
        view.dispatch({ changes });
        return true;
    }

    // 'row-above' / 'row-below'
    const newCells = new Array(colCount).fill('');
    if (command === 'row-below') {
        // 多行框选时「在下面加一行」加在最后一行下面
        const anchor = allRows[context.rows[context.rows.length - 1]];
        if (!anchor) return false;
        // 表头的「下面」= 分隔行下面，也就是第一个数据行的位置
        const after = anchor.kind === 'header' ? allRows[findDelimiterIndex(allRows)] : anchor;
        if (!after) return false;
        pushRowInsert(changes, after.to, newCells);
    } else {
        // 表头上方插不了行（GFM 里表格的第一行就是表头），退一步插成第一个数据行
        const anchor = allRows[context.rows[0]];
        if (!anchor) return false;
        const before =
            anchor.kind === 'header' ? allRows[findDelimiterIndex(allRows)] : allRows[context.rows[0] - 1];
        if (!before) return false;
        pushRowInsert(changes, before.to, newCells);
    }
    view.dispatch({ changes });
    return true;
}

/**
 * 找分隔行在行列表里的下标。
 *
 * @param rows - 行列表
 * @returns 下标；没有分隔行时返回 0
 */
function findDelimiterIndex(rows: Row[]): number {
    const index = rows.findIndex((row) => row.kind === 'delimiter');
    return index < 0 ? 0 : index;
}

/**
 * 把一整行（含换行符）加进改动列表。
 *
 * 末尾行没有「下一行的换行符」可用，只能连前一个换行符一起删 —— 不然会留下一行空行。
 *
 * @param changes - 待应用的改动列表
 * @param state - 编辑器状态
 * @param row - 要删的行
 */
function deleteLine(
    changes: ChangeSpec[],
    state: EditorState,
    row: Row
): void {
    const line = state.doc.lineAt(row.from);
    if (line.number < state.doc.lines) {
        changes.push({ from: line.from, to: line.to + 1 });
    } else if (line.from > 0) {
        changes.push({ from: line.from - 1, to: line.to });
    } else {
        changes.push({ from: line.from, to: line.to });
    }
}
