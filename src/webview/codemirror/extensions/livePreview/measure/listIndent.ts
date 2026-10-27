/**
 * 列表缩进全家桶（从 helpers.ts 拆出）。
 *
 * 缩进列数 / 空白像素宽 / 缩进单位探测 / 列表标记解析 / 行高与基线测量 /
 * 彩虹缩进色带样式生成。
 *
 * @module webview/codemirror/extensions/livePreview/listIndent
 */

import { measureTextIn, type MeasureEnv } from './textMeasure.js';
import { getMeasureContext, measureText, measureTextIn, type MeasureEnv } from './textMeasure.js';

// =============================================================================
// 列表缩进（层级引导线 + 空格/Tab 对齐）
// =============================================================================

/** 一个 Tab 按几列算。和编辑器里 tab-size 的常见约定保持一致。 */
const LIST_TAB_COLUMNS = 4;

/**
 * 取一行列表项的**行首空白**字符串。
 *
 * 认这几种标记：`- ` `* ` `+ ` 和 `1. ` `1) `；不是列表行返回 null。
 *
 * @param lineText - 整行文本
 * @returns 行首空白字符串（可能是空串）；不是列表行时返回 null
 */
function matchListWhitespace(lineText: string): string | null {
    const m = lineText.match(/^([ \t]*)(?:[-*+]|\d+[.)])(?=\s|$)/);
    return m ? m[1] : null;
}

/**
 * 把行首空白换算成「列数」：空格算 1 列，Tab 算 LIST_TAB_COLUMNS 列。
 *
 * @param whitespace - 行首空白字符串
 * @returns 列数
 */
export function indentColumns(whitespace: string): number {
    let cols = 0;
    for (const ch of whitespace) cols += ch === '\t' ? LIST_TAB_COLUMNS : 1;
    return cols;
}

/**
 * 量一段行首空白的**真实像素宽度**（空格按实测字宽，Tab 跳到下一个 4 列制表位）。
 *
 * 色带几何必须以真实空白宽度为准，不能一律用「层级 × 缩进单位」：
 * 5 个空格（层级 round 到 3 档）的实际 marker 列在 5/2 档之间，按网格算会让
 * 色带右缘超过真实正文起始、盖到文字上。精确落在网格上的缩进两者结果相同。
 *
 * @param whitespace - 行首空白字符串
 * @returns 像素宽度
 */
export function measureWhitespacePx(
    whitespace: string,
    env: MeasureEnv | null = null
): number {
    const spaceW = measureTextIn(env, ' ', '400');
    let px = 0;
    let col = 0;
    for (const ch of whitespace) {
        if (ch === '\t') {
            // Tab：推进到下一个 4 列制表位
            const next = Math.ceil((col + 1) / LIST_TAB_COLUMNS) * LIST_TAB_COLUMNS;
            px += (next - col) * spaceW;
            col = next;
        } else {
            px += spaceW;
            col += 1;
        }
    }
    return px;
}

/**
 * 探测这份文档的「缩进单位」（一级缩进等于几列）。
 *
 * 取全文列表行里**最小的那个正缩进**作为单位：2 空格文档探测出 2，
 * 4 空格文档探测出 4，Tab 文档探测出 4。这样空格缩进和 Tab 缩进
 * 会落到同一档上（就是需求里的「空格缩进也直接到达 tab 缩进」）。
 *
 * @param lineTexts - 全文各行文本
 * @returns 缩进单位（列），夹在 [2, 8]；找不到缩进时按 4
 */
export function detectIndentUnit(lineTexts: string[]): number {
    let unit = 0;
    for (const text of lineTexts) {
        const whitespace = matchListWhitespace(text);
        if (whitespace === null) continue;
        const cols = indentColumns(whitespace);
        if (cols > 0 && (unit === 0 || cols < unit)) unit = cols;
    }
    if (unit <= 0) return 4;
    return Math.min(8, Math.max(2, unit));
}

/**
 * 算一行列表项的缩进层级，以及行首空白的字符区间。
 *
 * 层级用四舍五入落到缩进单位上：写了 2 个空格而单位是 4，就按一级算
 * （即「只缩了一点也直接跳到下一档」），这样手写空格不会做出半级缩进。
 *
 * @param lineText - 整行文本
 * @param unit - 缩进单位（列），见 detectIndentUnit
 * @returns 层级、行首空白的字符长度、以及这一行是不是列表行；
 *          「没有缩进的根条目」和「根本不是列表行」的层级都是 0，靠 isList 区分
 */
