/**
 * 文本测量（从 helpers.ts 拆出）。
 *
 * Canvas 字宽测量 + MeasureEnv 环境。measureCache 是绑定 #editor DOM 的
 * 全进程单例，被表格量宽 / openScale / openWrap / plugin / BulletWidget 共享。
 *
 * @module webview/codemirror/extensions/livePreview/textMeasure
 */

// =============================================================================
// 字宽测量（Canvas）
// =============================================================================
//
// 「就地展开」和「列表圆点对齐」都要知道某串文字在正文里有多宽：
// 前者要把标记符占的宽度补回来，后者要让渲染出的圆点正好顶掉源码里的 `- `。
// 用 Canvas 的 measureText 量，比按字符个数估准得多（中英文混排、换字体换字号都不怕）。

/** 缓存的画布上下文：字体没变就复用，不用每次量化都新建。 */
let measureCache: {
    key: string;
    ctx: CanvasRenderingContext2D;
    size: number;
    family: string;
    codeFamily: string;
    /** 正文的字重（用户可调，见 --livewritemd-font-weight） */
    weight: string;
    /** 上次查样式表的时间戳（毫秒），用来做短命缓存 */
    lookedUpAt: number;
    /** 这一份是不是从编辑器正文（`.cm-content`）量的 */
    fromContent: boolean;
} | null = null;

/**
 * 取一个和正文同字体的画布上下文，用来量字宽。
 *
 * 字号、字体族、字重都从编辑器正文的实际计算样式里读，所以换主题、改字体缩放
 * （Ctrl+滚轮）、改字重之后量出来的宽度依然是对的。
 *
 * @returns 画布上下文（含正文字号/字体族/字重，以及行内代码用的等宽字体族）；
 *          拿不到时返回 null，调用方走字符数兜底
 */
export function getMeasureContext(): {
    ctx: CanvasRenderingContext2D;
    size: number;
    family: string;
    codeFamily: string;
    weight: string;
} | null {
    // 取字体的元素优先用编辑器正文；但 buildDecorations 在 EditorState.create 阶段
    // 就会跑一次，那时视图还没挂到 DOM 上，正文元素还不存在，所以退到 body。
    //
    // **退到 body 那次的结果必须作废**：webview 里 body 是界面字体/字号
    // （--vscode-font-family），正文是编辑器字体/字号（--vscode-editor-*），
    // 两者字宽差得不是一点。缓存只按时间复用的话，正文挂上来之后还会继续拿
    // body 那一套去量，量出来的宽度系统性偏 —— 所以缓存里记着它是从哪来的，
    // 正文一旦出现，旧的那份立刻不用了。
    //
    // 缓存存活一小会儿：换主题、改字体缩放之后要能很快跟上，但同一轮重建里
    // 会被调用几十次（每张表、每次量字宽都要），每次都 querySelector + getComputedStyle
    // 加起来就是一两毫秒。所以只做一次便宜的 querySelector 探测，不算样式。
    const now = Date.now();
    const contentEl = document.querySelector('#editor .cm-content');
    if (
        measureCache &&
        measureCache.lookedUpAt > now - 250 &&
        measureCache.fromContent === (contentEl !== null)
    ) {
        return {
            ctx: measureCache.ctx,
            size: measureCache.size,
            family: measureCache.family,
            codeFamily: measureCache.codeFamily,
            weight: measureCache.weight,
        };
    }

    const styleSource = contentEl ?? document.body;
    if (!styleSource) return null;

    const cs = getComputedStyle(styleSource);
    // 行内代码渲染态换成等宽字体（见 styles.ts 的 .cm-md-code），量它的宽度得换字体量。
    // 优先量一个真实存在的代码元素（最准），页面上暂时没有就退回 CSS 变量。
    const codeSample = document.querySelector('#editor .cm-md-code');
    const codeFamily = codeSample
        ? getComputedStyle(codeSample).fontFamily
        : (getComputedStyle(document.documentElement)
              .getPropertyValue('--vscode-editor-font-family')
              .trim() || 'monospace');

    const key = `${cs.fontFamily}|${cs.fontSize}|${cs.fontWeight}|${codeFamily}`;
    if (measureCache && measureCache.key === key) {
        return {
            ctx: measureCache.ctx,
            size: measureCache.size,
            family: measureCache.family,
            codeFamily: measureCache.codeFamily,
            weight: measureCache.weight,
        };
    }

    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return null;

    const size = Number.parseFloat(cs.fontSize) || 14;
    const family = cs.fontFamily || 'monospace';
    ctx.font = `${size}px ${family}`;
    // 正文的字重：可能被「字体粗细」这个设置改过（--livewritemd-font-weight），
    // 拿它去量宽度的调用方不能写死 400
    const weight = cs.fontWeight || '400';
    measureCache = {
        key,
        ctx,
        size,
        family,
        codeFamily,
        weight,
        lookedUpAt: now,
        fromContent: styleSource !== document.body,
    };
    return { ctx, size, family, codeFamily, weight };
}

