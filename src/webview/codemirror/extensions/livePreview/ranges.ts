/**
 * Live Preview Range Detection
 *
 * Utilities for detecting focused line ranges, Markdown block boundaries,
 * and code block ranges in the editor state.
 *
 * @module webview/codemirror/extensions/livePreview/ranges
 */

import type { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import type { ILineRange } from './types.js';
import {
    getPendingForceRange,
    getPinnedForceRange,
    getSourceModeRange,
} from './state.js';
import { isTableLikeBlock } from './tableDetect.js';

/**
 * 取当前「该显示源码」的区间。
 *
 * 分两种情况，规则不一样：
 *
 * 1. **光标（空选区）**：走 `getMarkdownBlockRange` —— 段落只看一行，
 *    代码块 / 公式块 / 引用整块让开，这样点进去看到的是干净的源码。
 * 2. **拖选（非空选区）**：选区覆盖到的**行**就是源码区间 —— 选中哪几行，
 *    哪几行立刻变回 Markdown 原文。表格是唯一的例外：它的格子骨架由
 *    tableRender 常驻渲染（不看聚焦范围），所以表格只会「格子里的文字」
 *    回到源码态，网格本身不会散架。
 *
 * 只读模式（Viewer）同样返回真实聚焦区间：viewer 允许「点击查看源码」，
 * 与实时模式行为一致，只是不能编辑。各编辑型交互（行级强制展开、双击进源码
 * 编辑等）在 lineForce.ts / widgets.ts 里有自己的 editable 守卫，不受影响。
 *
 * @param state - 编辑器状态
 * @returns 该按 Markdown 原文显示的区间
 */
export function getSourceRange(state: EditorState): ILineRange {
    const main = state.selection.main;
    // 兜底：选区位置理论上永远落在文档内，但导图节点的 mini-CM 在
    // 「实例刚销毁 / 文档被整体替换」的瞬间可能把旧位置带进一次更新。
    // doc.lineAt 收到越界位置时，CM 内部的 lineInner 会去读不存在的行，
    // 抛 `Cannot read properties of undefined (reading 'length')` ——
    // 整个装饰 StateField 更新跟着炸掉。这里把两端夹到合法区间，
    // 正常情况下 Math.min/max 不产生任何行为变化。
    const clamp = (pos: number): number => Math.max(0, Math.min(pos, state.doc.length));

    // 拖拽展开行：鼠标移动超阈值后整行已展开，直接返回该行区间。
    // 优先级保持最高，与 mousedown 时记录锚点的逻辑（见 lineForce.ts）互不干扰
    const pending = getPendingForceRange(state);
    if (pending) return { from: pending.from, to: pending.to };

    // 双击进过源码模式的块（表格 / 图片 / Mermaid）：选区只要还挨着它，就一直算源码区间
    const sourceMode = getSourceModeRange(state);
    if (sourceMode && main.from <= sourceMode.to && main.to >= sourceMode.from) {
        return { from: sourceMode.from, to: sourceMode.to };
    }

    // 双击钉住的行：选区与它相交期间一直算源码区间
    const pinned = getPinnedForceRange(state);
    if (pinned && main.from <= pinned.to && main.to >= pinned.from) {
        return { from: pinned.from, to: pinned.to };
    }

    if (main.empty) return getMarkdownBlockRange(state);

    // 选区的两端各取所在行的行首 / 行尾：选区中间那些行整行都算进来
    return {
        from: state.doc.lineAt(clamp(main.from)).from,
        to: state.doc.lineAt(clamp(main.to)).to,
    };
}

/**
 * 判断一个 Setext 标题是不是「被误判的」：它下面那条 `---` / `===`
 * 后面紧跟着一个代码围栏。
 *
 * 这种写法（正文、`---`、``` 三行紧挨着）在 CommonMark 里确实算 Setext 标题 ——
 * 那条 `---` 是标题下划线。可读者写它的时候想的是「一条分隔线 + 一个代码块」，
 * 于是「按标题渲染」就出事了：下划线那一行被折叠成 0 高（`cm-md-setext-underline`），
 * **整行凭空消失**。表格后面紧跟 `---` 是同一个毛病（见 isTableLikeBlock），
 * 这里再补上围栏这一种。
 *
 * @param state - 编辑器状态
 * @param from - 块起点
 * @param to - 块终点
 * @returns 下划线后面紧跟着围栏时返回 true
 */
export function isSetextBeforeFence(state: EditorState, from: number, to: number): boolean {
    const underline = state.doc.lineAt(to);
    // 下划线必须自成一行，且长得就是 `---` / `===`
    if (underline.number <= state.doc.lineAt(from).number) return false;
    if (!/^\s*(-{2,}|={2,})\s*$/.test(underline.text)) return false;
    if (underline.number >= state.doc.lines) return false;

    const next = state.doc.line(underline.number + 1).text.trimStart();
    return next.startsWith('```') || next.startsWith('~~~');
}

/**
 * Gets the Markdown block range for the current cursor position.
 * Expands to include the entire block (heading, code block, quote, table...).
 *
 * 例外是**段落和列表项**：它们只取光标所在的这一行，
 * 这样聚焦范围永远只有一行，列表里不会出现多行同时展开成 `-` 的情况。
 */
export function getMarkdownBlockRange(state: EditorState): ILineRange {
    const { main } = state.selection;
    const tree = syntaxTree(state);
    const doc = state.doc;
    // 同 getSourceRange：防止越界位置把 doc.lineAt 打进 CM 内部崩溃分支。
    // 越界只可能来自「状态本身已经不一致」的瞬时更新，夹一下即可。
    const pos = Math.max(0, Math.min(main.head, doc.length));

    // 双击进过源码模式的块（表格 / 图片 / Mermaid）：聚焦范围就给**整块**。
    // 这样按行扫描的那些收集器（公式、复选框、图片…）会整块跳过，
    // 看到的才是干干净净的源码。
    //
    // 必须在这里先判一次，不能等走语法树时再看：光标常常正好停在块的边界上
    // （双击表格时光标就落在表首），resolveInner 会往前面那个节点上靠，
    // 走上去根本碰不到 Table 节点。
    const sourceMode = getSourceModeRange(state);
    if (sourceMode && pos >= sourceMode.from && pos <= sourceMode.to) {
        return { from: sourceMode.from, to: sourceMode.to };
    }

    // Check if in a code block - if so, return the entire code block range
    if (isInCodeBlock(state, pos)) {
        return getCodeBlockRange(state, pos);
    }

    // For single-line cursor, try to expand to Markdown block boundaries
    const cursorLine = doc.lineAt(pos);

    // Walk up the syntax tree to find the enclosing block
    let blockFrom = cursorLine.from;
    let blockTo = cursorLine.to;

    let node: SyntaxNode | null = tree.resolveInner(pos);

    // 引用块优先于下面的一切分支：光标在引用里（任何深度——引用里的段落、
    // 引用里的列表项、嵌套引用的内层）都聚焦到**最外层 Blockquote**，
    // 整片相连的 `>` 行一起进源码态（`>` 全部露出，可以整段编辑/删除）。
    //
    // 为什么不能放在下面的分支链里：向上走的顺序是 Paragraph → ListItem →
    // Blockquote，段落和列表的「一次只展开一行」分支会先命中并提前 return，
    // 永远轮不到 Blockquote（`> - item` 这种引用里嵌列表就是踩这个）。
    // 一次性找到最外层引用再返回，分支顺序就不会再咬人。
    {
        let quote: SyntaxNode | null = node;
        while (quote && quote.name !== 'Blockquote') quote = quote.parent;
        if (quote) {
            while (quote.parent?.name === 'Blockquote') quote = quote.parent;
            return { from: quote.from, to: quote.to };
        }
    }
    while (node) {
        const { name } = node;

        // Block-level nodes that define editing boundaries
        if (
            name === 'ATXHeading1' ||
            name === 'ATXHeading2' ||
            name === 'ATXHeading3' ||
            name === 'ATXHeading4' ||
            name === 'ATXHeading5' ||
            name === 'ATXHeading6' ||
            name === 'SetextHeading1' ||
            name === 'SetextHeading2' ||
            name === 'Paragraph' ||
            name === 'BulletList' ||
            name === 'OrderedList' ||
            name === 'ListItem' ||
            name === 'Blockquote' ||
            name === 'FencedCode' ||
            name === 'Table' ||
            name === 'HorizontalRule' ||
            name === 'HTMLBlock'
        ) {
            // 普通段落按“当前行”进入编辑，避免相邻自然段被当成同一个编辑块；
            // 列表项里的段落同样只算一行（见下面的列表说明）。
            if (name === 'Paragraph') {
                return { from: cursorLine.from, to: cursorLine.to };
            }
            // 列表项 / 整张列表：聚焦范围就是**光标这一行**。
            // 用 ListItem 节点的范围会把它下面的子列表一起圈进来，那些行会跟着
            // 一起展开成 `-`；收窄到一行之后，兄弟节点不在这段区间里，
            // 主遍历仍然会正常渲染它们的圆点 —— 也就是「一次只有一行进源码模式」。
            if (name === 'ListItem' || name === 'BulletList' || name === 'OrderedList') {
                return { from: cursorLine.from, to: cursorLine.to };
            }
            // （引用块已在函数开头提前整片返回，分支链走不到 Blockquote）
            // 表格：聚焦范围也是**光标这一行**。
            // 表格的格子骨架由 collectTableDecorations 按行常驻渲染，不需要「整块展开」；
            // 收窄到一行之后，其余行照常渲染，光标所在那一行里的行内元素也照常渲染。
            if (name === 'Table') {
                return { from: cursorLine.from, to: cursorLine.to };
            }
            // 形状是表格的 Setext 标题（表格后面紧跟 ---）按表格算：聚焦范围给光标那一行，
            // 否则光标在格子里时会整块按源码显示
            if (name.startsWith('SetextHeading') && isTableLikeBlock(state, node.from, node.to)) {
                return { from: cursorLine.from, to: cursorLine.to };
            }
            // 下划线后面紧跟围栏的同理（「正文 + --- + ```」）：这块不按标题渲染，
            // 聚焦范围也只给光标那一行
            if (name.startsWith('SetextHeading') && isSetextBeforeFence(state, node.from, node.to)) {
                return { from: cursorLine.from, to: cursorLine.to };
            }
            // For headings, include the entire heading (including setext underline)
            if (name.startsWith('SetextHeading') || name.startsWith('ATXHeading')) {
                blockFrom = node.from;
                blockTo = node.to;
                break;
            }
            // For code blocks, use the whole block
            if (name === 'FencedCode') {
                blockFrom = node.from;
                blockTo = node.to;
                break;
            }
            // For other blocks, use the node range
            blockFrom = node.from;
            blockTo = node.to;
            break;
        }

        // Skip to parent
        if (name === 'Document') break;
        node = node.parent;
    }

    return { from: blockFrom, to: blockTo };
}

/**
 * 判断某个位置是不是「在围栏代码块里」。
 *
 * 逐行数围栏来数，不看语法树：语法树在某些位置（比如收尾围栏的**行尾**）
 * 会把光标算到**后面**那个节点上，于是同一个代码块「点中间算在里面、
 * 点行尾算在外面」，聚焦范围一会儿是整块、一会儿只有一行。
 *
 * 围栏行**自己**也算「在块里」—— 这是关键的一条：起始围栏那一行、
 * 收尾围栏那一行都在代码块的范围之内，点在它们上面跟点在正文行上一样，
 * 都该让整块进文本模式（用户要的就是「点哪儿都一样」）。
 * 老写法「数到这一行时取反再返回」会把收尾围栏判成「在块外」。
 *
 * @param state - 编辑器状态
 * @param pos - 文档位置
 * @returns 在代码块里（含前后两条围栏行）时返回 true
 */
export function isInCodeBlock(state: EditorState, pos: number): boolean {
    const doc = state.doc;
    // 调用方可能把「外部传进来的位置」直接递进来（widget 回调、持久化的
    // 选区），文档缩短后它就超界了。夹一下，避免 lineAt 抛内部 TypeError。
    const target = doc.lineAt(Math.max(0, Math.min(pos, doc.length)));
    let inCodeBlock = false;

    for (let ln = 1; ln <= target.number; ln++) {
        const trimmed = doc.line(ln).text.trimStart();
        if (!trimmed.startsWith('```') && !trimmed.startsWith('~~~')) continue;
        // 这一行就是围栏行本身：起始也好、收尾也好，都算在块里
        if (ln === target.number) return true;
        // 数到一条围栏就是「进 / 出」翻转一次
        inCodeBlock = !inCodeBlock;
    }

    return inCodeBlock;
}

/**
 * Get the range of the code block containing the given position.
 * Returns the position range from opening ``` to closing ```.
 */
export function getCodeBlockRange(state: EditorState, pos: number): ILineRange {
    const doc = state.doc;
    let inCodeBlock = false;
    let codeBlockStart = 0;

    for (let ln = 1; ln <= doc.lines; ln++) {
        const currentLine = doc.line(ln);
        const trimmed = currentLine.text.trimStart();
        if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
            if (!inCodeBlock) {
                codeBlockStart = currentLine.from;
                inCodeBlock = true;
            } else {
                // Found closing fence
                if (pos >= codeBlockStart && pos <= currentLine.to) {
                    return { from: codeBlockStart, to: currentLine.to };
                }
                inCodeBlock = false;
            }
        }
    }

    // If we're still in an unclosed code block at the end
    if (inCodeBlock && pos >= codeBlockStart) {
        return { from: codeBlockStart, to: doc.length };
    }

    return { from: pos, to: pos };
}

