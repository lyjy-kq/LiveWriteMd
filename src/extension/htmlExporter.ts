/**
 * FlowMD HTML Exporter
 *
 * Converts Markdown files to standalone HTML documents.
 * Handles math (KaTeX→MathML), Mermaid (CDN), footnotes,
 * syntax highlighting (highlight.js CDN), and GFM extensions.
 *
 * @module extension/htmlExporter
 */

import * as vscode from 'vscode';
import * as path from 'path';
import katex from 'katex';
import { LIGHT_THEME_CSS } from './htmlExportStyles.js';
import { Logger } from './logger.js';

// =============================================================================
// Constants
// =============================================================================

const MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
const HLJS_CDN_CSS =
    'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github.min.css';
const HLJS_CDN_JS = 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/highlight.min.js';

// =============================================================================
// Math Preprocessing
// =============================================================================

interface MathPlaceholder {
    placeholder: string;
    html: string;
}

/**
 * Render a TeX expression to MathML via KaTeX.
 */
function renderMath(tex: string, displayMode: boolean): string {
    try {
        return katex.renderToString(tex, {
            output: 'mathml',
            displayMode,
            throwOnError: false,
        });
    } catch {
        const escaped = tex.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<span class="math-error">${escaped}</span>`;
    }
}

/**
 * 从 Markdown 中提取数学公式，并用占位符暂存渲染结果。
 *
 * @param markdown - 原始 Markdown 文本
 * @returns 处理后的正文与公式占位符列表
 */
function extractMath(markdown: string): { text: string; placeholders: MathPlaceholder[] } {
    const placeholders: MathPlaceholder[] = [];
    let idx = 0;

    // 生成占位符并记录对应的公式渲染 HTML，后续再回填。
    function makePlaceholder(html: string): string {
        const ph = `%%MATH_PH_${idx++}%%`;
        placeholders.push({ placeholder: ph, html });
        return ph;
    }

    const lines = markdown.split('\n');
    const result: string[] = [];
    let i = 0;
    let insideCodeBlock = false;

    while (i < lines.length) {
        const line = lines[i];

        // Track fenced code blocks
        if (line.trimStart().startsWith('```')) {
            insideCodeBlock = !insideCodeBlock;
            result.push(line);
            i++;
            continue;
        }

        if (insideCodeBlock) {
            result.push(line);
            i++;
            continue;
        }

        // 同行块级公式：只有整行都被 $$ 包围时，才保留块级渲染。
        const sameLineMatch = line.match(/^\s*\$\$\s*(.+?)\s*\$\$\s*$/);
        if (sameLineMatch) {
            const tex = sameLineMatch[1].trim();
            const html = `<div class="math-block">${renderMath(tex, true)}</div>`;
            result.push(makePlaceholder(html));
            i++;
            continue;
        }

        // 多行块级公式：只有整行是 $$ 时才继续向下查找闭合行。
        if (line.trim() === '$$') {
            let closingIdx = i + 1;
            let found = false;
            while (closingIdx < lines.length) {
                if (/^\s*\$\$\s*$/.test(lines[closingIdx])) {
                    found = true;
                    break;
                }
                closingIdx++;
            }

            if (found) {
                const texContent = lines
                    .slice(i + 1, closingIdx)
                    .join('\n')
                    .trim();
                const html = `<div class="math-block">${renderMath(texContent, true)}</div>`;
                result.push(makePlaceholder(html));
                i = closingIdx + 1;
            } else {
                // No closing $$, leave as-is
                result.push(line);
                i++;
            }
            continue;
        }

        // 同行 display 公式：允许出现在普通文本或列表项中。
        const withBlockMath = line.replace(
            /(?<!\$)\$\$\s*(.+?)\s*\$\$(?!\$)/g,
            (_match, tex: string) => {
                const html = `<span class="math-inline">${renderMath(tex, false)}</span>`;
                return makePlaceholder(html);
            }
        );

        // 行内公式：允许 $ 与内容之间有空格，但仍排除 $$ 形式。
        const processed = withBlockMath.replace(
            /(?<!\$)\$(?!\$)\s*(.+?)\s*\$(?!\$|\d)/g,
            (_match, tex: string) => {
                if (!tex.trim()) return _match;
                // 行内代码中的美元符号不参与公式渲染。
                const html = `<span class="math-inline">${renderMath(tex, false)}</span>`;
                return makePlaceholder(html);
            }
        );
        result.push(processed);
        i++;
    }

    return { text: result.join('\n'), placeholders };
}

