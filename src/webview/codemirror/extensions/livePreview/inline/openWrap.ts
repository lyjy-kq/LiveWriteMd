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

import { WrapSim } from './wrapSim.js';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';
import { EditorView } from '@codemirror/view';
import { detectIndentUnit, getListIndent, measureIndentUnitPx } from '../measure/listIndent.js';
import { getMeasureContext } from '../measure/textMeasure.js';
import { fontSpec } from '../decor/layoutMetrics.js';
import { availableTableWidth } from '../table/tableWiring.js';
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
    /** 正文字重（用户可调，--livewritemd-font-weight） */
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
 * **必须传 view 的场合**：导图节点的 mini-CM。以前这里写死
 * `document.querySelector('#editor .cm-content')`，只有在主编辑器里才拿得到
 * 环境；导图里要么找不到 `#editor`、要么找到的是隐藏的主编辑器（clientWidth 为 0），
 * 于是跨行补偿整条被关掉，点开跨行加粗就退化成单行算法 —— 行数会 ±1、
 * 后面的文字被推走。传入调用方自己的 view 后，宽度与字体都按**这个编辑器**
 * 的真实 DOM 取，mini-CM 也能保住行数与后缀位置。
 *
 * @param viewOverride - 调用方的编辑器视图；不传时按主编辑器 `#editor` 取（旧路径）
 * @returns 排版环境；任何前提不满足时返回 null，调用方全部回退单行算法
 */
