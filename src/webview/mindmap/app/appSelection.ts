/**
 * MindMapApp 协作模块（从 mindmapApp.ts 拆出）：选中与多选：点选 / Ctrl 多选 / 框选应用 / 清选。
 *
 * 全部是原 MindMapApp 方法，this 换成第一参数 app；跨模块调用走 app 上的薄包装方法。
 *
 * @module webview/mindmap/app/appSelection
 */

import type { MindMapApp } from '../mindmapApp.js';
import type { MapNode } from '.././engine/model.js';
import type { MindMapTreeNode } from '.././types.js';


// ==================================================================
// 选中 / 工具条 / 编辑
// ==================================================================

/**
 * 节点单击：直接选中并进入编辑（光标落在点击位置）。
 *
 * 不再要求「先点一下选中、再点一下编辑」——那是旧交互的遗留。
 * root 只选中不编辑（它不是 Markdown 里的可编辑块）。
 */
export function handleNodeClick(app: MindMapApp, node: MapNode, event: MouseEvent) : void {
    const uid = node.uid;
    // 正在编辑这个节点：让 mini-CM 自己处理这次点击（定位光标）
    if (app.editSession?.uid === uid) return;
    // Ctrl / Cmd 点：切换多选，不进入编辑（用户正在组一批节点做批量删除）
    if (event.ctrlKey || event.metaKey) {
        app.toggleMultiSelection(uid);
        return;
    }
    // 单击 = 选中（并且可以顺手拖动节点）；
    // 再点一次**已经选中的**节点才进入编辑。
    //
    // 以前单击直接 startEdit，结果是「想拖节点却先进了编辑」，
    // 而且刚拖选完文字松手也会被当成点击。现在第一下只负责选中，
    // 编辑入口保留在：再次单击、双击、F2 / 工具条。
    // 多选状态下的普通单击要先清掉多选、切回单选，不算「再次点击」。
    const wasSelected = app.selectedUid === uid && app.multiSelected.size === 0;
    app.selectNode(uid);
    if (node.kind === 'root') return;
    if (wasSelected) app.startEdit(uid, event.clientX, event.clientY);
}


/**
 * Ctrl 点：把一个节点加入 / 移出多选集合。
 *
 * 集合为空时回落到普通单选，避免「取消最后一个多选后什么都点不了」。
 */
export function toggleMultiSelection(app: MindMapApp, uid: string) : void {
    if (app.multiSelected.has(uid)) app.multiSelected.delete(uid);
    else app.multiSelected.add(uid);
    app.canvas.setMultiSelected(app.multiSelected);
    if (app.multiSelected.size > 0) {
        // 多选期间只显示顶部的批量操作条；单节点工具条上的
        // ＋子节点 / ＋兄弟 对一批节点没有意义，先藏起来。
        app.selectedUid = uid;
        app.canvas.setSelected(uid);
        if (app.toolbarEl) app.toolbarEl.style.display = 'none';
        app.updateMultiBar();
    } else {
        app.clearSelection();
    }
}


/**
 * 框选结果（画布每次 pointermove 回调）。
 *
 * 框选期间直接覆盖集合；松手后集合保留，按 Delete 删除。
 * 单选 selectedUid 同步到最后一个命中项，工具条跟随。
 */
export function applyMarqueeSelection(app: MindMapApp, uids: string[]) : void {
    app.multiSelected = new Set(uids);
    app.canvas.setMultiSelected(app.multiSelected);
    // 多选时不显示工具条：按钮语义（＋子节点 / ＋兄弟）对一批节点没有
    // 意义，删除走键盘 Delete 或右键；这里只同步逻辑选中项。
    // 框选过程中每次都隐藏（可能上一次单选留下的工具条还挂着）。
    app.selectedUid = uids.length > 0 ? uids[uids.length - 1] : null;
    app.canvas.setSelected(app.selectedUid);
    if (app.toolbarEl) app.toolbarEl.style.display = 'none';
    app.updateMultiBar();
}


/** 选中节点、显示工具条、联动大纲。 */
export function selectNode(app: MindMapApp, uid: string) : void {
    // 换了节点：上一条「待确认删除」作废，避免红按钮跟到别的节点上
    if (app.pendingDeleteUid !== null && app.pendingDeleteUid !== uid) {
        app.clearPendingDelete();
    }
    // 普通点击 = 回到单选，清掉上一轮框选 / 多选
    if (app.multiSelected.size > 0) {
        app.multiSelected.clear();
        app.canvas.setMultiSelected(app.multiSelected);
        app.updateMultiBar();
    }
    app.selectedUid = uid;
    app.canvas.setSelected(uid);
    app.showToolbar(uid);
    // 其它节点的显示 CM 选区复位（行内元素收回渲染态）
    app.resetDisplaySelections(uid);
    const line = app.outlineLineOf(uid);
    if (line !== null) app.options.onSelectLine?.(line);
}


/** 节点对应的大纲行号（1-based；非标题沿父链找最近的标题）。 */
export function outlineLineOf(app: MindMapApp, uid: string) : number | null {
    if (!app.currentTree) return null;
    const found = findTreeNodeByUid(app.currentTree, uid);
    if (!found) return null;
    let current: MindMapTreeNode | null = found.node;
    while (current) {
        if (current.data._kind === 'heading' && current.data._lineRange) {
            return current.data._lineRange.fromLine + 1;
        }
        const parentUid = current.data.uid.split('/').slice(0, -1).join('/');
        if (!parentUid || parentUid === current.data.uid) break;
        current = findTreeNodeByUid(app.currentTree, parentUid)?.node ?? null;
    }
    return null;
}


/** 清除选中并隐藏工具条。 */
export function clearSelection(app: MindMapApp) : void {
    // 取消选中 = 取消待确认删除（红按钮不该留在屏幕上）
    app.clearPendingDelete();
    app.multiSelected.clear();
    app.pendingDeleteMulti = false;
    app.canvas.setMultiSelected(app.multiSelected);
    app.selectedUid = null;
    app.canvas.setSelected(null);
    app.resetDisplaySelections(null);
    if (app.toolbarEl) app.toolbarEl.style.display = 'none';
    app.updateMultiBar();
    if (app.toolbarTimer) {
        clearInterval(app.toolbarTimer);
        app.toolbarTimer = null;
    }
}


/** 所有显示实例的选区复位（P1 失焦恢复）。 */
export function resetDisplaySelections(app: MindMapApp, exceptUid: string | null) : void {
    app.canvas.forEachDisplay((uid, display) => {
        if (uid === exceptUid) return;
        display.resetSelection();
    });
}
