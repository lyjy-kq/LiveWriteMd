/**
 * KaTeX 渲染的公共入口。
 *
 * 公式在两个地方要用到，所以单独抽出来，避免样式注入各写一份：
 *
 * - 正文里的公式：由 widgets.ts 的 InlineMathWidget / BlockMathWidget 渲染成 DOM 节点；
 * - 表格单元格、`<details>` 这些「把 Markdown 渲染成 HTML 字符串」的地方：
 *   由 helpers.ts 调 renderMathToHtml 拿到 HTML 片段拼进去。
 *
 * @module webview/codemirror/extensions/livePreview/mathRender
 */

import katex from 'katex';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - esbuild text loader handles .css imports
import katexCssRaw from 'katex/dist/katex.min.css';

/** 是否已经注入过 KaTeX 样式，避免每次渲染公式都插一遍 <style>。 */
let katexCssInjected = false;

/**
 * 注入 KaTeX 样式表（幂等）。
 *
 * webview 里拿不到 KaTeX 自带的字体文件，所以把 @font-face 规则整段去掉，
 * 再用系统衬线字体兜底，公式的字形不至于跑版。
 */
export function ensureKatexCss(): void {
    if (katexCssInjected) return;
    katexCssInjected = true;

    // 去掉 @font-face（字体加载不到，留着只会刷一堆 404）
    let css = (katexCssRaw as string).replace(/@font-face\s*\{[^}]*\}/g, '');
    // KaTeX 自带字体族名换成本机可用的数学衬线字体
    css = css.replace(/font-family:\s*KaTeX_[A-Za-z_]+/g, 'font-family:Times New Roman,serif');
    css = css.replace(
        /font-family:\s*"KaTeX_[A-Za-z_]+"/g,
        'font-family:"Times New Roman",serif'
    );

    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
}

/**
 * 把 LaTeX 源码渲染成 HTML 字符串。
 *
 * 用于拼 HTML 的场景（表格单元格等），调用方拿到的是可以直接塞进
 * innerHTML 的片段，不需要再做转义。
 *
 * @param tex - LaTeX 源码，不含 `$` 定界符
 * @param displayMode - 是否按独立公式（$$...$$）排版；单元格里通常用 false
 * @returns 渲染出的 HTML；渲染失败时返回空串，由调用方决定怎么兜底
 */
export function renderMathToHtml(tex: string, displayMode: boolean): string {
    ensureKatexCss();
    try {
        return katex.renderToString(tex, {
            throwOnError: false,
            displayMode,
            output: 'htmlAndMathml',
        });
    } catch {
        // 公式写错时 KaTeX 自己会回退成红字原文，这里只兜住极端情况
        return '';
    }
}
