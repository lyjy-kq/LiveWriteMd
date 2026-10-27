/**
 * 导图 Markdown 回写（从 markdownEdit.ts 拆出）：§6.3 删除族。
 *
 * 全部是纯函数：输入 markdown 全文与节点信息，返回编辑结果。
 *
 * @module webview/mindmap/edit/remove
 */

import { extendRangeOverHr } from './add.js';
import { listIndentOf } from './move.js';
import { EditResult, FoundNode, findNodeByUid, rangeOf } from './shared.js';
import type { MindMapTreeNode, NodeLineRange } from '../types.js';


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
