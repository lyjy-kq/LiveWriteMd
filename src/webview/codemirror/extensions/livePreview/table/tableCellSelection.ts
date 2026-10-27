/**
 * 表格（从 tableRender.ts 拆出）：框选单元格：cellAt / tableBlockAt / CellSelectionStyle / tableCellSelection。
 *
 * @module webview/codemirror/extensions/livePreview/tableCellSelection
 */

import { coversCell } from './tableDecorations.js';
import { splitRowText } from './tableDetect.js';
import { TableBlock } from './tableTypes.js';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorSelection } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { MouseSelectionStyle } from '@codemirror/view';
import { findTables } from './tableRead.js';
import { findTextTables } from './tableDetect.js';

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
 * 构造一个「单光标」的 EditorSelection，并带上光标关联方向（assoc）。
 *
 * state 6.6+ 起 `EditorSelection.cursor()` 返回的是单个 **SelectionRange**
 * （没有 `.ranges`），不能直接当 EditorSelection 用（dispatch 的 selection、
 * MouseSelectionStyle.get 的返回都要 EditorSelection），这里统一包一层。
 *
 * @param pos - 光标位置
 * @param assoc - 关联方向：-1 偏左 / 1 偏右 / 0 不指定
 * @returns 只含一个光标的 EditorSelection
 */
