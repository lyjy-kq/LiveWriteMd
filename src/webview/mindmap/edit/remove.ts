/**
 * 导图 Markdown 回写（从 markdownEdit.ts 拆出）：§6.3 删除族。
 *
 * 全部是纯函数：输入 markdown 全文与节点信息，返回编辑结果。
 *
 * @module webview/mindmap/edit/remove
 */

import { extendRangeOverHr } from './add.js';
import { listIndentOf } from './move.js';
import { shiftHeadingLevel } from './clipboard.js';
import { EditResult, FoundNode, findNodeByUid, rangeOf } from './shared.js';
import type { MindMapTreeNode, NodeLineRange } from '../types.js';
import { reindentLines } from './move.js';


/**
 * §6.3 删除节点整棵子树对应的行区间。调用方负责子树 >1 节点时先 confirm。
 *
 * 节点前后紧贴的 `---` 分割行（含中间空行）会一并删掉（见 extendRangeOverHr）。
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
    const lines = markdown.split('\n');
    const { fromLine, toLine } = extendRangeOverHr(
        lines,
        rangeOf(found.node).fromLine,
        rangeOf(found.node).toLine
    );
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
    const lines = markdown.split('\n');
    // 每个区间向前后扩到紧贴的 `---` 分割行（与单删同规则）。
    // 相邻两个待删节点可能同时吃到中间那条 `---`：扩展后区间会重叠，
    // 先合并再删，否则同一行会被 splice 两次、误删后面一行。
    const ranges = roots
        .map((found) => {
            const r = rangeOf(found.node);
            return extendRangeOverHr(lines, r.fromLine, r.toLine);
        })
        .sort((a, b) => b.fromLine - a.fromLine);
    const merged: typeof ranges = [];
    for (const range of ranges) {
        const prev = merged[merged.length - 1];
        // ranges 按 fromLine 降序：prev 在 range 下面（行号更大）
        if (prev && range.toLine >= prev.fromLine - 1) {
            prev.fromLine = Math.min(prev.fromLine, range.fromLine);
        } else {
            merged.push({ ...range });
        }
    }
    for (const range of merged) {
        lines.splice(range.fromLine, range.toLine - range.fromLine + 1);
    }
    const joined = lines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\n+/, '');
    return { text: joined };
}


/**
 * 只删除节点自己，子节点整体上移一级（导图里最常用的「删掉这一层」）。
 *
 * 和 {@link deleteNode}（连整棵子树一起删）不同，这里要保证：
 *
 * 1. **子节点接替被删节点的位置** —— 标题链减少 `#` 数（`### C` → `## C`），
 *    列表链把缩进退到被删节点的标记列（`    - C` → `  - C`）；
 *    被删的是标题时，它的**列表项子节点**会转成同级别的标题
 *    （`## 标题` 下的 `- A / - B` → `## A / ## B`，见函数内注释）；
 * 2. 子节点的**整棵子树**一起平移，子树内部的相对层级不能变；
 * 3. 被删节点自身的区间用 `_selfLineRange`，不能把子节点的行也删掉
 *    （`_lineRange` 是含子树的，见 types.ts 的字段说明）。
 *
 * 先平移子节点、再删自身：两步都用原始行号，不需要来回换算。
 *
 * @param markdown 源全文
 * @param tree 当前导图树
 * @param uid 被删除的节点 uid
 * @returns 新全文（root 自动忽略）
 */
