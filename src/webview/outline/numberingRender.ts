/**
 * 标题编号：渲染与层级生成（从 headingNumbering.ts 拆出）。
 *
 * 把「第几级、第几个」渲染回编号文本；resolveFormat 会参考文中已有
 * 编号样式（调 numberingParse 的 parseNumbering）决定新编号的格式。
 *
 * @module webview/outline/numberingRender
 */

import { CN_DIGIT_MAP } from './numberingModel.js';
import type { NumberType, NumberingFormat, HeadingInfo } from './numberingModel.js';
import { parseNumbering } from './numberingParse.js';

// =============================================================================
// 编号原子：渲染
// =============================================================================

/**
 * 把数值渲染成中文数字（1-9999）。
 *
 * 规则按中文习惯：
 * - 10 以内直接取字，10 = 十，11-19 = 十X，20-99 = X十（X）；
 * - 中间隔位为 0 要补「零」：101 = 一百零一、1010 = 一千零一十；
 * - 整百/整十不挂尾零：110 = 一百一十、1100 = 一千一百。
 *
 * @param value - 数值
 * @returns 中文数字串
 */
function renderChineseNumber(value: number): string {
    const digits = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

    /** 渲染 1-99 这一段（供百位、千位之后复用）。 */
    const renderUnderHundred = (n: number): string => {
        if (n < 10) return digits[n];
        if (n === 10) return '十';
        if (n < 20) return `十${digits[n - 10]}`;
        const tens = Math.floor(n / 10);
        const rest = n % 10;
        return `${digits[tens]}十${rest > 0 ? digits[rest] : ''}`;
    };

    if (value < 100) return renderUnderHundred(value);

    const parts: string[] = [];
    const thousands = Math.floor(value / 1000);
    const hundreds = Math.floor((value % 1000) / 100);
    const tens = value % 100;

    if (thousands > 0) parts.push(`${digits[thousands]}千`);
    if (hundreds > 0) {
        parts.push(`${digits[hundreds]}百`);
    } else if (parts.length > 0 && tens > 0) {
        // 百位为 0 而后面还有数：补一个零（1010、1001 都走这里）
        parts.push('零');
    }
    if (tens > 0) {
        if (tens < 10 && parts[parts.length - 1] !== '零') {
            // 百位非零时，十位为 0（101 = 一百零一）
            parts.push('零');
        }
        parts.push(renderUnderHundred(tens));
    }
    return parts.join('');
}

/**
 * 把数值渲染成英文字母编号。
 *
 * 双射 26 进制：1-26 = A-Z，27 = AA，28 = AB…和 Excel 列号一致。
 *
 * @param value - 数值（≥1）
 * @param upper - 是否大写
 * @returns 字母编号串
 */
function renderLatinNumber(value: number, upper: boolean): string {
    const baseCode = upper ? 65 : 97;
    let remaining = value;
    let result = '';
    while (remaining > 0) {
        remaining -= 1;
        result = String.fromCodePoint(baseCode + (remaining % 26)) + result;
        remaining = Math.floor(remaining / 26);
    }
    return result;
}

/**
 * 把数值渲染成 ASCII 罗马数字（1-4999）。
 *
 * 按「千 / 个百（含 CM、CD）/ 个十（含 XC、XL）/ 个（含 IX、IV）」
 * 四段查表拼接。
 *
 * @param value - 数值
 * @param upper - 是否大写
 * @returns 罗马数字串
 */
function renderRomanNumber(value: number, upper: boolean): string {
    const table: Array<[number, string, string]> = [
        [1000, 'M', 'm'],
        [900, 'CM', 'cm'],
        [500, 'D', 'd'],
        [400, 'CD', 'cd'],
        [100, 'C', 'c'],
        [90, 'XC', 'xc'],
        [50, 'L', 'l'],
        [40, 'XL', 'xl'],
        [10, 'X', 'x'],
        [9, 'IX', 'ix'],
        [5, 'V', 'v'],
        [4, 'IV', 'iv'],
        [1, 'I', 'i'],
    ];
    let remaining = value;
    let result = '';
    for (const [num, upperToken, lowerToken] of table) {
        while (remaining >= num) {
            result += upper ? upperToken : lowerToken;
            remaining -= num;
        }
    }
    return result;
}

/**
 * 按原子种类渲染一个计数原子。
 *
 * 个别种类的可表示范围有限（带圈阿拉伯数字只到 ⑳、全角数字单个码位只到 9），
 * 超范围时退化成「阿拉伯数字 + 同种包围符」的写法，保证任何计数都渲染得出来。
 *
 * @param type - 原子种类
 * @param value - 计数值（≥1）
 * @returns 原子文本（不含 open / close）
 */
