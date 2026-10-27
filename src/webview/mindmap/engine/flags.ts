/**
 * MapCanvas 协作模块（从 canvas.ts 拆出）：外观状态标志：选中/多选/编辑/搜索高亮/展开层级/主题。
 *
 * 全部是原 MapCanvas 方法，this 换成第一参数 c；跨模块调用走 c 上的薄包装方法，行为与拆前完全一致。
 *
 * @module webview/mindmap/engine/flags
 */

import { PROGRESSIVE_THRESHOLD } from './canvasConstants.js';
import type { MapCanvas } from './canvas.js';
import type { ThemeType } from '../../../shared/types.js';
import { expandAncestors, expandSubtree, walkAll } from './model.js';


/** 同步一个节点的展开标记（展开层级设置 / 大纲联动后调用）。 */
export function setNodeExpand(c: MapCanvas, uid: string, expand: boolean) : void {
    const node = c.byUid.get(uid);
    if (!node) return;
    node.expand = expand;
}


/**
 * 按默认展开层级重设整棵树的展开状态。
 *
 * @param level 深度 >= level 且有子节点的节点收起
 * @returns 被收起的 uid 集合（上层记入 collapsedUids）
 */
export function applyExpandLevel(c: MapCanvas, level: number) : Set<string> {
    const collapsed = new Set<string>();
    if (c.root) {
        walkAll(c.root, (node) => {
            const collapse = node.depth >= level && node.children.length > 0;
            node.expand = !collapse;
            if (collapse) collapsed.add(node.uid);
        });
    }
    c.relayout();
    c.updateViewport();
    c.options.onViewChange();
    return collapsed;
}


/** 全部展开。 */
export function expandAll(c: MapCanvas) : void {
    if (c.root) expandSubtree(c.root);
    c.relayout();
    c.updateViewport();
    c.options.onViewChange();
}


/** 展开某个节点的全部祖先并重排（大纲 / 搜索跳转）。 */
export function revealUid(c: MapCanvas, uid: string) : boolean {
    if (!c.root) return false;
    const changed = expandAncestors(c.root, uid);
    if (changed) {
        c.relayout();
        c.updateViewport();
    }
    return changed;
}


// ==================================================================
// 外观状态
// ==================================================================

/** 设置选中节点（只影响类名）。 */
export function setSelected(c: MapCanvas, uid: string | null) : void {
    const previous = c.selectedUid;
    c.selectedUid = uid;
    if (previous) c.refreshWrapperClasses(c.byUid.get(previous));
    if (uid) c.refreshWrapperClasses(c.byUid.get(uid));
    // 选中节点是某条内链的源 / 目标时，那条箭头要提到全不透明
    c.updateInternalLinkEmphasis();
}


/**
 * 喂入内链对（内链所在节点 → 目标标题节点）并同步箭头层。
 *
 * 由上层（mindmapApp）在每次重建 / 编辑回写后按文档内容计算；
 * 传空数组 = 清空箭头层（设置关闭时）。
 */
export function setInternalLinks(c: MapCanvas, pairs: Array<{ fromUid: string; toUid: string }>) : void {
    c.ilinkPairs = pairs;
    c.syncInternalLinks();
}


/**
 * 内链跳转后的 1 秒高亮（独立通道，不与搜索高亮互相覆盖）。
 *
 * @param uid 目标节点 uid
 */
export function flashNode(c: MapCanvas, uid: string) : void {
    const previous = c.flashUid;
    c.flashUid = uid;
    if (previous && previous !== uid) {
        c.refreshWrapperClasses(c.byUid.get(previous));
    }
    c.refreshWrapperClasses(c.byUid.get(uid));
    if (c.flashTimer !== null) clearTimeout(c.flashTimer);
    c.flashTimer = setTimeout(() => {
        c.flashTimer = null;
        const stale = c.flashUid;
        c.flashUid = null;
        if (stale) c.refreshWrapperClasses(c.byUid.get(stale));
    }, 1000);
}


/**
 * 设置多选集合（Ctrl 点 / Ctrl 框选）。
 *
 * 多选和单选是两套独立的标记：框选时 selectedUid 可能还停在某个节点上，
 * 但删除要按整个集合来。这里只负责刷类名，集合本身由上层（mindmapApp）
 * 持有 —— 构造新树、删除节点后上层要重新给一次。
 */
