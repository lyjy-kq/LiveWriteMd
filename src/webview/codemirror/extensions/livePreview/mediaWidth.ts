/**
 * FlowMD 预览媒体宽度（图片 / Mermaid 图）的共享定义。
 *
 * 编辑器里的图片和 Mermaid 图默认占正文宽度的 75%，用户可以通过预览上的
 * −/+ 按钮调整。宽度以属性形式写回 Markdown 源码，写法沿用 Pandoc 风格的
 * 属性块，两种媒体保持一致：
 *
 * - 图片：`![alt](url){width=50%}`
 * - Mermaid：` ```mermaid 标题 {width=50%} `
 *
 * 宽度等于默认值时不写属性，源码保持干净；只有用户真的调过宽度才会留下痕迹。
 *
 * @module webview/codemirror/extensions/livePreview/mediaWidth
 */

/**
 * 可选的宽度档位，单位为正文宽度的百分比。
 *
 * 按 25% 一档划分，范围 25%–100%，默认 75%。
 */
export const MEDIA_WIDTH_STEPS: readonly number[] = [25, 50, 75, 100];

/**
 * 未显式设置宽度时使用的默认百分比。
 */
export const DEFAULT_MEDIA_WIDTH_PERCENT = 75;

/**
 * 宽度属性的匹配模式。
 *
 * 只认 `{width=NN%}` 这种最简单的形式，不引入单位换算，
 * 避免把用户的其它花括号写法误认成宽度属性。
 */
const WIDTH_ATTRIBUTE_PATTERN = /\{width=(\d+)%\}/;

/**
 * 从一段文本中解析宽度百分比。
 *
 * @param text - 待解析的文本，通常是图片语法的原文或 mermaid 的 info 行
 * @returns 解析出的百分比；没有宽度属性时返回 null
 */
export function parseMediaWidthPercent(text: string): number | null {
    const match = text.match(WIDTH_ATTRIBUTE_PATTERN);
    if (!match) {
        return null;
    }

    const percent = Number.parseInt(match[1], 10);
    return Number.isFinite(percent) ? clampMediaWidthPercent(percent) : null;
}

/**
 * 把百分比夹到允许的档位区间内。
 *
 * 对手写进去的越界值（比如 `{width=999%}`）做一次收敛，
 * 保证渲染出来的宽度始终在可控范围内。
 *
 * @param percent - 原始百分比
 * @returns 收敛后的百分比
 */
export function clampMediaWidthPercent(percent: number): number {
    if (!Number.isFinite(percent)) {
        return DEFAULT_MEDIA_WIDTH_PERCENT;
    }

    const min = MEDIA_WIDTH_STEPS[0];
    const max = MEDIA_WIDTH_STEPS[MEDIA_WIDTH_STEPS.length - 1];
    return Math.min(max, Math.max(min, Math.round(percent)));
}

/**
 * 生成宽度属性文本。
 *
 * 等于默认宽度时返回空串，这样把宽度调回 75% 会把源码里的属性抹掉，
 * 而不是留下一句多余的 `{width=75%}`。
 *
 * @param percent - 目标百分比
 * @returns 属性文本，或空串
 */
export function formatMediaWidthAttribute(percent: number): string {
    const clamped = clampMediaWidthPercent(percent);
    if (clamped === DEFAULT_MEDIA_WIDTH_PERCENT) {
        return '';
    }

    return `{width=${clamped}%}`;
}

/**
 * 按档位步进调整宽度。
 *
 * 这里是在档位列表上前后移动，而不是简单地加减固定值，
 * 保证手写的非标准值（比如 `{width=60%}`）点一下也能落到整齐的档位上。
 *
 * @param current - 当前百分比
 * @param delta - 步进方向，-1 缩小、1 放大
 * @returns 调整后的百分比
 */
export function stepMediaWidthPercent(current: number, delta: number): number {
    const clamped = clampMediaWidthPercent(current);
    const index = MEDIA_WIDTH_STEPS.indexOf(clamped);

    if (index < 0) {
        // 当前值不在档位上，就近落到最近的档位再走一步。
        const nearest = MEDIA_WIDTH_STEPS.reduce((best, step) =>
            Math.abs(step - clamped) < Math.abs(best - clamped) ? step : best
        );
        const nearestIndex = MEDIA_WIDTH_STEPS.indexOf(nearest);
        const target = Math.min(
            MEDIA_WIDTH_STEPS.length - 1,
            Math.max(0, nearestIndex + (delta > 0 ? 1 : -1))
        );
        return MEDIA_WIDTH_STEPS[target];
    }

    const target = Math.min(MEDIA_WIDTH_STEPS.length - 1, Math.max(0, index + (delta > 0 ? 1 : -1)));
    return MEDIA_WIDTH_STEPS[target];
}

/**
 * 判断宽度是否还能继续缩小或放大。
 *
 * 用于控制 −/+ 按钮的禁用态，避免用户点到没有反应的按钮。
 *
 * @param percent - 当前百分比
 * @param delta - 步进方向
 * @returns 该方向上是否还有档位可走
 */
export function canStepMediaWidth(percent: number, delta: number): boolean {
    const clamped = clampMediaWidthPercent(percent);
    return stepMediaWidthPercent(clamped, delta) !== clamped;
}

/**
 * 把文本末尾的宽度属性拆出来。
 *
 * 图片和 Mermaid 的宽度属性挂在语法末尾，而标题编辑、宽度编辑都会重写
 * 整段源码，两边必须各自把对方的属性原样带上，否则改标题会丢宽度、
 * 改宽度会丢标题。这个 helper 就是为此提供的统一拆解入口。
 *
 * @param text - 完整源码片段
 * @returns base 为不含属性的部分，attribute 为属性文本（含前导空白），没有属性时为空串
 */
export function splitTrailingWidthAttribute(text: string): { base: string; attribute: string } {
    const match = text.match(/(\s*)\{width=\d+%\}$/);
    if (!match) {
        return { base: text, attribute: '' };
    }

    return {
        base: text.slice(0, text.length - match[0].length),
        attribute: match[0],
    };
}

/**
 * 读取紧随某个位置之后的宽度属性。
 *
 * 图片语法的宽度属性写在图片语法外面（`![alt](url){width=50%}`），
 * 所以 decoration 的范围需要往后多圈一段，否则属性文本会以字面量形式
 * 留在渲染结果旁边。这里顺带把空白也算进去，`![alt](url) {width=50%}`
 * 这种带空格的写法同样能被吞掉。
 *
 * @param text - 从图片语法结束位置开始的后续文本
 * @returns 属性部分的长度（含前导空白）；没有属性时返回 0
 */
export function measureTrailingWidthAttribute(text: string): number {
    const match = text.match(/^\s*\{width=\d+%\}/);
    return match ? match[0].length : 0;
}
