/**
 * 标题编号：扫描与解析（从 headingNumbering.ts 拆出）。
 *
 * scanHeadings 扫出文档全部标题；parseNumbering 识别标题文本里的
 * 编号前缀（中文数字 / 罗马数字 / 拉丁字母 / 圈号等链式组合）。
 *
 * @module webview/outline/numberingParse
 */

import {
    SEPARATOR_CHARS,
    SUFFIX_CHARS,
    CN_DIGIT_MAP,
    CHAPTER_SUFFIXES,
    MAX_ARABIC_VALUE,
    CIRCLED_START,
    CIRCLED_END,
    CIRCLED_CN_START,
    CIRCLED_CN_END,
    ROMAN_UNICODE_UPPER_START,
    ROMAN_UNICODE_LOWER_START,
} from './numberingModel.js';
import type {
    NumberType,
    ParsedAtom,
    NumberingFormat,
    ParsedNumbering,
    HeadingInfo,
} from './numberingModel.js';

// =============================================================================
// 标题扫描
// =============================================================================

/**
 * 从 Markdown 全文里扫出所有标题（ATX 和 setext 两种写法都认）。
 *
 * 实现上按行扫描而不是查语法树：
 * - 本模块运行时拿到的是字符串，不保证语法树已经增量解析完；
 * - 我们只需要「层级 + 正文起点」两个信息，逐行判最直接。
 *
 * 跳过的情况：
 * - 代码围栏（``` / ~~~）里的 `#`；
 * - 4 个及以上空格缩进的行（那是缩进代码块，不是标题）；
 * - 空标题（正文 trim 后为空）——大纲里也不显示空标题，保持一致。
 *
 * @param content - Markdown 全文
 * @returns 标题信息列表（文档顺序）
 */
