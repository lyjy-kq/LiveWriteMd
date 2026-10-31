/**
 * MindMapApp 协作模块（从 mindmapApp.ts 拆出）：大纲联动 / 内链同步 / 搜索高亮 / perfHud。
 *
 * 全部是原 MindMapApp 方法，this 换成第一参数 app；跨模块调用走 app 上的薄包装方法。
 *
 * @module webview/mindmap/app/appLinkage
 */

import type { MindMapApp } from '../mindmapApp.js';
import { extractInternalLinkTargets, matchHeadingIndex } from '../../../shared/link/internalLink.js';
import { PerfHud } from '.././perfHud.js';
import type { MindMapTreeNode, NodeLineRange } from '.././types.js';


// ==================================================================
// 大纲联动 / 搜索
// ==================================================================

/**
 * 大纲点击联动：选中对应标题节点并画布居中。
 *
 * @param line0 0-based 行号（标题行）
 * @returns 找到对应标题节点时返回 true
 */
export function selectNodeAtLine(app: MindMapApp, line0: number) : boolean {
    if (!app.currentTree || !app.active) return false;
    let targetUid: string | null = null;
    const walk = (node: MindMapTreeNode): void => {
        if (targetUid) return;
        if (node.data._kind === 'heading' && node.data._lineRange?.fromLine === line0) {
            targetUid = node.data.uid;
            return;
        }
        node.children.forEach(walk);
    };
    walk(app.currentTree);
    if (!targetUid) return false;
    app.selectAndCenterUid(targetUid);
    return true;
}


/**
 * 从文本模式切进导图后的定位。
 *
 * - 固定 100% 缩放（需求：进入导图时 100%，不按整棵树 fit 后缩小）；
 * - 选中视口中线所在的节点并居中（行号 → 最深节点）。
 * 必须先 setActive(true)（容器可见、节点已测量），再做这两步。
 *
 * @param line0 0-based 正文行号
 */
export function focusLineFromEditor(app: MindMapApp, line0: number) : void {
    if (!app.active) return;
    // 先定缩放，再居中：centerOn 用的是当前 zoom
    app.canvas.setZoomPercent(100);
    const uid = app.findNodeUidAtLine(line0);
    if (uid) app.selectAndCenterUid(uid);
}


/**
 * 离开导图前取「用户正在看的位置」对应的 0-based 行号。
 *
 * 优先级：选中/正在编辑的节点 → 视口中心所在节点。调用方必须在
 * setActive(false) **之前**取（那时会清空选中）。
 *
 * @returns 行号；没有可用节点时返回 null
 */
export function getFocusLine0(app: MindMapApp) : number | null {
    if (!app.currentTree) return null;
    const selected = app.selectedUid ? app.canvas.getNode(app.selectedUid) : null;
    const selectedRange = selected?.data._lineRange as NodeLineRange | undefined;
    if (selectedRange) return selectedRange.fromLine;
    const centered = app.canvas.getNodeAtViewportCenter();
    const centeredRange = centered?.data._lineRange as NodeLineRange | undefined;
    return centeredRange?.fromLine ?? null;
}


/** 选中并居中（目标被折叠祖先藏住时先展开祖先）。 */
export function selectAndCenterUid(app: MindMapApp, uid: string) : void {
    const parts = uid.split('/');
    let prefix = '';
    for (let i = 0; i < parts.length - 1; i += 1) {
        prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
        app.collapsedUids.delete(prefix);
    }
    app.canvas.revealUid(uid);
    if (!app.canvas.getNode(uid)) return;
    app.selectNode(uid);
    app.canvas.centerOn(uid);
}


// ==================================================================
// 文档内链接（内链）
// ==================================================================

/**
 * 收集当前树的标题目录（文档顺序的文字 + uid）。
 *
 * 内链的两种消费方共用同一份目录：箭头配对（syncInternalLinks）与
 * 节点内 #锚点 链接的点击解析（resolveInternalLinkUid）。
 */
export function collectHeadings(app: MindMapApp) : { texts: string[]; uids: string[] } {
    const texts: string[] = [];
    const uids: string[] = [];
    if (!app.currentTree) return { texts, uids };
    const walk = (node: MindMapTreeNode): void => {
        // 标题节点的 text 已去掉 `#` 标记，可直接参与匹配
        if (node.data._kind === 'heading') {
            texts.push(node.data.text);
            uids.push(node.data.uid);
        }
        node.children.forEach(walk);
    };
    walk(app.currentTree);
    return { texts, uids };
}


