/**
 * 文件路径文本识别与位置解析工具。
 *
 * 该模块同时服务于 webview 与扩展侧：
 * - webview 用它识别用户 Ctrl/Cmd+点击时命中的路径文本。
 * - 扩展侧用它解析 `:行号`、`:行列`、`:起止范围` 等位置后缀。
 */

/**
 * 文件跳转选择范围。
 */
export interface FileLinkSelection {
    /** 起始行号，使用 1-based 约定。 */
    startLine: number;
    /** 起始列号，使用 1-based 约定。 */
    startColumn: number;
    /** 结束行号，使用 1-based 约定。 */
    endLine: number;
    /** 结束列号，使用 1-based 约定。 */
    endColumn: number;
}

/**
 * 解析后的文件链接目标。
 */
export interface ParsedFileLinkTarget {
    /** 去除位置后缀后的原始文件路径。 */
    filePath: string;
    /** 可选的跳转范围。 */
    selection: FileLinkSelection | null;
}

/**
 * 命中的文件路径文本片段。
 */
export interface FileLinkMatch {
    /** 原始匹配文本，包含位置后缀。 */
    rawText: string;
    /** 匹配起始下标。 */
    start: number;
    /** 匹配结束下标（不含）。 */
    end: number;
    /** 已解析的目标路径与范围。 */
    target: ParsedFileLinkTarget;
}

/**
 * 归一化单个正则匹配结果。
 *
 * @param text - 原始整行文本
 * @param match - 正则匹配结果
 * @returns 命中有效路径时返回结构化结果，否则返回 null
 */
function normalizeFileLinkMatch(text: string, match: RegExpMatchArray): FileLinkMatch | null {
    const rawText = match[0];
    const start = match.index ?? -1;
    const end = start + rawText.length;

    if (start < 0) {
        return null;
    }

    if (!hasNaturalBoundaries(text, start, end)) {
        return null;
    }

    if (isImmediatelyAfterUrlScheme(text, start)) {
        return null;
    }

    const target = parseFileLinkTarget(rawText);
    if (!target) {
        return null;
    }

    return {
        rawText,
        start,
        end,
        target,
    };
}

/**
 * 文件路径文本的全局匹配表达式。
 *
 * 该表达式支持：
 * - Windows 盘符路径
 * - 相对路径与 workspace 根路径
 * - 正斜杠与反斜杠
 * - 行号、列号、范围后缀
 */
