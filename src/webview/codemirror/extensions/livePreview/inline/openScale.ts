/**
 * 行内元素「展开态」的宽度换算：把 `**加粗**` 这种源码串，压回它渲染态占的那点宽度。
 *
 * 分两件事，都在这个文件里：
 *
 * 1. **元素结构**（`describeOpenElement`）：一个行内节点展开之后，哪几段是标记符、
 *    哪一段是内容、哪一段继续隐藏（链接地址）。链接是特例：`](地址)` 往往比链接文字
 *    长好几倍，整段露出来会把整行推出去很远，所以光标停在链接文字里时只露 `[文字]`。
 *
 * 2. **宽度补偿**（`computeOpenScales`，一次一批）：展开态是纯文本，比渲染态宽得多，于是整体
 *    挂一个 `font-size: 缩放`，让「标记 + 内容」的总宽度落回渲染态的宽度上；
 *    字号只能把宽度定到「台阶」上（中文步进会被光栅化量化到整数像素），
 *    台阶之间的零头再用一点点字距抹平。
 *
 * 宽度必须**用真实排版量、并且是正文那一套字体**（见 layoutMetrics 与
 * helpers.getMeasureContext）：宽度对字号、字重、字体族都极其敏感
 * （同一个汉字 14px/400 是 14px、14px/700 是 15px），量错一套字体，
 * 算出来的缩放档位就跟着错。**短元素受这个影响最大**：它的标记符占了源码的
 * 大半，缩放需求本来就卡在可读性下限上，没有任何余量去吸收偏差。
 *
 * @module webview/codemirror/extensions/livePreview/openScale
 */

import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { getMeasureContext } from '../measure/textMeasure.js';
import { fontSpec, MeasureBatch } from '../decor/layoutMetrics.js';

/**
 * 行内格式节点 → 标记子节点名、渲染态字重、渲染态额外宽度、以及「是不是行内代码」。
 *
 * `weight` / `extraWidth` 只用来算「渲染态有多宽」（也就是宽度补偿的目标值）：
 * 加粗要按 700 量、行内代码要加上左右各 6px 的内边距。
 * `weight` 留空表示「跟正文一个粗细」（正文的字重是用户可调的，见 --livewritemd-font-weight）。
 *
 * 这里的映射必须和 plugin.ts / styles.ts 里渲染态的处理保持一致，改一边要记得改另一边。
 */
const INLINE_FORMATS: Record<
    string,
    {
        markNames: string[];
        /** 渲染态的字重；空串表示跟随正文 */
        weight: string;
        extraWidth: number;
        /** 是不是行内代码（渲染态等宽字体 + 0.95em 字号，展开时也要用同一个字号）。 */
        code?: boolean;
    }
> = {
    // **加粗**：渲染态是粗体，粗体字宽和正文不一样，测宽时要带上字重。
    // 其余几种不改字重，跟正文一个粗细（见 styles.ts：斜体只变色不倾斜、删除线只加一条线）
    StrongEmphasis: { markNames: ['EmphasisMark'], weight: '700', extraWidth: 0 },
    // *斜体*
    Emphasis: { markNames: ['EmphasisMark'], weight: '', extraWidth: 0 },
    // ~~删除线~~
    Strikethrough: { markNames: ['StrikethroughMark'], weight: '', extraWidth: 0 },
    // `行内代码`：渲染态是等宽字体、字号 0.95em，还有 2px 6px 的内边距（左右共 12px）。
    // 展开时**用同一个字号**（见 pickOpenScale 的 code 分支）：
    // 这 12px 底色内边距正好替两个反引号「付过账」了，源串只比渲染态宽几个像素，
    // 收紧一点字距就能对齐——字号一动，点进去的那一下就像字突然变小/变大了。
    InlineCode: { markNames: ['CodeMark'], weight: '', extraWidth: 12, code: true },
};

/**
 * 行内代码渲染态的字号倍率（em）。
 *
 * 必须和 styles.ts 的 `.cm-md-code { font-size: 0.95em }` 保持一致：
 * 量「渲染态有多宽」用它，展开时保持同一个字号也用它。
 * openWrap.ts（跨行补偿）也要用它拼渲染态的目标宽度，所以导出。
 */
export const INLINE_CODE_FONT_EM = 0.95;

