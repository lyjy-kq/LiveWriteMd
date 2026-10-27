/**
 * Live Preview 装饰管线（从 plugin.ts 拆出）：语法树全树装饰：applyTreeDecorations 巨型函数整体搬迁（内部不切）+ 其专用树/折叠工具。
 *
 * @module webview/codemirror/extensions/livePreview/treeDecorations
 */

import { collectDetailsDecorations, isRenderableHtmlBlock } from './collectBlocks.js';
import { addImageLineDecoration, isWidgetBackedNode } from './collectInline.js';
import { HeadingAnchor, headingAnchorsOf } from './collectLinks.js';
import { collectListIndentDecorations } from './listIndentDecorations.js';
import { updateImageTitleInSource, updateImageWidthInSource, updateMermaidTitleInSource, updateMermaidWidthInSource } from './sourceWriteback.js';
import { matchHeadingIndex } from '../../../../shared/link/internalLink.js';
import { blockquoteLevelDecos, boldMarkDeco, codeMarkDeco, headingLineDecos, hideDeco, italicMarkDeco, strikethroughMarkDeco } from './decor/decorations.js';
import { isInlineRenderable, isWithinActiveInline } from './inline/focusMarks.js';
import { parseInlineImageTag } from './inline/inlineEngine.js';
import { collectMathSourceRanges } from './math/mathCollect.js';
import { createCodeBlockIndentStyle, getCodeBlockIndentInfo } from './measure/codeIndent.js';
import { extractFencedCodeContent, extractFencedCodeLanguage } from './measure/sourceParse.js';
import type { MeasureEnv } from './measure/textMeasure.js';
import { DEFAULT_MEDIA_WIDTH_PERCENT, measureTrailingWidthAttribute, parseMediaWidthPercent, splitTrailingWidthAttribute } from './mediaWidth.js';
import { isSetextBeforeFence } from './ranges.js';
import { foldedLinesOf, isForcedSourceRange, isInSourceMode, livePreviewDisplayOnly, sourceModeEffect } from './state.js';
import { collectTableDecorations } from './table/tableDecorations.js';
import { isTableLikeBlock } from './table/tableDetect.js';
import type { ILineRange } from './types.js';
import { HtmlBlockWidget } from './widgets/htmlBlockWidget.js';
import { ImageWidget, InlineHtmlImageWidget } from './widgets/mediaWidgets.js';
import { MermaidWidget } from './widgets/mermaidWidget.js';
import { BulletWidget, CheckboxWidget, CodeBlockCopyWidget, HorizontalRuleWidget } from './widgets/simpleWidgets.js';
import { indentUnit } from '@codemirror/language';
import { StateField } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import type { SyntaxNode, Tree } from '@lezer/common';


/**
 * 遍历适合做图片识别的文本块。
 *
 * 目前只扫描段落与标题，避免把 fenced code、inline code 等内容
 * 误识别为图片语法。
 *
 * @param state - 当前编辑器状态
 * @param focusedRange - 当前正在编辑的块范围
 * @param visit - 回调：接收块起点、终点和块文本
 */
export function treeLikeIterateTextBlocks(
    state: EditorState,
    focusedRange: ILineRange,
    tree: Tree,
    visit: (from: number, to: number, text: string) => void
): void {
    // (临时插桩误伤点已移除)
    tree.iterate({
        from: 0,
        to: state.doc.length,
        enter: (nodeRef): boolean | void => {
            const { from, to, name } = nodeRef;

            if (from < focusedRange.to && to > focusedRange.from) {
                return;
            }

            if (from >= to) {
                return;
            }

            if (
                name === 'Paragraph' ||
                name === 'ATXHeading1' ||
                name === 'ATXHeading2' ||
                name === 'ATXHeading3' ||
                name === 'ATXHeading4' ||
                name === 'ATXHeading5' ||
                name === 'ATXHeading6' ||
                name === 'SetextHeading1' ||
                name === 'SetextHeading2'
            ) {
                visit(from, to, state.doc.sliceString(from, to));
            }
        },
    });
}


// =============================================================================
// Live Preview Plugin
// =============================================================================

/**
 * 主遍历：把语法树上的各类节点变成装饰。
 *
 * 要跑两遍，所以抽成函数：
 *
 * - `mode = 'block'`：整篇跑，**只处理会产出 block 装饰的少数情况**
 *   （mermaid 整块替换、折叠列表把子行藏起来的块级替换）。CodeMirror 不允许
 *   ViewPlugin 产出 block 装饰，这些必须由 StateField 提供；而它们影响文档高度，
 *   又不能只算视口，否则滚到那儿高度会跳。
 * - `mode = 'inline'`：按**渲染窗口**跑，处理其余所有情况（行内标记、标题、引用、
 *   代码块外框、水平线……）。这些占绝大多数，都不影响块结构，可以只算视口。
 *
 * @param state - 编辑器状态
 * @param decos - 待写入的装饰数组
 * @param range - 这一遍要处理的范围（block 那遍是整篇，inline 那遍是窗口）
 * @param mode - 这一遍只处理 block 装饰，还是只处理非 block 的
 * @param tree - 语法树
 * @param focusedRange - 当前聚焦块（聚焦块里的块级标记要压 0 宽）
 * @param activeInlineNode - 光标所在的行内元素
 * @param taskMarkerPositions - 列表任务标记的位置集合（遍历时顺带填）
 */
