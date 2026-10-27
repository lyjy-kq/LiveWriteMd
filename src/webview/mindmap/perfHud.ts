/**
 * 导图性能监控浮层（设置「性能监控面板」开启后挂在画布右上角）。
 *
 * 实时显示：
 * - 帧率（rAF 逐帧测间隔，500ms 窗口滚动平均）；
 * - 缓存实例数（真实显示实例 / 已挂载节点）与堆内存（Chromium 的
 *   performance.memory，webview 恰好是 Chromium）；
 * - 换真队列长度与换真速度（实例创建计数器的时间增量）；
 * - 强制布局速率（gBCR/s，项目自己的性能口径；HUD 开启期间才包装计数）。
 *
 * 排查支持：帧间隔跳变（>2.5× 中位数且 >33ms）与长任务（longtask >100ms）
 * 发生时，把当时的现场（实例/队列/缩放/档位/手势/编辑/堆/gBCR）记进
 * 环形缓冲（最近 50 条），浮层上可一键复制成 JSON 贴回 Issue / 给我。
 *
 * @module webview/mindmap/perfHud
 */

import { BUILD_STAMP } from '../../shared/buildStamp.js';

/** 帧率尖峰 / 长任务的一条现场记录。 */
export interface PerfSpikeRecord {
    /** 距 HUD 启动的秒数。 */
    t: number;
    /** 帧间隔（尖峰）或长任务时长。 */
    deltaMs: number;
    kind: 'frame' | 'longtask';
    /** 现场快照（debugState + 堆 + 文档大小 + gBCR 速率）。 */
    snapshot: Record<string, unknown>;
}

/** 一帧间隔超过 max(中位数 × 该倍数, SPIKE_MIN_MS) 记为尖峰。 */
const SPIKE_FACTOR = 2.5;
const SPIKE_MIN_MS = 33;
/** 长任务阈值（ms）：小于它的不记。 */
const LONGTASK_MIN_MS = 100;
/** 环形缓冲容量。 */
const MAX_SPIKES = 50;
/** 文本刷新节奏（ms）。 */
const TEXT_TICK_MS = 500;

export class PerfHud {
    private readonly el: HTMLDivElement;
    private readonly textEl: HTMLDivElement;
    private readonly spikeEl: HTMLDivElement;
    private readonly snapshot: () => Record<string, unknown>;

    private rafId: number | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private longtaskObserver: PerformanceObserver | null = null;

    private readonly startedAt = performance.now();
    /** 上一帧的时间戳（null = 本轮 rAF 还没开始）。 */
    private lastFrame = 0;
    /** 滚动窗口内的帧间隔（ms）。 */
    private deltas: number[] = [];
    private readonly spikes: PerfSpikeRecord[] = [];

    // —— gBCR 计数（HUD 存活期间包装，destroy 时恢复）——
    private gbcrCount = 0;
    private gbcrOrig: typeof Element.prototype.getBoundingClientRect | null = null;
    /** 上一文本周期的瞬时速率基数。 */
    private lastCreated = 0;
    private lastGbcr = 0;
    private swapRate = 0;
    private gbcrRate = 0;
    private fps = 0;

