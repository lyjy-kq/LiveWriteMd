/**
 * 表格（从 tableRender.ts 拆出）：列宽分配算法：columnWidthCache / distributeColumns / columnWidthsFor。
 *
 * @module webview/codemirror/extensions/livePreview/tableColumns
 */

import { tableCompositionHandler } from './tableLocate.js';
import { CellMeasureRequest, measureCells } from './tableMeasure.js';
import { CELL_OVERHEAD, MAX_SACRIFICE_LINES, MIN_COL_PX, MIN_EMPTY_COL_PX, TableBlock } from './tableTypes.js';
import { getMeasureContext, measureText } from '../measure/textMeasure.js';
import type { EditorState } from '@codemirror/state';

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
export const columnWidthCache = new Map<
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
export function floorsOf(natural: number[], min: number[], hasContent: boolean[]): number[] {
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
export function distributeColumns(
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
        // 可能是用户调过的（--livewritemd-font-weight），都要照实量
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
 * @param composing - 是否处于输入法组合（composition）中；组合期间列宽冻结
 * @param caretHead - 光标位置（打字时用它定位「正在编辑的是哪一列」）
 * @param available - 正文可用宽度（px）；<= 0 表示量不到，不做收缩
 * @returns 每列宽度（px），长度等于列数
 */
export function columnWidthsFor(
    block: TableBlock,
    state: EditorState,
    caretInside: boolean,
    composing: boolean,
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
        // 输入法组合中（中文拼音尚未选字）：拼音只是临时内容，列宽**冻结** ——
        // 直接返回上次的列宽，不估不涨。否则每个拼音字母都涨一次列宽，
        // 整行会跟着「ceshineirong」的长度反复跳变。最终宽度等 compositionend
        // 后补一次重估（见 tableCompositionHandler）。
        if (composing) return usable.cols;

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
