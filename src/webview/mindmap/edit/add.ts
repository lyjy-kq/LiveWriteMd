/**
 * 导图 Markdown 回写（从 markdownEdit.ts 拆出）：§6.2 新增：子节点/兄弟节点/addNode（按 spec 生成各类插入文本）。
 *
 * 全部是纯函数：输入 markdown 全文与节点信息，返回编辑结果。
 *
 * @module webview/mindmap/edit/add
 */

import { insertBlockLines, insertHeadingAt, insertHeadingAtEnd, insertListItem, listContentColumn, listIndentOf, promoteParagraphToList } from './move.js';
import { isMediaKind } from './rename.js';
import { EditResult, NEW_NODE_TEXT, findNodeByUid, rangeOf } from './shared.js';
import { normalizeNestedListIndent } from '../treeBuilder.js';
import type { MindMapTreeNode, NodeLineRange } from '../types.js';


/**
 * §6.2 在 parent 下新增子节点。
 * root -> H1（文末）；H(n<6) -> H(n+1)；H6 -> 无序列表项；
 * list -> 缩进 +1 的同类型列表项；para 先原地升级成列表项再插子项。
 *
 * @param text - 新节点的初始文字（默认「分支主题」）。
 *        「拆分到子节点」把选中内容剪过来时走这里。
 */
export function addChildNode(
    markdown: string,
    tree: MindMapTreeNode,
    parentUid: string,
    text: string = NEW_NODE_TEXT
): EditResult {
    const found = findNodeByUid(tree, parentUid);
    if (!found) return { text: markdown };
    const parent = found.node;
    // 媒体节点是真正的叶子（代码块 / 表格里塞不进子节点）
    if (isMediaKind(parent.data._kind)) {
        return { text: markdown };
    }

    const lines = markdown.split('\n');

    // 段落 / 引用要加子节点：Markdown 里它们没有「子节点」这种结构，
    // 先原地升级成列表项（`- 文字`；引用升级成 `- > 文字`，列表项里的
    // 引用块仍是合法引用），再在它下面插子项。
    // 这样文字仍是正文（不会被改成标题），层级由缩进自然表达。
    if (parent.data._kind === 'para' || parent.data._kind === 'quote') {
        const self =
            (parent.data._selfLineRange as NodeLineRange | undefined) ?? rangeOf(parent);
        const childIndent = promoteParagraphToList(lines, self);
        insertListItem(lines, self.toLine + 1, childIndent, false, text, false);
        return { text: lines.join('\n'), newNodeUid: `${parent.data.uid}/0` };
    }
    // 缩进列要按 treeBuilder 看到的「归一化文本」算：
    // 用户（或粘贴进来的文档）常有缩进不足的嵌套列表，treeBuilder 在解析前
    // 会把 marker 补到父项内容列。若这里按原始行算，插入的代码块/子列表
    // 会差几格，重建后掉出父列表项 —— 表现就是「子节点跑到了兄弟/上一层」。
    // 归一化只改行首空白、不改行数，行号与原始文本一一对应。
    const normalizedLines = normalizeNestedListIndent(markdown).split('\n');
    const newIndex = parent.children.length;
    const newUid = `${parent.data.uid}/${newIndex}`;

    if (parent.data._kind === 'root') {
        // 完全空白的文档直接给一个标题，避免前面残留空行
        if (markdown.trim() === '') {
            return { text: `# ${text}`, newNodeUid: newUid };
        }
        insertHeadingAtEnd(lines, 1, text);
        return { text: lines.join('\n'), newNodeUid: newUid };
    }
    if (parent.data._kind === 'heading') {
        const level = parent.data._headingLevel ?? 1;
        const { toLine } = rangeOf(parent);
        if (level < 6) {
            insertHeadingAt(lines, toLine + 1, level + 1, text);
        } else {
            // H6 不能再深：转无序列表项（2 空格缩进，作为 H6 节内顶层列表）
            insertListItem(lines, toLine + 1, 2, false, text, true);
        }
        return { text: lines.join('\n'), newNodeUid: newUid };
    }

    // list：缩进 +1，类型继承父节点
    const { toLine } = rangeOf(parent);
    const indent = listContentColumn(
        normalizedLines[rangeOf(parent).fromLine] ?? '-'
    );
    insertListItem(
        lines,
        toLine + 1,
        indent,
        parent.data._listOrdered === true,
        text,
        false
    );
    return { text: lines.join('\n'), newNodeUid: newUid };
}


