/**
 * 导图编辑 -> Markdown 全文的局部行区间编辑（设计文档 §6）。
 *
 * 所有操作都基于节点携带的 _lineRange（0-based、含两端）做行级增删改，
 * 代码块 / 表格 / 空行等树外内容原样保留。函数全部纯函数，便于拖拽、
 * 增删、改名共用同一套「算出新全文 -> dispatch / CONTENT_CHANGE」通道。
 */

import type { MindMapTreeNode, NodeLineRange } from './types.js';

/** 新节点默认文本。 */
export const NEW_NODE_TEXT = '分支主题';

/** 编辑操作结果：新全文 + 新节点 uid（新增时用于立即进入编辑态）。 */
export interface EditResult {
    text: string;
    /** 新增节点的路径式 uid；仅新增操作返回。 */
    newNodeUid?: string;
}

/** 树查找结果。 */
interface FoundNode {
    node: MindMapTreeNode;
    parent: MindMapTreeNode | null;
    index: number;
}

/** 按路径 uid 找树节点。 */
export function findNodeByUid(
    tree: MindMapTreeNode,
    uid: string
): FoundNode | null {
    if (tree.data.uid === uid) return { node: tree, parent: null, index: -1 };
    const segments = uid.split('/').slice(1).map(Number);
    let parent: MindMapTreeNode = tree;
    for (let i = 0; i < segments.length; i++) {
        const index = segments[i];
        const node = parent.children[index];
        if (!node) return null;
        if (i === segments.length - 1) return { node, parent, index };
        parent = node;
    }
    return null;
}

/** 读取节点行区间；root 没有区间。 */
function rangeOf(node: MindMapTreeNode): { fromLine: number; toLine: number } {
    const range = node.data._lineRange;
    if (!range) throw new Error('节点缺少 _lineRange');
    return range;
}

/** 统计子树节点数（不含自身）。 */
export function countSubtreeNodes(node: MindMapTreeNode): number {
    let count = 0;
    const walk = (n: MindMapTreeNode): void => {
        n.children.forEach((child) => {
            count += 1;
            walk(child);
        });
    };
    walk(node);
    return count;
}

/**
 * §6.1 改节点文字。
 *
 * - heading：替换标题行文字，保留 # 前缀（setext 标题整行替换，下划线保留）
 * - list：保留缩进 / 列表标记 / 任务标记，替换文字部分（续行按标记列重新缩进）
 * - para：整段区间替换
 * - root：不允许编辑（原样返回）
 */
