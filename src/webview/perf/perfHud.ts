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
import {
    recentSpans,
    setPerfProbeEnabled,
} from './perfProbe.js';

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
/** 165Hz 下 median≈6ms；24ms 已经掉了 4 帧，20~32ms 的卡顿不能再吞掉。 */
const SPIKE_MIN_MS = 24;
/** 长任务阈值（ms）：longtask 规范下限就是 50ms。 */
const LONGTASK_MIN_MS = 50;
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
    /** 上一次文本刷新时的中位帧间隔（尖峰判定用，避免每帧排序）。 */
    private medianDelta = 16.7;
    /** 上一次文本刷新的时刻（尖峰现场算 since-tick 增量）。 */
    private lastTickAt = 0;
    private readonly spikes: PerfSpikeRecord[] = [];

    // —— 强制布局读计数（仅完整档，HUD 存活期间包装，destroy 时恢复）——
    //
    // 只数 getBoundingClientRect 是不够的：offsetHeight / scrollWidth /
    // clientHeight 这些属性同样会把脏布局同步算出来，而且幻灯片模式的
    // 自适应（fitPageElement）恰恰全走这几个属性。分开计数，既能看总
    // 布局压力，也能一眼分辨「是不是 gBCR 这一路」。
    private gbcrCount = 0;
    private layoutReadCount = 0;
    private readonly layoutRestore: Array<{
        proto: object;
        name: string;
        desc: PropertyDescriptor;
    }> = [];
    private gbcrOrig: typeof Element.prototype.getBoundingClientRect | null = null;
    /** 上一文本周期的瞬时速率基数。 */
    private lastCreated = 0;
    private lastGbcr = 0;
    private lastLayoutReads = 0;
    private swapRate = 0;
    private gbcrRate = 0;
    private layoutRate = 0;
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
            // 只记录最近操作，不采样；关闭时调用点只多一次布尔判断
            setPerfProbeEnabled(true);
        }
        this.startFpsLoop();
        this.lastTickAt = performance.now();
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
        if (delta < Math.max(this.medianDelta * SPIKE_FACTOR, SPIKE_MIN_MS)) {
            return;
        }
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
        // 现场快照要能回答「尖峰发生时停在哪个模式、文件多大、刚才在跑什么」
        const snap = this.snapshot();
        const now = performance.now();
        this.spikes.push({
            t: Math.round((now - this.startedAt) / 100) / 10,
            deltaMs: Math.round(deltaMs),
            kind,
            snapshot: {
                line: snap.line,
                ...snap.raw,
                heapMB: this.heapMB(),
                domNodes: document.getElementsByTagName('*').length,
                // 速率（上一 500ms 窗口）与「本窗口增量」都保留：
                // 尖峰可能发生在两次 tick 之间，只读 rate 会拿到 0
                gbcrPerSec: Math.round(this.gbcrRate),
                layoutReadsPerSec: Math.round(this.layoutRate),
                gbcrSinceTick: this.gbcrCount - this.lastGbcr,
                layoutReadsSinceTick:
                    this.layoutReadCount - this.lastLayoutReads,
                sinceTickMs: Math.round(Math.max(1, now - this.lastTickAt)),
                // 尖峰前刚结束的关键操作（翻页 / 填充 / 测量 / 分页……）
                recentSpans: recentSpans(),
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
            self.layoutReadCount++;
            return orig.call(this);
        };
        // 布局属性读取：与 gBCR 同源，都是「读几何 → 浏览器必须先排版」。
        //
        // 注意描述符所在的接口不一样：offset* 在 HTMLElement.prototype，
        // client* / scroll* 在 Element.prototype（SVG 元素也走这一层）。
        // 以前全从 HTMLElement.prototype 取，client/scroll 四个属性被
        // 静默跳过 —— 幻灯片自适应恰好大量读 clientHeight/scrollWidth，
        // HUD 的「布局」读数因此长期偏低。
        const groups: Array<{ proto: object; names: readonly string[] }> = [
            {
                proto: Element.prototype,
                names: [
                    'clientWidth',
                    'clientHeight',
                    'clientTop',
                    'clientLeft',
                    'scrollWidth',
                    'scrollHeight',
                    'scrollTop',
                    'scrollLeft',
                    'getClientRects',
                ],
            },
            {
                proto: HTMLElement.prototype,
                names: [
                    'offsetHeight',
                    'offsetWidth',
                    'offsetTop',
                    'offsetLeft',
                ],
            },
        ];
        for (const group of groups) {
            for (const name of group.names) {
                const desc = Object.getOwnPropertyDescriptor(group.proto, name);
                if (!desc?.get && !desc?.value) continue;
                if (desc.get) {
                    const getter = desc.get;
                    Object.defineProperty(group.proto, name, {
                        configurable: true,
                        enumerable: desc.enumerable,
                        get(this: Element) {
                            self.layoutReadCount++;
                            return getter.call(this);
                        },
                    });
                } else {
                    // getClientRects 是方法而不是 getter：包一层函数
                    const original = desc.value as (
                        ...args: unknown[]
                    ) => unknown;
                    Object.defineProperty(group.proto, name, {
                        configurable: true,
                        enumerable: desc.enumerable,
                        value(this: Element, ...args: unknown[]) {
                            self.layoutReadCount++;
                            return original.apply(this, args);
                        },
                    });
                }
                this.layoutRestore.push({
                    proto: group.proto,
                    name,
                    desc,
                });
            }
        }
    }

    /** 恢复布局读包装（destroy 与重复安装时调用）。 */
    private restoreLayoutCounter(): void {
        if (this.gbcrOrig) {
            Element.prototype.getBoundingClientRect = this.gbcrOrig;
            this.gbcrOrig = null;
        }
        for (const item of this.layoutRestore.splice(0)) {
            Object.defineProperty(item.proto, item.name, item.desc);
        }
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
            // 中位数每个刷新周期只算一次：以前每条尖峰都复制+排序 240 个
            // delta，持续卡顿时诊断器自己就成了负担。
            const sorted = [...this.deltas].sort((a, b) => a - b);
            this.medianDelta = sorted[Math.floor(sorted.length / 2)] ?? 16.7;
        }
        this.lastTickAt = performance.now();

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
        this.layoutRate =
            (this.layoutReadCount - this.lastLayoutReads) /
            (TEXT_TICK_MS / 1000);
        this.lastLayoutReads = this.layoutReadCount;

        const parts = [
            `${this.fps}fps`,
            `堆 ${this.heapMB()}MB`,
            `DOM ${document.getElementsByTagName('*').length}`,
            snap.line,
            `布局读 ${Math.round(this.layoutRate)}/s`,
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
        this.restoreLayoutCounter();
        if (this.mode === 'full') setPerfProbeEnabled(false);
        this.el.remove();
    }
}
