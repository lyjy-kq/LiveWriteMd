/**
 * 跨行（软折行）行内元素的展开宽度补偿。
 *
 * ## 和单行补偿（openScale.ts）是什么关系
 *
 * 单行补偿把目标定成「一维宽度」：缩放后源码串的**自然宽度** == 渲染态内容的自然宽度。
 * 元素被软折行拆成多个视觉行时这个目标不够用——即使总宽相等，每一行「塞不满的余量」
 * 会让末行右端偏掉、甚至行数 ±1，元素后面的文字照样被推走。所以这里把目标升级成
 * **二维几何**：视觉行数不变 + 末行右端不变。
 *
 * 做法是**用真实排版模拟折行**：把「元素之前的渲染态文字（前缀）+ 待量的那段」
 * 放进一个宽度恰为正文折行宽度的隐藏容器里，让浏览器自己折，再读探针占了几个
 * 视觉行、末行右端在哪。前缀必须一起进模拟：折行是级联的，元素首行能占多宽
 * 由前缀占掉多少决定；而且两边模拟用同一份前缀，「首行起点不变」这条约束就
 * 结构性地自动成立。
 *
 * 两边都从模拟量、不从 DOM 读真实布局——查过 @codemirror/view 源码：
 * ViewPlugin.update 期间 `coordsAtPos` 会直接抛 "Reading the editor layout
 * isn't allowed during an update"，而装饰重建恰恰发生在 update 里。对称模拟还有个
 * 附赠好处：系统性偏差两边同向，大部分互相抵消。
 *
 * ## 安全边界（历史教训）
 *
 * - **绝不碰 layoutMetrics.MeasureBatch 和 openScale.computeOpenScales**：
 *   那是所有元素共用的量宽探针，上次把它们改成「按折行量」污染了全部装饰计算，
 *   整篇退化成纯文本。本模块自建容器、自管缓存，与单行路径互不接触。
 * - 本函数整体包 try/catch：任何异常只让**本元素**回退单行算法，装饰集绝不丢。
 * - 前提不满足（wordWrap 没开、标题/列表/表格行、跨硬换行、行内混着公式图片……）
 *   一律回退单行算法，那是逐像素验证过的路径，不许因为新路径回归。
 *
 * @module webview/codemirror/extensions/livePreview/openWrap
 */

import type { EditorState } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';
import { EditorView } from '@codemirror/view';
import { getMeasureContext } from './helpers.js';
import { fontSpec } from './layoutMetrics.js';
import { availableTableWidth } from './tableRender.js';
import {
    describeOpenElement,
    INLINE_CODE_FONT_EM,
    INLINE_CODE_SCALES,
    isInlineFormatNode,
    OPEN_SCALES,
    openSourceText,
} from './openScale.js';
import type { OpenElementInfo } from './openScale.js';

/**
 * 字距补偿的上限（px/字符），沿用 openScale 的克制值：
 * 超过 1.5px 字就开始挤成一团，宁可末行留一点位移。
 */
const MAX_LETTER_SPACING_PX = 1.5;

/**
 * 字距斜率探针的步长（px）。
 *
 * 字距摊在**每个字符**上，但末行右端只动「末行字符数 × 字距」——不能用
 * 「零头 ÷ 总字符数」的单行算法去摊。所以先用一个小探针量出「每加这么多
 * 字距，末行右端实际动多少」（斜率），再解出目标字距。0.1px 对一整行 40 字
 * 也就 4px，不容易把折行点挤动，探针自身不改变行数时斜率才可信。
 */
const LETTER_SPACING_PROBE_PX = 0.1;

/** 残差小于这个值就不折腾字距了（亚像素级，肉眼不可见）。 */
const RESIDUAL_EPSILON_PX = 0.05;

/** 行内出现这些文字就不接管折行模拟：右到左文本的矩形会按方向拆分，行数读数不可信。 */
const RTL_PATTERN = /[\u0590-\u08FF]/;