export function renameNode(
    markdown: string,
    tree: MindMapTreeNode,
    uid: string,
    newText: string
): EditResult {
    const found = findNodeByUid(tree, uid);
    if (!found || found.node.data._kind === 'root') return { text: markdown };
    const lines = markdown.split('\n');
    const node = found.node;
    const { fromLine, toLine } = rangeOf(node);
    const trimmed = newText.trim();

    if (node.data._kind === 'heading') {
        // 标题节点允许在格子里按 Enter 换行：提交的文本可能是多行。写回规则：
        //   首行 → 标题行（保留原有 ATX 前缀 / setext 文字行）
        //   其余行 → 紧跟在标题块后面的续行（treeBuilder 会把它并回同一节点）
        // setext 的第 2 行是 ===/--- 下划线，续行必须插在下划线之后。
        // 注意用 _selfLineRange：不能碰子节点的行。
        const self = (node.data._selfLineRange as NodeLineRange | undefined) ?? {
            fromLine,
            toLine,
        };
        const firstLine = lines[self.fromLine] ?? '';
        const contentLines = trimmed.split('\n');
        // 显示态首行被规范成了 ATX（"# 标题"），setext 节点也一样，所以
        // 提交文本的首行要先剥掉 ATX 前缀（和收尾的 # 串）再套回原行前缀。
        const stripPrefix = (line: string): string =>
            line
                .replace(/^[ \t]*#{1,6}[ \t]+/, '')
                .replace(/[ \t]+#+[ \t]*$/, '');
        const firstContent = stripPrefix(contentLines[0] ?? '');
        const continuation = contentLines.slice(1);
        const atxMatch = /^([ \t]*#{1,6}[ \t]+)(.*)$/.exec(firstLine);
        if (atxMatch) {
            lines[self.fromLine] = atxMatch[1] + firstContent;
            // 替换掉旧的续行（自身边界到标题行之后）
            lines.splice(
                self.fromLine + 1,
                self.toLine - self.fromLine,
                ...continuation
            );
        } else {
            // setext：第 1 行文字、第 2 行下划线，续行插在下划线之后
            lines[self.fromLine] = firstContent;
            lines.splice(
                self.fromLine + 2,
                Math.max(0, self.toLine - self.fromLine - 1),
                ...continuation
            );
        }
        return { text: lines.join('\n') };
    }

    if (node.data._kind === 'list') {
        const firstLine = lines[fromLine] ?? '';
        // 拆出：行首缩进 / 列表标记（含其后空白）/ 任务标记 / 内容
        const match = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/.exec(
            firstLine
        );
        if (!match) return { text: markdown };
        const indent = match[1];
        const marker = match[2] + match[3];
        const task = match[4] ?? '';
        const prefix = indent + marker + task;
        // 续行对齐到 marker 之后：保留原 Tab 缩进层级，只用空格补标记宽度
        const markerWidth = marker.length + task.length;
        const continuationIndent = indent + ' '.repeat(markerWidth);
        // 显示态文档已经去掉父级缩进，但首行仍带自己的列表 marker、
        // 续行仍带 marker 宽度的缩进（见 mindmapApp.dedentListSource）。
        // 提交时先剥掉这一层再套回原文前缀，否则会写成「- - 新文本」，
        // 续行的相对缩进也会一层层累加。
        const textLines = trimmed.split('\n').map((textLine, index) => {
            if (index === 0) {
                return textLine.replace(
                    /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/,
                    ''
                );
            }
            // 最多剥掉 marker 宽度的空白：用户额外敲的缩进要保留
            let cut = 0;
            while (
                cut < markerWidth &&
                (textLine[cut] === ' ' || textLine[cut] === '\t')
            ) {
                cut += 1;
            }
            return textLine.slice(cut);
        });
        const replacement = textLines.map((textLine, index) =>
            index === 0 ? prefix + textLine : continuationIndent + textLine
        );
        // 只替换列表项自身占用的行！_lineRange 含整棵子树，
        // 用它做 splice 会把嵌套子列表/代码块一起删掉。
        const self = (node.data._selfLineRange as NodeLineRange | undefined) ?? {
            fromLine,
            toLine,
        };
        lines.splice(self.fromLine, self.toLine - self.fromLine + 1, ...replacement);
        return { text: lines.join('\n') };
    }

    // para / 媒体 / 元数据节点（code/table/image/math/mermaid/meta）：
    // 整段行区间替换。编辑的就是其完整 md 源码（围栏、表格线、图片语法、
    // front matter 的 --- 全部由用户输入负责 —— 统一显示态后编辑态含完整结构）。
    lines.splice(fromLine, toLine - fromLine + 1, ...trimmed.split('\n'));
    return { text: lines.join('\n') };
}

/** 是否媒体节点（code / table / image / math / mermaid）：叶位置、可删可拖可编辑源码。 */
export function isMediaKind(kind: string): boolean {
    return (
        kind === 'code' ||
        kind === 'table' ||
        kind === 'image' ||
        kind === 'math' ||
        kind === 'mermaid'
    );
}

/**
 * §6.2 在 parent 下新增子节点。
 * root -> H1（文末）；H(n<6) -> H(n+1)；H6 -> 无序列表项；
 * list -> 缩进 +1 的同类型列表项；para 不允许。
 */
export function addChildNode(
    markdown: string,
    tree: MindMapTreeNode,
    parentUid: string
): EditResult {
    const found = findNodeByUid(tree, parentUid);
    if (!found) return { text: markdown };
    const parent = found.node;
    // para / 媒体节点是叶子：不允许有子节点
    if (parent.data._kind === 'para' || isMediaKind(parent.data._kind)) {
        return { text: markdown };
    }

    const lines = markdown.split('\n');
    const newIndex = parent.children.length;
    const newUid = `${parent.data.uid}/${newIndex}`;

    if (parent.data._kind === 'root') {
        // 完全空白的文档直接给一个标题，避免前面残留空行
        if (markdown.trim() === '') {
            return { text: `# ${NEW_NODE_TEXT}`, newNodeUid: newUid };
        }
        insertHeadingAtEnd(lines, 1, NEW_NODE_TEXT);
        return { text: lines.join('\n'), newNodeUid: newUid };
    }
    if (parent.data._kind === 'heading') {
        const level = parent.data._headingLevel ?? 1;
        const { toLine } = rangeOf(parent);
        if (level < 6) {
            insertHeadingAt(lines, toLine + 1, level + 1, NEW_NODE_TEXT);
        } else {
            // H6 不能再深：转无序列表项（2 空格缩进，作为 H6 节内顶层列表）
            insertListItem(lines, toLine + 1, 2, false, NEW_NODE_TEXT, true);
        }
        return { text: lines.join('\n'), newNodeUid: newUid };
    }

    // list：缩进 +1，类型继承父节点
    const { toLine } = rangeOf(parent);
    const indent = listContentColumn(lines[rangeOf(parent).fromLine] ?? '-');
    insertListItem(
        lines,
        toLine + 1,
        indent,
        parent.data._listOrdered === true,
        NEW_NODE_TEXT,
        false
    );
    return { text: lines.join('\n'), newNodeUid: newUid };
}

/**
 * §6.2 新增兄弟节点：在目标子树区间之后插入同形态行。
 * root 不允许。
 */
export function addSiblingNode(
    markdown: string,
    tree: MindMapTreeNode,
    uid: string
): EditResult {
    const found = findNodeByUid(tree, uid);
    if (!found || !found.parent || found.node.data._kind === 'root') {
        return { text: markdown };
    }
    const node = found.node;
    // 媒体节点不支持「新增兄弟」（无法凭空造一个代码块/表格/图片，工具条也已禁用）
    if (isMediaKind(node.data._kind)) return { text: markdown };
    const lines = markdown.split('\n');
    const { toLine } = rangeOf(node);
    const insertAt = toLine + 1;
    const newUid = `${found.parent.data.uid}/${found.index + 1}`;

    if (node.data._kind === 'heading') {
        insertHeadingAt(lines, insertAt, node.data._headingLevel ?? 1, NEW_NODE_TEXT);
    } else if (node.data._kind === 'para') {
        // 段落兄弟（Shift+Enter 的普通文本路径）：空行 + 同缩进段落。
        // 空行是段落边界，没有它新文字会被并进同一段；段落若在列表项内部
        // （缩进过的续段），沿用原行缩进才能继续算作该列表项的子段落。
        const sourceLine = lines[rangeOf(node).fromLine] ?? '';
        const indent = /^[ \t]*/.exec(sourceLine)?.[0] ?? '';
        lines.splice(insertAt, 0, '', indent + NEW_NODE_TEXT);
    } else {
        const sourceLine = lines[rangeOf(node).fromLine] ?? '- ';
        const indent = listIndentOf(sourceLine);
        insertListItem(
            lines,
            insertAt,
            indent,
            node.data._listOrdered === true,
            NEW_NODE_TEXT,
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
    // 叶子节点不能加子节点；root 没有兄弟
    if (placement === 'child' && (targetKind === 'para' || targetKind === 'meta' || isMediaKind(targetKind))) {
        return { text: markdown };
    }
    if (placement === 'sibling' && targetKind === 'root') return { text: markdown };
    const parent = placement === 'child' ? target : found.parent;
    if (!parent) return { text: markdown };

    const lines = markdown.split('\n');
    const targetRange = rangeOf(target);
    const siblingIndex = found.index;
    // 插入位置：子节点 / 兄弟都追加到目标整棵子树之后
    // （子节点=父章节末尾，兄弟=目标子树之后；顺序都正确）
    const insertAt = placement === 'child' && targetKind === 'root'
        ? lines.length
        : targetRange.toLine + 1;
    const newIndex = placement === 'child' ? parent.children.length : siblingIndex + 1;
    const newUid = `${parent.data.uid}/${newIndex}`;

    // —— 列表上下文 ——
    const targetFirstLine = lines[targetRange.fromLine] ?? '';
    // 父节点是列表（加子节点）或目标本身是列表（加兄弟）时，新内容要带缩进
    const listParent = placement === 'child' && targetKind === 'list';
    const listSibling = placement === 'sibling' && targetKind === 'list';
    const childIndent = listParent
        ? listContentColumn(targetFirstLine)
        : listIndentOf(targetFirstLine);
    const listIndent = placement === 'sibling' ? listIndentOf(targetFirstLine) : childIndent;
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
            block = indentBlock(['$$', '', '$$'], listIndent);
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
function clampHeading(level: number): number {
    return Math.min(6, Math.max(1, Math.round(level)));
}

/**
 * §6.3 删除节点整棵子树对应的行区间。调用方负责子树 >1 节点时先 confirm。
 */
export function deleteNode(
    markdown: string,
    tree: MindMapTreeNode,
    uid: string
): EditResult {
    const found = findNodeByUid(tree, uid);
    if (!found || !found.parent || found.node.data._kind === 'root') {
        return { text: markdown };
    }
    const { fromLine, toLine } = rangeOf(found.node);
    const lines = markdown.split('\n');
    lines.splice(fromLine, toLine - fromLine + 1);
    // 折叠删除后可能出现的连续多空行，最多保留一个空行
    const joined = lines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\n+/, '');
    return { text: joined };
}

/**
 * 删除多个节点（Ctrl 点 / Ctrl 框选之后按 Delete）。
 *
 * 关键点：
 * - 祖先与后代同时选中时只删祖先 —— 否则后删祖先会把已经删掉的区间
 *   再删一遍，行号整体错位；
 * - 行区间从后往前删，避免前面的删除影响后面的行号；
 * - 空行折叠规则与单节点删除完全一致。
 *
 * @param markdown 源全文
 * @param tree 当前导图树
 * @param uids 待删除的 uid 集合
 * @returns 新全文（root 与不存在的 uid 自动忽略）
 */
export function deleteNodes(
    markdown: string,
    tree: MindMapTreeNode,
    uids: Iterable<string>
): EditResult {
    const unique = [...new Set(uids)];
    const all = unique
        .map((uid) => findNodeByUid(tree, uid))
        .filter((found): found is FoundNode => !!found && !!found.parent)
        .filter((found) => found.node.data._kind !== 'root');
    if (all.length === 0) return { text: markdown };
    // 去掉「祖先也在选中集合里」的后代，避免同一段行区间被删两次
    const roots = all.filter(
        (found) =>
            !all.some(
                (other) =>
                    other !== found &&
                    found.node.data.uid.startsWith(`${other.node.data.uid}/`)
            )
    );
    const ranges = roots
        .map((found) => rangeOf(found.node))
        .sort((a, b) => b.fromLine - a.fromLine);
    const lines = markdown.split('\n');
    for (const range of ranges) {
        lines.splice(range.fromLine, range.toLine - range.fromLine + 1);
    }
    const joined = lines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\n+/, '');
    return { text: joined };
}

/**
 * §6.4 拖拽移动（类型不变、各走各的链）。
 *
 * @param dragUid 被拖节点 uid
 * @param newParentUid 新父 uid（root / heading / list）
 * @param anchorUid 新位置的前一个兄弟 uid（优先）；没有时用 after=false + nextUid
 * @param nextUid 新位置的后一个兄弟 uid（anchorUid 为空时使用）
 */
export function moveNode(options: {
    markdown: string;
    tree: MindMapTreeNode;
    dragUid: string;
    newParentUid: string;
    anchorUid: string | null;
    nextUid: string | null;
}): EditResult {
    const { markdown, tree, dragUid, newParentUid, anchorUid, nextUid } = options;
    const dragFound = findNodeByUid(tree, dragUid);
    const parentFound = findNodeByUid(tree, newParentUid);
    if (!dragFound || !parentFound || !dragFound.parent) return { text: markdown };
    const dragNode = dragFound.node;
    const parentNode = parentFound.node;
    if (dragNode.data._kind === 'para' || dragNode.data._kind === 'root') {
        return { text: markdown };
    }
    // 媒体节点（code/table/image）：原样搬运整段行区间，块级内容与上下空行分隔
    const mediaDrag = isMediaKind(dragNode.data._kind);

    let lines = markdown.split('\n');
    const range = rangeOf(dragNode);

    // —— 跨链类型转换判定（迭代 N2：列表项 ↔ 标题互转）——
    // 落点语境决定类型：标题落到列表链上（列表节点上 / 纯列表间隙）→ 转成
    // 列表项；列表项落到纯标题间隙 → 转成同级标题。混合锚点（一边标题一边
    // 列表）不转换，保持原类型。
    const anchorNode = anchorUid ? findNodeByUid(tree, anchorUid)?.node : null;
    const gapNextNode = nextUid ? findNodeByUid(tree, nextUid)?.node : null;
    const anchorKind = anchorNode?.data._kind ?? null;
    const gapNextKind = gapNextNode?.data._kind ?? null;
    const dragKind = dragNode.data._kind;
    let convertTo: 'heading' | 'list' | null = null;
    if (dragKind === 'heading') {
        if (parentNode.data._kind === 'list') {
            convertTo = 'list';
        } else if (
            (anchorKind === 'list' || gapNextKind === 'list') &&
            anchorKind !== 'heading' &&
            gapNextKind !== 'heading'
        ) {
            convertTo = 'list';
        }
    } else if (dragKind === 'list') {
        if (
            (anchorKind === 'heading' || gapNextKind === 'heading') &&
            anchorKind !== 'list' &&
            gapNextKind !== 'list'
        ) {
            convertTo = 'heading';
        }
    }
    // 空行分隔按「转换后的类型」算（转成标题 = 块级空行分隔；转成列表项 = 随列表链）
    const effectiveKind = convertTo ?? dragKind;

    // 按类型生成「相对新父节点正确形态」的块
    let blockLines: string[];
    if (mediaDrag) {
        blockLines = lines.slice(range.fromLine, range.toLine + 1);
        // 落到列表节点下：整段缩进到列表内容列，否则 CommonMark 会认为它已脱出列表
        if (parentNode.data._kind === 'list') {
            const indent = listContentColumn(lines[rangeOf(parentNode).fromLine] ?? '-');
            blockLines = reindentLines(blockLines, indent);
        }
    } else if (convertTo === 'list') {
        // 标题块 → 列表块：首行剥 # 改成列表项行（缩进/标记随落点），
        // 章节内容整体缩进到列表内容列（保持子树仍挂在新列表项下）
        const { indent, marker } = listMarkerForDrop(
            lines,
            anchorNode,
            gapNextNode,
            parentNode
        );
        blockLines = transformHeadingBlockToList(
            lines.slice(range.fromLine, range.toLine + 1),
            indent,
            marker
        );
    } else if (convertTo === 'heading') {
        // 列表块 → 标题块：首行剥列表标记改成标题行（层级随标题兄弟），
        // 其余行 dedent 到顶格（作为标题章节下的顶层内容）
        const siblingLevel =
            (anchorKind === 'heading'
                ? anchorNode?.data._headingLevel
                : gapNextNode?.data._headingLevel) ?? 1;
        blockLines = transformListBlockToHeading(
            lines.slice(range.fromLine, range.toLine + 1),
            siblingLevel
        );
    } else if (dragNode.data._kind === 'heading') {
        const newLevel =
            parentNode.data._kind === 'root'
                ? 1
                : (parentNode.data._headingLevel ?? 1) + 1;
        const oldLevel = dragNode.data._headingLevel ?? 1;
        blockLines = transformHeadingBlock(
            lines.slice(range.fromLine, range.toLine + 1),
            oldLevel,
            newLevel
        );
    } else {
        const sourceFirst = lines[range.fromLine] ?? '-';
        const oldIndent = listIndentOf(sourceFirst);
        const newIndent =
            parentNode.data._kind === 'list'
                ? listContentColumn(lines[rangeOf(parentNode).fromLine] ?? '-')
                : 0;
        blockLines = reindentLines(
            lines.slice(range.fromLine, range.toLine + 1),
            newIndent - oldIndent
        );
    }

    // 先在「旧文档坐标」里算出插入行，然后剪切块，再修正插入点
    let insertAt: number;
    let blankSeparated: boolean;
    if (anchorUid) {
        const anchor = findNodeByUid(tree, anchorUid);
        if (!anchor) return { text: markdown };
        insertAt = rangeOf(anchor.node).toLine + 1;
        blankSeparated =
            mediaDrag ||
            effectiveKind === 'heading' ||
            anchor.node.data._kind === 'heading';
    } else if (nextUid) {
        const next = findNodeByUid(tree, nextUid);
        if (!next) return { text: markdown };
        insertAt = rangeOf(next.node).fromLine;
        blankSeparated =
            mediaDrag ||
            effectiveKind === 'heading' ||
            next.node.data._kind === 'heading';
    } else {
        // 落到父节点中央（MOVE_NODE_TO 语义=追加为最后一个子节点）：
        // 父节点已有其它子节点时，锚到最后一个非拖拽子节点的子树末尾。
        const otherChildren = parentNode.children.filter(
            (child) => child.data.uid !== dragNode.data.uid
        );
        const lastChild = otherChildren[otherChildren.length - 1];
        if (lastChild && lastChild.data._lineRange) {
            insertAt = lastChild.data._lineRange.toLine + 1;
            blankSeparated =
                mediaDrag ||
                effectiveKind === 'heading' ||
                lastChild.data._kind === 'heading';
        } else if (parentNode.data._kind === 'root') {
            insertAt = lines.length;
            blankSeparated = mediaDrag || effectiveKind === 'heading';
        } else if (parentNode.data._kind === 'heading') {
            insertAt = rangeOf(parentNode).fromLine + 1;
            blankSeparated = true;
        } else {
            insertAt = rangeOf(parentNode).fromLine + 1;
            // 列表父节点下的媒体块是列表项内容：与上文紧挨，不强制空行
            blankSeparated = mediaDrag;
        }
    }

    // 剪切
    lines.splice(range.fromLine, range.toLine - range.fromLine + 1);
    if (insertAt > range.fromLine) {
        insertAt -= range.toLine - range.fromLine + 1;
    }
    insertAt = Math.max(0, Math.min(insertAt, lines.length));

    // 列表节点落到 heading/root 下时按顶层列表形态处理空行
    lines = insertBlockLines(lines, insertAt, blockLines, blankSeparated, markdown);
    // 剪切/插入边界可能叠出多个空行，最多保留一个
    const joined = lines.join('\n').replace(/\n{3,}/g, '\n\n');
    return { text: joined };
}

/** 插入标题块，按需补空行分隔。 */
function insertHeadingAtEnd(lines: string[], level: number, text: string): void {
    insertHeadingAt(lines, lines.length, level, text);
}

/** 在指定行位置插入标题，保证与上下内容之间有空行。 */
function insertHeadingAt(
    lines: string[],
    at: number,
    level: number,
    text: string
): void {
    const block = ['#'.repeat(level) + ' ' + text];
    const result = insertBlockLines(lines, at, block, true, lines.join('\n'));
    lines.length = 0;
    lines.push(...result);
}

/** 插入列表项；insideList=true 时与上层列表紧挨，不强制空行。 */
function insertListItem(
    lines: string[],
    at: number,
    indent: number,
    ordered: boolean,
    text: string,
    blankBefore: boolean
): void {
    const marker = ordered ? '1. ' : '- ';
    const block = [' '.repeat(indent) + marker + text];
    const result = insertBlockLines(lines, at, block, blankBefore, lines.join('\n'));
    lines.length = 0;
    lines.push(...result);
}

/**
 * 把整块行插入指定位置，按需在块前后补空行，避免标题 / 列表与正文粘连。
 */
function insertBlockLines(
    lines: string[],
    at: number,
    block: string[],
    blankSeparated: boolean,
    _original: string
): string[] {
    const next = [...lines];
    const insert: string[] = [];
    if (blankSeparated && at > 0 && (next[at - 1] ?? '').trim() !== '') {
        insert.push('');
    }
    insert.push(...block);
    if (blankSeparated && at < next.length && (next[at] ?? '').trim() !== '') {
        insert.push('');
    }
    next.splice(at, 0, ...insert);
    return next;
}

/** 取列表行的前导缩进空格数。 */
function listIndentOf(line: string): number {
    const match = /^(\s*)/.exec(line);
    return match ? match[1].replace(/\t/g, '    ').length : 0;
}

/**
 * 列表行内容列的位置（前导缩进 + marker + marker 后空白）。
 *
 * 子列表必须缩进到这一列才能被 CommonMark 识别为嵌套：
 * 无序列表 marker 宽 2（`- `），有序列表宽 3+（`1. `），
 * 统一按「缩进 +2」会让有序列表的子项退化成同级列表。
 */
function listContentColumn(line: string): number {
    const match = /^(\s*(?:[-*+]|\d+[.)])\s+)/.exec(line);
    return match ? match[1].replace(/\t/g, '    ').length : listIndentOf(line) + 2;
}

/** 整块统一增减缩进（delta 为负时逐行去缩进）。 */
function reindentLines(block: string[], delta: number): string[] {
    return block.map((line) => {
        if (line.trim() === '') return line;
        if (delta >= 0) return ' '.repeat(delta) + line;
        const remove = Math.min(-delta, listIndentOf(line));
        return line.slice(remove);
    });
}

// ==================================================================
// 跨链类型转换（迭代 N2：列表项 ↔ 标题互转）
// ==================================================================

/**
 * 落点的列表形态（缩进 + 标记）：标题转列表项时用。
 *
 * - 间隙落点：跟随锚点列表项的缩进与列表类型；有序锚点递增/递减序号；
 * - 节点落点（无锚点，追加为子节点）：缩进到父列表的内容列，
 *   有序父取「现有子节点数 + 1」为序号，无序父用 `-`。
 */
function listMarkerForDrop(
    lines: string[],
    anchorNode: MindMapTreeNode | null | undefined,
    gapNextNode: MindMapTreeNode | null | undefined,
    parentNode: MindMapTreeNode
): { indent: number; marker: string } {
    /** 解析列表行：缩进 / 标记文本 / 是否有序 / 序号。 */
    const parseListLine = (
        line: string
    ): { indent: number; markerText: string; ordered: boolean; num: number } | null => {
        const m = /^(\s*)([-*+]|(\d+)[.)])(\s+)/.exec(line);
        if (!m) return null;
        return {
            indent: m[1].replace(/\t/g, '    ').length,
            markerText: m[2],
            ordered: m[3] !== undefined,
            num: m[3] !== undefined ? Number(m[3]) : 0,
        };
    };
    // 间隙落点：优先跟前一个兄弟
    for (const sibling of [anchorNode, gapNextNode]) {
        if (!sibling?.data._lineRange) continue;
        const line = lines[sibling.data._lineRange.fromLine] ?? '';
        const parsed = parseListLine(line);
        if (!parsed) continue;
        if (!parsed.ordered) return { indent: parsed.indent, marker: parsed.markerText };
        const num = sibling === anchorNode ? parsed.num + 1 : Math.max(1, parsed.num - 1);
        return { indent: parsed.indent, marker: `${num}.` };
    }
    // 节点落点：追加为列表节点的最后一个子节点
    if (parentNode.data._lineRange) {
        const parentLine = lines[parentNode.data._lineRange.fromLine] ?? '-';
        const indent = listContentColumn(parentLine);
        const ordered = parentNode.data._listOrdered === true;
        return {
            indent,
            marker: ordered ? `${parentNode.children.length + 1}.` : '-',
        };
    }
    return { indent: 0, marker: '-' };
}

/**
 * 标题块 → 列表块（N2）。
 *
 * 首行剥 `#` 改成列表项行；其余行（章节内容）整体缩进到列表内容列，
 * 保证重建后子树仍挂在新列表项下。章节里的子标题留在原地（合法 md，
 * 但列表项内的标题不进导图——已知边界，见进度档案）。
 */
function transformHeadingBlockToList(
    block: string[],
    indent: number,
    marker: string
): string[] {
    const result = [...block];
    const first = result[0] ?? '';
    const m = /^(\s*)#{1,6}\s+(.*)$/.exec(first);
    const text = m ? m[2] : first.trim();
    result[0] = ' '.repeat(indent) + marker + ' ' + text;
    const contentCol = indent + marker.length + 1;
    for (let i = 1; i < result.length; i++) {
        if (result[i].trim() === '') continue;
        result[i] = ' '.repeat(contentCol) + result[i];
    }
    return result;
}

/**
 * 列表块 → 标题块（N2）。
 *
 * 首行剥列表标记改成标题行（层级随标题兄弟）；其余行 dedent 到顶格，
 * 作为标题章节下的顶层内容（导图重建时子列表/段落仍是该标题的子节点）。
 */
function transformListBlockToHeading(block: string[], level: number): string[] {
    const result = [...block];
    const first = result[0] ?? '';
    const m = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(first);
    const text = m ? m[2] : first.trim();
    const clamped = Math.min(6, Math.max(1, level));
    result[0] = '#'.repeat(clamped) + ' ' + text;
    const contentCol = m ? listContentColumn(first) : 0;
    for (let i = 1; i < result.length; i++) {
        if (result[i].trim() === '') continue;
        const remove = Math.min(contentCol, listIndentOf(result[i]));
        result[i] = result[i].slice(remove);
    }
    return result;
}

/**
 * 移动标题块：块内所有 ATX 标题整体偏移层级，最深截断为 H6；
 * 非标题行原样返回。
 */
function transformHeadingBlock(
    block: string[],
    oldLevel: number,
    newLevel: number
): string[] {
    const delta = newLevel - oldLevel;
    return block.map((line) => {
        const match = /^(\s*)(#{1,6})(\s+.*)$/.exec(line);
        if (!match) return line;
        const level = Math.min(6, match[2].length + delta);
        if (level <= 0) return line;
        return match[1] + '#'.repeat(level) + match[3];
    });
}