/**
 * 展开态允许的最小缩放比例。
 *
 * 展开态是**纯文本**（不带加粗/等宽渲染），所以源串比渲染态宽得多，
 * 极短元素（如 `**加粗**`：6 个字符要挤进 2 个汉字的位置）理论缩放只有 0.56 左右。
 * 下限压到 0.55 就是为了让这类短元素也能真正零位移；再小就糊成一团了。
 */
const MIN_OPEN_SCALE = 0.55;

/**
 * 展开态每个字符允许收紧的最大字距（px）。
 *
 * 字号缩放是「台阶式」的（中文步进被光栅化量化到整数像素），台阶之间的零头
 * 靠负字距抹平。上限设得比较克制：超过 1.5px 就开始明显挤字，宁可留一点位移。
 */
const MAX_LETTER_TIGHTEN_PX = 1.5;

/** 候选缩放的步进：0.005。太稀会正好错过能对上的那一档字号。 */
const OPEN_SCALE_STEP = 0.005;

/**
 * 判断是不是需要「就地展开」的行内格式节点。
 *
 * 注意：**Link 不在这套体系里**。链接（只支持内联 `[text](url)`）
 * 的括号显隐走 plugin.ts 主遍历的独立逻辑，不参与点击展开、宽度缩放，
 * 也不会在拖选整行时被缩小——否则 `[i]`（如数组下标）会被误收进
 * 宽度补偿而变小。
 */
export function isInlineFormatNode(name: string): boolean {
    return name in INLINE_FORMATS;
}

/** 一个行内元素展开成源码所需的全部信息。 */
export interface OpenElementInfo {
    /** 元素整体范围 */
    from: number;
    to: number;
    /** 内容区间（首尾标记之间） */
    contentFrom: number;
    contentTo: number;
    /** 各标记符区间 */
    marks: Array<{ from: number; to: number }>;
    /** 仍然保持隐藏的区间（链接地址那一段） */
    hidden: Array<{ from: number; to: number }>;
    /** 做宽度换算用的字重（渲染态的字重，用来量目标宽度）；空串表示跟随正文 */
    weight: string;
    /** 渲染态比源码多出来的固定宽度（行内代码的内边距） */
    extraWidth: number;
    /** 是不是行内代码（渲染态等宽字体 + 0.95em 字号） */
    code: boolean;
}

/**
 * 把一个行内元素节点拆成「标记 + 内容」两段。
 *
 * 链接是特例：`](地址)` 往往比链接文字长好几倍，整段露出来会把整行推出去很远。
 * 所以光标停在链接文字里时只露 `[文字]`，地址那段继续隐藏（宽度补偿才补得回来）；
 * 光标真的移进地址里了，才把整段展开给你改地址。
 *
 * @param state - 编辑器状态，用来读源码文本
 * @param node - 行内元素节点
 * @param caret - 光标/选区活动端的位置，用来判断链接该露出多少
 * @returns 展开所需信息；结构不完整（比如没配对的标记）时返回 null
 */
export function describeOpenElement(
    state: EditorState,
    node: SyntaxNode,
    caret: number
): OpenElementInfo | null {
    const from = node.from;
    const to = node.to;

    if (node.name === 'Link') {
        const marks = node.getChildren('LinkMark');
        if (marks.length < 2) return null;
        const openMark = marks[0];
        const closeMark = marks[1];
        // 光标在链接文字区间内（含两端）→ 只露 `[文字]`，`](地址)` 保持隐藏。
        // 两端也算：点在文字最前面或最后面时也应该只露中括号。
        //
        // 地址只在**光标真的落在这个链接里面、而且落在文字以外**时才露。
        // 光标在元素之外不算 —— 那多半是「拖选顺带扫过这个链接」，
        // 地址露出来会把整行推出去好几倍，再被缩放压到字号下限，
        // 用户看到的就是「选了一行，这行突然糊了」。要改地址就把光标挪进地址里。
        const caretInText =
            caret < from ||
            caret > to ||
            (caret >= openMark.to && caret <= closeMark.from);
        return {
            from,
            to,
            contentFrom: openMark.to,
            contentTo: closeMark.from,
            // 只露 `[文字]` 两个中括号；地址那段（含它前面的 `(`）继续隐藏
            marks: caretInText
                ? [
                      { from: openMark.from, to: openMark.to },
                      { from: closeMark.from, to: closeMark.to },
                  ]
                : [
                      { from: openMark.from, to: openMark.to },
                      { from: closeMark.from, to },
                  ],
            hidden: caretInText ? [{ from: closeMark.to, to }] : [],
            weight: '',
            extraWidth: 0,
            code: false,
        };
    }

    const format = INLINE_FORMATS[node.name];
    if (!format) return null;

    const marks: Array<{ from: number; to: number }> = [];
    for (const markName of format.markNames) {
        for (const mark of node.getChildren(markName)) {
            marks.push({ from: mark.from, to: mark.to });
        }
    }
    if (marks.length < 2) return null;

    return {
        from,
        to,
        contentFrom: marks[0].to,
        contentTo: marks[marks.length - 1].from,
        marks,
        hidden: [],
        weight: format.weight,
        extraWidth: format.extraWidth,
        code: format.code === true,
    };
}

