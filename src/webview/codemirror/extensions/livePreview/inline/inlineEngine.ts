/**
 * 统一行内引擎（todo.md 任务 2）：「md 行内源码 → HTML」共享函数。
 *
 * lezer 语法树驱动（复用 tunedMarkdownLanguage 的 parser），替代旧的正则
 * 替换实现 —— 正则处理不了 `**嵌套 *斜体* 加粗**` 这类嵌套，lezer 可以。
 *
 * 两处共用：
 * - live preview：表格单元格、`<font>` 文本、脚注定义等「把 md 源码渲染成
 *   DOM」的地方（经 helpers.ts 的 re-export 使用）；
 * - 思维导图：节点内容的行内渲染（mindmap/inlineRender.ts），导图因此不再
 *   依赖 marked。
 *
 * 支持的行内语法：加粗 / 斜体 / 删除线 / 行内代码 / 链接（含 autolink）/
 * 图片（Markdown 图片渲染 alt 文本；行内 `<img>` 标签渲染成真实图片，见下）/
 * 行内公式（$...$、$$...$$，KaTeX）/ `<br>` / `[x]` `[ ]` 复选框 / HTML 实体。
 * 输出标签带与正文同款的 `cm-md-*` 类名，颜色字重都走 styles.ts 那套样式，
 * 两处渲染结果一致。
 *
 * 行内 `<img src width alt>` 是 README 海报墙（表格格子里放缩略图）的关键：
 * 表格列宽靠这里的 HTML 量，live 装饰则走 plugin.ts 的 HTMLTag 分支渲染成
 * widget，两条路的尺寸口径必须一致（都认 width 属性）。
 *
 * 安全性：除白名单 `<br>` / `<img>` 外的 HTML 一律转义，输出可直接 innerHTML。
 * `<img>` 只保留 src/alt/width/height/title，宽高只接受数字，地址统一走
 * resolvePreviewImageUrl（`javascript:` 之类不会被当成地址）。
 *
 * @module webview/codemirror/extensions/livePreview/inlineEngine
 */

import type { SyntaxNode } from '@lezer/common';
import { tunedMarkdownLanguage } from '../../markdownParser.js';
import { renderMathToHtml } from '../math/mathRender.js';
import { resolvePreviewImageUrl } from '../state.js';

/** 共享 parser（tunedMarkdownLanguage 的 Setext 修正对单行行内解析无影响）。 */
const parser = tunedMarkdownLanguage.parser;

// =============================================================================
// 行内 <img>（表格格子里的海报缩略图）
// =============================================================================

/** 行内图片标签允许保留的属性（其余一概丢弃，`on*` 不可能进来）。 */
const INLINE_IMAGE_ATTRS = new Set(['src', 'alt', 'width', 'height', 'title']);

/** 单个 `<img ...>` 标签（整段文本必须只有一个标签，别把后面的文字吞掉）。 */
const IMG_TAG_PATTERN = /^<img\b([^>]*?)\/?>$/i;

/** 标签属性：双引号 / 单引号 / 裸值三种写法。 */
const TAG_ATTR_PATTERN =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

/** 解析后的行内图片信息。 */
export interface InlineImageAttrs {
    /** 原始地址（未解析成 webview 可访问地址）。 */
    src: string;
    alt?: string;
    width?: string;
    height?: string;
    title?: string;
}

/**
 * 解码 HTML 实体（属性值里的 `&amp;` / `&#x2F;` 等）。
 *
 * 只用最小实现：行内图片的地址里最常见的是 `&amp;`，没必要为几个实体
 * 引入一个 DOM 解析器（这个函数在每次量表格列宽时都会跑）。
 */
function decodeHtmlEntities(text: string): string {
    return text.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (whole, code: string) => {
        const lower = code.toLowerCase();
        if (lower === 'amp') return '&';
        if (lower === 'quot') return '"';
        if (lower === 'apos') return "'";
        if (lower === 'lt') return '<';
        if (lower === 'gt') return '>';
        const value =
            lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
        return Number.isFinite(value) ? String.fromCodePoint(value) : whole;
    });
}

