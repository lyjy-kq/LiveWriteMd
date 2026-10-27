/**
 * MapCanvas 协作模块（从 canvas.ts 拆出）：连线与展开按钮：树连线、内链箭头层、展开按钮同步。
 *
 * 全部是原 MapCanvas 方法，this 换成第一参数 c；跨模块调用走 c 上的薄包装方法，行为与拆前完全一致。
 *
 * @module webview/mindmap/engine/links
 */

import type { MapCanvas } from './canvas.js';


// ==================================================================
// 连线 / 展开按钮
// ==================================================================

/** 重排后同步节点位置、连线、展开按钮。 */
export function relayout(c: MapCanvas) : void {
    if (!c.root) return;
    // 节点坐标/尺寸要变了：包围盒缓存与缩略图位图都作废
    c.boundsCache = null;
    c.minimapRaster = null;
    layoutMap(c.root);
    for (const uid of c.mounted) {
        const node = c.byUid.get(uid);
        if (node) c.positionNode(node);
    }
    c.syncLinksExtent();
    c.syncLinks();
    // 内链箭头跟着布局走（节点坐标变了，箭头端点与弯曲都要重算）
    c.syncInternalLinks();
    c.syncExpandButtons();
    // 节点坐标变了：缩略图里的方块要重画（合并到下一轮）
    c.scheduleMinimap();
}


/**
 * 把连线 SVG 的尺寸撑到整棵树的范围。
 *
 * 外层的 `<svg>` 默认只有 0×0。虽然可以靠 CSS `overflow: visible`
 * 把内容画到视口外，但不同浏览器/导出路径（foreignObject）表现不一致，
 * 实测会出现「节点都在、线全没了」—— 所以按包围盒显式给宽高。
 * 布局从 (0,0) 向右生长，坐标恒为非负，不需要 viewBox 平移。
 */
export function syncLinksExtent(c: MapCanvas) : void {
    if (!c.root) return;
    const bounds = c.getBounds();
    if (!bounds) return;
    // 正交折线全部落在节点包围盒内，留一点余量防端点被裁
    const pad = 64;
    c.linksSvg.setAttribute('width', String(Math.max(1, Math.ceil(bounds.right + pad))));
    c.linksSvg.setAttribute('height', String(Math.max(1, Math.ceil(bounds.bottom + pad))));
}


/** 同步连线（只保留可见父子对）。 */
export function syncLinks(c: MapCanvas) : void {
    if (!c.root) return;
    const alive = new Set<string>();
    walkVisible(c.root, (node) => {
        const parent = node.parent;
        if (!parent || !parent.expand) return;
        alive.add(node.uid);
        let path = c.linkPaths.get(node.uid);
        if (!path) {
            path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.classList.add('lwm-link');
            c.linksSvg.appendChild(path);
            c.linkPaths.set(node.uid, path);
        }
        // —— 正交连线（逻辑树样式）——
        // 多个子节点：父节点右侧引出一条横线 → 一条贯穿所有子节点中心的
        // 竖线（并列总线）→ 每个子节点各引一条横线。
        // 只有一个子节点：一条横线直接连过去，不需要竖线。
        const x1 = parent.x + parent.width;
        const y1 = parent.y + parent.height / 2;
        const x2 = node.x;
        const y2 = node.y + node.height / 2;
        // 总线放在父子间距的正中，留出展开按钮的视觉空间
        const busX = x1 + H_GAP / 2;
        const single = parent.children.length === 1;
        const d = single
            ? `M ${x1} ${y1} L ${x2} ${y2}`
            : `M ${x1} ${y1} H ${busX} V ${y2} H ${x2}`;
        // 先比较再写：relayout 每轮都会跑这里，不变的 path 不碰 DOM
        if (path.getAttribute('d') !== d) path.setAttribute('d', d);
    });
    for (const [uid, path] of c.linkPaths) {
        if (!alive.has(uid)) {
            path.remove();
            c.linkPaths.delete(uid);
        }
    }
    c.updateLinksVisibility();
    // 刚做过一次全量可见性同步：记下版本，avoid 下一帧 viewport 重复
    c.visibilityVersion = c.mountedVersion;
}


/** 连线可见性：端点任一在 DOM 里就显示（跨视口的长线也不会丢）。 */
export function updateLinksVisibility(c: MapCanvas) : void {
    for (const [uid, path] of c.linkPaths) {
        const node = c.byUid.get(uid);
        const parentMounted = node?.parent ? c.mounted.has(node.parent.uid) : false;
        path.style.display = c.mounted.has(uid) || parentMounted ? '' : 'none';
    }
}


/** 内链箭头可见性：与树连线同口径（端点任一挂载即显示）。 */
export function updateInternalLinksVisibility(c: MapCanvas) : void {
    for (const entry of c.ilinkEntries.values()) {
        const show =
            c.mounted.has(entry.group.dataset.from ?? '') ||
            c.mounted.has(entry.group.dataset.to ?? '');
        entry.group.style.display = show ? '' : 'none';
    }
}


/** 选中节点相关的内链箭头提到全不透明（悬停高亮由 CSS :hover 负责）。 */
export function updateInternalLinkEmphasis(c: MapCanvas) : void {
    const sel = c.selectedUid;
    for (const entry of c.ilinkEntries.values()) {
        const active =
            !!sel &&
            (entry.group.dataset.from === sel || entry.group.dataset.to === sel);
        entry.group.classList.toggle('lwm-ilink-active', active);
    }
}