function cursorSelection(pos: number, assoc: number): EditorSelection {
    return EditorSelection.create([EditorSelection.cursor(pos, assoc)]);
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
     * 光标在边界位置上的**关联方向**（assoc）：1 = 偏向位置右侧。
     *
     * 空 cell 的修正位置左边是 0 宽缝隙、右边才是 tcell 盒子内部，
     * 不显式向右关联，浏览器可能把光标画到缝隙里（竖线消失）。
     */
    private readonly startAssoc: number;

    /**
     * @param view - 编辑器视图
     * @param startEvent - 触发这次拖拽的 mousedown 事件
     * @param pos - 按下位置对应的文档位置（已做格子内修正）
     * @param assoc - 光标关联方向，见 startAssoc
     */
    constructor(
        private view: EditorView,
        private startEvent: MouseEvent,
        pos: number,
        assoc: number
    ) {
        this.startPos = pos;
        this.startAssoc = assoc;
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
            // 单击：光标落到目标位置。cursor() 只产出单个 SelectionRange，
            // 必须用 create([...]) 包成 EditorSelection（get 的返回类型要求）
            return cursorSelection(this.startPos, this.startAssoc);
        }
        // 划出编辑器（posAtCoords 取不到）时保持光标不动，别抛异常
        if (pos === null) return cursorSelection(this.startPos, this.startAssoc);

        // Shift 拖：起点沿用已有选区的锚点，才能「接着上次的地方继续选」
        const anchorPos = extend ? this.view.state.selection.main.anchor : this.startPos;
        // single 已返回 EditorSelection（anchor/head，自动归一化）
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
 * 单元格点击 / 框选扩展（接进 createLivePreviewExtension）。
 *
 * 只在「按下的位置落在某个格子上」时接管，表格之外一律 null，
 * 让 CodeMirror 用回它自己那套文本选区逻辑。
 *
 * ## 单击落点与光标关联修正
 *
 * `posAtCoords` 对「格子内容之外、mark 边界、0 宽缝隙」这些位置不可靠，
 * 会把光标放到旁边 font-size:0 的管道符处 —— 光标竖线消失，拼音 composition
 * 在缝隙里发生还会让格子边框消失。这里在**未拖动的单击**场景修正落点
 * （cellAt 已把点击归属到最近一格），并显式指定光标关联方向（assoc）：
 *
 * - 空格子：落点修正到借来的空格位置；
 * - 非空格子点在文字之外：落点修正到内容末尾；
 * - 点在文字上：落点不变。
 *
 * assoc 按末尾边界**右侧字符**决定 —— CM 据此选择从位置哪一侧取光标矩形：
 * 右侧是正常空格（`| a |`）→ assoc=1；右侧是 0 高管道符（紧凑写法 `| a|`）
 * → assoc=-1，向左贴最后一个内容字符（向右会落到管道符、竖线消失）。
 *
 * 拖拽仍然不吸附（get 里实时 posAtCoords），保留精确文本选区。
 *
 * @returns CodeMirror 的 mouseSelectionStyle 扩展
 */
export function tableCellSelection() {
    return EditorView.mouseSelectionStyle.of((view, event) => {
        // 只读模式（Viewer）不接管
        if (!view.state.facet(EditorView.editable)) return null;
        // 只接管左键**普通单击**（detail=1），其余交回 CM 原生：
        // Alt=矩形选择、Shift=扩展选区、Ctrl/Cmd=加多光标/点链接、
        // detail≠1=双击选词 / 三击选行
        if (event.button !== 0 || event.detail !== 1) return null;
        if (event.altKey || event.shiftKey || event.ctrlKey || event.metaKey) return null;
        const rawPos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (rawPos === null) return null;
        // 用 cellAt 把点击位置归属到格子（缝隙位置会归属最近一格）
        const cell = cellAt(view.state, rawPos);
        if (!cell) return null;

        // 该格子是不是空的：cell 区间含借位字符时，空格子取到的是单个空格
        const isEmpty = view.state.sliceDoc(cell.from, cell.to + 1).trim() === '';
        // 点击落在格子内容区间之外吗（缝隙 / 尾部空白）
        const outside = rawPos < cell.from || rawPos > cell.to;
        // 正好点在内容末尾边界（rawPos === cell.to）
        const atEnd = rawPos === cell.to;
        // 目标落点：
        // - 空格子：无论点哪都去借位空格位置（cell.to）；
        // - 非空格子点在内容之外：去内容末尾；
        // - 点在文字上：用 posAtCoords 的精确字符位置。
        const targetPos = isEmpty || outside ? cell.to : rawPos;
        // 末尾边界右侧紧邻的字符是不是「正常字号的空白」（可借位的 trailing
        // space）。边界位置（空格子 / 内容之外 / 正好末尾）必须显式关联：
        // - 右侧是正常空格（`| a |`）：assoc=1，光标贴空格、在 mark 内；
        // - 右侧是 font-size:0 的管道符（紧凑写法 `| a|`，无空格可借）：
        //   assoc=-1，光标向左贴最后一个内容字符 —— 向右会落到 0 高管道符、
        //   竖线消失。
        // 点在文字中间用默认 assoc=0。
        const onBoundary = isEmpty || outside || atEnd;
        const rightIsSpace = /[ \t]/.test(view.state.sliceDoc(cell.to, cell.to + 1));
        const targetAssoc = onBoundary ? (rightIsSpace ? 1 : -1) : 0;

        // **所有点击都在 mousedown 同步栈里直接放置光标**：CM 默认的点击
        // dispatch 对「0 宽缝隙、mark 边界」位置不可靠（实测单击事务不产生、
        // 光标不动）。这与 inputHandler 中 dispatch 同模式；CM 随后的
        // MouseSelection.select 发现选区已一致会自动跳过，不会重复 dispatch。
        // **阻止浏览器的 mousedown 默认动作**：否则浏览器会在事件处理后把原生
        // caret 放到它自己 hit-test 的点击位置 —— 那常常是 cell 之后 font-size:0
        // 的管道符处（rawPos=管道符位置，0 高、无竖线），并反过来覆盖我们下面
        // 这次 dispatch、被 CM 同步成错误光标。preventDefault 后 caret 完全由我们
        // 放置。focus 不受影响（CM 在 handler 里自行 focus contentDOM）。
        event.preventDefault();

        view.dispatch({ selection: cursorSelection(targetPos, targetAssoc) });
        return new CellSelectionStyle(view, event, targetPos, targetAssoc);
    });
}