export function deleteSelfKeepChildren(
    markdown: string,
    tree: MindMapTreeNode,
    uid: string
): EditResult {
    const found = findNodeByUid(tree, uid);
    if (!found || !found.parent || found.node.data._kind === 'root') {
        return { text: markdown };
    }
    const node = found.node;
    const lines = markdown.split('\n');
    const self = (node.data._selfLineRange as NodeLineRange | undefined) ?? rangeOf(node);
    /** 被删节点的标记列：列表是缩进，标题就是行首空白 */
    const nodeIndent = listIndentOf(lines[self.fromLine] ?? '');
    const nodeLevel = node.data._headingLevel ?? 1;

    for (const child of node.children) {
        const childRange = child.data._lineRange as NodeLineRange | undefined;
        if (!childRange) continue;
        const block = lines.slice(childRange.fromLine, childRange.toLine + 1);

        if (node.data._kind === 'heading' && child.data._kind === 'heading') {
            // 标题链：子标题顶上被删节点的级别（正常情况下正好 -1）
            const delta = Math.max(
                0,
                (child.data._headingLevel ?? 1) - nodeLevel
            );
            if (delta > 0) {
                lines.splice(
                    childRange.fromLine,
                    block.length,
                    ...shiftHeadingLevel(block, delta)
                );
            }
            continue;
        }

        if (node.data._kind === 'heading' && child.data._kind === 'list') {
            // 列表项提升成与被删标题**同级**的标题。
            //
            // 场景：`## 事实库现状` 下面只有 `- A / - B / - C`。删掉标题后，
            // 列表在 Markdown 里没法「平移」到上一级标题之下——文档中部的
            // 顶层列表会归入**上一个标题**的章节（内容看起来跑进了前一个
            // 兄弟），所以只能把每个列表项转成同级标题，才能留在原来的层级。
            //
            // 转换规则：
            //   - A 标题文字          ->  ## A 标题文字
            //     - 嵌套子项          ->  - 嵌套子项（整块左移到行首，仍是它的子节点）
            //     A 的续行            ->  A 的续行（紧贴标题，treeBuilder 会并回标题）
            // 有序列表的序号 / 任务标记属于列表语法：序号丢弃，任务标记保留在
            // 文字里（`## [x] foo`），避免把勾选状态弄丢。
            const childSelf =
                (child.data._selfLineRange as NodeLineRange | undefined) ?? childRange;
            const firstLine = lines[childSelf.fromLine] ?? '';
            const mark =
                /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/.exec(firstLine);
            if (mark) {
                // 内容列（字符数）= 缩进 + marker + marker 后空白 + 任务标记；
                // 续行与嵌套子列表都缩进到这一列，整块去掉它即可。
                const contentColumn =
                    mark[1].length + mark[2].length + mark[3].length + (mark[4] ?? '').length;
                const replacement = block.map((line) => {
                    if (line.trim() === '') return line;
                    let index = 0;
                    let consumed = 0;
                    while (
                        index < line.length &&
                        consumed < contentColumn &&
                        (line[index] === ' ' || line[index] === '\t')
                    ) {
                        index += 1;
                        consumed += 1;
                    }
                    return line.slice(index);
                });
                replacement[0] =
                    `${'#'.repeat(nodeLevel)} ${((mark[4] ?? '') + mark[5]).trimEnd()}`;
                lines.splice(childRange.fromLine, block.length, ...replacement);
            }
            continue;
        }

        // 列表 / 段落 / 媒体：子项首行的缩进退到被删节点的标记列。
        // 每个直接子节点单独算 delta —— 容错文档里兄弟缩进不一定完全一致。
        const childSelf =
            (child.data._selfLineRange as NodeLineRange | undefined) ?? childRange;
        const childIndent = listIndentOf(lines[childSelf.fromLine] ?? '');
        const delta = childIndent - nodeIndent;
        if (delta > 0) {
            lines.splice(
                childRange.fromLine,
                block.length,
                ...reindentLines(block, -delta)
            );
        }
    }

    // 删掉节点自身（含标题的续行 / setext 下划线），子节点行保持原样
    lines.splice(self.fromLine, self.toLine - self.fromLine + 1);
    const joined = lines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\n+/, '');
    return { text: joined };
}