/**
 * Restore math placeholders in rendered HTML.
 */
function restoreMath(html: string, placeholders: MathPlaceholder[]): string {
    let result = html;
    for (const { placeholder, html: mathHtml } of placeholders) {
        result = result.replace(placeholder, mathHtml);
    }
    return result;
}

// =============================================================================
// Footnote Preprocessing
// =============================================================================

interface FootnoteData {
    label: string;
    index: number;
    content: string;
}

/**
 * Extract footnote definitions and convert references to HTML.
 * Definitions are removed from text and rendered as a section at the end.
 */
function processFootnotes(markdown: string): { text: string; footnotesHtml: string } {
    const lines = markdown.split('\n');
    const footnotes: FootnoteData[] = [];
    const labels: string[] = [];
    const resultLines: string[] = [];

    // First pass: collect all footnote definitions
    for (const line of lines) {
        const defMatch = line.match(/^\[\^([^\]]+)\]:\s?(.*)/);
        if (defMatch) {
            const label = defMatch[1];
            const content = defMatch[2];
            if (!labels.includes(label)) {
                labels.push(label);
                footnotes.push({ label, index: labels.length, content });
            }
        } else {
            resultLines.push(line);
        }
    }

    if (footnotes.length === 0) {
        return { text: markdown, footnotesHtml: '' };
    }

    // Second pass: convert references [^label] to superscript links
    let text = resultLines.join('\n');
    for (const fn of footnotes) {
        const refPattern = new RegExp(`\\[\\^${escapeRegex(fn.label)}\\]`, 'g');
        text = text.replace(
            refPattern,
            `<sup class="footnote-ref"><a href="#fn-${fn.index}" id="fnref-${fn.index}">${fn.index}</a></sup>`
        );
    }

    // Build footnotes section HTML
    const footnotesHtml = `
<section class="footnotes-section">
<hr>
<ol>
${footnotes
    .map(
        (fn) =>
            `<li id="fn-${fn.index}">${fn.content} <a href="#fnref-${fn.index}" class="footnote-backref">\u21a9</a></li>`
    )
    .join('\n')}
</ol>
</section>`;

    return { text, footnotesHtml };
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// =============================================================================
// Mermaid Preprocessing
// =============================================================================

/**
 * 解析 `{width=NN%}` 形式的媒体宽度属性。
 *
 * 编辑器和导出的语法保持一致，这里只做读取，不做单位换算。
 *
 * @param text - 含属性文本的片段
 * @returns 宽度百分比；没有属性或数值非法时返回 null
 */
function parseMediaWidthPercent(text: string): number | null {
    const match = text.match(/\{width=(\d+)%\}/);
    if (!match) {
        return null;
    }

    const percent = Number.parseInt(match[1], 10);
    if (!Number.isFinite(percent)) {
        return null;
    }

    // 收敛到 25%–100%，避免手写的越界值把导出排版撑坏。
    return Math.min(100, Math.max(25, percent));
}

/**
 * 生成媒体宽度的内联变量声明。
 *
 * 样式表里统一用 `var(--flowmd-media-width, 75%)` 消费，所以调整过宽度的
 * 图片和 Mermaid 图只要挂上这个变量就能覆盖默认值。
 *
 * @param percent - 宽度百分比
 * @returns 可直接拼进 style 属性的声明
 */
function buildMediaWidthStyle(percent: number): string {
    return `--flowmd-media-width:${percent}%`;
}