/** 某个列表项/标题是不是折叠着（key 是它所在行的行首位置；实例隔离）。 */
export function isFoldedOf(state: EditorState, lineFrom: number): boolean {
    return foldedLinesOf(state).has(lineFrom);
}


/**
 * 标题章节折叠：返回该标题**章节内容结束**的文档位置。
 *
 * 章节从标题之后开始，到下一个「同级或更高级标题」（level ≤ 本标题）
 * 之前结束；找不到则到父节点（Document / Blockquote / ListItem…）末尾。
 *
 * @param heading - ATX 标题节点
 * @returns 章节结束位置（= 折叠块右端）
 */
export function headingSectionEnd(heading: SyntaxNode): number {
    const headingLevel = Number(
        heading.name.slice('ATXHeading'.length)
    );
    const parent = heading.parent;
    if (!parent) return heading.to;
    let cur = heading.nextSibling;
    while (cur) {
        const nm = cur.name ?? '';
        let boundaryLevel = 0;
        if (nm.startsWith('ATXHeading')) {
            boundaryLevel = Number(nm.slice('ATXHeading'.length));
        } else if (nm === 'SetextHeading1') {
            boundaryLevel = 1;
        } else if (nm === 'SetextHeading2') {
            boundaryLevel = 2;
        }
        if (boundaryLevel !== 0 && boundaryLevel <= headingLevel) {
            return cur.from;
        }
        cur = cur.nextSibling;
    }
    return parent.to;
}


/**
 * 数学公式源码里需要**屏蔽**的其他 Markdown 修饰节点。
 *
 * 公式文本对 lezer 是普通文本，`_`/`*`/`~~`/链接/反引号都会被照常解析；
 * 它们落在 collectMathSourceRanges 给出的公式区间内时一律不装饰
 * （见 applyTreeDecorations 开头的判断）。
 */
export const OTHER_MARKUP_NODES = new Set([
    // 强调：`*`、`_`（含标记节点本身，双保险 —— 跨公式边界的半配对
    // Emphasis 整体不在区间内时，区间内那个 EmphasisMark 仍要单独屏蔽）
    'Emphasis',
    'StrongEmphasis',
    'EmphasisMark',
    // 删除线
    'Strikethrough',
    'StrikethroughMark',
    // 链接（含 LinkMark 与 Autolink）
    'Link',
    'Autolink',
    'LinkMark',
    // 行内代码（反引号在公式源码里按原样字符处理）
    'InlineCode',
    'CodeMark',
]);