// =============================================================================
// 渲染窗口：视口 ± 余量
// =============================================================================

/**
 * 视口上下各多算多少行。
 *
 * 多留一截是为了「滚一点点不用重建」：只要还在这个窗口里滚，装饰照旧有效；
 * 滚出窗口才重算一次。60 行 ≈ 1400px，一屏多一点。
 */
export const RENDER_MARGIN_LINES = 60;

/**
 * 当前渲染窗口覆盖的文档区间：视口 ± 余量，并且一定把光标所在行圈进来
 * （聚焦块、源码模式那些都跟着光标走，漏了就会闪）。
 *
 * @param view - 当前编辑器视图
 * @returns 窗口区间
 */
export function renderRange(view: EditorView): ILineRange {
    const doc = view.state.doc;
    const ranges = view.visibleRanges;
    const firstPos = ranges.length > 0 ? ranges[0].from : 0;
    const lastPos = ranges.length > 0 ? ranges[ranges.length - 1].to : firstPos;
    const caret = view.state.selection.main.head;
    const top = Math.max(1, doc.lineAt(Math.min(firstPos, caret)).number - RENDER_MARGIN_LINES);
    const bottom = Math.min(
        doc.lines,
        doc.lineAt(Math.max(lastPos, caret)).number + RENDER_MARGIN_LINES
    );
    return { from: doc.line(top).from, to: doc.line(bottom).to };
}

/**
 * 窗口的行号范围（1-based，含两端）。
 *
 * 各收集器原本都写 `for (let ln = 1; ln <= state.doc.lines; ln++)` 整篇扫，
 * 换成从窗口起点扫到窗口终点即可 —— 循环体里的 `continue`/`ln` 全都不用动。
 *
 * @param state - 编辑器状态
 * @param range - 窗口区间
 * @returns 起始行号与结束行号
 */
export function windowLines(state: EditorState, range: ILineRange): { first: number; last: number } {
    const doc = state.doc;
    const clamp = (pos: number): number => Math.max(0, Math.min(pos, doc.length));
    return {
        first: doc.lineAt(clamp(range.from)).number,
        last: doc.lineAt(clamp(range.to)).number,
    };
}

/**
 * 两个区间有没有交集。
 *
 * @param a - 区间一
 * @param b - 区间二
 * @returns 有交集时返回 true
 */
export function overlaps(a: ILineRange, b: ILineRange): boolean {
    return a.from <= b.to && b.from <= a.to;
}