/**
 * 删除标题格式 / 删除列表格式：把节点所在的那一组兄弟整体降成普通文本。
 *
 * 为什么必须**整组**处理、且要求所有兄弟同格式：
 * - 只剥掉其中某一个标题的 `#`，剩下的兄弟还是标题，Markdown 会把这个
 *   普通段落并进前一个兄弟的章节里 —— 层级直接乱掉；
 * - 整组一起剥，这一层就从「标题链 / 列表链」变成普通段落，兄弟关系保持原样。
 *
 * 标题组：兄弟和它们**子树里所有标题**一起剥（`## 文字` → `文字`，
 * setext 的 `===` / `---` 下划线行删掉）。只剥到兄弟这一层的话，
 * 中间的 H3 仍会把后面被剥掉的兄弟“吸”成自己的子节点，导图里层级就错了。
 * 列表组：去掉 `- ` / `1. ` 标记，子树整体左移到父项内容列；
 * 任务标记 `[x]` 属于列表语法，转成普通文字后保留勾选状态。
 *
 * 剥掉标记后相邻两行会被并成同一个段落，所以段落之间要补空行。
 *
 * @param markdown 源全文
 * @param tree 当前导图树
 * @param uid 触发操作的节点 uid（root / 媒体 / 段落不适用）
 * @returns 新全文；兄弟格式不一致时原样返回
 */
export function deleteNodeFormat(
    markdown: string,
    tree: MindMapTreeNode,
    uid: string
): EditResult {
    const found = findNodeByUid(tree, uid);
    if (!found || !found.parent) return { text: markdown };
    const kind = found.node.data._kind;
    if (kind !== 'heading' && kind !== 'list') return { text: markdown };
    // 兄弟 = 父节点的全部子节点。元数据（front matter）不是内容兄弟，忽略。
    const siblings = found.parent.children.filter(
        (child) => child.data._kind !== 'meta'
    );
    if (
        siblings.length === 0 ||
        siblings.some((child) => child.data._kind !== kind)
    ) {
        return { text: markdown };
    }

    const lines = markdown.split('\n');
    const entries = siblings
        .map((node) => ({
            node,
            range: node.data._lineRange as NodeLineRange | undefined,
        }))
        .filter(
            (entry): entry is { node: MindMapTreeNode; range: NodeLineRange } =>
                !!entry.range
        )
        // 从后往前改：setext 会删行、补空行会增行，前面的行号不受影响
        .sort((a, b) => b.range.fromLine - a.range.fromLine);
    for (const { node, range } of entries) {
        const block = lines.slice(range.fromLine, range.toLine + 1);
        const converted =
            kind === 'heading'
                ? stripHeadingBlock(node, range, lines)
                : stripListBlock(block);
        // 前后补空行：剥掉标记后，紧挨着的普通行会并进同一个段落。
        // 原位置已经空着就不重复补；最后统一折叠多余空行。
        if (range.fromLine > 0 && (lines[range.fromLine - 1] ?? '').trim() !== '') {
            converted.unshift('');
        }
        if ((lines[range.toLine + 1] ?? '').trim() !== '') {
            converted.push('');
        }
        lines.splice(range.fromLine, block.length, ...converted);
    }
    const joined = lines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\n+/, '');
    return { text: joined };
}


/**
 * 标题块 → 普通段落块：兄弟自己 + 子树里所有标题一起剥掉标记。
 *
 * 用树节点的 `_selfLineRange` 定位标题行，而不是正则扫全文 ——
 * 围栏代码 / 引用里的 `#` 不是导图节点，必须原样保留。
 *
 * - ATX：去掉行首 `#{1,6}`（保留缩进）；
 * - setext：下划线行紧跟在标题文字行后面，直接删掉。
 *
 * 剥完的标题变成普通段落：相邻段落之间补空行，否则会被并成同一段。
 */