/** 一段按某套字体渲染的文字：折行模拟容器的原子单元。 */
interface ISegment {
    text: string;
    /** cssText 片段，通常是 fontSpec 拼出的 font 简写（可能再附加内边距/字距） */
    css: string;
}

/** 折行模拟器的读数：探针占了几个视觉行、末行右端离容器左缘多远（px）。 */
interface IProbeRead {
    lines: number;
    endX: number;
}

/** 跨行补偿需要的排版环境：折行宽度 + 正文字体那一套。 */
export interface IOpenWrapContext {
    /** 正文一行的折行宽度（px）——`.cm-line` 文字区的宽 */
    width: number;
    /** 正文字号（px，用户可调缩放后的实际值） */
    size: number;
    /** 正文字体族 */
    family: string;
    /** 行内代码的等宽字体族（渲染态目标宽度用） */
    codeFamily: string;
    /** 正文字重（用户可调，--flowmd-font-weight） */
    textWeight: string;
    /** 画布上下文（已配好正文字体）：折行预判用它量宽，不触发布局 */
    canvas: CanvasRenderingContext2D;
    /** 编辑器视图：按真实 .cm-line 行盒量各上下文的折行宽度 */
    view: EditorView;
}

/**
 * 取跨行补偿的排版环境。
 *
 * 三样东西缺一不可：折行得开着（wordWrap 没开就没有「跨行」这回事）、
 * 折行宽度得量得到（视图还没挂进 DOM 时量不到）、正文字体得拿得到。
 *
 * 折行开关用 `.cm-content` 上的 `cm-lineWrapping` 类判断：
 * `EditorView.lineWrapping` 就是往 contentDOM 挂这个类（@codemirror/view 源码），
 * editor.ts 的 lineWrappingCompartment 一关它就没了。
 *
 * @returns 排版环境；任何前提不满足时返回 null，调用方全部回退单行算法
 */
export function createOpenWrapContext(): IOpenWrapContext | null {
    const contentEl = document.querySelector('#editor .cm-content');
    if (!contentEl || !contentEl.classList.contains('cm-lineWrapping')) return null;
    const measure = getMeasureContext();
    if (!measure) return null;
    // 折行宽度 = 正文文字区宽度 − 8。availableTableWidth() 已经扣掉了行号栏、
    // 行宽上限和 .cm-content 的左右内边距；这里再扣 .cm-line 的 padding: 0 4px
    // （theme.ts 里写的 0 4px，左右共 8px——改那边的话这里要跟着改）。
    const width = availableTableWidth() - 8;
    if (!(width > 100)) return null;
    const view = EditorView.findFromDOM(contentEl as HTMLElement);
    if (!view) return null;
    return {
        width,
        size: measure.size,
        family: measure.family,
        codeFamily: measure.codeFamily,
        textWeight: measure.weight,
        canvas: measure.ctx,
        view,
    };
}

/** 一个逻辑行的几何：以行 border-box 左缘为原点 */
interface ILineGeometry {
    /** 内容列相对行左缘的左内边距（padding-left + border-left） */
    insetL: number;
    /** 右内边距（padding-right + border-right） */
    insetR: number;
    /** 内容文字区宽度 = 行盒宽 − 左右内边距 */
    width: number;
}

/**
 * 量某个文档位置所在 `.cm-line` 的**完整几何**（以行 border-box 左缘为原点）。
 *
 * 为什么必须含 border、且统一以行左缘为原点：
 * 段落行只有普通 padding；但引用行带 3px 左边框 + 加大的左 padding（blockquote），
 * 内容列比行左缘右移约 20px。若只扣 padding、用 padding 后当原点，模拟块的
 * 坐标帧就和真实行错位约 17px，margin 反而把后缀推坏。
 * 让模拟块完全复刻这组内边距与宽度，两端坐标帧严格一致。
 *
 * @param ctx - 排版环境
 * @param pos - 元素内的文档位置
 * @returns 行几何；量不到返回 null，调用方用默认宽度兜底
 */
