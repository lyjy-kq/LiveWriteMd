/**
 * Live Preview Helpers
 *
 * 提供 live preview 需要的通用辅助能力：
 * - 行内 Markdown 渲染
 * - 标题 `<font>` 安全样式解析
 * - 表格、图片、代码块等内容辅助处理
 *
 * @module webview/codemirror/extensions/livePreview/helpers
 */

import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import type { FrontmatterProperty } from './types.js';
import { getDocumentBaseUri } from './state.js';
import { renderMathToHtml } from './mathRender.js';

/**
 * Escape HTML special characters.
 */
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * 单元格 / `<details>` 里出现的数学公式片段。
 *
 * 两种定界符一起匹配，`$$...$$` 排在前面优先命中：
 * - 第 1 组：`$$...$$` 的内容（独立公式）
 * - 第 2 组：`$...$` 的内容（行内公式，前后都不能是 `$`，后面也不能跟数字，
 *   免得把「售价 $5」这种普通文本误判成公式）
 */
const MATH_SEGMENT_PATTERN =
    /(?<!\$)\$\$([\s\S]+?)\$\$(?!\$)|(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$|\d)/g;

/**
 * 把不含公式的普通片段渲染成 HTML。
 *
 * 先做 HTML 转义，再按少量行内语法替换标签，保证用户输入不会变成真的标签。
 *
 * @param text - 普通文本片段
 * @returns 渲染后的 HTML；片段为空时返回空串
 */
function renderPlainInline(text: string): string {
    // Unescape \| to | before HTML escaping (backslash-pipe is Markdown table escape)
    let html = escapeHtml(text.replace(/\\\|/g, '|').trim());
    if (html === '') return '';
    // Restore <br> tags escaped above (GFM table cells use <br> for line breaks)
    html = html.replace(/&lt;br\s*\/?\s*&gt;/gi, '<br>');
    // Inline checkboxes (before link processing to avoid conflict)
    html = html.replace(
        /\[(x|X)\]/g,
        '<input type="checkbox" checked class="cm-md-checkbox cm-md-table-checkbox" />'
    );
    html = html.replace(
        /\[ \]/g,
        '<input type="checkbox" class="cm-md-checkbox cm-md-table-checkbox" />'
    );
    // 加粗/斜体带上和编辑器正文同一套类名：颜色、字重都走 styles.ts 里的
    // `.cm-md-bold` / `.cm-md-italic`，表格单元格和 `<font>` 里的粗斜体
    // 才会跟正文长得一样，而不是浏览器默认的黑体/倾斜体。
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong class="cm-md-bold">$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em class="cm-md-italic">$1</em>');
    html = html.replace(/~~(.+?)~~/g, '<del class="cm-md-strikethrough">$1</del>');
    html = html.replace(/`(.+?)`/g, '<code class="cm-md-code">$1</code>');
    html = html.replace(/\[(.+?)\]\((.+?)\)/g, '<a class="cm-md-link">$1</a>');
    return html;
}

/**
 * Render inline Markdown to HTML (bold, italic, strikethrough, code, links, math).
 *
 * 公式必须先摘出来再渲染：KaTeX 要的是「没被 HTML 转义过的原文」，
 * 而且它输出的 HTML 也不能再被转义，所以这里按公式切段，
 * 公式段交给 KaTeX，其余段落走普通转义流程，最后拼回去。
 */
