/**
 * Live Preview 数学公式收集器
 *
 * 这一个文件只干一件事：**扫文档，把该渲染成 KaTeX 的公式挑出来，产出装饰**。
 * 三类公式都在这儿：
 *
 * 1. 块级 `$$ … $$`（独占多行、或者整行就是一行 `$$公式$$`）；
 * 2. 行内 `$公式$`、以及夹在正文里的 `$$公式$$`；
 * 3. 行内代码里写的公式：带定界符的 `` `$$x$$` ``、`` `$x$` ``，以及**不带定界符**的
 *    `` `A_e` ``、`` `\frac{a}{b}` ``（整个反引号内容就是公式，纯文字除外）—— 见
 *    collectCodeSpanMathDecorations。
 *
 * 只产出「源码压 0 宽 + KaTeX widget 叠上去」的装饰，具体怎么画、多高、点击怎么定位
 * 全在 widgets.ts（BlockMathWidget / InlineMathWidget）。
 *
 * @module webview/codemirror/extensions/livePreview/mathCollect
 */

import { Decoration } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import type { Tree } from '@lezer/common';
import { hiddenSourceDeco } from './decorations.js';
import { windowLines } from './ranges.js';
import { isForcedSourceRange } from './state.js';
import type { ILineRange } from './types.js';
import { BlockMathWidget, InlineMathWidget } from './widgets.js';

/** 收集器统一往这个数组里塞装饰，类型和 plugin.ts 里的一致。 */
type DecoArray = Array<ReturnType<Decoration['range']>>;

/**
 * 全篇扫一遍，把「独占一行的 `$$`」按出现顺序两两配对。
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
export function pairDollarLines(state: EditorState): Map<number, number> {
    const pairs = new Map<number, number>();
    /** 还没配上对的开头行号，-1 表示当前不在公式里 */
    let openLn = -1;
    /** 是否正走在围栏代码块里（围栏里的 `$$` 不算公式） */
    let inFence = false;

    for (let ln = 1; ln <= state.doc.lines; ln++) {
        const text = state.doc.line(ln).text.trim();
        // 围栏行：进/出代码块，本身不参与配对
        if (text.startsWith('```') || text.startsWith('~~~')) {
            inFence = !inFence;
            continue;
        }
        if (inFence || text !== '$$') continue;

        if (openLn < 0) {
            // 遇到一个「开头」
            openLn = ln;
        } else {
            // 遇到一个「结尾」，配成一对
            pairs.set(openLn, ln);
            openLn = -1;
        }
    }
    return pairs;
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
    const isInsideCode = (pos: number): boolean => {
        const node = tree.resolveInner(pos, 1);
        const n = node.type.name;
        return (
            n === 'InlineCode' ||
            n === 'CodeMark' ||
            n === 'FencedCode' ||
            n === 'CodeText' ||
            n === 'CodeBlock' ||
            n === 'CodeInfo'
        );
    };

    // 预编译行内公式正则，允许分隔符内外出现常见空格。
    // `(?!\$)` 的两头是为了排除 `$$`；结尾的 `(?!\d)` 是为了放过「$5 到 $10」这种价格。
    const inlineRegex = /(?<!\$)\$(?!\$)\s*(.+?)\s*\$(?!\$|\d)/g;

    // 块级 `$$` 的配对表：整篇算一次，循环里查表。配对规则见 pairDollarLines。
    const dollarPairs = pairDollarLines(state);
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
        if (isInsideCode(line.from)) continue;

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

            const rawFrom = state.doc.line(ln + 1).from;
            const rawTo = state.doc.line(closingLn).from;
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
 *    一个字符**（`$…$` 就是那个 `$`，不带定界符时是内容的头一个字符）：
 *    要是整段一次压掉、widget 顶到段首，同位置 `side: -1` 的 widget 会排在这段 mark 的
 *    **外面**（连带跑到行内代码盒子外面去），盒子里的内容全归零、盒子缩成一条缝。
 * 3. 源码留在文档里还有个好处：光标可以走进公式（左键点公式会直接把光标放进去，
 *    见 widgets.ts 的 placeMathCaret），一进这一行整行就切成文本模式显示源码。
 *
 * @param decos - 待写入的装饰数组
 * @param from - 公式源码起点（含 `$`）
 * @param to - 公式源码终点
 * @param tex - 公式内容（不含定界符）
 * @param fallbackText - KaTeX 没认出这段内容时要顶上去的原文。只有**反引号那一路**会传：
 *   那里的内容原本是按代码写的，猜错了应当显示得像没开这个功能（见
 *   collectCodeSpanMathDecorations）；正文里正儿八经写的 `$…$` 不传，照旧显示红字报错。
 * @returns void，结果直接 push 进 decos
 */