export function getListIndent(
    lineText: string,
    unit: number
): { level: number; chars: number; isList: boolean } {
    const whitespace = matchListWhitespace(lineText);
    if (whitespace === null) return { level: 0, chars: 0, isList: false };
    const cols = indentColumns(whitespace);
    if (cols <= 0) return { level: 0, chars: 0, isList: true };
    return {
        level: Math.min(8, Math.max(1, Math.round(cols / unit))),
        chars: whitespace.length,
        isList: true,
    };
}

/**
 * `.cm-line` 的行内边距（px）。theme.ts 里 `.cm-line { padding: 0 4px }` ——
 * 行内背景改成 border-box 定位后，横向坐标要把这 4px 一起算进去。
 * 改 theme.ts 那边的话这里必须跟着改。
 */
export const LINE_PADDING_PX = 4;

/**
 * 一条缩进色带的描述。
 *
 * 层级口径与有序/无序**无关**：当前行的缩进层级只由行首空白决定
 * （见 getListIndent / parseListMarkerLine），marker 类型只影响右缘位置。
 *
 * 所有色带一律**满行高**：一行只要缩进到深度 D，深度 0..D 的每一级色带都铺满
 * 整行——它们是这一行真实占用的缩进背景。旧实现给「收尾层级」画半高 tail，
 * 在深层行上会出现一排半高中间断层（用户反馈的 bug），已废弃。
 */
export interface IndentGuide {
    /**
     * marker（`-` / `1.`）之后**正文文字开始处**相对行 border-box 左缘的位置（px）。
     * 色带右缘对齐到这里。
     */
    contentX: number;
}

/**
 * 一个列表行 marker 区的解析结果（纯文本口径，不依赖 Lezer 语法树）。
 *
 * 关键：**有序 / 无序 / 任务项用同一套缩进规则**。Lezer 对有序列表要求
 * 「缩进 ≥ marker 宽度（`1. ` = 3 列）」才建立嵌套，2 空格的有序子项会被
 * 压平成兄弟节点、甚至变成上一行的 lazy 续行；无序列表 2 空格即可嵌套。
 * 统一走「行首空白 → 层级」后，三者行为一致，marker 类型只需提供自己的宽度。
 */
export interface ListMarkerInfo {
    /** 行首空白原文（可能含 Tab）。 */
    indentText: string;
    /** 行首空白换算出的视觉列数（Tab=4），即本行的缩进层级依据。 */
    indentCols: number;
    /** marker 文本：`-` `*` `+` 或 `1.` `1)`。 */
    marker: string;
    /** marker 与正文（或任务复选框）之间的分隔空白原文。 */
    gap: string;
    /** marker 大类：无序圆点 / 有序序号 / 任务复选框。 */
    type: 'bullet' | 'ordered' | 'task';
}

/**
 * 从一行文本解析列表 marker 区；不是列表行返回 null。
 *
 * 与 matchListWhitespace 的差别：那个只用来探缩进，这里同时取出 marker 文本、
 * 分隔空白和类型，供「按缩进层级链」生成色带时量各级 marker 的真实宽度。
 *
 * @param lineText - 整行文本
 * @returns marker 区信息；非列表行（含 `1.foo` 这种 marker 后无空白的）返回 null
 */
export function parseListMarkerLine(lineText: string): ListMarkerInfo | null {
    // 分组：1=行首空白 2=marker 3=marker 后分隔空白
    // marker 后必须紧跟空白或行尾（有序 `1.foo` 不算 marker）
    const m = /^([ \t]*)([-*+]|\d+[.)])(?=[ \t]|$)([ \t]*)/.exec(lineText);
    if (!m) return null;
    const indentText = m[1];
    const marker = m[2];
    const gap = m[3];
    // 任务项：bullet marker + 空白后跟 `[x]` / `[ ]`（复选框由 TaskMarker 分支渲染）
    const afterGap = lineText.slice(m[0].length);
    const taskMatch = /^\[([ xX])\]/.exec(afterGap);
    const type: ListMarkerInfo['type'] = taskMatch
        ? 'task'
        : /\d/.test(marker)
          ? 'ordered'
          : 'bullet';
    return {
        indentText,
        indentCols: indentColumns(indentText),
        marker,
        gap,
        type,
    };
}

/**
 * 正文行高（px）。
 *
 * 三级来源，越靠前越准（与 widgets.ts 里 mathLineHeightPx 同一套思路）：
 * 1. 页面上已有正文行 —— 量它的计算行高（用户可配，量出来最准）；
 * 2. 还没有（视图首次构建）—— 按 `--livewritemd-line-height` 现算，
 *    `1.7em` 这种写法乘上正文字号，`22px` 直接用；
 * 3. 都读不到 —— 字号 × 1.7 兜底。
 *
 * @returns 行高（px）
 */
