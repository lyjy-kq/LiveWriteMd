/**
 * MapCanvas 协作模块（从 canvas.ts 拆出）：视口与渲染档：transform/缩放/fit + 缩放降级档管理。
 *
 * 全部是原 MapCanvas 方法，this 换成第一参数 c；跨模块调用走 c 上的薄包装方法，行为与拆前完全一致。
 *
 * @module webview/mindmap/engine/viewport
 */

import { HI_ZOOM_THRESHOLD, MAX_ZOOM, MIN_ZOOM, ZOOM_SETTLE_MS } from './canvasConstants.js';
import type { MapCanvas } from './canvas.js';
import { computeBounds } from './layout.js';
import type { MapBounds } from './layout.js';
import { walkVisible } from './model.js';
import type { MapNode } from './model.js';


/**
 * 手势期间是否放弃合成层提升（设置：「手势期间保持清晰」）。
 *
 * 默认关闭：拖动时给世界层、缩放时给缩放层加 will-change，手势期间
 * 每帧只改合成属性，帧率最好；但合成层中的文字只能用灰度抗锯齿
 * （实测次像素彩边归零、Laplacian 214.72 / 192.36 对 194.68）。
 *
 * 开启后手势期间不再加这两个 class：世界层/缩放层始终是普通层，
 * Chromium 每帧按当前比例重新栅格化，文字在运动中也保持 LCD 次像素
 * 抗锯齿；代价是每帧重绘视口（大文档可能掉帧）。切换时顺手把可能
 * 残留的 class 清掉，免得设置改了但要等下一次手势才生效。
 *
 * @param enabled - true = 手势期间也保持清晰（不加 will-change）
 */
export function setGestureCrisp(c: MapCanvas, enabled: boolean) : void {
    c.gestureCrisp = enabled;
    // 只切一个 class：真正的「不提升」写在 CSS 里（.lwm-canvas.lwm-crisp
    // 覆盖 lwm-panning / lwm-zooming 的 will-change）。这样平移时的
    // cursor: grabbing 之类挂在原 class 上的样式不受影响。
    c.canvasEl.classList.toggle('lwm-crisp', enabled);
}


// ==================================================================
// 视口操作
// ==================================================================

/**
 * 世界层变换（唯一改动 translate/scale 的地方）。
 *
 * 平移与缩放拆成两层：
 * - `.lwm-world` 只写 translate。拖动时带 will-change，但平移不改变比例，
 *   Chromium 可以安全复用 1x 位图，文字不发虚；
 * - `.lwm-scaler` 只写 scale。平时不提升，浏览器按当前比例直接栅格化；
 *   只有在滚轮缩放的过程中才临时提升（见 markZooming）。
 *
 * 以前两者写在同一个元素上：will-change 把位图钉在 1x，scale 只是拉伸
 * 采样，非 100% 缩放下文字整体发虚、边缘出现彩边。
 *
 * 这里用 2D `translate()`，**不要**换成 `translate3d()`：3D 变换会让元素
 * 无条件变成合成层，而合成层里的文字只能用灰度抗锯齿（实测次像素彩边
 * 完全消失、Laplacian 217 → 215），和实时模式一比就显得「有点糊」。
 * 2D 平移不建层，静止时文字和实时模式走同一条次像素渲染路径。
 *
 * 平移量必须对齐到**设备像素**：拖动期间世界层仍是合成层（lwm-panning），
 * 合成层被小数平移时，Chromium 会拿整层位图做双线性重采样 —— 实测整数平移
 * 的 Laplacian 能量约 138，小数平移只剩 49（约六成），整屏文字就是「有点糊」。
 * 而 panX/panY 是浮点数（fit 居中、缩放锚点换算都会得到 401.738 这种值），
 * 所以这里只把写进 CSS 的值按 devicePixelRatio 取整；c.panX/panY 保持原值，
 * 命中测试、缩放锚点、缩略图视口框的数学都不受影响。
 */
