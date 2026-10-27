/**
 * 标题编号：类型与字符表（从 headingNumbering.ts 拆出）。
 *
 * 解析（numberingParse）与渲染（numberingRender）共用的数据结构和
 * Unicode 字符常量。
 *
 * @module webview/outline/numberingModel
 */

// =============================================================================
// 数据结构
// =============================================================================

/**
 * 编号原子的种类。
 *
 * 「原子」= 编号里一个不可再拆的计数码：`1.1.1` 里有 3 个 arabic 原子。
 */
export type NumberType =
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
export interface ParsedAtom {
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
export interface NumberingFormat {
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
export interface ParsedNumbering {
    format: NumberingFormat;
    length: number;
}

/** 扫描出的一个标题。位置均为相对整篇文档的偏移。 */
export interface HeadingInfo {
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
export const SEPARATOR_CHARS = new Set(['.', '．', '。', '・', ':', '：', '/', '／', '-']);

/** 普通编号链末尾允许出现的后缀符。 */
export const SUFFIX_CHARS = new Set(['.', '．', '、', ')', '）', ':', '：', '-']);

/** 中文数字字符 → 数值。 */
export const CN_DIGIT_MAP: Record<string, number> = {
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
export const CHAPTER_SUFFIXES = new Set(['章', '节', '部分', '篇', '条', '款', '项', '回']);

/**
 * 单个阿拉伯原子允许的最大值。
 *
 * 不能放太大：标题 `2026 年度计划` 里的年份会被误当成编号，
 * 而层级编号的某一段实际不会超过几百。
 */
export const MAX_ARABIC_VALUE = 999;

/** 带圈阿拉伯数字的覆盖范围（U+2460 ① 起，①-⑳）。 */
export const CIRCLED_START = 0x2460;
export const CIRCLED_END = 0x2473;

/** 带圈中文数字 ㈠-㈩（U+3220 起，1-10）。 */
export const CIRCLED_CN_START = 0x3220;
export const CIRCLED_CN_END = 0x3229;

/** Unicode 罗马数字符号 Ⅰ-ⅻ（U+2160 起，1-12，大写）。 */
export const ROMAN_UNICODE_UPPER_START = 0x2160;
/** Unicode 小写罗马数字 ⅰ-ⅻ（U+2170 起，1-12）。 */
export const ROMAN_UNICODE_LOWER_START = 0x2170;
