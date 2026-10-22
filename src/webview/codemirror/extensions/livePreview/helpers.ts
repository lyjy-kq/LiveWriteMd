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
import { renderInlineMarkdown } from './inlineEngine.js';

// 统一行内引擎（lezer 驱动，inlineEngine.ts）：live 各处与导图共用。
// 这里 re-export 保持既有调用方（tableRender / widgets）不用改 import。
export { renderInlineMarkdown };

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

// 行内渲染实现已抽去 inlineEngine.ts（统一行内引擎，lezer 驱动）；
// 本文件顶部 re-export 的 renderInlineMarkdown 即旧正则实现的直接替代。

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
// 代码块缩进导引（Rainbow indent）
// =============================================================================

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
    /** 行首空白占的视觉列数（Tab 按 tab-stop 折算）。 */
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
 * **最后一层色带不画满一个单位**，宽度恰好 = 行首空白在本单位内的剩余列数
 * ——于是无论缩进是几列（奇数空格、Tab、空格混 Tab），色带都正好停在
 * 这一行第一个文字/字母开始的位置，不会渲染到文字上。
 *
 * 横向尺寸一律用 **ch 单位**（不用 Canvas 量 px）：`1ch` 就是元素自身字体里
 * `'0'` 的推进宽度，等宽字体下它**按定义等于一列宽**，浏览器会自动跟着行实际
 * 使用的字体/字号走。ch 没有测量环节，首屏即正确。
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

/**
 * 一份「量字宽用」的字体环境。
 *
 * 为什么不一律走 getMeasureContext：它只认全局的 `#editor .cm-content`。
 * 导图节点里的 mini-CM 是独立编辑器 —— 如果页面上恰好没有主编辑器
 * （复现页 / 单实例场景），它会退到 body 的界面字体（比例字体），
 * 给 `- ` 量出 9px 这种偏窄的宽度；而同一条行在源码态按节点自己的
 * 等宽字体渲染时 `- ` 有 15px —— 圆点位置和正文起点就会差一截，
 * 表现为「进编辑态文字横向跳一下」。
 *
 * 所以凡是传得进 EditorView 的地方，都按该视图正文的实际计算样式量。
 */
export interface MeasureEnv {
    /** 正文字号（px）。 */
    size: number;
    /** 正文字体族。 */
    family: string;
    /** 正文字重。 */
    weight: string;
}

/**
 * 从某个元素（通常是 `.cm-content`）读出量字用的字体环境。
 *
 * @param el - 样式来源元素；为空 / 还没挂进文档时返回 null
 * @returns 字体环境；字号读不出来时返回 null（调用方退回全局口径）
 */
export function measureEnvFromElement(el: Element | null | undefined): MeasureEnv | null {
    if (!el) return null;
    // 视图首次构建时 DOM 还没进文档：此时 getComputedStyle 给的是空串 /
    // 浏览器默认字体，量出来的圆点会系统性地窄一截。宁可返回 null
    // （调用方退回全局口径并记一笔，挂载后补重建），也不要拿它当真。
    if (!el.isConnected) return null;
    try {
        const cs = getComputedStyle(el);
        const size = Number.parseFloat(cs.fontSize);
        if (!Number.isFinite(size) || size <= 0) return null;
        return {
            size,
            family: cs.fontFamily || 'monospace',
            weight: cs.fontWeight || '400',
        };
    } catch {
        return null;
    }
}

/**
 * 按给定字体环境量文本宽度。
 *
 * 与 measureText(text, weight, size, family) 的区别：整份环境一次传进来，
 * 调用方不用每次拆成散参数；env 为空时退回全局测量口径（行为与旧代码一致）。
 *
 * @param env - 字体环境（可为空）
 * @param text - 待测文本
 * @param weight - 字重，默认 400
 * @returns 宽度（px）
 */
export function measureTextIn(
    env: MeasureEnv | null,
    text: string,
    weight = '400'
): number {
    if (!text) return 0;
    if (!env) return measureText(text, weight);
    const m = getMeasureContext();
    if (!m) {
        // 没有画布（纯 SSR / 极端环境）：沿用字符数粗估，但字号用 env 的
        let units = 0;
        for (const ch of text) units += /[　-鿿＀-￯]/.test(ch) ? 1 : 0.6;
        return units * env.size;
    }
    m.ctx.font = `${weight} ${env.size}px ${env.family}`;
    return m.ctx.measureText(text).width;
}

/**
 * 圆点 widget 的盒宽：`marker + 分隔空白`。
 *
 * 渲染态的圆点必须精确顶掉源码里的 `- `（`* ` / `+ ` 同理），
 * 否则进编辑态露出原文时正文会横向跳；所以宽度按同一套字体量。
 *
 * @param marker - 源码标记符（`-` / `*` / `+`）
 * @param env - 字体环境；为空时退回全局口径
 * @returns 盒宽（px）
 */
export function measureBulletWidth(marker: string, env: MeasureEnv | null): number {
    return (
        measureTextIn(env, marker, '400') +
        measureTextIn(env, ' ', '400')
    );
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
 * 圆心目标定为**行盒中心**（距行顶 lineHeight/2）：水平方向圆点仍对准
 * marker 中点，垂直方向以整行中心为锚（产品决定，见 widgets.ts）。
 *
 * @param marker - 源码标记符（`-` / `*` / `+`），其字体盒中心即行盒中心
 * @returns 圆点 top 应加的修正量（px）；量不到时给 0，退回不补偿的旧行为，
 *          不影响正常渲染
 */
export function measureBulletYCorrection(
    marker = '-',
    env: MeasureEnv | null = null
): number {
    // 整体 try/catch，沿用 openWrap 的硬规矩：任何测量意外（离屏探针挂载、
    // 字体度量失败等）只让本圆点放弃补偿、退回旧行为，绝不能让异常冒泡到
    // 装饰构建期、把整篇装饰拖垮
    try {
        const m = getMeasureContext();
        if (!m) return 0;
        // 优先按调用方给的视图字体（导图节点的 mini-CM），没有才用全局正文口径
        const size = env?.size ?? m.size;
        const family = env?.family ?? m.family;
        // 标记符在源码里是常规字重（400），canvas 字体必须与它一致
        m.ctx.font = `400 ${size}px ${family}`;
        const metrics = m.ctx.measureText(marker);
        // middle 对齐点相对基线的偏移（负 = 在基线之上）
        const middleOffset = getMiddleAnchorOffset(size, family);
        // 圆心目标 = **行盒（line-box）中心**，即「距离行顶 lineHeight/2」。
        // CSS 里半行距 = (line-height − 字体盒高) 上下均分，所以行盒中心
        // 恒等于字体盒（font-bounding box）中心，与行高无关 —— 直接用
        // canvas 的 fontBoundingBox 度量即可，不需要知道实际 line-height。
        const lineBoxCenterOffset =
            (metrics.fontBoundingBoxDescent -
                metrics.fontBoundingBoxAscent) /
            2;
        // correction = 行盒中心 - middle 点
        return lineBoxCenterOffset - middleOffset;
    } catch (error) {
        console.warn(
            '[bullet] 圆点垂直补偿测量失败，放弃补偿：',
            error
        );
        return 0;
    }
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
