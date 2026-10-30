/**
 * Live Preview 数学公式收集器
 *
 * 这一个文件只干一件事：**扫文档，把该渲染成 KaTeX 的公式挑出来，产出装饰**。
 * 两类公式都在这儿：
 *
 * 1. 块级 `$$ … $$`（独占多行、或者整行就是一行 `$$公式$$`）；
 * 2. 行内 `$公式$`、以及夹在正文里的 `$$公式$$`。
 *
 * 行内代码（反引号）**不参与**公式渲染：反引号里的内容是代码，原样显示。
 * 以前还有一档「反引号内容按公式渲染」，已按用户要求去掉。
 *
 * 只产出「源码压 0 宽 + KaTeX widget 叠上去」的装饰，具体怎么画、多高、点击怎么定位
 * 全在 widgets.ts（BlockMathWidget / InlineMathWidget）。
 *
 * @module webview/codemirror/extensions/livePreview/mathCollect
 */

import { Decoration } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { Tree } from '@lezer/common';
import { hiddenSourceDeco } from '../decor/decorations.js';
import { windowLines } from '../ranges.js';
import { isForcedSourceRange } from '../state.js';
import type { ILineRange } from '../types.js';
import { BlockMathWidget, InlineMathWidget } from '../widgets/mathWidgets.js';

/** 收集器统一往这个数组里塞装饰，类型和 plugin.ts 里的一致。 */
type DecoArray = Array<ReturnType<Decoration['range']>>;

/**
 * 语法树里算「代码」的节点名。
 *
 * 行内代码（InlineCode / CodeMark）与围栏代码（FencedCode / CodeText /
 * CodeInfo）、缩进代码块（CodeBlock）都在内 —— 这些位置的 `$` 是代码，不是公式。
 */
const CODE_NODE_NAMES = new Set([
    'InlineCode',
    'CodeMark',
    'FencedCode',
    'CodeText',
    'CodeBlock',
    'CodeInfo',
]);

/**
 * 这个节点名是否属于代码区域。
 *
 * @param name - lezer 节点名
 * @returns 代码区域返回 true
 */
function isCodeNodeName(name: string): boolean {
    return CODE_NODE_NAMES.has(name);
}

/**
 * 全篇扫一遍，把公式的**开头 `$$`** 和**结尾 `$$`** 两两配对。
 *
 * 认三种行（角色判定见 classifyDollarLine）：
 * - 独占一行的 `$$`：按出现顺序交替当开头 / 结尾；
 * - `$$内容`（可带缩进）：开头定界符 + 同一行的内容；
 * - `内容$$`：同一行的内容 + 结尾定界符。
 *
 * 缩进要认：用户习惯在 `$$` 前面空两格，列表项里的公式更是必然带缩进。
 * 以前只认「整行 `$$`」，`  $$a+b` / `  $$` 这种写法里，第二个 `$$`
 * 会被当成新的开头，把后面真正的公式开头抢走、中间整段正文吞进公式。
 *
 * 缩进代码块（4 空格）与围栏代码里的 `$$` 一律不算公式。
 *
 * 为什么要先配对、而不是从某一行往下找下一个 `$$`：
 *
 * ```
 * $$
 * 公式一
 * $$
 * $$
 * 公式二
 * $$
 * ```
 *
 * 两组公式紧挨着时，中间那个 `$$` 既是公式一的**结尾**、又是公式二的**开头**
 * （就 2 个字符，两种说法都成立）。按「往下找」的写法，一旦公式一因为光标 /
 * 选区落在里面而不渲染，扫描就会从那一行继续往后找，于是把公式一的结尾
 * 和公式二的开头配成一对 —— 公式二被吃掉，剩下的 `$$` 全变成普通文本。
 *
 * 按出现顺序配对之后，每个 `$$` 的身份在整篇范围内唯一，谁进不渲染都不影响别人。
 * 围栏代码块里的 `$$` 不算（那是代码，不是公式）。
 *
 * @param state - 编辑器状态
 * @returns 开头行号 → 结尾行号
 */