/**
 * §6.2 新增兄弟节点：在目标子树区间之后插入同形态行。
 * root 不允许。
 *
 * @param text - 新节点的初始文字（默认「分支主题」）。
 *        「拆分到兄弟节点」把选中内容剪过来时走这里。
 */
export function addSiblingNode(
    markdown: string,
    tree: MindMapTreeNode,
    uid: string,
    text: string = NEW_NODE_TEXT
): EditResult {
    const found = findNodeByUid(tree, uid);
    if (!found || !found.parent || found.node.data._kind === 'root') {
        return { text: markdown };
    }
    const node = found.node;
    // 媒体节点不支持「新增兄弟」（无法凭空造一个代码块/表格/图片，工具条也已禁用）
    if (isMediaKind(node.data._kind)) return { text: markdown };
    const lines = markdown.split('\n');
    // 与 addChildNode 同理：兄弟的缩进必须跟 treeBuilder 归一化后的树一致
    const normalizedLines = normalizeNestedListIndent(markdown).split('\n');
    const { toLine } = rangeOf(node);
    const insertAt = toLine + 1;
    const newUid = `${found.parent.data.uid}/${found.index + 1}`;

    if (node.data._kind === 'heading') {
        insertHeadingAt(lines, insertAt, node.data._headingLevel ?? 1, text);
    } else if (node.data._kind === 'para') {
        // 段落兄弟（Shift+Enter 的普通文本路径）：空行 + 同缩进段落。
        // 空行是段落边界，没有它新文字会被并进同一段；段落若在列表项内部
        // （缩进过的续段），沿用原行缩进才能继续算作该列表项的子段落。
        // 只有父节点是列表时才继承缩进 —— 顶层段落后面新加的兄弟必须顶格。
        const sourceLine = lines[rangeOf(node).fromLine] ?? '';
        const inList = found.parent?.data._kind === 'list';
        const indent = inList ? (/^[ \t]*/.exec(sourceLine)?.[0] ?? '') : '';
        lines.splice(insertAt, 0, '', indent + text);
    } else {
        // 行首缩进取归一化文本：缩进不足的嵌套项在树里已被补到父内容列，
        // 这里沿用原始缩进会让新兄弟掉到父列表外面（「加兄弟跑到父节点兄弟」）。
        const sourceLine = normalizedLines[rangeOf(node).fromLine] ?? '- ';
        const indent = listIndentOf(sourceLine);
        insertListItem(
            lines,
            insertAt,
            indent,
            node.data._listOrdered === true,
            text,
            false
        );
    }
    return { text: lines.join('\n'), newNodeUid: newUid };
}


/**
 * 工具条悬浮菜单可插入的新节点类型。
 *
 * - text：普通文本节点（顶层段落 / 列表项，按上下文决定）
 * - heading：指定级别的标题
 * - list：无序列表项
 * - code / math / mermaid / table：媒体块
 */
export type NewNodeSpec =
    | { type: 'text' }
    | { type: 'heading'; level: number }
    | { type: 'list' }
    | { type: 'code'; language?: string }
    | { type: 'math' }
    | { type: 'mermaid' }
    | { type: 'table'; rows: number; cols: number };


