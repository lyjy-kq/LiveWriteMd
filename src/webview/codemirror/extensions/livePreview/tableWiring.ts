/**
 * 表格（从 tableRender.ts 拆出）：量宽与编辑器接线：tableResizePlugin / availableTableWidth / 未量表格探测。
 *
 * @module webview/codemirror/extensions/livePreview/tableWiring
 */

import { columnWidthCache, columnWidthsFor, distributeColumns } from './tableColumns.js';
import { TableBlock } from './tableTypes.js';
import { tableRemeasureEffect } from './state.js';
import type { EditorState } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';

/**
 * 有没有表格是**在量不到可用宽度的时候**算出来的（= 需要补一次重建）。
 *
 * 首次构建发生在 EditorState.create 阶段，那时视图还没挂进 DOM，可用宽度是 0，
 * 列宽只能按「谁都不许折行」算，表格会撑出正文列。见 plugin.ts 的 tableWidthBootstrap。
 *
 * @returns 有这种表格时返回 true
 */
export function hasUnmeasuredTables(): boolean {
    for (const entry of columnWidthCache.values()) {
        if (entry.available <= 0) return true;
    }
    return false;
}

/**
 * 复现页用的抓手：把一张表在缓存里的原始数据原样吐出来。
 *
 * 列宽不对只有两类原因：**量**错了（natural / min 不对）或者**分**错了
 * （cols 和 available 对不上）。光看渲染出来的 DOM 分不清是哪一类，
 * 所以把这两截摆到一起，复现页直接对数字。
 *
 * @param from - 表格在文档里的起点（TableBlock.from）
 * @returns 缓存里的原始数据；没缓存过这张表时返回 null
 */
export function tableWidthMetrics(
    from: number
): { natural: number[]; min: number[]; available: number; cols: number[] } | null {
    const cached = columnWidthCache.get(from);
    if (!cached) return null;
    return {
        natural: cached.natural.slice(),
        min: cached.min.slice(),
        available: cached.available,
        cols: cached.cols.slice(),
    };
}

/**
 * 监听滚动容器宽度变化、主动触发表格重新测量的插件。
 *
 * ## 为什么需要它（一条自己解不开的死循环）
 *
 * 表格列宽是按「正文可用宽度」分配的，而 `.cm-content` 的宽度反过来又由这些定宽
 * 列撑出来：当窗口 / 侧栏 / 大纲分隔条把 `.cm-scroller` 压窄时，content 宽度不变
 * → 正文不重排、文档高度不变 → CodeMirror 的 `viewportChanged` 不触发
 * → 装饰不重建（见 plugin.ts 的 needsRebuild）→ 列宽永远按旧的可用宽度钉着
 * → 表格溢出 scroller，视觉上就是表格右端被右侧大纲盖住。纯正文没有「定宽地板」，
 * content 自己会跟着 scroller 缩，所以只有表格踩这个坑。
 *
 * 插件直接观察 scrollDOM 的宽度：宽度一变就派发 tableRemeasureEffect，强制窗口装饰
 * 重算（columnWidthsFor 的缓存命中路径只重跑 distributeColumns 算术、不重新量格子，
 * 代价很小）。拖大纲分隔条、开关 VS Code 侧栏都走这条路。
 */
export const tableResizePlugin = ViewPlugin.fromClass(
    class {
        /** 上一次观察到的滚动容器宽度，用来过滤 RO 的初次回调与重复通知。 */
        private lastWidth: number;

        /** 宽度变化后的防抖定时器，合并侧栏动画 / 连续拖拽期间的密集通知。 */
        private debounceTimer = -1;

        /** ResizeObserver 断开等清理动作，destroy() 时调用一次。 */
        private cleanup: () => void = () => {};

        /**
         * @param view - 编辑器视图，scrollDOM 是被观察的目标
         */
        constructor(private view: EditorView) {
            const scroller = view.scrollDOM;
            this.lastWidth = scroller.clientWidth;
            if (typeof ResizeObserver === 'function') {
                const observer = new ResizeObserver(() => this.handleWidthChange());
                observer.observe(scroller);
                // 插件销毁时断开观察，避免视图销毁后回调还往一个死视图上 dispatch。
                this.cleanup = () => observer.disconnect();
            }
        }

        /**
         * RO 回调：宽度真的变了才排一个防抖任务去派发重新测量效果。
         */
        private handleWidthChange(): void {
            const width = this.view.scrollDOM.clientWidth;
            if (width === this.lastWidth) return;
            this.lastWidth = width;
            if (this.debounceTimer >= 0) clearTimeout(this.debounceTimer);
            // 50ms：既能把侧栏动画里的一连串变化合并，又不至于让人觉得“卡了一下”。
            this.debounceTimer = window.setTimeout(() => {
                this.debounceTimer = -1;
                // 视图可能在等待期间已经销毁，dispatch 前确认它还挂在 DOM 上。
                if (this.view.dom.isConnected) {
                    this.view.dispatch({ effects: tableRemeasureEffect.of(null) });
                }
            }, 50);
        }

        /**
         * 插件销毁：取消等待中的任务并断开观察。
         */
        destroy(): void {
            if (this.debounceTimer >= 0) clearTimeout(this.debounceTimer);
            this.cleanup();
        }
    }
);

