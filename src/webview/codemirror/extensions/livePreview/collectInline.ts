/**
 * Live Preview 装饰管线（从 plugin.ts 拆出）：行内收集器：标题字体标签 / 复选框 / 图片装饰。
 *
 * @module webview/codemirror/extensions/livePreview/collectInline
 */

import { updateImageWidthInSource } from './sourceWriteback.js';
import { treeLikeIterateTextBlocks } from './treeDecorations.js';
import { hiddenSourceDeco, imageLineDeco } from './decor/decorations.js';
import { extractFencedCodeLanguage, extractSafeFontStyles, splitMarkdownImageDestination } from './measure/sourceParse.js';
import { DEFAULT_MEDIA_WIDTH_PERCENT, measureTrailingWidthAttribute, parseMediaWidthPercent } from './mediaWidth.js';
import { windowLines } from './ranges.js';
import { isInTableCell } from './table/tableLocate.js';
import type { ILineRange } from './types.js';
import { ImageWidget } from './widgets/mediaWidgets.js';
import { CheckboxWidget, FontTextWidget } from './widgets/simpleWidgets.js';
import type { EditorState } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import type { SyntaxNode, Tree } from '@lezer/common';


/**
 * 收集标题中的 `<font>` 装饰。
 *
 * 这里只恢复标题级场景，避免把正文段落里的 `<font>` 行为一并放开。
 *
 * @param state - 当前编辑器状态。
 * @param decos - 待追加的装饰数组。
 * @param focusedRange - 当前聚焦的源码区间。
 * @param tree - 当前语法树。
 * @returns void
 */
export function collectHeadingFontDecorations(
    state: EditorState,
    decos: Array<ReturnType<Decoration['range']>>,
    range: ILineRange,
    focusedRange: ILineRange,
    tree: Tree
): void {
    const win = windowLines(state, range);
    /**
     * 判断指定位置是否落在需要保护的源码区域内。
     *
     * 这里会屏蔽行内代码、代码块、表格等区域，避免把 `<font>` widget 错误地
     * 嵌入到源码示例或结构化内容里。
     *
     * @param pos - 需要检测的文档位置。
     * @returns 是否位于保护区域。
     */
    const isInsideProtectedNode = (pos: number): boolean => {
        let node = tree.resolveInner(pos, 1);
        while (node) {
            const name = node.type.name;
            if (
                name === 'InlineCode' ||
                name === 'CodeMark' ||
                name === 'FencedCode' ||
                name === 'CodeText' ||
                name === 'CodeBlock' ||
                name === 'CodeInfo' ||
                name === 'Table' ||
                name.startsWith('Table')
            ) {
                return true;
            }
            if (!node.parent || node.parent === node) {
                break;
            }
            node = node.parent;
        }

        return false;
    };

    /**
     * 判断当前行是否属于标题行。
     *
     * 兼容 ATX 标题与 Setext 标题，确保 `test2.md` 里的标题写法都能进入渲染分支。
     *
     * @param lineText - 当前行文本。
     * @param nextLineText - 下一行文本，用于判断 Setext 标题。
     * @returns 是否为标题行。
     */
    const isHeadingLine = (lineText: string, nextLineText: string | undefined): boolean => {
        if (/^\s{0,3}(#{1,6})\s+.+$/.test(lineText)) {
            return true;
        }

        if (!nextLineText) {
            return false;
        }

        return /^\s*=+\s*$/.test(nextLineText) || /^\s*-+\s*$/.test(nextLineText);
    };

    const fontRegex = /<font\b([^>]*)>([\s\S]*?)<\/font>/gi;

    for (let ln = win.first; ln <= win.last; ln++) {
        const line = state.doc.line(ln);
        const nextLineText = ln < state.doc.lines ? state.doc.line(ln + 1).text : undefined;

        if (line.from < focusedRange.to && line.to > focusedRange.from) {
            continue;
        }

        const lineText = line.text;
        if (!lineText.includes('<font')) continue;
        if (!isHeadingLine(lineText, nextLineText)) continue;
        if (isInsideProtectedNode(line.from)) continue;

        fontRegex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = fontRegex.exec(lineText)) !== null) {
            const innerText = match[2];
            if (!innerText.trim()) continue;

            const fontFrom = line.from + match.index;
            const fontTo = fontFrom + match[0].length;
            if (fontFrom < focusedRange.to && fontTo > focusedRange.from) continue;
            if (isInsideProtectedNode(fontFrom)) continue;

            const styles = extractSafeFontStyles(match[1]);
            decos.push(
                Decoration.replace({
                    widget: new FontTextWidget(styles, innerText),
                }).range(fontFrom, fontTo)
            );
        }
    }
}


