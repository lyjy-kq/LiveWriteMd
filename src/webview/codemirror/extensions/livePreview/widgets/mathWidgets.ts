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
// 块级公式：固定 2.5 行高 + 超高缩放
// =============================================================================

/** 块级公式外框占几行正文。 */
const MATH_BLOCK_LINES = 2.5;

/**
 * 公式缩放比例缓存：key 是「框高 + 公式源码」。
 *
 * 量自然高度必须等元素挂进 DOM（toDOM 里量不到），所以第一次渲染是
 * 「先按原样挂上、下一帧量完再缩」。存下来之后，同一个公式再渲染就直接套缓存，
 * 首帧就是缩好的，不会闪。
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
 * 块级公式外框的高度（px）= 2.5 行正文。
 *
 * 只给两件事用：**视口外的高度估算**（`estimatedHeight`）和缩放缓存的 key。
 * 框的真实高度由 CSS 算（styles.ts 里 `calc(2.5 * var(--livewritemd-line-height))`），
 * 两边是同一条公式，所以这里算出来的和页面上量到的一致。
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
 * 把公式缩放到外框里。
 *
 * 缩放比例 = min(1, 可用高度 / 公式自然高度)：矮的公式原样显示（绝不放大小公式），
 * 比框高的（多行 aligned 之类）整体缩小后居中。transform 不影响布局，
 * 所以外面那 2.5 行的高度永远是稳定的。
 *
 * @param inner - 包着 KaTeX 输出的缩放层
 * @param tex - 公式源码（当缓存 key 用）
 * @returns void
 */
function fitMathToBox(inner: HTMLElement, tex: string): void {
    // 外框上下各 1px 边框要扣掉，公式才不会贴着边（框内上下没有 padding，见 styles.ts）
    const avail = mathBoxHeightPx() - 2;
    const key = `${Math.round(avail)}|${tex}`;

    const applyScale = (scale: number): void => {
        inner.style.transform = `scale(${scale.toFixed(4)})`;
    };

    const cached = mathScaleCache.get(key);
    if (cached !== undefined) {
        applyScale(cached);
        return;
    }

    // 第一帧量不到（元素还没进 DOM）：下一帧补量。
    // 外框高度是固定的，所以这一帧的量与不量都不会让下面的内容移位。
    requestAnimationFrame(() => {
        if (!inner.isConnected) return;
        const natural = inner.getBoundingClientRect().height;
        if (natural <= 0) return;
        const scale = Math.min(1, avail / natural);
        if (mathScaleCache.size > 200) mathScaleCache.clear();
        mathScaleCache.set(key, scale);
        applyScale(scale);
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
     * 高度是**固定**的 2.5 行，不用量也知道 —— 视口外的公式靠它估高度，
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
        // 高度**不写行内 style**：由 styles.ts 的 `calc(2.5 * var(--livewritemd-line-height))` 算。
        // 这里写死一段 px 会永久生效（widget.eq 为真时 CM 复用 DOM、toDOM 不再跑），
        // 而首次构建那一刻量不到行高，写下去的就是个错值 —— 下面每一行都会跟着偏。
        // 点击公式 → 光标落在点击处 → 整段公式进入文本模式
        div.addEventListener('mousedown', (event: MouseEvent) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            placeMathCaret(view, div, this.tex, this.sourceFrom, this.sourceTo, event);
        });

        // KaTeX 的输出包一层：缩放只作用在这一层，外框高度不受影响
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
        // 比外框高的公式整体缩小（首帧量不到，会在下一帧补上）
        fitMathToBox(inner, this.tex);
        return div;
    }
}