/** 工具条「添加子节点 / 添加兄弟」的通用插入。 */
export function addNode(
    markdown: string,
    tree: MindMapTreeNode,
    targetUid: string,
    placement: 'child' | 'sibling',
    spec: NewNodeSpec
): EditResult {
    const found = findNodeByUid(tree, targetUid);
    if (!found) return { text: markdown };
    const target = found.node;
    const targetKind = target.data._kind;
    // 媒体节点是真正的叶子；root 没有兄弟。
    // 段落允许加子节点：会先被升级成列表项（见下面的 promoteParagraphToList）。
    if (placement === 'child' && (targetKind === 'meta' || isMediaKind(targetKind))) {
        return { text: markdown };
    }
    if (placement === 'sibling' && targetKind === 'root') return { text: markdown };
    const parent = placement === 'child' ? target : found.parent;
    if (!parent) return { text: markdown };

    const lines = markdown.split('\n');
    // 缩进计算统一用归一化文本（见 addChildNode 的说明）：解析树看到的
    // 列表缩进才是「真实层级」，原始行的缩进可能比它浅几格。
    const normalizedLines = normalizeNestedListIndent(markdown).split('\n');
    const siblingIndex = found.index;
    // root 没有 _lineRange（treeBuilder 只给非 root 写），rangeOf 会抛错。
    // 根节点加子节点时插入位置本来就是文末，这里给一个「最后一行」的假区间。
    const targetRange = target.data._lineRange
        ? rangeOf(target)
        : { fromLine: Math.max(0, lines.length - 1), toLine: Math.max(0, lines.length - 1) };

    // 段落加子节点：先原地升级成列表项，后面的插入逻辑按「列表父节点」走。
    // 升级只改行首（补 `- ` / 续行缩进），文字本身、行数都不变。
    const promotePara = placement === 'child' && targetKind === 'para';
    // 升级后的内容列（原缩进 + 2）：子项必须落在这个列上才会被解析成子列表。
    // 不能拿升级前的 targetFirstLine 去算 —— 段落行没有 marker，
    // listContentColumn 会给出 0，子项会掉成同级列表（看起来「加子节点没生效」）。
    let promotedIndent = 0;
    if (promotePara) {
        promotedIndent = promoteParagraphToList(
            lines,
            (target.data._selfLineRange as NodeLineRange | undefined) ?? targetRange
        );
    }

    // —— 标题节点的插入位置 ——
    //
    // 标题的「直接子块」只可能出现在**标题行之后、第一个子标题之前**。
    // 如果按整节末尾插入，块会落进最后一个子标题的章节里：
    // 给 `## A`（有 `### A1`、`### A2`）加子节点，媒体块会变成 A2 的子节点，
    // 用户看到的就是「加子节点跑到兄弟/更深层去了」。
    // 同理，标题的「兄弟」如果是个段落/媒体块，Markdown 里根本无法成为标题的兄弟
    // （顶层段落永远归属于它前面的标题），只能退化成标题的子节点。
    // 所以：除了「插入同级标题」这种天然按级别解析的兄弟，其余一律锚定到
    // 标题自身内容的末尾（最后一个非标题子节点的子树之后）。
    const targetIsHeading = targetKind === 'heading';
    // 标题兄弟 + heading spec：新标题行直接放到整节之后，按级别自然成为兄弟
    const headingSiblingHeading = placement === 'sibling' && spec.type === 'heading';
    // 标题下已有的「非标题子节点」（段落/列表/媒体），它们都在第一个子标题之前
    const nonHeadingChildren = targetIsHeading
        ? target.children.filter((child) => child.data._kind !== 'heading')
        : [];
    const lastNonHeadingChild = nonHeadingChildren[nonHeadingChildren.length - 1];
    /** 标题自身内容（不含子标题）的结束行：setext 标题可能占两行。 */
    const headingOwnEnd =
        (target.data._selfLineRange as NodeLineRange | undefined)?.toLine ?? targetRange.fromLine;
    // —— 根节点的块级子节点（非标题）——
    //
    // 虚拟根（文件名）的直接子节点只能是「第一个标题之前」的顶层块。
    // 以前一律插到文末，结果这些块被解析成**最后一个标题**的子节点，
    // 用户看到的就是「给根加子节点，却出现在某个标题的兄弟位置」。
    // 有标题时插到第一个标题之前；没有标题时插到文末。
    // 标题类新增不适用：新标题追加到文末本来就属于根。
    const rootBlockChild =
        placement === 'child' &&
        targetKind === 'root' &&
        spec.type !== 'heading';
    const firstRootHeading = rootBlockChild
        ? target.children.find(
              (child) =>
                  child.data._kind === 'heading' && !!child.data._lineRange
          )
        : undefined;

    // 新的内容块/新标题插入位置
    const insertAt =
        placement === 'child' && targetKind === 'root'
            ? rootBlockChild
                ? (firstRootHeading?.data._lineRange?.fromLine ?? lines.length)
                : lines.length
            : targetIsHeading && !headingSiblingHeading
              ? (lastNonHeadingChild?.data._lineRange?.toLine ?? headingOwnEnd) + 1
              : targetRange.toLine + 1;

    // 预测新节点的 uid：必须和插入位置解析出来的树一致，否则 commit 会
    // 选中/进入编辑一个**别的**节点（以前标题加兄弟就会跳到下一个标题）。
    // 标题 + 非同级标题 spec：实际的父节点是**目标标题自己**（见上面的说明）。
    const newIndex =
        rootBlockChild && firstRootHeading
            ? // 插在第一个标题之前：新节点在根的子节点里排在这些「标题之前的块」之后
              parent.children.filter(
                  (child) =>
                      (child.data._lineRange?.fromLine ?? Number.MAX_SAFE_INTEGER) <
                      insertAt
              ).length
            : targetIsHeading && !headingSiblingHeading
              ? nonHeadingChildren.length
              : placement === 'child'
                ? parent.children.length
                : siblingIndex + 1;
    // 标题兄弟退化成子节点时，父 uid 要用目标标题，而不是 found.parent
    const newUid = `${targetIsHeading && !headingSiblingHeading ? target.data.uid : parent.data.uid}/${newIndex}`;

    // —— 列表上下文 ——
    //
    // 缩进只属于列表：块级内容（代码块/表格/公式/mermaid/段落）只有在
    // **列表项内部**才需要缩进到内容列，否则会掉出列表项变成顶层块。
    // 以前这里把目标行自身的行首空白当成缩进源，一个缩进了 7 个空格的
    // 目标行会把整段新媒体块也缩进 7 格 —— 导图节点拿到的是独立 mini-CM
    // 文档，≥4 空格的围栏会被 CommonMark 当成缩进代码块，mermaid 直接
    // 不渲染。现在：父节点不是列表就一律顶格。
    const targetFirstLine = normalizedLines[targetRange.fromLine] ?? '';
    const parentIsList = parent.data._kind === 'list';
    // 父是列表（加子节点）或目标是列表（加兄弟）时，新内容要带缩进。
    // 刚升级成列表项的段落同样按列表父节点处理。
    const listParent =
        placement === 'child' && (targetKind === 'list' || promotePara);
    const listSibling = placement === 'sibling' && targetKind === 'list';
    // 列表内子项必须缩进到内容列（`1. ` 比 `- ` 宽）；
    // 其余列表上下文沿用目标行的行首缩进（兄弟与父内容列对齐）
    const childIndent = listParent
        ? promotePara
            ? promotedIndent
            : listContentColumn(targetFirstLine)
        : 0;
    const listIndent = listParent
        ? childIndent
        : parentIsList
          ? listIndentOf(targetFirstLine)
          : 0;
    const ordered = target.data._listOrdered === true;

    /** 造一个列表项。 */
    const listItem = (indent: number, useOrdered: boolean): string[] => [
        ' '.repeat(indent) + (useOrdered ? '1. ' : '- ') + NEW_NODE_TEXT,
    ];

    /** 媒体块统一缩进（列表项内的围栏/表格必须缩进到内容列）。 */
    const indentBlock = (block: string[], indent: number): string[] =>
        block.map((line) => (line === '' ? line : ' '.repeat(indent) + line));

    let block: string[];
    let blankSeparated = true;

    switch (spec.type) {
        case 'heading': {
            if (listParent) {
                // 列表项里不能直接塞标题（CommonMark 不识别），退化成子列表项
                block = listItem(childIndent, ordered);
                blankSeparated = false;
            } else if (listSibling) {
                // 列表的兄弟标题插在整段列表之后、顶格开始
                block = [
                    '#'.repeat(clampHeading(spec.level)) + ' ' + NEW_NODE_TEXT,
                ];
            } else {
                // 作为标题的子节点时，级别必须比父标题深一级以上
                let level = clampHeading(spec.level);
                if (placement === 'child' && targetKind === 'heading') {
                    const parentLevel = target.data._headingLevel ?? 1;
                    level = Math.max(level, parentLevel + 1);
                }
                if (level > 6) {
                    // 已经是 H6：转为顶层列表项（Markdown 没有 H7）
                    block = listItem(0, false);
                } else {
                    block = ['#'.repeat(level) + ' ' + NEW_NODE_TEXT];
                }
            }
            break;
        }
        case 'text': {
            if (listParent) {
                block = listItem(childIndent, ordered);
                blankSeparated = false;
            } else if (listSibling) {
                block = listItem(listIndent, ordered);
                blankSeparated = false;
            } else {
                // 普通段落：空行分隔，不能紧贴标题（会被并进标题的续行）
                block = [' '.repeat(Math.max(0, listIndent)) + NEW_NODE_TEXT];
            }
            break;
        }
        case 'list': {
            if (listParent) {
                block = listItem(childIndent, ordered);
                blankSeparated = false;
            } else if (listSibling) {
                block = listItem(listIndent, ordered);
                blankSeparated = false;
            } else {
                // 顶层列表：与上文空行分隔
                block = listItem(0, false);
            }
            break;
        }
        case 'code': {
            const fence = '```' + (spec.language ?? '');
            block = indentBlock([fence, '', '```'], listIndent);
            break;
        }
        case 'math': {
            // 空的公式行不能夹在两条 `$$` 之间：`$$` / 空行 / `$$` 会被
            // CommonMark 拆成两个普通段落，treeBuilder 的 isDisplayMathParagraph
            // 两行都不满足（长度 < 5），新节点直接消失。紧挨着的两行 `$$` 才是一个
            // 完整的显示公式块（空公式）。
            block = indentBlock(['$$', '$$'], listIndent);
            break;
        }
        case 'mermaid': {
            block = indentBlock(
                ['```mermaid', 'graph TD', '    A[开始] --> B[结束]', '```'],
                listIndent
            );
            break;
        }
        case 'table': {
            const rows = Math.max(1, Math.min(4, spec.rows));
            const cols = Math.max(1, Math.min(4, spec.cols));
            // 表头 + 分隔行 + (rows-1) 个空数据行；单元格留给用户编辑
            const header = '| ' + Array.from({ length: cols }, () => ' ').join(' | ') + ' |';
            const divider = '| ' + Array.from({ length: cols }, () => '---').join(' | ') + ' |';
            const body = Array.from({ length: Math.max(0, rows - 1) }, () => header);
            block = indentBlock([header, divider, ...body], listIndent);
            break;
        }
        default:
            return { text: markdown };
    }

    // 空白文档 + 根节点加子节点：不要留前导空行
    if (markdown.trim() === '' && targetKind === 'root' && placement === 'child') {
        return { text: block.join('\n'), newNodeUid: newUid };
    }
    const next = insertBlockLines(lines, insertAt, block, blankSeparated, markdown);
    return { text: next.join('\n'), newNodeUid: newUid };
}