export function applyTransform(c: MapCanvas) : void {
    const dpr = window.devicePixelRatio || 1;
    const panX = Math.round(c.panX * dpr) / dpr;
    const panY = Math.round(c.panY * dpr) / dpr;
    c.worldEl.style.transform = `translate(${panX}px, ${panY}px)`;
    c.scalerEl.style.transform = `scale(${c.zoom})`;
    // 高倍缩放下的阅读增强：只切一个 class，真正的「压底色」写在 CSS 里。
    // 这里只在跨过阈值时动 DOM，平移/缩放的每一帧不会重复写 classList。
    const hiZoom = c.zoom >= HI_ZOOM_THRESHOLD;
    if (hiZoom !== c.hiZoomActive) {
        c.hiZoomActive = hiZoom;
        c.canvasEl.classList.toggle('lwm-hi-zoom', hiZoom);
    }
    // 视口框跟着动；重绘是合并的，拖动画布时也不会每帧都重画整棵树
    c.scheduleMinimap();
}


/**
 * 标记「正在滚轮缩放」：给缩放层临时提升合成层。
 *
 * 缩放时每帧都要改 scale，如果不提升，浏览器每帧都得按新比例重新栅格化
 * 视口内的文字（大文档会掉帧）。提升后每帧只改合成属性，代价是运动中
 * 文字由缓存位图拉伸（略糊）—— 正在动，看不出来。
 *
 * 手势停下 ZOOM_SETTLE_MS 后撤掉 class，缩放层退回普通渲染，浏览器
 * 按最终比例重新栅格化，文字立刻恢复清晰。
 */
export function markZooming(c: MapCanvas) : void {
    c.canvasEl.classList.add('lwm-zooming');
    if (c.zoomTimer !== null) clearTimeout(c.zoomTimer);
    c.zoomTimer = setTimeout(() => {
        c.zoomTimer = null;
        c.canvasEl.classList.remove('lwm-zooming');
    }, ZOOM_SETTLE_MS);
}


/**
 * 撤掉世界层的空闲合成提升。
 *
 * 以前这里是「空闲 160ms 后加 will-change，免得下次拖动第一帧现场建层」。
 * 但 will-change 会把世界层变成合成层，合成层里的文字只能用灰度抗锯齿：
 * 实测有提升时文字次像素彩边完全消失（Laplacian 217 → 192，且缩放后
 * 旧位图还会被拉伸），和实时模式并排一看就是「有点糊」。
 *
 * 现在清晰度优先：静止时绝不提升，只有拖动（lwm-panning）和滚轮缩放
 * （lwm-zooming）期间才临时提升。代价是每次开始拖动的第一帧要现场
 * 建层 + 栅格化（一次性几十 ms），换来的是松手后立刻恢复和实时模式
 * 完全一致的次像素抗锯齿。
 */
export function scheduleWorldLayer(c: MapCanvas) : void {
    c.canvasEl.classList.remove('lwm-layer-ready');
}


/**
 * 容器可视尺寸（优先用缓存）。
 *
 * 平移期间每帧都会调用；getBoundingClientRect 在刚改过 DOM 之后会
 * 触发一次同步布局，能省则省。resize()/fit() 会写这两个缓存值。
 */
export function viewSize(c: MapCanvas) : { width: number; height: number } {
    if (c.lastViewWidth > 0 && c.lastViewHeight > 0) {
        return { width: c.lastViewWidth, height: c.lastViewHeight };
    }
    const rect = c.container.getBoundingClientRect();
    if (rect.width > 0) c.lastViewWidth = rect.width;
    if (rect.height > 0) c.lastViewHeight = rect.height;
    return { width: rect.width, height: rect.height };
}


/**
 * 可见节点包围盒（带缓存）。
 *
 * 布局是纯数字计算，重排在 relayout 一次完成；之后包围盒不会再变。
 * 缩略图每 40ms 就要用一次，以前每次都遍历整棵树（大文档平移时
 * 等于每帧多走两遍全树）。relayout 负责把缓存置空。
 */
export function getBounds(c: MapCanvas) : MapBounds | null {
    if (!c.root) return null;
    if (!c.boundsCache) c.boundsCache = computeBounds(c.root);
    return c.boundsCache;
}


/** 屏幕坐标 → 世界坐标。 */
export function screenToWorld(c: MapCanvas, clientX: number, clientY: number) : { x: number; y: number } {
    const rect = c.container.getBoundingClientRect();
    return {
        x: (clientX - rect.left - c.panX) / c.zoom,
        y: (clientY - rect.top - c.panY) / c.zoom,
    };
}


