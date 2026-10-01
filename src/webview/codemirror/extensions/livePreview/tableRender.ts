/**
 * 表格的「就地渲染」。
 *
 * ## 为什么不是 widget
 *
 * 表格原来是一整块 `Decoration.replace` widget：源码被换掉，格子里的加粗、斜体、
 * 行内代码全靠 `renderInlineMarkdown` 拼 HTML 字符串再 `innerHTML` 塞进去。
 * 那条路和正文的渲染（语法树 + 装饰）是两套东西，类名、解析规则都得各维护一份，
 * 于是「表格里的加粗不是我自己定义的样式」这类问题反复出现；更要命的是
 * widget 内部光标进不去，单元格要编辑就得自己上 contenteditable、自己转义 `|`、
 * 自己钉列宽、自己处理输入法。
 *
 * 现在改成**保留源码、就地装饰**：
 *
 * - 管道线和它两侧的空白压成 0 宽（`.cm-md-tgap`），单元格内容用行内块 span
 *   （`.cm-md-tcell`）撑出格子，列宽钉死，所以同一列的格子左右对齐；
 * - 格子里的加粗 / 斜体 / 删除线 / 行内代码 / 链接 / 公式全部由**正文那条通道**
 *   （plugin.ts 的语法树遍历 + decorations.ts 的 mark）渲染，类名天然一致；
 * - 单元格里就是**真实的文档光标**：点进去直接打字，输入法、撤销、选区全走原生，
 *   不需要 contenteditable，也不需要写回。
 *
 * ## 三件事
 *
 * 1. **格子骨架**：管道线压 0 宽、单元格定宽、表头行加类名、分隔行折叠
 *    （光标停在分隔行上时摊开，方便改对齐方式）。整行是 flex 容器，
 *    单元格是它的 flex item，所以同一行的格子**高度永远一致**
 *    （一行里有的格子写三行、有的写一行，边框也不会参差不齐）。
 * 2. **列宽**：每列量两个宽度 —— 「不换行时多宽」（自然宽）和「折到最狠还能多宽」
 *    （min-content，交给浏览器算）。所有列的自然宽塞得进正文可用宽，就照自然宽钉死，
 *    整张表一行到底；塞不下再把超出的部分压给「让得出最多」的那几列，
 *    被压的列数最少（见 distributeColumns）。光标在表内打字时列宽只涨不缩
 *    （Canvas 粗估），否则内容长了列却不涨，打着打着就折行了。
 *
 *    「可用宽」= **正文文字的左右边界之间**（见 availableWidth）：行号栏、正文内边距、
 *    行宽上限（`flowMd.readableLineLength`）全都要扣掉。表格最宽也就是这么宽，
 *    两边和正文的文字对齐（不是和整个编辑区对齐 —— 那里还含着行号栏和两侧留白）。
 * 3. **框选**：在格子上拖鼠标就是**普通的文本选区**（见 tableCellSelection），
 *    不再往格子边界上吸附 —— 稍微滑一下只选到划过的几个字。
 *    只有当一格的内容被选区**完整盖住**时，这一格才整体上高亮。
 *
 * 增删行列这些**改文档**的操作不在这里：见 tableCommands.ts（右键菜单调它）。
 *
 * @module webview/codemirror/extensions/livePreview/tableRender
 */

import { EditorSelection, type EditorState } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { SyntaxNode, Tree } from '@lezer/common';
import { Decoration, EditorView, ViewPlugin, type MouseSelectionStyle, WidgetType } from '@codemirror/view';
import {
    getMeasureContext,
    measureText,
    parseAlignments,
    renderInlineMarkdown,
} from './helpers.js';
import { HorizontalRuleWidget } from './widgets.js';
import { isInSourceMode, sourceModeEffect, tableRemeasureEffect } from './state.js';

/** 单元格左右内边距（px）。 */
const CELL_PAD_X = 10;

/** 单元格边框宽度（px）。列宽是 border-box，算宽度时要把边框也算进去。 */
const CELL_BORDER_PX = 1;

/** 一列的最小宽度（px），防止有内容的列被压成一条线。 */
const MIN_COL_PX = 48;

/**
 * 「整列都没内容」的列缩到极限时能有多窄（px）。
 *
 * 表格总宽超了、要按比例缩的时候，空列要是也跟着守 48px 的底线，缩放就被顶回去 ——
 * 十几列空列能把表撑得比正文还宽（实测过：2 个内容列 + 12 个空列撑到 1262px）。
 * 空列本来就没内容，留一条窄边即可，格子照样画出来。
 *
 * 分配列宽时空列**第一个让位**：它让出来不心疼，而让得出的量就那么点（28 → 14），
 * 先让完再谈牺牲哪几个内容列，免得出现「十几个空列撑着表、真正的长列却在折行」。
 */
const MIN_EMPTY_COL_PX = 14;

/**
 * 列宽的额外余量（px）。
 *
 * 量尺量出来的宽度和真正渲染出来的宽度可能差零点几个像素（取整、字距、
 * 中文步进的整数化），正好卡在边界上时单元格就会折行、那一行突然高出一截。
 * 这里留一点余量把这种边界情况挡掉——列宽宽几个像素看不出来，多折一行很难看。
 */
const COL_WIDTH_SLACK = 6;

/**
 * 一格除内容之外的固定开销（px）：左右内边距 + 左右边框 + 余量。
 *
 * 量尺量的是**内容**宽，这些要另外加。做成常量是因为「折行上限」那条规则
 * 必须按内容宽来算（见 floorsOf），减去它的地方不能各写各的。
 */
const CELL_OVERHEAD = CELL_PAD_X * 2 + CELL_BORDER_PX * 2 + COL_WIDTH_SLACK;

/**
 * 被牺牲的列最多折几行 —— 「牺牲少数列」里的「牺牲」到什么程度。
 *
 * 一列自然宽 300px，它的下限就是 100px（折三行）。压到 100px 还不够，就轮到
 * 下一列去折：**宁可两列各折一点，也不让一列折成一条线**。这个数调小＝更倾向
 * 保住少数列、让它们折得更狠；调到 1 就等于「谁都不许折」，表格会直接走溢出那条路。
 */
const MAX_SACRIFICE_LINES = 3;

/** 单元格 / 缝隙 / 行 / 分隔行的类名。 */
const CELL_CLASS = 'cm-md-tcell';
/** 被框选到的格子。整格上高亮，和只涂文字的原生选区区分开。 */
const CELL_SELECTED_CLASS = 'cm-md-tcell-selected';
const GAP_CLASS = 'cm-md-tgap';
const ROW_CLASS = 'cm-md-table-row';
const HEADER_CLASS = 'cm-md-table-header';
/** 偶数数据行：配合 --flowmd-table-stripe-background 画斑马纹。 */
const STRIPE_CLASS = 'cm-md-table-stripe';
const DELIMITER_CLASS = 'cm-md-table-delimiter';

/** 表格里的一行。 */
export interface TableLine {
    lineFrom: number;
    lineTo: number;
    /** 单元格内容区间（已去掉两侧空白，直接来自 TableCell 节点） */
    cells: Array<{ from: number; to: number }>;
}