export function scanHeadings(content: string): HeadingInfo[] {
    const headings: HeadingInfo[] = [];
    const lines = content.split('\n');
    let inFence = false; // 当前是否处于围栏代码块内部
    let offset = 0; // 当前行行首在整篇文档中的偏移

    for (let i = 0; i < lines.length; i += 1) {
        // 去掉可能残留的 \r（\r\n 切分后行尾会留一个）
        const rawLine = lines[i];
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

        // 围栏开关行：允许行首 0-3 个空格
        const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (fenceMatch) {
            inFence = !inFence;
            offset += rawLine.length + 1;
            continue;
        }

        if (!inFence) {
            // ---- ATX 标题：0-3 空格 + 1-6 个 # + 至少一个空白 + 正文 ----
            const atxMatch = line.match(/^( {0,3})(#{1,6})([ \t]+)(.*)$/);
            if (atxMatch) {
                const contentFrom =
                    offset + atxMatch[1].length + atxMatch[2].length + atxMatch[3].length;
                if (atxMatch[4].trim() !== '') {
                    headings.push({ level: atxMatch[2].length, contentFrom });
                }
            } else {
                // ---- setext 标题：当前行是正文，下一行全是 = 或 - ----
                const nextLine =
                    i + 1 < lines.length && lines[i + 1].endsWith('\r')
                        ? lines[i + 1].slice(0, -1)
                        : lines[i + 1];
                const underlineMatch =
                    nextLine !== undefined && line.trim() !== ''
                        ? nextLine.match(/^ {0,3}(=+|-+)[ \t]*$/)
                        : null;
                // 正文行自身不能是 4+ 空格缩进（缩进代码块不构成 setext）
                const leadingSpaces = line.match(/^ */)?.[0].length ?? 0;
                if (underlineMatch && leadingSpaces <= 3) {
                    headings.push({
                        // = 是一级，- 是二级
                        level: underlineMatch[1][0] === '=' ? 1 : 2,
                        contentFrom: offset + leadingSpaces,
                    });
                }
            }
        }

        offset += rawLine.length + 1;
    }

    return headings;
}

// =============================================================================
// 编号原子：解析
// =============================================================================

/**
 * 解析中文数字字符串（支持 1-9999 的常见写法）。
 *
 * 依次处理「数字」和「十/百/千/万」单位，比如：
 * `十一`=11、`二十`=20、`一百零一`=101、`一千二百`=1200。
 *
 * @param text - 待解析文本（字符必须全部是中文数字/单位）
 * @returns 数值（1-9999）；无法解析或为 0 时返回 null
 */
function parseChineseNumber(text: string): number | null {
    let total = 0; // 已结算的部分
    let current = 0; // 当前读到、还没乘单位的个位数字
    let matched = false;

    for (const ch of text) {
        if (ch in CN_DIGIT_MAP) {
            current = CN_DIGIT_MAP[ch];
            matched = true;
        } else if (ch === '十' || ch === '百' || ch === '千' || ch === '万') {
            const unit = ch === '十' ? 10 : ch === '百' ? 100 : ch === '千' ? 1000 : 10000;
            // 「十二」的十前面没有数字，按 1×10 处理
            total += (current || 1) * unit;
            current = 0;
            matched = true;
        } else {
            return null;
        }
    }
    total += current;

    return matched && total >= 1 && total <= 9999 ? total : null;
}

/**
 * 校验并解析罗马数字（ASCII 写法，I/V/X/L/C/D/M）。
 *
 * 先用严格的合法形态正则过滤（避免 `IXI` 这种乱序串被当成罗马数字），
 * 再按字符累加。
 *
 * @param text - 待解析文本
 * @param upper - 是否按大写校验（大小写字符集不同）
 * @returns 数值（1-4999）；不合法返回 null
 */
function parseRomanNumber(text: string, upper: boolean): number | null {
    const validPattern = upper
        ? /^M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/
        : /^m{0,4}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/;
    if (!validPattern.test(text)) return null;

    const values: Record<string, number> = upper
        ? { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }
        : { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
    let result = 0;
    for (let i = 0; i < text.length; i += 1) {
        const value = values[text[i]];
        const nextValue = values[text[i + 1]] ?? 0;
        // 小值在大值左边 = 减法（IV=4），否则累加
        result += value < nextValue ? -value : value;
    }
    return result >= 1 && result <= 4999 ? result : null;
}

/**
 * 在文本指定位置解析一个编号原子。
 *
 * 各类原子的字符集有重叠（比如 ASCII 罗马数字和英文字母），
 * 所以按「歧义最小优先」排序尝试：
 *
 * 1. 全角数字、带圈符号、Unicode 罗马符号 —— 字符集独占，先判；
 * 2. 阿拉伯数字；
 * 3. 中文数字串；
 * 4. ASCII 罗马数字（`I`/`V`/`X`…单写也按罗马认，因为它和英文字母
 *    在数值 1 时渲染结果本来就相同）；
 * 5. 单个英文字母。
 *
 * @param text - 标题正文
 * @param start - 起始位置
 * @returns 原子解析结果；该位置没有任何原子时返回 null
 */
function parseAtom(text: string, start: number): ParsedAtom | null {
    const ch = text[start];
    if (ch === undefined) return null;
    const code = ch.codePointAt(0) ?? 0;

    // 1) 全角数字 ０-９
    if (/^[０-９]+/.test(text.slice(start))) {
        const run = text.slice(start).match(/^[０-９]+/)?.[0] ?? '';
        const value = Number.parseInt(
            Array.from(run)
                .map((c) => String.fromCodePoint((c.codePointAt(0) ?? 0) - 0xfee0))
                .join(''),
            10
        );
        if (value >= 1 && value <= MAX_ARABIC_VALUE) {
            return { type: 'fullwidth', value, length: run.length };
        }
    }

    // 2) 带圈中文数字 ㈠-㈩
    if (code >= CIRCLED_CN_START && code <= CIRCLED_CN_END) {
        return { type: 'circledCn', value: code - CIRCLED_CN_START + 1, length: 1 };
    }

    // 3) 带圈阿拉伯数字 ①-⑳
    if (code >= CIRCLED_START && code <= CIRCLED_END) {
        return { type: 'circled', value: code - CIRCLED_START + 1, length: 1 };
    }

    // 4) Unicode 罗马数字符号（大写 Ⅰ-ⅻ / 小写 ⅰ-ⅻ）
    if (
        (code >= ROMAN_UNICODE_UPPER_START && code <= ROMAN_UNICODE_UPPER_START + 11) ||
        (code >= ROMAN_UNICODE_LOWER_START && code <= ROMAN_UNICODE_LOWER_START + 11)
    ) {
        return {
            type:
                code >= ROMAN_UNICODE_LOWER_START ? 'romanUnicodeLower' : 'romanUnicodeUpper',
            value:
                (code >= ROMAN_UNICODE_LOWER_START
                    ? code - ROMAN_UNICODE_LOWER_START
                    : code - ROMAN_UNICODE_UPPER_START) + 1,
            length: 1,
        };
    }

    // 5) 阿拉伯数字
    const arabicRun = text.slice(start).match(/^[0-9]+/)?.[0];
    if (arabicRun) {
        const value = Number.parseInt(arabicRun, 10);
        if (value >= 1 && value <= MAX_ARABIC_VALUE) {
            return { type: 'arabic', value, length: arabicRun.length };
        }
    }

    // 6) 中文数字串：贪婪取出一整段中文数字字符再整体解析
    const cnRun = text.slice(start).match(/^[〇零一二三四五六七八九十百千万两]+/)?.[0];
    if (cnRun) {
        const value = parseChineseNumber(cnRun);
        if (value !== null) return { type: 'chinese', value, length: cnRun.length };
    }

    // 7) ASCII 罗马数字：贪婪取连续罗马字符，且至少能通过合法形态校验
    const romanUpperRun = text.slice(start).match(/^[IVXLCDM]+/)?.[0];
    if (romanUpperRun) {
        const value = parseRomanNumber(romanUpperRun, true);
        if (value !== null) return { type: 'romanUpper', value, length: romanUpperRun.length };
    }
    const romanLowerRun = text.slice(start).match(/^[ivxlcdm]+/)?.[0];
    if (romanLowerRun) {
        const value = parseRomanNumber(romanLowerRun, false);
        if (value !== null) return { type: 'romanLower', value, length: romanLowerRun.length };
    }

    // 8) 单个英文字母（编号原子只有一位字母；进位 AA 在渲染时生成）
    if (/^[A-Z]/.test(ch)) return { type: 'latinUpper', value: code - 64, length: 1 };
    if (/^[a-z]/.test(ch)) return { type: 'latinLower', value: code - 96, length: 1 };

    return null;
}

// =============================================================================
// 编号前缀：整体解析
// =============================================================================

/** 原子链解析的中间结果。 */
interface ChainResult {
    atoms: ParsedAtom[];
    separators: string[];
    pos: number; // 链结束位置
}

/**
 * 从指定位置解析一条「原子链」：原子 + 分隔符 + 原子 + …
 *
 * 分隔符后面必须还能解析出原子才算链的一部分；否则链提前结束，
 * 那个分隔符留给外层去当后缀（`1.` 里的点就是这样）。
 *
 * @param text - 标题正文
 * @param start - 起始位置
 * @returns 链结果；第一个原子都解析不出时返回 null
 */
function parseChain(text: string, start: number): ChainResult | null {
    const first = parseAtom(text, start);
    if (!first) return null;

    const atoms = [first];
    const separators: string[] = [];
    let pos = start + first.length;

    while (pos < text.length && SEPARATOR_CHARS.has(text[pos])) {
        const separator = text[pos];
        const next = parseAtom(text, pos + 1);
        if (!next) break;
        separators.push(separator);
        atoms.push(next);
        pos += 1 + next.length;
    }

    return { atoms, separators, pos };
}

/**
 * 判断编号前缀之后是不是「终止位置」（严格版）。
 *
 * 裸编号后面必须是空白或正文结束，避免把 `一二三级标题`、
 * `3.15消费者权益` 这种正文开头的数字误判成编号。
 *
 * @param text - 标题正文
 * @param pos - 前缀结束位置
 * @returns 是终止位置时返回 true
 */
function isTerminator(text: string, pos: number): boolean {
    return pos >= text.length || text[pos] === ' ' || text[pos] === '\t';
}

/**
 * 宽松版终止判断：编号**带后缀/包围符**时使用。
 *
 * 中文写作里编号符后面不加空格：`一、概述`、`（一）背景`、`3.消费者`
 * 都该认。所以严格规则之外，再放行「后面直接跟非 ASCII 字符」。
 *
 * 不会误放 `3.15消费者`：那条链里点被当成层级分隔符、链结束时没有后缀，
 * 走的是严格判断。
 *
 * @param text - 标题正文
 * @param pos - 前缀结束位置
 * @returns 是终止位置时返回 true
 */
function isTerminatorAfterSuffix(text: string, pos: number, suffixConsumed: boolean): boolean {
    if (isTerminator(text, pos)) return true;
    // 只有真正吃了一个后缀符（、. ) 等）才允许后面直接跟中文；
    // 没有后缀的裸编号链仍按严格规则，挡住 `3.15消费者` 这种
    // （那条链里点是层级分隔符、末尾没有后缀）。
    if (!suffixConsumed) return false;
    const code = text.codePointAt(pos);
    return code !== undefined && code > 127;
}

/**
 * 解析标题正文开头的编号前缀。
 *
 * 依次尝试三种形态：
 *
 * 1. **章节式**：`第 N 章/节/部分/篇/条/款/项/回`（N 为阿拉伯或中文数字）；
 * 2. **包围式**：`（N）` / `(N)`（括号里也允许原子链，如 `(1.1)`）；
 * 3. **普通链式**：`N.N.N` + 可选后缀（`.`、`、`、`)` 等）。
 *
 * @param text - 标题正文（不含 `#` 标记）
 * @returns 编号格式与前缀长度；开头没有编号时返回 null
 */
export function parseNumbering(text: string): ParsedNumbering | null {
    // 1) 章节式
    const chapterMatch = text.match(
        /^第([0-9]+|[〇零一二三四五六七八九十百千万两]+)([章节部分篇条款项回])/
    );
    if (chapterMatch) {
        const numberText = chapterMatch[1];
        const value = /^[0-9]+$/.test(numberText)
            ? Number.parseInt(numberText, 10)
            : parseChineseNumber(numberText);
        const end = chapterMatch[0].length;
        if (value !== null && value >= 1 && isTerminatorAfterSuffix(text, end, true)) {
            return {
                format: {
                    open: '第',
                    segments: [/^[0-9]+$/.test(numberText) ? 'arabic' : 'chinese'],
                    separators: [],
                    close: chapterMatch[2],
                    // 记录作者有没有在编号后留空格，重编号时照做
                    spaceAfter: text[end] === ' ' || text[end] === '\t',
                },
                length: end,
            };
        }
    }

    // 2) 包围式（全角 / 半角括号）
    if (text[0] === '（' || text[0] === '(') {
        const open = text[0];
        const close = open === '（' ? '）' : ')';
        const chain = parseChain(text, 1);
        if (
            chain &&
            text[chain.pos] === close &&
            isTerminatorAfterSuffix(text, chain.pos + 1, true)
        ) {
            return {
                format: {
                    open,
                    segments: chain.atoms.map((atom) => atom.type),
                    separators: chain.separators,
                    close,
                    // 右包围符之后是否带空格：`(1) Title` 有，`（一）背景` 没有
                    spaceAfter:
                        text[chain.pos + 1] === ' ' || text[chain.pos + 1] === '\t',
                },
                length: chain.pos + 1,
            };
        }
    }

    // 3) 普通链式
    const chain = parseChain(text, 0);
    if (chain && chain.atoms.length > 0) {
        let close = '';
        let end = chain.pos;
        // 链结束后吃一个后缀符
        if (end < text.length && SUFFIX_CHARS.has(text[end])) {
            close = text[end];
            end += 1;
        }
        if (isTerminatorAfterSuffix(text, end, close !== '')) {
            return {
                format: {
                    open: '',
                    segments: chain.atoms.map((atom) => atom.type),
                    separators: chain.separators,
                    close,
                    // 编号后有空白才算带空格；直接跟中文（一、概述）算紧贴
                    spaceAfter: text[end] === ' ' || text[end] === '\t',
                },
                length: end,
            };
        }
    }

    return null;
}

