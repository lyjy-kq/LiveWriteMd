/**
 * MindMapApp 协作模块（从 mindmapApp.ts 拆出）：剪贴板（子树复制/粘贴）+ 删除二次确认 + 展开回调。
 *
 * 全部是原 MindMapApp 方法，this 换成第一参数 app；跨模块调用走 app 上的薄包装方法。
 *
 * @module webview/mindmap/app/appClipboard
 */

import type { MindMapApp } from '../mindmapApp.js';
import { extractSubtreeText, insertSubtreeFromText } from '.././edit/clipboard.js';
import type { MindMapTreeNode } from '.././types.js';
import { findNodeByUid as findTreeNodeByUid } from '../edit/shared.js';


/**
 * 剪贴板操作的对象集合：多选优先（按加入顺序），否则单选节点。
 * root 不可复制（整篇文档没有可提取的区间）。
 */
export function clipboardTargetUids(app: MindMapApp) : string[] {
    const uids =
        app.multiSelected.size > 0
            ? [...app.multiSelected]
            : app.selectedUid
              ? [app.selectedUid]
              : [];
    return uids.filter((uid) => uid !== '0');
}


/** 复制选中子树到剪贴板（纯 Markdown）。 */
export async function copySelection(app: MindMapApp) : Promise<void> {
    if (!app.currentTree) return;
    const uids = app.clipboardTargetUids();
    if (uids.length === 0) return;
    const text = extractSubtreeText(app.markdown, app.currentTree, uids);
    if (text) await app.writeClipboardText(text);
}


/**
 * 粘贴：剪贴板文本解析成子节点，挂到目标下面。
 *
 * 落点：唯一选中节点；多选时取最早点选的那个（多选条上的粘贴）；
 * 什么都没选时落到根（追加到文末 / 第一个标题之前，由
 * insertSubtreeFromText 按块类型决定）。
 */
export async function pasteFromClipboard(app: MindMapApp) : Promise<void> {
    if (!app.currentTree) return;
    const targetUid =
        app.selectedUid ?? [...app.multiSelected][0] ?? '0';
    const clip = await app.readClipboardText();
    if (!clip.trim()) return;
    app.endEditBeforeStructuralOp();
    app.commit(
        insertSubtreeFromText(app.markdown, app.currentTree, targetUid, clip)
    );
}


export function armDelete(app: MindMapApp, uid: string, childCount: number) : void {
    app.pendingDeleteUid = uid;
    if (app.pendingDeleteTimer !== null) clearTimeout(app.pendingDeleteTimer);
    const button = app.toolbarEl?.querySelector<HTMLButtonElement>(
        'button[data-act="delete"]'
    );
    if (button) {
        button.classList.add('lwm-danger');
        // 文案带子项数量，点之前就知道会连带删掉多少
        button.textContent = childCount > 0 ? `确认删除（${childCount} 项）` : '确认删除';
    }
    app.pendingDeleteTimer = setTimeout(() => {
        app.pendingDeleteTimer = null;
        app.clearPendingDelete();
    }, 4000);
}


/** 复位「待确认删除」状态与按钮外观。 */
export function clearPendingDelete(app: MindMapApp) : void {
    app.pendingDeleteUid = null;
    if (app.pendingDeleteTimer !== null) {
        clearTimeout(app.pendingDeleteTimer);
        app.pendingDeleteTimer = null;
    }
    const button = app.toolbarEl?.querySelector<HTMLButtonElement>(
        'button[data-act="delete"]'
    );
    if (button) {
        button.classList.remove('lwm-danger');
        button.textContent = '删除';
    }
    // 多选删除的待确认态一并复位（顶部操作条恢复成「删除 N 项」）
    app.pendingDeleteMulti = false;
    app.updateMultiBar();
}


/** 展开按钮事件：同步 collapsedUids 与数据树的 expand 标记。 */
export function handleExpandChange(app: MindMapApp, uid: string, expanded: boolean, recursive: boolean) : void {
    const apply = (tree: MindMapTreeNode): void => {
        tree.data.expand = expanded;
        if (expanded) app.collapsedUids.delete(tree.data.uid);
        else app.collapsedUids.add(tree.data.uid);
        if (recursive) tree.children.forEach(apply);
    };
    if (!app.currentTree) return;
    const found = findTreeNodeByUid(app.currentTree, uid);
    if (found) {
        apply(found.node);
    } else if (expanded) {
        app.collapsedUids.delete(uid);
    } else {
        app.collapsedUids.add(uid);
    }
}


/** 全部展开（右键菜单）。 */
export function expandAllNodes(app: MindMapApp) : void {
    if (!app.currentTree) return;
    app.collapsedUids.clear();
    const walk = (tree: MindMapTreeNode): void => {
        tree.data.expand = true;
        tree.children.forEach(walk);
    };
    walk(app.currentTree);
    app.canvas.expandAll();
}