function measureLineGeometry(
    ctx: IOpenWrapContext,
    pos: number
): ILineGeometry | null {
    let dom: Node;
    try {
        dom = ctx.view.domAtPos(pos).node;
    } catch {
        return null;
    }
    const lineEl =
        dom instanceof Element ? dom.closest('.cm-line') : dom.parentElement?.closest('.cm-line');
    if (!lineEl) return null;
    const cs = getComputedStyle(lineEl);
    const insetL =
        (Number.parseFloat(cs.paddingLeft) || 0) + (Number.parseFloat(cs.borderLeftWidth) || 0);
    const insetR =
        (Number.parseFloat(cs.paddingRight) || 0) + (Number.parseFloat(cs.borderRightWidth) || 0);
    const width = lineEl.getBoundingClientRect().width - insetL - insetR;
    return width > 50 ? { insetL, insetR, width } : null;
}

/**
 * 量**当前真实渲染态**目标元素（.cm-md-bold 等）末行右端相对**本行 border-box 左缘**
 * 的距离。
 *
 * 这是补偿的**真实锚点**：直接读真实渲染元素（build 期间 DOM 尚未更新，仍是渲染态），
 * margin 才能把模拟器在列表/引用上下文的系统误差也一起纠正。
 *
 * 坐标帧：原点用「行 border-box 左缘」（含 border），与模拟器 endX（相对模拟块
 * 左缘）严格一致——模拟块完全复刻行的内边距与宽度。
 *
 * @param ctx - 排版环境
 * @param info - 元素展开信息（定位用）
 * @returns 真实末行右端距 + 视觉行数；元素当前未被渲染时返回 null
 */
function measureRenderedEndDist(
    ctx: IOpenWrapContext,
    info: OpenElementInfo
): { dist: number; lines: number } | null {
    let dom: Node;
    try {
        dom = ctx.view.domAtPos(info.contentFrom).node;
    } catch {
        return null;
    }
    // 从内容节点找真实渲染元素（任意一种渲染类），再找所在行
    const startEl = dom instanceof Element ? dom : dom.parentElement;
    const renderedEl = startEl?.closest(
        '.cm-md-bold,.cm-md-italic,.cm-md-strikethrough,.cm-md-code,.cm-md-link'
    );
    const lineEl = startEl?.closest('.cm-line');
    if (!renderedEl || !lineEl) return null;
    // 原点 = 行 border-box 左缘（不加 padding）；模拟块以同一位置为原点
    const lineLeft = lineEl.getBoundingClientRect().left;
    const rects = renderedEl.getClientRects();
    if (rects.length === 0) return null;
    // 渲染元素是纯文本 span，矩形数 = 视觉行数
    return { dist: rects[rects.length - 1].right - lineLeft, lines: rects.length };
}

/**
 * 祖先白名单：行内元素所在逻辑行允许的容器类型。
 *
 * - Paragraph：普通正文（含松散列表段落）；
 * - ListItem / List / OrderedList：列表行——bullet widget 的盒宽与 `- ` 严格相等
 *   （见 widgets.BulletWidget），有序序号渲染态本来可见，模拟模型成立；
 * - Blockquote：引用行——`> ` 两态都是 0 宽，可直接省略。
 * 其余（标题、表格、脚注定义等）模拟不了，拒绝。
 */
const ELIGIBLE_ANCESTORS = new Set([
    'Paragraph',
    'ListItem',
    // markdown 语法实际节点名是 BulletList / OrderedList（不是 List）
    'BulletList',
    'OrderedList',
    'Blockquote',
]);