/**
 * 量一段文本在指定字重、指定字号、指定字体下的宽度。
 *
 * @param text - 待测文本
 * @param weight - 字重，'700' 表示粗体（用来对齐渲染态的加粗宽度）
 * @param sizePx - 字号（px）；不传则用编辑器正文的字号
 * @param family - 字体族；不传则用正文的字体族（行内代码渲染态是等宽字体，要显式换）
 * @returns 宽度（px）；量不了时按「CJK 1em、其余 0.6em」粗估兜底
 */
export function measureText(
    text: string,
    weight = '400',
    sizePx?: number,
    family?: string
): number {
    if (!text) return 0;
    const m = getMeasureContext();
    const size = sizePx ?? m?.size ?? 14;
    if (!m) {
        // 兜底：CJK 按 1em、其余按 0.6em 粗算，保证不崩且量级正确
        let units = 0;
        for (const ch of text) units += /[　-鿿＀-￯]/.test(ch) ? 1 : 0.6;
        return units * size;
    }
    m.ctx.font = `${weight} ${size}px ${family ?? m.family}`;
    return m.ctx.measureText(text).width;
}

/**
 * 一份「量字宽用」的字体环境。
 *
 * 为什么不一律走 getMeasureContext：它只认全局的 `#editor .cm-content`。
 * 导图节点里的 mini-CM 是独立编辑器 —— 如果页面上恰好没有主编辑器
 * （复现页 / 单实例场景），它会退到 body 的界面字体（比例字体），
 * 给 `- ` 量出 9px 这种偏窄的宽度；而同一条行在源码态按节点自己的
 * 等宽字体渲染时 `- ` 有 15px —— 圆点位置和正文起点就会差一截，
 * 表现为「进编辑态文字横向跳一下」。
 *
 * 所以凡是传得进 EditorView 的地方，都按该视图正文的实际计算样式量。
 */
export interface MeasureEnv {
    /** 正文字号（px）。 */
    size: number;
    /** 正文字体族。 */
    family: string;
    /** 正文字重。 */
    weight: string;
}

/**
 * 从某个元素（通常是 `.cm-content`）读出量字用的字体环境。
 *
 * @param el - 样式来源元素；为空 / 还没挂进文档时返回 null
 * @returns 字体环境；字号读不出来时返回 null（调用方退回全局口径）
 */
export function measureEnvFromElement(el: Element | null | undefined): MeasureEnv | null {
    if (!el) return null;
    // 视图首次构建时 DOM 还没进文档：此时 getComputedStyle 给的是空串 /
    // 浏览器默认字体，量出来的圆点会系统性地窄一截。宁可返回 null
    // （调用方退回全局口径并记一笔，挂载后补重建），也不要拿它当真。
    if (!el.isConnected) return null;
    try {
        const cs = getComputedStyle(el);
        const size = Number.parseFloat(cs.fontSize);
        if (!Number.isFinite(size) || size <= 0) return null;
        return {
            size,
            family: cs.fontFamily || 'monospace',
            weight: cs.fontWeight || '400',
        };
    } catch {
        return null;
    }
}

/**
 * 按给定字体环境量文本宽度。
 *
 * 与 measureText(text, weight, size, family) 的区别：整份环境一次传进来，
 * 调用方不用每次拆成散参数；env 为空时退回全局测量口径（行为与旧代码一致）。
 *
 * @param env - 字体环境（可为空）
 * @param text - 待测文本
 * @param weight - 字重，默认 400
 * @returns 宽度（px）
 */
export function measureTextIn(
    env: MeasureEnv | null,
    text: string,
    weight = '400'
): number {
    if (!text) return 0;
    if (!env) return measureText(text, weight);
    const m = getMeasureContext();
    if (!m) {
        // 没有画布（纯 SSR / 极端环境）：沿用字符数粗估，但字号用 env 的
        let units = 0;
        for (const ch of text) units += /[　-鿿＀-￯]/.test(ch) ? 1 : 0.6;
        return units * env.size;
    }
    m.ctx.font = `${weight} ${env.size}px ${env.family}`;
    return m.ctx.measureText(text).width;
}

/**
 * 圆点 widget 的盒宽：`marker + 分隔空白`。
 *
 * 渲染态的圆点必须精确顶掉源码里的 `- `（`* ` / `+ ` 同理），
 * 否则进编辑态露出原文时正文会横向跳；所以宽度按同一套字体量。
 *
 * @param marker - 源码标记符（`-` / `*` / `+`）
 * @param env - 字体环境；为空时退回全局口径
 * @returns 盒宽（px）
 */
export function measureBulletWidth(marker: string, env: MeasureEnv | null): number {
    return (
        measureTextIn(env, marker, '400') +
        measureTextIn(env, ' ', '400')
    );
}