/** 尺寸只接受数字（可带 px / %），把 `onerror=...` 之类挡在门外。 */
function safeDimension(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    return /^\d+(?:\.\d+)?(?:px|%)?$/.test(trimmed) ? trimmed : undefined;
}

/**
 * 解析行内 `<img ...>` 标签。
 *
 * 只读取白名单属性，返回 null 表示：
 * - 这段 HTML 不是单个 img 标签；或
 * - 没有 src（画不出东西，调用方应保持源码显示）。
 *
 * @param raw - HTMLTag 节点原文
 * @returns 图片信息；不适用时 null
 */
export function parseInlineImageTag(raw: string): InlineImageAttrs | null {
    const match = raw.trim().match(IMG_TAG_PATTERN);
    if (!match) return null;

    const attrs: Record<string, string> = {};
    TAG_ATTR_PATTERN.lastIndex = 0;
    let attr: RegExpExecArray | null;
    while ((attr = TAG_ATTR_PATTERN.exec(match[1])) !== null) {
        const name = attr[1].toLowerCase();
        if (!INLINE_IMAGE_ATTRS.has(name)) continue;
        attrs[name] = decodeHtmlEntities(attr[2] ?? attr[3] ?? attr[4] ?? '');
    }

    const src = (attrs.src ?? '').trim();
    if (!src) return null;

    return {
        src,
        alt: attrs.alt,
        width: safeDimension(attrs.width),
        height: safeDimension(attrs.height),
        title: attrs.title,
    };
}

/**
 * 把行内图片渲染成 HTML（拆列宽 / `<font>` 内容等走字符串渲染的场合用）。
 *
 * 地址解析失败时退回转义后的源码，至少不吞内容。
 *
 * @param attrs - parseInlineImageTag 的结果
 * @param raw - 原始标签文本（解析失败时兜底显示）
 * @returns HTML 字符串
 */
function renderInlineImageHtml(attrs: InlineImageAttrs, raw: string): string {
    const resolved = resolvePreviewImageUrl(attrs.src);
    if (!resolved) return escapeHtml(raw);
    const parts = [
        `class="cm-md-inline-image"`,
        `src="${escapeHtml(resolved)}"`,
    ];
    if (attrs.alt !== undefined) parts.push(`alt="${escapeHtml(attrs.alt)}"`);
    if (attrs.title !== undefined) parts.push(`title="${escapeHtml(attrs.title)}"`);
    if (attrs.width) parts.push(`width="${escapeHtml(attrs.width)}"`);
    if (attrs.height) parts.push(`height="${escapeHtml(attrs.height)}"`);
    return `<img ${parts.join(' ')}>`;
}

/**
 * 公式片段：`$$...$$` 优先，其次 `$...$`（排除 $5 这种金额写法）。
 * 公式必须先摘出来：KaTeX 要没被 HTML 转义过的原文，其输出也不能再被转义。
 */
const MATH_SEGMENT_PATTERN =
    /(?<!\$)\$\$([\s\S]+?)\$\$(?!\$)|(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$|\d)/g;

/** 白名单换行标签（GFM 表格单元格用 <br> 换行）。 */
const BR_TAG_PATTERN = /^<br\s*\/?\s*>$/i;

/**
 * Escape HTML special characters.
 */
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * 渲染普通文本片段（两个语法节点之间的「缝隙」文本）。
 *
 * 顺带把 `[x]` / `[ ]` 换成复选框（表格单元格里的行内任务标记）；
 * 独立的 `[x]` 大多已被 parser 解析成无 URL 的 Link 节点，走 {@link renderLink}
 * 的复选框分支，这里是兜底（嵌在更长文本里、链接解析失败的场景）。
 */
