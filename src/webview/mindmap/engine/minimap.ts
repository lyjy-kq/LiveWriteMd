/**
 * MapCanvas 协作模块（从 canvas.ts 拆出）：缩略图：几何、离屏 raster 缓存绘制、指针跳转。
 *
 * 全部是原 MapCanvas 方法，this 换成第一参数 c；跨模块调用走 c 上的薄包装方法，行为与拆前完全一致。
 *
 * @module webview/mindmap/engine/minimap
 */

import { MINIMAP_H, MINIMAP_REDRAW_MS, MINIMAP_W } from './canvasConstants.js';
import type { MapCanvas } from './canvas.js';
import { walkVisible } from './model.js';


// ==================================================================
// 缩略图（右下角）
// ==================================================================

/** 合并高频重绘：平移 / 缩放每帧都会调到这里。 */
export function scheduleMinimap(c: MapCanvas) : void {
    if (!c.active) return;
    if (c.minimapTimer !== null) return;
    c.minimapTimer = setTimeout(() => {
        c.minimapTimer = null;
        c.drawMinimap();
    }, MINIMAP_REDRAW_MS);
}


/**
 * 缩略图坐标映射：世界坐标 → 画布像素。
 *
 * 范围取「可见节点包围盒 ∪ 当前视口」，这样放大到某一角时，
 * 视口框也不会跑出缩略图外。
 */
export function minimapGeometry(c: MapCanvas) : { s: number; ox: number; oy: number; /** 容器视口在缩略图里的像素矩形。 */ view: { x: number; y: number; w: number; h: number }; } | null {
    if (!c.root) return null;
    const size = c.viewSize();
    if (size.width <= 0 || size.height <= 0) return null;
    const w = MINIMAP_W;
    const h = MINIMAP_H;
    const bounds = c.getBounds();
    if (!bounds) return null;
    const view = {
        left: -c.panX / c.zoom,
        top: -c.panY / c.zoom,
        right: (size.width - c.panX) / c.zoom,
        bottom: (size.height - c.panY) / c.zoom,
    };
    const left = Math.min(bounds.left, view.left);
    const top = Math.min(bounds.top, view.top);
    const right = Math.max(bounds.right, view.right);
    const bottom = Math.max(bounds.bottom, view.bottom);
    const bw = Math.max(1, right - left);
    const bh = Math.max(1, bottom - top);
    const pad = 8;
    const s = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh);
    // 内容在缩略图里居中
    const ox = (w - bw * s) / 2 - left * s;
    const oy = (h - bh * s) / 2 - top * s;
    return {
        s,
        ox,
        oy,
        view: {
            x: ox + view.left * s,
            y: oy + view.top * s,
            w: (view.right - view.left) * s,
            h: (view.bottom - view.top) * s,
        },
    };
}