/**
 * 把字距夹在允许范围内。
 *
 * 字号只能把宽度定到「阶梯」上（中文步进会被量化），剩下的零头用字距微调吃掉：
 * 元素里每个字符收紧/放松一点点，总宽度就能精确落到目标上。
 * 上限 MAX_LETTER_TIGHTEN_PX 是为了不把字挤成一团。
 *
 * @param residual - 还差多少像素
 * @param totalChars - 参与摊派的字符数
 * @returns 每个字符要加的字距（px）
 */
function clampLetterSpacing(residual: number, totalChars: number): number {
    if (totalChars <= 0) return 0;
    return Math.max(
        -MAX_LETTER_TIGHTEN_PX,
        Math.min(MAX_LETTER_TIGHTEN_PX, residual / totalChars)
    );
}

/**
 * 展开态缩放结果缓存。
 *
 * 这个计算要在一批候选字号上逐个量字宽（中文步进被量化到整数像素，只能实测），
 * 一个元素近百次。光标停在同一个元素里打字时，每个按键都会重算一遍 ——
 * 内容没变（比如在元素外面回车）就完全没必要。
 * key = 展开态文字 + 内容 + 字体 + 内边距 + 字号字体，算完就存着。
 */
const openScaleCache = new Map<string, { scale: number; letterSpacing: number }>();

/** 内存统计用：缩放补偿缓存条目数。 */
export function openScaleCacheSize(): number {
    return openScaleCache.size;
}

/**
 * 展开态真正会显示出来的那串文字（标记 + 内容）。
 *
 * 按文档位置排序后拼接，不是把标记符简单并在一起：链接展开后是 `[文字](`，
 * 顺序错了宽度就不对（相邻字符之间有字距调整）。隐藏的部分（链接地址）在展开态
 * 是 0 宽，不参与。
 *
 * @param state - 编辑器状态
 * @param info - 元素的展开信息
 * @returns 展开后会显示的文字
 */
export function openSourceText(state: EditorState, info: OpenElementInfo): string {
    const pieces = [
        { from: info.contentFrom, to: info.contentTo },
        ...info.marks.map((mark) => ({ from: mark.from, to: mark.to })),
    ].sort((a, b) => a.from - b.from);
    return pieces.map((piece) => state.doc.sliceString(piece.from, piece.to)).join('');
}

/**
 * 普通行内元素的候选缩放档位：从 1 一路排到可读下限，步进 OPEN_SCALE_STEP。
 *
 * 模块级算一次、所有元素共用：档位只跟 MIN_OPEN_SCALE / STEP 两个常量有关，
 * 跟具体元素无关，放在每次计算里重建属于白造垃圾。
 * 行内代码不缩字号（固定 0.95em），它不用这份表，见 INLINE_CODE_SCALES。
 * 两张表都导出：openWrap.ts（跨行补偿）的折行模拟要用同一批候选档位。
 */
export const OPEN_SCALES: number[] = buildScales(1);

/** 行内代码的候选档位：从 0.95em 起（它的渲染态字号），最多再往下缩一点点。 */
export const INLINE_CODE_SCALES: number[] = buildScales(INLINE_CODE_FONT_EM);

