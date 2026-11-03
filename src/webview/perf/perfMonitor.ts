/**
 * 全局性能监测控制器。
 *
 * 每个 webview（主编辑器 / 独立导图面板）各有一个实例，负责：
 * 1. 读设置 `perfMonitor`（off / minimal / full）；
 * 2. 需要时把 HUD 挂到 document.body（fixed 定位，所有模式都能看到）；
 * 3. 设置改动时幂等切换档位，关闭时彻底销毁（连 rAF / 定时器一起停）。
 *
 * 数据从哪来由宿主通过 setPerfSnapshotProvider 注入，本模块不认识
 * CodeMirror / 导图 / 幻灯片，方便主 webview 和独立面板各取所需。
 *
 * @module webview/perf/perfMonitor
 */

import { settingsState } from '../settings/settingsState.js';
import {
    PerfHud,
    type PerfHudMode,
    type PerfSnapshotProvider,
} from './perfHud.js';

/** 当前快照提供者；宿主启动 / INIT 时注册。 */
let provider: PerfSnapshotProvider = () => ({ line: '' });

/** 当前存活的浮层（off 时为 null）。 */
let hud: PerfHud | null = null;

/**
 * 注册快照提供者。
 *
 * HUD 在 tick 时通过闭包调用最新的 provider，因此宿主在设置变化、
 * 换文档等场景下不需要重建 HUD，只要这里保持同一个单例即可。
 */
export function setPerfSnapshotProvider(next: PerfSnapshotProvider): void {
    provider = next;
}

/** 从 settingsState 解析档位（未知值一律当关闭）。 */
function readMode(): PerfHudMode | 'off' {
    const raw = settingsState.getString('perfMonitor');
    return raw === 'minimal' || raw === 'full' ? raw : 'off';
}

/**
 * 按当前设置挂载 / 切换 / 销毁浮层（幂等）。
 *
 * 调用时机：INIT 应用完 allSettings 之后、SETTINGS_CHANGE 之后、
 * 设置面板当场改完（本地先生效）之后。
 */
export function syncPerfMonitor(): void {
    const mode = readMode();

    if (mode === 'off') {
        if (hud) {
            hud.destroy();
            hud = null;
        }
        return;
    }

    // 档位没变就保留现有实例：反复 sync 不重建 rAF 采样，
    // 也不会反复包装 / 恢复 getBoundingClientRect。
    if (hud?.mode === mode) return;

    hud?.destroy();
    // 挂 body 而不是某个模式容器：fixed 定位，实时 / 源码 / 阅读 /
    // 导图 / 幻灯片切换时浮层原地不动。
    hud = new PerfHud(document.body, () => provider(), mode);
}
