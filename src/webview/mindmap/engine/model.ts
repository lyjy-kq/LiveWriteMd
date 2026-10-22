/**
 * 导图引擎的纯数据模型。
 *
 * 设计原则：
 * - 一份模型只描述「树 + 布局状态」，不掺任何渲染逻辑；
 * - uid 继续沿用 treeBuilder 的路径式 uid（"0/2/1"），搜索/编辑/大纲联动
 *   的既有约定完全不变；
 * - 渲染需要的 DOM 引用（wrapper / display）挂在模型上，生命周期由
 *   MapCanvas 统一管理 —— 这里只声明字段，不做创建/销毁。
 *
 * 与 simple-mind-map 的 { data, children } 树一一对应：buildMapModel()
 * 负责一次性转换，之后引擎只跟 MapNode 打交道。
 */

import type { NodeDisplay } from '../miniCm.js';
import type {
    MindMapNodeKind,
    MindMapNodePayload,
    MindMapTreeNode,
} from '../types.js';

/**
 * 引擎节点。
 *
 * 坐标体系：世界坐标（未缩放），root 左上角为 (0,0)，子节点向右生长。
 * x/y 是节点自身的左上角，subtreeHeight 只在布局阶段使用。
 */
export interface MapNode {
    /** 路径式 uid（与源文档树一致）。 */
    uid: string;
    /** 节点类型（root/heading/list/para/code/...）。 */
    kind: MindMapNodeKind;
    /** 节点显示文本（标题去掉 # 标记后的内容）。 */
    text: string;
    /** 悬停提示（段落全文等，可空）。 */
    note?: string;
    /** 原始负载，编辑/提交逻辑按需读取（_lineRange 等）。 */
    data: MindMapNodePayload;
    /** 父节点（root 为 null）。 */
    parent: MapNode | null;
    /** 子节点。 */
    children: MapNode[];
    /** 深度（root = 0）。 */
    depth: number;
    /** 是否展开（有子节点且被收起时为 false）。 */
    expand: boolean;

    // —— 布局（由 layout.ts 填充）——
    x: number;
    y: number;
    width: number;
    height: number;
    /** 整棵可见子树的纵向占位高度（含自身）。 */
    subtreeHeight: number;
    /**
     * 后代节点总数（含所有层级，不受展开状态影响）。
     *
     * 折叠按钮上显示「收起了几项」用：不能按可见子树算，否则父节点收起时
     * 里面本来已经折叠的孙辈就漏掉了。
     */
    descendantCount: number;

    // —— 渲染状态（由 MapCanvas 维护）——
    /** 是否已经量过尺寸（占位/真实内容都算）。 */
    measured: boolean;
    /** 节点包裹元素（跨渲染复用，保证 CM 不被反复搬迁）。 */
    wrapper: HTMLElement | null;
    /** 真实显示实例（mini-CM）；未创建或已逐出时为 null。 */
    display: NodeDisplay | null;
    /** 当前内容是否是静态占位（等待换真）。 */
    placeholder: boolean;
}

/** 新建一个 MapNode（内部使用，避免外部手工填一堆默认值）。 */
function createNode(
    data: MindMapNodePayload,
    parent: MapNode | null,
    depth: number
): MapNode {
    return {
        uid: data.uid,
        kind: data._kind,
        text: data.text,
        note: data.note,
        data,
        parent,
        children: [],
        depth,
        // 有子节点才谈得上展开；叶子节点 expand 恒为 true，省得各处判空
        expand: data.expand !== false,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        subtreeHeight: 0,
        descendantCount: 0,
        measured: false,
        wrapper: null,
        display: null,
        placeholder: false,
    };
}

/**
 * 把 treeBuilder 产出的数据树转换成引擎模型。
 *
 * @param tree 源数据树
 * @returns 根 MapNode；children 顺序与源文档行序一致
 */