export function setMultiSelected(c: MapCanvas, uids: Iterable<string>) : void {
    const next = new Set(uids);
    // 先刷新失去多选标记的节点，再刷新新标记的
    for (const uid of c.multiSelected) {
        if (!next.has(uid)) c.refreshWrapperClasses(c.byUid.get(uid));
    }
    c.multiSelected = next;
    for (const uid of next) c.refreshWrapperClasses(c.byUid.get(uid));
}


/** 当前多选集合（副本）。 */
export function getMultiSelected(c: MapCanvas) : string[] {
    return [...c.multiSelected];
}


/** 设置编辑中的节点（编辑期间不被虚拟化卸下）。 */
export function setEditing(c: MapCanvas, uid: string | null) : void {
    const previous = c.editingUid;
    c.editingUid = uid;
    if (previous) c.refreshWrapperClasses(c.byUid.get(previous));
    if (uid) {
        c.refreshWrapperClasses(c.byUid.get(uid));
        // 编辑目标必须在 DOM 里
        const node = c.byUid.get(uid);
        if (node && node.wrapper && node.wrapper.parentElement !== c.nodeLayer) {
            c.mountNode(node);
        }
    } else {
        // 编辑期间滚动滚轮缩放可能跨过了降级阈值：那时不能重建实例
        // （会销毁正在编辑的 mini-CM），统一拖到会话结束后补切档。
        c.syncRenderTier();
    }
}


/** 节点「展开到最大行数」标记（去/去行数截断）。 */
export function setNodeExpandedFlag(c: MapCanvas, uid: string, expanded: boolean) : void {
    if (expanded) c.expandedFlags.add(uid);
    else c.expandedFlags.delete(uid);
    const node = c.byUid.get(uid);
    if (!node) return;
    c.refreshWrapperClasses(node);
    // 去掉截断会改变高度：重新量 + 重排
    if (node.wrapper) c.measureNode(node);
    c.relayout();
    c.updateViewport();
}


/** 节点内容是否被尺寸上限截断。 */
export function isNodeClamped(c: MapCanvas, uid: string) : boolean {
    const node = c.byUid.get(uid);
    const wrapper = node?.wrapper;
    if (!wrapper) return false;
    return (
        wrapper.scrollHeight > wrapper.clientHeight + 1 ||
        wrapper.scrollWidth > wrapper.clientWidth + 1
    );
}


/** 更新搜索高亮（命中 + 当前项）。 */
export function setSearchHighlight(c: MapCanvas, hits: string[], current: string | null) : void {
    c.searchHits = new Set(hits);
    c.searchCurrent = current;
    for (const uid of c.mounted) {
        c.refreshWrapperClasses(c.byUid.get(uid));
    }
}


/**
 * 拖动后 uid 会整体变化：把按 uid 记的运行时标记一并重定向。
 *
 * @param remap 旧 uid → 新 uid
 */
export function remapFlags(c: MapCanvas, remap: Map<string, string>) : void {
    const mapUid = (uid: string): string => remap.get(uid) ?? uid;
    const reverse = (set: Set<string>): Set<string> => {
        const next = new Set<string>();
        for (const uid of set) next.add(mapUid(uid));
        return next;
    };
    const expanded = reverse(c.expandedFlags);
    c.expandedFlags.clear();
    for (const uid of expanded) c.expandedFlags.add(uid);
    const hits = reverse(c.searchHits);
    c.searchHits = hits;
    if (c.searchCurrent) c.searchCurrent = mapUid(c.searchCurrent);
}


/** 切换明暗主题：重建显示实例（token 颜色跟着 CM 主题走）。 */
export function setTheme(c: MapCanvas, theme: ThemeType) : void {
    c.applyThemeVars();
    // 主题只影响颜色，不影响尺寸；但必须在每个显示实例里生效。
    // 直接全部销毁、按需懒建（已挂载的会立即重建）。
    for (const entry of c.displays.values()) entry.display.destroy();
    c.displays.clear();
    for (const node of c.byUid.values()) {
        node.display = null;
        node.placeholder = false;
        node.wrapper?.replaceChildren();
    }
    c.queue.length = 0;
    c.queued.clear();
    c.progressiveCount = 0;
    // 主题切换要给已挂载节点重建真实 CM，允许一轮同步创建
    c.eagerDisplayBudget = PROGRESSIVE_THRESHOLD;
    for (const uid of c.mounted) {
        const node = c.byUid.get(uid);
        if (node) c.ensureContent(node);
    }
    c.relayout();
    c.updateViewport();
    c.scheduleMeasureSettle();
    void theme;
}
