/**
 * 逻辑结构（向右生长）布局。
 *
 * 算法是 O(n) 的两遍递归：
 * 1. 后序：算出每个节点「可见子树的纵向占位高度」；
 * 2. 前序：按占位高度把子树纵向居中到父节点，子节点从父节点右侧
 *    （width + H_GAP）开始依次向下排列。
 *
 * 只排版可见节点 —— 折叠子树的尺寸不参与计算，展开/收起时重排一次
 * 就能得到正确结果，不需要「隐藏后再测」之类的补丁。
 */

import type { MapNode } from './model.js';

/** 父子之间的水平间距（像素）。 */
export const H_GAP = 48;
/** 兄弟子树之间的纵向间距（像素）。 */
export const V_GAP = 16;

/** 可见子节点（折叠时为空数组）。 */
function visibleChildren(node: MapNode): MapNode[] {
    return node.expand ? node.children : [];
}

/**
 * 后序遍历：计算 subtreeHeight。
 *
 * @param node 子树根
 * @returns 该子树占用的纵向高度
 */
function measureSubtree(node: MapNode): number {
    const children = visibleChildren(node);
    if (children.length === 0) {
        node.subtreeHeight = node.height;
        return node.subtreeHeight;
    }
    let total = 0;
    children.forEach((child, index) => {
        total += measureSubtree(child);
        if (index > 0) total += V_GAP;
    });
    node.subtreeHeight = Math.max(node.height, total);
    return node.subtreeHeight;
}

/**
 * 前序遍历：写回 x/y。
 *
 * @param node 子树根
 * @param left 子树左边界
 * @param top 子树上边界
 */
function place(node: MapNode, left: number, top: number): void {
    node.x = left;
    // 节点自身在子树占位里纵向居中：高度不一致时连线仍然水平对齐
    node.y = top + (node.subtreeHeight - node.height) / 2;
    const children = visibleChildren(node);
    if (children.length === 0) return;

    let childrenHeight = 0;
    children.forEach((child, index) => {
        childrenHeight += child.subtreeHeight;
        if (index > 0) childrenHeight += V_GAP;
    });
    let childTop = top + (node.subtreeHeight - childrenHeight) / 2;
    const childLeft = left + node.width + H_GAP;
    for (const child of children) {
        place(child, childLeft, childTop);
        childTop += child.subtreeHeight + V_GAP;
    }
}

/**
 * 对整棵可见树重新布局。
 *
 * @param root 根节点
 */
export function layoutMap(root: MapNode): void {
    measureSubtree(root);
    place(root, 0, 0);
}

/** 世界坐标包围盒。 */
export interface MapBounds {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
}

/**
 * 计算可见节点的包围盒（导出 / 适应画布用）。
 *
 * @param root 根节点
 * @returns 世界坐标包围盒；树为空时返回 0 尺寸
 */
export function computeBounds(root: MapNode): MapBounds {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    const stack: MapNode[] = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        if (!node) break;
        left = Math.min(left, node.x);
        top = Math.min(top, node.y);
        right = Math.max(right, node.x + node.width);
        bottom = Math.max(bottom, node.y + node.height);
        if (!node.expand) continue;
        for (const child of node.children) stack.push(child);
    }
    if (!Number.isFinite(left)) {
        return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    return {
        left,
        top,
        right,
        bottom,
        width: right - left,
        height: bottom - top,
    };
}
