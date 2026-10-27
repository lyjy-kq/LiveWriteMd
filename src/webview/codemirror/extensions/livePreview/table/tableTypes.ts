/**
 * 表格（从 tableRender.ts 拆出）：表格常量与类型：列宽常量 / CSS 类名 / TableLine / TableBlock。
 *
 * @module webview/codemirror/extensions/livePreview/tableTypes
 */

import { floorsOf } from './tableColumns.js';

/** 单元格左右内边距（px）。 */
const CELL_PAD_X = 10;

/** 单元格边框宽度（px）。列宽是 border-box，算宽度时要把边框也算进去。 */
const CELL_BORDER_PX = 1;

/** 一列的最小宽度（px），防止有内容的列被压成一条线。 */
export const MIN_COL_PX = 48;

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
export const MIN_EMPTY_COL_PX = 14;

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
export const CELL_OVERHEAD = CELL_PAD_X * 2 + CELL_BORDER_PX * 2 + COL_WIDTH_SLACK;

/**
 * 被牺牲的列最多折几行 —— 「牺牲少数列」里的「牺牲」到什么程度。
 *
 * 一列自然宽 300px，它的下限就是 100px（折三行）。压到 100px 还不够，就轮到
 * 下一列去折：**宁可两列各折一点，也不让一列折成一条线**。这个数调小＝更倾向
 * 保住少数列、让它们折得更狠；调到 1 就等于「谁都不许折」，表格会直接走溢出那条路。
 */
export const MAX_SACRIFICE_LINES = 3;

/** 单元格 / 缝隙 / 行 / 分隔行的类名。 */
export const CELL_CLASS = 'cm-md-tcell';

/** 被框选到的格子。整格上高亮，和只涂文字的原生选区区分开。 */
export const CELL_SELECTED_CLASS = 'cm-md-tcell-selected';

/**
 * 每行**最后一列**的格子（含行尾补出来的空格子）。
 *
 * 悬停加列按钮（tableHoverControls）只在这一列上生效：鼠标靠近它的
 * 右边框时显示「+」，点一下在表格右侧加一列。
 */
export const CELL_LAST_CLASS = 'cm-md-tcell-end';

/**
 * 每行**第一列**的格子。
 *
 * 所有格子都用 marginLeft:-1px 把相邻边框叠成一条；第一格也左移 1px 后，
 * 左边框就落到行盒外面，表格看起来没有左边。给第一格单独去掉负边距
 * （用类名而不是 :first-child —— 格子里前面还有压 0 宽的管道线 span）。
 */
export const CELL_FIRST_CLASS = 'cm-md-tcell-start';

export const GAP_CLASS = 'cm-md-tgap';

export const ROW_CLASS = 'cm-md-table-row';

/**
 * 表格的最后一个数据行。悬停它的下边框时显示「+」，点击在下方加一行。
 * （分隔行是折叠的，不算视觉上的行。）
 */
export const ROW_LAST_CLASS = 'cm-md-table-last-row';

export const HEADER_CLASS = 'cm-md-table-header';

/** 偶数数据行：配合 --livewritemd-table-stripe-background 画斑马纹。 */
export const STRIPE_CLASS = 'cm-md-table-stripe';

/** 分隔行（`|---|---|`）：折叠显示，但仍是表格的一部分（边界遍历要跨过它）。 */
export const DELIMITER_CLASS = 'cm-md-table-delimiter';

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
