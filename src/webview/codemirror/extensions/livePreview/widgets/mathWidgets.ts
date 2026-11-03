/**
 * Live Preview Widget（从 widgets.ts 拆出）：数学公式 widget：行内 + 块级（含 mathScaleCache 与盒高测量）。
 *
 * @module webview/codemirror/extensions/livePreview/mathWidgets
 */

import { EditorView, WidgetType } from '@codemirror/view';

// =============================================================================
// Math Widgets (KaTeX)
// =============================================================================

import katex from 'katex';
// KaTeX 样式注入与字符串渲染统一放在 mathRender.ts，表格单元格那边的公式
// 走的是同一个入口，样式只注入一次。
import { ensureKatexCss } from '../math/mathRender.js';
// 「只读显示态」小文档标记：导图节点 / 幻灯片块的 mini-CM 走这个分支，
// 它们的字号 / 行高由所在容器决定，和主编辑器不是一套口径。
import { livePreviewDisplayOnly } from '../state.js';

/**
 * 点击公式时，把光标放到「点击处对应的源码字符」上，从而切到文本模式。
 *
 * 为什么必须自己接管：公式是整段**替换**成 widget 的，而 `WidgetType.ignoreEvent`
 * 默认对所有事件返回 true（编辑器一律忽略 widget 里面的事件），所以点公式既不会
 * 移动光标、也不会展开源码——这就是「点公式没反应」的原因。
 *
 * 位置**由构造方传进来**（sourceFrom / sourceTo 是公式原文的准确区间），不去猜：
 * 早先的写法是拿 `posAtDOM(host, 0)` 当起点、再用 `indexOf(tex)` 往后找，
 * 多行公式一带缩进、或者块级 widget 的位置落在别处，就找不到、光标落到公式外面，
 * 表现就是「点中间没反应」。
 *
 * @param view - 当前编辑器视图
 * @param host - 公式 widget 的根节点
 * @param tex - 公式源码（不含定界符）
 * @param sourceFrom - 公式源码在文档里的起点
 * @param sourceTo - 公式源码在文档里的终点
 * @param event - 触发定位的鼠标事件
 */
function placeMathCaret(
    view: EditorView,
    host: HTMLElement,
    tex: string,
    sourceFrom: number,
    sourceTo: number,
    event: MouseEvent
): void {
    // 只读模式（Viewer）只让 CM6 照常处理，不动光标
    if (!view.state.facet(EditorView.editable)) return;

    const doc = view.state.doc;
    if (sourceFrom < 0 || sourceTo > doc.length || sourceFrom >= sourceTo) return;

    const rect = host.getBoundingClientRect();
    const ratioX = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    const ratioY = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0;

    // 多行公式：先按纵向比例选出第几行，再在那一行里按横向比例选字符
    const lines = tex.split('\n');
    const lineIndex = Math.max(0, Math.min(lines.length - 1, Math.round(ratioY * (lines.length - 1))));
    let offset = 0;
    for (let i = 0; i < lineIndex; i++) offset += lines[i].length + 1;
    offset += Math.round(ratioX * lines[lineIndex].length);

    // 落在公式区间内，别越界跑到别的段落上去
    const pos = Math.max(sourceFrom, Math.min(sourceTo, sourceFrom + offset));
    view.dispatch({ selection: { anchor: pos } });
    view.focus();
}

/**
 * Widget that renders an inline math expression ($...$).
 */
export class InlineMathWidget extends WidgetType {
    /**
     * @param tex - 公式源码（不含定界符）
     * @param sourceFrom - 公式源码在文档里的起点
     * @param sourceTo - 公式源码在文档里的终点
     */
    constructor(
        private tex: string,
        private sourceFrom: number,
        private sourceTo: number
    ) {
        super();
    }

    eq(other: InlineMathWidget): boolean {
        return (
            this.tex === other.tex &&
            this.sourceFrom === other.sourceFrom &&
            this.sourceTo === other.sourceTo
        );
    }

    toDOM(view: EditorView): HTMLElement {
        const span = document.createElement('span');
        span.className = 'cm-md-math-inline';
        // 点击公式 → 光标落在点击处 → 这一行进入文本模式（显示 $...$ 源码）
        span.addEventListener('mousedown', (event: MouseEvent) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            placeMathCaret(view, span, this.tex, this.sourceFrom, this.sourceTo, event);
        });
        try {
            ensureKatexCss();
            katex.render(this.tex, span, {
                throwOnError: false,
                output: 'htmlAndMathml',
            });
        } catch (e) {
            console.error('[LiveWriteMD] InlineMath KaTeX render error:', e, 'tex:', this.tex);
        }
        return span;
    }
}