/**
 * 判断一个行内元素能不能交给折行模拟接管。
 *
 * 只做「便宜」的判定（不碰 DOM、不量宽度）：
 * 1. 祖先链只允许 ELIGIBLE_ANCESTORS 里的容器；
 * 2. 元素必须完整落在一个逻辑行里——跨硬换行的元素在两个 .cm-line 里各自折行，
 *    「一个折行容器」的模型不成立；
 * 3. 行内不许混着 widget 化的东西（`$` 行内公式、`![]` 图片、`[^]` 脚注引用）
 *    或 Tab——widget 的占宽和文字宽度毫无关系，Tab 在 CM 里被换成定宽占位块；
 * 4. 行内不许出现右到左文字——双向文本的 client rects 按方向拆分，
 *    「矩形数 = 视觉行数」的读数不可信。
 *
 * @param state - 编辑器状态，用来查文档行
 * @param node - 待展开的行内元素节点
 * @returns 能接管时返回 true
 */
export function openWrapEligible(state: EditorState, node: SyntaxNode): boolean {
    if (!(node.from < node.to)) return false;
    // 祖先链：从元素的父节点一路往上，只放行白名单容器，直到 Document
    let current: SyntaxNode | null = node.parent;
    let sawDocument = false;
    while (current) {
        if (current.name === 'Document') {
            sawDocument = true;
            break;
        }
        if (!ELIGIBLE_ANCESTORS.has(current.name)) return false;
        current = current.parent;
    }
    if (!sawDocument) return false;
    // 完整落在一个逻辑行里
    const line = state.doc.lineAt(node.from);
    if (state.doc.lineAt(node.to - 1).number !== line.number) return false;
    if (
        line.text.includes('\t') ||
        line.text.includes('$') ||
        line.text.includes('![') ||
        // 脚注引用 `[^label]` 渲染态被替换成上标 widget（collectFootnoteDecorations）
        line.text.includes('[^') ||
        RTL_PATTERN.test(line.text)
    ) {
        return false;
    }
    return true;
}

/**
 * 把一段文档区间按**渲染态**切成字体分段（不含行首列表/引用结构标记，
 * 那些由外层 renderedSegments 统一处理）。
 *
 * 普通文字跟正文字体；行内元素的内容按它自己的渲染态字体
 * （加粗 700、行内代码等宽 0.95em + 左右 6px 底色内边距）；标记符和链接地址
 * 在渲染态是被 `hideDeco`（`Decoration.replace({})`）**整段抽掉**的
 * （见 plugin.ts 的 EmphasisMark/CodeMark/LinkMark 分支），所以这里也直接跳过、
 * 不占任何宽度、不制造断行机会——千万别做成 font-size:0 的零宽字符，
 * 零宽字符前后的断行机会和「字符不存在」不一样，会把折行模拟带偏。
 * 嵌套元素（`**`码`**` 的内层）按外层字体一整段量——是前缀宽度的一级近似，
 * 见分析文档三节的边界说明。
 *
 * @param state - 编辑器状态，用来读文档文本
 * @param tree - 当前语法树
 * @param from - 区间起点（文档位置）
 * @param to - 区间终点（文档位置）
 * @param ctx - 排版环境（字体那一套）
 * @returns 按文档顺序排好的字体分段
 */