const FILE_LINK_PATTERN =
    /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|\/|(?:[^\s\\/:"'`()[\]{}<>|?*，。；：！？、]+[\\/]))(?:[^\s\\/:"'`()[\]{}<>|?*，。；：！？、]+[\\/])*(?:[^\s\\/:"'`()[\]{}<>|?*，。；：！？、]+\.[A-Za-z0-9]{1,16})(?::\d+(?::\d+)?(?:-\d+(?::\d+)?)?)?/g;

/**
 * 判断单个字符是否可视为路径文本的一部分。
 *
 * @param char - 待判断字符
 * @returns 字符属于常见路径 token 时返回 true
 */
function isPathTokenChar(char: string): boolean {
    return /[\p{L}\p{N}._~\-\\/:]/u.test(char);
}

/**
 * 判断匹配是否处在自然边界内，避免吞掉句中标点或 URL 片段。
 *
 * @param text - 原始整行文本
 * @param start - 匹配起始位置
 * @param end - 匹配结束位置
 * @returns 满足自然边界要求时返回 true
 */
function hasNaturalBoundaries(text: string, start: number, end: number): boolean {
    const prevChar = start > 0 ? text[start - 1] : '';
    const nextChar = end < text.length ? text[end] : '';

    if (prevChar && isPathTokenChar(prevChar)) {
        return false;
    }

    if (nextChar && isPathTokenChar(nextChar)) {
        return false;
    }

    return true;
}

/**
 * 判断匹配前缀是否落在 URL scheme 之后，避免把 `https://` 误识别为文件路径。
 *
 * @param text - 原始整行文本
 * @param start - 匹配起始位置
 * @returns 如果匹配位于 URL scheme 后面则返回 true
 */
function isImmediatelyAfterUrlScheme(text: string, start: number): boolean {
    const prefix = text.slice(Math.max(0, start - 8), start);
    return /[A-Za-z][A-Za-z0-9+\-.]*:\/\/$/.test(prefix);
}

/**
 * 基于正则后缀把位置文本转成结构化范围。
 *
 * @param rawText - 原始路径文本
 * @returns 结构化结果；无法解析时返回 null
 */
export function parseFileLinkTarget(rawText: string): ParsedFileLinkTarget | null {
    const normalizedText = rawText.trim();
    if (!normalizedText) {
        return null;
    }

    const rangeWithColumnsMatch = normalizedText.match(/^(.*):(\d+):(\d+)-(\d+):(\d+)$/);
    if (rangeWithColumnsMatch) {
        return {
            filePath: rangeWithColumnsMatch[1],
            selection: {
                startLine: Number(rangeWithColumnsMatch[2]),
                startColumn: Number(rangeWithColumnsMatch[3]),
                endLine: Number(rangeWithColumnsMatch[4]),
                endColumn: Number(rangeWithColumnsMatch[5]),
            },
        };
    }

    const rangeMatch = normalizedText.match(/^(.*):(\d+)-(\d+)$/);
    if (rangeMatch) {
        return {
            filePath: rangeMatch[1],
            selection: {
                startLine: Number(rangeMatch[2]),
                startColumn: 1,
                endLine: Number(rangeMatch[3]),
                endColumn: 1,
            },
        };
    }

    const lineWithColumnMatch = normalizedText.match(/^(.*):(\d+):(\d+)$/);
    if (lineWithColumnMatch) {
        return {
            filePath: lineWithColumnMatch[1],
            selection: {
                startLine: Number(lineWithColumnMatch[2]),
                startColumn: Number(lineWithColumnMatch[3]),
                endLine: Number(lineWithColumnMatch[2]),
                endColumn: Number(lineWithColumnMatch[3]),
            },
        };
    }

    const lineMatch = normalizedText.match(/^(.*):(\d+)$/);
    if (lineMatch) {
        return {
            filePath: lineMatch[1],
            selection: {
                startLine: Number(lineMatch[2]),
                startColumn: 1,
                endLine: Number(lineMatch[2]),
                endColumn: 1,
            },
        };
    }

    if (!/[\\/]/.test(normalizedText) && !/^[A-Za-z]:/.test(normalizedText)) {
        return null;
    }

    return {
        filePath: normalizedText,
        selection: null,
    };
}

/**
 * 提取整行文本中的所有可点击文件路径片段。
 *
 * @param text - 当前行完整文本
 * @returns 按出现顺序排列的文件路径片段列表
 */
export function findFileLinkMatches(text: string): FileLinkMatch[] {
    const matches: FileLinkMatch[] = [];

    for (const rawMatch of text.matchAll(FILE_LINK_PATTERN)) {
        const normalizedMatch = normalizeFileLinkMatch(text, rawMatch);
        if (normalizedMatch) {
            matches.push(normalizedMatch);
        }
    }

    return matches;
}

/**
 * 在整行文本中查找光标所在位置命中的文件路径表达式。
 *
 * @param text - 当前点击位置所在行的完整文本
 * @param cursorIndex - 光标位于该行中的 0-based 下标
 * @returns 命中的结构化路径结果；未命中时返回 null
 */
export function findFileLinkAtText(text: string, cursorIndex: number): FileLinkMatch | null {
    for (const match of findFileLinkMatches(text)) {
        if (cursorIndex >= match.start && cursorIndex < match.end) {
            return match;
        }
    }

    return null;
}
