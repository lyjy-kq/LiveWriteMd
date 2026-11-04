/**
 * 主编辑器 webview 的性能快照：把「当前模式 + 文档 + 模式专属指标」
 * 整理成 HUD 能直接展示的一行字。
 *
 * 所有模式共用同一个 HUD；切模式时不需要通知 HUD，下次刷新这里读到的
 * ctx.currentEditorMode 已经变了，展示内容自然跟着换。
 *
 * @module webview/perf/editorSnapshot
 */

import { ctx } from '../host/webviewContext.js';
import type { EditorMode } from '../../shared/types.js';
import type { PerfSnapshot } from './perfHud.js';

/** 模式短标签（HUD 一行里尽量省字）。 */
const MODE_LABEL: Record<EditorMode, string> = {
    live: '实时',
    source: '源码',
    viewer: '阅读',
    mindmap: '导图',
    slides: '幻灯片',
};

/**
 * 生成主编辑器当前状态快照。
 *
 * 文件信息统一从 CM 的 Text 上读（O(1) 的 length / lines，不复制全文），
 * 导图 / 幻灯片再叠加各自的调试指标。
 */
export function buildEditorPerfSnapshot(): PerfSnapshot {
    const view = ctx.editor?.getView();
    const doc = view?.state.doc;
    const lines = doc?.lines ?? 0;
    const bytes = doc?.length ?? 0;
    // 一位小数的 KB：3485 字节 → 3.4KB
    const kb = Math.round(bytes / 102.4) / 10;
    const mode = ctx.currentEditorMode;
    const base = `${MODE_LABEL[mode] ?? mode} · 行 ${lines} · ${kb}KB`;
    const raw: Record<string, unknown> = { mode, lines, bytes };

    // —— 导图：节点 / 挂载 / 显示实例 / 换真队列 ——
    if (mode === 'mindmap' && ctx.mindmapApp) {
        const stats = ctx.mindmapApp.debugStats();
        Object.assign(raw, stats);
        return {
            line: `${base} · 节点 ${stats.nodes}/${stats.mounted} · 队列 ${stats.queue}`,
            raw,
            // 画布累计创建的显示实例数：HUD 用它算「换真 x/s」
            createdTotal: Number(stats.createdTotal) || 0,
        };
    }

    // —— 幻灯片：页数 / 块 / 缓存页与 CM / 翻页与测量耗时 ——
    //
    // 行内只放最关键的几个数：页数、缓存规模、后台测量队列、最近一次
    // 翻页（含是否在等测量）和最近一次测量批。完整字段都在 raw 里，
    // 尖峰记录与「显示内存占用」能拿到全部细节。
    if (mode === 'slides' && ctx.slidesApp) {
        const stats = ctx.slidesApp.debugStats();
        Object.assign(raw, stats);
        const flip =
            stats.lastFlipSettleMs >= 0
                ? `${stats.lastFlipMs}/${stats.lastFlipSettleMs}ms`
                : `${stats.lastFlipMs}ms(补)`;
        return {
            line:
                `${base} · 页 ${stats.pages} · 块 ${stats.blocks}` +
                ` · 缓存 ${stats.cachedPages}p/${stats.cmCount}cm` +
                ` · 待测 ${stats.measurePending}` +
                ` · 填充 ${stats.fillPendingBlocks}块` +
                ` · 翻页 ${flip}` +
                ` · 测量 ${stats.lastMeasureMs}ms`,
            raw,
        };
    }

    // —— 文本模式（实时 / 源码 / 阅读）：当前视口排了多少行 ——
    if (view) {
        const visibleLines = view.viewportLineBlocks.length;
        raw.visibleLines = visibleLines;
        return { line: `${base} · 视口 ${visibleLines}行`, raw };
    }

    // 编辑器还没建好（INIT 之前）：只报模式与文件大小
    return { line: base, raw };
}
