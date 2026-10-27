/**
 * 列表圆点垂直对齐补偿（从 helpers.ts 拆出）。
 *
 * 0 高 inline-block 的 middle 对齐点实测，供 BulletWidget 做像素级补偿。
 *
 * @module webview/codemirror/extensions/livePreview/bulletAlign
 */

import { getMeasureContext, type MeasureEnv } from './textMeasure.js';

// =============================================================================
// 列表圆点垂直对齐补偿
// =============================================================================
//
// `.cm-md-bullet` 是 0 高 inline-block（唯一子元素绝对定位），圆心经
// top:50% 落在盒子的 `vertical-align:middle` 对齐点上；但源码 `-` 的墨迹
// 中心与该点并不重合 —— Chromium 对空 inline-block 的 middle 落点约在
// 基线之上 0.245em，而 `-` 墨迹中心随实际字体变化，于是圆点系统性偏下。
// 下面把真实差值量出来，交给 BulletWidget 做像素级补偿。

/** middle 对齐点实测结果缓存：同字体环境 1s 内复用，避免反复插探针。 */
let middleAnchorCache: {
    key: string;
    value: number;
    at: number;
} | null = null;

/**
 * 实测「0 高 inline-block 的 `vertical-align:middle` 对齐点」相对父基线的
 * y 偏移。
 *
 * 在与正文同字体的离屏容器里放两个 0 高探针（一个 middle、一个 baseline），
 * 直接量两者顶缘之差 —— 不写死 0.245em 这类经验常数，换引擎/字体都成立。
 *
 * @param size - 正文字号（px）
 * @param family - 正文字体族
 * @returns 偏移量（px，负值 = middle 对齐点在基线之上）
 */
function getMiddleAnchorOffset(size: number, family: string): number {
    const now = Date.now();
    const key = `${size}px ${family}`;
    if (
        middleAnchorCache &&
        middleAnchorCache.key === key &&
        middleAnchorCache.at > now - 1000
    ) {
        return middleAnchorCache.value;
    }

    // 离屏测量宿主：字体与正文完全一致。line-height 给 1 即可——
    // 实测它不影响 0 高探针的落点（探针本身不占行高）。
    const host = document.createElement('div');
    host.style.cssText =
        'position:fixed;top:0;left:-9999px;font:400 ' +
        key +
        ';line-height:1;white-space:pre;';
    // middle 探针：0 高 inline-block，其顶缘（=底缘）即 middle 对齐点
    // baseline 探针：加 overflow:hidden，空 inline-block 的基线 = 自身底缘
    host.innerHTML =
        '<span style="display:inline-block;width:1px;height:0;vertical-align:middle"></span>' +
        '<span style="display:inline-block;width:1px;height:0;overflow:hidden;vertical-align:baseline"></span>';
    document.body.appendChild(host);
    const spans = host.querySelectorAll('span');
    const value =
        spans[0].getBoundingClientRect().top -
        spans[1].getBoundingClientRect().top;
    host.remove();

    middleAnchorCache = { key, value, at: now };
    return value;
}

/**
 * 量「列表圆点圆心」相对 middle 对齐点应补的垂直修正量。
 *
 * 圆心目标定为**行盒中心**（距行顶 lineHeight/2）：水平方向圆点仍对准
 * marker 中点，垂直方向以整行中心为锚（产品决定，见 widgets.ts）。
 *
 * @param marker - 源码标记符（`-` / `*` / `+`），其字体盒中心即行盒中心
 * @returns 圆点 top 应加的修正量（px）；量不到时给 0，退回不补偿的旧行为，
 *          不影响正常渲染
 */
export function measureBulletYCorrection(
    marker = '-',
    env: MeasureEnv | null = null
): number {
    // 整体 try/catch，沿用 openWrap 的硬规矩：任何测量意外（离屏探针挂载、
    // 字体度量失败等）只让本圆点放弃补偿、退回旧行为，绝不能让异常冒泡到
    // 装饰构建期、把整篇装饰拖垮
    try {
        const m = getMeasureContext();
        if (!m) return 0;
        // 优先按调用方给的视图字体（导图节点的 mini-CM），没有才用全局正文口径
        const size = env?.size ?? m.size;
        const family = env?.family ?? m.family;
        // 标记符在源码里是常规字重（400），canvas 字体必须与它一致
        m.ctx.font = `400 ${size}px ${family}`;
        const metrics = m.ctx.measureText(marker);
        // middle 对齐点相对基线的偏移（负 = 在基线之上）
        const middleOffset = getMiddleAnchorOffset(size, family);
        // 圆心目标 = **行盒（line-box）中心**，即「距离行顶 lineHeight/2」。
        // CSS 里半行距 = (line-height − 字体盒高) 上下均分，所以行盒中心
        // 恒等于字体盒（font-bounding box）中心，与行高无关 —— 直接用
        // canvas 的 fontBoundingBox 度量即可，不需要知道实际 line-height。
        const lineBoxCenterOffset =
            (metrics.fontBoundingBoxDescent -
                metrics.fontBoundingBoxAscent) /
            2;
        // correction = 行盒中心 - middle 点
        return lineBoxCenterOffset - middleOffset;
    } catch (error) {
        console.warn(
            '[bullet] 圆点垂直补偿测量失败，放弃补偿：',
            error
        );
        return 0;
    }
}
