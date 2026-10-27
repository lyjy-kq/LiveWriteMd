/**
 * 聚焦块的「就地展开」与「宽度补偿」。
 *
 * ## 设计目标
 *
 * 渲染态和编辑态要能无缝切换：点进某一行时，只有**你点的那一个行内元素**展开成
 * Markdown 源码，行的其余部分保持渲染态；并且展开之后，那一块的总宽度要尽量等于
 * 它在渲染态下的宽度，这样它后面的文字也不会被推着走。
 *
 * ## 三条规则
 *
 * 1. **行内元素（加粗 / 斜体 / 删除线 / 行内代码 / 链接）**
 *    光标落进哪个元素，就只展开哪一个，其余元素照常渲染（标记隐藏、内容上样式）。
 *    拖选时（非空选区）整块退回源码，这一块里的元素**每一个都挂同一套缩放补偿**
 *    （不只是被选中的那些，见 collectSourceModeInlineNodes），
 *    免得一开始选字，元素就从「略小」弹回原大小、整行长度跳一下 ——
 *    尤其是同行的兄弟元素：它没被选中但一样变成了源码，补偿少了它，
 *    它就会以原字号跟旁边略小的那个并排，看着像坏了。
 *    展开后这一块是**纯文本**——`**加粗**` 里的「加粗」不再加粗、行内代码不再换等宽
 *    字体也不再有底色，就是 6 个普通字符。这样既符合「文本模式只含修饰符和元素内文本」，
 *    也顺手消掉了行高变化：等宽字体的 ascent/descent 比正文比例字体高，之前会把这行
 *    和下一行一起顶下去一点。
 *
 *    代价是纯文本比渲染态宽得多，于是整体挂一个 `font-size: 缩放` 把宽度压回来
 *    —— 缩放和字距怎么算、为什么短元素补不齐，见 openScale.ts。
 *
 *    **行内代码不缩字号**：它渲染态自带 12px 的底色内边距，已经替两个反引号
 *    「付过账」了，源串只多出几个像素，收紧一点字距就能对齐；
 *    展开后字号也保持和渲染态一样（0.95em），所以点进去的那一下
 *    字号不变、宽度不变，只是多露出两个反引号。
 *
 *    链接是这条规则的特例：`](地址)` 通常比链接文字长得多，整段露出来会把
 *    整行推出去很远，所以光标停在链接文字里时只露 `[文字]`，地址继续隐藏；
 *    确实要改地址（光标移到地址里）时才整段展开。
 *
 * 2. **块级标记（`# `、`> `、代码块围栏）**
 *    标题的 `# ` 用「光标落在这一行就展开」，露出来的标记就占在行首，
 *    标题文字整体右移一个标记的宽度——不做位置补偿，因为正文左侧留白只有 32px，
 *    开行号栏时把标记顶进留白里会压到行号上，比整行右移更难看。
 *    代码围栏同理，而且更彻底：**光标落在代码块里的任何位置**（围栏行或正文行）
 *    都把前后两个 ` ``` ` 和语言名一起露出来。围栏行整行都是标记，压成 0 宽会变成
 *    一条空白，点一下像把这一行弄没了；而按「行」判断还会让点正文时围栏继续藏着，
 *    看不出自己在编辑代码块。
 *    引用 `>` 仍是「光标真的落在标记字符上才展开」、平时压 0 宽。
 *
 * 3. **行级样式（标题字号、引用边框）**
 *    无论是否聚焦都照常应用，否则点一下标题行，字号和缩进都会跳。
 *    **代码块是例外**：光标一进代码块，整块的底色、边框、缩进导引线全部撤掉，
 *    只剩「围栏 + 纯文本的代码」——用户要求的是「点哪儿整块都变成文本模式，
 *    没有背景色」。其它行级样式照旧，免得点一下标题行、整行字号跳一下。
 *
 * ## 元素越短越难补，但**只会偏宽、不会偏窄**
 *
 * `**加粗**` 这种短元素，4 个标记字符的宽度已经是内容本身的两倍多，
 * 想完全补回来得把字缩到 48%，那样根本看不清。
 * 所以设了一个可读下限 MIN_OPEN_SCALE，宁可留一点点位移，也不把字缩到没法读。
 * 元素越长补偿越充分：十几个字的加粗句、行内代码，基本可以做到零位移。
 *
 * 补不齐时的方向是**固定的**：字号下限 + 字距收紧上限都用满之后，元素只会比
 * 渲染态略宽（后面的字往右挪一两个像素），绝不会比渲染态窄 —— 放宽字距是够用的，
 * 「展开之后这一块比原来还窄」属于算错，不是取舍。
 *
 * @module webview/codemirror/extensions/livePreview/focusMarks
 */