/**
 * 正文可用宽度（px）：表格最多能占多宽 —— 也就是**正文文字的左右边界之间**有多宽。
 *
 * 三段减法：
 *
 * 1. 从**滚动容器**（`.cm-scroller`）的 clientWidth 出发。不能取 `.cm-content`
 *    的宽度 —— 那是**能变**的：`.cm-content` 是 `.cm-scroller`（display:flex）里
 *    的 flex item，还带着 `flex-shrink: 0`，里面的东西撑宽了它，它自己就跟着变宽。
 *    而它的宽度又正好由表格的列宽决定（格子的行内宽度就是列宽），于是形成正反馈：
 *    表格溢出一次 → `.cm-content` 变宽 → 下次量到的「可用宽度」更大 → 表格更宽。
 *    实测过：编辑器明明只有 900px，表格算出来 1288px，而且再也收不回来。
 * 2. 扣掉**行号栏**。它在 scroller 里占的是实打实的位置，正文是从它右边才开始的。
 * 3. 扣掉正文自己的左右内边距，再受 `.cm-content` 的 max-width 约束
 *    （`liveWriteMd.readableLineLength`，见 webviewContent.ts）—— 正文自己就被它封顶，
 *    表格当然也不能比正文宽。
 *
 * 拿不到就返回 0，调用方跳过收缩。
 *
 * 差几像素不用管：表格行自己还带着一点不在列宽里的开销（首尾管道线压 0 宽后
 * 剩下的那几像素），所以行的外框会比所有列宽之和宽 3~6px。这是表格自己的框，
 * 不是列分配算错的，为了它再去量一次行开销（又是一次强制布局）不值。
 *
 * @returns 正文文字区的宽度（px）
 */
export function availableTableWidth(): number {
    return availableWidth();
}

/**
 * 正文可用宽度（px）的实现。
 *
 * @param view - 传入视图时优先识别导图语境：导图节点的 mini-CM 不在
 *        `#editor` 里，全局查法一定量到 0（不设上限 → 表格无限增长）。
 *        导图里改读**节点盒子的 CSS max-width**（`.lwm-node-table` 的
 *        上限，见 mindmapStyles）当预算 —— 列宽收缩 / 格子换行逻辑与
 *        live 模式完全同一套，只是宽度来源不同。getComputedStyle 返回
 *        的是变换前的排版像素，不受画布世界层的缩放影响，直接可用。
 * @returns 正文文字区宽度；视图还没挂进 DOM（量不到）时返回 0
 */
export function availableWidth(view?: EditorView): number {
    // 导图语境：预算读 CSS 变量 --lwm-table-max-width（在 .lwm-canvas 上定义、
    // 继承到节点）。不能只读节点盒的 max-width：编辑态会 max-width: none
    // （解除截断），那样会量到 'none' → 预算 0 → 列宽不收缩，表格源码横着溢出。
    // 主编辑器的 dom 不会套在 .lwm-node 里，自然落到下面的全局路径。
    const nodeEl = view?.dom.closest('.lwm-node');
    if (nodeEl) {
        const cs = getComputedStyle(nodeEl as HTMLElement);
        const raw = cs.getPropertyValue('--lwm-table-max-width').trim();
        const fontSize = Number.parseFloat(cs.fontSize) || 14;
        // 变量允许写 em 或 px；em 按节点正文字号换算
        const px = raw.endsWith('em')
            ? Number.parseFloat(raw) * fontSize
            : raw.endsWith('px')
              ? Number.parseFloat(raw)
              : NaN;
        return Number.isFinite(px) && px > 0 ? px : 0;
    }

    const scroller = document.querySelector('#editor .cm-scroller');
    const content = document.querySelector('#editor .cm-content');
    if (!scroller || !content) return 0;
    const cs = getComputedStyle(content);

    // 行号栏的宽度（关掉行号时它不在，按 0 算）
    const gutters = document.querySelector('#editor .cm-gutters');
    const gutterWidth = gutters instanceof HTMLElement ? gutters.offsetWidth : 0;

    // 正文这一格最多能有多宽：scroller 剩下的地方，再受正文自己的宽度上限约束。
    // 上限只认 px —— 关掉「限制行宽」时 webview 写的是 `max-width: 100%`
    // （见 editor.ts 的 readableLineLength === 0 分支），百分比解析成数字会得到
    // 100 这种荒谬的值（表格全被压成 100px 宽），那种情况按「不限制」处理。
    const room = (scroller as HTMLElement).clientWidth - gutterWidth;
    const maxWidthPx = cs.maxWidth.endsWith('px') ? Number.parseFloat(cs.maxWidth) : NaN;
    const boxWidth =
        Number.isFinite(maxWidthPx) && maxWidthPx > 0 ? Math.min(maxWidthPx, room) : room;

    // max-width 管的是**边框盒**（CodeMirror 给 .cm-content 设了 border-box），
    // 内边距也算在里面，所以文字区宽度要把内边距减掉
    const inner =
        boxWidth -
        (Number.parseFloat(cs.paddingLeft) || 0) -
        (Number.parseFloat(cs.paddingRight) || 0);
    return inner > 0 ? inner : 0;
}
