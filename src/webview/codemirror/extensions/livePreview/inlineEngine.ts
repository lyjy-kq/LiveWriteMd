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
 * 图片（渲染 alt 文本）/ 行内公式（$...$、$$...$$，KaTeX）/ `<br>` /
 * `[x]` `[ ]` 复选框 / HTML 实体。输出标签带与正文同款的 `cm-md-*` 类名，
 * 颜色字重都走 styles.ts 那套样式，两处渲染结果一致。
 *
 * 安全性：除白名单 `<br>` 外的 HTML 一律转义，输出可直接 innerHTML。
 *
 * @module webview/codemirror/extensions/livePreview/inlineEngine
 */

import type { SyntaxNode } from '@lezer/common';
import { tunedMarkdownLanguage } from '../markdownParser.js';
import { renderMathToHtml } from './mathRender.js';

/** 共享 parser（tunedMarkdownLanguage 的 Setext 修正对单行行内解析无影响）。 */
const parser = tunedMarkdownLanguage.parser;

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
            // 白名单 <br>，其余 HTML 一律转义（安全底线）
            return BR_TAG_PATTERN.test(tag) ? '<br>' : escapeHtml(tag);
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
