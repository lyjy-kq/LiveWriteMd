/**
 * 轻量性能跨度（span）记录器。
 *
 * 只做一件事：把最近若干次「关键操作」的耗时与发生时刻存进一个环形
 * 缓冲，供性能浮层在记录尖峰时附带「尖峰前刚跑过什么」。
 *
 * 设计成叶子模块（不依赖 CodeMirror / 导图 / 幻灯片），关闭时所有
 * beginSpan 只返回 null，调用点只多一次布尔判断；开启后也不做采样
 * 定时器，纯事件记录，避免诊断本身制造卡顿。
 *
 * @module webview/perf/perfProbe
 */

/** 一条操作记录。 */
export interface PerfSpan {
    /** 操作名，例如 slides.flip / slides.fill / map.pump。 */
    name: string;
    /** 耗时（ms，保留一位小数）。 */
    ms: number;
    /** 结束时刻（performance.now()）。 */
    at: number;
    /** 尖峰发生时这个操作还没结束（此时 ms 是已运行时长）。 */
    open?: boolean;
}

/** 保留最近多少条（够覆盖一次尖峰前后即可）。 */
const MAX_SPANS = 16;

let enabled = false;
const recent: PerfSpan[] = [];
/** 当前还没结束的跨度（尖峰现场能看到「正在跑什么」）。 */
const openSpans = new Set<{ name: string; start: number }>();

/** 开启 / 关闭记录（由 PerfHud 完整档控制）。 */
export function setPerfProbeEnabled(on: boolean): void {
    enabled = on;
    if (!on) {
        recent.length = 0;
        openSpans.clear();
    }
}

/** 当前是否开启。 */
export function perfProbeEnabled(): boolean {
    return enabled;
}

/** 开始一个跨度；关闭时返回 null（调用方无需判断 enabled）。 */
export function beginSpan(name: string): { name: string; start: number } | null {
    if (!enabled) return null;
    const span = { name, start: performance.now() };
    openSpans.add(span);
    return span;
}

/** 结束跨度并写入环形缓冲。 */
export function endSpan(span: { name: string; start: number } | null): void {
    if (!span || !enabled) return;
    openSpans.delete(span);
    const now = performance.now();
    recent.push({
        name: span.name,
        ms: Math.round((now - span.start) * 10) / 10,
        at: Math.round(now),
    });
    if (recent.length > MAX_SPANS) recent.shift();
}

/** 最近的跨度快照（含正在执行的跨度）；尖峰现场用。 */
export function recentSpans(): PerfSpan[] {
    const now = performance.now();
    const active: PerfSpan[] = [];
    for (const span of openSpans) {
        active.push({
            name: span.name,
            ms: Math.round((now - span.start) * 10) / 10,
            at: Math.round(now),
            open: true,
        });
    }
    return [...recent, ...active].slice(-MAX_SPANS);
}