function renderText(text: string): string {
    if (text === '') return '';
    return escapeHtml(text)
        .replace(
            /\[(x|X)\]/g,
            '<input type="checkbox" checked class="cm-md-checkbox cm-md-table-checkbox" />'
        )
        .replace(
            /\[ \]/g,
            '<input type="checkbox" class="cm-md-checkbox cm-md-table-checkbox" />'
        );
}

/**
 * 渲染 Link / Image 节点。
 *
 * - `[label](url)` → 只保留 label（节点内容不可点穿，不输出 href）；
 * - 无 URL 的 `[x]` / `[ ]` → 复选框；其它无 URL 的引用式写法 → 按纯文本渲染 label；
 * - Image → 渲染 alt 文本（导图节点的图片走媒体节点，行内图片只留文字）。
 */
function renderLinkLike(node: SyntaxNode, src: string): string {
    let hasUrl = false;
    let label = '';
    // label 文字是 LinkMark 子节点之间的「缝隙」（如 `[文字](url)` 里的「文字」），
    // 必须像 renderChildren 一样补缝隙，不能只渲染子节点
    let pos = node.from;
    for (let child = node.firstChild; child; child = child.nextSibling) {
        // 先补缝隙（label 文字），再按类型处理子节点 —— 否则 `]` 前的
        // label 文字会被 LinkMark 分支跳掉
        if (child.from > pos) label += renderText(src.slice(pos, child.from));
        if (child.name === 'URL' || child.name === 'LinkTitle') {
            hasUrl = true;
        } else if (child.name !== 'LinkMark') {
            // label 里的行内元素（如 [加 **粗** 体](url)）递归渲染
            label += renderNode(child, src);
        }
        pos = child.to;
    }
    // 复选框：[x] / [ ]（无 URL 的「链接」）
    const rawLabel = src.slice(node.from, node.to);
    if (!hasUrl && /^\[[ xX]\]$/.test(rawLabel)) {
        const checked = rawLabel[1] !== ' ';
        return `<input type="checkbox"${checked ? ' checked' : ''} class="cm-md-checkbox cm-md-table-checkbox" />`;
    }
    if (node.name === 'Image') {
        // 图片只留 alt 文本，不带链接样式
        return label === '' ? escapeHtml(rawLabel) : label;
    }
    if (!hasUrl) {
        // 引用式链接（未解析到定义）→ 纯文本
        return label === '' ? renderText(rawLabel) : label;
    }
    return `<a class="cm-md-link">${label}</a>`;
}

/**
 * 递归渲染一个语法节点（标记类节点输出空串，标记符号不进结果）。
 */
function renderNode(node: SyntaxNode, src: string): string {
    switch (node.name) {
        case 'EmphasisMark':
        case 'StrikethroughMark':
        case 'CodeMark':
        case 'LinkMark':
            // 定界符号本身不渲染
            return '';
        case 'Emphasis':
            return `<em class="cm-md-italic">${renderChildren(node, src)}</em>`;
        case 'StrongEmphasis':
            return `<strong class="cm-md-bold">${renderChildren(node, src)}</strong>`;
        case 'Strikethrough':
            return `<del class="cm-md-strikethrough">${renderChildren(node, src)}</del>`;
        case 'InlineCode':
            // 代码内容不做任何行内替换（连复选框也不换），纯转义
            return `<code class="cm-md-code">${escapeHtml(
                src.slice(codeContentFrom(node), codeContentTo(node))
            )}</code>`;
        case 'Link':
        case 'Image':
            return renderLinkLike(node, src);
        case 'Autolink': {
            // <https://a.b> → 显示 URL 文本
            for (let child = node.firstChild; child; child = child.nextSibling) {
                if (child.name === 'URL') {
                    return `<a class="cm-md-link">${escapeHtml(src.slice(child.from, child.to))}</a>`;
                }
            }
            return renderText(src.slice(node.from, node.to));
        }
        case 'HTMLTag': {
            const tag = src.slice(node.from, node.to);
            // 白名单 <br> 与 <img>（表格格子里的海报缩略图），其余 HTML 一律转义
            if (BR_TAG_PATTERN.test(tag)) return '<br>';
            const image = parseInlineImageTag(tag);
            if (image) return renderInlineImageHtml(image, tag);
            return escapeHtml(tag);
        }
        case 'Entity':
            // &amp; 这类实体原样输出（本身已是转义形态，不能再 escape）
            return src.slice(node.from, node.to);
        case 'HardBreak':
            return '<br>';
        default:
            // 未识别的节点（Subscript/Superscript/Emoji 等）：渲染其子内容，
            // 标记符号不进结果也不强求还原 —— 保持「显示内容」语义即可
            return renderChildren(node, src);
    }
}