function segmentsForRange(
    state: EditorState,
    tree: Tree,
    from: number,
    to: number,
    ctx: IOpenWrapContext
): ISegment[] {
    const segments: ISegment[] = [];
    if (from >= to) return segments;
    const bodyFont = fontSpec(ctx.textWeight, 'normal', ctx.size, ctx.family);
    // 读文字时夹在 [from,to] 内：边界节点的内部区间可能伸出范围
    const pushText = (f: number, t: number, css: string) => {
        const cf = Math.max(f, from);
        const ct = Math.min(t, to);
        if (cf < ct) segments.push({ text: state.doc.sliceString(cf, ct), css });
    };

    // 浅层行内元素：与 collectSourceModeInlineNodes 同一套收法——嵌套的只收最外层
    const nodes: SyntaxNode[] = [];
    tree.iterate({
        from,
        to,
        enter: (ref) => {
            // **边界必须严格**：CM 的 iterate 会把起点恰好等于 `to`（或终点恰等于
            // `from`）的节点也放进来。前缀区间是 [from,to)，不夹住就会把
            // 目标元素本身收进前缀（前缀里内容出现两次，全部折行读数作废）
            if (ref.from >= to || ref.to <= from) return false;
            if (!isInlineFormatNode(ref.name)) return;
            const covered = nodes.some((n) => n.from <= ref.from && ref.to <= n.to);
            if (covered) return false;
            nodes.push(ref.node);
            return false;
        },
    });
    nodes.sort((a, b) => a.from - b.from);

    let cursor = from;
    for (const node of nodes) {
        // caret 传 -1（必然小于元素起点）：前缀元素一定不含光标，
        // 链接按「只露文字」处理——渲染态正是这个样子
        const info = describeOpenElement(state, node, -1);
        if (!info) continue;
        pushText(cursor, node.from, bodyFont);
        // 元素内部按位置铺开：内容段（渲染态字体）；标记/隐藏段 css 为 null——
        // 渲染态它们被 hideDeco 整段抽掉，模拟时同样不产生任何文字
        const contentCss = info.code
            ? // 行内代码：等宽字体 + 0.95em + 左右各 6px 内边距（渲染态的底色盒）
              `${fontSpec(ctx.textWeight, 'normal', ctx.size * INLINE_CODE_FONT_EM, ctx.codeFamily)};padding:0 6px`
            : fontSpec(info.weight || ctx.textWeight, 'normal', ctx.size, ctx.family);
        const pieces: Array<{ f: number; t: number; css: string | null }> = [
            { f: info.contentFrom, t: info.contentTo, css: contentCss },
            ...info.marks.map((m) => ({ f: m.from, t: m.to, css: null })),
            ...info.hidden.map((h) => ({ f: h.from, t: h.to, css: null })),
        ].sort((a, b) => a.f - b.f);
        let inner = node.from;
        for (const piece of pieces) {
            pushText(inner, piece.f, bodyFont);
            if (piece.css) pushText(piece.f, piece.t, piece.css);
            inner = piece.t;
        }
        pushText(inner, node.to, bodyFont);
        cursor = node.to;
    }
    pushText(cursor, to, bodyFont);
    return segments;
}

/**
 * 行首结构标记（引用 `> `、无序列表 bullet）的处理规则。
 *
 * 依据（实测 plugin/widget DOM）：
 * - **QuoteMark**：渲染态 `> ` 被 hideDeco 整段抽掉（0 宽、无断行机会）→ **整段省略**；
 * - **无序 ListMark**：渲染态 `- ` 被 BulletWidget 替换，而该 widget 的盒宽
 *   **精确等于 `- ` 的宽度**（widgets.ts 构造时按真实字宽量的）→ 模拟时直接按
 *   普通文本 `- ` 输出即可，两态前缀等宽；
 * - 有序 ListMark：渲染态本来可见，无需特殊处理（按普通文本走 segmentsForRange）。
 */
interface IStructuralMark {
    f: number;
    t: number;
    kind: 'quote' | 'bullet';
}

/**
 * 前缀（渲染态）的字体分段：先按位置顺序处理行首结构标记，
 * 其余区间交给 segmentsForRange 处理普通文字与行内兄弟元素。
 *
 * @param state - 编辑器状态，用来读文档文本
 * @param tree - 当前语法树
 * @param from - 前缀起点（通常是逻辑行行首）
 * @param to - 前缀终点（目标元素起点）
 * @param ctx - 排版环境
 * @returns 按文档顺序排好的字体分段
 */
