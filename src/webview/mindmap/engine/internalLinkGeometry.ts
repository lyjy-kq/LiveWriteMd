/**
 * 内链箭头几何（从 canvas.ts 拆出）：贝塞尔箭头路径与矩形出射线，纯函数。
 *
 * @module webview/mindmap/engine/internalLinkGeometry
 */

import type { MapNode } from './model.js';

/**
 * 内链箭头几何：起止点取「中心连线与节点矩形边框的交点」（不穿节点），
 * 中间一个微弯的二次贝塞尔，目标端沿末端切线画小实心三角。
 *
 * 可见路径按遮挡矩形裁剪：贝塞尔采样成 64 段折线，中点落在任一节点
 * 矩形（外扩 3px）里的段直接不画，得到若干 M/L 子路径 —— 节点底色是
 * 半透明混色，不裁的话虚线会透过节点身体显示出来（看着像画在节点上）。
 * 源 / 目标节点自身除外（端点本来就该贴在它们的边框上）。
 *
 * @returns 可见路径 d（已裁剪）、命中路径 hitD（完整曲线）与三角 points；
 *          两节点中心重合 / 距离过近时返回 null
 */
export function computeInternalLinkGeometry(
    from: MapNode,
    to: MapNode,
    occluders: Array<{ x: number; y: number; w: number; h: number }>
): { d: string; hitD: string; points: string } | null {
    const cx1 = from.x + from.width / 2;
    const cy1 = from.y + from.height / 2;
    const cx2 = to.x + to.width / 2;
    const cy2 = to.y + to.height / 2;
    const dx = cx2 - cx1;
    const dy = cy2 - cy1;
    if (dx === 0 && dy === 0) return null;
    const t1 = rayExitRect(cx1, cy1, dx, dy, from);
    const t2 = rayExitRect(cx2, cy2, -dx, -dy, to);
    const x1 = cx1 + dx * t1;
    const y1 = cy1 + dy * t1;
    const x2 = cx2 - dx * t2;
    const y2 = cy2 - dy * t2;
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 1) return null;
    // 微弯：控制点在连线中点的法向上，弯曲量随距离收敛（10~60px），
    // 避免和正交的树连线重合，也不会弯成夸张的弧线
    const bend = Math.min(60, Math.max(10, len * 0.12));
    const nx = -(y2 - y1) / len;
    const ny = (x2 - x1) / len;
    const cx = (x1 + x2) / 2 + nx * bend;
    const cy = (y1 + y2) / 2 + ny * bend;
    // 目标端三角：沿二次贝塞尔的末端切线方向
    const tx = x2 - cx;
    const ty = y2 - cy;
    const tl = Math.hypot(tx, ty) || 1;
    const ux = tx / tl;
    const uy = ty / tl;
    const headLen = 8;
    const headW = 5;
    const bx = x2 - ux * headLen;
    const by = y2 - uy * headLen;
    const points = `${x2},${y2} ${bx - uy * (headW / 2)},${by + ux * (headW / 2)} ${bx + uy * (headW / 2)},${by - ux * (headW / 2)}`;

    const hitD = `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;

    // 遮挡矩形：排除源 / 目标节点自身，外扩 3px 让虚线在节点边缘外就断开
    const pad = 3;
    const rects = occluders.filter(
        (r) =>
            !(r.x === from.x && r.y === from.y && r.w === from.width && r.h === from.height) &&
            !(r.x === to.x && r.y === to.y && r.w === to.width && r.h === to.height)
    );
    // 二次贝塞尔采样：p(t) = (1-t)²p0 + 2(1-t)t·c + t²p1
    const SAMPLES = 64;
    const pointAt = (t: number): { x: number; y: number } => {
        const u = 1 - t;
        return {
            x: u * u * x1 + 2 * u * t * cx + t * t * x2,
            y: u * u * y1 + 2 * u * t * cy + t * t * y2,
        };
    };
    const occluded = (x: number, y: number): boolean => {
        for (const r of rects) {
            if (
                x >= r.x - pad &&
                x <= r.x + r.w + pad &&
                y >= r.y - pad &&
                y <= r.y + r.h + pad
            ) {
                return true;
            }
        }
        return false;
    };
    let d = '';
    let penDown = false;
    let prev = pointAt(0);
    for (let i = 1; i <= SAMPLES; i++) {
        const cur = pointAt(i / SAMPLES);
        const midX = (prev.x + cur.x) / 2;
        const midY = (prev.y + cur.y) / 2;
        if (!occluded(midX, midY)) {
            d += penDown ? ` L ${cur.x} ${cur.y}` : ` M ${prev.x} ${prev.y} L ${cur.x} ${cur.y}`;
            penDown = true;
        } else {
            penDown = false;
        }
        prev = cur;
    }
    if (!d) return null;
    return { d, hitD, points };
}

/** 从节点中心沿 (dx,dy) 方向出射，求与矩形边框交点的射线参数 t。 */
export function rayExitRect(
    cx: number,
    cy: number,
    dx: number,
    dy: number,
    node: MapNode
): number {
    let t = Infinity;
    if (dx > 0) t = Math.min(t, (node.x + node.width - cx) / dx);
    else if (dx < 0) t = Math.min(t, (node.x - cx) / dx);
    if (dy > 0) t = Math.min(t, (node.y + node.height - cy) / dy);
    else if (dy < 0) t = Math.min(t, (node.y - cy) / dy);
    return Number.isFinite(t) && t > 0 ? t : 0;
}