/**
 * 按步进列出候选缩放（从大到小，夹在 [MIN_OPEN_SCALE, startScale] 之间）。
 *
 * 夹到下限之后会出现重复值，去个重，省得白量同一档。
 *
 * @param startScale - 最大的候选值（普通元素 1，行内代码 0.95）
 * @returns 候选缩放，按从大到小排列
 */
function buildScales(startScale: number): number[] {
    const scales: number[] = [];
    for (let value = startScale; value >= MIN_OPEN_SCALE - 1e-6; value -= OPEN_SCALE_STEP) {
        const scale = Math.max(MIN_OPEN_SCALE, Math.round(value * 1000) / 1000);
        if (!scales.includes(scale)) scales.push(scale);
    }
    return scales;
}

/**
 * 从一个元素量好的宽度里挑一档缩放，并把剩下的零头摊成字距。
 *
 * 挑法（跟推导有关的部分见 computeOpenScales 的说明）：
 * - 普通元素：挑实际宽度最接近渲染态的那一档。候选是从大到小排的，所以「偏差相同」
 *   时先遇到的就是更大的字号（可读性优先）。
 * - 行内代码：从头往下找第一个「字距兜得住」的档位。绝大多数情况第一轮就命中，
 *   字号和渲染态一模一样；只有差十几像素的极端情况才再缩一点点（能少缩就少缩，
 *   绝不会掉到 MIN_OPEN_SCALE 那种「字突然变小」的程度）。
 *
 * @param info - 元素的展开信息（要用它判断是不是行内代码）
 * @param totalChars - 展开态显示的字符数（摊字距用）
 * @param target - 渲染态宽度（已经加过内边距）
 * @param widths - 各候选档位下量出来的实际宽度，与候选表一一对应
 * @returns 缩放的 em 倍率和补偿字距（px）
 */
function pickOpenScale(
    info: OpenElementInfo,
    totalChars: number,
    target: number,
    widths: number[]
): { scale: number; letterSpacing: number } {
    const scales = info.code ? INLINE_CODE_SCALES : OPEN_SCALES;
    if (!(target > 0)) return { scale: 1, letterSpacing: 0 };

    if (info.code) {
        const cap = MAX_LETTER_TIGHTEN_PX * Math.max(1, totalChars);
        for (let i = 0; i < scales.length; i++) {
            const residual = target - widths[i];
            if (Math.abs(residual) <= cap) {
                return { scale: scales[i], letterSpacing: clampLetterSpacing(residual, totalChars) };
            }
        }
        return { scale: MIN_OPEN_SCALE, letterSpacing: 0 };
    }

    let bestIndex = 0;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let i = 0; i < scales.length; i++) {
        const delta = Math.abs(widths[i] - target);
        if (delta < bestDelta - 0.01) {
            bestDelta = delta;
            bestIndex = i;
        }
    }

    // 剩下的零头用字距微调吃掉。
    //
    // 注意失败方向：字距收紧有上限（MAX_LETTER_TIGHTEN_PX），所以只有「连最小字号
    // 都还比渲染态宽」时才对不齐，而且那一侧是**偏宽**——元素绝不会展开之后比原来窄。
    // 反过来放宽是够用的，所以偏窄这种情况不会出现。
    return {
        scale: scales[bestIndex],
        letterSpacing: clampLetterSpacing(target - widths[bestIndex], totalChars),
    };
}

/** 一个元素「登记了哪些要量的东西」，flush 之后按这些下标取宽度。 */
interface IOpenMeasureJob {
    /** 在入参数组里的下标（返回值要按这个顺序摆） */
    index: number;
    /** 缓存 key：算完就按它存起来 */
    key: string;
    info: OpenElementInfo;
    /** 展开态显示的字符数 */
    totalChars: number;
    /** 目标宽度登记在批次里的下标 */
    targetIndex: number;
    /** 各候选档位登记在批次里的下标，与候选表一一对应 */
    scaleIndices: number[];
}