/**
 * Collect inline checkbox decorations.
 * Matches [ ], [x], [X] outside of list TaskMarkers, code spans, and links.
 */
export function collectCheckboxDecorations(
    state: EditorState,
    decos: Array<ReturnType<Decoration['range']>>,
    range: ILineRange,
    focusedRange: ILineRange,
    tree: Tree,
    taskMarkerPositions: Set<number>
): void {
    const cbRegex = /\[([ xX])\]/g;
    const win = windowLines(state, range);
    for (let ln = win.first; ln <= win.last; ln++) {
        const line = state.doc.line(ln);

        if (line.from < focusedRange.to && line.to > focusedRange.from) {
            continue;
        }

        // Quick skip: lines without [ can't contain checkboxes
        if (!line.text.includes('[')) continue;

        cbRegex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = cbRegex.exec(line.text)) !== null) {
            const cbFrom = line.from + match.index;
            const cbTo = cbFrom + 3; // [ ] or [x] is always 3 chars

            // Skip if already handled as TaskMarker in list items
            if (taskMarkerPositions.has(cbFrom)) continue;

            // 上下文边界检查：任务复选框只该出现在行首/列表标记之后，
            // 且 `]` 后面按 CommonMark 规定必须跟空白或位于行尾。
            // 不检查的话算法笔记里的数组下标会被误渲染：
            // `dp[x]` → 勾选框、`a[ ]` → 空框。
            const charBefore = state.doc.sliceString(cbFrom - 1, cbFrom);
            if (/[\p{L}\p{N}_]/u.test(charBefore)) continue;
            const charAfter = state.doc.sliceString(cbTo, cbTo + 1);
            // 非空白且不是行尾就跳过（链接 `[x](url)` 的 `(` 也一并被排除）
            if (charAfter !== '' && !/\s/.test(charAfter)) continue;

            // Skip if inside code span (InlineCode node)
            let node = tree.resolveInner(cbFrom, 1);
            let inCode = false;
            while (node) {
                if (
                    node.name === 'InlineCode' ||
                    node.name === 'FencedCode' ||
                    node.name === 'CodeBlock'
                ) {
                    inCode = true;
                    break;
                }
                if (!node.parent || node.parent === node) break;
                node = node.parent;
            }
            if (inCode) continue;

            const checked = match[1] === 'x' || match[1] === 'X';
            // 和行内公式同一套：源码盖住（压 0 宽）+ widget 夹在中间。
            // 不能用整段 replace —— 单元格里的「格子」是 mark 包出来的盒子，
            // 格子里整段都是 replace 的话，CodeMirror 会连盒子一起丢掉。
            decos.push(hiddenSourceDeco.range(cbFrom, cbFrom + 1));
            decos.push(hiddenSourceDeco.range(cbFrom + 1, cbTo));
            decos.push(
                Decoration.widget({
                    widget: new CheckboxWidget(checked, cbFrom),
                    side: -1,
                }).range(cbFrom + 1)
            );
        }
    }
}


/**
 * 收集 wiki 图片与包含空格的 Markdown 图片装饰。
 *
 * 这里保留原有标准 Markdown 图片渲染分支，同时补上 Wiki 图片语法
 * 与空格文件名场景，避免预览端只认一种写法。
 *
 * @param state - 当前编辑器状态
 * @param decos - 装饰集合输出容器
 * @param focusedRange - 当前正在编辑的块范围
 */