function stripHeadingBlock(
    node: MindMapTreeNode,
    range: NodeLineRange,
    lines: string[]
): string[] {
    /** 需要剥掉 `#` 的 ATX 标题行（绝对行号）。 */
    const stripLines = new Set<number>();
    /** 需要整行删除的 setext 下划线行（绝对行号）。 */
    const dropLines = new Set<number>();
    const collect = (current: MindMapTreeNode): void => {
        if (current.data._kind === 'heading') {
            const self = current.data._selfLineRange as
                | NodeLineRange
                | undefined;
            if (self) {
                const line = lines[self.fromLine] ?? '';
                if (/^[ \t]*#{1,6}(?:[ \t]+|$)/.test(line)) {
                    stripLines.add(self.fromLine);
                } else {
                    // setext：下划线紧跟在标题文字行后面
                    dropLines.add(self.fromLine + 1);
                }
            }
        }
        current.children.forEach(collect);
    };
    collect(node);

    const converted: string[] = [];
    for (let i = range.fromLine; i <= range.toLine; i += 1) {
        if (dropLines.has(i)) {
            // 下划线删掉后，标题文字会跟下一行并成同一段：原位补一个空行
            if (
                converted.length > 0 &&
                converted[converted.length - 1].trim() !== '' &&
                (lines[i + 1] ?? '').trim() !== ''
            ) {
                converted.push('');
            }
            continue;
        }
        const line = lines[i] ?? '';
        if (!stripLines.has(i)) {
            converted.push(line);
            continue;
        }
        // 剥掉 # 后就是普通段落：前后都要有空行，避免跟相邻段落粘连
        if (
            converted.length > 0 &&
            converted[converted.length - 1].trim() !== ''
        ) {
            converted.push('');
        }
        converted.push(line.replace(/^([ \t]*)#{1,6}(?:[ \t]+|$)/, '$1'));
        const next = lines[i + 1] ?? '';
        if (!dropLines.has(i + 1) && next.trim() !== '') converted.push('');
    }
    return converted;
}


/**
 * 列表项块 → 普通段落块：剥掉首行标记，子树整体左移到父项内容列。
 *
 * 左移量是「标记 + 标记后空白」（不含缩进）：
 * 顶层列表因此顶格，嵌套列表则留在父列表项的内容列里 ——
 * 子节点上提一级，但不会跳出父项。
 */
function stripListBlock(block: string[]): string[] {
    const first = block[0] ?? '';
    const mark = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/.exec(
        first
    );
    if (!mark) return block;
    // 标记宽度（Tab 按 4 空格算，和 listIndentOf 保持同一口径）
    const markerWidth =
        mark[2].replace(/\t/g, '    ').length +
        mark[3].replace(/\t/g, '    ').length +
        (mark[4] ?? '').replace(/\t/g, '    ').length;
    return block.map((line, index) => {
        if (index === 0) {
            // 任务标记 [x] 当普通文字保留，勾选状态不会丢
            return mark[1] + (mark[4] ?? '') + mark[5];
        }
        if (line.trim() === '') return line;
        const remove = Math.min(markerWidth, listIndentOf(line));
        return line.slice(remove);
    });
}


/**
 * 只删除节点的全部子节点，保留节点自己。
 *
 * 子节点的 `_lineRange` 已经包含各自的整棵子树，所以直接按区间删；
 * 从后往前删，避免前面的删除影响后面的行号。
 *
 * @param markdown 源全文
 * @param tree 当前导图树
 * @param uid 保留的节点 uid
 * @returns 新全文（没有子节点 / root 时原样返回）
 */
export function deleteChildNodes(
    markdown: string,
    tree: MindMapTreeNode,
    uid: string
): EditResult {
    const found = findNodeByUid(tree, uid);
    if (!found || found.node.children.length === 0) {
        return { text: markdown };
    }
    const lines = markdown.split('\n');
    const ranges = found.node.children
        .map((child) => child.data._lineRange as NodeLineRange | undefined)
        .filter((range): range is NodeLineRange => !!range)
        .sort((a, b) => b.fromLine - a.fromLine);
    if (ranges.length === 0) return { text: markdown };
    for (const range of ranges) {
        lines.splice(range.fromLine, range.toLine - range.fromLine + 1);
    }
    const joined = lines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\n+/, '');
    return { text: joined };
}
