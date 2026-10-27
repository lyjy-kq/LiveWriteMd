/**
 * MapCanvas 协作模块（从 canvas.ts 拆出）：视口与渲染档：transform/缩放/fit + 缩放降级档管理。
 *
 * 全部是原 MapCanvas 方法，this 换成第一参数 c；跨模块调用走 c 上的薄包装方法，行为与拆前完全一致。
 *
 * @module webview/mindmap/engine/viewport
 */

import type { RenderTier } from './canvas.js';
import type { MapCanvas } from './canvas.js';
import type { MapBounds } from './layout.js';
import type { MapNode } from './model.js';


/**
 * 设置缩放降级阈值与两个档位的开关（百分比）。
 *
 * 两个阈值把缩放分成三档，跨越阈值时整树按新档重建内容：
 * - zoom >= lite：全量渲染；
 * - plain <= zoom < lite：降级（文本节点轻量 CM，媒体只显示摘要）；
 * - zoom < plain：纯文本（不建任何 CM）。
 *
 * 两个开关默认关闭：关闭的档位无论缩放多小都不会进入，
 * 因此默认行为是「任何缩放比例都全量渲染」。
 *
 * @param litePercent 降级阈值（1-100）
 * @param plainPercent 纯文本阈值（1-100，超过降级阈值时按降级阈值处理）
 * @param liteEnabled 是否启用降级档（缺省沿用当前值）
 * @param plainEnabled 是否启用纯文本档（缺省沿用当前值）
 */
export function setZoomRenderThresholds(c: MapCanvas, litePercent: number, plainPercent: number, liteEnabled: boolean = c.liteEnabled, plainEnabled: boolean = c.plainEnabled) : void {
    const toRatio = (value: number): number =>
        Math.min(100, Math.max(1, value)) / 100;
    const lite = toRatio(litePercent);
    // plain 高于 lite 时没有意义（会出现空档），钳到 lite
    const plain = Math.min(toRatio(plainPercent), lite);
    const enabledChanged =
        liteEnabled !== c.liteEnabled || plainEnabled !== c.plainEnabled;
    if (
        lite === c.liteZoom &&
        plain === c.plainZoom &&
        !enabledChanged
    ) {
        return;
    }
    c.liteZoom = lite;
    c.plainZoom = plain;
    c.liteEnabled = liteEnabled;
    c.plainEnabled = plainEnabled;
    // 开关变化必须强制重算档位：回差逻辑会让「关闭某个档」卡在原档里
    // （例如当前在纯文本档、用户关掉它，缩放仍低于阈值 → 不越过回差
    // 边界就永远出不来）。这里直接按无回差目标档同步。
    c.syncRenderTier(enabledChanged);
}


/**
 * 当前缩放「应该」处的档位（无回差）。
 *
 * 关闭的档位直接跳过：纯文本关掉后哪怕 zoom 很小也最多降到降级档；
 * 两个都关掉则始终是全量档。
 */
export function directTier(c: MapCanvas) : RenderTier {
    const zoom = c.zoom;
    if (c.plainEnabled && zoom < c.plainZoom) return 2;
    if (c.liteEnabled && zoom < c.liteZoom) return 1;
    return 0;
}


/**
 * 当前缩放应处的档位。
 *
 * 带回差（2%）：滚轮在阈值附近来回时不会反复触发整树重建 ——
 * 每跨一次阈值都要重建内容 + 重量，抖动一下就是几百毫秒。
 */
export function tierForZoom(c: MapCanvas) : RenderTier {
    const zoom = c.zoom;
    // 先算「无回差」目标档，再按缩放方向决定是否要越过阈值 2% 才生效。
    // 不能只比较相邻档：编辑期间缩放被挂起，结束后可能一次跨两档
    // （例如从 100% 直接滚到 30%），必须一次算到最终档。
    const target: RenderTier = c.directTier();
    if (target === c.renderTier) return target;
    // 当前所在档已被用户关闭：直接跳出去，不走回差。否则缩放仍在
    // 原阈值的死区内（比如 30% < 纯文本阈值 40%），会永远卡在原档。
    if (
        (c.renderTier === 2 && !c.plainEnabled) ||
        (c.renderTier === 1 && !c.liteEnabled)
    ) {
        return target;
    }
    const latch = 0.02;
    const goingDown = target > c.renderTier;
    // 本次要跨过的阈值：向下 = 目标档的上边界；向上 = 当前档的下边界
    const boundary = goingDown
        ? target === 2
            ? c.plainZoom
            : c.liteZoom
        : c.renderTier === 2
          ? c.plainZoom
          : c.liteZoom;
    const deadZone = boundary * latch;
    if (goingDown) {
        return zoom < boundary - deadZone ? target : c.renderTier;
    }
    return zoom > boundary + deadZone ? target : c.renderTier;
}


