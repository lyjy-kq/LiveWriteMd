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
    /** 正文的字重（用户可调，见 --livewritemd-font-weight） */
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
    // 正文的字重：可能被「字体粗细」这个设置改过（--livewritemd-font-weight），
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
// 列表圆点垂直对齐补偿
// =============================================================================
//
// `.cm-md-bullet` 是 0 高 inline-block（唯一子元素绝对定位），圆心经
// top:50% 落在盒子的 `vertical-align:middle` 对齐点上；但源码 `-` 的墨迹
// 中心与该点并不重合 —— Chromium 对空 inline-block 的 middle 落点约在
// 基线之上 0.245em，而 `-` 墨迹中心随实际字体变化，于是圆点系统性偏下。
// 下面把真实差值量出来，交给 BulletWidget 做像素级补偿。

/** middle 对齐点实测结果缓存：同字体环境 1s 内复用，避免反复插探针。 */
let middleAnchorCache: {
    key: string;
    value: number;
    at: number;
} | null = null;

/**
 * 实测「0 高 inline-block 的 `vertical-align:middle` 对齐点」相对父基线的
 * y 偏移。
 *
 * 在与正文同字体的离屏容器里放两个 0 高探针（一个 middle、一个 baseline），
 * 直接量两者顶缘之差 —— 不写死 0.245em 这类经验常数，换引擎/字体都成立。
 *
 * @param size - 正文字号（px）
 * @param family - 正文字体族
 * @returns 偏移量（px，负值 = middle 对齐点在基线之上）
 */
function getMiddleAnchorOffset(size: number, family: string): number {
    const now = Date.now();
    const key = `${size}px ${family}`;
    if (
        middleAnchorCache &&
        middleAnchorCache.key === key &&
        middleAnchorCache.at > now - 1000
    ) {
        return middleAnchorCache.value;
    }

    // 离屏测量宿主：字体与正文完全一致。line-height 给 1 即可——
    // 实测它不影响 0 高探针的落点（探针本身不占行高）。
    const host = document.createElement('div');
    host.style.cssText =
        'position:fixed;top:0;left:-9999px;font:400 ' +
        key +
        ';line-height:1;white-space:pre;';
    // middle 探针：0 高 inline-block，其顶缘（=底缘）即 middle 对齐点
    // baseline 探针：加 overflow:hidden，空 inline-block 的基线 = 自身底缘
    host.innerHTML =
        '<span style="display:inline-block;width:1px;height:0;vertical-align:middle"></span>' +
        '<span style="display:inline-block;width:1px;height:0;overflow:hidden;vertical-align:baseline"></span>';
    document.body.appendChild(host);
    const spans = host.querySelectorAll('span');
    const value =
        spans[0].getBoundingClientRect().top -
        spans[1].getBoundingClientRect().top;
    host.remove();

    middleAnchorCache = { key, value, at: now };
    return value;
}

/**
 * 量「列表圆点圆心」相对 middle 对齐点应补的垂直修正量。
 *
 * @param marker - 源码标记符（`-` / `*` / `+`）
 * @returns 圆点 top 应加的修正量（px，通常为负 = 向上挪）；量不到时给 0，
 *          退回不补偿的旧行为，不影响正常渲染
 */