export function measureLineHeightPx(): number {
    const line = document.querySelector('#editor .cm-line');
    if (line) {
        const measured = Number.parseFloat(getComputedStyle(line).lineHeight);
        if (Number.isFinite(measured) && measured > 0) return measured;
    }
    const rootStyle = getComputedStyle(document.documentElement);
    const raw = rootStyle.getPropertyValue('--livewritemd-line-height').trim();
    const value = Number.parseFloat(raw);
    if (Number.isFinite(value) && value > 0) {
        if (raw.endsWith('px')) return value;
        // 正文字号兜底取 14：首次构建时拿不到 .cm-content 的计算字号，
        // 而 14 是主题默认值；挂载后 bootstrap 会重建装饰，重算成准的
        return value * 14;
    }
    return 14 * 1.7;
}

/**
 * 行盒顶部到**文字基线**的距离（px）。
 *
 * own 引导线不再从圆点中心（半行高）起笔，而是从「下划线位置」
 * （基线附近）起笔 —— 竖线与圆点之间留出呼吸空间，视觉上像从
 * 文字下方的下划线处垂下去。
 *
 * 用 canvas 字体度量：baseline = 半行距 + fontAscent。
 * 拿不到 fontBoundingBox 指标时按经验值（字号 × 0.8）兜底。
 */
export function measureBaselineInset(): number {
    const lineHeight = measureLineHeightPx();
    // 首帧可能拿不到度量上下文：用默认字号兜底
    const mc = getMeasureContext();
    const size = mc?.size ?? 14;
    let ascent: number;
    let fontHeight: number;
    const metrics = mc?.ctx.measureText('ABC');
    const fbAscent = (metrics as any)?.fontBoundingBoxAscent as
        | number
        | undefined;
    const fbDescent = (metrics as any)?.fontBoundingBoxDescent as
        | number
        | undefined;
    if (fbAscent && fbDescent) {
        ascent = fbAscent;
        fontHeight = fbAscent + fbDescent;
    } else {
        ascent = size * 0.8;
        fontHeight = size;
    }
    const halfLeading = Math.max(0, (lineHeight - fontHeight) / 2);
    // 再下移到下划线位置（基线之下，Chrome 自动下划线偏移 ≈ 字号 0.14）
    return halfLeading + ascent + size * 0.14;
}

/** tail 末端渐隐段的长度（px）：最后这么长一段从实色渐变到透明。 */
const TAIL_FADE_PX = 9;

/**
 * 缩进引导线的 rainbow 调色板：按缩进层级循环取色。
 *
 * 选用饱和度/亮度适中的彩虹色（红橙黄绿青蓝紫），在深底、浅底上都可辨，
 * 且 1px 细线不会过于刺眼；层级超过调色板长度后循环。
 */
const RAINBOW_INDENT_COLORS = [
    '#f87171', // 红
    '#fb923c', // 橙
    '#facc15', // 黄
    '#4ade80', // 绿
    '#22d3ee', // 青
    '#60a5fa', // 蓝
    '#a78bfa', // 紫
];

/** 取某缩进层级的 rainbow 颜色。 */
function rainbowIndentColor(levelIndex: number): string {
    const i = ((levelIndex % RAINBOW_INDENT_COLORS.length) +
        RAINBOW_INDENT_COLORS.length) %
        RAINBOW_INDENT_COLORS.length;
    return RAINBOW_INDENT_COLORS[i];
}

