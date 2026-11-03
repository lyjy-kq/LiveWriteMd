/**
 * 全局性能监测浮层（设置「性能监测」开启后挂在窗口右上角）。
 *
 * 这个浮层从导图模式里抽出来，成为所有模式（实时 / 源码 / 阅读 / 导图 /
 * 幻灯片）共用的功能：
 *
 * - 浮层自己只负责**采样与渲染**：帧率、堆内存、DOM 数量、强制布局速率、
 *   长任务与帧率尖峰；
 * - 「当前是哪个模式、文档多大、这个模式有哪些专属指标」由宿主注入的
 *   snapshot 回调提供 —— 所以切模式时不需要销毁 / 重建 HUD，下一次
 *   500ms 刷新自然就换成了新模式的数据。
 *
 * 两个档位：
 * - minimal（极简）：无边框，只显示帧率与堆内存，不做尖峰记录、不包装
 *   gBCR、不装长任务观察器（开销最小，适合日常开着看）；
 * - full（完整）：实时显示帧率 / 堆内存 / DOM / 当前模式摘要 / 强制布局
 *   速率；帧率跳变与长任务发生时记录现场（可复制成 JSON 排查）。
 *
 * @module webview/perf/perfHud
 */

import { BUILD_STAMP } from '../../shared/buildStamp.js';

/** 浮层档位（去掉 off）。 */
export type PerfHudMode = 'minimal' | 'full';

/**
 * 当前模式 / 文档的快照。
 *
 * 由宿主（主编辑器 webview / 独立导图面板）提供，HUD 只负责展示，
 * 不直接认识 CodeMirror / 导图 / 幻灯片实例。
 */
export interface PerfSnapshot {
    /** 模式 + 文档 + 模式专属指标，拼在 HUD 主行末尾。 */
    line: string;
    /**
     * 可选的累计计数器（导图「换真」次数）。
     *
     * 提供时 HUD 会按刷新周期算速率，显示为「换真 x/s」；
     * 文本 / 幻灯片模式不提供，HUD 就不显示这一段。
     */
    createdTotal?: number;
    /** 尖峰现场里要额外带上的原始字段。 */
    raw?: Record<string, unknown>;
}

/** snapshot 回调：每次 HUD 刷新（500ms）调用一次。 */
export type PerfSnapshotProvider = () => PerfSnapshot;

/** 帧率尖峰 / 长任务的一条现场记录。 */
export interface PerfSpikeRecord {
    /** 距 HUD 启动的秒数。 */
    t: number;
    /** 帧间隔（尖峰）或长任务时长。 */
    deltaMs: number;
    kind: 'frame' | 'longtask';
    /** 现场快照（snapshot 原始字段 + 堆 + 布局速率 + 构建戳）。 */
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
    /** 当前档位（设置切换时宿主据此重建）。 */
    public readonly mode: PerfHudMode;

    private readonly el: HTMLDivElement;
    private readonly textEl: HTMLDivElement;
    /** 完整档才有的尖峰说明行。 */
    private readonly spikeEl: HTMLDivElement | null;
    private readonly snapshot: PerfSnapshotProvider;

    private rafId: number | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private longtaskObserver: PerformanceObserver | null = null;

    private readonly startedAt = performance.now();
    /** 上一帧的时间戳（null = 本轮 rAF 还没开始）。 */
    private lastFrame = 0;
    /** 滚动窗口内的帧间隔（ms）。 */
    private deltas: number[] = [];
    private readonly spikes: PerfSpikeRecord[] = [];

    // —— gBCR 计数（仅完整档，HUD 存活期间包装，destroy 时恢复）——
    private gbcrCount = 0;
    private gbcrOrig: typeof Element.prototype.getBoundingClientRect | null = null;
    /** 上一文本周期的瞬时速率基数。 */
    private lastCreated = 0;
    private lastGbcr = 0;
    private swapRate = 0;
    private gbcrRate = 0;
    private fps = 0;

