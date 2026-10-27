/**
 * MindMapApp 协作模块（从 mindmapApp.ts 拆出）：结构操作：commit 回写 + 增删子/兄弟节点。
 *
 * 全部是原 MindMapApp 方法，this 换成第一参数 app；跨模块调用走 app 上的薄包装方法。
 *
 * @module webview/mindmap/app/appStructureEdit
 */

import type { MindMapApp } from '../mindmapApp.js';
import { addChildNode, addSiblingNode } from '.././edit/add.js';
import { deleteChildNodes, deleteNode, deleteNodes, deleteSelfKeepChildren } from '.././edit/remove.js';
import { countSubtreeNodes } from '.././edit/shared.js';
import { buildMindMapTree } from '.././treeBuilder.js';


// ==================================================================
// 编辑回写 / 结构操作
// ==================================================================

/** 提交一次导图编辑：本地重建 + onEdit 回写源文档。 */
export function commit(app: MindMapApp, result: { text: string; newNodeUid?: string }) : void {
    if (!result) return;
    if (result.text === app.markdown && !result.newNodeUid) return;
    app.setMarkdown(result.text);
    const tree = buildMindMapTree(result.text, app.fileName);
    app.currentTree = tree;
    if (app.editSession) {
        app.pendingTree = tree;
    } else {
        app.canvas.setData(app.bakeExpandState(tree));
        // 树变了：内链箭头按新内容重算
        app.syncInternalLinks();
        app.toggleEmptyHint(tree.children.length === 0);
    }
    app.options.onEdit(result.text);
    app.searchBar.refreshAfterDocumentChange();
    if (result.newNodeUid) {
        const uid = result.newNodeUid;
        app.selectedUid = uid;
        app.canvas.setSelected(uid);
        app.showToolbar(uid);
        // 新节点已在同步渲染里就位，直接进编辑
        requestAnimationFrame(() => app.startEdit(uid));
    }
}


/**
 * 工具条结构操作前先落掉编辑会话。
 *
 * 点击节点会直接进入编辑态；此时点工具条，commit() 只会把新树塞进
 * pendingTree（要等编辑结束才应用），表现就是「点了删除/新增没反应」。
 * 所以结构操作一律先把当前编辑提交掉，让 canvas 立即重建。
 */
export function endEditBeforeStructuralOp(app: MindMapApp) : void {
    if (app.editSession) app.commitEditSession();
}


/** 新增子节点。 */
export function addChild(app: MindMapApp) : void {
    if (!app.selectedUid || !app.currentTree) return;
    app.endEditBeforeStructuralOp();
    app.commit(addChildNode(app.markdown, app.currentTree, app.selectedUid));
}


/** 新增兄弟节点。 */
export function addSibling(app: MindMapApp) : void {
    if (!app.selectedUid || !app.currentTree) return;
    app.endEditBeforeStructuralOp();
    app.commit(addSiblingNode(app.markdown, app.currentTree, app.selectedUid));
}


/**
 * 删除选中节点整棵子树。
 *
 * 有子项（或元数据整块）的节点要「两次点击」：
 * - 第一次：不删，只把工具条上的删除按钮变红并改成「确认删除」；
 * - 4 秒内再点一次：真正删除；
 * - 超时 / 选中别的节点 / 点空白：红色待确认态自动复位。
 *
 * 叶子节点仍然一次点击直接删（没有误删风险，保持顺手）。
 * 这里不再用 window.confirm —— webview 里原生确认框不显示，
 * 用户看到的就是「点删除没反应」。
 */
export function deleteSelected(app: MindMapApp) : void {
    // 多选优先：Ctrl 点 / 框选之后 Delete 一次删一批（二次确认见下）
    if (app.multiSelected.size > 0) {
        app.deleteMultiSelected();
        return;
    }
    if (!app.selectedUid || !app.currentTree) return;
    // 删除前先结束编辑：否则 commit() 只写 pendingTree，点了删除看不到变化
    app.endEditBeforeStructuralOp();
    const uid = app.selectedUid;
    const found = findTreeNodeByUid(app.currentTree, uid);
    if (!found) return;
    const childCount = countSubtreeNodes(found.node);
    const needsConfirm = childCount >= 1 || found.node.data._kind === 'meta';
    if (needsConfirm && app.pendingDeleteUid !== uid) {
        // 键盘 Delete 入口也要能看到红按钮：先确保工具条显示在节点上
        app.showToolbar(uid);
        app.armDelete(uid, childCount);
        return;
    }
    app.clearPendingDelete();
    app.clearSelection();
    app.commit(deleteNode(app.markdown, app.currentTree, uid));
}