function renderedSegments(
    state: EditorState,
    tree: Tree,
    from: number,
    to: number,
    ctx: IOpenWrapContext
): ISegment[] {
    if (from >= to) return [];
    const bodyFont = fontSpec(ctx.textWeight, 'normal', ctx.size, ctx.family);

    // 收集行首结构标记（边界严格，防压线节点；嵌套引用会有多个 QuoteMark）
    const marks: IStructuralMark[] = [];
    tree.iterate({
        from,
        to,
        enter: (ref) => {
            if (ref.from >= to || ref.to <= from) return false;
            if (ref.name === 'QuoteMark') {
                marks.push({ f: ref.from, t: ref.to, kind: 'quote' });
            } else if (ref.name === 'ListMark') {
                // 只有无序标记被 widget 替换；标记字符是 - * +
                const markerText = state.doc.sliceString(ref.from, ref.to);
                if (markerText === '-' || markerText === '*' || markerText === '+') {
                    marks.push({ f: ref.from, t: ref.to, kind: 'bullet' });
                }
            }
        },
    });
    marks.sort((a, b) => a.f - b.f);

    // 按位置铺开：结构标记之间的区间走普通分段
    const result: ISegment[] = [];
    let cursor = from;
    for (const mark of marks) {
        result.push(...segmentsForRange(state, tree, cursor, mark.f, ctx));
        // plugin 的替换范围含标记后的一个空格（hideEnd），两态一致
        const end = state.doc.sliceString(mark.t, mark.t + 1) === ' ' ? mark.t + 1 : mark.t;
        if (mark.kind === 'bullet') {
            result.push({ text: state.doc.sliceString(mark.f, end), css: bodyFont });
        }
        // quote: 什么都不产生（0 宽）
        cursor = end;
    }
    result.push(...segmentsForRange(state, tree, cursor, to, ctx));
    return result;
}

/**
 * 折行模拟器：往一个隐藏容器里登记「前缀段 + 探针」的模拟行，一次性读出
 * 全部探针的「行数 + 末行右端」。
 *
 * 容器的折行三件套 `white-space: break-spaces; word-break: break-word;
 * overflow-wrap: anywhere` 与 CodeMirror `lineWrapping` 挂在 `.cm-content`
 * 上的逐字相同（已从 @codemirror/view 源码核对），同样的字符序列、同样的宽度，
 * 浏览器给出的断点就是正文里真实的断点。
 *
 * 和 layoutMetrics.MeasureBatch 一样，**所有块挂完才读一次**：中途每读一次
 * 都会强制一次布局。一个模拟器从建到拆恰好一次强制布局，
 * 一次跨行补偿共三个模拟器（选档 / 斜率 / 验证），共 3 次。
 */
class WrapSim {
    private box: HTMLDivElement;
    private probes: HTMLSpanElement[] = [];

    /**
     * @param width - 一行的折行宽度（px）
     */
    constructor(width: number) {
        const box = document.createElement('div');
        box.style.cssText =
            'position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;' +
            'contain:layout style;' +
            `width:${width.toFixed(2)}px;white-space:break-spaces;word-break:break-word;overflow-wrap:anywhere;`;
        box.setAttribute('aria-hidden', 'true');
        this.box = box;
    }

    /**
     * 登记一块模拟行：前缀各段在前、探针在后（探针就是要量的那一段）。
     *
     * @param segments - 前缀的渲染态分段（可为空，元素在行首时）
     * @param probeText - 待量的文字
     * @param probeCss - 探针的字体样式（fontSpec 拼的，可附加字距）
     * @param geom - 本块的行几何（内容宽 + 左右内边距）；不同上下文（引用更窄、
     *               带 border）不同，传入则让块完全复刻行盒；不传用容器默认
     * @returns 探针下标，flush() 之后按它取读数
     */
    add(
        segments: ISegment[],
        probeText: string,
        probeCss: string,
        geom?: ILineGeometry
    ): number {
        const block = document.createElement('div');
        if (geom) {
            // border-box 宽 = 内容宽 + 左右内边距；用 padding 复刻 border 空间
            block.style.boxSizing = 'border-box';
            block.style.paddingLeft = `${geom.insetL.toFixed(2)}px`;
            block.style.paddingRight = `${geom.insetR.toFixed(2)}px`;
            block.style.width = `${(geom.width + geom.insetL + geom.insetR).toFixed(2)}px`;
        }
        for (const seg of segments) {
            const span = document.createElement('span');
            span.style.cssText = seg.css;
            span.textContent = seg.text;
            block.appendChild(span);
        }
        const probe = document.createElement('span');
        probe.style.cssText = probeCss;
        probe.textContent = probeText;
        block.appendChild(probe);
        this.box.appendChild(block);
        this.probes.push(probe);
        return this.probes.length - 1;
    }

