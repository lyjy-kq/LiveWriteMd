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

// =============================================================================
// 数据结构
// =============================================================================

/**
 * 编号原子的种类。
 *
 * 「原子」= 编号里一个不可再拆的计数码：`1.1.1` 里有 3 个 arabic 原子。
 */
type NumberType =
    | 'arabic' // 阿拉伯数字 1
    | 'fullwidth' // 全角数字 １
    | 'chinese' // 中文数字 一
    | 'latinUpper' // 大写英文字母 A
    | 'latinLower' // 小写英文字母 a
    | 'romanUpper' // 大写罗马数字 I（ASCII 写法）
    | 'romanLower' // 小写罗马数字 i
    | 'romanUnicodeUpper' // 大写罗马数字 Ⅰ（Unicode 专用符号）
    | 'romanUnicodeLower' // 小写罗马数字 ⅰ
    | 'circled' // 带圈阿拉伯数字 ①
    | 'circledCn'; // 带圈中文数字 ㈠

/** 一次原子解析的结果。 */
interface ParsedAtom {
    /** 原子种类 */
    type: NumberType;
    /** 解析出的数值（从 1 开始） */
    value: number;
    /** 原子在文本中占用的字符长度 */
    length: number;
}

/**
 * 一套编号格式（模板）。
 *
 * 编号串的完整拼法：
 *
 * ```
 * open + 原子1 sep1 原子2 sep2 ... + close
 * ```
 *
 * 例如：
 * - `1.1`：open=''，segments=[arabic, arabic]，separators=['.']，close=''
 * - `一、`：open=''，segments=[chinese]，separators=[]，close='、'
 * - `（1）`：open='（'，segments=[arabic]，separators=[]，close='）'
 * - `第三章`：open='第'，segments=[chinese]，separators=[]，close='章'
 */
interface NumberingFormat {
    /** 第一个原子之前的固定文本 */
    open: string;
    /** 每个层级对应的原子种类 */
    segments: NumberType[];
    /** 相邻原子之间的分隔符（长度 = segments.length - 1） */
    separators: string[];
    /** 最后一个原子之后的固定文本（后缀或右包围符） */
    close: string;
    /**
     * 编号与正文之间原来是否有空格。
     *
     * 从第一个既有编号上记录：`第一章 概述` 有、`第一章概述` 没有、
     * `一、概述` 没有 —— 重新编号时原样复刻，不替作者改排版习惯。
     */
    spaceAfter: boolean;
}

/** 前缀解析结果：格式模板 + 前缀在标题正文里占用的长度。 */
interface ParsedNumbering {
    format: NumberingFormat;
    length: number;
}

/** 扫描出的一个标题。位置均为相对整篇文档的偏移。 */
interface HeadingInfo {
    /** 标题层级 1-6 */
    level: number;
    /** 标题正文起点（`#` 标记和其后空白之后；setext 为正文行去缩进后） */
    contentFrom: number;
}

/** 一处文本修改（交给 CodeMirror dispatch 的 changes）。 */
export interface HeadingEdit {
    from: number;
    to: number;
    insert: string;
}

// =============================================================================
// 字符表
// =============================================================================

/** 原子之间允许出现的分隔符（注意全角点 U+FF0E 和间隔号 U+30FB）。 */
const SEPARATOR_CHARS = new Set(['.', '．', '。', '・', ':', '：', '/', '／', '-']);

/** 普通编号链末尾允许出现的后缀符。 */
const SUFFIX_CHARS = new Set(['.', '．', '、', ')', '）', ':', '：', '-']);

/** 中文数字字符 → 数值。 */
const CN_DIGIT_MAP: Record<string, number> = {
    〇: 0,
    零: 0,
    一: 1,
    二: 2,
    两: 2, // 「两」是口语化的 2，也认
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
};

/** `第 N X` 里允许的收尾量词。 */
const CHAPTER_SUFFIXES = new Set(['章', '节', '部分', '篇', '条', '款', '项', '回']);

/**
 * 单个阿拉伯原子允许的最大值。
 *
 * 不能放太大：标题 `2026 年度计划` 里的年份会被误当成编号，
 * 而层级编号的某一段实际不会超过几百。
 */
const MAX_ARABIC_VALUE = 999;

/** 带圈阿拉伯数字的覆盖范围（U+2460 ① 起，①-⑳）。 */
const CIRCLED_START = 0x2460;
const CIRCLED_END = 0x2473;

/** 带圈中文数字 ㈠-㈩（U+3220 起，1-10）。 */
const CIRCLED_CN_START = 0x3220;
const CIRCLED_CN_END = 0x3229;

/** Unicode 罗马数字符号 Ⅰ-ⅻ（U+2160 起，1-12，大写）。 */
const ROMAN_UNICODE_UPPER_START = 0x2160;
/** Unicode 小写罗马数字 ⅰ-ⅻ（U+2170 起，1-12）。 */
const ROMAN_UNICODE_LOWER_START = 0x2170;

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
