/**
 * Live Preview Plugin
 *
 * Core ViewPlugin for Obsidian-style live preview.
 * Manages decorations: hides Markdown markers in non-focused blocks
 * and renders widgets (tables, math, mermaid, etc.).
 *
 * @module webview/codemirror/extensions/livePreview/plugin
 */

import { ensureSyntaxTree, indentUnit, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, type Transaction, RangeSet, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';
import type { SyntaxNode, Tree } from '@lezer/common';
import { findFileLinkAtText, findFileLinkMatches } from '../../../../shared/link/fileLink.js';
import { matchHeadingIndex } from '../../../../shared/link/internalLink.js';
// 列表引导线横坐标要读「正文与行号线距离」设置（lineGutterGap）
import { settingsState } from '../../../settings/settingsState.js';

import {
    blockquoteLevelDecos,
    boldMarkDeco,
    codeMarkDeco,
    footnoteDefLineDeco,
    headingLineDecos,
    hideDeco,
    imageLineDeco,
    italicMarkDeco,
    hiddenSourceDeco,
    strikethroughMarkDeco,
} from './decor/decorations.js';
import { ensureTokenColorCss, liveWriteMdTokenHighlight } from './decor/tokenColors.js';
import { createCodeBlockIndentStyle, getCodeBlockIndentInfo } from './measure/codeIndent.js';
import { createListIndentStyle, detectIndentUnit, parseListMarkerLine, measureWhitespacePx, measureBaselineInset, measureIndentUnitPx } from './measure/listIndent.js';
import type { IndentGuide, ListMarkerInfo } from './measure/listIndent.js';
import { extractFencedCodeContent, extractFencedCodeLanguage, extractSafeFontStyles, splitMarkdownImageDestination } from './measure/sourceParse.js';
import { measureEnvFromElement, measureTextIn } from './measure/textMeasure.js';
import type { MeasureEnv } from './measure/textMeasure.js';
import {
    collectFocusDecorations,
    computeFocusSignature,
    findActiveInlineNode,
    isInlineRenderable,
    isWithinActiveInline,
} from './inline/focusMarks.js';
import {
    DEFAULT_MEDIA_WIDTH_PERCENT,
    formatMediaWidthAttribute,
    measureTrailingWidthAttribute,
    parseMediaWidthPercent,
    splitTrailingWidthAttribute,
} from './mediaWidth.js';
import {
    getSourceRange,
    isSetextBeforeFence,
    overlaps,
    renderRange,
    windowLines,
} from './ranges.js';
import {
    collectCodeSpanMathDecorations,
    collectMathDecorations,
    collectMathSourceRanges,
} from './math/mathCollect.js';
import { scrollPreserverExtension } from './interaction/scrollHack.js';
import { tableCellSelection } from './table/tableCellSelection.js';
import { collectTableDecorations } from './table/tableDecorations.js';
import { isTableLikeBlock } from './table/tableDetect.js';
import { isInTableCell, tableCompositionHandler, tablePipeEscaper, tableSourceModeHandler } from './table/tableLocate.js';
import { hasUnmeasuredTables, tableResizePlugin } from './table/tableWiring.js';
import { autoPairBrackets } from './inline/autoPair.js';
import {
    exitPinnedForceIfOutside,
    exitSourceModeIfOutside,
    foldToggleEffect,
    foldedLinesOf,
    isForcedSourceRange,
    isInSourceMode,
    lineForceEffect,
    livePreviewDisplayOnly,
    livePreviewInstanceField,
    mapForceRanges,
    patchLineForce,
    setSourceModeRange,
    sourceModeEffect,
    tableRemeasureEffect,
} from './state.js';
import { lineForcePlugin, nativeAnchoredMouseSelection } from './interaction/lineForce.js';
import { tableHoverControls } from './table/tableHoverControls.js';
import { createBaseThemeStyles } from './decor/styles.js';
import type { ILineRange } from './types.js';
import { HtmlBlockWidget } from './widgets/htmlBlockWidget.js';
import { ImageWidget, InlineHtmlImageWidget } from './widgets/mediaWidgets.js';
import { MermaidWidget } from './widgets/mermaidWidget.js';
import { BulletWidget, CheckboxWidget, CodeBlockCopyWidget, DetailsWidget, FootnoteDefWidget, FootnoteRefWidget, HorizontalRuleWidget, FontTextWidget } from './widgets/simpleWidgets.js';
import { collectDetailsDecorations, collectFootnoteDecorations } from './collectBlocks.js';
import { collectCheckboxDecorations, collectHeadingFontDecorations, collectImageDecorations } from './collectInline.js';
import { anchorFlashClearEffect, anchorFlashEffect, anchorFlashField, collectFileLinkDecorations, collectSpacedFileLinkDecorations, collectWikiInternalLinkDecorations, findHeadingPos } from './collectLinks.js';
import { collectListIndentDecorations } from './listIndentDecorations.js';
import { applyTreeDecorations } from './treeDecorations.js';
import { parseInlineImageTag } from './inline/inlineEngine.js';

































/**
 * The Live Preview ViewPlugin.
 *
 * Manages decorations for Obsidian-style live preview.
 * Hides Markdown markers and applies styling in non-focused blocks.
 * Shows raw Markdown source in the focused block.
 */
function buildBlockDecorations(state: EditorState): DecorationSet {
    const decos: Array<ReturnType<Decoration['range']>> = [];
    // 这部分必须整篇算：block 装饰由 StateField 提供，而 StateField 看不到视口
    const range: ILineRange = { from: 0, to: state.doc.length };
    // 源码区间：空选区看光标所在的块，有选区就看选区覆盖的那几行（见 ranges.ts）。
    // 以前拖选时是「沿用上一次光标所在的块」，于是选中的那几行还是渲染态，
    // 用户看不到自己选的是什么；现在选中即源码。
    const focusedRange = getSourceRange(state);
    // Try to get a fully parsed tree within a short budget.
    // If parsing isn't done yet, fall back to the current incremental tree;
    // treeChanged detection in update() will trigger a rebuild with the complete tree.
    const tree = ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
    const taskMarkerPositions = new Set<number>();
    // 光标所在的行内元素（加粗/斜体/行内代码）——它会被 focusMarks 展开成源码，
    // 同一行里其它行内元素照常渲染，这样点一下不会让整行都变样。
    const activeInlineNode = findActiveInlineNode(state, tree);
    // 表格 / 图片 / Mermaid 的源码模式：光标点去别处就自动退出。
    // 必须在下面的树遍历之前清掉，否则这一轮还会按「源码模式」渲染。
    exitSourceModeIfOutside(state, state.selection.main.from, state.selection.main.to);

    // front matter（YAML 头）在 live 模式按普通文本显示，不再渲染元数据卡片；
    // parseFrontmatter / FrontmatterWidget 保留在 helpers.ts / widgets.ts，
    // 供导图的元数据节点复用（todo.md 任务 5 / 14）。


    // 会产出 **block 装饰** 的收集器只能待在这里（CM6 不允许 ViewPlugin 产出 block 装饰）：
    // 公式的多行 `$$`、`<details>`、表格下面那条加行条，都是块级 replace / 块级 widget。
    const full: ILineRange = { from: 0, to: state.doc.length };
    applyTreeDecorations(
        state,
        decos,
        full,
        'block',
        tree,
        focusedRange,
        activeInlineNode,
        taskMarkerPositions
    );
    collectMathDecorations(state, decos, full, focusedRange, tree);
    collectDetailsDecorations(state, decos, full, focusedRange);

    void taskMarkerPositions;
    void activeInlineNode;
    return RangeSet.of(decos, true);
}

/**
 * 窗口部分：只产出 mark / line / 行内 widget 的那些收集器。
 *
 * 它们按**渲染窗口**（视口 ± 余量）算，不算整篇 —— 这是长文档里最大的一笔省：
 * 1547 行的文档，整篇算一次重建要 7ms 上下，按窗口算不到 0.3ms。
 *
 * @param state - 编辑器状态
 * @param range - 渲染窗口
 * @param composing - 是否处于输入法组合中（组合期间表格列宽冻结）
 * @returns 这部分的装饰集
 */
/**
 * 每个视图最近一轮窗口装饰是用什么字体环境量的。
 *
 * 校验「首屏那轮是否量错」用：视图首次构建时可能还没进文档 / 主题样式
 * 尚未注入，计算样式不是最终正文那套（量出来的圆点偏窄、悬挂缩进偏小）。
 * 挂载后用真实样式比一次，不一致就补一轮重建。
 * WeakMap 按视图存，视图销毁自动回收。
 */
const viewBuildEnv = new WeakMap<EditorView, MeasureEnv | null>();

function buildWindowDecorations(
    state: EditorState,
    range: ILineRange,
    composing: boolean,
    view?: EditorView
): DecorationSet {
    const decos: Array<ReturnType<Decoration['range']>> = [];
    const tree = ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
    // 和 block 那一遍用同一套规则算源码区间，两边的判断才不会打架
    const focusedRange = getSourceRange(state);
    const activeInlineNode = findActiveInlineNode(state, tree);

    // 窗口内的任务标记位置：列表项里的 `[ ]` 由主遍历渲染，这里的正则要避开它们
    const taskMarkerPositions = new Set<number>();
    tree.iterate({
        from: range.from,
        to: range.to,
        enter: (nodeRef) => {
            if (nodeRef.name === 'TaskMarker') taskMarkerPositions.add(nodeRef.from);
        },
    });

    // 当前视图的正文字体：圆点 / 悬挂缩进都按它量，保证渲染态与源码态
    // 的 `- ` 宽度一致（导图节点是独立 mini-CM，不能依赖全局 #editor）
    const measureEnv = measureEnvFromElement(view?.contentDOM ?? null);
    // 记下本视图这一轮用的字体环境；挂载后由 tableWidthBootstrap 与
    // 真实计算样式比对，不一致就补一轮（首屏构建常常发生在样式就位之前）
    if (view) viewBuildEnv.set(view, measureEnv);
    applyTreeDecorations(
        state,
        decos,
        range,
        'inline',
        tree,
        focusedRange,
        activeInlineNode,
        taskMarkerPositions,
        measureEnv
    );
    collectFootnoteDecorations(state, decos, range, focusedRange);
    collectHeadingFontDecorations(state, decos, range, focusedRange, tree);
    collectCheckboxDecorations(state, decos, range, focusedRange, tree, taskMarkerPositions);
    collectImageDecorations(state, decos, range, focusedRange, tree);
    collectFileLinkDecorations(state, decos, range, focusedRange);
    // wiki 内链 `[[#标题]]`：Lezer 不认这种语法，与文件路径一样走逐行正则
    collectWikiInternalLinkDecorations(state, decos, range, focusedRange, tree);
    // 带空格 / 括号的文件链接（Lezer 解析失败的兜底，如 `[PDF](../A B.pdf)`）
    collectSpacedFileLinkDecorations(state, decos, range, focusedRange, tree);
    // 行内代码里写的公式（`$$…$$` / `$…$` / 不带定界符的 `A_e`）：
    // 保持反引号的盒子，里面换成 KaTeX。它**不收 focusedRange** ——
    // 让不让开看光标在不在这一格里，见 mathCollect.ts 的说明。
    collectCodeSpanMathDecorations(state, decos, range, tree);
    // 表格骨架：管道线压 0 宽、单元格定宽、分隔行折叠、被框选的格子高亮。
    // mark/line/行内 widget 都不影响块结构，所以可以只算窗口。
    // view 透传给表格量宽：导图节点按节点盒的 max-width 当预算，不设上限
    // 会把节点撑成无限宽。
    collectTableDecorations(state, decos, tree, range, composing, view);
    // 列表缩进：层级引导线 + 行首空白对齐（两种状态下长得一样）
    collectListIndentDecorations(state, decos, range, measureEnv);
    // 聚焦块处理：块级标记压 0 宽、行级样式补齐、光标所在的行内元素就地展开
    // 并整体缩放补偿宽度（详见 focusMarks.ts）
    collectFocusDecorations(
        state,
        decos,
        {
            from: Math.max(focusedRange.from, range.from),
            to: Math.min(focusedRange.to, range.to),
        },
        tree,
        activeInlineNode,
        // 跨行宽度补偿按「当前视图」量折行宽度与字体（导图节点是独立 mini-CM）
        view
    );
    return RangeSet.of(decos, true);
}



/**
 * live preview 的装饰插件。
 *
 * ## 为什么是 ViewPlugin 而不是 StateField
 *
 * 装饰集按**当前视口 ± 余量**（见 renderRange）算，而不是整篇 —— 视口只有 CM6 的
 * `view.visibleRanges` 知道，StateField 拿不到。长文档上这个差别很大：1547 行的
 * 文档实测一次全量重建 7ms 以上，按窗口算只剩不到 1ms。
 *
 * 只算窗口的代价是：滚出窗口时要重算一次。所以窗口上下各留了 60 行余量，
 * 一屏之内随便滚都不会触发；窗口外的内容 CM6 用 widget 的 estimatedHeight 估高度，
 * 这也是各个 widget 都实现 estimatedHeight 的原因。
 */
export const livePreviewPlugin = ViewPlugin.fromClass(
    class {
        /** 当前这轮装饰。 */
        decorations: DecorationSet;
        /** 上面这轮装饰是按哪个窗口算的；视口跑出这个窗口才需要重算。 */
        private window: ILineRange;

        constructor(view: EditorView) {
            this.window = renderRange(view);
            // 构建时不可能在输入法组合中，composing 传 false
            this.decorations = buildWindowDecorations(view.state, this.window, false, view);
        }

        update(update: ViewUpdate): void {
            if (!needsRebuild(update)) return;
            const next = renderRange(update.view);
            // 视口还在上一轮的窗口里（只是滚了一点）：不用重建
            if (
                update.viewportChanged &&
                !update.docChanged &&
                !update.selectionSet &&
                next.from >= this.window.from &&
                next.to <= this.window.to
            ) {
                return;
            }
            this.window = next;
            // 把「是否在输入法组合中」透传下去：组合期间表格列宽必须冻结
            this.decorations = buildWindowDecorations(
                update.view.state,
                next,
                update.view.composing,
                update.view
            );
        }
    },
    { decorations: (value) => value.decorations }
);

/**
 * block 装饰集（StateField）。
 *
 * CodeMirror 不允许 ViewPlugin 产出 block 装饰，所以「会产出块级 replace / 块级 widget」
 * 的那几个收集器留在这里，整篇算；其余按窗口算的部分在下面的 ViewPlugin 里。
 * 实测这部分在 1547 行的文档上约 1ms（主遍历 0.5ms + 公式 0.2ms + 表格 0.7ms，
 * 表格那条已经被「按内容缓存列宽」压到很便宜）。
 */
/**
 * 视图挂上 DOM 之后补一次重建 —— 表格的列宽需要它。
 *
 * 表格列宽要按「正文有多宽」分配（见 tableRender 的 availableWidth），可 block 装饰
 * 是在 `EditorState.create` 阶段算出来的，那时视图还没有 DOM，可用宽度量到 0，
 * 表格只能按「谁都不许折行」的自然宽画 —— 于是撑出正文列，而且**只要没人动它就一直撑着**
 * （短文档不会有视口变化，谁也不会触发重建）。
 *
 * 所以挂载时探一次：量不到宽度就排一个任务，等能量到了补一次重建，让表格回到
 * 「按可见宽度分配」的那一版。只排这一次，不是轮询。
 *
 * 用 setTimeout 而不是 `view.requestMeasure`：无头 Chrome 在 `--dump-dom` 之前
 * 不保证出帧，rAF 回调可能一次都不跑（复现页里就没法验证了）。
 */

/**
 * 检查已渲染的 bullet 是不是在视图挂载前**用错字体**量的宽度。
 *
 * 首次装饰构建发生在 EditorState.create 阶段、视图还没进 DOM，
 * getMeasureContext 退回 body 的 UI 字体（比例字体），给 `- ` 量出
 * 一个偏窄的宽度；挂载后正文实际用编辑器字体（通常等宽），
 * 真实 `- ` 更宽。这个函数在挂载后运行，逐个对照：
 * bullet DOM 上写死的旧宽度 vs 现在按正文重新量出的目标宽度。
 *
 * @param view - 已挂载的编辑器视图
 * @returns 只要有一个 bullet 宽度偏差超过 0.5px 就返回 true
 */
function hasMismeasuredBullets(view: EditorView): boolean {
    const bullets = view.contentDOM.querySelectorAll<HTMLElement>('.cm-md-bullet');

    for (const bullet of bullets) {
        const currentWidth = Number.parseFloat(bullet.style.width);
        if (!Number.isFinite(currentWidth)) continue;

        // 反查这个 bullet 在源码里对应的标记符（`-` / `*` / `+`），
        // 三种字符在比例字体下宽度不一定相同，不能一律按 '-' 量
        let marker = '-';
        try {
            const pos = view.posAtDOM(bullet, 0);
            const line = view.state.doc.lineAt(pos);
            const ch = line.text[pos - line.from];
            if (ch === '-' || ch === '*' || ch === '+') marker = ch;
        } catch {
            /* 取不到就退回按 '-' 比对 */
        }

        // 按**当前视图**的正文样式量。不能只靠 getMeasureContext 的全局缓存：
        // 导图节点的 mini-CM 是独立字体环境，页面上没有主编辑器时会退到
        // body 的比例字体，量出的 `- ` 偏窄，圆点/正文就和源码态对不上。
        const env = measureEnvFromElement(view.contentDOM);
        const targetWidth =
            measureTextIn(env, marker, '400') + measureTextIn(env, ' ', '400');
        if (targetWidth > 0 && Math.abs(currentWidth - targetWidth) > 0.5) {
            return true;
        }
    }
    return false;
}

export const tableWidthBootstrap = ViewPlugin.fromClass(
    class {
        /**
         * @param view - 编辑器视图
         */
        constructor(view: EditorView) {
            // 判据留到回调时再算（构造函数跑在首屏装饰之前）：
            // 1. 构造时列宽缓存还是空的，判了永远是「不用补」；
            // 2. 判据是「首屏那批装饰是否量错」，不是「现在量得到吗」；
            // 3. 视图没挂上去时 dispatch 会炸。
            /** 纠正是否已经做过（rAF 与 setTimeout 两个回调只做一次） */
            let done = false;
            const correct = (): void => {
                if (done || !view.dom.isConnected) return;
                // 首屏补算共用这一个 effect，三种情况：
                // ① 首轮构建时视图还没进文档，所有按字体量的东西
                //    （圆点宽度 / 悬挂缩进 / 表格列宽）都用了 body 界面字体
                //    —— 见 viewsBuiltWithoutEnv；
                // ② 表格列宽还没按可用宽度分配（见 hasUnmeasuredTables）；
                // ③ bullet 宽度与当前正文口径不一致（见 hasMismeasuredBullets）。
                // 首轮构建用的字体环境 vs 现在真实正文样式：不一致说明
                // 那一轮在样式就位前量过（圆点偏窄 / 缩进偏小），必须重建
                const builtEnv = viewBuildEnv.get(view) ?? null;
                const currentEnv = measureEnvFromElement(view.contentDOM);
                const envChanged =
                    !!currentEnv &&
                    (builtEnv === null ||
                        builtEnv.size !== currentEnv.size ||
                        builtEnv.family !== currentEnv.family);
                if (
                    !envChanged &&
                    !hasUnmeasuredTables() &&
                    !hasMismeasuredBullets(view)
                ) {
                    return;
                }
                done = true;
                view.dispatch({ effects: tableRemeasureEffect.of(null) });
            };
            // **绘制前**纠正：rAF 回调在浏览器本次绘制**之前**同步运行，
            // dispatch 同步更新 DOM —— 首帧就是正确版本，不会先看到一帧
            // 用 body 字体（UI 字体）量出来的错位圆点再跳一下。
            requestAnimationFrame(correct);
            // 兜底：标签页在后台时 rAF 被节流、无头 --dump-dom 也不保证出帧
            // （历史教训，见 createOpenWrapContext 的注释），setTimeout 兜一道
            setTimeout(correct, 0);
        }
    }
);

export const livePreviewBlockDecorations = StateField.define<DecorationSet>({
    create(state) {
        return buildBlockDecorations(state);
    },
    update(value, tr) {
        // 双击切换源码模式 / 行级强制态：效果里带来新的区间（null 表示退出），
        // 先落到共享状态里，下面的重算才会按新模式渲染。
        for (const effect of tr.effects) {
            if (effect.is(sourceModeEffect)) {
                setSourceModeRange(tr.state, effect.value);
            } else if (effect.is(lineForceEffect)) {
                patchLineForce(tr.state, effect.value);
            }
        }
        if (blockNeedsRebuild(tr)) return buildBlockDecorations(tr.state);
        return value;
    },
    provide: (f) => EditorView.decorations.from(f),
});

/**
 * block 装饰集的更新判据（StateField 版：拿不到 viewport，所以只能看事务）。
 *
 * @param tr - 当前事务
 * @returns 需要重算时返回 true
 */
function blockNeedsRebuild(tr: Transaction): boolean {
    const state = tr.state;
    const startState = tr.startState;
    const oldSel = startState.selection.main;
    const newSel = state.selection.main;
    void oldSel;
    void newSel;

    // 文档变化：先把行级强制区间映射到新坐标（StateField 一定会重建，
    // 但共享状态本身得保持准确）
    if (tr.docChanged) mapForceRanges(state, tr.changes);
    // 钉住行失去焦点：在这里清掉，下面 getSourceRange 才不会继续按钉住行算
    const exitedPinned = exitPinnedForceIfOutside(state, newSel.from, newSel.to);

    // 源码区间变了（拖选范围变了、光标换了块）就得重算
    const oldFocused = getSourceRange(startState);
    const newFocused = getSourceRange(state);
    const focusChanged = oldFocused.from !== newFocused.from || oldFocused.to !== newFocused.to;
    const focusSignatureChanged =
        computeFocusSignature(startState, syntaxTree(startState)) !==
        computeFocusSignature(state, syntaxTree(state));
    const editableChanged = startState.facet(EditorView.editable) !== state.facet(EditorView.editable);
    const hasFoldToggle = tr.effects.some((e) => e.is(foldToggleEffect));
    const hasSourceModeToggle = tr.effects.some((e) => e.is(sourceModeEffect));
    // mousedown 待选 / 双击钉住的切换：不改文档也不改选区，必须单独触发重建
    const hasLineForceToggle = tr.effects.some((e) => e.is(lineForceEffect));
    // 挂载后补算（表格/bullet）：折叠列表项的 bullet 由本 block 遍产出，
    // 同样可能在首屏用错字体量宽，需要跟着重建
    const hasTableRemeasure = tr.effects.some((e) => e.is(tableRemeasureEffect));
    const treeChanged = syntaxTree(startState) !== syntaxTree(state);
    if (tr.docChanged) return true;
    return (
        focusChanged ||
        focusSignatureChanged ||
        editableChanged ||
        hasFoldToggle ||
        treeChanged ||
        hasSourceModeToggle ||
        hasLineForceToggle ||
        hasTableRemeasure ||
        exitedPinned
    );
}

/**
 * 这次更新要不要重算装饰。
 *
 * 判据和以前（StateField 版）一致，额外多了一条 `viewportChanged`：
 * 装饰只覆盖窗口范围，滚出窗口必须重算。
 *
 * @param update - CodeMirror 的视图更新
 * @returns 需要重算时返回 true
 */
function needsRebuild(update: ViewUpdate): boolean {
    const tr = update.transactions.length > 0 ? update.transactions[update.transactions.length - 1] : null;
    // 双击切换源码模式 / 行级强制态：效果里带来新的区间（null 表示退出），
    // 先落到共享状态里，下面的 buildDecorations 才会按新模式渲染。
    for (const effect of update.transactions.flatMap((t) => t.effects)) {
        if (effect.is(sourceModeEffect)) {
            setSourceModeRange(update.state, effect.value);
        } else if (effect.is(lineForceEffect)) {
            patchLineForce(update.state, effect.value);
        }
    }

    // 注意：这里**不能**再 mapForceRanges！
    // 同一个事务的 StateField.update（blockNeedsRebuild）已经映射过一次，
    // 共享状态里的区间此时是「新文档坐标」。再用同一份 tr.changes（它基于
    // 旧文档）映射第二次，会把新坐标当旧坐标用，位置超出旧文档长度时
    // CodeMirror 直接抛 RangeError: Position N is out of range for changeset
    // of length M（导图节点编辑时文档一变长就能稳定复现）。
    // 钉住区间的退出判断是幂等的，重复调用无害，保留。
    // 钉住行失去焦点：同样提前清掉，viewportChanged 那一支也得带着新状态重建
    const earlyNewSel = update.state.selection.main;
    const exitedPinned = exitPinnedForceIfOutside(update.state, earlyNewSel.from, earlyNewSel.to);

    if (update.viewportChanged) return true;

    const state = update.state;
    const startState = update.startState;
    const newSel = state.selection.main;
    // 光标/选区离开源码模式的块就退出。必须每次更新都查一遍：
    // 「光标移出表格」本身可能不会让聚焦范围变化（源码模式下聚焦范围是整张表），
    // 不查的话表格会卡在源码模式里出不来。
    const exitedSourceMode = exitSourceModeIfOutside(state, newSel.from, newSel.to);

    const oldFocused = getSourceRange(startState);
    const newFocused = getSourceRange(state);
    const focusChanged = oldFocused.from !== newFocused.from || oldFocused.to !== newFocused.to;
    // 同一块内移动光标也要重建：换了活动行内元素（点同一行的另一个加粗）、
    // 或者光标进出标题行（决定 `#` 露不露），外观都得跟着变。
    const focusSignatureChanged =
        computeFocusSignature(startState, syntaxTree(startState)) !==
        computeFocusSignature(state, syntaxTree(state));
    const editableChanged =
        startState.facet(EditorView.editable) !== state.facet(EditorView.editable);
    const hasFoldToggle = update.transactions.some((t) =>
        t.effects.some((e) => e.is(foldToggleEffect))
    );
    // 表格 / 图片 / Mermaid 双击进（出）源码模式：本身不改文档，但外观要重建
    const hasSourceModeToggle = update.transactions.some((t) =>
        t.effects.some((e) => e.is(sourceModeEffect))
    );
    // mousedown 待选 / 双击钉住的切换：不改文档也不改选区，必须单独触发重建
    const hasLineForceToggle = update.transactions.some((t) =>
        t.effects.some((e) => e.is(lineForceEffect))
    );
    // 视图挂上 DOM 之后的那次补算：表格列宽要按可见宽度重新分配（见 tableWidthBootstrap）。
    // 表格的装饰在**窗口**这一份里（不是 block 那一份），所以判据写在这里。
    const hasTableRemeasure = update.transactions.some((t) =>
        t.effects.some((e) => e.is(tableRemeasureEffect))
    );
    // Lezer 增量解析完成（大文件后台解析）也会换树
    const treeChanged = syntaxTree(startState) !== syntaxTree(state);
    // 选区两端变了也要重建：被框选的格子高亮是跟着选区加的（见 collectTableDecorations）。
    // 只关心「有范围的选区」—— 光标在空选区里挪来挪去不必重算。
    const selChanged =
        (!startState.selection.main.empty || !newSel.empty) &&
        (startState.selection.main.from !== newSel.from ||
            startState.selection.main.to !== newSel.to);
    void tr;

    return (
        update.docChanged ||
        selChanged ||
        focusChanged ||
        focusSignatureChanged ||
        editableChanged ||
        hasFoldToggle ||
        treeChanged ||
        hasSourceModeToggle ||
        hasLineForceToggle ||
        hasTableRemeasure ||
        exitedSourceMode ||
        exitedPinned
    );
}

// 三个工厂函数已拆到 extensionFactory.ts；re-export 保持既有调用方不变
export {
    createLivePreviewExtension,
    createLivePreviewDisplayExtension,
    livePreviewEditAddons,
} from './extensionFactory.js';