/** 标题级别钳到 1-6。 */
export function clampHeading(level: number): number {
    return Math.min(6, Math.max(1, Math.round(level)));
}


/** 判断一行是不是水平分割线（`---` / `***` / `___`，可含空白与行间空格）。 */
export function isHrLine(text: string): boolean {
    return /^\s*([-*_])(\s*\1){2,}\s*$/.test(text);
}


/**
 * 把待删行区间向前后扩到紧贴的 `---` 分割行（含区间与分割线之间的空行）。
 *
 * 导图里删一个节点时，它作为「一节」前后的分割线应该一起消失，否则文档里
 * 会留下孤立的 `---`。
 *
 * 向上的安全判据：`---` 的上一行是非空文本时，那条 `---` 其实是上面内容的
 * **setext 标题下划线**（吃掉会把人家的标题降级成普通段落），不能动；
 * 上一行是空行 / 文档开头 / 另一条分割线时才是真·分割线。
 * 向下不需要这个判据：`---` 只可能是它上面那一行的下划线，而上面那行
 * 正在本次删除范围内（否则解析器早把它并进同一个块了）。
 */
export function extendRangeOverHr(
    lines: string[],
    fromLine: number,
    toLine: number
): { fromLine: number; toLine: number } {
    // 向下：跳过空行，吃到第一条分割线
    let end = toLine;
    let i = toLine + 1;
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i < lines.length && isHrLine(lines[i])) end = i;
    // 向上：跳过空行，吃到分割线（setext 下划线除外）
    let start = fromLine;
    let j = fromLine - 1;
    while (j >= 0 && lines[j].trim() === '') j--;
    if (
        j >= 0 &&
        isHrLine(lines[j]) &&
        (j - 1 < 0 || lines[j - 1].trim() === '' || isHrLine(lines[j - 1]))
    ) {
        start = j;
    }
    return { fromLine: start, toLine: end };
}