/**
 * 把图片语法尾随的 `{width=NN%}` 转成内联宽度变量。
 *
 * marked 会把属性当成普通文本原样输出（`<img ...>{width=50%}`），
 * 这里把它吸进 img 的 style，避免这串花括号出现在导出结果里。
 *
 * @param html - marked 渲染后的 HTML 片段
 * @returns 处理后的 HTML 片段
 */
function applyImageWidthAttributes(html: string): string {
    return html.replace(
        /(<img\b[^>]*>)\s*\{width=(\d+)%\}/g,
        (_match, imgTag: string, rawPercent: string) => {
            const percent = parseMediaWidthPercent(`{width=${rawPercent}%}`);
            if (percent === null) {
                return imgTag;
            }

            // marked 不会给 img 生成 style，直接插在最前面即可。
            return imgTag.replace(/^<img/, `<img style="${buildMediaWidthStyle(percent)}"`);
        }
    );
}

/**
 * Convert ```mermaid code blocks to <pre class="mermaid"> for CDN rendering.
 *
 * 围栏信息行支持 `mermaid 标题 {width=50%}`，宽度会转成内联变量，
 * 让导出的图宽和编辑器里看到的一致。
 */
function processMermaid(markdown: string): { text: string; hasMermaid: boolean } {
    let hasMermaid = false;
    const lines = markdown.split('\n');
    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trimStart();
        const fenceMatch = trimmed.match(/^```\s*mermaid\b(.*)$/);

        if (fenceMatch) {
            hasMermaid = true;
            const widthPercent = parseMediaWidthPercent(fenceMatch[1]);
            const styleAttribute =
                widthPercent === null ? '' : ` style="${buildMediaWidthStyle(widthPercent)}"`;

            // Find closing ```
            let closingIdx = i + 1;
            while (closingIdx < lines.length && !lines[closingIdx].trimStart().startsWith('```')) {
                closingIdx++;
            }

            const mermaidContent = lines.slice(i + 1, closingIdx).join('\n');
            result.push(`<pre class="mermaid"${styleAttribute}>`);
            result.push(mermaidContent);
            result.push(`</pre>`);
            i = closingIdx + 1;
        } else {
            result.push(line);
            i++;
        }
    }

    return { text: result.join('\n'), hasMermaid };
}

// =============================================================================
// HTML Generation
// =============================================================================

/**
 * Convert Markdown to rendered HTML body using marked.
 */
async function convertMarkdownToHtml(
    markdown: string
): Promise<{ body: string; hasMermaid: boolean }> {
    // 1. Extract math expressions (before marked touches them)
    const { text: afterMath, placeholders } = extractMath(markdown);

    // 2. Process footnotes
    const { text: afterFootnotes, footnotesHtml } = processFootnotes(afterMath);

    // 3. Process Mermaid blocks (before marked escapes them)
    const { text: afterMermaid, hasMermaid } = processMermaid(afterFootnotes);

    // 4. Parse remaining Markdown with marked
    // Note: marked is ESM-only; dynamic import() is the TS-sanctioned way to load
    // it from a CJS module. esbuild inlines this into the bundle at build time,
    // so runtime behavior is identical to a static import.
    const { Marked } = await import('marked');
    const marked = new Marked();
    marked.setOptions({
        gfm: true,
        breaks: false,
    });

    let html = await marked.parse(afterMermaid);

    // 5. Restore math placeholders
    html = restoreMath(html, placeholders);

    // 6. 把图片尾随的宽度属性收进内联样式，保证导出宽度和编辑器一致
    html = applyImageWidthAttributes(html);

    // 7. Append footnotes
    if (footnotesHtml) {
        html += footnotesHtml;
    }

    return { body: html, hasMermaid };
}

/**
 * Generate a complete standalone HTML document.
 */