/** InlineCode 正文的起点（跳过开头的 CodeMark / 反引号串）。 */
function codeContentFrom(node: SyntaxNode): number {
    const first = node.firstChild;
    return first && first.name === 'CodeMark' ? first.to : node.from;
}

/** InlineCode 正文的终点（去掉结尾的 CodeMark）。 */
function codeContentTo(node: SyntaxNode): number {
    const last = node.lastChild;
    return last && last.name === 'CodeMark' ? last.from : node.to;
}

/**
 * 渲染节点的全部子节点，子节点之间的文本缝隙走 {@link renderText}。
 */
function renderChildren(node: SyntaxNode, src: string): string {
    let html = '';
    let pos = node.from;
    for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.from > pos) html += renderText(src.slice(pos, child.from));
        html += renderNode(child, src);
        pos = child.to;
    }
    if (node.to > pos) html += renderText(src.slice(pos, node.to));
    return html;
}

/**
 * 渲染不含公式的行内片段（lezer 语法树驱动）。
 *
 * @param text - 行内 md 源码（已做 `\|` → `|` 预处理与 trim）
 * @returns HTML；空输入返回空串
 */
function renderPlainInline(text: string): string {
    if (text === '') return '';
    const tree = parser.parse(text);
    // Document 下通常只有一个 Paragraph；多行输入可能出现多个块，逐个渲染
    let html = '';
    let first = true;
    for (let child = tree.topNode.firstChild; child; child = child.nextSibling) {
        if (!first) html += '<br>';
        first = false;
        html += renderChildren(child, text);
    }
    return html;
}

/**
 * Render inline Markdown to HTML (bold, italic, strikethrough, code, links, math).
 *
 * 按公式切段：公式段交 KaTeX，普通段走 lezer 行内引擎，最后拼回。
 * 与旧正则版行为对齐：输入整体 trim、`\|` 预处理为空格之前的竖线还原、
 * 空结果给 `&nbsp;` 占位（空 td / 空节点不塌陷）。
 */
export function renderInlineMarkdown(text: string): string {
    const segments: string[] = [];
    let cursor = 0;
    let match: RegExpExecArray | null;

    MATH_SEGMENT_PATTERN.lastIndex = 0;
    while ((match = MATH_SEGMENT_PATTERN.exec(text)) !== null) {
        // 公式前面那一段普通文本
        segments.push(renderPlainInline(preprocess(text.slice(cursor, match.index))));

        // 第 1 组命中说明是 $$...$$（独立公式），否则是 $...$（行内公式）
        const isDisplay = match[1] !== undefined;
        const tex = (match[1] ?? match[2] ?? '').trim();
        if (tex) {
            segments.push(renderMathToHtml(tex, isDisplay));
        } else {
            // 空公式（例如 `$ $`）保持原样，避免凭空消失
            segments.push(renderPlainInline(preprocess(match[0])));
        }

        cursor = match.index + match[0].length;
    }
    segments.push(renderPlainInline(preprocess(text.slice(cursor))));

    const html = segments.join('');
    // 空内容给个占位，否则 td / 导图节点会塌陷
    return html === '' ? '&nbsp;' : html;
}

/**
 * 片段预处理：`\|` → `|`（markdown 表格转义）+ trim（与旧正则版一致）。
 */
function preprocess(text: string): string {
    return text.replace(/\\\|/g, '|').trim();
}