export function measureBulletYCorrection(marker = '-'): number {
    const m = getMeasureContext();
    if (!m) return 0;
    // 标记符在源码里是常规字重（400），canvas 字体必须与它一致
    m.ctx.font = `400 ${m.size}px ${m.family}`;
    const metrics = m.ctx.measureText(marker);
    // marker 墨迹中心在基线之上 halfInk px（actualBoundingBoxDescent
    // 对 Consolas 的 '-' 为负值，因为横线整个落在基线之上）
    const halfInk =
        (metrics.actualBoundingBoxAscent -
            metrics.actualBoundingBoxDescent) /
        2;
    // middle 对齐点相对基线的偏移（负 = 在基线之上）
    const middleOffset = getMiddleAnchorOffset(m.size, m.family);
    // 圆心要从 middle 点挪到墨迹中心：
    // 墨迹中心 = 基线 - halfInk；middle 点 = 基线 + middleOffset
    // correction = 墨迹中心 - middle 点 = -halfInk - middleOffset
    return -halfInk - middleOffset;
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
 * `.cm-line` 的行内边距（px）。theme.ts 里 `.cm-line { padding: 0 4px }` ——
 * 行内背景改成 border-box 定位后，横向坐标要把这 4px 一起算进去。
 * 改 theme.ts 那边的话这里必须跟着改。
 */
export const LINE_PADDING_PX = 4;

/**
 * 一条缩进引导线的描述。
 */
export interface IndentGuide {
    /** 中心相对「行 border-box 左缘」的横向位置（px）。 */
    x: number;
    /**
     * 线的形态：
     * - `full`：祖先线，铺满整行，负责把上下行的线接过来；
     * - `own`：当前行**自己**那条，从首个视觉行的圆点中心（半行处）往下垂，
     *   只在还有子级时出现；
     * - `tail`：祖先线在**最后一条后代**处收尾——只画上半行（顶→圆点高度），
     *   末端渐隐，不再硬切到行底。
     */
    kind: 'full' | 'own' | 'tail';
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
 * 梦幻色带：以右侧悬垂线颜色着色，向左铺到另一条悬垂线 / 行左边界。
 *
 * - 横向 alpha 渐变（靠左实、靠右在右线处渐隐），既有透明感又有梦幻感；
 * - 右缘内缩 0.5px，保证 1px 悬垂线画在色带之上、不被盖住；
 * - 纵向几何（top / height）与该悬垂线完全一致。
 */
const BAND_ALPHA_LEFT = 0.30;
const BAND_ALPHA_RIGHT = 0.10;

/** 计算一条悬垂线对应的色带几何（左缘、宽、顶、高），单位 px / %。 */
function bandGeometry(
    guides: IndentGuide[],
    index: number,
    halfPx: number
): { left: number; top: string; width: string; height: string } {
    const g = guides[index];
    // 左缘：上一条悬垂线；最外层 = 行 border-box 左缘（0）
    const left = index > 0 ? guides[index - 1].x : 0;
    // 宽：右线中心 − 左缘；内缩 0.5px 给悬垂线留白
    const width = Math.max(0, g.x - left - 0.5);
    let top = 'top';
    let height = '100%';
    if (g.kind === 'tail') {
        top = 'top';
        height = `${halfPx.toFixed(2)}px`;
    } else if (g.kind === 'own') {
        // 从「圆点中心」(halfPx) 起笔、直接接到圆点，而不是从文字基线——
        // 旧写法在圆点(半行)与基线之间留约 6px 断点，色带也跟着断。
        top = `${halfPx.toFixed(2)}px`;
        height = `calc(100% - ${halfPx.toFixed(2)}px)`;
    }
    return { left, top, width: `${width.toFixed(2)}px`, height };
}

/**
 * 根据各级 marker 的**真实中心位置**生成行装饰的行内样式：
 * 悬挂缩进 + 缩进引导线背景。
 *
 * ## 悬挂缩进（hangPx）
 *
 * `padding-left = 4px + hangPx`、`text-indent = -hangPx`：
 * padding 把文字区推到「marker 所在列」，text-indent 只把**第一个视觉行**
 * 拉回原来的行首；于是折出来的续行全部从 marker 列开始（需求：续行与
 * 该层级 marker `-` 本身那一列对齐），首行外观不变。
 *
 * ## 引导线
 *
 * 每条线是一个 1px 宽的 linear-gradient，背景原点用 border-box，
 * 这样同一层级的竖线在不同缩进的行上始终垂直对齐，不受本行 padding 影响：
 * - `full`（祖先）：高 100%、顶对齐，跨行连接；
 * - `own`（自己）：从**文字基线**（下划线位置）垂到行底；
 * - `tail`（收尾祖先）：只画到半行高，末端用 TAIL_FADE_PX 渐隐。
 * 颜色用 `.cm-md-indent` 上定义的 `--cm-md-indent-color`。
 *
 * 为什么不用「层级 × 固定缩进单位」：bullet（`-`）每级缩进 2 列、ordered
 * （`1.`）每级缩进 3 列，统一公式必然顾此失彼。调用方按语法树各级 ListMark
 * 的真实位置传入，bullet / ordered、任意缩进都能精确对齐 marker 中心。
 *
 * @param guides - 从外到内各级 marker 的引导线
 * @param hangPx - 悬挂缩进宽度（px），即 marker 列相对内容左缘的位置
 * @param halfPx - 首个视觉行一半的高度（px），tail 的纵向分界
 * @param baselinePx - 行顶到文字基线的距离（px），own 的纵向起点
 * @returns 可写入 line decoration attributes.style 的样式
 */
export function createListIndentStyle(
    guides: IndentGuide[],
    hangPx: number,
    halfPx: number
): string {
    const decls: string[] = [];

    // —— 悬挂缩进 ——
    if (hangPx > 0) {
        // padding-left 行内长式会顶掉 theme.ts 的 `padding: 0 4px` 左值，
        // 所以用 calc 把 4px 显式加回来；右内边距不受影响
        decls.push(
            `padding-left:calc(${LINE_PADDING_PX}px + ${hangPx.toFixed(2)}px)`,
            `text-indent:${(-hangPx).toFixed(2)}px`
        );
    }

    // —— 层级引导线 + 梦幻色带（rainbow：每个缩进层级一种颜色）——
    if (guides.length > 0) {
        // CSS background 图层：先放梦幻色带（下层），再放 1px 悬垂线（上层）。
        const bandImages: string[] = [];
        const bandSizes: string[] = [];
        const bandPositions: string[] = [];
        const lineImages: string[] = [];
        const lineSizes: string[] = [];
        const linePositions: string[] = [];

        guides.forEach((g, levelIndex) => {
            const [r, gg, b] = hexToRgb(rainbowIndentColor(levelIndex));
            // 梦幻色带：左实右虚的横向 alpha 渐变（右缘在悬垂线处渐隐）
            bandImages.push(
                `linear-gradient(to right, rgba(${r},${gg},${b},${BAND_ALPHA_LEFT}) 0%, rgba(${r},${gg},${b},${BAND_ALPHA_RIGHT}) 100%)`
            );
            const geo = bandGeometry(guides, levelIndex, halfPx);
            bandSizes.push(`${geo.width} ${geo.height}`);
            bandPositions.push(`${geo.left.toFixed(2)}px ${geo.top}`);

            // 1px 悬垂线（盖在色带之上）。
            // 第一级(index 0)的悬垂线隐藏——它的左界已贴住行号线，只留梦幻色带。
            if (levelIndex > 0) {
                const color = `rgb(${r},${gg},${b})`;
                const solidImage = `linear-gradient(to right, ${color} 0 1px, transparent 1px)`;
                const tailImage = `linear-gradient(to bottom, ${color} 0 calc(100% - ${TAIL_FADE_PX}px), transparent 100%)`;
                if (g.kind === 'full') {
                    lineImages.push(solidImage);
                    lineSizes.push('1px 100%');
                    linePositions.push(`${g.x.toFixed(2)}px top`);
                } else if (g.kind === 'tail') {
                    lineImages.push(tailImage);
                    // 量不到行高（halfPx=0，极少见的首帧兜底）时收尾线直接不画
                    lineSizes.push(`1px ${halfPx.toFixed(2)}px`);
                    linePositions.push(`${g.x.toFixed(2)}px top`);
                } else {
                    // own：从「圆点中心」(halfPx) 垂到行底，直接接上圆点、不留断点
                    lineImages.push(solidImage);
                    lineSizes.push(`1px calc(100% - ${halfPx.toFixed(2)}px)`);
                    linePositions.push(`${g.x.toFixed(2)}px ${halfPx.toFixed(2)}px`);
                }
            }
        });
        decls.push(
            'background-origin:border-box',
            'background-repeat:no-repeat',
            `background-image:${bandImages.concat(lineImages).join(', ')}`,
            `background-size:${bandSizes.concat(lineSizes).join(', ')}`,
            `background-position:${bandPositions.concat(linePositions).join(', ')}`
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
