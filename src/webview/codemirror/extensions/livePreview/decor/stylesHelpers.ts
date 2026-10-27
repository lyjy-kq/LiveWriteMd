/**
 * 样式片段共用的助手（从 styles.ts 拆出）：复选框对勾 SVG + 语义色混色函数。
 *
 * @module webview/codemirror/extensions/livePreview/stylesHelpers
 */

/**
 * 勾选标记的 SVG（白色对勾），作为复选框 checked 背景。
 * input 元素不支持 ::after，对勾只能走背景图；data URI 内
 * 用单双引号嵌套避免转义。
 */
export const CHECK_SVG =
    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path d='M2.5 6.2 L4.8 8.5 L9.5 3.8' fill='none' stroke='white' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'/></svg>\")";

/**
 * 语义色的主题化微调（标题 / 加粗 / 斜体 / 链接）。
 *
 * 和行内代码改用 textPreformat 主题色的思路一致：不再让固定的粉彩色
 * 直接贴在任意主题背景上，而是保留原来的色相，只把颜色往当前主题的
 * 正文色方向混一部分：
 * - 深色主题的正文偏亮 → 语义色稍微提亮、降一点饱和，和正文处在同一亮度层（25%）；
 * - 浅色主题的正文偏暗 → 同一色相自动压深，白底上不会发虚（46%）；
 * - 黄色（h5）在浅色底上天然最难读，额外多压一点（56%），仍是黄 / 橄榄色系；
 * - 只动明度 / 饱和度，不动色相：红仍是红、紫仍是紫、链接仍是绿色系。
 *
 * 用户自定义颜色不参与混合 —— 外层的 `var(--livewritemd-*-color, …)`
 * 会直接覆盖整个 `color-mix()`。
 *
 * @param hue 原始语义色（深色主题下的基准色）
 * @param light 是否浅色主题版本（决定主题变量缺失时的兜底正文色）
 * @param lightAmount 浅色主题的混入比例（默认 46%，h5 单独调高）
 * @param darkAmount 深色主题的混入比例（默认 25%；h2 紫色单独调低 = 更深）
 * @returns 可用于 CSS 的颜色表达式
 */
export function tone(hue: string, light = false, lightAmount = 46, darkAmount = 25): string {
    const amount = light ? lightAmount : darkAmount;
    const fallback = light ? '#24292e' : '#d4d4d4';
    return `color-mix(in srgb, ${hue} ${100 - amount}%, var(--vscode-editor-foreground, ${fallback}) ${amount}%)`;
}