// =============================================================================
// 块级公式：固定 3 行高 + 缩放填满
// =============================================================================

/**
 * 块级公式外框占几行正文。
 *
 * 源码里的块级公式是 `$$` / 内容 / `$$` 三行，框高也取 3 行，渲染前后占的高度
 * 一致，光标在源码态和渲染态之间切换时下面的内容不会上下跳。
 */
const MATH_BLOCK_LINES = 3;

/**
 * 公式缩放比例缓存：key 是「可用高度 + 基准字号 + 公式源码」（见 mathScaleKey）。
 *
 * 量自然高度必须等元素挂进 DOM（toDOM 里量不到），所以第一次渲染是
 * 「先按原样挂上、下一帧量完再缩」。存下来之后，主编辑器里同一个公式再渲染
 * 就可以同步套缓存，首帧就是缩好的，不会闪；mini-CM 在下一帧按真实盒高查缓存。
 */
const mathScaleCache = new Map<string, number>();

/** 内存统计用：公式缩放缓存条目数。 */
export function mathScaleCacheSize(): number {
    return mathScaleCache.size;
}

/**
 * 正文的字号（px）。
 *
 * `.cm-content` 的 font-size 就是 `.cm-content` 那条规则算出来的
 * `--livewritemd-editor-font-size × --livewritemd-font-scale`，这里照抄一遍 ——
 * 只用在「连正文行都还没有」的首次构建里给行高兜底。
 *
 * @returns 正文字号（px），两个变量都读不到时按主题默认的 14px
 */
function contentFontSizePx(): number {
    const root = getComputedStyle(document.documentElement);
    const base = Number.parseFloat(root.getPropertyValue('--livewritemd-editor-font-size'));
    const scale = Number.parseFloat(root.getPropertyValue('--livewritemd-font-scale'));
    return Number.isFinite(base) ? base * (Number.isFinite(scale) ? scale : 1) : 14;
}

/**
 * 正文的行高（px）。
 *
 * 三级来源，越靠前越准：
 * 1. 页面上已经有正文行 —— 量它的计算行高（行高是用户可配的，量出来的最准）；
 * 2. 还没有（视图**首次构建**时一行都没有）—— 按 CSS 里用的同一个变量现算：
 *    `--livewritemd-line-height` 是 `1.7em` 这种带 em 的写法时乘上正文字号，
 *    写成 `22px` 时直接用；
 * 3. 变量也读不到 —— 字号 × 1.7，即主题里那个兜底值。
 *
 * @returns 行高（px）
 */
function mathLineHeightPx(): number {
    const line = document.querySelector('#editor .cm-line');
    if (line) {
        const measured = Number.parseFloat(getComputedStyle(line).lineHeight);
        if (Number.isFinite(measured) && measured > 0) return measured;
    }
    const raw = getComputedStyle(document.documentElement)
        .getPropertyValue('--livewritemd-line-height')
        .trim();
    const value = Number.parseFloat(raw);
    if (Number.isFinite(value) && value > 0) {
        return raw.endsWith('px') ? value : value * contentFontSizePx();
    }
    return contentFontSizePx() * 1.7;
}

/**
 * 块级公式外框的高度（px）= 3 行正文。
 *
 * 两个用途：**视口外的高度估算**（`estimatedHeight`），以及主编辑器里
 * 算缩放可用高度（要再扣掉上下边框 / 内边距，见 fitMathToBox）。
 * 框的真实高度由 CSS 算（stylesChrome.ts 里 `calc(3 * var(--livewritemd-line-height))`），
 * 两边是同一条公式，所以主编辑器里算出来的和页面上量到的一致。
 *
 * 导图节点 / 幻灯片块不能用它：那边的字号、行高由节点 / 块容器决定
 * （幻灯片会按块覆盖 `--livewritemd-editor-font-size`），要用真实盒高量。
 *
 * **别拿它去写行内 style 的高度**：首次构建时 `.cm-line` 还不存在，
 * 行高只能猜（而且 `getMeasureContext()` 那时退到 body，字号是界面的 16px 而不是
 * 正文的 14px），猜出来的 68px 会被 CM 连同 DOM 一起缓存住 ——
 * widget.eq 为真时 DOM 复用、toDOM 不再跑，框就一直比正文高 8.5px，
 * 下面所有行的行号、点击落点跟着往上偏（2026-09-21 反馈）。
 *
 * @returns 外框高度（px）
 */