export function buildMapModel(tree: MindMapTreeNode): MapNode {
    const root = createNode(tree.data, null, 0);
    const stack: Array<{ src: MindMapTreeNode; out: MapNode }> = [{ src: tree, out: root }];
    while (stack.length > 0) {
        const item = stack.pop();
        if (!item) break;
        for (const child of item.src.children) {
            const node = createNode(child.data, item.out, item.out.depth + 1);
            item.out.children.push(node);
            stack.push({ src: child, out: node });
        }
    }
    // 自底向上累加后代数：children 已经建好，倒序（后序）一趟即可。
    // 放在建模阶段算，避免每帧同步展开按钮时对每个折叠节点递归数子树。
    const order: MapNode[] = [];
    walkAll(root, (node) => {
        order.push(node);
    });
    for (let i = order.length - 1; i >= 0; i -= 1) {
        const node = order[i];
        let count = 0;
        for (const child of node.children) count += child.descendantCount + 1;
        node.descendantCount = count;
    }
    return root;
}

/**
 * 遍历全部节点（含被折叠的子树）。
 *
 * @param root 根节点
 * @param visit 访问回调；返回 false 可跳过该节点的子树
 */
export function walkAll(root: MapNode, visit: (node: MapNode) => void | false): void {
    const stack: MapNode[] = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        if (!node) break;
        if (visit(node) === false) continue;
        for (let i = node.children.length - 1; i >= 0; i -= 1) {
            stack.push(node.children[i]);
        }
    }
}

/**
 * 遍历**可见**节点（折叠的子树不进入）。
 *
 * 布局、命中测试、视口挂载都只关心可见节点，避免每帧遍历整棵树。
 *
 * @param root 根节点
 * @param visit 访问回调
 */
export function walkVisible(root: MapNode, visit: (node: MapNode) => void): void {
    const stack: MapNode[] = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        if (!node) break;
        visit(node);
        if (!node.expand) continue;
        for (let i = node.children.length - 1; i >= 0; i -= 1) {
            stack.push(node.children[i]);
        }
    }
}

/**
 * 按 uid 查节点。
 *
 * @param root 根节点
 * @param uid 路径式 uid
 * @returns 命中的节点；不存在时返回 null
 */
export function findMapNode(root: MapNode, uid: string): MapNode | null {
    let current: MapNode | null = root;
    if (uid === root.uid) return root;
    // uid 是路径："0/2/1" → 根以下 children[2].children[1]，
    // 直接按段走，O(depth)，不用全树遍历。
    //
    // 第一段是**根自己的 uid**（"0"），必须跳过；从根出发再消费它
    // 会整体多下钻一层，导致 revealUid（搜索跳转展开折叠祖先）永远
    // 找不到目标、折叠的节点跳不过去。
    const relative = uid.startsWith(`${root.uid}/`)
        ? uid.slice(root.uid.length + 1)
        : uid;
    if (!relative) return null;
    const parts = relative.split('/');
    for (const raw of parts) {
        const index = Number(raw);
        if (!Number.isInteger(index) || index < 0) return null;
        current = current?.children[index] ?? null;
        if (!current) return null;
    }
    return current;
}

/**
 * 收集一个节点及其全部后代（拖动时用于排除「拖进自己子树」）。
 *
 * @param node 子树根
 * @returns uid 集合
 */
export function collectSubtreeUids(node: MapNode): Set<string> {
    const set = new Set<string>();
    walkAll(node, (n) => {
        set.add(n.uid);
    });
    return set;
}

/**
 * 按 uid 找到节点并展开其所有祖先（大纲跳转 / 搜索跳转用）。
 *
 * @param root 根节点
 * @param uid 目标 uid
 * @returns 是否真的有祖先被展开
 */
export function expandAncestors(root: MapNode, uid: string): boolean {
    const target = findMapNode(root, uid);
    if (!target) return false;
    let changed = false;
    let current = target.parent;
    while (current) {
        if (!current.expand) {
            current.expand = true;
            changed = true;
        }
        current = current.parent;
    }
    return changed;
}

/** 清空一棵子树的展开标记（展开全部子节点用）。 */
export function expandSubtree(node: MapNode): void {
    walkAll(node, (n) => {
        n.expand = true;
    });
}
