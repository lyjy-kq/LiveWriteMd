/**
 * 表格（从 tableRender.ts 拆出）：表格装饰：collectTableDecorations 把表格画成格子 + EmptyCellWidget。
 *
 * @module webview/codemirror/extensions/livePreview/tableDecorations
 */

import { columnWidthsFor } from './tableColumns.js';
import { CELL_CLASS, CELL_FIRST_CLASS, CELL_LAST_CLASS, CELL_SELECTED_CLASS, DELIMITER_CLASS, GAP_CLASS, HEADER_CLASS, MIN_COL_PX, ROW_CLASS, ROW_LAST_CLASS, STRIPE_CLASS } from './tableTypes.js';
import { availableWidth } from './tableWiring.js';
import { HorizontalRuleWidget } from './simpleWidgets.js';
import { isInSourceMode } from './state.js';
import type { EditorState } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { Tree } from '@lezer/common';

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
export function coversCell(
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
 * @param range - 本次渲染窗口范围
 * @param composing - 是否处于输入法组合中（组合期间列宽冻结）
 * @returns void，结果直接 push 进 decos
 */
export function collectTableDecorations(
    state: EditorState,
    decos: Array<ReturnType<Decoration['range']>>,
    tree: Tree,
    range: { from: number; to: number },
    composing: boolean,
    view?: EditorView
): void {
    const caretLine = state.doc.lineAt(state.selection.main.head).number;
    // 可用宽度一次算好传下去：每张表都去 querySelector + getComputedStyle 太浪费。
    // 导图节点的 mini-CM 靠 view 走节点盒 max-width 那条路（见 availableWidth）。
    const available = availableWidth(view);
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
        if (isInSourceMode(state, block.from, block.to)) continue;
        const firstLine = state.doc.lineAt(block.from).number;
        const lastLine = state.doc.lineAt(block.to).number;
        const caretInside = caretLine >= firstLine && caretLine <= lastLine;
        const widths = columnWidthsFor(
            block,
            state,
            caretInside,
            composing,
            state.selection.main.head,
            available
        );

        // 数据行序号：只统计非表头行，用于决定偶数行是否加斑马纹 class
        let dataRowOrdinal = 0;
        // 行序号：用来认「最后一行」（悬停加行按钮只在这一行生效）
        let rowOrdinal = 0;
        for (const row of block.rows) {
            const { line, isHeader } = row;
            const isLastRow = rowOrdinal === block.rows.length - 1;
            rowOrdinal++;
            // 整行就是一个 flex 容器：格子是它的 flex item，一行里所有格子高度自动拉平。
            // 表格总宽由表格自己的行内宽度（列宽之和）决定，这里不用再写样式。

            // 组装行 class：表头 / 普通行，偶数数据行额外加 stripe（斑马纹）
            let rowClass = isHeader ? `${ROW_CLASS} ${HEADER_CLASS}` : ROW_CLASS;
            if (!isHeader) {
                dataRowOrdinal++;
                if (dataRowOrdinal % 2 === 0) rowClass += ` ${STRIPE_CLASS}`;
            }
            if (isLastRow) rowClass += ` ${ROW_LAST_CLASS}`;
            decos.push(
                Decoration.line({
                    class: rowClass,
                }).range(line.lineFrom)
            );

            // 单元格装饰 + 缝隙压 0 宽，按 DOM 顺序交错产出。
            //
            // ## 「借」一个空格进 tcell 盒子
            //
            // cell 内容（trim 后）后面通常紧跟一个空格（标准写法 `| a | b |`）。
            // tcell 的 mark 把**这个空格也一起包住**（range 多 1 字符），于是：
            //
            // - 光标停在内容末尾（cell.to）时，DOM 位置在 mark **内部**
            //   （mark 一直覆盖到空格之后），正常字号、光标竖线可见；
            // - 中文 composition 也在 mark 内部发生，拼音节点被盒子包住，
            //   输入期间格子边框不消失；
            // - 空格不增加任何布局：tcell 是定宽 flex item，行尾空白在盒子内部
            //   被换行规则吸收。
            //
            // 没有空格可借的紧凑写法（`|a|b|`）退回老行为，不影响其它格子。
            let cursor = line.lineFrom;
            line.cells.forEach((cell, col) => {
                // 当前格子之前的部分（管道线与两侧空白）压成 0 宽
                if (cell.from > cursor) {
                    decos.push(Decoration.mark({ class: GAP_CLASS }).range(cursor, cell.from));
                }

                const width = widths[col] ?? widths[widths.length - 1] ?? MIN_COL_PX;
                const align = block.alignments[col] ?? null;
                const style = align ? `width:${width}px; text-align:${align}` : `width:${width}px`;
                // 被选区**完整盖住**的格子多一个类名：整格上高亮，而不是只把文字涂蓝。
                // 只盖住一半的格子不加 —— 那时用户选的是格子里的几个字（见 coversCell）
                // 最后一列（含行尾补齐的空格子）再带一个 end 类名，
                // 供「悬停右边框加列」定位。
                const isLastCol = col === block.colCount - 1;
                const cls =
                    `${CELL_CLASS}` +
                    (selection && coversCell(selection, cell) ? ` ${CELL_SELECTED_CLASS}` : '') +
                    (col === 0 ? ` ${CELL_FIRST_CLASS}` : '') +
                    (isLastCol ? ` ${CELL_LAST_CLASS}` : '');

                // cell.to 处是不是可以「借」的空白字符（空格/Tab，且不是行尾）
                const canBorrow =
                    cell.to < line.lineTo && /[ \t]/.test(state.doc.sliceString(cell.to, cell.to + 1));
                const markEnd = canBorrow ? cell.to + 1 : cell.to;

                if (cell.from < cell.to || canBorrow) {
                    // 非空格子：mark 包住内容（+借来的空格）；
                    // 空格子：mark 只包住借来的那一个空格，盒子照样成立 ——
                    // 不再需要空盒子 widget（widget 不可编辑，光标进不去、
                    // composition 时边框会消失）
                    decos.push(
                        Decoration.mark({ class: cls, attributes: { style } }).range(cell.from, markEnd)
                    );
                } else {
                    // 极端兜底：紧凑到连一个空白字符都没有（`||`），
                    // 只能放一个不可编辑的占位盒子
                    decos.push(
                        Decoration.widget({
                            widget: new EmptyCellWidget(width, style, cls),
                            side: 1,
                        }).range(cell.from)
                    );
                }
                cursor = markEnd;
            });
            if (cursor < line.lineTo) {
                decos.push(Decoration.mark({ class: GAP_CLASS }).range(cursor, line.lineTo));
            }

            // 行里格子比列数少：在行尾补几个空格子，网格的右边框才不会缺一块
            if (line.cells.length < block.colCount) {
                for (let col = line.cells.length; col < block.colCount; col++) {
                    const width = widths[col] ?? MIN_COL_PX;
                    const align = block.alignments[col] ?? null;
                    const style = align
                        ? `width:${width}px; text-align:${align}`
                        : `width:${width}px`;
                    // 补齐的空格子也要带「第一列 / 最后一列」标记：
                    // 整行没有格子时第一格才是左边框的落点
                    const padCls =
                        `${CELL_CLASS}` +
                        (col === 0 ? ` ${CELL_FIRST_CLASS}` : '') +
                        (col === block.colCount - 1 ? ` ${CELL_LAST_CLASS}` : '');
                    decos.push(
                        Decoration.widget({
                            widget: new EmptyCellWidget(width, style, padCls),
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
 * 空格子占位（**仅极端兜底**）。
 *
 * 正常的空格子（`|  |`）由 mark 包住「借来的空格」撑出盒子：光标可进、
 * 输入法 composition 时边框也不消失。只有紧凑到连一个空白字符都没有的写法
 * （`||`）才退回这个不可编辑的占位盒子；行尾补齐格子同样用它。
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