function generateStandaloneHtml(body: string, title: string, hasMermaid: boolean): string {
    const mermaidScript = hasMermaid
        ? `\n<script type="module">
import mermaid from '${MERMAID_CDN}';
mermaid.initialize({ startOnLoad: true, theme: 'default' });
</script>`
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${HLJS_CDN_CSS}">
<style>
${LIGHT_THEME_CSS}
</style>
</head>
<body>
<div class="markdown-body">
${body}
</div>
<script src="${HLJS_CDN_JS}"></script>
<script>hljs.highlightAll();</script>${mermaidScript}
</body>
</html>`;
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// =============================================================================
// Shared Export Helpers
// =============================================================================

/**
 * 解析要导出的 Markdown 文件 URI。
 *
 * 优先使用调用方传入的 URI；没有时依次回退到活动文本编辑器和活动标签页，
 * 这样资源管理器右键、编辑器标题栏按钮和命令面板可以共用同一套解析逻辑。
 *
 * @param uri - 调用方传入的候选 URI
 * @returns 解析出的 Markdown 文件 URI；无法确定时返回 undefined
 */
export function resolveMarkdownTargetUri(uri?: vscode.Uri): vscode.Uri | undefined {
    if (uri) {
        return uri;
    }

    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.languageId === 'markdown') {
        return activeEditor.document.uri;
    }

    // 自定义编辑器（FlowMD 自己）下没有 activeTextEditor，只能从活动标签页取 URI。
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (activeTab?.input && typeof activeTab.input === 'object' && 'uri' in activeTab.input) {
        return (activeTab.input as { uri: vscode.Uri }).uri;
    }

    return undefined;
}

/**
 * 导出的渲染结果。
 */
export interface RenderedMarkdownExport {
    /** 完整的独立 HTML 文档内容。 */
    html: string;
    /** 用于标题和文件名的文档名（不含扩展名）。 */
    title: string;
    /** 去掉 .md 扩展名后的绝对路径，作为导出文件的输出前缀。 */
    basePath: string;
}

/**
 * 把 Markdown 文件渲染成完整的独立 HTML 文档。
 *
 * HTML 导出和 PDF 导出共用这一步，保证两种导出的排版完全一致。
 *
 * @param uri - 目标 Markdown 文件 URI
 * @returns 渲染结果，包含 HTML 文本、标题和输出路径前缀
 */
export async function renderMarkdownFile(uri: vscode.Uri): Promise<RenderedMarkdownExport> {
    const fileContent = await vscode.workspace.fs.readFile(uri);
    const markdown = Buffer.from(fileContent).toString('utf-8');

    const { body, hasMermaid } = await convertMarkdownToHtml(markdown);

    const mdPath = uri.fsPath;
    const title = path.basename(mdPath, path.extname(mdPath));
    const basePath = mdPath.replace(/\.md$/i, '');

    return {
        html: generateStandaloneHtml(body, title, hasMermaid),
        title,
        basePath,
    };
}

// =============================================================================
// Command Handler
// =============================================================================

/**
 * Export a Markdown file as standalone HTML.
 * Called from Explorer context menu, editor tab context menu, or command palette.
 *
 * @param uri - The URI of the Markdown file to export (optional; uses active editor if not provided)
 */
export async function exportMarkdownAsHtml(uri?: vscode.Uri): Promise<void> {
    try {
        const targetUri = resolveMarkdownTargetUri(uri);
        if (!targetUri) {
            vscode.window.showWarningMessage('FlowMD: No Markdown file selected.');
            return;
        }

        Logger.info(`Exporting HTML: ${targetUri.fsPath}`);

        const { html, basePath } = await renderMarkdownFile(targetUri);
        const htmlPath = `${basePath}.html`;

        await vscode.workspace.fs.writeFile(
            vscode.Uri.file(htmlPath),
            Buffer.from(html, 'utf-8')
        );

        Logger.info(`HTML exported: ${htmlPath}`);
        vscode.window.showInformationMessage(`FlowMD: Exported to ${path.basename(htmlPath)}`);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        Logger.error(
            `HTML export failed: ${errorMessage}`,
            error instanceof Error ? error : undefined
        );
        vscode.window.showErrorMessage(`FlowMD: Export failed: ${errorMessage}`);
    }
}