    /**
     * @param container 浮层挂载容器（全局使用传 document.body）
     * @param snapshot 当前模式 / 文档 / 专属指标提供者
     * @param mode 档位
     */
    constructor(
        container: HTMLElement,
        snapshot: PerfSnapshotProvider,
        mode: PerfHudMode = 'full'
    ) {
        this.mode = mode;
        this.snapshot = snapshot;
        this.el = document.createElement('div');
        this.el.className =
            mode === 'minimal' ? 'lwm-perf-hud lwm-perf-hud-minimal' : 'lwm-perf-hud';
        this.textEl = document.createElement('div');
        this.textEl.className = 'lwm-perf-hud-line';
        this.el.appendChild(this.textEl);

        // 尖峰记录 / 复制按钮只有完整档需要；极简档连 DOM 都不建
        this.spikeEl = mode === 'full' ? document.createElement('div') : null;
        if (mode === 'full' && this.spikeEl) {
            this.spikeEl.className = 'lwm-perf-hud-spikes';
            const copyBtn = document.createElement('button');
            copyBtn.type = 'button';
            copyBtn.className = 'lwm-perf-hud-copy';
            copyBtn.textContent = '复制尖峰记录';
            copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.copySpikes(copyBtn);
            });
            this.el.append(this.spikeEl, copyBtn);
        }
        container.appendChild(this.el);

        if (mode === 'full') {
            this.installGbcrCounter();
            this.startLongtaskObserver();
        }
        this.startFpsLoop();
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
                if (this.mode === 'full') this.maybeRecordSpike(delta);
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
        // 现场快照要能回答「尖峰发生时停在哪个模式、文件多大」
        const snap = this.snapshot();
        this.spikes.push({
            t: Math.round((performance.now() - this.startedAt) / 100) / 10,
            deltaMs: Math.round(deltaMs),
            kind,
            snapshot: {
                line: snap.line,
                ...snap.raw,
                heapMB: this.heapMB(),
                gbcrPerSec: Math.round(this.gbcrRate),
                // 哪次构建产生的记录（旧包 / 新包一眼区分，排查的前提）
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
        // 帧率：滚动窗口的平均间隔（两档共用）
        if (this.deltas.length > 0) {
            const avg = this.deltas.reduce((a, b) => a + b, 0) / this.deltas.length;
            this.fps = Math.round(1000 / Math.max(1, avg));
        }

        // 极简档：一行「帧率 · 堆」，不读快照、不算速率
        if (this.mode === 'minimal') {
            const heap = this.heapMB();
            this.textEl.textContent =
                heap >= 0 ? `${this.fps} fps · ${heap} MB` : `${this.fps} fps`;
            return;
        }

        const snap = this.snapshot();

        // 速率 = 计数器增量 / 周期间隔。
        // 第一个周期不算：HUD 可能挂在页面已经跑了一阵之后，
        // 计数器基数不是 0，直接算会把历史全部计入「这一秒」。
        if (snap.createdTotal !== undefined) {
            if (this.lastCreated === 0 && snap.createdTotal > 0) {
                this.lastCreated = snap.createdTotal;
            }
            // 实例重建（INIT / 换文档）会让累计数归零：重置基数，
            // 否则会出现「换真 -12.3/s」这种负速率
            if (snap.createdTotal < this.lastCreated) {
                this.lastCreated = snap.createdTotal;
            }
            this.swapRate =
                (snap.createdTotal - this.lastCreated) / (TEXT_TICK_MS / 1000);
            this.lastCreated = snap.createdTotal;
        }
        this.gbcrRate = (this.gbcrCount - this.lastGbcr) / (TEXT_TICK_MS / 1000);
        this.lastGbcr = this.gbcrCount;

        const parts = [
            `${this.fps}fps`,
            `堆 ${this.heapMB()}MB`,
            `DOM ${document.getElementsByTagName('*').length}`,
            snap.line,
            `布局 ${Math.round(this.gbcrRate)}/s`,
        ];
        // 「换真」只对导图有意义；其它模式 snapshot 不提供 createdTotal
        if (snap.createdTotal !== undefined) {
            parts.splice(parts.length - 1, 0, `换真 ${this.swapRate.toFixed(1)}/s`);
        }
        this.textEl.textContent = parts.filter(Boolean).join(' | ');
        this.spikeEl!.textContent =
            this.spikes.length > 0
                ? `尖峰 ${this.spikes.length} 条（最近 ${this.spikes[this.spikes.length - 1].deltaMs}ms ${this.spikes[this.spikes.length - 1].kind}）`
                : '无尖峰';
    }

    /** 把尖峰记录复制到剪贴板（走 relay，webview 直写不稳定）。 */
    private copySpikes(button: HTMLButtonElement): void {
        const payload = JSON.stringify(
            {
                note: 'LiveWriteMD 性能尖峰记录',
                capturedAt: new Date().toISOString(),
                mode: this.mode,
                spikes: this.spikes,
            },
            null,
            1
        );
        // copyToClipboard 是 state.ts 的 relay：host 可用走宿主，否则退 navigator
        void import('../codemirror/extensions/livePreview/state.js').then(
            ({ copyToClipboard }) => {
                void copyToClipboard(payload);
            }
        );
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