    /**
     * 挂上 DOM、一次性读出全部探针的读数，再拆掉（一次强制布局）。
     *
     * 行数读数 = `getClientRects()` 的矩形个数：无双向文字的内联 span
     * 恰好每个视觉行一个矩形；末行右端 = 最后一个矩形的右缘（相对容器左缘）。
     *
     * @returns 与登记顺序一一对应的读数；探针读不到（空矩形）时该位为 null
     */
    flush(): Array<IProbeRead | null> {
        const host = document.body;
        if (!host) return this.probes.map(() => null);
        host.appendChild(this.box);
        const originX = this.box.getBoundingClientRect().left;
        const reads = this.probes.map((probe) => {
            const rects = probe.getClientRects();
            if (rects.length === 0) return null;
            const last = rects[rects.length - 1];
            return { lines: rects.length, endX: last.right - originX };
        });
        this.box.remove();
        this.probes = [];
        return reads;
    }
}

/**
 * 跨行补偿结果缓存。
 *
 * 'single' 是「渲染态本来只占一行」的记号：那种元素该回退单行算法，
 * 把这个结论也缓存住，否则每次重建都要白白付一遍选档批次的强制布局。
 * key 里带逻辑行全文 + 元素区间 + 折行宽度 + 字体：行文本、宽度、字体
 * 任何一样变了都会重新算。
 */
const wrapScaleCache = new Map<string, IWrapResult | 'single'>();

/**
 * 真实渲染末行几何的快照（key 见 computeOpenScalesWrapped）。
 * 只在元素为渲染态的首遍 build 写入，后续 build 复用，避免读到源码态脏值。
 */
const renderedSnapshot = new Map<string, { dist: number; lines: number }>();

/**
 * 候选字号（相对正文基准）：**双向**。
 *
 * 为什么允许放大到 1 以上：展开后内容从加粗变常规，笔画变细、字宽变窄，靠近
 * 折行边界时会比渲染态少占一行（margin 改不了纵向行数）。把常规字号放大到约
 * 1.05~1.1，字宽即与加粗时相当、笔画却不会变粗，行数与右端都能对齐。
 * 步进 0.01（每档右端变化约 2~3px），残差交给 margin。
 */
const WRAP_SCALES: number[] = [];
for (let s = 1.12; s >= 0.85 - 1e-6; s -= 0.01) {
    WRAP_SCALES.push(Math.round(s * 1000) / 1000);
}

/** 结尾 margin 安全上限（px），仅防量错时后缀飞出。 */
const MAX_MARGIN_PX = 60;

export interface IWrapResult {
    /** 展开元素的字号倍率（em），可能略大于 1 */
    scale: number;
    /** 展开元素的字距（px）；本算法固定为 0 */
    letterSpacing: number;
    /**
     * 结尾补偿（px）：挂在元素 margin-right 上，把后缀精确推/拉回渲染态位置。
     * margin 只作用于元素结尾、不影响元素内部折行，是几何精确的收尾。
     */
    marginRight: number;
}

/**
 * 一次算出一批跨行元素的展开补偿（双向字号 + 结尾 margin）。
 *
 * 流程：量真实渲染末行几何（右端 + 行数）→ 渲染只占一行则交回单行算法；
 * 渲染多行时，沿 WRAP_SCALES 逐档真实折行，在「行数守恒」的档位里挑右端最接近
 * 真实渲染的字号 → 剩余差由 margin 精确抹平。开头位置天然不变（标记在元素起点）。
 *
 * @param state - 编辑器状态，读文档文本
 * @param tree - 当前语法树，算前缀分段
 * @param ctx - 排版环境（真实视图 + 字体）
 * @param infos - 这批元素的展开信息，顺序即返回顺序
 * @returns 与 infos 等长的结果；null 表示该元素回退单行算法
 */
