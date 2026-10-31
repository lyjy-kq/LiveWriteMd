/**
 * MapCanvas 的调参常量（从 canvas.ts 拆出）。
 *
 * 全部是性能/交互调参：显示实例缓存上限、换真泵节奏、视口余量、
 * 缩略图尺寸、缩放档位阈值等。canvas.ts 与各协作模块共用。
 *
 * @module webview/mindmap/engine/canvasConstants
 */

/** 一次 setData 中直接创建真实显示实例的节点数（其余先占位）。 */
export const PROGRESSIVE_THRESHOLD = 24;
/**
 * 换真泵每批处理的节点数。
 *
 * 一次建 12 个轻量 CM 实测 90~130ms，单个任务太长；单个 CM 约 11~22ms，
 * 所以每批 2 个（约 20~45ms 一个任务），16ms 节奏下每秒仍能换 120 个。
 * 松手后第一屏内容一两百毫秒内就能补齐，不会盯着占位文本看很久。
 */
export const PROGRESSIVE_BATCH = 2;
/**
 * 手势进行中，换真泵的轮询间隔（ms）。
 *
 * 拖动/缩放时绝不创建 mini-CM：实测创建 8 个轻量 CM 要 90ms，
 * 一次拖动里换真泵跑一批就能让帧间隔从 16ms 跳到 80~300ms。
 * 手势期间只轮询，松手后立刻继续换真。
 */
export const PUMP_PAUSE_MS = 100;
/** 最后一次滚轮缩放后，视为「缩放手势进行中」的时长（ms）。 */
export const WHEEL_ACTIVE_MS = 120;
/** 视口外挂载余量（屏幕像素）。 */
export const VIEW_MARGIN = 320;
/**
 * 卸载余量相对挂载余量的倍数（双圈制）：
 * 小圈内 = 立即挂载区；小圈外大圈内 = 预热挂载区（空闲时由 prewarm 填满，
 * 手势拖过去零挂载成本）；出了大圈才卸载。手势期间一律不卸载——
 * 拖回来的节点马上要，卸载了再挂会触发 CM 重测量（起步卡顿的来源之一）。
 */
export const UNMOUNT_MARGIN_MULT = 3;
/** 预热挂载：空闲时每批挂几个、间隔多久、最多挂到多少个节点。 */
export const PREWARM_BATCH = 8;
export const PREWARM_DELAY_MS = 250;
export const PREWARM_CAP = 600;
/** 按下后移动超过该距离才算拖动（像素）。 */
export const DRAG_THRESHOLD = 5;
/** 拖到边缘多少像素内自动平移。 */
export const AUTO_PAN_EDGE = 48;
/** 自动平移每帧步长（像素）。 */
export const AUTO_PAN_STEP = 14;
/** 缩放范围。 */
export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 3;
/**
 * 高倍缩放阈值（1 = 100%）。
 *
 * 超过这个比例时给画布加 `lwm-hi-zoom`：CSS 会把节点底色浓度按比例压低，
 * 文字与底色的对比度随之上升（实测 16% → 6% 时同一段文字的 Laplacian
 * 从 119 升到 128，16% → 0% 升到 133）。
 *
 * 为什么只有这一个旋钮：字形栅格化本身已经到顶 —— 实测 300% 变换里的
 * 节点文字与「原生按 42px 排版」的平面文本逐项指标完全一致
 * （lap 88.15 / lapInk 176.21 / ink 3606 / 彩边 3.36），
 * 再把节点位置对齐到设备像素也是 55.03 → 54.95（无变化）。
 * 也就是说重新排版、重新栅格化、像素对齐都不会更清晰，
 * 高倍下还能真实改善的只有对比度（以及字重 / 字体这类排版选择）。
 */
export const HI_ZOOM_THRESHOLD = 1.5;
/** 缩略图尺寸（CSS px）。 */
export const MINIMAP_W = 190;
export const MINIMAP_H = 120;
/** 缩略图重绘合并间隔（ms）：平移/缩放高频触发时最多 25fps。 */
export const MINIMAP_REDRAW_MS = 40;
/**
 * 滚轮缩放停下多久后撤掉缩放层的 will-change（ms）。
 *
 * 缩放期间缩放层是合成层，文字用缓存位图拉伸（运动中略糊，但流畅）；
 * 停下后必须撤掉，让浏览器按最终比例重新栅格化，文字恢复清晰。
 * 与 WHEEL_ACTIVE_MS 接近即可：先恢复清晰，再考虑换真泵。
 */
export const ZOOM_SETTLE_MS = 120;

/**
 * 文本类节点（标题 / 列表项 / 段落）。
 *
 * 尺寸测量时需要「文本态 / 显示态」各量一遍取最大值，只对这几类做；
 * 代码 / 表格 / 公式 / mermaid 是 widget 渲染，源码态宽度没有意义。
 */
export const TEXT_KINDS = new Set<string>(['heading', 'list', 'para', 'quote']);

/**
 * 标题色板 h1~h6 的基准色（色相与 live 的默认色一致；live 会把它们
 * 按主题正文色做明度微调，这里只用于节点底色的色相轮换，保持原色即可）。
 * 背景色轮换用：CSS 变量 --livewritemd-hN-color 没定义时拿它兜底。
 */
// h2 紫色与 live 同步加深过（#ae9acb → #a17fe0），改 live 基准色时这里要一起改
export const HEADING_TINT_FALLBACKS = ['#eb8383', '#a17fe0', '#7db5cd', '#71a796', '#dcbf61', '#dda36a'];