/**
 * 一次算出**一批**行内元素的展开缩放：让「标记 + 内容」的总宽度落到渲染态的宽度上。
 *
 * 推导很简单——渲染态只有内容占宽，展开态多了标记符，于是
 * `缩放 × (标记宽 + 内容宽) ≈ 渲染态内容宽`，解出缩放即可。
 * 结果夹在 [MIN_OPEN_SCALE, 1] 之间：不会放大，也不会小到看不清。
 *
 * 行内代码是例外：**展开态直接用渲染态的字号**（0.95em，见 INLINE_CODE_FONT_EM），
 * 宽度差全靠字距抹平。它渲染态那 12px 底色内边距已经替两个反引号「付过账」了，
 * 源串只多几个像素，收紧一点字距就够——字号一动，点进去的那一下就像字跳了一下。
 *
 * 为什么按批而不是按元素：一个元素要量近百个候选字号，量一次就要强制一次布局
 * （见 MeasureBatch）。拖选会让整块退回源码，一块里往往有好几个元素 ——
 * 一个元素一个批次的话，整块要付「元素数 × 2」次强制布局；合成一批只付 1 次。
 * 缓存命中的元素直接跳过，连 span 都不挂。
 *
 * @param state - 编辑器状态
 * @param infos - 这批元素的展开信息（顺序即返回顺序）
 * @returns 与 infos 等长的「缩放的 em 倍率 + 补偿字距（px）」
 */
export function computeOpenScales(
    state: EditorState,
    infos: OpenElementInfo[]
): Array<{ scale: number; letterSpacing: number }> {
    const results: Array<{ scale: number; letterSpacing: number } | null> = infos.map(() => null);
    if (infos.length === 0) return [];

    const measureCtx = getMeasureContext();
    const baseSize = measureCtx?.size ?? 14;
    const family = measureCtx?.family ?? 'monospace';
    const codeFamily = measureCtx?.codeFamily ?? family;
    // 正文的字重（用户可调）、以及这个元素渲染态的字重。展开态是纯文本，
    // 用的就是正文字重；「跟随正文」的几种（斜体、删除线、链接、行内代码）也用它。
    const textWeight = measureCtx?.weight ?? '400';
    /** 展开态是纯文本，只有字号在变：`font-size: baseSize × scale`。 */
    const sourceStyle = (scale: number): string =>
        fontSpec(textWeight, 'normal', baseSize * scale, family);

    const batch = new MeasureBatch();
    const jobs: IOpenMeasureJob[] = [];

    infos.forEach((info, index) => {
        const sourceText = openSourceText(state, info);
        const contentText = state.doc.sliceString(info.contentFrom, info.contentTo);
        // 源码串或内容为空（比如 `****`）：没什么可补的，原样
        if (!sourceText || !contentText) {
            results[index] = { scale: 1, letterSpacing: 0 };
            return;
        }
        const renderWeight = info.weight || textWeight;
        const key = [
            sourceText,
            contentText,
            renderWeight,
            textWeight,
            info.extraWidth,
            info.code,
            baseSize,
            family,
            codeFamily,
        ].join('|');
        const cached = openScaleCache.get(key);
        if (cached) {
            results[index] = cached;
            return;
        }

        // 渲染态宽度 = 内容按**渲染态那套字体**排出来有多宽：加粗按 700，
        // 行内代码换等宽字体、字号 0.95em，还要加上左右各 6px 的底色内边距
        // （见 styles.ts 的 .cm-md-code）。
        const targetIndex = batch.add(
            contentText,
            info.code
                ? fontSpec(textWeight, 'normal', baseSize * INLINE_CODE_FONT_EM, codeFamily)
                : fontSpec(renderWeight, 'normal', baseSize, family)
        );
        // 各候选字号下的源码宽度。展开态是纯文本、字号整体缩放，所以直接量
        // 「标记 + 内容」这一整串，不比拆开量再相加差。
        const scales = info.code ? INLINE_CODE_SCALES : OPEN_SCALES;
        const scaleIndices = scales.map((scale) => batch.add(sourceText, sourceStyle(scale)));
        jobs.push({ index, key, info, totalChars: sourceText.length, targetIndex, scaleIndices });
    });

    if (jobs.length > 0) {
        const widths = batch.flush(); // 整批只在这里强制一次布局
        for (const job of jobs) {
            const target = widths[job.targetIndex] + job.info.extraWidth;
            const candidates = job.scaleIndices.map((i) => widths[i]);
            const result = pickOpenScale(job.info, job.totalChars, target, candidates);
            if (openScaleCache.size > 300) openScaleCache.clear();
            openScaleCache.set(job.key, result);
            results[job.index] = result;
        }
    }

    return results.map((result) => result ?? { scale: 1, letterSpacing: 0 });
}