export function computeOpenScalesWrapped(
    state: EditorState,
    tree: Tree,
    ctx: IOpenWrapContext,
    infos: OpenElementInfo[]
): Array<IWrapResult | null> {
    const results: Array<IWrapResult | null> = infos.map(() => null);
    if (infos.length === 0) return results;

    try {
        // 每元素：真实渲染几何 + 各候选字号的源码探针，全部挂进一个模拟器
        const sim = new WrapSim(ctx.width);
        /** 每个元素登记的探针信息 */
        const entries: Array<{
            index: number;
            scaleProbes: number[];
            rendered: { dist: number; lines: number };
        } | null> = infos.map(() => null);

        infos.forEach((info, index) => {
            const sourceText = openSourceText(state, info);
            const contentText = state.doc.sliceString(info.contentFrom, info.contentTo);
            if (!sourceText || !contentText) return; // 空内容交回单行算法
            const line = state.doc.lineAt(info.from);

            // 真实行几何（引用带 border、内容窄）；量不到放弃
            const geom = measureLineGeometry(ctx, info.from);
            if (!geom) return;

            // 真实渲染几何：快照只读一次，避免多遍 build 读到源码态
            const snapshotKey = `${line.from}:${info.from - line.from}:${contentText.length}`;
            let rendered = renderedSnapshot.get(snapshotKey);
            if (!rendered) {
                const measured = measureRenderedEndDist(ctx, info);
                if (!measured) return; // 未渲染又无快照：放弃
                renderedSnapshot.set(snapshotKey, measured);
                rendered = measured;
            }
            // 渲染只占一行 → 单行算法处理，openWrap 不介入
            if (rendered.lines <= 1) return;

            // 前缀分段（复刻行首列表/引用标记）
            const prefix = renderedSegments(state, tree, line.from, info.from, ctx);

            // 每档字号一个源码探针（真实折行），样式不缩放字距
            const scaleProbes = WRAP_SCALES.map((scale) =>
                sim.add(
                    prefix,
                    sourceText,
                    `${fontSpec(ctx.textWeight, 'normal', ctx.size * scale, ctx.family)};letter-spacing:0px`,
                    geom
                )
            );
            entries[index] = { index, scaleProbes, rendered };
        });

        const reads = sim.flush();
        for (const entry of entries) {
            if (!entry) continue;
            // 在「行数守恒」档位里挑右端最接近真实渲染的字号
            let bestScale = 0;
            let bestEnd = 0;
            let bestAbs = Number.POSITIVE_INFINITY;
            entry.scaleProbes.forEach((probeIndex, k) => {
                const read = reads[probeIndex];
                if (!read || read.lines !== entry.rendered.lines) return;
                const abs = Math.abs(read.endX - entry.rendered.dist);
                // 并列取右端更靠后（偏宽安全，不把后缀吸上同一行）
                if (abs < bestAbs || (abs === bestAbs && read.endX > entry.rendered.dist)) {
                    bestAbs = abs;
                    bestScale = WRAP_SCALES[k];
                    bestEnd = read.endX;
                }
            });
            if (bestScale === 0) continue; // 没有档位保住行数：回退
            // margin 精确收尾
            const margin = Math.max(
                -MAX_MARGIN_PX,
                Math.min(MAX_MARGIN_PX, entry.rendered.dist - bestEnd)
            );
            results[entry.index] = {
                scale: bestScale,
                letterSpacing: 0,
                marginRight: Math.abs(margin) > 0.01 ? margin : 0,
            };
        }
    } catch (error) {
        // 任何意外：该批回退（null），console 留痕，绝不影响整篇渲染
        console.warn('[openWrap] 跨行宽度补偿失败，回退单行算法：', error);
    }
    return results;
}
