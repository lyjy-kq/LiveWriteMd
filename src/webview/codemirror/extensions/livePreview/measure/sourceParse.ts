/**
 * 源码解析小工具（从 helpers.ts 拆出）。
 *
 * escapeHtml / <font> 标签安全样式白名单 / 图片 destination 拆分 /
 * 表格对齐解析 / frontmatter 解析 / 围栏代码块语言与内容提取。
 *
 * @module webview/codemirror/extensions/livePreview/sourceParse
 */

import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import type { FrontmatterProperty } from '../types.js';

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// 行内渲染实现已抽去 inlineEngine.ts（统一行内引擎，lezer 驱动）；
// 本文件顶部 re-export 的 renderInlineMarkdown 即旧正则实现的直接替代。

/**
 * 判断一整行是不是「快速卡片」的结束围栏（单独的 `>>>` 行）。
 *
 * 背景：快速卡片的存储格式是 `<<<` / `>>>` 两个独立行（见
 * webview/mindmap/edit/staging.ts），设计上在 live 模式里它们只是普通文字。
 * 但 CommonMark 会把行首的 `>>>` 解析成**三级引用**，于是 live 预览会：
 * - 把三个 `>` 当 QuoteMark 压 0 宽；
 * - 再给这一行套上 `.cm-md-blockquote-3`（3.6em 缩进 + 两条引用竖线），
 *   看起来像个空的三级引用块，而不是卡片的结束标记。
 *
 * 所以 live 预览在「引用 / 引用标记」两个分支里都要先按本函数放行，
 * 让这一行保持普通文字原样（与 `<<<` 行的显示一致）。
 *
 * 判定刻意与 staging.ts 的格式约束对齐：`>>>` 必须从第 0 列开始，
 * 行尾只允许空白；`>>>>`、`>>> 文字` 这些仍然是正常的引用。
 *
 * @param lineText - 单行文本（不含换行符）
 * @returns 是快速卡片结束围栏时返回 true
 */
export function isQuickCardCloseLine(lineText: string): boolean {
    return /^>>>[ \t]*$/.test(lineText);
}

/**
 * `<font>` 允许映射到 DOM 的安全 CSS 属性白名单。
 */
const SAFE_FONT_STYLE_PROPERTIES = new Set([
    'color',
    'background-color',
    'font-weight',
    'font-style',
    'text-decoration',
    'text-decoration-color',
    'font-size',
    'font-family',
]);

/**
 * 判断 font-family 回退校验中的字符是否安全。
 *
 * @param char - 待检查的单个字符。
 * @returns 字符属于字体族名称常见安全字符时返回 true。
 */
function isSafeFontFamilyFallbackChar(char: string): boolean {
    return (
        /[\w\s]/.test(char) ||
        char === ',' ||
        char === "'" ||
        char === '"' ||
        char === '’' ||
        char === '\\' ||
        char === '-'
    );
}

/**
 * 判断单个 CSS 值是否可以安全写入元素样式。
 *
 * 这里先排除 `url()`、`expression()` 以及 `javascript:` 这类高风险片段，
 * 再交给浏览器的 CSS 解析器做二次校验；如果当前环境不支持 `CSS.supports`，
 * 则回退到保守的字符串规则校验。
 *
 * @param property - CSS 属性名，要求使用连字符格式
 * @param value - 待写入的 CSS 值
 * @returns 是否允许写入 DOM
 */
function isSafeCssValue(property: string, value: string): boolean {
    const normalizedValue = value.trim();
    if (!normalizedValue) {
        return false;
    }

    if (/url\s*\(|expression\s*\(|javascript:/i.test(normalizedValue)) {
        return false;
    }

    if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
        try {
            if (CSS.supports(property, normalizedValue)) {
                return true;
            }
        } catch {
            // 继续走保守回退分支。
        }
    }

    switch (property) {
        case 'color':
        case 'background-color':
        case 'text-decoration-color':
            return (
                /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(normalizedValue) ||
                /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+(?:\s*,\s*[\d.]+)?\s*\)$/i.test(
                    normalizedValue
                ) ||
                /^hsla?\(\s*[\d.]+\s*,\s*[\d.]+%\s*,\s*[\d.]+%(?:\s*,\s*[\d.]+)?\s*\)$/i.test(
                    normalizedValue
                ) ||
                /^(?:inherit|initial|unset|revert|currentColor|transparent)$/i.test(
                    normalizedValue
                ) ||
                /^[a-z][a-z0-9-]*$/i.test(normalizedValue)
            );
        case 'font-weight':
            return /^(?:normal|bold|bolder|lighter|[1-9]00)$/i.test(normalizedValue);
        case 'font-style':
            return /^(?:normal|italic|oblique)$/i.test(normalizedValue);
        case 'text-decoration':
            return /^(?:none|underline|overline|line-through|underline\s+line-through|line-through\s+underline)$/i.test(
                normalizedValue
            );
        case 'font-size':
            return (
                /^(?:xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)$/i.test(
                    normalizedValue
                ) ||
                /^-?\d+(?:\.\d+)?(?:px|em|rem|%|pt|pc|vh|vw|vmin|vmax|ch|ex)$/i.test(
                    normalizedValue
                )
            );
        case 'font-family':
            return Array.from(normalizedValue).every(isSafeFontFamilyFallbackChar);
        default:
            return false;
    }
}

/**
 * 从 `<font>` 开标签里提取可安全写入 DOM 的样式声明。
 *
 * @param openTagText - `<font>` 的开标签文本。
 * @returns 经过过滤后的 CSS 声明数组，供 `style.setProperty()` 使用。
 */
