/**
 * 大纲面板的共享常量（从 outlinePanel.ts 拆出）。
 *
 * 为什么要单独放一个模块：面板的实现被拆成了 outlinePanel / outlineRender /
 * outlineActionBar 几个文件，而这些常量原本挂在 OutlinePanel 类的 static 上。
 * 兄弟模块只能用 `import type` 引 OutlinePanel（避免类模块之间的值循环依赖），
 * 一旦写成 `OutlinePanel.XXX` 就是在运行时取值——type 导入会被 esbuild 整个擦掉，
 * 于是运行时直接 `OutlinePanel is not defined`，整个编辑器初始化失败。
 *
 * 所以凡是「兄弟模块也要读」的类静态常量，统一搬到这里用普通值导入。
 *
 * @module webview/outline/outlineConstants
 */

/** 大纲面板允许的最小宽度（像素）。 */
export const OUTLINE_MIN_WIDTH = 220;

/** 大纲面板允许的最大宽度（像素）。 */
export const OUTLINE_MAX_WIDTH = 520;

/** 标题悬浮提示的延迟时间（毫秒），鼠标停留超过这个时长才弹提示。 */
export const OUTLINE_TOOLTIP_DELAY_MS = 500;

/**
 * 一级到六级标题的配色池，用于严格按层级循环取色。
 *
 * 索引方式是 `(level - 1) % length`，7 级及以下不存在，不会越界。
 */
export const OUTLINE_LEVEL_ACCENT_PALETTE: readonly string[] = [
    'rgba(235, 131, 131, 0.5)',
    'rgba(174, 154, 203, 0.5)',
    'rgba(125, 181, 205, 0.5)',
    'rgba(113, 167, 150, 0.5)',
    'rgba(220, 191, 97, 0.5)',
    'rgba(221, 163, 106, 0.5)',
];