/** 重画缩略图：节点方块 + 视口框（不做文字/连线，保持轻量）。 */
export function drawMinimap(c: MapCanvas) : void {
    const canvas = c.minimapEl;
    if (!c.active || !c.root) {
        canvas.classList.remove('lwm-minimap-visible');
        return;
    }
    const geo = c.minimapGeometry();
    if (!geo) {
        canvas.classList.remove('lwm-minimap-visible');
        return;
    }
    const w = MINIMAP_W;
    const h = MINIMAP_H;
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const pxW = Math.round(w * dpr);
    const pxH = Math.round(h * dpr);
    if (canvas.width !== pxW || canvas.height !== pxH) {
        canvas.width = pxW;
        canvas.height = pxH;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    canvas.classList.add('lwm-minimap-visible');

    const dark = c.container.dataset.lwmTheme !== 'light';

    // —— 节点方块：缓存到离屏位图 ——
    // 平移时 geo 不变（内容比视口大时取的是内容包围盒）、节点坐标也不变，
    // 只有视口框在动。重复 walkVisible + 每节点 fillRect 纯属浪费。
    const key = `${geo.s}|${geo.ox}|${geo.oy}|${dpr}|${dark ? 1 : 0}`;
    let raster = c.minimapRaster;
    if (!raster || raster.key !== key) {
        const off = raster?.canvas ?? document.createElement('canvas');
        off.width = pxW;
        off.height = pxH;
        const offCtx = off.getContext('2d');
        if (!offCtx) return;
        offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        offCtx.clearRect(0, 0, w, h);
        // 缩略图只做定位示意，不跟节点的标题色轮换走：按深度给不同亮度，
        // root 最亮、越深越暗，小图里更容易分清主干和末梢
        const fillFor = (depth: number): string => {
            if (depth === 0) return dark ? '#5d9df0' : '#1c6fb5';
            if (depth === 1) return dark ? 'rgba(148,186,232,0.9)' : 'rgba(56,116,176,0.9)';
            return dark ? 'rgba(198,208,224,0.42)' : 'rgba(86,102,124,0.36)';
        };
        walkVisible(c.root, (node) => {
            if (node.width <= 0 || node.height <= 0) return;
            offCtx.fillStyle = fillFor(node.depth);
            const x = geo.ox + node.x * geo.s;
            const y = geo.oy + node.y * geo.s;
            // 至少 2px：缩到很小时方块仍可见（缩略图只需要「有东西」）
            const rw = Math.max(2, node.width * geo.s);
            const rh = Math.max(2, node.height * geo.s);
            offCtx.fillRect(x, y, rw, rh);
        });
        raster = { key, canvas: off };
        c.minimapRaster = raster;
    }
    // 源位图尺寸就是 pxW×pxH，按 CSS 尺寸 w×h 贴回来（ctx 已带 dpr 变换）
    ctx.drawImage(raster.canvas, 0, 0, w, h);

    // 当前视口框
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.78)' : 'rgba(30,45,65,0.72)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(
        geo.view.x + 0.75,
        geo.view.y + 0.75,
        Math.max(2, geo.view.w - 1.5),
        Math.max(2, geo.view.h - 1.5)
    );

    // 右下角缩放比例徽标：用户据此判断当前是否已进入降级 / 纯文本档，
    // 也方便对照设置里的两个阈值（缩放以容器中心为准，显示取整百分比）。
    const label = `${Math.round(c.zoom * 100)}%`;
    ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    const labelTextWidth = ctx.measureText(label).width;
    const boxW = Math.ceil(labelTextWidth) + 10;
    const boxH = 15;
    const boxX = w - boxW - 4;
    const boxY = h - boxH - 4;
    // 半透明底：缩略图里节点方块很密，没有底衬时数字看不清
    ctx.fillStyle = dark ? 'rgba(18,20,26,0.72)' : 'rgba(255,255,255,0.82)';
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.fillStyle = dark ? 'rgba(236,241,250,0.95)' : 'rgba(22,32,46,0.88)';
    ctx.fillText(label, boxX + boxW - 5, boxY + boxH - 2);
}


/** 缩略图画布坐标 → 世界坐标。 */
export function minimapScreenToWorld(c: MapCanvas, clientX: number, clientY: number) : { x: number; y: number } | null {
    const geo = c.minimapGeometry();
    if (!geo) return null;
    const rect = c.minimapEl.getBoundingClientRect();
    return {
        x: (clientX - rect.left - geo.ox) / geo.s,
        y: (clientY - rect.top - geo.oy) / geo.s,
    };
}


/** 按下缩略图：跳转，并进入拖动模式。 */
export function handleMinimapPointerDown(c: MapCanvas, event: PointerEvent) : void {
    if (!c.active || event.button === 2) return;
    event.preventDefault();
    event.stopPropagation();
    c.minimapPointerId = event.pointerId;
    try {
        c.minimapEl.setPointerCapture(event.pointerId);
    } catch {
        /* 某些环境不支持捕获：拖动退化为单次点击 */
    }
    c.minimapJumpTo(event.clientX, event.clientY);
}


export function handleMinimapPointerMove(c: MapCanvas, event: PointerEvent) : void {
    if (c.minimapPointerId !== event.pointerId) return;
    event.preventDefault();
    c.minimapJumpTo(event.clientX, event.clientY);
}


export function handleMinimapPointerUp(c: MapCanvas, event: PointerEvent) : void {
    if (c.minimapPointerId !== event.pointerId) return;
    c.minimapPointerId = null;
    try {
        c.minimapEl.releasePointerCapture(event.pointerId);
    } catch {
        /* 已释放 */
    }
}


/** 把点击处的世界坐标移到容器中心。 */
export function minimapJumpTo(c: MapCanvas, clientX: number, clientY: number) : void {
    const world = c.minimapScreenToWorld(clientX, clientY);
    if (!world) return;
    const rect = c.container.getBoundingClientRect();
    c.panX = rect.width / 2 - world.x * c.zoom;
    c.panY = rect.height / 2 - world.y * c.zoom;
    c.applyTransform();
    c.scheduleViewport();
}