export function pushInlineMath(
    decos: DecoArray,
    from: number,
    to: number,
    tex: string,
    fallbackText?: string
): void {
    // 只剩一个字符时**没有地方夹 widget**：整段压 0 宽之后，这段区间里就没有
    // 「不属于任何被压区间」的位置了，widget 只能落到 mark 外面去（见函数头第 2 点）。
    // 于是单字符内容（`` `x` ``、`` `n` ``）照旧按行内代码原样显示 —— 少渲染一个，
    // 好过在代码盒子外面飘一个公式。
    if (to - from <= 1) return;
    // 头一个字符单独压 0 宽，widget 夹在两段中间 —— 这一刀是必须的，见函数头第 2 点
    decos.push(hiddenSourceDeco.range(from, from + 1));
    decos.push(hiddenSourceDeco.range(from + 1, to));
    // 公式原文（不含那个头字符，`$…$` 时头字符就是 `$`）的起点：
    // 两侧的空格也一并算进去，传下去是给点击定位用的（见 widgets.ts 的 placeMathCaret）
    const contentFrom = from + 1;
    decos.push(
        Decoration.widget({
            widget: new InlineMathWidget(
                tex,
                contentFrom,
                contentFrom + tex.length,
                fallbackText ?? null
            ),
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
 * **中文（CJK）标点字符集**：纯文字判定里要放过的标点，按 Unicode 区间列出。
 *
 * 分三组：
 *
 * 1. `U+3000–U+301F`、`U+3030` —— CJK Symbols and Punctuation 块：
 *    全角空格、顿号 `、`、句号 `。`、反复号 `〃々〆`、各类书名号 / 引号 / 括号
 *    （`〈〉《》「」『』【】〔〕〖〗`）、波浪号 `〜`、`〰` 等；
 * 2. 与中文排版共用的通用标点：破折号区间 `–—―`、弯引号 `‘’“”`、
 *    省略号 `…`、间隔号 `·‧・`（中文人名 / 书名常用）；
 * 3. 全角 ASCII 标点里**非数学**的那些：`！＂＃％＆＇（），－．／：；？［］｛｜｝～･￥`。
 *
 * 第 3 组为什么是零散区间而不是整段 U+FF00–FFEF：全角区块里混着
 * `＄`（美元定界符）、`＊＋＜＝＞＼＾＿｀` 这些数学形状字符，
 * `` `A＿B` ``（全角下划线）这类罕见写法保持「当公式」的旧行为，
 * 只放过中文行文里真正会出现的标点。ASCII 的 `_ ^ \ { } ~` 同理不放进来 ——
 * 那是 `` `A_e` `` 要出下标的既定判据，半角 / 全角在这里按字符区分。
 *
 * 字符串里写的是 `\uXXXX` 转义（拼进正则字符类），不直接写中文原字，
 * 避免源码编码误转之后区间边界被破坏（本仓库有过 UTF-8→GBK 的乱码历史）。
 */
const CJK_PUNCTUATION =
    '\\u3000-\\u301F\\u3030' + // CJK 标点块：顿号句号、引号括号、波浪线
    '\\u2013-\\u2015\\u2018-\\u201F\\u2026\\u00B7\\u2027\\u30FB' + // 破折号、弯引号、省略号、间隔号
    '\\uFF01-\\uFF03\\uFF05-\\uFF09\\uFF0C-\\uFF0F\\uFF1A-\\uFF1B\\uFF1F' + // ！＃％（），－．／：；？
    '\\uFF3B\\uFF3D\\uFF5B-\\uFF5E\\uFF65\\uFFE5'; // ［］｛｜｝～･￥

/**
 * 「纯文字」：整个内容只有**各国文字、数字、空白和中文标点**，没有别的字符。
 *
 * ```
 * `code`   `整格代码`   `hello world`   `v2`                ← 纯文字，不渲染（行内代码原样）
 * `E101 重损，很确定。`   `见第 3．2 节`   `5～10 天`          ← 带中文标点的行文，不渲染
 * `A_e`    `lnw_i`      `\frac{a}{b}`   `x^2`               ← 有数学记号，渲染
 * ```
 *
 * 为什么要这一条：反引号里的内容一律按公式渲染之后，`` `code` `` 这种显然是一段文字的
 * 东西也被 KaTeX 排成了斜体数学（2026-09-21 反馈：这一档要削掉）。判据只能是「有没有
 * 数学记号」—— 纯字/数字/空白里出现不了上下标、命令、算符，所以是安全的。
 *
 * 2026-09-22 补充：中文行文里标点是标配（`重损，很确定。`），标点本身不是数学记号，
 * 于是把 CJK_PUNCTUATION 也并入字符类 —— 带 `，。、！？：；""《》（）～…—·` 等
 * 标点的纯文字格子同样豁免（标点清单见 CJK_PUNCTUATION 的注释）。
 *
 * 注意半角 `_` `^` `\` `{` 这些都**不算**纯文字：`` `user_id` `` 仍会渲染成 user 下标 id，
 * 这是「多字母下标变量（`` `lnw_i` ``）也要出下标」的既定代价，两者形状上分不开。
 */
const PLAIN_TEXT_SHAPE = new RegExp(`^[\\p{L}\\p{N}\\s${CJK_PUNCTUATION}]+$`, 'u');

/**
 * 「纯数字形状」：整个内容由**数字与数字写法的标点**组成。
 *
 * ```
 * `0.000000`   `1,234.56`   `-1.5`   `50%`   ← 数字，不渲染
 * ```
 *
 * 为什么不能只靠 PLAIN_TEXT_SHAPE：小数点 `.`、千分位逗号 `,`、正负号、`%`
 * 都不属于「文字 / 数字 / 空白」，`0.000000` 因此漏网被 KaTeX 当公式渲染
 * （2026-09-22 反馈：这一档不该渲染）。这些字符一旦和数字组成**整段**，
 * 只可能是数值而不是公式。
 *
 * 字符类里各字符的用途：`.` 小数点、`,` 千分位、`+`/`-` 正负号、
 * `%` 百分号（`%` 在 LaTeX 里还是注释符，误当公式还会把后面内容吞掉）。
 * 两侧的 `\p{N} … \p{N}` 保证**至少含一个数字**，免得单个 `%` 或 `+`
 * 被误判进来。科学计数法 `1e-3` 含字母、不在这一档（仍按公式渲染）。
 */
const NUMBER_SHAPE = /^[\p{N}.\s,+%-]*\p{N}[\p{N}.\s,+%-]*$/u;

/**
 * 行内代码里写的公式，两种写法都认：
 *
 * 1. 带定界符：`` `$$公式$$` ``、`` `$公式$` `` —— 只渲染被定界符括住的那一段，
 *    反引号里其余的文字照旧当代码（`` `见 $\frac{1}{2}$ 这个式子` ``）；
 * 2. **不带定界符：整个反引号内容就是公式**（2026-09-21 用户要求「等同于 `$ $`」），
 *    只有**纯文字**不算 —— 见 PLAIN_TEXT_SHAPE。
 *
 * 第 2 条以前是保守的白名单（只认「一个字母 + 上下标」，怕把 `user_id` 渲成公式），
 * 现在撤了：`` `\frac{a}{b}` ``、`` `\hat{y}` ``、`` `n \to \infty` ``、`` `lnw_i` ``
 * 一律按公式渲染。
 *
 * 撤掉白名单之后还剩两处**不等同** `$…$`：
 * - **纯文字 / 纯数字**（`` `code` ``、`` `整格代码` ``、`` `hello world` ``、
 *   `` `E101 重损，很确定。` ``、`` `0.000000` ``、`` `1,234.56` ``、`` `50%` ``）
 *   不渲染，原样当代码（判据见 PLAIN_TEXT_SHAPE / NUMBER_SHAPE；纯文字允许夹带
 *   中文标点，标点清单见 CJK_PUNCTUATION）；
 * - KaTeX 认不出来的内容（`` `a_b_c` `` 的双下标、`` `C:\Users\pc` `` 里的未定义命令
 *   `\Users`）不摆红字报错，而是退回原样的代码文本 —— 反引号里的东西首先是代码，
 *   猜错了就该看起来跟没开这个功能一样，见 InlineMathWidget 的 fallbackText
 *   和那个探针色 MATH_PROBE_COLOR。
 *
 * 行内代码平时是**原样显示**的（内容不参与任何 Markdown 渲染），只有公式破例渲染成
 * KaTeX。除公式以外的部分——包括反引号带来的底色、等宽字体、点击进源码——全都保持
 * 行内代码本来的样子（公式 widget 就嵌在那个底色盒子里，连字号都跟着 0.95em 走，
 * 所以「不影响本身的大小」）。
 *
 * 第 1 条的两种定界合并成一条正则、**按先长后短的顺序匹配**（`$$x$$` 不能被拆成两个单 `$` 的式子）。
 * 单个 `$` 那一路比双美元保守，几道口子都是为了别把普通行内代码误判成公式：
 * - 前后不能再挨着 `$`（`$$$` 不认）；
 * - **内容里不许有换行**：跨行的 `$…$` 十有八九是两处不相干的美元符号；
 * - 收尾 `$` 后面不许紧跟**数字**：`$5 到 $10` 这种价格区间不会被当成公式；
 * - 内容允许两侧留空格（`$ x $`），空格不算进公式。
 *
 * **要不要让开，看的是光标在不在这一格里，不看聚焦区间。**
 * 别的收集器都是「这一段正在编辑就整段显示原文」，行内代码不能这么办：
 * 一格就是一个独立的盒子，用户在同一个段落的别处打字，不该让这一格从公式闪回源码。
 *
 * 产出的是 mark + 行内 widget，所以跟着「按窗口算」的那一遍走。
 *
 * @param state - 编辑器状态
 * @param decos - 待写入的装饰数组
 * @param range - 渲染窗口
 * @param tree - 当前语法树
 * @returns void，结果直接 push 进 decos
 */
export function collectCodeSpanMathDecorations(
    state: EditorState,
    decos: DecoArray,
    range: ILineRange,
    tree: Tree
): void {
    // 两路并成一条正则：第一个分支是 `$$…$$`（先试），第二个是单个 `$…$`。
    // 捕获组 1 = 双美元的内容，捕获组 2 = 单美元的内容。
    // 注意：这是拿**内容**去匹配的（下面先掐掉了反引号），match.index 也得按内容起点换算。
    const codeSpanMath = /\$\$([^$]+?)\$\$|(?<!\$)\$(?!\$)\s*([^$\n]+?)\s*\$(?!\$|\d)/g;

    tree.iterate({
        from: range.from,
        to: range.to,
        enter: (nodeRef): boolean | void => {
            const { from, to, name } = nodeRef;
            if (name !== 'InlineCode') return;
            // **只有光标 / 选区真的落进这一格**，这一格才回原文。
            // 这里不能拿聚焦区间（focusedRange）判 —— 那是「整段」的粒度，
            // 用户在句尾「见 §9.6」那点一下，前面的 `A_e` 就跟着从下标形式闪回源码，
            // 而他要的是「点哪一格才动哪一格」（2026-09-21 反馈）。
            // 注意区间是闭开式的：光标停在反引号**前**（from）算「在格外面」，照旧渲染公式。
            const sel = state.selection.main;
            // 行级强制区间（待选 / 钉住）覆盖本行时同样回原文，
            // 否则整行都源码了、反引号里还套着一个公式 widget，看着不像源码
            if ((sel.from < to && sel.to > from) || isForcedSourceRange(state, from, to)) return false;

            // 节点区间是连**反引号一起**的，先把开头/结尾那两串反引号掐掉，
            // 拿到的才是「内容」的准确区间（点击定位、压 0 宽都按它来）。
            // （支持 ``` `` ``` 那种多反引号写法，所以是 `+` 不是单个。）
            const text = state.doc.sliceString(from, to);
            const openTicks = /^`+/.exec(text)?.[0].length ?? 0;
            const closeTicks = /`+$/.exec(text)?.[0].length ?? 0;
            const contentFrom = from + openTicks;
            const contentTo = to - closeTicks;
            if (contentFrom >= contentTo) return false;
            const content = text.slice(openTicks, text.length - closeTicks);

            // ---- 带定界符的两路（`$$…$$` / `$…$`）：只动被括住的那几段 ----
            if (content.includes('$')) {
                codeSpanMath.lastIndex = 0;
                let match: RegExpExecArray | null;
                while ((match = codeSpanMath.exec(content)) !== null) {
                    // 走哪个分支看是哪个捕获组有值
                    const tex = (match[1] ?? match[2] ?? '').trim();
                    if (!tex) continue;
                    // index 是相对 content 的，加上内容起点才是文档位置
                    const mathFrom = contentFrom + match.index;
                    // 兜底文案给整段 `$…$`（不含反引号）：真认不出来时，
                    // 这一格看起来就跟普通行内代码一模一样
                    pushInlineMath(decos, mathFrom, mathFrom + match[0].length, tex, match[0]);
                }
                return false;
            }

            // ---- 不带定界符的一路：整个内容就是公式，等同 `$…$` ----
            // 除了两种「显然不是公式」的形状：
            // 1. **纯文字**：`` `code` ``、`` `整格代码` ``、`` `hello world` ``、
            //    `` `E101 重损，很确定。` ``，只有字/数字/空白/中文标点
            //    （标点范围见 CJK_PUNCTUATION）；
            // 2. **纯数字**：`` `0.000000` ``、`` `1,234.56` ``、`` `-1.5` ``、`` `50%` ``
            //    —— KaTeX 排得出数学数字，但用户要的是数值原样（2026-09-22 反馈）。
            if (PLAIN_TEXT_SHAPE.test(content) || NUMBER_SHAPE.test(content)) return false;

            // 和 `$…$` 完全一样地压：头一个字符压 0 宽、公式夹在中间 ——
            // 这样 widget 落在**行内代码盒子里**，底色和 0.95em 字号都跟着走。
            // 兜底文案就是内容本身（不含反引号），失败时显示成原来的代码文本。
            pushInlineMath(decos, contentFrom, contentTo, content, content);
            return false;
        },
    });
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