export function createOpenWrapContext(viewOverride?: EditorView): IOpenWrapContext | null {
    const contentEl = viewOverride
        ? viewOverride.contentDOM
        : document.querySelector('#editor .cm-content');
    if (!contentEl || !contentEl.classList.contains('cm-lineWrapping')) return null;
    // 字体环境：给 view 时从该视图自己的正文量（导图节点的字体/字号可以与主编辑器不同）
    const measure = viewOverride
        ? measureContextFromContent(contentEl)
        : getMeasureContext();
    if (!measure) return null;
    const view = viewOverride ?? EditorView.findFromDOM(contentEl as HTMLElement);
    if (!view) return null;
    // 折行宽度：
    // - 主编辑器走原来的 availableTableWidth（扣行号栏、行宽上限、正文内边距），
    //   再扣 .cm-line 的 padding: 0 4px（左右共 8px）。改 theme.ts 那边要跟着改。
    // - 指定了 view 时，宽度按该视图的正文盒现量。**用布局像素**（offset/client），
    //   不用 getBoundingClientRect：mini-CM 挂在画布的世界层里，可能被 CSS
    //   transform 缩放，rect 是缩放后的屏幕像素，而折行模拟容器挂在 body 上
    //   （未缩放），两边混用会让模拟出的行数整体偏少。
    const width = viewOverride
        ? contentLayoutWidth(contentEl)
        : availableTableWidth() - 8;
    // 主编辑器的可用宽度要求至少 100px；节点单元格可能更窄，放宽到 40px
    if (!(width > (viewOverride ? 40 : 100))) return null;
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

/**
 * 按给定正文元素现量一套字体环境（canvas + 字号 + 字体族 + 字重）。
 *
 * 与 helpers.getMeasureContext 的区别：不查 `#editor`、不共享缓存 ——
 * 导图里每个节点都是独立的 mini-CM，缓存按主编辑器字体存会在多个视图间串味。
 * 调用频率与重建频率一致（点开一个元素一次），成本可以忽略。
 *
 * @param contentEl - 该视图的 `.cm-content`
 * @returns 字体环境；拿不到 canvas 时返回 null
 */
function measureContextFromContent(
    contentEl: HTMLElement
): { ctx: CanvasRenderingContext2D; size: number; family: string; codeFamily: string; weight: string } | null {
    const cs = getComputedStyle(contentEl);
    const size = Number.parseFloat(cs.fontSize) || 14;
    const family = cs.fontFamily || 'monospace';
    const weight = cs.fontWeight || '400';
    // 行内代码在渲染态换等宽字体，量它的宽度得用同一套字体。
    // 优先量本视图里真实存在的代码元素，没有就退回 CSS 变量。
    const codeSample = contentEl.querySelector('.cm-md-code');
    const codeFamily = codeSample
        ? getComputedStyle(codeSample).fontFamily
        : (getComputedStyle(document.documentElement)
              .getPropertyValue('--vscode-editor-font-family')
              .trim() || 'monospace');
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return null;
    ctx.font = `${size}px ${family}`;
    return { ctx, size, family, codeFamily, weight };
}

/**
 * 量的正文盒**布局像素**宽度（不含 padding）。
 *
 * 用 clientWidth 而不是 getBoundingClientRect：后者会被祖先的 CSS transform
 * 缩放（导图世界层），而折行模拟容器挂在 body 上未缩放，必须同一坐标帧。
 *
 * @param contentEl - 视图的 `.cm-content`
 * @returns 文字区宽度（px）；量不到返回 0
 */
function contentLayoutWidth(contentEl: HTMLElement): number {
    const cs = getComputedStyle(contentEl);
    const inner =
        contentEl.clientWidth -
        (Number.parseFloat(cs.paddingLeft) || 0) -
        (Number.parseFloat(cs.paddingRight) || 0);
    return inner > 0 ? inner : 0;
}

/** 一个逻辑行的几何：以行 border-box 左缘为原点 */
interface ILineGeometry {
    /** 内容列相对行左缘的左内边距（padding-left + border-left） */
    insetL: number;
    /** 右内边距（padding-right + border-right） */
    insetR: number;
    /** 内容文字区宽度 = 行盒宽 − 左右内边距 */
    width: number;
    /**
     * 悬挂缩进宽度（px）：真实列表行通过 padding-left + text-indent 让续行
     * 从 marker 列起。模拟器要同样设 text-indent 才能复现首行满宽、续行窄，
     * 非列表行为 0
     */
    hang: number;
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
    // 行盒宽度必须换算成**布局像素**：getBoundingClientRect 会被祖先 transform
    // 缩放（导图世界层），折行模拟容器挂在 body 上未缩放。用 rect / scale 还原，
    // 比 offsetWidth 多保留小数；主编辑器没有缩放时 factor = 1，行为不变。
    const width = layoutWidthOf(lineEl, ctx.view.scaleX) - insetL - insetR;
    // 悬挂缩进：**直接读真实行的 text-indent**，不要只按文档缩进猜。
    // 列表行的悬挂缩进是 `padding-left: marker 列宽 + text-indent: -marker 列宽`，
    // 顶格列表（level 0）也一样有这一对（getListIndent 只算「嵌套层级」，
    // 对顶格行返回 level 0）。只按层级算会让模拟器把首行也缩进一个 marker 列宽，
    // 首行少排一个字符 → 末行右端偏出一整字，行数也跟着 ±1。
    const textIndent = Number.parseFloat(cs.textIndent) || 0;
    // 调用方仍可用文档缩进兜底（计算样式尚未应用时 text-indent 会是 0）
    return width > 50 ? { insetL, insetR, width, hang: Math.max(0, -textIndent) } : null;
}

/**
 * 取元素未被 CSS transform 缩放时的布局宽度（px）。
 *
 * getBoundingClientRect 返回屏幕像素，会被祖先 transform 缩放（导图世界层
 * 的 zoom）；折行模拟容器挂在 body 上、未缩放。必须把 rect 除以视图自己
 * 算出的缩放系数，两边才在同一坐标帧里。
 *
 * 用 `view.scaleX` 而不是 `rect.width / offsetWidth`：offsetWidth 取整，
 * 窄单元格上会丢掉半像素，行数正好卡在边界时会选错字号档位。
 *
 * @param el - 待测元素
 * @param scale - 视图的横向缩放系数（未缩放时为 1）
 * @returns 布局像素宽度
 */
function layoutWidthOf(el: Element, scale: number): number {
    const width = el.getBoundingClientRect().width;
    return scale > 0 ? width / scale : width;
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
    // 原点 = 行 border-box 左缘（不加 padding）；模拟块以同一位置为原点。
    // 两个 rect 都是屏幕像素，统一除以视图缩放系数还原成布局像素
    // （主编辑器 scaleX = 1，行为不变）。
    const scale = ctx.view.scaleX > 0 ? ctx.view.scaleX : 1;
    const lineLeft = lineEl.getBoundingClientRect().left;
    const rects = renderedEl.getClientRects();
    if (rects.length === 0) return null;
    // 渲染元素是纯文本 span，矩形数 = 视觉行数
    return { dist: (rects[rects.length - 1].right - lineLeft) / scale, lines: rects.length };
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

/** 内存统计用：跨行补偿缓存与渲染快照的条目数。 */
export function openWrapCacheStats(): { wrapScaleEntries: number; snapshotEntries: number } {
    return {
        wrapScaleEntries: wrapScaleCache.size,
        snapshotEntries: renderedSnapshot.size,
    };
}

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

    // 缩进单位：取样前 200 行探测（与 plugin.ts 的 collectListIndentDecorations
    // 同思路），用来把每个列表行的悬挂缩进宽度算给折行模拟器
    const indentSamples: string[] = [];
    for (let ln = 1; ln <= Math.min(200, state.doc.lines); ln++) {
        indentSamples.push(state.doc.line(ln).text);
    }
    const indentUnitCols = detectIndentUnit(indentSamples);

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

            // 本行的悬挂缩进宽度（列表行才有）：行层级 × 缩进单位 px，
            // 与 collectListIndentDecorations 同源，交给模拟器复刻 text-indent
            const lineIndent = getListIndent(line.text, indentUnitCols);
            const hangPx = lineIndent.isList
                ? lineIndent.level * measureIndentUnitPx(indentUnitCols)
                : 0;

            // 真实行几何（引用带 border、内容窄）；量不到放弃
            const geom = measureLineGeometry(ctx, info.from);
            if (!geom) return;
            // text-indent 优先（真实行的悬挂缩进）；样式还没应用出来时才用文档缩进兜底
            if (geom.hang <= 0 && hangPx > 0) geom.hang = hangPx;

            // 真实渲染几何：快照只读一次，避免多遍 build 读到源码态。
            // key 必须带上折行宽度与字体：同一个 Map 现在服务主编辑器和
            // 各个导图 mini-CM（每个节点文档都从第 1 行开始，line.from 恒为 0），
            // 只按位置/长度做 key 会把别的视图的读数拿来用。
            const snapshotKey =
                `${ctx.width.toFixed(1)}|${ctx.size}|${ctx.family}|` +
                `${line.from}:${info.from - line.from}:${contentText.length}|${line.text}`;
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