export function pairDollarLines(state: EditorState, tree?: Tree): Map<number, number> {
    const pairs = new Map<number, number>();
    /** 还没配上对的开头行号，-1 表示当前不在公式里 */
    let openLn = -1;
    /** 是否正走在围栏代码块里（围栏里的 `$$` 不算公式） */
    let inFence = false;
    /** 懒取语法树：调用方有现成的就复用，没有就现查一次 */
    const syntax = (): Tree => tree ?? syntaxTree(state);

    for (let ln = 1; ln <= state.doc.lines; ln++) {
        const line = state.doc.line(ln);
        const text = line.text.trim();
        // 围栏行：进/出代码块，本身不参与配对
        if (text.startsWith('```') || text.startsWith('~~~')) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;

        // 不含 `$$` 的行不可能参与配对，先跳过（避免每行都去查语法树）
        if (!text.includes('$$')) continue;

        // 缩进代码块里的 `$$` 是代码，不能参与配对 —— 否则它会把后面
        // 真正公式的开头「抢走」，那一组就再也不渲染了。
        // 代码块节点从第一个非空白字符开始，所以按缩进之后的位置查。
        const lead = line.text.length - line.text.trimStart().length;
        if (isCodeNodeName(syntax().resolveInner(line.from + lead, 1).type.name)) continue;

        const role = classifyDollarLine(text);
        // 不含定界符 / 定界符自己成对（`$$x$$`）：和跨行配对无关
        if (role === 'none' || role === 'single') continue;

        if (role === 'open') {
            // 「开头行 + 同一行内容」（`  $$a+b`）。
            // 前面如果已经有个没配上的开头，说明那段是残缺的写法，
            // 让位给更靠后的这个（残缺段保持源码，不去吞后面的正文）。
            openLn = ln;
            continue;
        }

        if (role === 'close') {
            // 「结尾行 + 同一行内容」（`a+b$$`）：只负责收尾，不能当新开头
            if (openLn >= 0) {
                pairs.set(openLn, ln);
                openLn = -1;
            }
            continue;
        }

        // 独占一行的 `$$`：既可能是开头也可能是结尾，按出现顺序两两交替
        if (openLn < 0) {
            openLn = ln;
        } else {
            pairs.set(openLn, ln);
            openLn = -1;
        }
    }
    return pairs;
}

/**
 * 一行（已 trim）里的 `$$` 扮演什么角色 —— `pairDollarLines` 靠它配对。
 *
 * 以前只认「整行就是 `$$`」，于是缩进 / 内容写在同一行的写法
 * （`  $$a+b` 换行 `  $$`）会被彻底漏掉：第二个 `$$` 被当成新的开头，
 * 结果它和后面真正的公式开头配成一对，中间整段正文被吞进公式里。
 *
 * 判定规则（都在 trim 之后的文本上做）：
 * - `$$`                → `neutral`，可开可闭，交给配对循环按顺序交替；
 * - `$$x$$`             → `single`，单行公式，收集时由 sameLineMatch 处理，不参与配对；
 * - `$$x…`              → `open`，开头定界符后面还有内容；
 * - `x…$$`              → `close`，内容之后才是结尾定界符；
 * - 其余（`$$a$$ b`、`x $$ y` 这种）→ `none`，不参与配对，避免误吞。
 *
 * @param trimmed - 已经 trim 过的行文本
 * @returns 该行在配对里的角色
 */
function classifyDollarLine(
    trimmed: string
): 'none' | 'single' | 'open' | 'close' | 'neutral' {
    // 先判「整行就是 $$」：它既 startsWith 又 endsWith，别被下面的单一判定抢走
    if (trimmed === '$$') return 'neutral';
    if (!trimmed.includes('$$')) return 'none';

    const starts = trimmed.startsWith('$$');
    const ends = trimmed.endsWith('$$');
    // 上下定界符挤在同一行：`$$x$$`，单行公式
    if (starts && ends) return 'single';

    if (starts) {
        // 开头 `$$` 后面还剩内容，且内容里不再出现 `$$`（否则这行自己就含一对）
        return trimmed.slice(2).includes('$$') ? 'none' : 'open';
    }
    if (ends) {
        // 结尾 `$$` 前面的内容里不能再有 `$$`
        return trimmed.slice(0, -2).includes('$$') ? 'none' : 'close';
    }
    return 'none';
}