import type { EditorState } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';
import { Decoration } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';
import {
    headingLineDecos,
    hideDeco,
    srcDelimDeco,
    srcMarkActiveDeco,
    srcMarkDeco,
} from '../decor/decorations.js';
import { extractFencedCodeContent, extractFencedCodeLanguage } from '../measure/sourceParse.js';
import {
    computeOpenScales,
    describeOpenElement,
    isInlineFormatNode,
} from './openScale.js';
import type { OpenElementInfo } from './openScale.js';
import {
    computeOpenScalesWrapped,
    createOpenWrapContext,
    openWrapEligible,
} from './openWrap.js';
import { isTableLikeBlock, splitRowText } from '../table/tableDetect.js';
// 引用聚焦的悬挂缩进要叠在「正文与行号线距离」之上（.cm-line 的默认左内边距）
import { settingsState } from '../../../../settings/settingsState.js';
import { isSetextBeforeFence } from '../ranges.js';
import { isForcedSourceRange } from '../state.js';
import { inlineMathFocusSignature } from '../math/mathCollect.js';
import { CodeBlockCopyWidget } from '../widgets/simpleWidgets.js';
import type { ILineRange } from '../types.js';

/** Decoration.range 的返回类型，直接拿来当数组元素类型用。 */
type RangeDecoration = ReturnType<Decoration['range']>;

/**
 * 判断节点是否归属某个**真的**行内元素——元素本身、或者它内部的标记子节点
 * （`EmphasisMark`、`CodeMark`、`LinkMark` 这些）都算。
 *
 * 聚焦块里只放行这些节点继续走渲染态：这样加粗、行内代码的标记会被正常隐藏，
 * 而代码块的围栏 ` ``` `（它的父节点是 FencedCode，不是行内元素）不会被误放行。
 *
 * 聚焦块里只放行这些节点继续走渲染态：这样加粗、行内代码的标记会被正常隐藏，
 * 而代码块的围栏 ` ``` `（它的父节点是 FencedCode，不是行内元素）不会被误放行。
 *
 * @param node - 待判断的语法节点
 * @returns 属于行内元素时返回 true
 */
export function isInlineRenderable(node: SyntaxNode): boolean {
    // 行内元素嵌套很浅（元素 → 标记），最多往上找三层就够
    let current: SyntaxNode | null = node;
    for (let depth = 0; current && depth < 3; depth++) {
        if (isInlineFormatNode(current.name)) return true;
        current = current.parent;
    }
    return false;
}

/**
 * 判断节点是否落在活动元素里（含它自己）。
 *
 * 活动元素整体由 focusMarks 展开成源码，所以它和它的子节点都不能再走渲染态，
 * 否则标记刚露出来又被隐藏掉。
 *
 * 比较用位置区间而不是对象引用：Lezer 的 SyntaxNode 是按需创建的，
 * 同一棵树位置可能对应两个不同的对象。
 *
 * @param node - 待判断的语法节点
 * @param activeNode - 当前活动元素，可为 null
 * @returns 在活动元素内部时返回 true
 */
export function isWithinActiveInline(node: SyntaxNode, activeNode: SyntaxNode | null): boolean {
    if (!activeNode) return false;
    // 连同活动元素的子节点（首尾标记 `EmphasisMark` 等）一起排除，
    // 否则标记刚露出来又会被渲染态隐藏掉
    let current: SyntaxNode | null = node;
    while (current) {
        if (current.from === activeNode.from && current.to === activeNode.to) return true;
        current = current.parent;
    }
    return false;
}

// =============================================================================
// 活动元素判定
// =============================================================================

/**
 * 找出光标所在的**行内元素**（没有就返回 null）。
 *
 * 实现上从光标位置的语法节点往上找，碰到第一个真行内元素就是它。
 * 只有空选区才算——拖选时不展开，免得选着选着整行来回跳。
 *
 * @param state - 编辑器状态
 * @param tree - 语法树
 * @returns 光标所在的行内元素节点；光标在普通文字里时返回 null
 */
export function findActiveInlineNode(state: EditorState, tree: Tree): SyntaxNode | null {
    const selection = state.selection.main;
    if (!selection.empty) return null;

    let node: SyntaxNode | null = tree.resolveInner(selection.head, 0);
    while (node) {
        if (isInlineFormatNode(node.name)) return node;
        if (node.name === 'Document') return null;
        node = node.parent;
    }
    return null;
}

// =============================================================================
// 展开态的渲染信息
// =============================================================================

