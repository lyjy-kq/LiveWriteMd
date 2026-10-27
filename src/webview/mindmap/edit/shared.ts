/**
 * 导图 Markdown 回写（从 markdownEdit.ts 拆出）：公共件：EditResult / 树查找辅助。
 *
 * 全部是纯函数：输入 markdown 全文与节点信息，返回编辑结果。
 *
 * @module webview/mindmap/edit/shared
 */

import type { MindMapTreeNode } from '../types.js';


/** 新节点默认文本。 */
export const NEW_NODE_TEXT = '分支主题';


/** 编辑操作结果：新全文 + 新节点 uid（新增时用于立即进入编辑态）。 */
export interface EditResult {
    text: string;
    /** 新增节点的路径式 uid；仅新增操作返回。 */
    newNodeUid?: string;
}


/** 树查找结果。 */
export interface FoundNode {
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
export function rangeOf(node: MindMapTreeNode): { fromLine: number; toLine: number } {
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