/** 把 #rrggbb 解析成 [r,g,b]；非法输入回退中性灰。 */
function hexToRgb(hex: string): [number, number, number] {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return [148, 163, 184];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * 缩进色带：以右侧 marker 颜色着色，向左铺到上一个 marker / 行左边界。
 *
 * - 只有**固定透明度**，无渐变、无梦幻感；alpha 与代码块 indent 色带一致（0.18）；
 * - 所有悬垂线（1px 竖线）一律隐藏，只保留色带；
 * - 色带右缘一直铺到 marker 中心列（不内缩），相邻色带/色带与边界之间不留白缝。
 */
const BAND_ALPHA = 0.18;

/**
 * 相邻色带的叠压量（px）：每级色带向左压过上一级这么多。
 *
 * 不叠压时，色带边界是 19.39px 这类小数，Chrome 对「上一层右缘」和
 * 「下一层左缘」的取整互相独立、方向可能不一致，中间漏出 1px 行底色
 * （视觉上就是一二级之间的白线）。固定叠压 1px 后，无论两端如何取整
 * 都被覆盖；该 1px 由先绘制（更靠上）的上层色带盖住，外观无痕。
 */
const BAND_OVERLAP_PX = 1;

/** 计算一条色带的几何（左缘、宽）；纵向一律顶对齐、满行高，单位 px。 */
function bandGeometry(
    guides: IndentGuide[],
    index: number
): { left: number; width: string } {
    const g = guides[index];
    // 左缘：上一个 marker 的正文起始列再左移叠压量；最外层 = 行 border-box 左缘（0）。
    const left = index > 0 ? guides[index - 1].contentX - BAND_OVERLAP_PX : 0;
    // 宽：一直铺到「本 marker 之后正文开始处」(contentX)，盖满不留缝。
    const width = Math.max(0, g.contentX - left);
    return { left, width: `${width.toFixed(2)}px` };
}

/**
 * 根据各级 marker 的**真实中心位置**生成行装饰的行内样式：
 * 悬挂缩进 + 缩进引导线背景。
 *
 * ## 悬挂缩进（hangPx）
 *
 * `padding-left = 正文左内边距(lineGutterGap，默认 4px) + hangPx`、`text-indent = -hangPx`：
 * padding 把文字区推到「marker 所在列」，text-indent 只把**第一个视觉行**
 * 拉回原来的行首；于是折出来的续行全部从 marker 列开始（需求：续行与
 * 该层级 marker `-` 本身那一列对齐），首行外观不变。
 *
 * ## 色带
 *
 * 每一级是一个满行高的 linear-gradient 色块，背景原点用 border-box，同一层级
 * 的色带在不同缩进的行上始终垂直对齐，不受本行 padding 影响。
 * 颜色按层级在 rainbow 调色板里循环取。
 *
 * 层级链由调用方按**行首空白**算出（有序/无序同一套规则）；各级右缘用该级
 * marker（`-` / `1.` / 任务框）的真实宽度，因此 `10.` 比 `1.` 宽也能对齐。
 *
 * @param guides - 从外到内各级色带（条数 = 层级深度 + 1）
 * @param hangPx - 悬挂缩进宽度（px），即 marker 列相对内容左缘的位置
 * @returns 可写入 line decoration attributes.style 的样式
 */
export function createListIndentStyle(
    guides: IndentGuide[],
    hangPx: number
): string {
    const decls: string[] = [];

    // —— 悬挂缩进 ——
    if (hangPx > 0) {
        // padding-left 行内长式会顶掉 theme.ts 给 .cm-line 设的左内边距，
        // 所以用 calc 把「正文与行号线距离」的 CSS 变量显式加回来；
        // LINE_PADDING_PX 是变量缺省时的兜底，右内边距不受影响
        decls.push(
            `padding-left:calc(var(--livewritemd-line-padding-left, ${LINE_PADDING_PX}px) + ${hangPx.toFixed(2)}px)`,
            `text-indent:${(-hangPx).toFixed(2)}px`
        );
    }

    // —— 缩进色带（rainbow：每个缩进层级一种颜色；悬垂线全部隐藏）——
    if (guides.length > 0) {
        const images: string[] = [];
        const sizes: string[] = [];
        const positions: string[] = [];

        guides.forEach((g, levelIndex) => {
            const [r, gg, b] = hexToRgb(rainbowIndentColor(levelIndex));
            // 纯色带、固定透明度（无渐变 / 梦幻感）
            images.push(`linear-gradient(rgba(${r},${gg},${b},${BAND_ALPHA}), rgba(${r},${gg},${b},${BAND_ALPHA}))`);
            const geo = bandGeometry(guides, levelIndex);
            // 纵向满行高（100%）、顶对齐
            sizes.push(`${geo.width} 100%`);
            positions.push(`${geo.left.toFixed(2)}px top`);
        });
        decls.push(
            'background-origin:border-box',
            'background-repeat:no-repeat',
            `background-image:${images.join(', ')}`,
            `background-size:${sizes.join(', ')}`,
            `background-position:${positions.join(', ')}`
        );
    }

    return decls.join('; ');
}

/**
 * 算出一级缩进（也就是缩进单位）的像素宽度。
 *
 * 直接量 unit 个空格的总宽：正文用等宽字体时它就是一个制表位，
 * 用比例字体时也是「和源码里敲 unit 个空格一样宽」，两种都比写死 em 靠谱。
 *
 * @param unit - 缩进单位（列）
 * @returns 像素宽度；量不了时返回 0（调用方会退回 CSS 的 em 兜底值）
 */
export function measureIndentUnitPx(unit: number): number {
    return measureText(' '.repeat(Math.max(1, unit)), '400');
}