/**
 * 收集数学公式对应的 KaTeX 装饰。
 *
 * 扫描顺序上有讲究，按下面的顺序判断，先命中的先返回：
 * 聚焦区间 → 不含 `$` 的行 → 代码块内 → 整行 `$$…$$` → 块级结尾行
 * → 块级开头行（吃掉整块）→ 行内 `$$…$$` → 行内 `$…$`。
 *
 * @param state - 当前编辑器状态
 * @param decos - 待写入的装饰数组
 * @param range - 渲染窗口
 * @param focusedRange - 当前正在编辑的聚焦区间（落在里面的行显示源码）
 * @param tree - 当前语法树
 * @returns void，结果直接 push 进 decos
 */
export function collectMathDecorations(
    state: EditorState,
    decos: DecoArray,
    range: ILineRange,
    focusedRange: ILineRange,
    tree: Tree
): void {
    const win = windowLines(state, range);

    /**
     * 这个位置是不是落在代码里（行内代码 / 围栏代码都算）。
     * 代码里的美元符号是代码，不是公式。
     */
    const isInsideCode = (pos: number): boolean =>
        isCodeNodeName(tree.resolveInner(pos, 1).type.name);

    // 预编译行内公式正则，允许分隔符内外出现常见空格。
    // `(?!\$)` 的两头是为了排除 `$$`；结尾的 `(?!\d)` 是为了放过「$5 到 $10」这种价格。
    const inlineRegex = /(?<!\$)\$(?!\$)\s*(.+?)\s*\$(?!\$|\d)/g;

    // 块级 `$$` 的配对表：整篇算一次，循环里查表。配对规则见 pairDollarLines。
    const dollarPairs = pairDollarLines(state, tree);
    const dollarClosers = new Set(dollarPairs.values());

    // 当前选区：行内公式要不要展开，看的是光标在不在**表达式里面**，
    // 不再是「光标在不在这一行」（2026-09-22 反馈：要和 `*` / `` ` `` 同粒度）。
    const sel = state.selection.main;

    /**
     * 一个**行内**公式现在该不该让开（显示源码、不挂 widget）。
     *
     * 两种选区规则不一样：
     * - 空选区（光标）：光标严格落在表达式区间内部才展开 —— 点同一行的普通文字时，
     *   行内公式保持渲染，和加粗 / 行内代码的 focusMarks 行为一致。
     *   边界不算内部（光标在定界符外那格 = 没点到元素），与行内代码同一套闭开判定。
     * - 非空选区（拖选）：表达式落在选区覆盖的行里就让开，
     *   即「选中即源码」的行级规则。
     *
     * 两种选区下，只要表达式落在行级强制区间（mousedown 待选 / 双击钉住）
     * 也都让开：整行展开时公式不能继续以渲染态留在原地。
     *
     * 块级公式（整行 `$$x$$`、多行 `$$`）不走这里，它们的展开粒度仍是行 / 整块。
     */
    const isInlineMathOpen = (mathFrom: number, mathTo: number): boolean => {
        if (isForcedSourceRange(state, mathFrom, mathTo)) return true;
        if (sel.empty) return sel.head > mathFrom && sel.head < mathTo;
        return mathFrom < focusedRange.to && mathTo > focusedRange.from;
    };

    for (let ln = win.first; ln <= win.last; ln++) {
        const line = state.doc.line(ln);

        // 注意：这里**不再**因「光标落在这一行」就整行跳过。
        // 行内公式改为元素级粒度（见 isInlineMathOpen），块级分支各自保留
        // 整块展开的判断（见下面的 sameLineMatch 和多行配对分支）。

        const lineText = line.text;
        const trimmedLine = lineText.trim();

        // 没有美元符号的行不可能包含数学公式，直接跳过。
        if (!lineText.includes('$')) continue;

        // 代码块内不做数学公式渲染，避免误伤源码。
        // 注意**不能用 line.from 判**：缩进代码块（4 空格）的节点是从第一个
        // 非空白字符开始的，行首那几个空格还在节点外面，resolveInner 会在那里
        // 返回 Document，于是 `    $$x` 这类会被误当成公式。
        const leadingSpace = lineText.length - lineText.trimStart().length;
        if (isInsideCode(line.from + leadingSpace)) continue;

        // 同行块级公式：只有整行都由 $$ 包围时，才保留块级渲染（渲染成块级 widget，占 2.5 行高）。
        const sameLineMatch = lineText.match(/^\s*\$\$\s*(.+?)\s*\$\$\s*$/);
        if (sameLineMatch) {
            // 块级语义：光标 / 选区落在这一行就整行显示源码（展开粒度 = 行，
            // 与代码块一致）。不挂 widget，这一行什么都不做。
            if (line.from < focusedRange.to && line.to > focusedRange.from) continue;
            const rawTex = sameLineMatch[1];
            const tex = rawTex.trim();
            if (tex) {
                // 公式原文的准确区间：`$$` 之后的第一个非空白字符起，到结尾 `$$` 前的空白为止。
                // 传这个区间是为了点击定位（见 widgets.ts 的 placeMathCaret）。
                const texStart =
                    line.from + sameLineMatch[0].indexOf(rawTex) + (rawTex.length - rawTex.trimStart().length);
                decos.push(
                    Decoration.replace({
                        widget: new BlockMathWidget(tex, texStart, texStart + tex.length),
                    }).range(line.from, line.to)
                );
            }
            continue;
        }

        // 公式的**结尾** `$$`：整块由它上面那一行的开头负责，这里直接跳过。
        // 必须先判这一条：不然结尾 `$$` 会被当成分组的开头，和下一组的 `$$` 配成一对。
        if (dollarClosers.has(ln)) continue;

        // 多行块级公式：`$$` 独占一行，配对表说了算（见 pairDollarLines）。
        const closingLn = dollarPairs.get(ln);
        if (closingLn !== undefined) {
            const closingLine = state.doc.line(closingLn);
            // 光标 / 选区落在**整块里**任何一行都要让开（块首的 `$$`、中间的公式正文、块尾的 `$$`）。
            // 只拿结束行判断是不够的：光标点在公式正中间时结束行并不和它重叠，
            // 于是整块照样被替换成 widget —— 用户点了没反应，光标其实藏在 widget 里。
            if (line.from < focusedRange.to && closingLine.to > focusedRange.from) {
                // 整块让开：里面的行也不能再按正文去找行内公式（那样会露出半截公式）
                ln = closingLn;
                continue;
            }

            // 公式原文 = 开头 `$$` 之后 … 结尾 `$$` 之前。
            // 内容允许写在定界符同一行（`  $$a+b` / `a+b$$`），所以起点是
            // 开头行里 `$$` 的末尾、终点是结尾行里 `$$` 的起点，中间的行整段包含。
            // 这种写法常见于缩进（列表项 / 引用块 / 用户习惯空两格）。
            const openIdx = line.text.indexOf('$$');
            const closeIdx = closingLine.text.lastIndexOf('$$');
            const rawFrom = line.from + Math.max(0, openIdx) + 2;
            const rawTo = closingLine.from + Math.max(0, closeIdx);
            const rawTex = state.doc.sliceString(rawFrom, rawTo);
            const texContent = rawTex.trim();
            if (texContent) {
                // 掐掉首尾空白之后公式原文在哪：点击定位要用（见 placeMathCaret）
                const texStart = rawFrom + (rawTex.length - rawTex.trimStart().length);
                decos.push(
                    Decoration.replace({
                        widget: new BlockMathWidget(texContent, texStart, texStart + texContent.length),
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
            // 元素级粒度：只有光标真的落在这段公式里（或拖选覆盖这行）才展开
            if (isInlineMathOpen(mathFrom, mathTo)) continue;
            if (isInsideCode(mathFrom)) continue;
            pushInlineMath(decos, mathFrom, mathTo, tex);
        }

        // 行内公式：允许 $ 与内容之间留空格，但仍排除 $$。
        inlineRegex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = inlineRegex.exec(lineText)) !== null) {
            const tex = match[1];
            if (!tex.trim()) continue;
            const mathFrom = line.from + match.index;
            const mathTo = mathFrom + match[0].length;
            // 元素级粒度：光标在这个表达式里面才展开，点同行别处时它保持渲染
            if (isInlineMathOpen(mathFrom, mathTo)) continue;
            // 行内代码片段中的美元符号不参与公式渲染。
            if (isInsideCode(mathFrom)) continue;
            pushInlineMath(decos, mathFrom, mathTo, tex);
        }
    }
}

/**
 * 画一个行内公式：源码压 0 宽盖住，KaTeX 用 widget 叠在中间。
 *
 * 三点讲究：
 * 1. **不整段 replace**：表格单元格的「格子」是 mark 包出来的盒子（见 tableRender.ts），
 *    格子里如果整段都是 replace，CodeMirror 会连那个 mark 一起丢掉，格子就塌了。
 *    压 0 宽既藏住了源码，又保证格子里始终有能做样式的内容。
 * 2. widget 夹在**两段盖住的源码中间**：这样它不会落进 `font-size: 0` 的那个 span 里，
 *    否则 KaTeX 内部全是 em 字号，父级一归零整条公式就看不见了。所以第一段**至少要有
 *    一个字符**（`$…$` 就是那个 `$`）：
 *    要是整段一次压掉、widget 顶到段首，同位置 `side: -1` 的 widget 会排在这段 mark 的
 *    **外面**（连带跑到单元格 / 行内元素的盒子外面去），盒子里的内容全归零、盒子缩成一条缝。
 * 3. 源码留在文档里还有个好处：光标可以走进公式（左键点公式会直接把光标放进去，
 *    见 widgets.ts 的 placeMathCaret），一进这一行整行就切成文本模式显示源码。
 *
 * @param decos - 待写入的装饰数组
 * @param from - 公式源码起点（含 `$`）
 * @param to - 公式源码终点
 * @param tex - 公式内容（不含定界符）
 * @returns void，结果直接 push 进 decos
 */
export function pushInlineMath(
    decos: DecoArray,
    from: number,
    to: number,
    tex: string
): void {
    // 只剩一个字符时**没有地方夹 widget**：整段压 0 宽之后，这段区间里就没有
    // 「不属于任何被压区间」的位置了，widget 只能落到 mark 外面去（见函数头第 2 点）。
    // 公式区间至少含一对 `$` 定界符（3 个字符），理论上到不了这里；留着兜底。
    if (to - from <= 1) return;
    // 头一个字符单独压 0 宽，widget 夹在两段中间 —— 这一刀是必须的，见函数头第 2 点
    decos.push(hiddenSourceDeco.range(from, from + 1));
    decos.push(hiddenSourceDeco.range(from + 1, to));
    // 公式原文（不含那个头字符，`$…$` 时头字符就是 `$`）的起点：
    // 两侧的空格也一并算进去，传下去是给点击定位用的（见 widgets.ts 的 placeMathCaret）
    const contentFrom = from + 1;
    decos.push(
        Decoration.widget({
            widget: new InlineMathWidget(tex, contentFrom, contentFrom + tex.length),
            side: -1,
        }).range(contentFrom)
    );
}

/**
 * 算出范围内所有**数学公式源码**（含 `$` 定界符）的区间。
 *
 * 用途：`$$` 对 Markdown 语法只是普通字符，公式文本里的 `_`（下标）、`*`、`~~`
 * 会被 lezer 照常解析成 Emphasis 等节点。plugin.ts 的主遍历拿这份区间做屏蔽：
 * 落在公式源码内的其他修饰节点一律不装饰，进文本模式后公式源码才能完整可编辑
 * （否则 `x*y` 的 `*` 被 hideDeco 替换、直接变成 `xy`）。
 *
 * 识别规则必须与 collectMathDecorations **严格一致**（同一份配对表、同样三条正则），
 * 否则会出现「渲染了公式却没屏蔽修饰」或反过来的错位。
 *
 * 覆盖三类：
 * 1. 多行 `$$`：配对表，区间 = 开头 `$$` 行首 … 结尾 `$$` 行尾；
 * 2. 整行 `$$x$$`：整行；
 * 3. 行内 `$$…$$` 与 `$…$`：正则匹配区间。
 *
 * @param state - 编辑器状态
 * @param range - 只算这个范围涉及的公式（block 遍整篇、inline 遍窗口）
 * @returns 公式源码区间数组（无序，调用方只做包含判断）
 */
export function collectMathSourceRanges(
    state: EditorState,
    range: ILineRange
): Array<{ from: number; to: number }> {
    const result: Array<{ from: number; to: number }> = [];
    const win = windowLines(state, range);
    const pairs = pairDollarLines(state);
    const closers = new Set(pairs.values());

    // 1. 多行 $$：配对区间含两条 $$ 行，只收与窗口相交的
    for (const [openLn, closeLn] of pairs) {
        if (closeLn < win.first || openLn > win.last) continue;
        result.push({
            from: state.doc.line(openLn).from,
            to: state.doc.line(closeLn).to,
        });
    }

    // 与收集时相同的两条行内正则（先双美元、后单美元）
    const doubleRegex = /(?<!\$)\$\$\s*(.+?)\s*\$\$(?!\$)/g;
    const singleRegex = /(?<!\$)\$(?!\$)\s*(.+?)\s*\$(?!\$|\d)/g;

    for (let ln = win.first; ln <= win.last; ln++) {
        const line = state.doc.line(ln);
        if (!line.text.includes('$')) continue;
        // 多行 $$ 的开头 / 结尾行已由配对区间整行覆盖，别重复
        if (pairs.get(ln) !== undefined || closers.has(ln)) continue;

        // 2. 整行 $$x$$（sameLineMatch 同规则）：整行
        if (/^\s*\$\$\s*(.+?)\s*\$\$\s*$/.test(line.text)) {
            result.push({ from: line.from, to: line.to });
            continue;
        }

        // 3. 行内 $$…$$
        let m: RegExpExecArray | null;
        doubleRegex.lastIndex = 0;
        while ((m = doubleRegex.exec(line.text))) {
            result.push({ from: line.from + m.index, to: line.from + m.index + m[0].length });
        }
        // 行内 $…$
        singleRegex.lastIndex = 0;
        while ((m = singleRegex.exec(line.text))) {
            result.push({ from: line.from + m.index, to: line.from + m.index + m[0].length });
        }
    }
    return result;
}

/**
 * 光标当前是否落在某个**行内公式**里 —— 给 focusMarks.computeFocusSignature 用。
 *
 * 行内公式不在语法树里（是本文件用正则识别的），光标在同一个段落行内、从普通文字
 * 移进公式时，focusChanged 不变、行内元素签名也算不到它，装饰就不会重建 ——
 * 于是点了公式却没反应。本函数用与收集时相同的两条正则找出「严格包住光标」的那段，
 * 返回区间签名；computeFocusSignature 拼进总签名后，这种行内移动就能触发重建。
 *
 * 块级公式（整行 `$$x$$`、多行 `$$`）不需要签名：它们的展开跟 focusedRange 走，
 * 光标跨进行所在行时 focusChanged 已经会触发。
 *
 * @param state - 编辑器状态
 * @param tree - 语法树，用来排除代码区域
 * @returns 形如 `m8-17` 的签名；光标不在任何行内公式里时返回 null
 */
export function inlineMathFocusSignature(state: EditorState, tree: Tree): string | null {
    const selection = state.selection.main;
    if (!selection.empty) return null;

    const line = state.doc.lineAt(selection.head);
    if (!line.text.includes('$')) return null;

    // 代码（行内代码 / 围栏代码）里的 $ 不是公式，判定与收集时的 isInsideCode 一致
    const resolvedName = tree.resolveInner(selection.head, 1).type.name;
    if (
        resolvedName === 'InlineCode' ||
        resolvedName === 'CodeMark' ||
        resolvedName === 'FencedCode' ||
        resolvedName === 'CodeText' ||
        resolvedName === 'CodeBlock' ||
        resolvedName === 'CodeInfo'
    ) {
        return null;
    }

    // 整行 $$x$$ 是块级语义，交给 focusedRange 变化触发，这里不产出签名
    if (/^\s*\$\$\s*.+?\s*\$\$\s*$/.test(line.text)) return null;

    // 与收集时相同的两条正则（先双美元、后单美元），找严格包住光标的那一段
    const regexes = [
        /(?<!\$)\$\$\s*(.+?)\s*\$\$(?!\$)/g,
        /(?<!\$)\$(?!\$)\s*(.+?)\s*\$(?!\$|\d)/g,
    ];
    for (const re of regexes) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(line.text)) !== null) {
            const from = line.from + m.index;
            const to = from + m[0].length;
            // 与 isInlineMathOpen 的空选区判定严格一致：光标必须在表达式内部
            if (selection.head > from && selection.head < to) return `m${from}-${to}`;
        }
    }
    return null;
}