/** 以容器内某点为锚缩放。 */
export function zoomAt(c: MapCanvas, screenX: number, screenY: number, nextZoom: number) : void {
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
    if (zoom === c.zoom) return;
    const worldX = (screenX - c.panX) / c.zoom;
    const worldY = (screenY - c.panY) / c.zoom;
    c.zoom = zoom;
    c.panX = screenX - worldX * zoom;
    c.panY = screenY - worldY * zoom;
    // 缩放进行中：缩放层临时提升为合成层，每帧只改 scale 不重栅格化
    c.markZooming();
    c.applyTransform();
    c.scheduleViewport();
    // 缩放改变了栅格化比例：撤掉空闲合成层，停下后按新比例再提升
    c.scheduleWorldLayer();
}


/** 适应画布。 */
export function fit(c: MapCanvas) : void {
    if (!c.root) return;
    const rect = c.container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const bounds = c.getBounds();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
    const padding = 64;
    const scale = Math.min(
        MAX_ZOOM,
        Math.max(
            MIN_ZOOM,
            Math.min(
                (rect.width - padding * 2) / bounds.width,
                (rect.height - padding * 2) / bounds.height,
                1.25
            )
        )
    );
    c.zoom = scale;
    c.panX = rect.width / 2 - (bounds.left + bounds.width / 2) * scale;
    c.panY = rect.height / 2 - (bounds.top + bounds.height / 2) * scale;
    // fit 已按当前尺寸居中：记下基准，后续 resize 只补偿增量
    c.lastViewWidth = rect.width;
    c.lastViewHeight = rect.height;
    c.hasFit = true;
    c.applyTransform();
    c.updateViewport();
    c.options.onViewChange();
    // fit 改变缩放：等这一轮渲染稳定后再提升合成层
    c.scheduleWorldLayer();
}


/**
 * 直接把缩放设成指定百分比（以容器中心为锚点）。
 *
 * 模式切换用：从 live 进导图时要求固定 100%，而 setActive 里的 fit()
 * 会按整棵树自动算一个缩放。zoomAt 是唯一能同时维护 pan/zoom 与
 * 降级档位的入口，所以这里包一层，不直接改 c.zoom。
 *
 * @param percent 缩放百分比（100 = 原始大小）
 */
export function setZoomPercent(c: MapCanvas, percent: number) : void {
    const rect = c.container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    c.zoomAt(rect.width / 2, rect.height / 2, percent / 100);
}


/**
 * 视口中心所在的节点（取包含中心点的最深一层）。
 *
 * live → map 的「从当前页中间开始」反向操作用：map → live 时如果
 * 没有选中节点，就以用户正在看的画面中心为准。
 */
export function getNodeAtViewportCenter(c: MapCanvas) : MapNode | null {
    if (!c.root) return null;
    const rect = c.container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const worldX = (rect.width / 2 - c.panX) / c.zoom;
    const worldY = (rect.height / 2 - c.panY) / c.zoom;
    // byUid 含折叠子树里的节点；只从**可见**节点里挑，否则会返回
    // 一个根本不在屏幕上的节点位置
    let best: MapNode | null = null;
    walkVisible(c.root, (node) => {
        if (
            worldX < node.x ||
            worldX > node.x + node.width ||
            worldY < node.y ||
            worldY > node.y + node.height
        ) {
            return;
        }
        // 包含中心点的节点里取最深的一层（节点之间可能有重叠的布局盒子）
        if (!best || node.depth > best.depth) best = node;
    });
    return best;
}


/** 把节点平移到容器中心。 */
export function centerOn(c: MapCanvas, uid: string) : void {
    const node = c.byUid.get(uid);
    if (!node) return;
    const rect = c.container.getBoundingClientRect();
    c.panX = rect.width / 2 - (node.x + node.width / 2) * c.zoom;
    c.panY = rect.height / 2 - (node.y + node.height / 2) * c.zoom;
    c.applyTransform();
    c.updateViewport();
    c.options.onViewChange();
}


/** 节点相对容器的屏幕盒子（工具条定位用）。 */
export function getNodeRect(c: MapCanvas, uid: string) : { left: number; top: number; right: number; bottom: number } | null {
    const node = c.byUid.get(uid);
    if (!node) return null;
    const rect = c.container.getBoundingClientRect();
    const left = c.panX + node.x * c.zoom;
    const top = c.panY + node.y * c.zoom;
    return {
        left,
        top,
        right: left + node.width * c.zoom,
        bottom: top + node.height * c.zoom,
    };
}