function mathBoxHeightPx(): number {
    return MATH_BLOCK_LINES * mathLineHeightPx();
}

/**
 * 缩放缓存的 key：可用高度 + 基准字号 + 公式源码。
 *
 * 比例本身 = 可用高度 / 自然高度，两者都随基准字号等比变化时结果不变；
 * 但不同容器的行高倍率可能不同（同一可用高度对应不同基准字号），
 * 把基准字号一起放进 key，避免不同模式之间串用比例。
 *
 * @param avail - 外框内容区高度（px）
 * @param baseFont - 公式所在上下文的基准字号（px）
 * @param tex - 公式源码
 * @returns 缓存 key
 */
function mathScaleKey(avail: number, baseFont: number, tex: string): string {
    return `${Math.round(avail)}|${Math.round(baseFont * 10)}|${tex}`;
}

/**
 * 把公式缩放到外框里 —— **正好填满** 3 行。
 *
 * 比例 = 可用高度 / 公式自然高度，不限制「只缩不放」：小公式会被放大、
 * 高公式会被缩小，最终墨迹高度恰好等于 3 行正文。这样同一个框里所有块级
 * 公式的视觉高度都一致，翻文档时不会忽大忽小。
 *
 * **用 font-size 缩放，不用 transform**：
 * - KaTeX 的尺寸全部是 em，放大字号就是等比放大；
 * - `transform` 只改绘制不改布局。导图节点 / 幻灯片块是按内容
 *   `max-content` 量宽高的，放大后的墨迹会超出量出来的盒子、被
 *   `overflow: hidden` 裁掉（导图里就是「公式右边被切掉一截」）。
 *   字号缩放则布局尺寸一起变，量出来就是最终大小。
 *
 * 可用高度分两套口径：
 * - **主编辑器（live）**：行高来自全局 `--livewritemd-line-height`，
 *   可以直接算出来，缓存命中时首帧就是缩好的（滚动重建不闪）；
 * - **mini-CM（导图节点 / 幻灯片块 / 快速卡片）**：字号与行高由所在容器
 *   决定（幻灯片按块覆盖 `--livewritemd-editor-font-size`），只能在挂进
 *   DOM 后从外框的真实盒高量。统一用布局像素（clientHeight / offsetHeight）：
 *   导图外层的 `transform`、幻灯片页面的 CSS `zoom` 都不影响这两个值，
 *   量出来的比例才和实际排版一致。
 *
 * 外框内边距（上下各 1px）和边框（上下各 1px）都要扣掉，公式才不会
 * 贴着边框；缩放后墨迹正好落在盒子的内容区里。
 *
 * @param inner - 包着 KaTeX 输出的缩放层
 * @param tex - 公式源码（当缓存 key 用）
 * @param displayOnly - 是否处于导图 / 幻灯片这类只读显示态 mini-CM
 * @returns void
 */
function fitMathToBox(inner: HTMLElement, tex: string, displayOnly: boolean): void {
    /**
     * 套用缩放。
     *
     * @param scale - 相对基准字号的倍数
     */
    const applyScale = (scale: number): void => {
        inner.style.fontSize = `${scale.toFixed(4)}em`;
    };

    /**
     * 量到自然高度后算比例、写缓存并立刻套用。
     *
     * @param avail - 可用高度（px）
     * @param baseFont - 基准字号（px）
     * @param natural - 缩放前的自然高度（px）
     */
    const measureAndApply = (avail: number, baseFont: number, natural: number): void => {
        if (natural <= 0) return;
        const scale = avail / natural;
        if (mathScaleCache.size > 200) mathScaleCache.clear();
        mathScaleCache.set(mathScaleKey(avail, baseFont, tex), scale);
        applyScale(scale);
    };

    if (displayOnly) {
        // 导图节点 / 幻灯片块：等挂进 DOM 之后，从外框真实盒高取可用高度。
        // 首帧量不到也无所谓 —— 外框高度是固定的，缩放只影响框内内容，
        // 不会推动外部布局。
        requestAnimationFrame(() => {
            if (!inner.isConnected) return;
            const box = inner.parentElement;
            if (!box || box.clientHeight <= 0) return;
            const boxStyle = getComputedStyle(box);
            const avail =
                box.clientHeight -
                (Number.parseFloat(boxStyle.paddingTop) || 0) -
                (Number.parseFloat(boxStyle.paddingBottom) || 0);
            // 基准字号就是缩放前 inner 继承到的字号
            const baseFont =
                Number.parseFloat(getComputedStyle(inner).fontSize) || contentFontSizePx();
            const cached = mathScaleCache.get(mathScaleKey(avail, baseFont, tex));
            if (cached !== undefined) {
                applyScale(cached);
                return;
            }
            // 用 offsetHeight（布局像素）而不是 rect：rect 会被导图的
            // transform 和幻灯片的 zoom 放大，和上面的可用高度不是一个坐标空间
            measureAndApply(avail, baseFont, inner.offsetHeight);
        });
        return;
    }

    // 主编辑器：可用高度 = 3 行 − 上下边框各 1px − 上下内边距各 1px
    const avail = mathBoxHeightPx() - 4;
    const baseFont = contentFontSizePx();
    const cached = mathScaleCache.get(mathScaleKey(avail, baseFont, tex));
    if (cached !== undefined) {
        // 缓存命中：同步套用，首帧就是缩好的
        applyScale(cached);
        return;
    }

    // 第一帧量不到（元素还没进 DOM）：下一帧补量。
    // 外框高度是固定的，所以这一帧的量与不量都不会让下面的内容移位。
    requestAnimationFrame(() => {
        if (!inner.isConnected) return;
        measureAndApply(avail, baseFont, inner.getBoundingClientRect().height);
    });
}