function renderAtom(type: NumberType, value: number): string {
    switch (type) {
        case 'arabic':
            return String(value);
        case 'fullwidth':
            // 全角码位只能逐位表示 0-9，整体转全角即可
            return Array.from(String(value), (digit) =>
                String.fromCodePoint((digit.codePointAt(0) ?? 0) + 0xfee0)
            ).join('');
        case 'chinese':
            return renderChineseNumber(Math.min(value, 9999));
        case 'latinUpper':
            return renderLatinNumber(value, true);
        case 'latinLower':
            return renderLatinNumber(value, false);
        case 'romanUpper':
            return renderRomanNumber(value, true);
        case 'romanLower':
            return renderRomanNumber(value, false);
        case 'romanUnicodeUpper': {
            // Unicode 专用符号只覆盖 1-12，超过就退回 ASCII 大写罗马数字
            if (value >= 1 && value <= 12) return String.fromCodePoint(ROMAN_UNICODE_UPPER_START + value - 1);
            return renderRomanNumber(value, true);
        }
        case 'romanUnicodeLower': {
            if (value >= 1 && value <= 12) return String.fromCodePoint(ROMAN_UNICODE_LOWER_START + value - 1);
            return renderRomanNumber(value, false);
        }
        case 'circled':
            // 带圈只到 ⑳（20），超出退回普通阿拉伯数字
            if (value >= 1 && value <= 20) return String.fromCodePoint(CIRCLED_START + value - 1);
            return String(value);
        case 'circledCn':
            // 带圈中文只到 ㈩（10），超出退回普通中文数字
            if (value >= 1 && value <= 10) return String.fromCodePoint(CIRCLED_CN_START + value - 1);
            return renderChineseNumber(value);
    }
}

// =============================================================================
// 层级与编号生成
// =============================================================================

/**
 * 默认编号格式：`1` / `1.1` / `1.1.1`。
 *
 * 模板只放一个阿拉伯原子、没有后缀；深层级自动用 `.` 续接
 * （见 renderNumbering 的扩展规则）。
 */
const DEFAULT_FORMAT: NumberingFormat = {
    open: '',
    segments: ['arabic'],
    separators: [],
    close: '',
    // 新建编号默认带一个空格：`1 标题`
    spaceAfter: true,
};

/**
 * 按格式模板和各级计数渲染一条编号。
 *
 * 层级比模板深时（比如模板只在一级标题上出现、现在要编三级标题）：
 * - 原子种类：复用模板最后一个原子的种类；
 * - 分隔符：复用模板最后一个分隔符，模板本身没有分隔符时用 `.`。
 *
 * @param format - 编号格式模板
 * @param counters - 各级当前计数（counters[d] 为第 d 层的序号，从 1 起）
 * @param depth - 当前逻辑层级（≥1）
 * @returns 编号串
 */
function renderNumbering(format: NumberingFormat, counters: number[], depth: number): string {
    const lastSegment = format.segments[format.segments.length - 1];
    const lastSeparator = format.separators[format.separators.length - 1] ?? '.';

    const tokens: string[] = [];
    for (let d = 0; d < depth; d += 1) {
        const type = d < format.segments.length ? format.segments[d] : lastSegment;
        tokens.push(renderAtom(type, counters[d + 1]));
    }

    // 按层级逐个插分隔符：模板内的用模板的，超出模板的复用规则
    let body = tokens[0];
    for (let d = 1; d < depth; d += 1) {
        const separator = d - 1 < format.separators.length ? format.separators[d - 1] : lastSeparator;
        body += separator + tokens[d];
    }
    return `${format.open}${body}${format.close}`;
}

/**
 * 计算所有标题的「逻辑层级」序号。
 *
 * 两个修正：
 * 1. **基准层级归一**：文档可能直接从二级标题开始，把文档里的最小层级当作第 1 层；
 * 2. **跳级夹紧**：H1 后面直接 H3 时，编号会出现 `1.0.1` 这种空档，
 *    把它夹紧成上一标题层级 +1（即按第 2 层编号）。
 *
 * @param headings - 扫描出的标题
 * @returns 每个标题的逻辑层级（与入参等长、等序）
 */
function computeLogicalDepths(headings: HeadingInfo[]): number[] {
    if (headings.length === 0) return [];
    const minLevel = Math.min(...headings.map((h) => h.level));
    const depths: number[] = [];
    let previousDepth = 0;
    for (const heading of headings) {
        const rawDepth = heading.level - minLevel + 1;
        const depth = Math.min(rawDepth, previousDepth + 1);
        depths.push(depth);
        previousDepth = depth;
    }
    return depths;
}

/**
 * 选编号模板：第一个能解析出编号前缀的标题说了算。
 *
 * 这是「格式不统一时，按第一个遇到的向下统一」这条规则的落点。
 * 所有标题都没编号时使用默认阿拉伯层级格式。
 *
 * @param content - Markdown 全文
 * @param headings - 扫描出的标题
 * @returns 编号格式模板
 */
function resolveFormat(content: string, headings: HeadingInfo[]): NumberingFormat {
    for (const heading of headings) {
        // 找到下一个行尾（或文末）截出标题正文；ATX 行尾的闭合 # 不影响开头解析
        let lineEnd = content.indexOf('\n', heading.contentFrom);
        if (lineEnd === -1) lineEnd = content.length;
        const text = content.slice(heading.contentFrom, lineEnd).replace(/\r$/, '');
        const parsed = parseNumbering(text);
        if (parsed) return parsed.format;
    }
    return DEFAULT_FORMAT;
}

