/**
 * 标题编号 / 取消编号的核心逻辑。
 *
 * ## 要解决的问题
 *
 * 大纲底部两个按钮：
 * 1. **标题编号**：给文档里所有标题加上层级编号；已经有编号的，按既有格式重新顺号。
 * 2. **取消编号**：把标题开头的编号摘掉，标题正文一个字不动。
 *
 * ## 编号格式的适配范围
 *
 * 每个编号都被拆成「若干个编号原子 + 分隔符 + 后缀/包围符」的结构，
 * 原子支持这些种类（以及它们在同一条编号里的混排组合）：
 *
 * - 阿拉伯数字：`1`、`01`、`1.1.1`
 * - 全角数字：`１`、`１．１`
 * - 中文数字：`一`、`十一`、`一百零一`、`第一卷` / `第三章` / `第五节`
 * - 英文字母：`A`、`a`、`1.A`（超过 Z 自动进位成 `AA`）
 * - 罗马数字：`I`、`IV`、`i`、`Ⅰ`、`Ⅻ`
 * - 带圈 / 括号：`①`、`㈠`、`（一）`、`(1)`、`1)`、`一、`
 *
 * ## 三条业务规则（用户原话整理）
 *
 * 1. **全都没有编号** → 按默认层级格式编号：`1` / `1.1` / `1.1.1`。
 * 2. **有编号但顺序乱了**（比如 `1.2` 后面直接 `1.5`）→ 沿用该格式，全部重新顺号。
 * 3. **编号格式不统一**（比如 `1.2` 后面是 `1.a`）→ 以**从上往下第一个遇到的
 *    编号格式为准**，向下统一编号。
 *
 * ## 位置约定
 *
 * 本模块只吃 Markdown 全文字符串、吐出一批文本替换区间（偏移基于字符串的
 * UTF-16 索引，和 CodeMirror 的文档位置一一对应），不直接碰编辑器，
 * 方便被大纲面板和其它入口复用。
 *
 * @module webview/headingNumbering
 */


// 类型与实现已拆到同目录：numberingModel / numberingParse / numberingRender
import { scanHeadings, parseNumbering } from './numberingParse.js';
import { resolveFormat, computeLogicalDepths, renderNumbering } from './numberingRender.js';
import type { HeadingInfo } from './numberingModel.js';

export type { HeadingEdit } from './numberingModel.js';
import type { HeadingEdit } from './numberingModel.js';

// =============================================================================
// 对外入口：编号 / 取消编号
// =============================================================================

/**
 * 给所有标题生成「标题编号」的文本修改。
 *
 * 流程：
 * 1. 扫描标题、算逻辑层级；
 * 2. 确定格式模板（首个既有编号 or 默认 1/1.1/1.1.1）；
 * 3. 按文档顺序维护各级计数，逐标题渲染新编号；
 * 4. 对每个标题，把旧前缀（可能没有）替换成新编号，
 *    编号与正文之间统一留一个空格。
 *
 * @param content - Markdown 全文
 * @returns 修改区间列表；没有标题时为空数组
 */
export function buildHeadingNumberingEdits(content: string): HeadingEdit[] {
    const headings = scanHeadings(content);
    if (headings.length === 0) return [];

    const format = resolveFormat(content, headings);
    const depths = computeLogicalDepths(headings);
    const counters: number[] = [0]; // 下标从 1 开始用

    const edits: HeadingEdit[] = [];
    for (let i = 0; i < headings.length; i += 1) {
        const heading = headings[i];
        const depth = depths[i];

        // 计数：当前层 +1，所有更深层归零（兄弟标题互不顺号）
        counters[depth] = (counters[depth] ?? 0) + 1;
        for (let d = depth + 1; d < counters.length; d += 1) counters[d] = 0;

        // 截出标题正文
        let lineEnd = content.indexOf('\n', heading.contentFrom);
        if (lineEnd === -1) lineEnd = content.length;
        const text = content.slice(heading.contentFrom, lineEnd).replace(/\r$/, '');

        const number = renderNumbering(format, counters, depth);
        // 编号和正文之间的间隔：复刻首个编号的既有习惯（空格或紧贴）
        const gap = format.spaceAfter ? ' ' : '';

        // 旧前缀（可能没有）
        const oldPrefix = parseNumbering(text);
        if (oldPrefix) {
            // 替换范围 = 旧前缀 + 它后面的空白（空白统一重排，避免遗留多余空格）。
            // 正文不在替换区间内，insert 只写「编号 + 间隔」，
            // 千万别把正文拼进 insert——它在 to 之后会原样保留，拼了就重复。
            const spaceRun = text.slice(oldPrefix.length).match(/^[ \t]+/)?.[0].length ?? 0;
            const replacedEnd = oldPrefix.length + spaceRun;
            const hasRest = text.slice(replacedEnd).length > 0;
            const insert = hasRest ? `${number}${gap}` : number;
            edits.push({ from: heading.contentFrom, to: heading.contentFrom + replacedEnd, insert });
        } else {
            // 没有旧前缀：纯插入编号，正文留在原地不动；正文非空才补间隔
            const insert = text ? `${number}${gap}` : number;
            edits.push({ from: heading.contentFrom, to: heading.contentFrom, insert });
        }
    }
    return edits;
}

/**
 * 生成「取消编号」的文本修改：只摘标题开头的编号，正文原样保留。
 *
 * 没有编号的标题不产生修改。同样兼容全部受支持的编号格式。
 *
 * @param content - Markdown 全文
 * @returns 修改区间列表
 */
export function buildHeadingUnnumberEdits(content: string): HeadingEdit[] {
    const headings = scanHeadings(content);
    const edits: HeadingEdit[] = [];

    for (const heading of headings) {
        let lineEnd = content.indexOf('\n', heading.contentFrom);
        if (lineEnd === -1) lineEnd = content.length;
        const text = content.slice(heading.contentFrom, lineEnd).replace(/\r$/, '');

        const parsed = parseNumbering(text);
        if (!parsed) continue;

        // 摘掉编号以及编号后的空白（范围必须含空白，否则空白会被留下来）。
        // 正文在范围之外原样保留，所以 insert 是空串——写成正文会重复一遍。
        const spaceRun = text.slice(parsed.length).match(/^[ \t]+/)?.[0].length ?? 0;
        edits.push({
            from: heading.contentFrom,
            to: heading.contentFrom + parsed.length + spaceRun,
            insert: '',
        });
    }
    return edits;
}