/**
 * 缩放变化后同步档位（无变化时零开销）。
 *
 * @param force 忽略回差、直接按 directTier 切换（开关变化时用）
 */
export function syncRenderTier(c: MapCanvas, force = false) : void {
    const next = force ? c.directTier() : c.tierForZoom();
    if (next === c.renderTier) return;
    // 编辑中不能整树重建：applyRenderTier 会销毁所有显示实例，
    // 正在编辑的 mini-CM 也在其中（会话持有它的引用，销毁后直接坏掉）。
    // 编辑结束（setEditing(null)）时会再同步一次。
    if (c.editingUid !== null) return;
    c.applyRenderTier(next);
}


/**
 * 切换渲染档：销毁所有显示实例，按新档重建整树内容并重量。
 *
 * 只在跨阈值时发生（回差避免了抖动），一次几百毫秒可以接受；
 * 换来的是小缩放下不再维持成百上千个 live preview 装饰与 widget。
 */
export function applyRenderTier(c: MapCanvas, tier: RenderTier) : void {
    c.renderTier = tier;
    // CSS 钩子：纯文本档可以进一步去掉阴影之类的装饰
    c.container.dataset.lwmTier = String(tier);
    // 换真队列只服务全量 / 轻量档
    c.queue.length = 0;
    c.queued.clear();
    if (c.pumpTimer !== null) {
        clearTimeout(c.pumpTimer);
        c.pumpTimer = null;
    }
    if (!c.root) return;

    // 1) 销毁全部实例（wrapper 保留，DOM 复用），清空内容
    for (const entry of c.displays.values()) entry.display.destroy();
    c.displays.clear();
    for (const node of c.byUid.values()) {
        node.display = null;
        node.placeholder = false;
        node.wrapper?.replaceChildren();
    }

    // 2) 按新档重建内容。档 2 下 ensureContent 只写纯文本占位；
    //    档 1 下仍走渐进预算（先 24 个轻量 CM，其余排队换真）。
    //    手势进行中（滚轮缩放跨档）不预建：24 个 CM 同步造出来
    //    要上百毫秒，等缩放停下后交给换真泵慢慢补。
    c.progressiveCount = 0;
    c.eagerDisplayBudget = c.interactionActive() ? 0 : PROGRESSIVE_THRESHOLD;
    const toMeasure: MapNode[] = [];
    walkAll(c.root, (node) => {
        c.ensureWrapper(node);
        c.ensureContent(node);
        toMeasure.push(node);
    });
    c.eagerDisplayBudget = 0;

    // 3) 内容形态变了（源码 ↔ 轻量 CM ↔ 纯文本）：全部重量一次。
    //    批量测量只触发一次强制布局，比逐节点量便宜得多。
    c.measureNodes(toMeasure);
    c.relayout();
    c.updateViewport();
    c.scheduleMeasureSettle();
}


/**
 * 显示实例 LRU 淘汰开关（设置项，默认关闭）。
 *
 * 从关到开时立刻执行一轮淘汰，而不是等下一次 createDisplay：
 * 用户可能在关闭状态下已经攒了几百个离屏实例，打开设置后应当马上
 * 释放到上限，而不是继续保留。
 */
export function setDisplayCacheEnabled(c: MapCanvas, enabled: boolean) : void {
    if (c.displayCacheEnabled === enabled) return;
    c.displayCacheEnabled = enabled;
    if (enabled) c.enforceDisplayCap();
}


/** 性能模式开关：false = 不做视口裁剪（所有节点常驻 DOM）。 */
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


export function setVirtualization(c: MapCanvas, enabled: boolean) : void {
    if (c.virtualization === enabled) return;
    c.virtualization = enabled;
    if (enabled) {
        c.updateViewport();
    } else if (c.root) {
        walkVisible(c.root, (node) => {
            if (node.wrapper) c.mountNode(node);
        });
        c.updateLinksVisibility();
        c.updateInternalLinksVisibility();
        c.updateExpandButtonsVisibility();
        c.visibilityVersion = c.mountedVersion;
    }
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
    // 跨过降级阈值：先按新档重建内容，再做视口更新
    c.syncRenderTier();
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
    // 大文档 fit 出来可能远低于降级阈值：先切档再更新视口，
    // 否则会先把全量节点挂上去再拆掉
    c.syncRenderTier();
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