export function collectImageDecorations(
    state: EditorState,
    decos: Array<ReturnType<Decoration['range']>>,
    range: ILineRange,
    focusedRange: ILineRange,
    tree: Tree
): void {
    const wikiImageRegex = /!\[\[([^\]\n]+?)\]\]/g;
    const markdownImageRegex = /!\[([^\]]*?)\]\(([^)\n]+)\)/g;

    treeLikeIterateTextBlocks(
        state,
        // 夹到窗口内：公共遍历是按聚焦范围走语法树的，这里只关心窗口里的图
        { from: Math.max(focusedRange.from, range.from), to: Math.min(focusedRange.to, range.to) },
        tree,
        (from, to, text) => {
        wikiImageRegex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = wikiImageRegex.exec(text)) !== null) {
            const inner = match[1];
            const [rawTarget, alias] = inner.split('|', 2);
            const imageUrl = rawTarget.trim();
            if (!imageUrl) {
                continue;
            }

            const altText = alias ?? '';
            // wiki 图片同样支持尾随宽度属性，范围要把属性一起圈进来。
            const wikiFrom = from + match.index;
            const wikiTo =
                wikiFrom +
                match[0].length +
                measureTrailingWidthAttribute(text.slice(match.index + match[0].length));
            // 单元格里不渲染图片：格子是 mark 包出来的，整段 replace 会把盒子顶掉
            if (isInTableCell(tree, wikiFrom)) continue;
            const wikiRawText = state.doc.sliceString(wikiFrom, wikiTo);
            const wikiWidth =
                parseMediaWidthPercent(wikiRawText) ?? DEFAULT_MEDIA_WIDTH_PERCENT;

            addImageLineDecoration(state, decos, wikiFrom, wikiTo);
            decos.push(
                Decoration.replace({
                    widget: new ImageWidget(
                        imageUrl,
                        altText,
                        wikiFrom,
                        wikiTo,
                        null,
                        wikiWidth,
                        (widgetView: EditorView, nextPercent: number) => {
                            updateImageWidthInSource(
                                widgetView,
                                wikiFrom,
                                wikiTo,
                                wikiRawText,
                                nextPercent
                            );
                        }
                    ),
                }).range(wikiFrom, wikiTo)
            );
        }

        markdownImageRegex.lastIndex = 0;
        while ((match = markdownImageRegex.exec(text)) !== null) {
            const altText = match[1];
            const rawDestination = splitMarkdownImageDestination(match[2]);

            // 标准无空格的 Markdown 图片保留给原有 syntax tree 分支处理，
            // 这里只补充空格路径，避免重复装饰。
            if (!/\s/.test(rawDestination)) {
                continue;
            }

            if (!rawDestination) {
                continue;
            }

            const spacedFrom = from + match.index;
            // 单元格里不渲染图片：格子是 mark 包出来的，整段 replace 会把盒子顶掉
            if (isInTableCell(tree, spacedFrom)) continue;
            const spacedTo =
                spacedFrom +
                match[0].length +
                measureTrailingWidthAttribute(text.slice(match.index + match[0].length));
            const spacedRawText = state.doc.sliceString(spacedFrom, spacedTo);
            const spacedWidth =
                parseMediaWidthPercent(spacedRawText) ?? DEFAULT_MEDIA_WIDTH_PERCENT;

            addImageLineDecoration(state, decos, spacedFrom, spacedTo);
            decos.push(
                Decoration.replace({
                    widget: new ImageWidget(
                        rawDestination,
                        altText,
                        spacedFrom,
                        spacedTo,
                        null,
                        spacedWidth,
                        (widgetView: EditorView, nextPercent: number) => {
                            updateImageWidthInSource(
                                widgetView,
                                spacedFrom,
                                spacedTo,
                                spacedRawText,
                                nextPercent
                            );
                        }
                    ),
                }).range(spacedFrom, spacedTo)
            );
        }
    });
}


/**
 * 判断节点是不是「单击保持渲染、双击才进源码」的块级内容。
 *
 * 表格、图片、Mermaid 图这三类在渲染态是一个完整的 widget，
 * 光标一进去就把整块摊成源码会很难看（表格尤其乱），所以改成：
 * 单击只把光标放进源码里（表格因此能就地改单元格），双击才切换成源码。
 *
 * @param node - 语法节点
 * @param state - 编辑器状态，用来读 fenced code 的语言
 * @returns 属于这三类内容时返回 true
 */
export function isWidgetBackedNode(node: SyntaxNode, state: EditorState): boolean {
    // 表格不算：它现在是「保留源码 + 就地装饰」，光标进得去，也不再有源码模式
    if (node.name === 'Image') return true;
    if (node.name === 'FencedCode') {
        return extractFencedCodeLanguage(node, state) === 'mermaid';
    }
    return false;
}


/**
 * 图片独占一行时，给这一行挂上居中装饰。
 *
 * 判断依据是源码：这一行「除了图片语法本身」没有别的可视文字。
 * 之所以不在 CSS 里用 `:has(> .cm-md-image-wrapper:only-child)`，
 * 是因为 CM6 会在行内 widget 前插一个 `cm-widgetBuffer` 占位元素，
 * `:only-child` 永远不成立，图片实际上一直是左对齐的（实测确认）。
 *
 * @param state - 当前编辑器状态
 * @param decos - 待写入的装饰数组
 * @param from - 图片语法起点（含宽度属性前后的完整范围起点）
 * @param to - 图片语法终点（宽度属性也算在内）
 */
export function addImageLineDecoration(
    state: EditorState,
    decos: Array<ReturnType<Decoration['range']>>,
    from: number,
    to: number
): void {
    const line = state.doc.lineAt(from);
    // 跨行的图片语法不处理，保持原样
    if (state.doc.lineAt(to).number !== line.number) return;
    // 行里还有别的文字（比如「文字 ![图](x.png) 文字」）时不居中，
    // 免得把普通段落整个推到中间
    if (line.text.trim() !== state.doc.sliceString(from, to).trim()) return;
    decos.push(imageLineDeco.range(line.from));
}