export function extractSafeFontStyles(openTagText: string): Array<[string, string]> {
    const styleMatch = openTagText.match(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!styleMatch) {
        return [];
    }

    const rawStyle = styleMatch[1] ?? styleMatch[2] ?? styleMatch[3] ?? '';
    if (!rawStyle.trim()) {
        return [];
    }

    const safeDeclarations: Array<[string, string]> = [];
    for (const declaration of rawStyle.split(';')) {
        const colonIndex = declaration.indexOf(':');
        if (colonIndex <= 0) {
            continue;
        }

        const property = declaration.slice(0, colonIndex).trim().toLowerCase();
        const value = declaration.slice(colonIndex + 1).trim();
        if (!SAFE_FONT_STYLE_PROPERTIES.has(property)) {
            continue;
        }
        if (!isSafeCssValue(property, value)) {
            continue;
        }

        safeDeclarations.push([property, value]);
    }

    return safeDeclarations;
}

/**
 * 将安全样式声明逐条写入元素的 style 属性。
 *
 * @param el - 需要设置样式的 DOM 元素。
 * @param declarations - 经过白名单过滤后的 CSS 声明。
 * @returns void
 */
export function applySafeFontStyles(el: HTMLElement, declarations: Array<[string, string]>): void {
    for (const [property, value] of declarations) {
        el.style.setProperty(property, value);
    }
}

/**
 * 从 Markdown 图片语法里拆分出真正的图片目标地址。
 *
 * 该函数会尽量保留带空格的本地路径，同时去掉可选的标题部分，
 * 以便后续统一交给图片渲染逻辑处理。
 *
 * @param rawDestination - Markdown 图片括号里的原始内容
 * @returns 解析后的图片目标地址
 */
export function splitMarkdownImageDestination(rawDestination: string): string {
    const trimmed = rawDestination.trim();
    if (!trimmed) return '';

    if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
        return trimmed.slice(1, -1).trim();
    }

    const titleMatch = trimmed.match(/^(.*?)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]+\)))$/);
    if (titleMatch) {
        return titleMatch[1].trim();
    }

    return trimmed;
}

/**
 * Parse table delimiter row to extract column alignments.
 */
export function parseAlignments(
    delimiterText: string
): Array<'left' | 'center' | 'right' | 'default'> {
    return delimiterText
        .split('|')
        .filter((c) => c.trim().length > 0)
        .map((cell) => {
            const t = cell.trim();
            if (t.startsWith(':') && t.endsWith(':')) return 'center';
            if (t.endsWith(':')) return 'right';
            if (t.startsWith(':')) return 'left';
            return 'default';
        });
}

/**
 * Parse YAML frontmatter text into an array of key-value properties.
 * Handles simple values, quoted strings, and block scalars (| and >).
 */
export function parseFrontmatter(yamlText: string): FrontmatterProperty[] {
    const properties: FrontmatterProperty[] = [];
    const lines = yamlText.split('\n');
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const match = line.match(/^(\w[\w\s-]*):\s*(.*)/);
        if (!match) {
            i++;
            continue;
        }

        const key = match[1].trim();
        let value = match[2].trim();

        // Block scalar (| or >)
        if (value === '|' || value === '>') {
            const blockLines: string[] = [];
            i++;
            while (i < lines.length) {
                const bLine = lines[i];
                // Continuation: indented line or empty line within block
                if (bLine.match(/^\s+/) || (bLine.trim() === '' && blockLines.length > 0)) {
                    blockLines.push(bLine.replace(/^\s{2}/, ''));
                    i++;
                } else {
                    break;
                }
            }
            // Trim trailing empty lines
            while (blockLines.length > 0 && blockLines[blockLines.length - 1].trim() === '') {
                blockLines.pop();
            }
            value = blockLines.join(value === '|' ? '\n' : ' ');
        } else {
            // Strip surrounding quotes
            if (
                (value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))
            ) {
                value = value.slice(1, -1);
            }
            i++;
        }

        properties.push({ key, value });
    }

    return properties;
}

/**
 * 提取 fenced code block 的语言名。
 *
 * @param node - fenced code block 对应的语法节点
 * @param state - 当前编辑器状态，用于读取代码块 info 文本
 * @returns 规范化后的语言名，没有显式语言时返回 `go`
 */
export function extractFencedCodeLanguage(node: SyntaxNode, state: EditorState): string {
    const codeInfoNode = node.getChild('CodeInfo');
    if (!codeInfoNode) return 'go';

    const rawInfo = state.doc.sliceString(codeInfoNode.from, codeInfoNode.to).trim();
    if (!rawInfo) return 'go';

    const language = rawInfo.split(/\s+/)[0].trim().toLowerCase();
    return language || 'go';
}

/**
 * Extract content text from a fenced code block node (excluding opening/closing fences).
 *
 * 与 VS Code 的 code block 口径一致：开围栏的缩进（列表项里的 2/4/7 格）
 * 只是「把围栏挂进列表」的结构缩进，不属于代码本身；复制或交给 Mermaid
 * 时按 CommonMark 的规则逐行去掉这段前缀，最多去掉开围栏那么宽。
 */
export function extractFencedCodeContent(node: SyntaxNode, state: EditorState): string | null {
    const startLine = state.doc.lineAt(node.from);
    const endLine = state.doc.lineAt(node.to);
    if (endLine.number <= startLine.number + 1) return null;
    const contentStart = state.doc.line(startLine.number + 1).from;
    const contentEnd = state.doc.line(endLine.number).from;
    if (contentStart >= contentEnd) return null;

    const indent = /^[ \t]*/.exec(startLine.text)?.[0] ?? '';
    const raw = state.doc.sliceString(contentStart, contentEnd).trimEnd();
    if (!indent) return raw;
    return raw
        .split('\n')
        .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
        .join('\n');
}