export function applyTreeDecorations(
    state: EditorState,
    decos: Array<ReturnType<Decoration['range']>>,
    range: ILineRange,
    mode: 'block' | 'inline',
    tree: Tree,
    focusedRange: ILineRange,
    activeInlineNode: SyntaxNode | null,
    taskMarkerPositions: Set<number>,
    /**
     * 量圆点宽度用的字体环境（窗口遍由 ViewPlugin 传入当前视图的正文样式）。
     * block 遍在 EditorState.create 阶段跑、拿不到视图，传 null 走全局口径。
     */
    env: MeasureEnv | null = null
): void {
    // 本范围内所有公式源码区间：下面 enter 用它屏蔽其他修饰。
    // 两遍（block 整篇 / inline 窗口）各算一次，与 range 对齐。
    const mathSourceRanges = collectMathSourceRanges(state, range);

    // 内链断链判定用的标题锚点：懒算，只在真的遇到 `#` 内链时才遍历一次树
    // （断链判定需要全文档标题；导图节点的 mini-CM 是节点级小文档，见
    // state.ts 的 livePreviewDisplayOnly，那边直接跳过判定、不做灰显）
    const displayOnly = state.facet(livePreviewDisplayOnly);
    let headingAnchors: HeadingAnchor[] | null = null;
    const internalLinkBroken = (target: string): boolean => {
        if (displayOnly) return false;
        headingAnchors ??= headingAnchorsOf(state, tree);
        return (
            matchHeadingIndex(
                headingAnchors.map((a) => a.text),
                target
            ) < 0
        );
    };

    tree.iterate({
        from: range.from,
        to: range.to,
        enter: (nodeRef): boolean | void => {
            const { from, to, name } = nodeRef;

            // Document node spans everything - always process children
            if (name === 'Document') return;

            // 公式源码区间内的其他修饰节点一律不处理（连同子节点一起跳过）。
            // 公式里的 `_`（下标）、`*` 是数学记号：被 hideDeco 替换后文本模式下
            // `x*y` 会直接变成 `xy`、被上 italic 样式后源码也不再是原文。
            // 判定用「节点整体在区间内」；跨边界的半配对由 EmphasisMark 单条兜底。
            if (
                OTHER_MARKUP_NODES.has(name) &&
                mathSourceRanges.some((r) => from >= r.from && to <= r.to)
            ) {
                return false;
            }

            // block 那一遍只处理「会产出 block 装饰」的情况，其余一律下探不处理。
            if (mode === 'block') {
                const isMermaidFence =
                    name === 'FencedCode' &&
                    extractFencedCodeLanguage(nodeRef.node, state) === 'mermaid';
                const isFoldedItem =
                    name === 'ListItem' &&
                    foldedLinesOf(state).has(state.doc.lineAt(from).from);
                // 折叠的标题章节：需要在 ATXHeading 节点产出块隐藏
                const isFoldedHeading =
                    name.startsWith('ATXHeading') &&
                    foldedLinesOf(state).has(state.doc.lineAt(from).from);
                // 缩进式代码块：要在 CodeBlock 节点铺 rainbow indent
                const isIndentedCodeBlock = name === 'CodeBlock';
                // HTML 块：整块替换成渲染结果（居中段落 / 徽章图片行）。
                // 块级 replace 只能从 StateField 这一遍产出，所以必须放行到这里。
                const isHtmlBlock = name === 'HTMLBlock';
                if (
                    !isMermaidFence &&
                    !isFoldedItem &&
                    !isFoldedHeading &&
                    !isIndentedCodeBlock &&
                    !isHtmlBlock
                )
                    return;
            }

            // 与聚焦块重叠的节点：默认按「显示源码」处理，直接跳过。
            //
            // 两种「让开」的规矩不一样，按选区空不空来分：
            //
            // - **光标（空选区）**：行内格式照旧渲染（标记隐藏、内容上样式），只有光标
            //   所在的那一个元素展开成源码（见 focusMarks.ts）。否则在正文里点一下，
            //   整行的加粗、行内代码全变回源码，看着像文件坏了。
            // - **拖选（非空选区）**：选中的文字一律变回纯文本 —— 行内格式也不例外，
            //   这是「选中即文本模式」的规则（表格除外，见下面的 keepWidgetRendered：
            //   表格散架了就没法选格子里的字了，但格子**里**的行内格式照样变源码）。
            //
            // 双击进过源码模式的块，不管光标在不在里面，都摊开成源码渲染。
            // （它自己的单击/双击逻辑见 widgets.ts 里的 sourceModeEffect）
            if (isWidgetBackedNode(nodeRef.node, state) && isInSourceMode(state, from, to)) {
                return;
            }

            // 表格进了源码模式：整块按源码显示，里面的行内元素一个都不处理
            // （不然加粗、公式还是渲染态，看着不像源码）
            if (name === 'Table' && isInSourceMode(state, from, to)) {
                return false;
            }

            if (from < focusedRange.to && to > focusedRange.from) {
                // 落在行级强制区间（mousedown 待选 / 双击钉住）时，即使是空选区
                // 也不许走渲染态：整行必须是源码，坐标和长度才能稳定
                const canRenderInFocus =
                    state.selection.main.empty &&
                    !isForcedSourceRange(state, from, to) &&
                    isInlineRenderable(nodeRef.node) &&
                    !isWithinActiveInline(nodeRef.node, activeInlineNode);
                // 表格 / 图片 / Mermaid：单击保持渲染态，只有双击进源码模式才显示原文
                const keepWidgetRendered = isWidgetBackedNode(nodeRef.node, state);
                if (!canRenderInFocus && !keepWidgetRendered) {
                    // 例外：折叠态的 ListItem / ATXHeading 需要在
                    // block 遍产出章节隐藏，不能被焦点跳过；CodeBlock
                    // 要铺 rainbow indent，同样不能因聚焦在块上而被跳过。
                    const isFoldedItemNode =
                        name === 'ListItem' &&
                        isFoldedOf(state, state.doc.lineAt(from).from);
                    const isFoldedHeadingNode =
                        name.startsWith('ATXHeading') &&
                        isFoldedOf(state, state.doc.lineAt(from).from);
                    if (
                        !isFoldedItemNode &&
                        !isFoldedHeadingNode
                    )
                        return;
                }
            }

            // Skip empty ranges
            if (from >= to) return;

            switch (name) {
                // === HIDE MARKERS ===

                case 'HeaderMark': {
                    // Setext 标题的下划线（`---` / `===`）也是一个 HeaderMark。
                    const parent = nodeRef.node.parent;
                    if (parent && parent.name.startsWith('SetextHeading')) {
                        // 如果这一块其实是「表格 + 分隔线」，那条线交给 tableRender 按水平线画，
                        // 这里不能再把它压 0 宽（否则那一行会整行消失）
                        if (isTableLikeBlock(state, parent.from, parent.to)) break;
                        // 下划线后面紧跟着围栏的（正文、`---`、``` 三行紧挨）同理：
                        // 这块不按标题渲染，这条线就照正文里的 `---` 一样画成一条水平线。
                        // 压 0 宽的话整行都会没掉 —— 那正是「这一行不见了」。
                        if (isSetextBeforeFence(state, parent.from, parent.to)) {
                            decos.push(
                                Decoration.replace({
                                    widget: new HorizontalRuleWidget(),
                                }).range(from, to)
                            );
                            break;
                        }
                    }
                    // Hide # marks and trailing space（折叠交互在 lineNumber 位置）
                    const after = state.doc.sliceString(to, to + 1);
                    const hideEnd = after === ' ' ? to + 1 : to;
                    decos.push(hideDeco.range(from, hideEnd));
                    break;
                }

                case 'EmphasisMark':
                case 'StrikethroughMark':
                case 'CodeMark':
                case 'CodeInfo': {
                    decos.push(hideDeco.range(from, to));
                    break;
                }

                case 'QuoteMark': {
                    // Hide > mark and trailing space
                    const after = state.doc.sliceString(to, to + 1);
                    const hideEnd = after === ' ' ? to + 1 : to;
                    decos.push(hideDeco.range(from, hideEnd));
                    break;
                }

                case 'ListMark': {
                    const text = state.doc.sliceString(from, to);
                    const after = state.doc.sliceString(to, to + 1);
                    const hideEnd = after === ' ' ? to + 1 : to;

                    // Unordered list markers → bullet widget
                    if (text === '-' || text === '*' || text === '+') {
                        // TaskMarker 包在 Task 节点里（非 ListItem 直接子节点）
                        const itemNode = nodeRef.node.parent;
                        const isTask = !!itemNode?.getChild('Task');
                        if (isTask) {
                            // 任务项：圆点冗余，把 "- " 整段隐藏，复选框顶到该列
                            decos.push(hideDeco.range(from, hideEnd));
                        } else {
                            decos.push(
                                Decoration.replace({
                                    // 圆点盒宽按「当前视图」的字体量：导图节点的
                                    // mini-CM 与主编辑器是两套独立字体环境，
                                    // 用错会让进编辑态时正文横跳（见 helpers.MeasureEnv）
                                    widget: new BulletWidget(text, env),
                                }).range(from, hideEnd)
                            );
                        }
                    }
                    // 有序 marker：序号可见，但统一染成深灰（与 # / - 一致）
                    else {
                        decos.push(
                            Decoration.mark({
                                class: 'cm-md-ordmark',
                            }).range(from, to)
                        );
                    }
                    break;
                }

                case 'TaskMarker': {
                    const markerText = state.doc.sliceString(from, to);
                    const checked = markerText === '[x]' || markerText === '[X]';
                    const afterChar = state.doc.sliceString(to, to + 1);
                    const replaceEnd = afterChar === ' ' ? to + 1 : to;
                    taskMarkerPositions.add(from);
                    decos.push(
                        Decoration.replace({
                            widget: new CheckboxWidget(checked, from),
                        }).range(from, replaceEnd)
                    );
                    break;
                }

                // === LINE-LEVEL DECORATIONS ===

                case 'ATXHeading1':
                case 'ATXHeading2':
                case 'ATXHeading3':
                case 'ATXHeading4':
                case 'ATXHeading5':
                case 'ATXHeading6': {
                    const level = parseInt(name.replace('ATXHeading', ''));
                    const headingLine = state.doc.lineAt(from);
                    decos.push(headingLineDecos[level].range(headingLine.from));
                    // 折叠态：行矩形左缘挂「两角铠甲」角花类（样式见 styles.ts
                    // 的 .cm-md-fold-armor）。只在 inline 遍加，block 遍只负责章节隐藏
                    if (
                        mode === 'inline' &&
                        foldedLinesOf(state).has(headingLine.from)
                    ) {
                        decos.push(
                            Decoration.line({
                                class: 'cm-md-fold-armor',
                            }).range(headingLine.from)
                        );
                    }
                    // 折叠态：章节内容整块藏掉（block 遍到达这里时产出）。
                    //
                    // 范围必须严格按「整行」取：首行隐藏行的行首 → 末行隐藏行
                    // 的行尾。旧写法起点是标题行尾、终点是下一标题行首
                    // (sectionEnd)，CodeMirror 会把 block widget 与端点相邻的
                    // 行块融合 —— 实测下一同级标题会丢掉行号格与标题行装饰，
                    // 只剩普通文字。sectionEnd 是下一标题行首，-1 即末隐藏行尾。
                    if (mode === 'block') {
                        const sectionEnd = headingSectionEnd(nodeRef.node);
                        const hideFrom = headingLine.to + 1;
                        const hideTo = sectionEnd - 1;
                        if (hideFrom <= hideTo) {
                            decos.push(
                                Decoration.replace({ block: true }).range(
                                    hideFrom,
                                    hideTo
                                )
                            );
                        }
                    }
                    break;
                }

                case 'SetextHeading1':
                case 'SetextHeading2': {
                    // 形状是表格的（表格后面紧跟一条 ---，被解析成了 Setext 标题）：
                    // 让给表格渲染。不能按标题涂样式，更不能把那条 --- 当行下划线藏起来
                    // ——那正是「第 44 行不见了」的原因。
                    if (isTableLikeBlock(state, from, to)) break;
                    // 下划线后面紧跟着围栏（正文、---、``` 三行紧挨）同理：这块不是标题，
                    // 不涂标题样式、也不折叠那条下划线（折叠 = 整行消失）。
                    // 那条下划线本身由下面的 HeaderMark 分支画成水平线。
                    if (isSetextBeforeFence(state, from, to)) break;
                    const level = name === 'SetextHeading1' ? 1 : 2;
                    const contentLine = state.doc.lineAt(from);
                    decos.push(headingLineDecos[level].range(contentLine.from));

                    // Collapse the underline line visually (=== or ---)
                    const endLine = state.doc.lineAt(to);
                    if (endLine.number > contentLine.number) {
                        decos.push(
                            Decoration.line({ class: 'cm-md-setext-underline' }).range(endLine.from)
                        );
                    }
                    break;
                }

                case 'Blockquote': {
                    // Only process outermost Blockquote to avoid duplicate line decos
                    if (nodeRef.node.parent?.name === 'Blockquote') break;

                    const startLine = state.doc.lineAt(from);
                    const endLine = state.doc.lineAt(to);
                    for (let ln = startLine.number; ln <= endLine.number; ln++) {
                        const line = state.doc.line(ln);
                        if (line.text.trim() === '') continue;
                        // Count > marks to determine nesting level
                        const gtMatches = line.text.match(/^(\s*>)+/);
                        const level = gtMatches ? (gtMatches[0].match(/>/g) || []).length : 1;
                        const idx = Math.min(level, 5) - 1;
                        decos.push(blockquoteLevelDecos[idx].range(line.from));
                    }
                    break;
                }

                case 'ListItem': {
                    const itemLine = state.doc.lineAt(from);
                    // 缩进引导线不在这里加：它必须「渲染态和编辑态长得一样」，
                    // 而这里的遍历会把聚焦块整块跳过。统一挪到
                    // collectListIndentDecorations，那边按行扫全文，两种状态下都在。

                    // Check if this list item has child list (sub-items)
                    const syntaxNode = nodeRef.node;
                    const hasChildList = !!(
                        syntaxNode.getChild('BulletList') ||
                        syntaxNode.getChild('OrderedList')
                    );
                    if (hasChildList) {
                        const isFolded = isFoldedOf(state, itemLine.from);
                        if (isFolded) {
                            if (mode === 'inline') {
                                // 行矩形左缘挂「两角铠甲」角花类（见 styles.ts）
                                decos.push(
                                    Decoration.line({
                                        class: 'cm-md-fold-armor',
                                    }).range(itemLine.from)
                                );
                            }
                            // 折叠态：行首 ListMark（"- " / "1. "）整段隐藏。
                            // 折叠箭头只在行号位（gutter）显示，正文不再画 chevron。
                            const listMark = syntaxNode.getChild('ListMark');
                            if (listMark) {
                                const afterChar = state.doc.sliceString(
                                    listMark.to,
                                    listMark.to + 1
                                );
                                const hideEnd =
                                    afterChar === ' ' ? listMark.to + 1 : listMark.to;
                                decos.push(hideDeco.range(listMark.from, hideEnd));
                            }
                            // Hide child lines：块级替换，只由 block 那一遍产出。
                            // 起点取首个子行的行首 (itemLine.to + 1)，与标题
                            // 折叠同口径：范围严格覆盖整行，避免 widget 与相邻
                            // 行块融合、下一同级项丢行号 / 行装饰
                            if (mode === 'block') {
                                const endLine = state.doc.lineAt(to);
                                const hideFrom = itemLine.to + 1;
                                if (hideFrom <= endLine.to) {
                                    decos.push(
                                        Decoration.replace({ block: true }).range(
                                            hideFrom,
                                            endLine.to
                                        )
                                    );
                                }
                            }
                            return false; // Skip children（两遍都跳，子行不装饰）
                        }
                    }
                    break;
                }

                case 'Table': {
                    // 表格不再是替换 widget：格子骨架（管道线压 0 宽、单元格定宽、
                    // 分隔行折叠）由 collectTableDecorations 按行处理，格子里的行内元素
                    // 由下面的 StrongEmphasis / Emphasis / InlineCode 等分支照常渲染。
                    // 这里直接下探子节点，让单元格里的行内节点都能被处理到。
                    return;
                }

                case 'FencedCode': {
                    const syntaxNode = nodeRef.node;
                    const language = extractFencedCodeLanguage(syntaxNode, state);
                    // mermaid 是整块替换（block 装饰）：只由 block 那一遍产出。
                    // 这一遍直接跳过整棵子树，否则同一个代码块会被替换两次、撞在一起。
                    if (language === 'mermaid' && mode === 'inline') return false;
                    if (language === 'mermaid') {
                        const content = extractFencedCodeContent(syntaxNode, state);
                        if (content) {
                            const firstLine = state.doc.lineAt(from);
                            const endLine = state.doc.lineAt(to);
                            const codeInfoNode = syntaxNode.getChild('CodeInfo');
                            const codeInfoFrom = codeInfoNode ? codeInfoNode.from : firstLine.from + 3;
                            // info 行形如 `mermaid 标题 {width=50%}`，宽度属性也在这里读。
                            const widthPercent =
                                parseMediaWidthPercent(
                                    state.doc.sliceString(codeInfoFrom, firstLine.to)
                                ) ?? DEFAULT_MEDIA_WIDTH_PERCENT;
                            decos.push(
                                Decoration.replace({
                                    widget: new MermaidWidget(
                                        content,
                                        state.facet(EditorView.darkTheme),
                                        firstLine.from,
                                        endLine.to,
                                        (widgetView: EditorView, nextTitle: string) => {
                                            updateMermaidTitleInSource(
                                                widgetView,
                                                codeInfoFrom,
                                                firstLine.to,
                                                nextTitle
                                            );
                                        },
                                        widthPercent,
                                        (widgetView: EditorView, nextPercent: number) => {
                                            updateMermaidWidthInSource(
                                                widgetView,
                                                codeInfoFrom,
                                                firstLine.to,
                                                nextPercent
                                            );
                                        }
                                    ),
                                    block: true,
                                }).range(firstLine.from, endLine.to)
                            );
                            return false;
                        }
                    }

                    // 普通代码块只保留边框、语言按钮和缩进导引线。
                    {
                        const startLine = state.doc.lineAt(from);
                        const endLine = state.doc.lineAt(to);
                        for (let ln = startLine.number; ln <= endLine.number; ln++) {
                            const line = state.doc.line(ln);
                            const classes = ['cm-md-codeblock'];
                            const attributes: Record<string, string> = {};
                            if (ln === startLine.number) {
                                classes.push('cm-md-codeblock-first');
                            }
                            if (ln === endLine.number) {
                                classes.push('cm-md-codeblock-last');
                            }
                            if (ln > startLine.number && ln < endLine.number) {
                                // Rainbow indent：行首空白的视觉列数（Tab 按
                                // state.tabSize 的 tab-stop 算），样式函数据此
                                // 把色带精确停在文字前。首/末行是围栏 ``` 行，不铺。
                                const indentColumns = getCodeBlockIndentInfo(
                                    line.text,
                                    state.tabSize
                                ).columns;
                                // 一个缩进单位占几列：默认 indentUnit = 2 空格，
                                // 色带按它轮换（每按一次 Tab 换一种颜色）。
                                // indentUnit 允许配成 Tab，那时一个单位宽 = tabSize。
                                const unitText = state.facet(indentUnit);
                                const indentUnitColumns =
                                    unitText.charCodeAt(0) === 9
                                        ? state.tabSize * unitText.length
                                        : unitText.length;
                                classes.push('cm-md-codeblock-indent');
                                attributes.style = createCodeBlockIndentStyle(
                                    indentColumns,
                                    indentUnitColumns
                                );
                            }
                            decos.push(
                                Decoration.line({
                                    class: classes.join(' '),
                                    attributes,
                                }).range(line.from)
                            );
                        }
                        const codeContent = extractFencedCodeContent(nodeRef.node, state);
                        if (codeContent !== null) {
                            decos.push(
                                Decoration.widget({
                                    widget: new CodeBlockCopyWidget(codeContent, language),
                                    side: 1,
                                }).range(startLine.to)
                            );
                        }
                    }
                    break;
                }

                // === INLINE STYLING ===

                case 'StrongEmphasis': {
                    const syntaxNode = nodeRef.node;
                    const marks = syntaxNode.getChildren('EmphasisMark');
                    if (marks.length >= 2) {
                        const contentFrom = marks[0].to;
                        const contentTo = marks[marks.length - 1].from;
                        if (contentFrom < contentTo) {
                            decos.push(boldMarkDeco.range(contentFrom, contentTo));
                        }
                    }
                    break;
                }

                case 'Emphasis': {
                    const syntaxNode = nodeRef.node;
                    const marks = syntaxNode.getChildren('EmphasisMark');
                    if (marks.length >= 2) {
                        const contentFrom = marks[0].to;
                        const contentTo = marks[marks.length - 1].from;
                        if (contentFrom < contentTo) {
                            decos.push(italicMarkDeco.range(contentFrom, contentTo));
                        }
                    }
                    break;
                }

                case 'Strikethrough': {
                    const syntaxNode = nodeRef.node;
                    const marks = syntaxNode.getChildren('StrikethroughMark');
                    if (marks.length >= 2) {
                        const contentFrom = marks[0].to;
                        const contentTo = marks[marks.length - 1].from;
                        if (contentFrom < contentTo) {
                            decos.push(strikethroughMarkDeco.range(contentFrom, contentTo));
                        }
                    }
                    break;
                }

                case 'InlineCode': {
                    const syntaxNode = nodeRef.node;
                    const marks = syntaxNode.getChildren('CodeMark');
                    if (marks.length >= 2) {
                        const contentFrom = marks[0].to;
                        const contentTo = marks[marks.length - 1].from;
                        if (contentFrom < contentTo) {
                            decos.push(codeMarkDeco.range(contentFrom, contentTo));
                        }
                    }
                    break;
                }

                case 'Link': {
                    const linkNode = nodeRef.node;

                    const marks = linkNode.getChildren('LinkMark');

                    // 只支持内联链接 `[text](url)`：带着 `[` `]` `(` `)`
                    // 共 4 个 LinkMark。只有 2 个的 `[i]` 是普通字面文本
                    // （数组下标），不藏括号、不加链接类。
                    if (marks.length < 4) return false;
                    // 链接文本区间 = `[` 之后、`]` 之前
                    const textFrom = marks[0].to;
                    const textTo = marks[1].from;
                    const urlNode = linkNode.getChild('URL');
                    // 空链接 `[text]()` 没有 URL 子节点，targetUrl 保持空串
                    const rawUrl = urlNode
                        ? state.doc.sliceString(urlNode.from, urlNode.to)
                        : '';
                    // `<...>` 包裹的目标（CommonMark 里允许带空格的写法）：
                    // 尖括号只是语法，跳转 / data-href 都用内部文字
                    const targetUrl =
                        rawUrl.startsWith('<') && rawUrl.endsWith('>')
                            ? rawUrl.slice(1, -1)
                            : rawUrl;

                    // 藏掉 `[` `]` `(` `)` 四个标记字符
                    marks.forEach((mark) => {
                        decos.push(hideDeco.range(mark.from, mark.to));
                    });
                    // 藏掉括号里的网址文本本身。
                    // 只藏括号字符不藏 URL 的话，网址会原样露在链接文字后面。
                    if (urlNode) {
                        decos.push(hideDeco.range(urlNode.from, urlNode.to));
                    }

                    // 链接文字恰好是一个行内 <img>（README 海报墙的写法：
                    // `[<img src="preview-01.jpg" width="170">](poster-01.png)`）。
                    // 把标签源码换成图片 widget；链接类与 data-href 直接交给
                    // widget（见 InlineHtmlImageWidget），这里不再加 mark ——
                    // replace 与 mark 完全同区间时，嵌套关系不由我们控制。
                    const inlineImage = parseInlineImageTag(
                        state.doc.sliceString(textFrom, textTo)
                    );
                    if (inlineImage) {
                        decos.push(
                            Decoration.replace({
                                widget: new InlineHtmlImageWidget(inlineImage, targetUrl),
                            }).range(textFrom, textTo)
                        );
                        return false;
                    }

                    if (textFrom < textTo) {
                        // 空链接不加 data-href：有链接样式但点不开
                        const attrs: Record<string, string> = {};
                        let cls = 'cm-md-link';
                        if (targetUrl.startsWith('#')) {
                            // 内链（文档内标题跳转）：虚线下划线与外链区分；
                            // 断链（目标标题不存在）换灰皮、不给 data-href ——
                            // 点击退回普通文本行为，方便用户原地修正
                            cls += ' cm-md-link-internal';
                            const target = targetUrl.slice(1);
                            if (internalLinkBroken(target)) {
                                cls += ' cm-md-link-broken';
                                attrs['title'] = `未找到标题：${target}`;
                            } else {
                                attrs['data-href'] = targetUrl;
                                attrs['title'] = `${target}（点击跳转）`;
                            }
                        } else if (targetUrl) {
                            attrs['data-href'] = targetUrl;
                            attrs['title'] = `${targetUrl} (Ctrl+Click to open)`;
                        }
                        decos.push(
                            Decoration.mark({
                                class: cls,
                                attributes: attrs,
                            }).range(textFrom, textTo)
                        );
                    }
                    return false;
                }

                case 'Autolink': {
                    const autoNode = nodeRef.node;
                    const autoUrlChild = autoNode.getChild('URL');
                    if (autoUrlChild) {
                        const autoUrl = state.doc.sliceString(autoUrlChild.from, autoUrlChild.to);
                        const autoMarks = autoNode.getChildren('LinkMark');
                        for (const mark of autoMarks) {
                            decos.push(hideDeco.range(mark.from, mark.to));
                        }
                        decos.push(
                            Decoration.mark({
                                class: 'cm-md-link',
                                attributes: {
                                    'data-href': autoUrl,
                                    title: `${autoUrl} (Ctrl+Click to open)`,
                                },
                            }).range(autoUrlChild.from, autoUrlChild.to)
                        );
                    }
                    return false;
                }

                case 'URL': {
                    // 内联链接的地址子节点：渲染态已在 Link 分支处理，
                    // 聚焦行时它以源码文字显示——都不走这里的裸网址渲染，
                    // 否则聚焦时括号里的网址会被涂成绿色链接样式
                    if (nodeRef.node.parent?.name === 'Link') break;
                    const bareUrl = state.doc.sliceString(from, to);
                    if (bareUrl.startsWith('http://') || bareUrl.startsWith('https://')) {
                        decos.push(
                            Decoration.mark({
                                class: 'cm-md-link',
                                attributes: {
                                    'data-href': bareUrl,
                                    title: `${bareUrl} (Ctrl+Click to open)`,
                                },
                            }).range(from, to)
                        );
                    }
                    break;
                }

                case 'Image': {
                    const syntaxNode = nodeRef.node;
                    const imgUrlNode = syntaxNode.getChild('URL');
                    const imgUrl = imgUrlNode
                        ? state.doc.sliceString(imgUrlNode.from, imgUrlNode.to)
                        : '';
                    // 宽度属性挂在 Image 节点之外，decoration 要往后多圈一段，
                    // 否则 `{width=50%}` 会以字面量形式留在图片旁边。
                    const imageTo =
                        to +
                        measureTrailingWidthAttribute(
                            state.doc.sliceString(to, Math.min(to + 32, state.doc.length))
                        );
                    const rawImageText = state.doc.sliceString(from, imageTo);
                    // 标题编辑只认 `![alt](url)`，比较时先去掉宽度属性。
                    const imgText = splitTrailingWidthAttribute(rawImageText).base;
                    const altMatch = imgText.match(/!\[([^\]]*)\]/);
                    const altText = altMatch ? altMatch[1] : '';
                    const widthPercent =
                        parseMediaWidthPercent(rawImageText) ?? DEFAULT_MEDIA_WIDTH_PERCENT;

                    if (imgUrl || altText) {
                        addImageLineDecoration(state, decos, from, imageTo);
                        decos.push(
                            Decoration.replace({
                                widget: new ImageWidget(
                                    imgUrl,
                                    altText,
                                    from,
                                    imageTo,
                                    (widgetView: EditorView, nextTitle: string) => {
                                        updateImageTitleInSource(
                                            widgetView,
                                            from,
                                            imageTo,
                                            rawImageText,
                                            nextTitle
                                        );
                                    },
                                    widthPercent,
                                    (widgetView: EditorView, nextPercent: number) => {
                                        updateImageWidthInSource(
                                            widgetView,
                                            from,
                                            imageTo,
                                            rawImageText,
                                            nextPercent
                                        );
                                    }
                                ),
                            }).range(from, imageTo)
                        );
                    }
                    return false;
                }

                case 'HorizontalRule': {
                    decos.push(
                        Decoration.replace({
                            widget: new HorizontalRuleWidget(),
                        }).range(from, to)
                    );
                    break;
                }

                case 'HTMLBlock': {
                    // 块级替换只能从 block 那一遍（StateField）产出；
                    // 窗口遍再产一次会因为 block 装饰来源不合法而报错。
                    if (mode !== 'block') break;
                    const rawHtml = state.doc.sliceString(from, to);
                    // <details> 走 collectDetailsDecorations 的折叠 widget；
                    // 纯注释 / script 等保持源码。
                    if (!isRenderableHtmlBlock(rawHtml)) break;
                    // replace 的区间必须是整行（块级 replace 的硬性要求），
                    // HTMLBlock 节点本身通常不含行尾换行，这里按行对齐。
                    const htmlStartLine = state.doc.lineAt(from);
                    const htmlEndLine = state.doc.lineAt(Math.max(from, to - 1));
                    decos.push(
                        Decoration.replace({
                            widget: new HtmlBlockWidget(rawHtml),
                            block: true,
                        }).range(htmlStartLine.from, htmlEndLine.to)
                    );
                    break;
                }

                case 'HTMLTag': {
                    // 行内 <img>：表格格子里的海报缩略图，以及正文里零散写的
                    // <img src=... width=...>。只替换真正的 img 标签，其它
                    // 行内 HTML（<b>、<span>…）保持源码，不在这里扩大支持面。
                    // 链接里的 img 由上面的 Link 分支处理并提前 return，
                    // 不会走到这里重复替换。
                    if (mode === 'block') break;
                    const rawTag = state.doc.sliceString(from, to);
                    const inlineImage = parseInlineImageTag(rawTag);
                    if (!inlineImage) break;
                    decos.push(
                        Decoration.replace({
                            widget: new InlineHtmlImageWidget(inlineImage),
                        }).range(from, to)
                    );
                    break;
                }
            }
        },
    });
}