/**
 * 同步内链箭头：只画两端都在可见树里的对（折叠子树里的目标不画；
 * 点击跳转时 revealUid 展开祖先后，下一轮同步自然会把它画出来）。
 *
 * 创建 / 复用 / 回收的模式抄 syncLinks：alive 集合 + 遍历回收。
 * 几何：中心连线与两个节点矩形边框的交点作为起止（不穿节点），
 * 中间一个微弯的二次贝塞尔（弯曲量随距离收敛），目标端一个小实心三角。
 */
export function syncInternalLinks(c: MapCanvas) : void {
    if (!c.root) return;
    const visible = new Set<string>();
    walkVisible(c.root, (node) => visible.add(node.uid));
    // 遮挡矩形：全部可见节点。虚线虽然在 DOM 序上已经压在节点下面，
    // 但节点底色是低透明度混色，虚线会透过节点身体显示出来 ——
    // 看起来像「箭头画在节点上面」。这里按节点矩形把路径剪成若干段，
    // 穿过节点的部分直接不画（端点所属的两个节点除外，端点本来就该贴边）。
    const occluders: Array<{ x: number; y: number; w: number; h: number }> = [];
    walkVisible(c.root, (node) => {
        occluders.push({ x: node.x, y: node.y, w: node.width, h: node.height });
    });
    const alive = new Set<string>();
    for (const pair of c.ilinkPairs) {
        const from = c.byUid.get(pair.fromUid);
        const to = c.byUid.get(pair.toUid);
        if (!from || !to || from === to) continue;
        if (!visible.has(from.uid) || !visible.has(to.uid)) continue;
        const key = `${pair.fromUid}->${pair.toUid}`;
        alive.add(key);
        let entry = c.ilinkEntries.get(key);
        if (!entry) {
            const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            group.classList.add('lwm-ilink');
            group.dataset.from = pair.fromUid;
            group.dataset.to = pair.toUid;
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.classList.add('lwm-ilink-path');
            const head = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
            head.classList.add('lwm-ilink-head');
            // 命中线放最上层：12px 透明粗线 —— 1.5px 的虚线本身点不中
            const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            hit.classList.add('lwm-ilink-hit');
            group.append(path, head, hit);
            c.ilinkLayer.appendChild(group);
            entry = { group, path, head, hit };
            c.ilinkEntries.set(key, entry);
        }
        const geo = computeInternalLinkGeometry(from, to, occluders);
        if (!geo) continue;
        entry.path.setAttribute('d', geo.d);
        // 命中线不裁剪（保持整条可点）：节点区域上的点击本来就会被
        // 上层的节点抢走，轮不到这条线
        entry.hit.setAttribute('d', geo.hitD);
        entry.head.setAttribute('points', geo.points);
    }
    for (const [key, entry] of c.ilinkEntries) {
        if (!alive.has(key)) {
            entry.group.remove();
            c.ilinkEntries.delete(key);
        }
    }
    c.updateInternalLinkEmphasis();
    c.updateInternalLinksVisibility();
}


/** 同步展开按钮（有子节点的可见节点各一个）。 */
export function syncExpandButtons(c: MapCanvas) : void {
    if (!c.root) return;
    const alive = new Set<string>();
    walkVisible(c.root, (node) => {
        if (node.children.length === 0) return;
        alive.add(node.uid);
        let button = c.expandButtons.get(node.uid);
        if (!button) {
            button = document.createElement('div');
            button.className = 'lwm-expand-btn';
            button.dataset.uid = node.uid;
            c.nodeLayer.appendChild(button);
            c.expandButtons.set(node.uid, button);
        }
        button.dataset.uid = node.uid;
        button.dataset.expanded = node.expand ? 'true' : 'false';
        // 收起态显示「后面藏了几项」（全部后代，含更深层）；
        // 展开态仍是减号，两个状态靠 CSS 的 ::before 切换文案
        button.dataset.count =
            node.descendantCount > 99 ? '99+' : String(node.descendantCount);
        button.title = node.expand
            ? '收起'
            : `展开（收起了 ${node.descendantCount} 项）`;
        // 先比较再写（同 syncLinks）：不变的按钮不碰 DOM
        const btnTransform = `translate(${node.x + node.width + 4}px, ${
            node.y + node.height / 2 - 8
        }px)`;
        if (button.style.transform !== btnTransform) button.style.transform = btnTransform;
    });
    for (const [uid, button] of c.expandButtons) {
        if (!alive.has(uid)) {
            button.remove();
            c.expandButtons.delete(uid);
        }
    }
    c.updateExpandButtonsVisibility();
}


export function updateExpandButtonsVisibility(c: MapCanvas) : void {
    if (!c.virtualization) {
        for (const button of c.expandButtons.values()) button.style.display = '';
        return;
    }
    for (const [uid, button] of c.expandButtons) {
        const node = c.byUid.get(uid);
        if (!node) continue;
        const parentMounted = node.parent ? c.mounted.has(node.parent.uid) : true;
        button.style.display =
            c.mounted.has(uid) || parentMounted ? '' : 'none';
    }
}