/**
 * 二级删除菜单：按选项执行不同的删法。
 *
 * 菜单本身已经是一次「明确选择」，所以这里直接提交，不再走键盘 Delete
 * 的两段式确认；节点还在的「只删除子节点」保持选中，工具条继续贴着它。
 *
 * @param item - 带 `data-del` 的菜单项（subtree / self / children）
 */
export function deleteFromMenu(app: MindMapApp, item: HTMLElement) : void {
    if (!app.selectedUid) return;
    const act = item.dataset.del;
    // 结构操作前先落掉编辑会话，否则 commit 只会写 pendingTree
    app.endEditBeforeStructuralOp();
    const tree = app.currentTree;
    if (!tree) return;
    const uid = app.selectedUid;
    const found = findTreeNodeByUid(tree, uid);
    if (!found || found.node.data._kind === 'root') return;
    const childCount = countSubtreeNodes(found.node);

    let result: { text: string };
    switch (act) {
        case 'self':
            // 只删自己：子节点上移一级
            result = deleteSelfKeepChildren(app.markdown, tree, uid);
            break;
        case 'children':
            if (childCount === 0) return;
            result = deleteChildNodes(app.markdown, tree, uid);
            // 节点还在，重建后保持选中（不要把工具条一起收掉）
            app.clearPendingDelete();
            app.commit(result);
            if (app.selectedUid === uid) app.showToolbar(uid);
            return;
        default:
            // 含子树：与点击「删除」一致
            result = deleteNode(app.markdown, tree, uid);
            break;
    }
    app.clearPendingDelete();
    app.clearSelection();
    app.commit(result);
}


/**
 * 删除多选集合。
 *
 * 与单节点删除同样的「两步确认」：第一次只提示并变红，4 秒内再按一次
 * 才真正删除。框选常常一次选中十几个节点，误删的代价比单节点大得多，
 * 所以不提供「一按就删」。
 */
export function deleteMultiSelected(app: MindMapApp) : void {
    if (!app.currentTree) return;
    app.endEditBeforeStructuralOp();
    // 根节点永远不可删；祖先 + 后代同时选中时 deleteNodes 会去重
    const uids = [...app.multiSelected].filter((uid) => {
        const found = findTreeNodeByUid(app.currentTree!, uid);
        return !!found && found.parent && found.node.data._kind !== 'root';
    });
    if (uids.length === 0) {
        app.clearSelection();
        return;
    }
    if (!app.pendingDeleteMulti) {
        app.pendingDeleteMulti = true;
        // 操作条自己的按钮变红并改成「确认删除 N 项」—— 提示直接
        // 落在用户刚才点的那个按钮上，不用再飘一条独立的提示。
        app.updateMultiBar();
        if (app.pendingDeleteTimer !== null) clearTimeout(app.pendingDeleteTimer);
        app.pendingDeleteTimer = setTimeout(() => {
            app.pendingDeleteTimer = null;
            app.pendingDeleteMulti = false;
            app.updateMultiBar();
        }, 4000);
        return;
    }
    app.pendingDeleteMulti = false;
    if (app.pendingDeleteTimer !== null) {
        clearTimeout(app.pendingDeleteTimer);
        app.pendingDeleteTimer = null;
    }
    // 先清选中再重建：setData 后旧 uid 已失效，留着只会选中错节点
    const tree = app.currentTree;
    app.multiSelected.clear();
    app.canvas.setMultiSelected(app.multiSelected);
    app.selectedUid = null;
    app.canvas.setSelected(null);
    app.clearPendingDelete();
    if (app.toolbarEl) app.toolbarEl.style.display = 'none';
    app.updateMultiBar();
    app.commit(deleteNodes(app.markdown, tree, uids));
}