/** 一张表在文档里的骨架。 */
export interface TableBlock {
    /** 表格整体范围，当缓存 key 用 */
    from: number;
    to: number;
    /** 表头行 + 数据行（不含分隔行） */
    rows: Array<{ line: TableLine; isHeader: boolean }>;
    /** 分隔行（`|---|:--:|`），只有一行 */
    delimiter: TableLine | null;
    /** 每列的对齐方式 */
    alignments: Array<string | null>;
    /** 列数（取各行最大值） */
    colCount: number;
    /**
     * 兜底表格后面那条被当成 Setext 下划线的分隔线（`---` / `===`）的区间。
     *
     * 正常情况下它没有意义（真表格后面不是标题下划线），只有「表格后面紧跟 ---」
     * 这种被误判的块才有 —— 要把它按**水平线**渲染出来，而不是让 HeaderMark
     * 那条规则把它藏成 0 宽（那正是「那一行不见了」的原因）。
     */
    underline?: { from: number; to: number };
}

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
function readRow(state: EditorState, node: SyntaxNode): TableLine {
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

    // 收紧到非空白部分；全是空白的格子就留一个零长区间，照样占一格
    const cells = segments.map((seg) => {
        const text = state.doc.sliceString(seg.from, seg.to);
        const leading = text.length - text.trimStart().length;
        const trailing = text.length - text.trimEnd().length;
        return { from: seg.from + leading, to: Math.max(seg.from + leading, seg.to - trailing) };
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
function findTables(
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
        return { from: seg.from + leading, to: Math.max(seg.from + leading, seg.to - trailing) };
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
function findTextTables(
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

// =============================================================================
// 量列宽
// =============================================================================

/**
 * 量尺：屏幕外的隐藏盒子，量「单元格渲染出来有多宽」。
 *
 * 必须用真实布局量，不能用 canvas：单元格里可能有加粗（换字重）、行内代码
 * （等宽字体 + 0.95em 字号 + 左右各 6px 内边距）、公式（KaTeX 排版）、复选框，
 * 这些都是样式表算出来的，canvas 量不到。量尺里塞的就是 `renderInlineMarkdown`
 * 产出的 HTML。
 *
 * **两把尺子**，因为一列要量两个宽度：
 *
 * - `pre` 那把 `white-space: pre`，量出「一个字符都不折」时多宽（自然宽）；
 * - `min` 那把让每个格子 `width: min-content`，量出「折到最狠还能多宽」。
 *   这个值不能自己算 —— 中英文混排怎么断、`overflow-wrap` 怎么生效、行内代码
 *   里面还能不能断，规则全在浏览器肚子里，问它最省事也最准。
 *
 * 两把尺子挂在同一个宿主下，而宿主**抄了编辑器身上那几个主题类名**：
 * `.cm-md-*` 那套规则来自 `EditorView.baseTheme`，选择器形如 `.ͼN .cm-md-code`
 * （后代选择器，N 是 CodeMirror 生成的随机类名）。量尺直接挂 `document.body` 上，
 * 一条规则都命中不了 —— 行内代码会漏掉左右各 6px 的内边距、复选框按浏览器默认
 * 尺寸算，量出来天然比真渲染窄，格子白白折行。抄类名比手写一份「量尺专用样式」
 * 更不容易和正文走散。
 *
 * 为什么不干脆挂进 `.cm-editor` 里面：CodeMirror 的 DOMObserver 盯着那块 DOM，
 * 多一个节点会被当成「DOM 被外部改过」，白白触发一次重新解读。
 */
let rulerHost: HTMLElement | null = null;

/** 两把量尺。随宿主一起生死，字体一变（换字号/字体缩放）整个重建。 */
const rulers: { pre: HTMLElement | null; min: HTMLElement | null } = { pre: null, min: null };

/** 建两把尺子时用的字体，用来判断要不要重建。 */
let rulerFont = '';

/**
 * 取（必要时创建 / 刷新）量尺宿主。
 *
 * @returns 挂量尺的宿主元素
 */
function ensureRulerHost(): HTMLElement {
    if (!rulerHost || !rulerHost.isConnected) {
        const host = document.createElement('div');
        host.setAttribute('aria-hidden', 'true');
        // 给复现页留个抓手：量尺是不是真的「脱离排版」了，从外面才看得出来
        host.dataset.flowmdRuler = '1';
        // 容器本身不参与页面排版：绝对定位 + 移出可视区 + 不可见，
        // `contain: layout style` 再把它和外界隔开（不然字体、行高都可能被继承污染）
        // 注意 `!important`：下面抄过来的主题类名里带着 baseTheme 的 `&` 规则，
        // 那条规则把 `position: relative !important` 和 `display: flex !important`
        // 按在宿主身上 —— 不写 !important 的话内联样式压不住它，宿主会掉回文档流里，
        // 一把几千像素宽的尺子就这么插进页面（实测会把整页撑出横向滚动条）。
        // 同一条规则还带 `display:flex`，会让两把尺子变成 flex item，也一并压回去。
        host.style.cssText = [
            'position:absolute !important',
            'display:block !important',
            'left:-99999px',
            'top:0',
            'visibility:hidden',
            'pointer-events:none',
            // 三保险：就算位置那几条将来又被什么规则顶掉，一个 0×0 且裁剪的盒子里
            // 也漏不出东西去影响页面。尺子里的元素都是自带宽度的（pre 不折行、
            // min-content 是显式宽度），父盒 0 宽不影响它们的盒宽。
            'width:0',
            'height:0',
            'overflow:hidden',
            'contain:layout style',
        ].join(';');
        document.body.appendChild(host);
        rulerHost = host;
        // 宿主是新造的，里面那两把尺子跟着作废；字体缓存也一起清掉，
        // 让下面重新按当前字体建一遍
        rulers.pre = null;
        rulers.min = null;
        rulerFont = '';
    }

    // 每次重建都同步一遍主题类名：第一次量的时候（EditorState.create 阶段）
    // 编辑器可能还没挂进 DOM，那份「没有类名」的宿主不能一直用下去；
    // 换主题时 CodeMirror 也会换掉其中一个类名。
    const editor = document.querySelector('#editor .cm-editor');
    const classes = editor
        ? Array.from(editor.classList)
              .filter((name) => name.startsWith('ͼ'))
              .join(' ')
        : '';
    if (rulerHost.className !== classes) rulerHost.className = classes;

    return rulerHost;
}

/**
 * 取（必要时创建 / 刷新）两把量尺。
 *
 * @returns 量不换行宽的尺子和量 min-content 宽的尺子
 */
function ensureRulers(): { pre: HTMLElement; min: HTMLElement } {
    const host = ensureRulerHost();
    // 字体要和正文一致，否则量出来的宽度没有意义
    const ctx = getMeasureContext();
    const font = [
        `font-size:${ctx?.size ?? 14}px`,
        `font-family:${ctx?.family ?? 'monospace'}`,
        // 正文那一档字重（可能是用户调过的 --flowmd-font-weight）；
        // 表头行的 600 在条目上单独加，见 measureCells
        `font-weight:${ctx?.weight ?? '400'}`,
        'line-height:1',
    ].join(';');

    if (rulers.pre?.isConnected && rulers.min?.isConnected && rulerFont === font) {
        return { pre: rulers.pre, min: rulers.min };
    }

    rulers.pre?.remove();
    rulers.min?.remove();

    const pre = document.createElement('div');
    pre.style.cssText = `${font}; white-space:pre; width:auto; height:auto;`;

    const min = document.createElement('div');
    min.style.cssText = [
        font,
        'white-space:normal',
        'word-break:normal',
        // 必须和 .cm-md-tcell 上的值保持一致（styles.ts 里是 break-word）——
        // 换成 anywhere 的话 min-content 会退化成「一个字符宽」，下限就没意义了
        'overflow-wrap:break-word',
        'width:auto',
        'height:auto',
    ].join(';');

    host.appendChild(pre);
    host.appendChild(min);
    rulers.pre = pre;
    rulers.min = min;
    rulerFont = font;
    return { pre, min };
}

/** 一条待量的单元格。 */
interface CellMeasureRequest {
    /** 单元格源码（不含管道线和两侧空白） */
    text: string;
    /** 是不是表头行：表头格子是 600 字重，比正文宽，量的时候得按 600 量 */
    header: boolean;
}

/**
 * 单元格宽度缓存：同一段「源码 + 字重 + 字体」只量一次。
 *
 * 量一次 = 挂两次 DOM + 读两次盒宽 = **一次强制布局**，很贵。
 * 同一个词在几十个格子里重复出现是常态，缓存能省掉绝大部分。
 *
 * key 里带字体是必须的：首次构建发生在视图挂进 DOM 之前，`getMeasureContext()`
 * 那时只能退到 body 上取字体（界面字体 ≠ 编辑器字体，宽得不是一点），
 * 量出来的宽度是错的。视图挂上来之后字体一变，key 就变了，那份错的自然作废。
 */
const cellWidthCache = new Map<string, { max: number; min: number }>();

/**
 * 当前字体环境的指纹（量宽度必须用它，缓存 key 里也要带上它）。
 *
 * @returns 形如 `14|Menlo, monospace|400|Consolas` 的指纹
 */
function fontKey(): string {
    const ctx = getMeasureContext();
    return `${ctx?.size ?? 14}|${ctx?.family ?? ''}|${ctx?.weight ?? '400'}|${ctx?.codeFamily ?? ''}`;
}

/**
 * 一次量一批单元格：`max` 是不换行时的宽，`min` 是折到最狠时的宽。
 *
 * 两把尺子一起写、一起读：**所有的挂载（写）全做完再统一读盒宽，中途一次都不读**
 * —— 读一次就强制一次布局，文档越大越贵。所以整批只付一次强制布局的钱。
 *
 * @param requests - 待量的单元格（顺序即返回顺序）
 * @returns 与 requests 一一对应的内容宽度（px，不含内边距边框，调用方自己加）
 */
function measureCells(requests: CellMeasureRequest[]): Array<{ max: number; min: number }> {
    const results = requests.map(() => ({ max: 0, min: 0 }));
    const pending: number[] = [];
    // 字体进 key：换字号/字体缩放/换主题，量出来的宽度就全不作数了
    const font = fontKey();
    const keyOf = (request: CellMeasureRequest): string =>
        `${font}|${request.header ? 'h' : 'b'}|${request.text}`;

    requests.forEach((request, index) => {
        if (!request.text) return; // 空格子：两个宽度都是 0，不用量
        const cached = cellWidthCache.get(keyOf(request));
        if (cached) {
            results[index] = cached;
            return;
        }
        pending.push(index);
    });
    if (pending.length === 0) return results;

    const { pre, min } = ensureRulers();
    pre.textContent = '';
    min.textContent = '';

    /**
     * 挂一个条目，返回**要读宽度**的那个元素。
     *
     * @param ruler - 挂到哪把尺子上
     * @param index - 条目下标
     * @param boxed - min-content 那把尺子上要额外套一层容器，见下面的说明
     * @returns 读宽度用的元素
     */
    const mount = (ruler: HTMLElement, index: number, boxed: boolean): HTMLElement => {
        const html = renderInlineMarkdown(requests[index].text);
        // 表头按 600 量：styles.ts 的 `.cm-md-table-header .cm-md-tcell` 是 600，
        // 同一个汉字 400 和 600 能差 7%，不补回来的话表头那一行会莫名其妙折行
        const content = requests[index].header
            ? `<span style="font-weight:600">${html}</span>`
            : html;
        if (boxed) {
            // min-content 必须**一格一个容器**：几个格子共用一个 width:min-content
            // 的父元素时，父元素的 min-content 取的是所有格子里最大的那个，
            // 短格子会被撑到那个宽度，量出来的就不是它自己的下限了
            const box = document.createElement('div');
            box.style.cssText = 'width:min-content';
            box.innerHTML = content;
            ruler.appendChild(box);
            return box;
        }
        const span = document.createElement('span');
        span.innerHTML = content;
        ruler.appendChild(span);
        return span;
    };

    const preEls = pending.map((index) => mount(pre, index, false));
    const minEls = pending.map((index) => mount(min, index, true));

    // ↓ 这两行之间不能再碰 DOM，否则每读一次就多强制一次布局
    const preWidths = preEls.map((el) => el.getBoundingClientRect().width);
    const minWidths = minEls.map((el) => el.getBoundingClientRect().width);

    pre.textContent = '';
    min.textContent = '';

    if (cellWidthCache.size > 500) cellWidthCache.clear();
    pending.forEach((index, slot) => {
        const value = { max: preWidths[slot], min: minWidths[slot] };
        cellWidthCache.set(keyOf(requests[index]), value);
        // 同一段文字在别的列里也出现时，不用再等下一次才命中缓存
        results[index] = value;
    });
    return results;
}

/**
 * 列宽缓存：key 是表格在文档里的起点。
 *
 * 一份缓存里存着**两截东西**，它们变化的时机完全不同，分开存是为了少重量：
 *
 * - `natural` / `min` 是**量**出来的（贵：一次强制布局），只跟「表格源码 + 字体」有关，
 *   跟正文有多宽没关系；
 * - `cols` 是**分**出来的（便宜：纯算术，见 distributeColumns），跟可用宽度有关。
 *
 * 分开之后，拖窗口、改字体缩放、开关侧边栏这些「可用宽度变了但表格没变」的情况
 * 只重跑一遍除法，**一个格子都不用量**。合在一起存的话每变一次都得重量整张表。
 *
 * 光标停在表格里（正在编辑）时走另一条路：不重量，用 Canvas 粗估当前那一列，
 * 只让它涨不让它缩，并且**把涨幅写回 `natural`**（见 columnWidthsFor）——
 * 不写回的话，光标一挪到旁边那列，刚才敲出来的宽度就没了。
 */
const columnWidthCache = new Map<
    number,
    {
        textKey: string;
        natural: number[];
        min: number[];
        hasContent: boolean[];
        available: number;
        cols: number[];
    }
>();

/**
 * 一份表格的「内容指纹」：源码 + 当时的字号字体。
 *
 * 字号或字体（换主题、改字体缩放）一变，量出来的宽度就作废了，所以一起进指纹。
 *
 * @param state - 编辑器状态
 * @param block - 表格骨架
 * @returns 指纹字符串
 */
function tableTextKey(state: EditorState, block: TableBlock): string {
    const ctx = getMeasureContext();
    return `${ctx?.size ?? 14}|${ctx?.family ?? ''}|${state.doc.sliceString(block.from, block.to)}`;
}

/**
 * 各列的**下限宽度**（px）：一列再怎么被压，也不会比这个更窄。
 *
 * 三个来源取最大：
 *
 * 1. `min`：min-content，**折到最狠还有多宽**。低于它就会把「不许断的片段」
 *    从中间劈开 —— 长 URL、长代码、长英文单词。这是物理下限，量出来的。
 * 2. `MIN_COL_PX`：不许把有内容的列压成一条线。
 * 3. `natural / MAX_SACRIFICE_LINES`：**最多折几行**换来的宽度。这是「牺牲」
 *    的尺度 —— 一列折到三行还不够，就该轮到下一列去折了。
 *
 * 第 3 条要按**内容**宽算：把内边距那部分先扣掉再除，除完再加回去。
 * 直接拿整格宽去除的话，窄列的固定开销会被摊进每一行，算出来的下限偏小。
 *
 * @param natural - 各列自然宽（px，含内边距边框余量）
 * @param min - 各列 min-content 宽（px，含内边距边框余量）
 * @param hasContent - 各列是不是有内容（整列空的不适用折行上限，压到极限也不心疼）
 * @returns 各列的下限宽度（px）
 */
function floorsOf(natural: number[], min: number[], hasContent: boolean[]): number[] {
    return natural.map((value, col) => {
        if (!hasContent[col]) return MIN_EMPTY_COL_PX;
        const contentMax = Math.max(0, value - CELL_OVERHEAD);
        const byLines = contentMax / MAX_SACRIFICE_LINES + CELL_OVERHEAD;
        return Math.max(min[col], MIN_COL_PX, byLines);
    });
}

/**
 * 取整，并把舍入多出来的那几像素从最宽的列里扣掉。
 *
 * 多出来一两个像素的后果不是「难看一点」而是「最后一列折行」：表格总宽正好卡在
 * 可用宽度上的时候，多出来的 0.5px 就够让一个格子折成两行。所以宁可欠一点。
 *
 * @param widths - 各列宽度（px），不原地改
 * @param available - 可用宽度（px）；<= 0 表示不设上限
 * @returns 取整后的各列宽度（px）
 */
function roundWidths(widths: number[], available: number): number[] {
    const out = widths.map((w) => Math.max(1, Math.round(w)));
    if (available <= 0) return out;

    let excess = out.reduce((sum, w) => sum + w, 0) - Math.floor(available);
    if (excess <= 0) return out;
    // 从最宽的列往下扣，扣到只剩 1px 为止
    const order = out.map((_, index) => index).sort((a, b) => out[b] - out[a]);
    for (const col of order) {
        if (excess <= 0) break;
        const take = Math.min(excess, out[col] - 1);
        out[col] -= take;
        excess -= take;
    }
    return out;
}

/**
 * 把各列自然宽压进正文可用宽度。规则按优先级排：
 *
 * 1. **全放得下 → 一个都不动。** 每列都用自然宽，整张表一行到底。这是唯一的
 *    「完美」解，其余两条都是退而求其次。
 * 2. **放不下 → 牺牲尽量少的列。** 多出来的那部分，压给「让得出最多」的列：
 *    一列压到自己的下限，还不够才轮到下一列。全部压到下限还是不够，才走第 3 条。
 * 3. **实在放不下 → 每列留个底、再把超出底的那部分等比压到可用宽**（列太多、
 *    或者一列断不开的长 URL 把下限撑得老高）。这时会折得超过 MAX_SACRIFICE_LINES，
 *    但总比让表格撑出正文强。「留底」这一步是关键：按整个下限等比压的话，
 *    窄列会被压到放不下自己两个字的宽度，宽列反而还留着大把余地。
 *
 * 第 2 条为什么按「让得出多少」而不是按「谁最宽」排：一列很长的 URL，它的
 * min-content 就等于自然宽，`让得出` 几乎为 0 —— 把它折成两行省不出几个像素，
 * 不值得为它牺牲。而一列长散文让得出很多，折它最划算。所以「让得出多少」
 * 才是「牺牲谁」的正确尺度；对普通文本来说，它和「谁最长」是一致的。
 *
 * 空列（整列没内容）另算：它们排在**最前面**让位。让出来不心疼，而且量也小
 * （28 → 14px），先让完再谈牺牲哪个内容列 —— 否则十几个空列撑着表、真正的长列
 * 却在折行。
 *
 * @param natural - 各列自然宽（px，含内边距边框余量）
 * @param floor - 各列下限（px，见 floorsOf）
 * @param hasContent - 各列是不是有内容
 * @param available - 正文可用宽度（px）；<= 0 表示量不到，不做收缩
 * @returns 各列最终宽度（px）
 */
function distributeColumns(
    natural: number[],
    floor: number[],
    hasContent: boolean[],
    available: number
): number[] {
    const widths = natural.slice();
    if (available <= 0) return roundWidths(widths, 0);

    const total = natural.reduce((sum, w) => sum + w, 0);
    if (total <= available) return roundWidths(widths, 0); // ① 全员一行

    /** 还需要压掉多少像素 */
    let need = total - available;

    // ② 牺牲尽量少的列。贪心：「让得出最多」的先让，让到下限为止；
    //    轮到一列时一次吃满，所以被压过的列数就是最少的那个数
    //    （要覆盖一个目标、用的项数最少，每次取最大的那个就是最优的）
    const empty: number[] = [];
    const filled: number[] = [];
    widths.forEach((_, col) => (hasContent[col] ? filled : empty).push(col));
    filled.sort((a, b) => natural[b] - floor[b] - (natural[a] - floor[a]));

    for (const col of [...empty, ...filled]) {
        if (need <= 0) break;
        // 下限可能比自然宽还大（窄列的下限是 48px），这时候它没有可让的
        const give = Math.max(0, widths[col] - floor[col]);
        if (give <= 0) continue;
        const take = Math.min(need, give);
        widths[col] -= take;
        need -= take;
    }

    // ③ 每个能给的都给了还是放不下：等比压到可用宽。走到这里说明这张表本来就
    //    放不进正文，只能接受「折得比上限还多」
    if (need > 0) {
        // 先给每列留一份「还能用」的底：有内容 MIN_COL_PX，整列空 MIN_EMPTY_COL_PX。
        // 超出底的那部分（真正的下限开销，往往是断不开的长 URL）再等比压。
        // 不能直接拿 floor 去等比：floor 大的是那些本来就有余地的宽列，
        // 按 floor 等比压，窄列会被压到 20 几像素（「站点」两个字都放不下、
        // 还溢出），宽列却仍留着 200 多像素 —— 该让的没让，不该让的让了。
        const base = floor.map((_, col) => (hasContent[col] ? MIN_COL_PX : MIN_EMPTY_COL_PX));
        const sumBase = base.reduce((sum, w) => sum + w, 0);
        if (sumBase >= available) {
            // 极端：列多到连「底」都铺不下（正文宽 400、十列各 48）。这时只能
            // 连底一起按比例缩，保证总量不超可用宽这条底线还在
            const scale = available / sumBase;
            for (let col = 0; col < widths.length; col++) widths[col] = Math.max(1, base[col] * scale);
        } else {
            const excess = floor.map((w, col) => Math.max(0, w - base[col]));
            const sumExcess = excess.reduce((sum, w) => sum + w, 0);
            const scale = sumExcess > 0 ? (available - sumBase) / sumExcess : 0;
            for (let col = 0; col < widths.length; col++) widths[col] = base[col] + excess[col] * scale;
        }
    }

    return roundWidths(widths, available);
}


/**
 * 光标落在表格的第几列（0 起）。
 *
 * 只服务「打字时让这一列涨一点」这一件事，所以不求精确：光标停在管道线上时
 * 算右边那一格（和点格子边框的手感一致），落在分隔行上时返回 -1。
 *
 * @param block - 表格骨架
 * @param head - 光标位置
 * @returns 列号；不在数据行上时返回 -1
 */
function columnUnderCaret(block: TableBlock, head: number): number {
    for (const row of block.rows) {
        if (head < row.line.lineFrom || head > row.line.lineTo) continue;
        const cells = row.line.cells;
        if (cells.length === 0) return -1;
        for (let col = 0; col < cells.length; col++) {
            if (head <= cells[col].to) return col;
        }
        return cells.length - 1;
    }
    return -1;
}

/**
 * 用 Canvas 粗估一列的自然宽（px，含内边距边框余量）。
 *
 * 专门给「光标正在这一列里打字」用：不能走真实量尺（那是强制布局），
 * 又必须让宽度跟着内容长。Canvas 量纯文本和真实排版几乎一致（差 ≤ 0.01px），
 * 唯一偏的是 Markdown 标记符会被算进宽度（`**加粗**` 里的四个星号）——
 * **多算是安全的**：无非是这个格子宽几个像素，比折行好看。
 * 光标一离开表格就会用真实量尺重量一次，这点误差不会留下来。
 *
 * @param block - 表格骨架
 * @param state - 编辑器状态，用来读单元格源码
 * @param col - 列号
 * @returns 估算的列宽（px）
 */
function estimateColumnWidth(block: TableBlock, state: EditorState, col: number): number {
    const ctx = getMeasureContext();
    let width = CELL_OVERHEAD;
    for (const row of block.rows) {
        const cell = row.line.cells[col];
        if (!cell) continue;
        const text = state.doc.sliceString(cell.from, cell.to);
        if (!text) continue;
        // 表头那档字重是 600（见 .cm-md-table-header .cm-md-tcell），正文那档
        // 可能是用户调过的（--flowmd-font-weight），都要照实量
        const weight = row.isHeader ? '600' : (ctx?.weight ?? '400');
        const estimate = measureText(text, weight) + CELL_OVERHEAD;
        if (estimate > width) width = estimate;
    }
    return width;
}

/**
 * 算出一张表每列的宽度。
 *
 * 三条路，按顺序试：
 *
 * 1. 缓存里就是这一版表格源码 → 直接拿上次量到的自然宽重新分配（可用宽度没变
 *    的话连分配都省了），**一个格子都不用量**；
 * 2. 光标正在这张表里、源码变了 → 不重量（重量要走强制布局，边打字边重量整行都在抖），
 *    但也不能像以前那样把宽度钉死 —— 内容长了列却不涨，打着打着就折行了。
 *    折中：Canvas 粗估**光标所在那一列**，只让它涨、不让它缩，涨幅留在缓存里；
 * 3. 其余情况 → 老老实实量一遍（每列取该列所有单元格的最大值）。
 *
 * @param block - 表格骨架
 * @param state - 编辑器状态，用来读单元格源码
 * @param caretInside - 光标是否在表格里
 * @param caretHead - 光标位置（打字时用它定位「正在编辑的是哪一列」）
 * @param available - 正文可用宽度（px）；<= 0 表示量不到，不做收缩
 * @returns 每列宽度（px），长度等于列数
 */
function columnWidthsFor(
    block: TableBlock,
    state: EditorState,
    caretInside: boolean,
    caretHead: number,
    available: number
): number[] {
    const cached = columnWidthCache.get(block.from);
    const usable = cached && cached.natural.length === block.colCount ? cached : null;

    // 1. 表格源码没变：重量是白花钱，直接重新分配
    if (usable && usable.textKey === tableTextKey(state, block)) {
        if (usable.available === available) return usable.cols;
        usable.cols = distributeColumns(
            usable.natural,
            floorsOf(usable.natural, usable.min, usable.hasContent),
            usable.hasContent,
            available
        );
        usable.available = available;
        return usable.cols;
    }

    // 2. 正在这张表里打字：只涨不缩。估出来的宽度要**写回缓存里的 natural**，
    //    但故意不更新 textKey（= 不声称「这版量过了」），下次真量一遍时自然纠正回来。
    //    写回这一步是必须的：光标在一列里敲长、再挪到旁边一列接着敲时，
    //    第一列的涨幅要是没留下，重新分配就会按「没敲过字」的老宽度把第一列压回去，
    //    那一列当场折成好几行（见 tabletype 场景的最后一阶段）。
    if (usable && caretInside) {
        const col = columnUnderCaret(block, caretHead);
        if (col >= 0) {
            const estimate = estimateColumnWidth(block, state, col);
            if (estimate > usable.natural[col]) usable.natural[col] = estimate;
            // 往一个原本全空的列里打字时，「这列有内容」也得记上：否则下限还是
            // MIN_EMPTY_COL_PX（14px），光标一挪走这列就被压成一条线、字全折掉。
            if (!usable.hasContent[col]) {
                usable.hasContent[col] = block.rows.some((row) => {
                    const cell = row.line.cells[col];
                    return cell ? state.doc.sliceString(cell.from, cell.to).trim() !== '' : false;
                });
            }
        }
        // 估出来的列宽只保证「装得下这一列最长的那行」，min-content 还是老值；
        // 老值是旧内容的物理下限，只会偏松，不会把内容劈开，所以照用。
        const cols = distributeColumns(
            usable.natural,
            floorsOf(usable.natural, usable.min, usable.hasContent),
            usable.hasContent,
            available
        );
        // 分出来的结果照旧写回缓存。**别**顺手把 textKey 也更新了 —— 那等于对外声称
        // 「这一版量过了」，下一次更新就会走第 1 条路，拿着粗估的宽当实测宽用下去。
        usable.cols = cols;
        usable.available = available;
        return cols;
    }

    // 3. 真量一遍：每列取该列所有单元格的最大值，顺便记下哪些列整列都没内容
    const requests: CellMeasureRequest[] = [];
    const columns: number[] = [];
    const hasContent: boolean[] = new Array(block.colCount).fill(false);
    for (const row of block.rows) {
        row.line.cells.forEach((cell, col) => {
            if (col >= block.colCount) return;
            const text = state.doc.sliceString(cell.from, cell.to);
            if (text.trim() !== '') hasContent[col] = true;
            columns.push(col);
            requests.push({ text, header: row.isHeader });
        });
    }

    // 量不出来的格子（空格子、量尺还没进 DOM）按 0 算，加完固定开销就是「一格空盒子」
    const natural: number[] = new Array(block.colCount).fill(CELL_OVERHEAD);
    const min: number[] = new Array(block.colCount).fill(CELL_OVERHEAD);
    measureCells(requests).forEach((value, index) => {
        const col = columns[index];
        natural[col] = Math.max(natural[col], value.max + CELL_OVERHEAD);
        min[col] = Math.max(min[col], value.min + CELL_OVERHEAD);
    });

    const cols = distributeColumns(
        natural,
        floorsOf(natural, min, hasContent),
        hasContent,
        available
    );

    if (columnWidthCache.size > 200) columnWidthCache.clear();
    columnWidthCache.set(block.from, {
        textKey: tableTextKey(state, block),
        natural,
        min,
        hasContent,
        available,
        cols,
    });
    return cols;
}

/**
 * 有没有表格是**在量不到可用宽度的时候**算出来的（= 需要补一次重建）。
 *
 * 首次构建发生在 EditorState.create 阶段，那时视图还没挂进 DOM，可用宽度是 0，
 * 列宽只能按「谁都不许折行」算，表格会撑出正文列。见 plugin.ts 的 tableWidthBootstrap。
 *
 * @returns 有这种表格时返回 true
 */
export function hasUnmeasuredTables(): boolean {
    for (const entry of columnWidthCache.values()) {
        if (entry.available <= 0) return true;
    }
    return false;
}

/**
 * 复现页用的抓手：把一张表在缓存里的原始数据原样吐出来。
 *
 * 列宽不对只有两类原因：**量**错了（natural / min 不对）或者**分**错了
 * （cols 和 available 对不上）。光看渲染出来的 DOM 分不清是哪一类，
 * 所以把这两截摆到一起，复现页直接对数字。
 *
 * @param from - 表格在文档里的起点（TableBlock.from）
 * @returns 缓存里的原始数据；没缓存过这张表时返回 null
 */
export function tableWidthMetrics(
    from: number
): { natural: number[]; min: number[]; available: number; cols: number[] } | null {
    const cached = columnWidthCache.get(from);
    if (!cached) return null;
    return {
        natural: cached.natural.slice(),
        min: cached.min.slice(),
        available: cached.available,
        cols: cached.cols.slice(),
    };
}

/**
 * 监听滚动容器宽度变化、主动触发表格重新测量的插件。
 *
 * ## 为什么需要它（一条自己解不开的死循环）
 *
 * 表格列宽是按「正文可用宽度」分配的，而 `.cm-content` 的宽度反过来又由这些定宽
 * 列撑出来：当窗口 / 侧栏 / 大纲分隔条把 `.cm-scroller` 压窄时，content 宽度不变
 * → 正文不重排、文档高度不变 → CodeMirror 的 `viewportChanged` 不触发
 * → 装饰不重建（见 plugin.ts 的 needsRebuild）→ 列宽永远按旧的可用宽度钉着
 * → 表格溢出 scroller，视觉上就是表格右端被右侧大纲盖住。纯正文没有「定宽地板」，
 * content 自己会跟着 scroller 缩，所以只有表格踩这个坑。
 *
 * 插件直接观察 scrollDOM 的宽度：宽度一变就派发 tableRemeasureEffect，强制窗口装饰
 * 重算（columnWidthsFor 的缓存命中路径只重跑 distributeColumns 算术、不重新量格子，
 * 代价很小）。拖大纲分隔条、开关 VS Code 侧栏都走这条路。
 */
export const tableResizePlugin = ViewPlugin.fromClass(
    class {
        /** 上一次观察到的滚动容器宽度，用来过滤 RO 的初次回调与重复通知。 */
        private lastWidth: number;

        /** 宽度变化后的防抖定时器，合并侧栏动画 / 连续拖拽期间的密集通知。 */
        private debounceTimer = -1;

        /** ResizeObserver 断开等清理动作，destroy() 时调用一次。 */
        private cleanup: () => void = () => {};

        /**
         * @param view - 编辑器视图，scrollDOM 是被观察的目标
         */
        constructor(private view: EditorView) {
            const scroller = view.scrollDOM;
            this.lastWidth = scroller.clientWidth;
            if (typeof ResizeObserver === 'function') {
                const observer = new ResizeObserver(() => this.handleWidthChange());
                observer.observe(scroller);
                // 插件销毁时断开观察，避免视图销毁后回调还往一个死视图上 dispatch。
                this.cleanup = () => observer.disconnect();
            }
        }

        /**
         * RO 回调：宽度真的变了才排一个防抖任务去派发重新测量效果。
         */
        private handleWidthChange(): void {
            const width = this.view.scrollDOM.clientWidth;
            if (width === this.lastWidth) return;
            this.lastWidth = width;
            if (this.debounceTimer >= 0) clearTimeout(this.debounceTimer);
            // 50ms：既能把侧栏动画里的一连串变化合并，又不至于让人觉得“卡了一下”。
            this.debounceTimer = window.setTimeout(() => {
                this.debounceTimer = -1;
                // 视图可能在等待期间已经销毁，dispatch 前确认它还挂在 DOM 上。
                if (this.view.dom.isConnected) {
                    this.view.dispatch({ effects: tableRemeasureEffect.of(null) });
                }
            }, 50);
        }

        /**
         * 插件销毁：取消等待中的任务并断开观察。
         */
        destroy(): void {
            if (this.debounceTimer >= 0) clearTimeout(this.debounceTimer);
            this.cleanup();
        }
    }
);

/**
 * 正文可用宽度（px）：表格最多能占多宽 —— 也就是**正文文字的左右边界之间**有多宽。
 *
 * 三段减法：
 *
 * 1. 从**滚动容器**（`.cm-scroller`）的 clientWidth 出发。不能取 `.cm-content`
 *    的宽度 —— 那是**能变**的：`.cm-content` 是 `.cm-scroller`（display:flex）里
 *    的 flex item，还带着 `flex-shrink: 0`，里面的东西撑宽了它，它自己就跟着变宽。
 *    而它的宽度又正好由表格的列宽决定（格子的行内宽度就是列宽），于是形成正反馈：
 *    表格溢出一次 → `.cm-content` 变宽 → 下次量到的「可用宽度」更大 → 表格更宽。
 *    实测过：编辑器明明只有 900px，表格算出来 1288px，而且再也收不回来。
 * 2. 扣掉**行号栏**。它在 scroller 里占的是实打实的位置，正文是从它右边才开始的。
 * 3. 扣掉正文自己的左右内边距，再受 `.cm-content` 的 max-width 约束
 *    （`flowMd.readableLineLength`，见 webviewContent.ts）—— 正文自己就被它封顶，
 *    表格当然也不能比正文宽。
 *
 * 拿不到就返回 0，调用方跳过收缩。
 *
 * 差几像素不用管：表格行自己还带着一点不在列宽里的开销（首尾管道线压 0 宽后
 * 剩下的那几像素），所以行的外框会比所有列宽之和宽 3~6px。这是表格自己的框，
 * 不是列分配算错的，为了它再去量一次行开销（又是一次强制布局）不值。
 *
 * @returns 正文文字区的宽度（px）
 */
export function availableTableWidth(): number {
    return availableWidth();
}

/**
 * 正文可用宽度（px）的实现。
 *
 * @returns 正文文字区宽度；视图还没挂进 DOM（量不到）时返回 0
 */
function availableWidth(): number {
    const scroller = document.querySelector('#editor .cm-scroller');
    const content = document.querySelector('#editor .cm-content');
    if (!scroller || !content) return 0;
    const cs = getComputedStyle(content);

    // 行号栏的宽度（关掉行号时它不在，按 0 算）
    const gutters = document.querySelector('#editor .cm-gutters');
    const gutterWidth = gutters instanceof HTMLElement ? gutters.offsetWidth : 0;

    // 正文这一格最多能有多宽：scroller 剩下的地方，再受正文自己的宽度上限约束。
    // 上限只认 px —— 关掉「限制行宽」时 webview 写的是 `max-width: 100%`
    // （见 editor.ts 的 readableLineLength === 0 分支），百分比解析成数字会得到
    // 100 这种荒谬的值（表格全被压成 100px 宽），那种情况按「不限制」处理。
    const room = (scroller as HTMLElement).clientWidth - gutterWidth;
    const maxWidthPx = cs.maxWidth.endsWith('px') ? Number.parseFloat(cs.maxWidth) : NaN;
    const boxWidth =
        Number.isFinite(maxWidthPx) && maxWidthPx > 0 ? Math.min(maxWidthPx, room) : room;

    // max-width 管的是**边框盒**（CodeMirror 给 .cm-content 设了 border-box），
    // 内边距也算在里面，所以文字区宽度要把内边距减掉
    const inner =
        boxWidth -
        (Number.parseFloat(cs.paddingLeft) || 0) -
        (Number.parseFloat(cs.paddingRight) || 0);
    return inner > 0 ? inner : 0;
}

// =============================================================================
// 装饰
// =============================================================================

/**
 * 某个格子是不是被选区**完整盖住**了（用来决定要不要给格子加高亮类）。
 *
 * 判据是「完全包含」而不是「有交集」：拖到一半时选区边界落在一格中间，
 * 这时候用户想选的是那几个字，不是这一整格 —— 整格变色会让选区边界看起来
 * 「跳」到了格子边缘。只有把整格内容都选进去（`selection.from <= 格子头` 且
 * `格子尾 <= selection.to`），才认定用户要的是这一整格。
 *
 * @param selection - 选区范围
 * @param cell - 格子区间
 * @returns 选区盖住整格时返回 true
 */
function coversCell(
    selection: { from: number; to: number },
    cell: { from: number; to: number }
): boolean {
    return selection.from <= cell.from && cell.to <= selection.to;
}

/**
 * 收集表格的骨架装饰：格子、被压掉的管道线、折叠的分隔行、被框选的格子。
 *
 * 和列表缩进引导线一样，这个函数**不看聚焦范围**：表格的格子外形必须一直成立，
 * 否则光标一进表格，整张表就散成源码了。格子里的行内样式（加粗、行内代码…）
 * 仍然由主遍历按「聚焦块里也照常渲染行内元素」的规则处理。
 *
 * @param state - 编辑器状态
 * @param decos - 待写入的装饰数组
 * @param tree - 语法树
 * @returns void，结果直接 push 进 decos
 */
export function collectTableDecorations(
    state: EditorState,
    decos: Array<ReturnType<Decoration['range']>>,
    tree: Tree,
    range: { from: number; to: number }
): void {
    const caretLine = state.doc.lineAt(state.selection.main.head).number;
    // 可用宽度一次算好传下去：每张表都去 querySelector + getComputedStyle 太浪费
    const available = availableWidth();
    // 框选到的格子要单独上高亮（见下面的 cellClassAt）。整段选区一个都算不到时
    // 连交集都不用查，把 null 传下去当「没在选」。
    const selection = state.selection.main.empty ? null : state.selection.main;

    // 正常的表格 + 「被误判成标题/段落、其实是表格」的兜底块。
    // 只处理**和当前渲染窗口有交集**的表格（表格本身照旧整张画完，不然会出现半张表格）；
    // 不在窗口里的表格连量宽度都省了，等滚回去时缓存还在。
    const visible = [...findTables(state, tree, range), ...findTextTables(state, tree, range)].filter(
        (block) => block.from <= range.to && range.from <= block.to
    );
    for (const block of visible) {
        // 双击进过源码模式的表格：整块按源码显示（管道线、对齐说明都露出来），不画格子
        if (isInSourceMode(block.from, block.to)) continue;
        const firstLine = state.doc.lineAt(block.from).number;
        const lastLine = state.doc.lineAt(block.to).number;
        const caretInside = caretLine >= firstLine && caretLine <= lastLine;
        const widths = columnWidthsFor(
            block,
            state,
            caretInside,
            state.selection.main.head,
            available
        );

        // 数据行序号：只统计非表头行，用于决定偶数行是否加斑马纹 class
        let dataRowOrdinal = 0;
        for (const row of block.rows) {
            const { line, isHeader } = row;
            // 整行就是一个 flex 容器：格子是它的 flex item，一行里所有格子高度自动拉平。
            // 表格总宽由表格自己的行内宽度（列宽之和）决定，这里不用再写样式。

            // 组装行 class：表头 / 普通行，偶数数据行额外加 stripe（斑马纹）
            let rowClass = isHeader ? `${ROW_CLASS} ${HEADER_CLASS}` : ROW_CLASS;
            if (!isHeader) {
                dataRowOrdinal++;
                if (dataRowOrdinal % 2 === 0) rowClass += ` ${STRIPE_CLASS}`;
            }
            decos.push(
                Decoration.line({
                    class: rowClass,
                }).range(line.lineFrom)
            );

            // 管道线和它两侧的空白一起压成 0 宽：格子之间不留缝，间距交给单元格内边距
            let cursor = line.lineFrom;
            for (const cell of line.cells) {
                if (cell.from > cursor) {
                    decos.push(Decoration.mark({ class: GAP_CLASS }).range(cursor, cell.from));
                }
                cursor = cell.to;
            }
            if (cursor < line.lineTo) {
                decos.push(Decoration.mark({ class: GAP_CLASS }).range(cursor, line.lineTo));
            }

            // 单元格：定宽 + 对齐，宽度和列对得上，全表的格子就排成网格。
            // 空格子（零长区间）没法用 mark 加样式，改用一个空盒子 widget 占位 ——
            // 空行、空列也要看得见格子，否则整行整列会凭空消失。
            line.cells.forEach((cell, col) => {
                const width = widths[col] ?? widths[widths.length - 1] ?? MIN_COL_PX;
                const align = block.alignments[col] ?? null;
                const style = align ? `width:${width}px; text-align:${align}` : `width:${width}px`;
                // 被选区**完整盖住**的格子多一个类名：整格上高亮，而不是只把文字涂蓝。
                // 只盖住一半的格子不加 —— 那时用户选的是格子里的几个字（见 coversCell）
                const cls = selection && coversCell(selection, cell)
                    ? `${CELL_CLASS} ${CELL_SELECTED_CLASS}`
                    : CELL_CLASS;
                if (cell.from >= cell.to) {
                    decos.push(
                        Decoration.widget({
                            widget: new EmptyCellWidget(width, style, cls),
                            side: 1,
                        }).range(cell.from)
                    );
                    return;
                }
                decos.push(
                    Decoration.mark({ class: cls, attributes: { style } }).range(cell.from, cell.to)
                );
            });

            // 行里格子比列数少：在行尾补几个空格子，网格的右边框才不会缺一块
            if (line.cells.length < block.colCount) {
                for (let col = line.cells.length; col < block.colCount; col++) {
                    const width = widths[col] ?? MIN_COL_PX;
                    const align = block.alignments[col] ?? null;
                    const style = align
                        ? `width:${width}px; text-align:${align}`
                        : `width:${width}px`;
                    decos.push(
                        Decoration.widget({
                            widget: new EmptyCellWidget(width, style, CELL_CLASS),
                            side: 1,
                        }).range(line.lineTo)
                    );
                }
            }
        }

        // 分隔行：平时整行折叠（高度 0），光标停在这一行时摊开，方便改对齐方式
        if (block.delimiter && state.doc.lineAt(block.delimiter.lineFrom).number !== caretLine) {
            decos.push(
                Decoration.line({ class: DELIMITER_CLASS }).range(block.delimiter.lineFrom)
            );
            if (block.delimiter.lineTo > block.delimiter.lineFrom) {
                decos.push(
                    Decoration.mark({ class: GAP_CLASS }).range(
                        block.delimiter.lineFrom,
                        block.delimiter.lineTo
                    )
                );
            }
        }

        // 兜底表格后面那条分隔线：按水平线画（和正文里的 `---` 一样）
        if (block.underline) {
            decos.push(
                Decoration.replace({
                    widget: new HorizontalRuleWidget(),
                }).range(block.underline.from, block.underline.to)
            );
        }

    }
}

// =============================================================================
// 小 widget
// =============================================================================

/**
 * 空格子占位。
 *
 * 两种场合都要它：格子里本来就没写字（`|  |`），或者这一行比别的行少写了几格。
 * 没有它的话空行会变成一条没有格子的空白、空列会整列消失。
 */
class EmptyCellWidget extends WidgetType {
    /**
     * @param width - 这一列的宽度（px）
     * @param style - 和对齐方式一起拼好的行内样式
     * @param className - 类名（被框选时比普通格子多一个高亮类）
     */
    constructor(
        private width: number,
        private style: string,
        private className: string
    ) {
        super();
    }

    eq(other: EmptyCellWidget): boolean {
        return (
            this.width === other.width &&
            this.style === other.style &&
            this.className === other.className
        );
    }

    toDOM(): HTMLElement {
        const span = document.createElement('span');
        span.className = this.className;
        span.style.cssText = this.style;
        return span;
    }
}

// =============================================================================
// 定位表格 / 改文档
// =============================================================================

/**
 * 判断某个位置是不是落在表格单元格里。
 *
 * 给别的装饰用：单元格的「格子」是 mark 包出来的盒子，里面如果整段都是
 * `Decoration.replace`（比如一张图片），CodeMirror 会连盒子一起丢掉，
 * 所以这类内容在单元格里要跳过渲染，保持源码原样。
 *
 * @param tree - 语法树
 * @param pos - 文档位置
 * @returns 在某个 TableCell 里时返回 true
 */
export function isInTableCell(tree: Tree, pos: number): boolean {
    let node: SyntaxNode | null = tree.resolveInner(pos, 0);
    while (node) {
        if (node.name === 'TableCell') return true;
        if (node.name === 'Document' || node.name === 'Table') return false;
        node = node.parent;
    }
    return false;
}

/**
 * 从某个位置往上找，看它在哪张表里。
 *
 * @param state - 编辑器状态
 * @param pos - 文档位置
 * @returns Table 语法节点；不在表格里时返回 null
 */
export function findTableAt(state: EditorState, pos: number): SyntaxNode | null {
    // side = -1：双击的位置可能正好落在 Table 节点和后面内容的交界上，
    // 默认的 side=0 会往「后面那个节点」上靠，一上去就不是表格了
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    while (node) {
        if (node.name === 'Table') return node;
        if (node.name === 'Document') return null;
        node = node.parent;
    }
    return null;
}

/**
 * 双击表格 → 整张表切成源码模式（管道线、分隔行的对齐说明都露出来）。
 *
 * 表格本身是「半渲染」的（管道线藏起来、但源码就在文档里），要动结构（手写管道线、
 * 改对齐）时看源码更直接，所以留了这一手，行为和以前那个 widget 版本一样：
 * 光标点到表格外面就自动退出（见 state.ts 的 exitSourceModeIfOutside）。
 *
 * 增删行列走右键菜单（tableCommands.ts），不再靠双击。
 *
 * @returns CodeMirror 的 domEventHandlers 扩展（接进 createLivePreviewExtension）
 */
export function tableSourceModeHandler() {
    return EditorView.domEventHandlers({
        dblclick(event: MouseEvent, view: EditorView) {
            if (!view.state.facet(EditorView.editable)) return false;
            if (event.ctrlKey || event.metaKey || event.altKey) return false;
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos === null) return false;
            const table = findTableAt(view.state, pos);
            if (!table) return false;
            // 光标要在表格里，否则下面那句「光标离开就退出」会立刻把它收回去
            const selection = view.state.selection.main;
            const caretInside = selection.from >= table.from && selection.to <= table.to;
            view.dispatch({
                ...(caretInside ? {} : { selection: { anchor: table.from } }),
                effects: sourceModeEffect.of({ from: table.from, to: table.to }),
            });
            return true;
        },
    });
}

/**
 * 表格单元格里输入 `|` 时自动转义成 `\|`。
 *
 * 管道线是表格的分隔符，在单元格里直接敲一个会把这一行切成两格、整张表跟着变形。
 * 原来的 widget 方案是在写回文档时转义，现在没有写回了，就在输入这一层拦一下。
 *
 * @returns CodeMirror 的 inputHandler 扩展（接进 createLivePreviewExtension）
 */
export function tablePipeEscaper() {
    return EditorView.inputHandler.of((view, from, to, text) => {
        // 只处理单个 `|`；粘贴整段文本不拦（那是用户自己的选择）
        if (text !== '|') return false;
        let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(from, 0);
        while (node && node.name !== 'TableCell') {
            if (node.name === 'Document') return false;
            node = node.parent;
        }
        view.dispatch({
            changes: { from, to, insert: '\\|' },
            selection: { anchor: from + 2 },
        });
        return true;
    });
}

// =============================================================================
// 框选单元格
// =============================================================================
//
// 表格里的文字和管道线都在文档里，所以要是不管，在格子上拖鼠标得到的就是
// 「从某格中间到某格中间」的一段文字选区。
//
// 这里借 CodeMirror 的 mouseSelectionStyle 换掉「拖拽怎么算选区」这段逻辑。
// **注意：这里已经不吸附了** —— 早期版本会把选区两端吸到格子边界，结果在格子里
// 稍微滑一下鼠标，整格就被选中，想选其中几个字根本做不到。
// 现在的规则是：拖拽 = 老老实实的文本选区，选到哪就是哪；
// 「整格选中」是**渲染层**的事（格子被完整盖住才上高亮，见 coversCell）。
// 单击仍然是正常放光标（不然就没法点进去改字了），双击的选词更是原生行为。

/** 拖动多少像素才算「真的在拖」，而不是手抖。 */
const DRAG_THRESHOLD_PX = 4;

/**
 * 位置 → 所在格子的区间（绝对文档位置）。
 *
 * **按文本切管道线**，不查语法树：lezer 会把空格子整段跳过，
 * 拿它数格子的话空列会对不上号。
 *
 * 落在格子和格子之间（管道线、两侧空白）时取最近的一格 —— 点在格子的左边框上，
 * 用户心里的目标就是右边这一格。
 *
 * @param state - 编辑器状态
 * @param pos - 文档位置
 * @returns 格子区间；不在表格里（或落在分隔行上）时返回 null
 */
export function cellAt(state: EditorState, pos: number): { from: number; to: number } | null {
    const block = tableBlockAt(state, pos);
    if (!block) return null;
    // 分隔行是折叠的（高度 0），点不到它，也不该被当成格子
    if (block.delimiter && pos >= block.delimiter.lineFrom && pos <= block.delimiter.lineTo) {
        return null;
    }
    const line = state.doc.lineAt(pos);
    const cells = splitRowText(line.text).map((seg) => ({
        from: line.from + seg.from,
        to: line.from + seg.to,
    }));
    if (cells.length === 0) return null;

    for (const cell of cells) {
        if (pos >= cell.from && pos <= cell.to) return cell;
    }
    // 掉在缝隙里：pos 前面那一格和后面那一格，取边界更近的一个
    for (let i = 0; i < cells.length; i++) {
        if (pos < cells[i].from) {
            const prev = cells[i - 1];
            if (!prev) return cells[0];
            return pos - prev.to <= cells[i].from - pos ? prev : cells[i];
        }
    }
    return cells[cells.length - 1];
}

/**
 * 找出包含某个位置的表格骨架（含「其实是表格的标题 / 段落」那种兜底块）。
 *
 * @param state - 编辑器状态
 * @param pos - 文档位置
 * @returns 表格骨架；不在表格里时返回 null
 */
export function tableBlockAt(state: EditorState, pos: number): TableBlock | null {
    const tree = ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
    const whole = { from: 0, to: state.doc.length };
    for (const block of [...findTables(state, tree, whole), ...findTextTables(state, tree, whole)]) {
        if (pos >= block.from && pos <= block.to) return block;
    }
    return null;
}

/**
 * 表格里的一次拖拽。
 *
 * 实现要点全在 `get()` 里：它是 CodeMirror 在按下、拖动、松开时都会调的那一个函数，
 * 拿到的永远是当前鼠标事件。
 */
class CellSelectionStyle implements MouseSelectionStyle {
    /** 按下时落点的文档位置（没拖动时用它放光标）。 */
    private readonly startPos: number;

    /**
     * @param view - 编辑器视图
     * @param startEvent - 触发这次拖拽的 mousedown 事件
     * @param pos - 按下位置对应的文档位置
     */
    constructor(
        private view: EditorView,
        private startEvent: MouseEvent,
        pos: number
    ) {
        this.startPos = pos;
    }

    /**
     * 拖动过程中鼠标划出文档 / 划出表格，不需要额外重算，直接返回 false。
     *
     * @returns 恒为 false
     */
    update(): boolean {
        return false;
    }

    /**
     * 算出这一瞬间该有哪些内容被选中：**就是按下点到当前点的原始文本区间**。
     *
     * 这里刻意不做任何吸附 —— 吸附会让「稍微滑一下」变成「整格选中」。
     * 拖动过程中鼠标划到哪里，选区就是哪一段文字，跟表格外面的拖拽手感完全一致。
     *
     * @param event - 当前鼠标事件
     * @param extend - 是否按住 Shift（沿用已有选区的一端）
     * @param multiple - 是否按住 Ctrl / Cmd（多选区，这里不支持，忽略）
     * @returns 选区
     */
    get(event: MouseEvent, extend: boolean): EditorSelection {
        const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY });

        // 没拖动就按普通单击处理：光标落在按下点上，双击/三击留给原生逻辑。
        // 必须用 startPos 而不是 pos：posAtCoords 是按字符盒取的，点击落在字符
        // 左半/右半会取到不同的位置，直接用会让光标偏移一个字符。
        if (!this.hasMoved(event) && !extend) {
            return EditorSelection.single(this.startPos);
        }
        // 划出编辑器（posAtCoords 取不到）时保持光标不动，别抛异常
        if (pos === null) return EditorSelection.single(this.startPos);

        // Shift 拖：起点沿用已有选区的锚点，才能「接着上次的地方继续选」
        const anchorPos = extend ? this.view.state.selection.main.anchor : this.startPos;
        // 单参数版本会自动把 anchor / head 归一化成 from <= to，不用自己比大小
        return EditorSelection.single(anchorPos, pos);
    }

    /**
     * 鼠标从按下位置挪开够远了吗。
     *
     * @param event - 当前鼠标事件
     * @returns 超过阈值时返回 true
     */
    private hasMoved(event: MouseEvent): boolean {
        const dx = Math.abs(event.clientX - this.startEvent.clientX);
        const dy = Math.abs(event.clientY - this.startEvent.clientY);
        return Math.max(dx, dy) > DRAG_THRESHOLD_PX;
    }
}

/**
 * 单元格框选扩展（接进 createLivePreviewExtension）。
 *
 * 只在「按下的位置落在某个格子里」时接管，表格之外一律返回 null，
 * 让 CodeMirror 用回它自己那套文本选区逻辑。
 *
 * @returns CodeMirror 的 mouseSelectionStyle 扩展
 */
export function tableCellSelection() {
    return EditorView.mouseSelectionStyle.of((view, event) => {
        // 只读模式（Viewer）不接管；Alt 留给矩形选择，右键交给右键菜单
        if (!view.state.facet(EditorView.editable)) return null;
        if (event.button !== 0 || event.altKey) return null;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return null;
        // 用 cellAt 判「是不是在格子上」：不在表格里就整个让给 CodeMirror 原生逻辑
        const cell = cellAt(view.state, pos);
        if (!cell) return null;
        return new CellSelectionStyle(view, event, pos);
    });
}
