/**
 * MindMapApp 协作模块（从 mindmapApp.ts 拆出）：拖拽落点校验与 uid 重映射。
 *
 * 全部是原 MindMapApp 方法，this 换成第一参数 app；跨模块调用走 app 上的薄包装方法。
 *
 * @module webview/mindmap/app/appDragDrop
 */

import type { MindMapApp } from '../mindmapApp.js';
import { moveNode } from '.././edit/move.js';
import { isMediaKind } from '.././edit/rename.js';
import type { DropPayload } from '.././engine/canvas.js';
import type { MapNode } from '.././engine/model.js';
import { buildMindMapTree } from '.././treeBuilder.js';
import type { MindMapTreeNode } from '.././types.js';
import { findNodeByUid as findTreeNodeByUid } from '../edit/shared.js';


// ==================================================================
// 拖动
// ==================================================================

/** 落点预校验：类型不变、各走各的链，para/root 不可拖。 */
export function validateDropParent(app: MindMapApp, dragUid: string, parentUid: string) : boolean {
    const drag = app.canvas.getNode(dragUid);
    const parent = app.canvas.getNode(parentUid);
    if (!drag || !parent) return false;
    const kind = drag.kind;
    const media = isMediaKind(kind);
    if (kind !== 'heading' && kind !== 'list' && !media) return false;
    const parentKind = parent.kind;
    if (
        (kind === 'heading' || kind === 'list' || media) &&
        parentKind !== 'root' &&
        parentKind !== 'heading' &&
        parentKind !== 'list'
    ) {
        return false;
    }
    // 禁止拖进自己的子树
    let ancestor: MapNode | null = parent;
    while (ancestor) {
        if (ancestor.uid === dragUid) return false;
        ancestor = ancestor.parent;
    }
    return true;
}


/**
 * 拖动结束：按落点回写 md，然后按「旧 uid → 新 uid」映射复用 DOM。
 */
export function handleDrop(app: MindMapApp, payload: DropPayload) : void {
    if (!app.currentTree) return;
    const { dragUid, parentUid, prevUid, nextUid } = payload;
    if (!app.validateDropParent(dragUid, parentUid)) {
        // 非法落点：用当前树重排一次，让被拖节点回到原位
        app.canvas.setData(app.bakeExpandState(app.currentTree), { keepView: true });
        app.syncInternalLinks();
        return;
    }
    const result = moveNode({
        markdown: app.markdown,
        tree: app.currentTree,
        dragUid,
        newParentUid: parentUid,
        anchorUid: prevUid,
        nextUid,
    });
    if (!result.text || result.text === app.markdown) {
        // 原地放下（位置没变）：重排一次即可
        app.canvas.setData(app.bakeExpandState(app.currentTree), { keepView: true });
        app.syncInternalLinks();
        return;
    }

    const previousTree = app.currentTree;
    const newTree = buildMindMapTree(result.text, app.fileName);
    const remap = app.computeDropRemap(dragUid, parentUid, previousTree, newTree);
    // uid 是路径，拖动后整棵被拖子树都会换 uid：把按 uid 记的
    // 展开/折叠/已知集合与画布标记一起重定向，否则折叠态会丢。
    app.remapUidSets(remap);
    app.canvas.remapFlags(remap);
    app.setMarkdown(result.text);
    app.currentTree = newTree;
    app.canvas.setData(app.bakeExpandState(newTree), {
        uidRemap: remap,
        keepView: true,
    });
    app.syncInternalLinks();
    app.options.onEdit(result.text);
    app.searchBar.refreshAfterDocumentChange();
    // 拖动后选中被移动的节点（uid 可能变了）
    const newUid = remap.get(dragUid) ?? dragUid;
    if (app.canvas.getNode(newUid)) {
        app.selectedUid = newUid;
        app.canvas.setSelected(newUid);
        app.showToolbar(newUid);
    }
    void previousTree;
}


/** 拖动后把按 uid 记账的本地集合整体重定向。 */
export function remapUidSets(app: MindMapApp, remap: Map<string, string>) : void {
    if (remap.size === 0) return;
    const remapSet = (set: Set<string>): void => {
        const next = new Set<string>();
        for (const uid of set) next.add(remap.get(uid) ?? uid);
        set.clear();
        for (const uid of next) set.add(uid);
    };
    remapSet(app.expandedUids);
    remapSet(app.collapsedUids);
    remapSet(app.knownUids);
    if (app.selectedUid) app.selectedUid = remap.get(app.selectedUid) ?? app.selectedUid;
}