// =============================================================================
// 聚焦签名（决定光标移动后要不要重建装饰）
// =============================================================================

/**
 * 算一个「当前聚焦状态」的紧凑签名，供 plugin.ts 判断要不要重建装饰。
 *
 * 为什么需要它：装饰原本只在文档变化 / 聚焦块变化时才重建，于是**同一个块内
 * 移动光标**（点同一行的另一个加粗、点到行内普通文字、点进标题）不会触发重建，
 * 活动元素就一直停在第一次点的那个上。用签名把「活动行内元素」和
 * 「光标在哪一行标题里」也纳入比较，成本只是两次语法树查询，不会全量重建。
 *
 * @param state - 编辑器状态
 * @param tree - 该状态对应的语法树
 * @returns 签名字符串；拖选（非空选区）时返回空串，因为拖选不展开任何元素
 */
export function computeFocusSignature(state: EditorState, tree: Tree): string {
    const selection = state.selection.main;
    if (!selection.empty) return '';

    // 1) 光标所在的行内元素（决定哪一个展开成源码）
    const active = findActiveInlineNode(state, tree);
    let signature = active ? `i${active.from}-${active.to}` : '';

    // 2) 光标所在的行标题（决定标题的 `#` 要不要露出来）
    let node: SyntaxNode | null = tree.resolveInner(selection.head, 0);
    while (node) {
        if (node.name.startsWith('ATXHeading')) {
            signature += `|h${node.from}`;
            break;
        }
        if (node.name === 'Document') break;
        node = node.parent;
    }

    // 3) 光标所在的行内公式（`$…$`）不在语法树里，单独问 mathCollect 要签名：
    //    同一行里从普通文字移进公式也得触发重建，否则点公式没反应
    const mathSignature = inlineMathFocusSignature(state, tree);
    if (mathSignature) signature += `|${mathSignature}`;
    return signature;
}

// =============================================================================
// 主入口
// =============================================================================

/**
 * 这个区间是不是「把表格的一整格包住了」。
 *
 * 用文本切格子（`splitRowText`）而不是查语法树里的 `TableCell`：
 * tableRender 画格子时分了两条路 —— 正常表格走语法树，**被解析成标题/段落、其实是
 * 表格**的那种兜底块走文本（见 findTextTables），而 `splitRowText` 正是两条路共用的
 * 切法，跟它对齐才能不漏掉兜底表格里的格子。
 *
 * 只在「整格」时返回 true：区间只盖住格子的一部分（`前**粗**后` 那种）不会有问题 ——
 * 那时外层 span 是套在格子**里面**的，格子本身还是整行的直接子元素。
 *
 * @param state - 编辑器状态
 * @param from - 区间起点（文档位置）
 * @param to - 区间终点（文档位置）
 * @returns 包住了某一整格时返回 true
 */
function isWholeTableCell(state: EditorState, from: number, to: number): boolean {
    const line = state.doc.lineAt(from);
    // 跨行的区间不可能是格子（表格的一行就是一格）
    if (line.to < to) return false;
    // 方向别写反：要的是「区间**盖住**了整格」（from <= 格子头、格子尾 <= to），
    // 不是「区间落在格子里」—— 后者连 `前 **粗** 后` 都会命中，格子里的加粗
    // 就再也拿不到宽度补偿了。
    return splitRowText(line.text).some(
        (seg) => from <= line.from + seg.from && line.from + seg.to <= to
    );
}

/**
 * 找出聚焦块里**所有**行内元素（每个最多收一层，只收最外层）。
 *
 * 为什么是「所有」而不是「与选区相交的那些」：非空选区会让**整块**退回源码文本
 * （见 plugin.ts 的 canRenderInFocus：选区一非空，这一块的行内格式一律按源码显示），
 * 于是整块里每个 `**加粗**` 都露出了自己的星号。要是只给「被选中的那几个」挂宽度补偿，
 * 同一行的兄弟元素就会是「源码 + 原字号」——比旁边被选中的那个整整大一圈，
 * 看着像坏了（用户反馈的原话就是：没选中的那个「变成文本元素还是正常大小」）。
 * 所以规则对齐成一句话：**只要是源码态的行内元素，就保持略小**。
 *
 * 只收最外层是必须的：`**粗 `码` 体**` 这种嵌套如果内外两层都挂 `font-size`，
 * 字号会**叠乘**（0.6 × 0.6 = 0.36em），宽度反而更对不上。
 *
 * @param tree - 当前语法树
 * @param focusedRange - 当前聚焦区间（只在可见的聚焦块里找，跟主遍历保持一致）
 * @returns 这一块里的行内元素节点（最外层，文档顺序）
 */