/**
 * 同步内链箭头层：扫全部文本节点的源码，提取内链并解析到目标标题。
 *
 * 断链（目标标题不存在）/ 自指不画；同一对节点多条内链只画一条；
 * 设置关闭时清空。每次整树重建 / 编辑回写后都要调用一次。
 */
export function syncInternalLinks(app: MindMapApp) : void {
    if (!app.currentTree || !app.settings.mindmapInternalLinks) {
        app.canvas.setInternalLinks([]);
        return;
    }
    const { texts, uids } = app.collectHeadings();
    const pairs: Array<{ fromUid: string; toUid: string }> = [];
    const seen = new Set<string>();
    const walk = (node: MindMapTreeNode): void => {
        const kind = node.data._kind;
        // 只有文本类节点可能出现内链；媒体节点（代码块 / 表格等）的内容
        // 在 live 里同样不产生链接，两边口径一致
        if (kind === 'heading' || kind === 'list' || kind === 'para' || kind === 'quote') {
            const range = node.data._selfLineRange ?? node.data._lineRange;
            const source = range
                ? app.markdownLines.slice(range.fromLine, range.toLine + 1).join('\n')
                : '';
            for (const target of extractInternalLinkTargets(source)) {
                const index = matchHeadingIndex(texts, target);
                if (index < 0) continue; // 断链不画
                const toUid = uids[index];
                if (toUid === node.data.uid) continue; // 自指不画
                const key = `${node.data.uid}->${toUid}`;
                if (seen.has(key)) continue;
                seen.add(key);
                pairs.push({ fromUid: node.data.uid, toUid });
            }
        }
        node.children.forEach(walk);
    };
    walk(app.currentTree);
    app.canvas.setInternalLinks(pairs);
}


/** 内链目标标题文字 → 导图节点 uid（精确优先 + slug 回退）。 */
export function resolveInternalLinkUid(app: MindMapApp, target: string) : string | null {
    const { texts, uids } = app.collectHeadings();
    const index = matchHeadingIndex(texts, target);
    return index >= 0 ? uids[index] : null;
}


/** 内链跳转：展开祖先、选中并居中（不改缩放）、1 秒高亮。 */
export function handleInternalLinkNavigate(app: MindMapApp, uid: string) : void {
    app.selectAndCenterUid(uid);
    app.canvas.flashNode(uid);
}


// ==================================================================
// 性能监控浮层
// ==================================================================

/** 按设置挂 / 摘 / 切换性能监测浮层（幂等）。 */
export function syncPerfHud(app: MindMapApp) : void {
    const mode = app.settings.mindmapPerfMonitor;
    if (mode === 'off') {
        if (app.perfHud) {
            app.perfHud.destroy();
            app.perfHud = null;
        }
        return;
    }
    // 档位没变就保留现有实例：反复 setSettings 不重建 rAF 采样
    if (app.perfHud?.mode === mode) return;
    app.perfHud?.destroy();
    app.perfHud = new PerfHud(
        app.container,
        () => ({
            ...app.canvas.debugState(),
            docKB: Math.round(app.markdown.length / 1024),
        }),
        mode
    );
}


/** 应用搜索高亮（命中节点描边，当前项加深）。 */
export function applySearchHighlight(app: MindMapApp, uids: string[], currentUid: string | null) : void {
    // 画布自己记住命中集合：节点重新挂载 / 重建后会自动补类名
    app.canvas.setSearchHighlight(uids, currentUid);
}


/**
 * 行号 → 节点 uid（搜索映射）：取包含该行的最深节点。
 */
export function findNodeUidAtLine(app: MindMapApp, line0: number) : string | null {
    if (!app.currentTree) return null;
    // 用对象包一层：回调里的赋值不会被 TS 的控制流分析跟踪，
    // 直接写 let best 会在 walk() 之后被误收窄成 never
    const state: { best: { uid: string; span: number } | null } = { best: null };
    const walk = (node: MindMapTreeNode): void => {
        const range = node.data._lineRange;
        if (range && line0 >= range.fromLine && line0 <= range.toLine) {
            const span = range.toLine - range.fromLine;
            if (!state.best || span < state.best.span) {
                state.best = { uid: node.data.uid, span };
            }
        }
        node.children.forEach(walk);
    };
    walk(app.currentTree);
    return state.best?.uid ?? null;
}
