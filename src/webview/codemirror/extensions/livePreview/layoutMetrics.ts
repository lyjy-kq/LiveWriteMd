/**
 * 用**真实排版**量字宽：把字符串塞进隐藏的 span，让浏览器自己排一遍，读它的宽度。
 *
 * ## 为什么不继续用 Canvas 的 measureText
 *
 * 先说清楚：**不是 Canvas 量得不准**。无头 Chrome 实测过 12 种组合
 * （字体族 {编辑器, 界面} × 字号 {14, 16} × 字重 {400, 700}），
 * 两个引擎的差距全部 ≤ 0.01px：
 *
 * | 文本 | 14px/400 | 14px/700 | 16px/400 | 16px/700 |
 * | --- | --- | --- | --- | --- |
 * | 一个汉字 | 14.00 | 15.00 | 16.00 | 17.00 |
 * | `abc` | 23.09 | 23.09 | 26.39 | 26.39 |
 * | `**加粗**` 整串 | 90.98 | 91.98 | 103.97 | 104.97 |
 *
 * 真正把宽度补偿算歪的是**喂给它的字体**：宽度对字号、字重、字体族都非常敏感
 * （同一个汉字 14px/400 是 14px，14px/700 就是 15px，差 7%），
 * 而宽度补偿要求的是「排版出来到底多宽」，一个字都不许差。
 *
 * 所以这里不用「画布量一遍、希望它和排版一致」，而是**让排版引擎自己排一遍**
 * —— 拿到的是即将真正渲染的宽度，结构上就不可能不一致，不必依赖两个引擎恰好对齐
 * （换字体、换平台、换 Chrome 版本都不用重新验一遍）。
 *
 * 其余地方（缩进估算、列宽初值）继续用 Canvas：那边只要量级对，
 * 且没必要为它付一次强制布局的开销。
 *
 * ## 成本：一次批量只强制一次布局
 *
 * 量宽度这个动作本身很便宜（挂 span、读盒宽），**贵的是读盒宽时触发的强制布局**
 * —— 读一次就会把整个文档重排一次，文档越大越贵。所以：
 *
 * 1. 所有 span 先挂上去、**最后统一读**（中途读一次就强制一次）；
 * 2. 一批里放多少条都一样，因此把「一个块里所有元素要量的东西」合并成一批，
 *    见 MeasureBatch 的说明。
 *
 * @module webview/codemirror/extensions/livePreview/layoutMetrics
 */

/** 一条待量文本：内容 + 它要用的字体样式。 */
export interface IMeasureItem {
    /** 要量的文字 */
    text: string;
    /** 样式 cssText 片段，至少要给出 font-size / font-weight / font-family */
    style: string;
}

/**
 * 拼一段 `font` 简写。
 *
 * 用简写而不是分三条写，是为了让每个测量 span 的字体状态**完全确定**：
 * 简写会把没写到的（font-style、font-variant、line-height）一并重置成初始值，
 * 不会从页面别处继承来一个斜体或小字号，把宽度带偏。
 *
 * @param weight - 字重（'400' / '700'）
 * @param style - 字形（'normal' / 'italic'）
 * @param size - 字号（px）
 * @param family - 字体族（可以是逗号分隔的列表）
 * @returns cssText 片段
 */
export function fontSpec(weight: string, style: string, size: number, family: string): string {
    return `font: ${style} ${weight} ${size.toFixed(3)}px ${family}`;
}

/**
 * 真正量宽度的那一步：挂 span → **只读一次** → 拆掉。
 *
 * @param items - 待量文本；顺序即返回顺序
 * @returns 每个条目排出来有多宽（px）；量不了时返回 0，调用方自己兜底
 */
function measureItems(items: IMeasureItem[]): number[] {
    if (items.length === 0) return [];
    const host = document.body;
    if (!host) return items.map(() => 0);

    // 容器本身不参与页面排版：绝对定位 + 移出可视区 + 不可见，
    // `contain: layout style` 再把它和外界彻底隔开（不然字体、行高都可能被继承污染）
    const box = document.createElement('div');
    box.style.cssText =
        'position:absolute; left:-99999px; top:0; visibility:hidden; pointer-events:none;' +
        'white-space:pre; contain:layout style;';
    box.setAttribute('aria-hidden', 'true');

    const spans = items.map((item) => {
        const span = document.createElement('span');
        span.style.cssText = `white-space:pre; ${item.style}`;
        span.textContent = item.text;
        box.appendChild(span);
        return span;
    });
    host.appendChild(box);

    // 这一行循环里只读不写：写一次就会让后面每次读都重新布局
    const widths = spans.map((span) => span.getBoundingClientRect().width);
    box.remove();
    return widths;
}

/**
 * 分批登记的「一次量测」。
 *
 * 为什么是登记式（add 一堆 → flush 一次），而不是一条一条量：
 * 展开一个行内元素要在近百个候选字号上量同一串源码，而一个块里常常同时展开好几个
 * 元素（拖选会让整块退回源码）。一条一条量的话，**每个元素要付 2 次强制布局**；
 * 登记进同一个批次，整块只付 **1 次**。强制布局是这条路径上唯一昂贵的操作，
 * 所以能合并就合并。
 *
 * 用法：
 *
 * ```ts
 * const batch = new MeasureBatch();
 * const target = batch.add(内容, 渲染态样式);
 * const candidates = 候选字号.map((s) => batch.add(源码串, 展开态样式));
 * const widths = batch.flush();          // 到这里才碰 DOM，只强制一次布局
 * widths[target] / widths[candidates[0]] // 按下标取宽度
 * ```
 */
export class MeasureBatch {
    /** 已登记、还没量的条目 */
    private items: IMeasureItem[] = [];

    /**
     * 登记一条待量文本。
     *
     * @param text - 要量的文字
     * @param style - 样式 cssText 片段（通常由 fontSpec 拼出来）
     * @returns 这条的下标；flush() 之后按这个下标取宽度
     */
    add(text: string, style: string): number {
        this.items.push({ text, style });
        return this.items.length - 1;
    }

    /** 已经登记了多少条（调用方用来判断「有没有必要 flush」）。 */
    get size(): number {
        return this.items.length;
    }

    /**
     * 一次性量完本批登记的全部条目。
     *
     * @returns 与登记顺序一一对应的宽度（px）；量完即清空，可以接着登记下一批
     */
    flush(): number[] {
        const items = this.items;
        this.items = [];
        return measureItems(items);
    }
}