function collectSourceModeInlineNodes(tree: Tree, focusedRange: ILineRange): SyntaxNode[] {
    const nodes: SyntaxNode[] = [];
    tree.iterate({
        from: focusedRange.from,
        to: focusedRange.to,
        enter: (nodeRef): boolean | void => {
            // 不是行内元素（标题、代码块、列表…）：继续往下找
            if (!isInlineFormatNode(nodeRef.name)) return;
            // 已经被前面收下的外层元素罩住了：跳过，别再挂一层缩放
            const covered = nodes.some(
                (node) => node.from <= nodeRef.from && nodeRef.to <= node.to
            );
            if (covered) return false;
            nodes.push(nodeRef.node);
            // 命中一个就不再下探：嵌套元素跟着外层一起展开成源码
            return false;
        },
    });
    return nodes;
}

/**
 * 收集聚焦块内需要补的样式、需要压 0 宽的块级标记、以及展开成源码的活动元素。
 *
 * @param state - 当前编辑器状态，用来读文档内容与选区
 * @param decos - 待写入的装饰数组，由调用方统一交给 DecorationSet
 * @param focusedRange - 当前聚焦（正在编辑）的区间；from < 0 表示只读模式
 * @param tree - 当前语法树
 * @param activeNode - 光标所在的行内元素（由 findActiveInlineNode 算出）
 * @param view - 当前编辑器视图；跨行宽度补偿要按**这个视图**的折行宽度/字体量
 *              （导图节点的 mini-CM 与主编辑器是两套 DOM），不传时退回主编辑器
 * @returns void，结果直接 push 进 decos
 */