/**
 * 拖动后计算旧 uid → 新 uid。
 *
 * uid 是结构路径，移动会让整棵被拖子树的路径变化；但子树形状不变，
 * 因此只要在新父节点下找到「同文本 + 同形状」的那棵子树，就能逐层配对。
 * 配对成功时画布直接把旧 wrapper / mini-CM 搬过去，拖动后零重建。
 */
export function computeDropRemap(app: MindMapApp, dragUid: string, parentUid: string, oldTree: MindMapTreeNode, newTree: MindMapTreeNode) : Map<string, string> {
    const remap = new Map<string, string>();
    // 匹配签名只认「类型 + 文本」：标题拖动后层级会变（# → ##），
    // 文本不变，仍然应该复用原来的显示实例（内容重建交给 ensureContent）。
    const signature = (node: MindMapTreeNode): string =>
        `${node.data._kind}\u0000${node.data.text}`;

    /**
     * 对齐两棵树上同一父节点下的子节点。
     *
     * 拖动一个节点会让它后面所有兄弟的 uid 整体前移（0/2 → 0/1 …），
     * 只按相同 uid 复用的话，这些兄弟全部「内容不匹配 → 销毁重建」，
     * 大文档一次 drop 要重建几十个 mini-CM（实测 ~900ms）。
     * 用 LCS 按内容对齐后，除被拖走的子树外都能原地复用。
     */
    const alignChildren = (oldParent: MindMapTreeNode, newParent: MindMapTreeNode): void => {
        const a = oldParent.children;
        const b = newParent.children;
        const n = a.length;
        const m = b.length;
        if (n === 0 || m === 0) return;
        if (n * m > 200_000) {
            // 极端宽的层级：退回按签名分桶的顺序匹配，避免 DP 占内存
            const buckets = new Map<string, MindMapTreeNode[]>();
            for (const node of b) {
                const key = signature(node);
                const list = buckets.get(key);
                if (list) list.push(node);
                else buckets.set(key, [node]);
            }
            for (const oldChild of a) {
                const match = buckets.get(signature(oldChild))?.shift();
                if (match) {
                    remap.set(oldChild.data.uid, match.data.uid);
                    alignChildren(oldChild, match);
                }
            }
            return;
        }
        // DP：dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度
        const dp: number[][] = Array.from({ length: n + 1 }, () =>
            new Array<number>(m + 1).fill(0)
        );
        for (let i = n - 1; i >= 0; i -= 1) {
            for (let j = m - 1; j >= 0; j -= 1) {
                dp[i][j] =
                    signature(a[i]) === signature(b[j])
                        ? dp[i + 1][j + 1] + 1
                        : Math.max(dp[i + 1][j], dp[i][j + 1]);
            }
        }
        let i = 0;
        let j = 0;
        while (i < n && j < m) {
            if (signature(a[i]) === signature(b[j])) {
                remap.set(a[i].data.uid, b[j].data.uid);
                alignChildren(a[i], b[j]);
                i += 1;
                j += 1;
            } else if (dp[i + 1][j] >= dp[i][j + 1]) {
                i += 1;
            } else {
                j += 1;
            }
        }
    };

    // 根节点 uid 恒为 "0"
    remap.set(oldTree.data.uid, newTree.data.uid);
    alignChildren(oldTree, newTree);

    // 被拖子树单独配对：它跨了父层，上面的按兄弟对齐匹配不到。
    // 落到新父节点下找「同文本 + 同类型 + 同子节点数」的那棵。
    const oldNode = app.canvas.getNode(dragUid);
    const newParent = findTreeNodeByUid(newTree, parentUid)?.node;
    if (!oldNode || !newParent) return remap;
    let target: MindMapTreeNode | null = null;
    for (const child of newParent.children) {
        if (
            child.data.text === oldNode.text &&
            child.data._kind === oldNode.kind &&
            child.children.length === oldNode.children.length
        ) {
            target = child;
            break;
        }
    }
    if (!target) return remap;
    const pair = (from: MapNode, to: MindMapTreeNode): void => {
        remap.set(from.uid, to.data.uid);
        const count = Math.min(from.children.length, to.children.length);
        for (let i = 0; i < count; i += 1) {
            pair(from.children[i], to.children[i]);
        }
    };
    pair(oldNode, target);
    return remap;
}