export function renderInlineMarkdown(text: string): string {
    const segments: string[] = [];
    let cursor = 0;
    let match: RegExpExecArray | null;

    MATH_SEGMENT_PATTERN.lastIndex = 0;
    while ((match = MATH_SEGMENT_PATTERN.exec(text)) !== null) {
        // 公式前面那一段普通文本
        segments.push(renderPlainInline(text.slice(cursor, match.index)));

        // 第 1 组命中说明是 $$...$$（独立公式），否则是 $...$（行内公式）
        const isDisplay = match[1] !== undefined;
        const tex = (match[1] ?? match[2] ?? '').trim();
        if (tex) {
            segments.push(renderMathToHtml(tex, isDisplay));
        } else {
            // 空公式（例如 `$ $`）保持原样，避免凭空消失
            segments.push(renderPlainInline(match[0]));
        }

        cursor = match.index + match[0].length;
    }
    segments.push(renderPlainInline(text.slice(cursor)));

    const html = segments.join('');
    // 单元格是空的（或者公式渲染失败）时给个占位，否则 td 会塌陷成一条线
    return html === '' ? '&nbsp;' : html;
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
 * 将图片原始地址解析为 webview 可访问的最终地址。
 *
 * 支持远程图片、data URI 和文档同级的相对路径图片。
 *
 * @param rawUrl - 图片原始链接或相对路径
 * @returns 可直接赋值给 img.src 的地址，失败时返回空字符串
 */
export function resolvePreviewImageUrl(rawUrl: string): string {
    const trimmed = rawUrl.trim();
    if (!trimmed) return '';

    if (
        trimmed.startsWith('http://') ||
        trimmed.startsWith('https://') ||
        trimmed.startsWith('data:')
    ) {
        return trimmed;
    }

    const baseUri = getDocumentBaseUri();
    if (!baseUri) return '';

    try {
        const normalizedBase = baseUri.endsWith('/') ? baseUri : `${baseUri}/`;
        const normalizedPath = trimmed.replace(/\\/g, '/');
        return new URL(normalizedPath, normalizedBase).href;
    } catch {
        return '';
    }
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
 */
export function extractFencedCodeContent(node: SyntaxNode, state: EditorState): string | null {
    const startLine = state.doc.lineAt(node.from);
    const endLine = state.doc.lineAt(node.to);
    if (endLine.number <= startLine.number + 1) return null;
    const contentStart = state.doc.line(startLine.number + 1).from;
    const contentEnd = state.doc.line(endLine.number).from;
    if (contentStart >= contentEnd) return null;
    return state.doc.sliceString(contentStart, contentEnd).trimEnd();
}

/**
 * 代码块里一个 Tab 占几列。
 *
 * CodeMirror 6 默认 `state.tabSize = 4`，并把 `tab-size: <n>` 逐行写进
 * `.cm-line` 的内联样式（见 @codemirror/view），所以浏览器实际渲染 Tab
 * 用的也是这个宽度——这里必须与它一致，不能用浏览器默认的 8。
 */
const CODE_TAB_COLUMNS = 4;

/**
 * Rainbow indent 最多铺几层色带；最深一层会把剩余列数全包住（见下）。
 *
 * 20+ 层深缩进在真实代码里极罕见，卡 20 只是防止异常文档塞进几十层背景；
 * 注意当缩进单位是 2 空格时，6 层只够覆盖 12 列，所以不能再像旧版那样只给 6。
 */
const CODE_INDENT_MAX_BANDS = 20;

/**
 * 代码行的行首缩进信息。
 */
export interface CodeBlockIndentInfo {
    /**
     * 行首空白占的**视觉列数**：
     * - 空格算 1 列；
     * - Tab 不停在固定宽度，而是跳到下一个 tab-stop（tabSize 的整数倍）列，
     *   例如第 2 列上的 Tab 只前进 2 列。
     */
    columns: number;
}

/**
 * 计算代码行行首空白占的视觉列数，用于缩进导引渲染。
 *
 * @param lineText - 当前代码行文本
 * @param tabSize - 一个 Tab 的停靠宽度（列），默认 4，与 CM state.tabSize 对齐
 * @returns 缩进信息；未缩进时 columns 为 0
 */
export function getCodeBlockIndentInfo(lineText: string, tabSize = CODE_TAB_COLUMNS): CodeBlockIndentInfo {
    let columns = 0;
    for (const ch of lineText) {
        if (ch === ' ') {
            columns += 1;
            continue;
        }
        if (ch === '\t') {
            // Tab 跳到「当前列之后的第一个 tabSize 整数倍」位置，
            // 不是无脑 +tabSize（Tab 在第 0 列才前进整整 4 列）。
            columns = (Math.floor(columns / tabSize) + 1) * tabSize;
            continue;
        }
        break;
    }
    return { columns };
}

/**
 * 生成代码块缩进导引（rainbow indent）的内联样式。
 *
 * 色带按「缩进层级」铺：每经过一个缩进单位（indentUnit）就换一种颜色——
 * 用户每按一次 Tab（默认插入 2 空格，即一个缩进单位），颜色就轮换一格。
 * 与旧实现的区别：
 * - 旧版写死每 4 列一色，缩进单位是 2 空格时按两次 Tab 才换色
 *   （表现为「两个 tab 一个颜色」）；
 * - **最后一层色带不画满一个单位**，宽度恰好 = 行首空白在本单位内的剩余列数
 *   ——于是无论缩进是几列（奇数空格、Tab、空格混 Tab），色带都正好停在
 *   这一行第一个文字/字母开始的位置，不会渲染到文字上。
 *
 * 横向尺寸一律用 **ch 单位**（不用 Canvas 量 px）：`1ch` 就是元素自身字体里
 * `'0'` 的推进宽度，等宽字体下它**按定义等于一列宽**，浏览器会自动跟着行实际
 * 使用的字体/字号走。这避开了 Canvas 方案的时序坑——装饰首次构建发生在
 * EditorState.create 阶段（视图还没挂 DOM），那时量字宽只能退到 body 的界面
 * 字体，首屏色带宽度就是错的。ch 没有测量环节，首屏即正确。
 *
 * 超过最大层数的深缩进不另加颜色，而是让最深一层自动变宽把剩余列全包住，
 * 任何缩进深度都覆盖得到。
 *
 * @param columns - 行首空白的视觉列数（getCodeBlockIndentInfo 算出）
 * @param unitColumns - 一个缩进单位（indentUnit）占几列；色带按此宽度轮换
 * @returns 可直接写入 line decoration attributes.style 的样式字符串
 */
export function createCodeBlockIndentStyle(columns: number, unitColumns: number): string {
    const backgroundColor = 'var(--vscode-textCodeBlock-background, rgba(128,128,128,0.08))';
    const palette = [
        'rgba(235, 131, 131, 0.18)',
        'rgba(174, 154, 203, 0.18)',
        'rgba(125, 181, 205, 0.18)',
        'rgba(113, 167, 150, 0.18)',
        'rgba(220, 191, 97, 0.18)',
        'rgba(221, 163, 106, 0.18)',
        'rgba(184, 245, 162, 0.18)',
    ];

    // 未缩进：只铺代码块底色，不铺任何色带。
    if (columns <= 0) {
        return `background-color: ${backgroundColor}; background-image: none; background-repeat: no-repeat;`;
    }

    // 兜底：缩进单位异常（0 列）时退回按 4 列一色，避免死循环/除零。
    const safeUnitColumns = unitColumns > 0 ? unitColumns : CODE_TAB_COLUMNS;
    const bandCount = Math.min(
        CODE_INDENT_MAX_BANDS,
        Math.max(1, Math.ceil(columns / safeUnitColumns))
    );

    const layers: string[] = [];
    const positions: string[] = [];
    const sizes: string[] = [];

    for (let i = 0; i < bandCount; i++) {
        const startCols = i * safeUnitColumns;
        // 最后一层：宽度 = 从本层起点到文字起点之间的真实剩余列数。
        //  - 行首空白不是缩进单位的整数倍时，它就只有余数列那么宽，
        //    正好停在文字前；
        //  - 深缩进超过最大层数时，这一层会随之变宽，把最深的空白也盖住。
        // 其余层固定一个缩进单位宽。
        const widthCols = i === bandCount - 1 ? columns - startCols : safeUnitColumns;

        layers.push(`linear-gradient(${palette[i % palette.length]}, ${palette[i % palette.length]})`);
        // ch = 行字体里一列的宽度；小数列（widthCols 恒为整数，保留写法兜底）也准。
        positions.push(`${startCols.toFixed(2)}ch 0`);
        sizes.push(`${widthCols.toFixed(2)}ch 100%`);
    }

    return [
        `background-color: ${backgroundColor}`,
        `background-image: ${layers.join(', ')}`,
        'background-repeat: no-repeat',
        // 原点用 **content-box**：色带坐标要和「第 0 列字符」对齐，
        // 而字符从行的内容区（padding 之后）开始。旧实现用 padding-box，
        // 色带整体左偏一个行内边距（4px），同样停不准。
        // 裁剪仍用 padding-box：底色铺满整行、圆角处不露黑边。
        'background-origin: content-box',
        'background-clip: padding-box',
        `background-position: ${positions.join(', ')}`,
        `background-size: ${sizes.join(', ')}`,
    ].join('; ');
}

// =============================================================================
// 字宽测量（Canvas）
// =============================================================================
//
// 「就地展开」和「列表圆点对齐」都要知道某串文字在正文里有多宽：
// 前者要把标记符占的宽度补回来，后者要让渲染出的圆点正好顶掉源码里的 `- `。
// 用 Canvas 的 measureText 量，比按字符个数估准得多（中英文混排、换字体换字号都不怕）。

/** 缓存的画布上下文：字体没变就复用，不用每次量化都新建。 */
let measureCache: {
    key: string;
    ctx: CanvasRenderingContext2D;
    size: number;
    family: string;
    codeFamily: string;
    /** 正文的字重（用户可调，见 --flowmd-font-weight） */
    weight: string;
    /** 上次查样式表的时间戳（毫秒），用来做短命缓存 */
    lookedUpAt: number;
    /** 这一份是不是从编辑器正文（`.cm-content`）量的 */
    fromContent: boolean;
} | null = null;

/**
 * 取一个和正文同字体的画布上下文，用来量字宽。
 *
 * 字号、字体族、字重都从编辑器正文的实际计算样式里读，所以换主题、改字体缩放
 * （Ctrl+滚轮）、改字重之后量出来的宽度依然是对的。
 *
 * @returns 画布上下文（含正文字号/字体族/字重，以及行内代码用的等宽字体族）；
 *          拿不到时返回 null，调用方走字符数兜底
 */
export function getMeasureContext(): {
    ctx: CanvasRenderingContext2D;
    size: number;
    family: string;
    codeFamily: string;
    weight: string;
} | null {
    // 取字体的元素优先用编辑器正文；但 buildDecorations 在 EditorState.create 阶段
    // 就会跑一次，那时视图还没挂到 DOM 上，正文元素还不存在，所以退到 body。
    //
    // **退到 body 那次的结果必须作废**：webview 里 body 是界面字体/字号
    // （--vscode-font-family），正文是编辑器字体/字号（--vscode-editor-*），
    // 两者字宽差得不是一点。缓存只按时间复用的话，正文挂上来之后还会继续拿
    // body 那一套去量，量出来的宽度系统性偏 —— 所以缓存里记着它是从哪来的，
    // 正文一旦出现，旧的那份立刻不用了。
    //
    // 缓存存活一小会儿：换主题、改字体缩放之后要能很快跟上，但同一轮重建里
    // 会被调用几十次（每张表、每次量字宽都要），每次都 querySelector + getComputedStyle
    // 加起来就是一两毫秒。所以只做一次便宜的 querySelector 探测，不算样式。
    const now = Date.now();
    const contentEl = document.querySelector('#editor .cm-content');
    if (
        measureCache &&
        measureCache.lookedUpAt > now - 250 &&
        measureCache.fromContent === (contentEl !== null)
    ) {
        return {
            ctx: measureCache.ctx,
            size: measureCache.size,
            family: measureCache.family,
            codeFamily: measureCache.codeFamily,
            weight: measureCache.weight,
        };
    }

    const styleSource = contentEl ?? document.body;
    if (!styleSource) return null;

    const cs = getComputedStyle(styleSource);
    // 行内代码渲染态换成等宽字体（见 styles.ts 的 .cm-md-code），量它的宽度得换字体量。
    // 优先量一个真实存在的代码元素（最准），页面上暂时没有就退回 CSS 变量。
    const codeSample = document.querySelector('#editor .cm-md-code');
    const codeFamily = codeSample
        ? getComputedStyle(codeSample).fontFamily
        : (getComputedStyle(document.documentElement)
              .getPropertyValue('--vscode-editor-font-family')
              .trim() || 'monospace');

    const key = `${cs.fontFamily}|${cs.fontSize}|${cs.fontWeight}|${codeFamily}`;
    if (measureCache && measureCache.key === key) {
        return {
            ctx: measureCache.ctx,
            size: measureCache.size,
            family: measureCache.family,
            codeFamily: measureCache.codeFamily,
            weight: measureCache.weight,
        };
    }

    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return null;

    const size = Number.parseFloat(cs.fontSize) || 14;
    const family = cs.fontFamily || 'monospace';
    ctx.font = `${size}px ${family}`;
    // 正文的字重：可能被「字体粗细」这个设置改过（--flowmd-font-weight），
    // 拿它去量宽度的调用方不能写死 400
    const weight = cs.fontWeight || '400';
    measureCache = {
        key,
        ctx,
        size,
        family,
        codeFamily,
        weight,
        lookedUpAt: now,
        fromContent: styleSource !== document.body,
    };
    return { ctx, size, family, codeFamily, weight };
}

/**
 * 量一段文本在指定字重、指定字号、指定字体下的宽度。
 *
 * @param text - 待测文本
 * @param weight - 字重，'700' 表示粗体（用来对齐渲染态的加粗宽度）
 * @param sizePx - 字号（px）；不传则用编辑器正文的字号
 * @param family - 字体族；不传则用正文的字体族（行内代码渲染态是等宽字体，要显式换）
 * @returns 宽度（px）；量不了时按「CJK 1em、其余 0.6em」粗估兜底
 */
export function measureText(
    text: string,
    weight = '400',
    sizePx?: number,
    family?: string
): number {
    if (!text) return 0;
    const m = getMeasureContext();
    const size = sizePx ?? m?.size ?? 14;
    if (!m) {
        // 兜底：CJK 按 1em、其余按 0.6em 粗算，保证不崩且量级正确
        let units = 0;
        for (const ch of text) units += /[　-鿿＀-￯]/.test(ch) ? 1 : 0.6;
        return units * size;
    }
    m.ctx.font = `${weight} ${size}px ${family ?? m.family}`;
    return m.ctx.measureText(text).width;
}

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
function indentColumns(whitespace: string): number {
    let cols = 0;
    for (const ch of whitespace) cols += ch === '\t' ? LIST_TAB_COLUMNS : 1;
    return cols;
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
 * 生成列表缩进引导线的行内样式。
 *
 * 具体的画法在 styles.ts 的 `.cm-md-indent` 里（两层背景），这里只把三个
 * 「量出来的数」递给它：
 *
 * - `--cm-md-indent-level`：这一行自己缩进到第几层 —— 它同时是「要先铺几条祖先竖线」；
 * - `--cm-md-indent-unit`：一级缩进多宽（px），竖线的间距；
 * - `--cm-md-indent-dot`：圆点圆心离行左边缘多远（px），每条竖线都要右移这么多，
 *   这样竖线才长在圆点正下方；
 * - `--cm-md-indent-own`：自己那条竖线画多高 —— 50% 表示「从行中间（圆点中心）
 *   往下垂」，没有子级时给 0% 表示不画。
 *
 * @param level - 缩进层级
 * @param unitPx - 一级缩进的像素宽度
 * @param ownLine - 这一行下面还有没有更深的子级（决定自己那条竖线画不画）
 * @param dotPx - 圆点圆心相对行左边缘的横向偏移
 * @returns 可直接写入 line decoration attributes.style 的样式字符串
 */
export function createListIndentStyle(
    level: number,
    unitPx: number,
    ownLine: boolean,
    dotPx: number
): string {
    return [
        `--cm-md-indent-level:${level}`,
        `--cm-md-indent-unit:${unitPx.toFixed(2)}px`,
        `--cm-md-indent-dot:${dotPx.toFixed(2)}px`,
        `--cm-md-indent-own:${ownLine ? '50%' : '0%'}`,
    ].join('; ');
}

/**
 * 圆点圆心相对**正文内容左边缘**的横向偏移（px）= 半个 `-` 宽。
 *
 * 圆点以 `-` 的中点为圆心，而 `- ` 那个盒子正是从正文内容左边缘开始的，
 * 所以圆心就落在半个 `-` 宽的位置。
 *
 * 注意这里**不含行内边距**：引导线的背景设了 `background-origin: content-box`，
 * 定位原点本来就是正文内容左边缘，行内边距由 CSS 自己算进去。
 * （早先的写法去读 `getComputedStyle` 拿内边距，可插件第一次构建时视图还没进 DOM，
 * 量出来是 0，竖线会整体偏 4px。）
 *
 * 缩进层级带来的偏移也不在这里：那一截是 `层级 × unitPx`，由调用方加起来。
 *
 * @returns 像素偏移
 */
export function measureBulletDotOffsetPx(): number {
    return measureText('-', '400') / 2;
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