export function collectFocusDecorations(
    state: EditorState,
    decos: RangeDecoration[],
    focusedRange: ILineRange,
    tree: Tree,
    activeNode: SyntaxNode | null,
    view?: EditorView
): void {
    // 只读模式（Viewer）也走完整聚焦展开：ranges.ts 的 editable 总闸放开后，
    // viewer 下 focusedRange 同样是真实区间，行为与实时模式一致（只是不能编辑）。
    if (focusedRange.from < 0 || focusedRange.from >= focusedRange.to) return;

    // 选区左右端点：空选区时两者都等于光标位置
    const selection = state.selection.main;
    const selFrom = Math.min(selection.from, selection.to);
    const selTo = Math.max(selection.from, selection.to);

    /**
     * 块级标记要不要展开显示。
     *
     * 空选区（点击）用「严格包含」而不是「挨着就展开」：点击正文时落点几乎总在
     * 标记边缘上，用闭区间会导致一点击就展开、整行跳动。
     *
     * 非空选区（拖选）放宽为「选区碰到标记所在行就展开」：拖选的起点几乎总在
     * 第一行标记**之后**（点在文字上），严格判据下第一行的行首标记（> 等）会
     * 被漏掉、其余行却都显示——拖选语义是「这几行回到源码态」，行碰上了就该显。
     *
     * 但落在行级强制区间（mousedown 待选 / 双击钉住）时一律展开：
     * 标记要是继续压 0 宽，等拖选真正开始（选区变非空）才露面，整行会
     * 再跳一次 —— 展开必须在 mousedown 的同一时刻完成，坐标才始终一致。
     */
    const isBlockMarkExposed = (from: number, to: number): boolean => {
        if (isForcedSourceRange(state, from, to)) return true;
        if (!selection.empty) {
            // 拖选：标记所在行与选区相交（含端点）即展开
            const markLine = state.doc.lineAt(from);
            return selFrom <= markLine.to && markLine.from <= selTo;
        }
        // 点击：严格开区间相交，防止落点蹭到标记边缘就整行跳动
        return selFrom < to && from < selTo;
    };

    /**
     * 把一个块级标记区间加进装饰：展开态用正常字号，否则压 0 宽。
     */
    const pushBlockMark = (from: number, to: number): void => {
        if (from >= to) return;
        decos.push((isBlockMarkExposed(from, to) ? srcMarkActiveDeco : srcMarkDeco).range(from, to));
    };

    /**
     * 挂上宽度补偿那层 span：标记符和内容一起缩，总宽度才回得来。
     *
     * **唯独「整格」不挂这层**（见下面的说明）：它会套住整个格子、把格子挤塌。
     * 不挂的代价只是格子里的 `**` 按原字号显示，内容长过钉子列宽时这一行会折行
     * —— 宽是列宽钉死的，折行是内容真的变长了，和往格子里多打几个字一样。
     *
     * @param info - 元素的展开信息
     * @param result - 补偿参数：字号倍率、字距 px（来自 computeOpenScales / openWrap）、
     *                 结尾 margin px（仅 openWrap 跨行路径给出，把后缀精确推回原位）
     */
    const pushScaleMark = (
        info: OpenElementInfo,
        result: { scale: number; letterSpacing: number; marginRight?: number }
    ): void => {
        const { scale, letterSpacing } = result;
        // margin-right 只在跨行路径有值；0 / undefined 都不写，保持样式最短
        const margin = result.marginRight;
        const marginStyle = margin ? `; margin-right:${margin.toFixed(2)}px` : '';
        decos.push(
            Decoration.mark({
                class: 'cm-md-src-open',
                attributes: {
                    style:
                        `font-size:${scale.toFixed(4)}em; letter-spacing:${letterSpacing.toFixed(3)}px` +
                        marginStyle,
                },
            }).range(info.from, info.to)
        );
    };

    /**
     * 挂上「这一段是展开出来的源码」的说明性装饰：标记符灰化 + 该藏的继续藏。
     *
     * 注意：这里**故意不给内容挂渲染样式**。展开态就是纯文本（`**加粗**` 显示成
     * 6 个普通字符），既是「文本模式只含修饰符和元素内文本」的要求，
     * 也顺带避免了行内代码换等宽字体把行盒顶高。
     *
     * @param info - 元素的展开信息
     */
    const pushSourceMarks = (info: OpenElementInfo): void => {
        // 标记符：灰一点以示区分（这两个装饰都落在元素内部，套不进格子，
        // 所以「整格」时也照挂）
        info.marks.forEach((mark) => {
            if (mark.from < mark.to) {
                decos.push(srcDelimDeco.range(mark.from, mark.to));
            }
        });
        // 链接地址这类「太长、露出来会把整行推走」的片段继续隐藏
        info.hidden.forEach((range) => {
            if (range.from < range.to) {
                decos.push(hideDeco.range(range.from, range.to));
            }
        });
    };

    /**
     * 把**一批**行内元素按「展开态」渲染。
     *
     * 调用方有两处，语义不同但渲染必须完全一致：
     * 1. **空选区**：光标所在的那一个元素（`activeNode`）；
     * 2. **非空选区**：整块里所有行内元素（见 collectSourceModeInlineNodes）
     *    —— 少了这一路，一拖选字号就弹回原大小，同行的兄弟元素还会大小不一。
     *
     * 为什么收一批：缩放要量字宽（一个元素近百个候选字号），而量一次要强制一次
     * 布局。一批一起算 → 整块只强制一次（见 openScale.computeOpenScales）。
     *
     * @param entries - 要展开的元素，以及各自判断链接地址露不露用的依据
     */
    const pushOpenElements = (
        entries: Array<{ node: SyntaxNode; caret: number }>
    ): void => {
        // 第一步：解出结构（不含量宽），顺手定下「谁要挂缩放」——
        // 整格的元素只展开、不缩放（理由见 pushScaleMark）。
        // node 一并留着：跨行判定要看语法树上的祖先（见 openWrapEligible）
        const opened = entries
            .map((entry) => {
                const info = describeOpenElement(state, entry.node, entry.caret);
                if (!info) return null;
                return {
                    node: entry.node,
                    info,
                    scaled: !isWholeTableCell(state, info.from, info.to),
                };
            })
            .filter(
                (item): item is { node: SyntaxNode; info: OpenElementInfo; scaled: boolean } =>
                    item !== null
            );
        if (opened.length === 0) return;

        // ---------------------------------------------------------------------
        // 第二步：宽度补偿分两路（详见 openWrap.ts 的文件头说明）
        // - 跨行（软折行）候选先交给折行模拟：按「行数 + 末行右端」选字号，
        //   保住元素后面的文字不动、也不让它多占/少占一行；
        // - 模拟不接管的（渲染态只占一行 / 标题列表表格行 / 前提不满足 / 异常兜底）
        //   全部回落到单行算法（computeOpenScales），那是逐像素验证过的路径。
        // 两路结果按 opened 的原顺序合并，挂装饰的方式和以前完全一致。
        //
        // 排版环境只在「确实有能接管的候选」时才去量（要量一次折行宽度），
        // 免得点表格格子这类永远走不到跨行路径的场景白付一次强制布局。
        // ---------------------------------------------------------------------
        const scaleResults = new Map<
            OpenElementInfo,
            { scale: number; letterSpacing: number; marginRight?: number }
        >();
        // openWrap 接管条件：openWrapEligible（纯段落/单逻辑行/无 widget）。
        // 前缀里的兄弟行内元素由 renderedSegments 按渲染态处理；
        // 行数风险由各批模拟的「行数守恒」直接验证兜住，不再事先排除
        const canWrap = (item: { node: SyntaxNode }) => openWrapEligible(state, item.node);
        const candidates = opened.filter((item) => item.scaled && canWrap(item));
        // 传入当前视图：mini-CM 的折行宽度/字体与主编辑器不同，
        // 写死 #editor 会让导图里的跨行补偿整条失效（行数 ±1、后缀被推走）
        const wrapCtx = candidates.length > 0 ? createOpenWrapContext(view) : null;
        const fallbackInfos: OpenElementInfo[] = [];
        const wrappedInfos: OpenElementInfo[] = [];
        for (const item of opened) {
            if (!item.scaled) continue;
            if (wrapCtx && canWrap(item)) {
                wrappedInfos.push(item.info);
            } else {
                fallbackInfos.push(item.info);
            }
        }
        const wrappedScales =
            wrappedInfos.length > 0
                ? computeOpenScalesWrapped(state, tree, wrapCtx!, wrappedInfos)
                : [];
        wrappedInfos.forEach((info, i) => {
            const result = wrappedScales[i];
            if (result) {
                scaleResults.set(info, result);
            } else {
                // openWrap 主动让位（渲染态只占一行等）：回落到单行算法
                fallbackInfos.push(info);
            }
        });
        const fallbackScales = computeOpenScales(state, fallbackInfos);
        fallbackInfos.forEach((info, i) => {
            scaleResults.set(info, fallbackScales[i]);
        });

        // 第三步：逐个挂装饰（scaled 的元素必有一路结果，见上面的分组）
        for (const item of opened) {
            if (item.scaled) {
                pushScaleMark(item.info, scaleResults.get(item.info)!);
            }
            pushSourceMarks(item.info);
        }
    };

    // -------------------------------------------------------------------------
    // 活动元素：整块展开成源码，并整体缩放，使宽度与渲染态一致
    // -------------------------------------------------------------------------
    // 表格格子里的元素只展开、**不缩放**（见下面的 isWholeTableCell）。
    // 那个带缩放的外层 span 在「元素正好是一整格」时会把「格子」套在自己里面，而格子的
    // 盒子是靠「作为整行的 flex item」撑出来的（见 tableRender.ts）——一旦变成别人的
    // 子元素，就只剩行内元素语义，定宽 / 内边距 / 边框 / min-height 全部失效：
    // 实测点进一个整格加粗的格子后，它从 92×29.8 缩成 81×17，而整行是
    // justify-content:center 排列的，右边那些格子跟着一起往左挪 —— 就是「边框缩小并乱位」。
    // 格子宽度本来就是钉死的，用不着靠字号缩放去补偿宽度，所以那层 span 直接不挂。
    // 行级强制区间（mousedown 待选 / 双击钉住）：即使光标正停在某个元素里，
    // 也要按「整行所有元素一起展开」处理 —— 用户从行内任何位置按下都得看到
    // 全句的修饰符。判据放在 activeNode 之前，否则只会展开光标所在的那一个。
    const forcedInFocus =
        focusedRange.from < focusedRange.to &&
        isForcedSourceRange(state, focusedRange.from, focusedRange.to);

    if (forcedInFocus || !selection.empty) {
        // ① 拖选（非空选区）/ 强制行：**整块**都会退回源码（plugin.ts 那一侧
        //    已经决定了），所以这里给这一块里的每一个行内元素都补上同样的缩放
        //    补偿 —— 不管是选中的那个，还是同行的兄弟。少挂一个，它就会以原字号
        //    显示源码，跟旁边略小的那个一比就像坏了。
        //    注意和下面的单元素分支互斥：两边都挂同一段区间的 cm-md-src-open，
        //    重叠会把字号叠乘。
        // 活动端统一交给每个元素自己判断：露不露链接地址只看「活动端有没有真的落进
        // 这个链接里」（见 describeOpenElement）——拖选时活动端在别处，
        // 链接就跟没被选中时一样只露 `[文字]`，不会被一个长地址把整行撑开。
        // 待选（pending）阶段光标已经落在按下点：链接地址的显隐按该点判定，
        // 和单击同一位置时的结果保持一致。
        pushOpenElements(
            collectSourceModeInlineNodes(tree, focusedRange).map((node) => ({
                node,
                caret: selection.head,
            }))
        );
    } else if (activeNode && activeNode.from >= focusedRange.from && activeNode.to <= focusedRange.to) {
        // ② 光标（空选区）常态：只有光标所在的那一个元素展开
        pushOpenElements([{ node: activeNode, caret: selection.head }]);
    }

    // -------------------------------------------------------------------------
    // 块级样式：标题 / 引用 / 代码块，无论是否聚焦都补齐，避免点一下整块变形
    // -------------------------------------------------------------------------
    tree.iterate({
        from: focusedRange.from,
        to: focusedRange.to,
        enter: (nodeRef): boolean | void => {
            const { from, to, name } = nodeRef;
            const node = nodeRef.node;

            // 活动元素自己已经处理过了，不再重复
            if (isWithinActiveInline(node, activeNode)) return false;

            // ---- 标题：补行级字号/字重，`#` 按需露出 ----
            if (name.startsWith('ATXHeading') || name.startsWith('SetextHeading')) {
                // 形状是表格的（表格后面紧跟一条 ---）就不是标题了，让给表格渲染
                if (isTableLikeBlock(state, from, to)) return;
                // 下划线后面紧跟着围栏的也不是标题（见 isSetextBeforeFence）：
                // 标题样式和「下划线折叠」都别做，这一行就按原文显示 `---`
                if (isSetextBeforeFence(state, from, to)) return;
                const level = name.startsWith('ATXHeading')
                    ? Number.parseInt(name.slice('ATXHeading'.length), 10)
                    : name === 'SetextHeading1'
                      ? 1
                      : 2;
                const lineFrom = state.doc.lineAt(from).from;
                const marks = node.getChildren('HeaderMark');
                // 光标落在这一行标题里（不只是落在 `#` 字符上）就把 `#` 露出来——
                // 「点标题不动、看不到修饰符」的问题就出在这里。
                const caretInHeading =
                    name.startsWith('ATXHeading') &&
                    marks.length > 0 &&
                    selection.head >= from &&
                    selection.head <= to;

                if (caretInHeading) {
                    // 只把 `#` 露出来，不做任何位置补偿：露出来的标记就占在行首，
                    // 标题文字整体右移一个 `# ` 的宽度。之前用负 text-indent 把标记
                    // 顶进正文左侧的留白里（标题纹丝不动），但留白只有 32px，
                    // 开行号栏时标记会压到行号上，比整行右移更难接受。
                    // 类名和 decorations.ts 的 headingLineDecos 保持一致。
                    decos.push(
                        Decoration.line({
                            class: `cm-md-heading cm-md-heading-${level}`,
                        }).range(lineFrom)
                    );
                    marks.forEach((mark) => {
                        const after = state.doc.sliceString(mark.to, mark.to + 1);
                        decos.push(
                            srcMarkActiveDeco.range(mark.from, after === ' ' ? mark.to + 1 : mark.to)
                        );
                    });
                } else {
                    const levelDeco = headingLineDecos[level];
                    if (levelDeco) decos.push(levelDeco.range(lineFrom));
                    // 首尾的 `#`（以及 `# ` 后面那个空格）平时压 0 宽
                    marks.forEach((mark) => {
                        const after = state.doc.sliceString(mark.to, mark.to + 1);
                        pushBlockMark(mark.from, after === ' ' ? mark.to + 1 : mark.to);
                    });
                }

                // Setext 标题下面那行 === / --- 在渲染态被折叠，这里保持同样的行级类
                if (name.startsWith('SetextHeading')) {
                    const startLine = state.doc.lineAt(from);
                    const endLine = state.doc.lineAt(to);
                    if (endLine.number > startLine.number) {
                        decos.push(
                            Decoration.line({ class: 'cm-md-setext-underline' }).range(endLine.from)
                        );
                    }
                }
                return;
            }

            // ---- 引用：聚焦时撤掉渲染态外壳，但保留「悬挂缩进」 ----
            //
            // 边框 / 左边距这些渲染态外壳撤掉（与代码块聚焦同哲学），
            // `> ` 原样显示——用户要能看到并删掉它（以前压 0 宽：不可见
            // 也点不中）。但折行的续行必须对齐到 `>` 标记**之后**的文本列，
            // 不能和 `>` 顶齐 —— 与列表的悬挂缩进同一个手法
            // （padding-left + 负 text-indent，见 collectListIndentDecorations）。
            if (name === 'Blockquote') {
                // 只处理最外层：嵌套引用的行已由最外层这一遍覆盖
                if (node.parent?.name !== 'Blockquote') {
                    const startLine = state.doc.lineAt(from);
                    const endLine = state.doc.lineAt(to);
                    // 引用块里「没有 > 的非空行」是上一行的懒续行（CommonMark lazy
                    // continuation）：它没有自己的标记，要对齐到上一行的文本列，
                    // 所以只给 padding-left、不给负 text-indent。
                    let lastWidthCh = 0;
                    // .cm-line 自带 lineGutterGap 的左内边距，我们的 padding 是
                    // 覆盖式写入 —— 必须把它加回来，否则 `>` 会跑到普通段落左边
                    const basePadding = settingsState.getNumber('lineGutterGap');
                    for (let ln = startLine.number; ln <= endLine.number; ln++) {
                        const line = state.doc.line(ln);
                        if (line.text.trim() === '') continue;
                        // 行首的 > 标记串（含其间空白；嵌套引用有多个）。
                        // 宽度按字符数算（等宽字体 1 字符 = 1ch；Tab 罕见，按 1 算）
                        const marksRun = line.text.match(/^[ \t]*(?:>[ \t]*)+/);
                        if (marksRun) {
                            const widthCh = marksRun[0].length;
                            lastWidthCh = widthCh;
                            decos.push(
                                Decoration.line({
                                    class: 'cm-md-quote-open',
                                    attributes: {
                                        style: `padding-left:calc(${basePadding}px + ${widthCh}ch);text-indent:-${widthCh}ch`,
                                    },
                                }).range(line.from)
                            );
                        } else if (lastWidthCh > 0) {
                            // 懒续行：对齐到文本列（只有 padding，没有负缩进）
                            decos.push(
                                Decoration.line({
                                    class: 'cm-md-quote-open',
                                    attributes: {
                                        style: `padding-left:calc(${basePadding}px + ${lastWidthCh}ch)`,
                                    },
                                }).range(line.from)
                            );
                        }
                    }
                }
                return;
            }

            // 引用符号本身：不压 0 宽、不加任何装饰 —— 原样露出（可编辑）
            if (name === 'QuoteMark') {
                return false;
            }

            // ---- 代码块：进文本模式，整块的底色/边框/缩进导引线一起撤掉 ----
            if (name === 'FencedCode') {
                // Mermaid 在渲染态是整块图形 widget，编辑态保持纯文本更好改
                if (extractFencedCodeLanguage(node, state) === 'mermaid') return false;

                // 这里**故意不挂** `cm-md-codeblock*` 那几行装饰：那是渲染态的外壳
                // （底色、左右边框、圆角、行首 0.9em 的内边距、缩进导引线）。
                // 光标一进代码块，整块就是「纯文本 + 围栏」——用户要的是
                // 「点哪儿都整块变成文本模式，并且没有背景色」，留着底色会让
                // 「进去了」这件事只能靠左边两个 ``` 看出来，尤其是块很长的时候。
                //
                // 主角是主遍历：它碰到与聚焦块重叠的 FencedCode 会整棵跳过，
                // 所以渲染态那套行装饰在这里**本来就不会产生**。此处只要不补，
                // 整块自然就是干净的正文。
                const startLine = state.doc.lineAt(from);

                // 复制按钮：渲染态由 plugin.ts 的主遍历挂上，这里必须补一个一样的。
                // 两条路是互斥的（主遍历跳过聚焦块、这里只管聚焦块），不会挂重；
                // 少了它，光标一进代码块（或一拖选）按钮就会消失、再点走又冒出来。
                const codeContent = extractFencedCodeContent(node, state);
                if (codeContent !== null) {
                    decos.push(
                        Decoration.widget({
                            widget: new CodeBlockCopyWidget(
                                codeContent,
                                extractFencedCodeLanguage(node, state)
                            ),
                            side: 1,
                        }).range(startLine.to)
                    );
                }

                // 围栏上的 ``` 和语言名在渲染态是隐藏的。
                //
                // 判据是「光标在这个代码块里」而不是「光标在围栏这一行」：能走到这个
                // 分支就说明这一块正被聚焦（这个函数只算聚焦区间），所以**直接展开**。
                // 按行判断的老写法有个坑：点代码正文时围栏继续藏着，用户看到的是一段
                // 悬空的代码，不知道自己在编辑代码块；而且点围栏行和点正文行结果不一样，
                // 规则也不统一。现在点哪儿都是「正文连同前后 ``` 一起进文本模式」。
                node.getChildren('CodeMark').forEach((mark) => {
                    if (mark.from < mark.to) {
                        decos.push(srcMarkActiveDeco.range(mark.from, mark.to));
                    }
                });
                node.getChildren('CodeInfo').forEach((mark) => {
                    if (mark.from < mark.to) {
                        decos.push(srcMarkActiveDeco.range(mark.from, mark.to));
                    }
                });
                return false;
            }
        },
    });
}