    constructor(container: HTMLElement, snapshot: () => Record<string, unknown>) {
        this.snapshot = snapshot;
        this.el = document.createElement('div');
        this.el.className = 'lwm-perf-hud';
        this.textEl = document.createElement('div');
        this.textEl.className = 'lwm-perf-hud-line';
        this.spikeEl = document.createElement('div');
        this.spikeEl.className = 'lwm-perf-hud-spikes';
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'lwm-perf-hud-copy';
        copyBtn.textContent = '复制尖峰记录';
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.copySpikes(copyBtn);
        });
        this.el.append(this.textEl, this.spikeEl, copyBtn);
        container.appendChild(this.el);

        this.installGbcrCounter();
        this.startFpsLoop();
        this.startLongtaskObserver();
        this.timer = setInterval(() => this.tick(), TEXT_TICK_MS);
    }

    // ==================================================================
    // 采样
    // ==================================================================

    private startFpsLoop(): void {
        const loop = (now: number): void => {
            if (this.lastFrame > 0) {
                const delta = now - this.lastFrame;
                this.deltas.push(delta);
                if (this.deltas.length > 240) this.deltas.shift();
                this.maybeRecordSpike(delta);
            }
            this.lastFrame = now;
            this.rafId = requestAnimationFrame(loop);
        };
        this.rafId = requestAnimationFrame(loop);
    }

    /** 帧间隔跳变 → 记一条现场。 */
    private maybeRecordSpike(delta: number): void {
        if (delta < SPIKE_MIN_MS) return;
        const sorted = [...this.deltas].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)] ?? 16.7;
        if (delta < Math.max(median * SPIKE_FACTOR, SPIKE_MIN_MS)) return;
        this.recordSpike(delta, 'frame');
    }

    private startLongtaskObserver(): void {
        if (typeof PerformanceObserver === 'undefined') return;
        try {
            this.longtaskObserver = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    if (entry.duration >= LONGTASK_MIN_MS) {
                        this.recordSpike(entry.duration, 'longtask');
                    }
                }
            });
            this.longtaskObserver.observe({ entryTypes: ['longtask'] });
        } catch {
            /* 不支持 longtask 的环境：只靠帧间隔尖峰 */
        }
    }

    private recordSpike(deltaMs: number, kind: PerfSpikeRecord['kind']): void {
        this.spikes.push({
            t: Math.round((performance.now() - this.startedAt) / 100) / 10,
            deltaMs: Math.round(deltaMs),
            kind,
            snapshot: {
                ...this.snapshot(),
                heapMB: this.heapMB(),
                gbcrPerSec: Math.round(this.gbcrRate),
                // 哪次构建产生的记录（旧包/新包一眼区分，排查的前提）
                build: BUILD_STAMP,
            },
        });
        if (this.spikes.length > MAX_SPIKES) this.spikes.shift();
    }

    // ==================================================================
    // gBCR 计数（强制布局速率）
    // ==================================================================

    private installGbcrCounter(): void {
        const proto = Element.prototype;
        this.gbcrOrig = proto.getBoundingClientRect;
        const orig = this.gbcrOrig;
        const self = this;
        proto.getBoundingClientRect = function (this: Element) {
            self.gbcrCount++;
            return orig.call(this);
        };
    }

    private heapMB(): number {
        const mem = (
            performance as unknown as { memory?: { usedJSHeapSize: number } }
        ).memory;
        return mem ? Math.round(mem.usedJSHeapSize / 1048576) : -1;
    }

    // ==================================================================
    // 文本刷新
    // ==================================================================

    private tick(): void {
        const snap = this.snapshot();
        // 速率 = 计数器增量 / 周期间隔。
        // 第一个周期不算：HUD 可能挂在画布已经跑了一阵之后，
        // 计数器基数不是 0，直接算会把历史全部计入「这一秒」
        const created = Number(snap.createdTotal ?? 0);
        if (this.lastCreated === 0 && created > 0) this.lastCreated = created;
        this.swapRate = (created - this.lastCreated) / (TEXT_TICK_MS / 1000);
        this.lastCreated = created;
        this.gbcrRate = (this.gbcrCount - this.lastGbcr) / (TEXT_TICK_MS / 1000);
        this.lastGbcr = this.gbcrCount;
        // 帧率：滚动窗口的平均间隔
        if (this.deltas.length > 0) {
            const avg = this.deltas.reduce((a, b) => a + b, 0) / this.deltas.length;
            this.fps = Math.round(1000 / Math.max(1, avg));
        }
        const parts = [
            `${this.fps}fps`,
            `堆 ${this.heapMB()}MB`,
            `DOM ${document.getElementsByTagName('*').length}`,
            `实例 ${snap.displays ?? '?'}/${snap.mounted ?? '?'}`,
            `队列 ${snap.queue ?? '?'}`,
            `换真 ${this.swapRate.toFixed(1)}/s`,
            `布局 ${Math.round(this.gbcrRate)}/s`,
            // 挂载/卸载累计：手势期间这两个数应该纹丝不动（双圈预制的验收口径）
            `挂${snap.mountTotal ?? '?'}/卸${snap.unmountTotal ?? '?'}`,
            `档${snap.tier ?? '?'}`,
        ];
        if (snap.interacting) parts.push('手势中');
        if (snap.editing) parts.push('编辑中');
        this.textEl.textContent = parts.join(' | ');
        this.spikeEl.textContent =
            this.spikes.length > 0
                ? `尖峰 ${this.spikes.length} 条（最近 ${this.spikes[this.spikes.length - 1].deltaMs}ms ${this.spikes[this.spikes.length - 1].kind}）`
                : '无尖峰';
    }

    /** 把尖峰记录复制到剪贴板（走 relay，webview 直写不稳定）。 */
    private copySpikes(button: HTMLButtonElement): void {
        const payload = JSON.stringify(
            {
                note: 'LiveWriteMD 导图性能尖峰记录',
                capturedAt: new Date().toISOString(),
                spikes: this.spikes,
            },
            null,
            1
        );
        // copyToClipboard 是 state.ts 的 relay：host 可用走宿主，否则退 navigator
        void import('../codemirror/extensions/livePreview/state.js').then(({ copyToClipboard }) => {
            void copyToClipboard(payload);
        });
        button.textContent = `已复制 ${this.spikes.length} 条`;
        setTimeout(() => {
            button.textContent = '复制尖峰记录';
        }, 1500);
    }

    /** 销毁：停循环、摘 DOM、恢复 gBCR。 */
    destroy(): void {
        if (this.rafId !== null) cancelAnimationFrame(this.rafId);
        if (this.timer !== null) clearInterval(this.timer);
        this.longtaskObserver?.disconnect();
        if (this.gbcrOrig) Element.prototype.getBoundingClientRect = this.gbcrOrig;
        this.el.remove();
    }
}