/**
 * Widget that renders a block math expression ($$...$$).
 */
export class BlockMathWidget extends WidgetType {
    /**
     * @param tex - 公式源码（不含 `$$` 定界符）
     * @param sourceFrom - 公式源码在文档里的起点
     * @param sourceTo - 公式源码在文档里的终点
     */
    constructor(
        private tex: string,
        private sourceFrom: number,
        private sourceTo: number
    ) {
        super();
    }
    /**
     * 高度是**固定**的 3 行，不用量也知道 —— 视口外的公式靠它估高度，
     * 估得准，滚动条才不会跳。
     *
     * 这只是个估算：视口里的公式 CM 会拿真实盒高盖掉它（见 styles.ts 上的说明）。
     */
    get estimatedHeight(): number {
        return mathBoxHeightPx();
    }

    eq(other: BlockMathWidget): boolean {
        return (
            this.tex === other.tex &&
            this.sourceFrom === other.sourceFrom &&
            this.sourceTo === other.sourceTo
        );
    }

    /**
     * 让 CodeMirror 照常处理公式里的事件。
     *
     * 默认（返回 true）是「widget 里的事件编辑器一律不管」，那样点公式只会被我们
     * 自己的 mousedown 兜住；万一那一下没算准位置，用户就完全点不进去了。
     * 返回 false 之后，就算我们的计算失败，CodeMirror 也会把光标放到公式边界上，
     * 至少能进文本模式（只是光标没那么准），不会出现「点了没反应」。
     *
     * @returns 恒为 false
     */
    ignoreEvent(): boolean {
        return false;
    }

    toDOM(view: EditorView): HTMLElement {
        const div = document.createElement('div');
        div.className = 'cm-md-math-block';
        // 高度**不写行内 style**：由 styles.ts 的 `calc(3 * var(--livewritemd-line-height))` 算。
        // 这里写死一段 px 会永久生效（widget.eq 为真时 CM 复用 DOM、toDOM 不再跑），
        // 而首次构建那一刻量不到行高，写下去的就是个错值 —— 下面每一行都会跟着偏。
        // 点击公式 → 光标落在点击处 → 整段公式进入文本模式
        div.addEventListener('mousedown', (event: MouseEvent) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            placeMathCaret(view, div, this.tex, this.sourceFrom, this.sourceTo, event);
        });

        // KaTeX 的输出包一层：缩放只作用在这一层（font-size），外框高度不受影响
        const inner = document.createElement('div');
        inner.className = 'cm-md-math-inner';
        try {
            ensureKatexCss();
            katex.render(this.tex, inner, {
                throwOnError: false,
                displayMode: true,
                output: 'htmlAndMathml',
            });
        } catch (e) {
            console.error('[LiveWriteMD] BlockMath KaTeX render error:', e, 'tex:', this.tex);
            inner.textContent = `$$${this.tex}$$`;
        }
        div.appendChild(inner);
        // 缩放填满 3 行：主编辑器可直接按全局行高算，mini-CM（导图 / PPT）
        // 要等挂进 DOM 后按所在容器的真实盒高量（见 fitMathToBox）。
        fitMathToBox(inner, this.tex, view.state.facet(livePreviewDisplayOnly));
        return div;
    }
}
