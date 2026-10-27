/**
 * 内存占用统计采集（webview 侧）。
 *
 * 「LiveWriteMD: 显示内存占用」命令的数据源：扩展侧发
 * COLLECT_MEMORY_STATS，这里汇总当前 webview 的堆 / DOM / 文档 /
 * 导图 / 各模块缓存计数，回发 memoryStatsReport。
 *
 * 定位「打开大文件内存爆炸」类问题时，这份快照能把
 * 「堆被谁占着」缩小到一张表：导图显示实例、各渲染缓存都在里面。
 */

import {
    mermaidSvgCache,
    mermaidHeightCache,
    widgetHeightCache,
    mermaidRenderPromises,
} from './codemirror/extensions/livePreview/state.js';
import { tableCacheStats } from './codemirror/extensions/livePreview/tableMeasure.js';
import { openScaleCacheSize } from './codemirror/extensions/livePreview/openScale.js';
import { openWrapCacheStats } from './codemirror/extensions/livePreview/openWrap.js';
import { mathScaleCacheSize } from './codemirror/extensions/livePreview/mathWidgets.js';

/** 汇总当前 webview 的内存相关计数。 */
export function collectMemoryStats(opts: {
    /** 文档字符数（主编辑器 CM 文档） */
    docLength: number;
    /** 文档行数 */
    docLines: number;
    /** 当前编辑器模式（live / mindmap / viewer / source） */
    mode: string;
    /** 导图内部计数（不在导图模式时传 null）；字段见 MapCanvas.debugState */
    mapStats: Record<string, unknown> | null;
}): Record<string, unknown> {
    // performance.memory 是 Chromium 专有 API：VS Code 的 webview 恰好是
    // Chromium，直接可用；其它宿主（理论上）没有就报 -1
    const mem = (
        performance as unknown as {
            memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
        }
    ).memory;
    return {
        // —— 总量 ——
        heapUsedMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : -1,
        heapTotalMB: mem ? Math.round(mem.totalJSHeapSize / 1048576) : -1,
        domNodes: document.getElementsByTagName('*').length,
        // —— 文档 ——
        docKB: Math.round(opts.docLength / 1024),
        docLines: opts.docLines,
        mode: opts.mode,
        // —— 导图（仅导图模式有值）——
        map: opts.mapStats,
        // —— 各模块缓存条目数（无限增长的缓存是历史泄漏重灾区）——
        caches: {
            mermaidSvg: mermaidSvgCache.size,
            mermaidHeight: mermaidHeightCache.size,
            mermaidPending: mermaidRenderPromises.size,
            widgetHeight: widgetHeightCache.size,
            mathScale: mathScaleCacheSize(),
            openScale: openScaleCacheSize(),
            ...tableCacheStats(),
            ...openWrapCacheStats(),
        },
    };
}
