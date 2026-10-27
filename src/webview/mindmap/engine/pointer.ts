/**
 * MapCanvas 协作模块（从 canvas.ts 拆出）：指针交互：事件装配、平移/节点/框选三分支、拖拽与自动平移、滚轮缩放、双击。
 *
 * 全部是原 MapCanvas 方法，this 换成第一参数 c；跨模块调用走 c 上的薄包装方法，行为与拆前完全一致。
 *
 * @module webview/mindmap/engine/pointer
 */

import type { DropCandidate } from './canvas.js';
import type { MapCanvas } from './canvas.js';
import type { MapNode } from './model.js';


export function bindEvents(c: MapCanvas) : void {
    c.on(c.canvasEl, 'pointerdown', (e: PointerEvent) => c.handlePointerDown(e));
    c.on(c.canvasEl, 'pointermove', (e: PointerEvent) => c.handlePointerMove(e));
    c.on(c.canvasEl, 'pointerup', (e: PointerEvent) => c.handlePointerUp(e));
    c.on(c.canvasEl, 'pointercancel', (e: PointerEvent) => c.handlePointerCancel(e));
    // wheel 必须非被动，才能 preventDefault 阻止页面滚动
    c.canvasEl.addEventListener('wheel', c.handleWheel, { passive: false });
    c.handlers.push([c.canvasEl, 'wheel', c.handleWheel as EventListener]);
    c.on(c.nodeLayer, 'dblclick', (e: MouseEvent) => c.handleDoubleClick(e));
    c.on(c.nodeLayer, 'click', (e: MouseEvent) => c.handleLayerClick(e));
    // 缩略图：按下 / 拖动 = 把该世界坐标移到视口中心
    c.on(c.minimapEl, 'pointerdown', (e: PointerEvent) =>
        c.handleMinimapPointerDown(e)
    );
    c.on(c.minimapEl, 'pointermove', (e: PointerEvent) =>
        c.handleMinimapPointerMove(e)
    );
    c.on(c.minimapEl, 'pointerup', (e: PointerEvent) => c.handleMinimapPointerUp(e));
    c.on(c.minimapEl, 'pointercancel', (e: PointerEvent) =>
        c.handleMinimapPointerUp(e)
    );
    // 拖到窗口外松手：pointerup 可能收不到，用 window 兜底
    c.on(window, 'pointerup', (e: PointerEvent) => {
        if (c.drag || c.pointer) c.handlePointerUp(e, true);
    });
    // 节点里的图片（live 预览 widget）是异步加载的：加载完尺寸会变，
    // 必须补测一次，否则用户得点进编辑再失焦才能看到正确宽度。
    // load 不冒泡，所以用捕获阶段在 document 上听。
    c.on(
        document,
        'load',
        (event: Event) => {
            const target = event.target;
            if (target instanceof HTMLImageElement && c.canvasEl.contains(target)) {
                c.scheduleMeasureSettle(true);
            }
        },
        true
    );
}


// ==================================================================
// 指针交互
// ==================================================================

export function handlePointerDown(c: MapCanvas, event: PointerEvent) : void {
    if (!c.active || event.button === 2) return;
    const target = event.target as Element | null;

    // 内链箭头：整条命中线都是热区。单向 A→B 的箭头是**双向跳转**：
    // 点前半段（靠近源节点）跳到目标 B，点后半段（靠近箭头）跳回源 A ——
    // 两个节点间可以来回切换。
    // 必须最先拦截：箭头压在最底层，落点同时也可能命中节点 / 空白
    if (target?.closest?.('.lwm-ilink')) {
        event.preventDefault();
        event.stopPropagation();
        const group = target.closest('.lwm-ilink') as SVGGElement;
        const fromUid = group.dataset.from ?? '';
        const toUid = group.dataset.to ?? '';
        const hit = group.querySelector<SVGPathElement>('.lwm-ilink-hit');
        if (!hit || !fromUid || !toUid) return;
        // 命中线是世界坐标：点击点换算到世界坐标后，找线上最近采样点
        // 属于前半段还是后半段（48 段采样，点击是低频操作，随便算）
        const world = c.screenToWorld(event.clientX, event.clientY);
        const total = hit.getTotalLength();
        let bestLen = 0;
        let bestDist = Infinity;
        const SAMPLES = 48;
        for (let i = 0; i <= SAMPLES; i++) {
            const l = (total * i) / SAMPLES;
            const p = hit.getPointAtLength(l);
            const d = Math.hypot(p.x - world.x, p.y - world.y);
            if (d < bestDist) {
                bestDist = d;
                bestLen = l;
            }
        }
        const dest = bestLen <= total / 2 ? toUid : fromUid;
        c.options.onInternalLinkNavigate?.(dest);
        return;
    }

    // 展开按钮：交给 click 处理（要读 ctrlKey），不要启动拖动
    if (target?.closest?.('.lwm-expand-btn')) {
        event.stopPropagation();
        return;
    }

    // mermaid 节点右下角的「放大 / 复制 / 尺寸」按钮组：完全交给 widget
    // 自己处理（按钮的 mousedown 由 CM 的 ignoreEvent 放行）。这里不能
    // 建 node 指针，否则 pointerup 会被当成「单击节点」——第一次点按钮
    // 选中节点，第二次就顺手进了编辑态，按钮看着像失灵。
    if (target?.closest?.('.cm-md-preview-actions, .cm-md-resize-actions')) {
        return;
    }

    // Ctrl / Cmd + 点链接：打开链接（外部地址 → openUrl，相对路径 → openFile）。
    //
    // 为什么只能在画布这一层接：
    // 1. 导图节点里的 mini-CM 用的是只读显示扩展包（见 plugin.ts 的
    //    createLivePreviewDisplayExtension），本来就不带 live 的链接点击插件；
    // 2. 就算带上也没用 —— 画布在 pointerdown 里 setPointerCapture 之后，
    //    浏览器会把后续 mousedown 重定向到画布，CM 挂在 contentDOM 上的
    //    处理器收不到。
    //
    // 普通单击在导图里有别的含义（选中节点 / 展开源码），所以链接跟
    // 图片一样统一要求按住 Ctrl，避免误触。
    if ((event.ctrlKey || event.metaKey) && c.openLinkAt(event)) {
        event.preventDefault();
        event.stopPropagation();
        return;
    }

    const wrapper = target?.closest?.('.lwm-node[data-uid]') as HTMLElement | null;
    const inNode = !!wrapper && wrapper.parentElement === c.nodeLayer;
    const uid = inNode ? (wrapper!.dataset.uid ?? '') : '';
    // 编辑中的节点：CM 自己处理选字/光标（含拖动选择）
    if (inNode && uid === c.editingUid) return;

    // Ctrl / Cmd + 按下：进入「框选或切换选中」手势。
    // 不抢占文字选择：落在 CM 正文里且没拖动时，交给上层当 Ctrl 点处理。
    if (event.ctrlKey || event.metaKey) {
        c.pointer = {
            kind: 'marquee',
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
            fromNode: inNode ? { uid, event } : null,
        };
        c.capturePointer(event.pointerId);
        return;
    }

    if (inNode) {
        // 关键：这里**不能** setPointerCapture。
        // 指针一旦被画布捕获，浏览器会把后续 mousedown/mousemove 也重定向到
        // 画布元素，CodeMirror 挂在 contentDOM 上的 mousedown 收不到事件 ——
        // 表现就是节点里的文字（包括加粗 / 斜体 / 代码 / 表格）怎么拖都
        // 选不中。改为真正开始拖节点时再捕获（见 handlePointerMove）。
        //
        // 「已经选中的节点」按下就是拖节点：
        // 第一次单击负责选中，之后从节点任何位置（包括正文/表格单元格）
        // 拖拽都应该移动节点。以前正文里按下会走「拖选文字」，用户看到的是
        // 文字被涂蓝、节点纹丝不动。未选中的节点仍保留拖选文字的手势，
        // 这样显示态里的文字依旧能直接框选；文字编辑态（第二次单击）本来就会
        // 提前 return，选字完全交给 mini-CM。
        const selectedForDrag =
            uid === c.selectedUid && c.multiSelected.size === 0;
        // 复选框 / 链接 / 按钮要保留自己的默认行为（勾选、Ctrl+点击），
        // 不能为了拖节点把它们一起 preventDefault 掉。
        const interactiveTarget = !!target?.closest?.(
            'input, button, a, .cm-md-checkbox'
        );
        if (selectedForDrag && !interactiveTarget) {
            // 阻止浏览器在拖动前先开始拖选文字（pointerdown 的默认行为
            // 会派生出 mousedown → 选区）。单击（没移动）仍然走 pointerup
            // 的 onNodeClick，不受影响。
            event.preventDefault();
        }
        c.pointer = {
            kind: 'node',
            pointerId: event.pointerId,
            uid,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
            // 落在正文里 = 用户可能是想拖选文字；没按 Alt 时不启动节点拖动。
            // 已选中的节点例外：直接拖节点。
            fromContent:
                !selectedForDrag && !!target?.closest?.('.cm-content'),
            event,
        };
        return;
    }

    // 空白处：平移画布
    c.pointer = {
        kind: 'pan',
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        panX: c.panX,
        panY: c.panY,
        moved: false,
    };
    c.canvasEl.classList.add('lwm-panning');
    c.capturePointer(event.pointerId);
}


/**
 * Ctrl / Cmd + 点中节点里的链接时打开它。
 *
 * 链接 DOM 由 live 装饰产出：普通链接 / 文件路径是带 `data-href` 的
 * `.cm-md-link` span，HTML 块里的 `<a>` 也走同一套（见 buildHtmlBlockFragment）。
 *
 * 打开方式与 live 一致：
 * - `http(s)://` → `openUrl`（宿主用 openExternal 交给系统浏览器）；
 * - 其它（相对路径 / 文件路径）→ `openFile`（宿主按当前文档目录解析）；
 * - `#锚点` → 导图里没有可滚动的正文，这一下只吞掉，不当成节点选中。
 *
 * @param event - 画布收到的 pointerdown（阶段不捕获指针）
 * @returns true 表示这一下已经按「打开链接」处理，调用方不要再启动拖动 / 框选
 */
export function openLinkAt(c: MapCanvas, event: PointerEvent) : boolean {
    const target = event.target instanceof Element ? event.target : null;
    const link = target?.closest('.cm-md-link');
    const href = link?.getAttribute('data-href')?.trim();
    if (!href) return false;

    // 内链（#标题）：解析到目标标题节点并跳转（断链就只吞掉手势，
    // 不要掉进「Ctrl 点节点 = 切换多选」的分支）
    if (href.startsWith('#')) {
        const uid = c.options.resolveInternalLink?.(href.slice(1)) ?? null;
        if (uid) c.options.onInternalLinkNavigate?.(uid);
        return true;
    }

    // webview 宿主注入的 API；探针 / 单独浏览器里没有时，只吞掉手势
    const vscodeApi = (
        window as unknown as {
            __vscodeApi?: { postMessage(message: unknown): void };
        }
    ).__vscodeApi;
    if (!vscodeApi) return true;

    if (href.startsWith('http://') || href.startsWith('https://')) {
        vscodeApi.postMessage({ type: 'openUrl', url: href });
    } else {
        // 与 live 的链接逻辑保持一致：去掉 #fragment / ?query 再交给宿主
        const path = href.split('#')[0].split('?')[0].trim();
        if (path) vscodeApi.postMessage({ type: 'openFile', path });
    }
    return true;
}


/** setPointerCapture 在合成事件/已释放指针上会抛异常，统一兜住。 */
export function capturePointer(c: MapCanvas, pointerId: number) : void {
    try {
        c.canvasEl.setPointerCapture?.(pointerId);
    } catch {
        /* 合成事件或指针已失效：忽略 */
    }
}


export function handlePointerMove(c: MapCanvas, event: PointerEvent) : void {
    const pointer = c.pointer;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    const dx = event.clientX - pointer.startX;
    const dy = event.clientY - pointer.startY;

    if (pointer.kind === 'pan') {
        if (!pointer.moved && Math.abs(dx) + Math.abs(dy) > 3) pointer.moved = true;
        if (!pointer.moved) return;
        c.panX = pointer.panX + dx;
        c.panY = pointer.panY + dy;
        c.applyTransform();
        c.scheduleViewport();
        return;
    }

    // Ctrl 框选：超过阈值才开始画框；没拖动就是一次 Ctrl 点（切换选中）
    if (pointer.kind === 'marquee') {
        if (!pointer.moved) {
            if (Math.abs(dx) + Math.abs(dy) <= 3) return;
            pointer.moved = true;
        }
        c.updateMarquee(pointer.startX, pointer.startY, event.clientX, event.clientY);
        return;
    }

    // node：超过阈值才进入拖动
    if (!c.drag) {
        if (Math.abs(dx) + Math.abs(dy) <= DRAG_THRESHOLD) return;
        pointer.moved = true;
        // 从 CM 正文里按下：让浏览器/CodeMirror 完成文字拖选。
        // Alt+拖动是「我就是要挪这个节点」的显式覆盖。
        if (pointer.fromContent && !event.altKey) return;
        const node = c.byUid.get(pointer.uid);
        if (!node) {
            c.pointer = null;
            return;
        }
        // 确认是拖节点而不是选文字，这时才捕获指针（见 handlePointerDown）
        c.capturePointer(event.pointerId);
        c.drag = {
            uid: pointer.uid,
            node,
            startClientX: pointer.startX,
            startClientY: pointer.startY,
            originX: node.x,
            originY: node.y,
            candidate: null,
            pointerId: event.pointerId,
        };
        c.refreshWrapperClasses(node);
        node.wrapper?.classList.add('lwm-node-dragging');
    }
    c.updateDrag(event);
}


/**
 * 更新 Ctrl 框选矩形并回调命中节点。
 *
 * 用屏幕坐标和 getBoundingClientRect 相交判断：节点少（可见节点通常
 * 几十个）、且框选本身是低频手势，没必要再维护一套世界坐标换算。
 */
export function updateMarquee(c: MapCanvas, startX: number, startY: number, endX: number, endY: number) : void {
    const rect = c.canvasEl.getBoundingClientRect();
    const left = Math.min(startX, endX) - rect.left;
    const top = Math.min(startY, endY) - rect.top;
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);
    const style = c.marqueeEl.style;
    style.display = 'block';
    style.left = `${left}px`;
    style.top = `${top}px`;
    style.width = `${width}px`;
    style.height = `${height}px`;

    // 与画布可见节点的屏幕矩形求交
    const box = {
        left: rect.left + left,
        top: rect.top + top,
        right: rect.left + left + width,
        bottom: rect.top + top + height,
    };
    const hits: string[] = [];
    for (const uid of c.mounted) {
        const wrapper = c.byUid.get(uid)?.wrapper;
        if (!wrapper) continue;
        const r = wrapper.getBoundingClientRect();
        if (
            r.right >= box.left &&
            r.left <= box.right &&
            r.bottom >= box.top &&
            r.top <= box.bottom
        ) {
            hits.push(uid);
        }
    }
    c.options.onMarqueeSelect?.(hits);
}


/** 拖动中：移动节点、算落点、边缘自动平移。 */
export function updateDrag(c: MapCanvas, event: PointerEvent) : void {
    const drag = c.drag;
    if (!drag) return;
    const dx = (event.clientX - drag.startClientX) / c.zoom;
    const dy = (event.clientY - drag.startClientY) / c.zoom;
    const wrapper = drag.node.wrapper;
    if (wrapper) {
        // 拖动中的节点自己有 will-change（独立合成层），小数平移会让
        // Chromium 拿位图做双线性重采样、节点文字发糊；对齐设备像素后
        // 拖动全程都是清晰的。只取整写进 CSS 的值，模型坐标不受影响。
        const dpr = window.devicePixelRatio || 1;
        const tx = Math.round((drag.originX + dx) * dpr) / dpr;
        const ty = Math.round((drag.originY + dy) * dpr) / dpr;
        // 仍写 2D，松手后 positionNode 会写回同一形式，不会闪一下。
        wrapper.style.transform = `translate(${tx}px, ${ty}px)`;
    }

    // 边缘自动平移：每帧移动一小步，指针不动也能继续滚
    const rect = c.container.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    c.autoPanDx = localX < AUTO_PAN_EDGE ? AUTO_PAN_STEP : localX > rect.width - AUTO_PAN_EDGE ? -AUTO_PAN_STEP : 0;
    c.autoPanDy = localY < AUTO_PAN_EDGE ? AUTO_PAN_STEP : localY > rect.height - AUTO_PAN_EDGE ? -AUTO_PAN_STEP : 0;
    if (c.autoPanDx !== 0 || c.autoPanDy !== 0) c.startAutoPan();
    else c.stopAutoPan();

    c.updateDropCandidate(event.clientX, event.clientY);
}


export function startAutoPan(c: MapCanvas) : void {
    if (c.autoPanTimer !== null) return;
    c.autoPanTimer = setTimeout(() => {
        c.autoPanTimer = null;
        if (!c.drag) return;
        if (c.autoPanDx === 0 && c.autoPanDy === 0) return;
        c.panX += c.autoPanDx;
        c.panY += c.autoPanDy;
        c.applyTransform();
        c.updateViewport();
        c.startAutoPan();
    }, 16);
}


export function stopAutoPan(c: MapCanvas) : void {
    if (c.autoPanTimer !== null) {
        clearTimeout(c.autoPanTimer);
        c.autoPanTimer = null;
    }
}


/** 计算指针下方的落点候选并更新高亮。 */
export function updateDropCandidate(c: MapCanvas, clientX: number, clientY: number) : void {
    const drag = c.drag;
    if (!drag) return;
    const point = c.screenToWorld(clientX, clientY);
    const excluded = collectSubtreeUids(drag.node);
    let hovered: MapNode | null = null;
    let nearest: MapNode | null = null;
    let nearestDist = Infinity;

    if (!c.root) return;
    walkVisible(c.root, (node) => {
        if (excluded.has(node.uid)) return;
        // 1) 命中（取最深的一个）
        if (
            point.x >= node.x &&
            point.x <= node.x + node.width &&
            point.y >= node.y &&
            point.y <= node.y + node.height
        ) {
            if (!hovered || node.depth > hovered.depth) hovered = node;
        }
        // 2) 最近（兄弟间隙落点）
        const cx = Math.max(node.x, Math.min(point.x, node.x + node.width));
        const cy = Math.max(node.y, Math.min(point.y, node.y + node.height));
        const dist = Math.hypot(point.x - cx, point.y - cy);
        if (dist < nearestDist) {
            nearestDist = dist;
            nearest = node;
        }
    });

    let candidate: DropCandidate | null = null;
    if (hovered) {
        const target = hovered as MapNode;
        if (c.canDrop(drag.uid, target.uid)) {
            candidate = {
                parentUid: target.uid,
                prevUid: null,
                nextUid: null,
                targetUid: target.uid,
                line: null,
            };
        }
    }
    // 悬停节点不合法（例如落进段落/媒体节点）或点在空白：用最近节点的兄弟间隙
    if (!candidate && nearest && nearestDist <= 220) {
        const near = nearest as MapNode;
        const parent = near.parent;
        if (parent) {
            const siblings = parent.children.filter((child) => child.expand || child === near);
            const index = siblings.indexOf(near);
            const before = point.y < near.y + near.height / 2;
            const prev = before ? siblings[index - 1] ?? null : near;
            const next = before ? near : siblings[index + 1] ?? null;
            if (c.canDrop(drag.uid, parent.uid)) {
                candidate = {
                    parentUid: parent.uid,
                    prevUid: prev?.uid ?? null,
                    nextUid: next?.uid ?? null,
                    targetUid: null,
                    line: {
                        x: near.x - 8,
                        y: before ? near.y - V_GAP / 2 : near.y + near.height + V_GAP / 2,
                        width: near.width + 16,
                    },
                };
            }
        }
    }

    const previous = c.dropCandidate;
    c.dropCandidate = candidate;
    drag.candidate = candidate;
    if (previous?.targetUid) c.refreshWrapperClasses(c.byUid.get(previous.targetUid));
    if (candidate?.targetUid) c.refreshWrapperClasses(c.byUid.get(candidate.targetUid));
    if (candidate?.line) {
        c.dropLine.style.display = '';
        c.dropLine.style.transform = `translate(${candidate.line.x}px, ${candidate.line.y}px)`;
        c.dropLine.style.width = `${candidate.line.width}px`;
    } else {
        c.dropLine.style.display = 'none';
    }
}


/** 类型规则交给上层（上层看得到 markdown 语义）。 */
export function canDrop(c: MapCanvas, dragUid: string, parentUid: string) : boolean {
    return c.options.canDrop ? c.options.canDrop(dragUid, parentUid) : true;
}


export function handlePointerUp(c: MapCanvas, event: PointerEvent, fromWindow = false) : void {
    const pointer = c.pointer;
    const drag = c.drag;
    if (!pointer && !drag) return;
    if (pointer && pointer.pointerId !== event.pointerId && !fromWindow) return;

    if (drag) c.finishDrag();
    else if (pointer?.kind === 'pan') {
        c.canvasEl.classList.remove('lwm-panning');
        // 松手立刻退回非合成层：文字恢复次像素抗锯齿（见 scheduleWorldLayer）
        c.scheduleWorldLayer();
        c.pointer = null;
        if (!pointer.moved) c.options.onCanvasClick();
    } else if (pointer?.kind === 'marquee') {
        c.pointer = null;
        c.marqueeEl.style.display = 'none';
        if (!pointer.moved) {
            if (pointer.fromNode) {
                // Ctrl 点节点 = 切换该节点的多选状态（上层按 ctrlKey 判断）
                const node = c.byUid.get(pointer.fromNode.uid);
                if (node) {
                    c.options.onNodeClick(
                        node,
                        pointer.fromNode.event as unknown as MouseEvent
                    );
                }
            } else {
                // Ctrl 点空白 = 清空多选
                c.options.onCanvasClick();
            }
        }
    } else if (pointer?.kind === 'node') {
        c.pointer = null;
        // 拖选文字时 moved 也会置位：此时绝不能上报「单击节点」，
        // 否则上层会立刻进入编辑态并把刚选好的选区塌成光标。
        if (!pointer.moved) {
            const node = c.byUid.get(pointer.uid);
            if (node) c.options.onNodeClick(node, event as unknown as MouseEvent);
        }
    }
    try {
        c.canvasEl.releasePointerCapture?.(event.pointerId);
    } catch {
        /* 指针已释放：忽略 */
    }
    // 手势结束：视口立即补齐 + 外圈分批预热 + 换真泵继续
    // （手势期间被推迟的挂载都在这一轮平滑补上）
    c.updateViewport();
    c.schedulePrewarm(30);
    c.resumePump();
}


export function handlePointerCancel(c: MapCanvas, event: PointerEvent) : void {
    // 拖动被系统取消（触控板手势/窗口失焦）：原地落回，不写文档
    if (c.drag) {
        const drag = c.drag;
        c.drag = null;
        c.dropCandidate = null;
        c.stopAutoPan();
        c.dropLine.style.display = 'none';
        c.refreshWrapperClasses(drag.node);
        c.positionNode(drag.node);
    }
    c.pointer = null;
    c.marqueeEl.style.display = 'none';
    c.canvasEl.classList.remove('lwm-panning');
    c.scheduleWorldLayer();
    try {
        c.canvasEl.releasePointerCapture?.(event.pointerId);
    } catch {
        /* 忽略 */
    }
    // 与正常松手一致：补挂载 + 预热 + 恢复换真
    c.updateViewport();
    c.schedulePrewarm(30);
    c.resumePump();
}


/** 拖动结束：合法落点交给上层写文档，然后清掉所有拖动态。 */
export function finishDrag(c: MapCanvas) : void {
    const drag = c.drag;
    if (!drag) return;
    const candidate = drag.candidate;
    c.drag = null;
    c.dropCandidate = null;
    c.pointer = null;
    c.stopAutoPan();
    c.dropLine.style.display = 'none';
    c.refreshWrapperClasses(drag.node);
    // 先回到布局位置：若上层 setData 复用同一 wrapper，起点就是正确的
    c.positionNode(drag.node);
    if (candidate) {
        c.options.onDrop({
            dragUid: drag.uid,
            parentUid: candidate.parentUid,
            prevUid: candidate.prevUid,
            nextUid: candidate.nextUid,
        });
    }
    c.updateViewport();
    c.options.onViewChange();
}


export function handleWheel(c: MapCanvas, event: WheelEvent): void {
    if (!c.active) return;
    event.preventDefault();
    // 记下滚轮活动：换真泵在滚动结束后 120ms 内不建 CM
    c.lastWheelTime = performance.now();
    const rect = c.container.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    if (event.shiftKey) {
        // Shift + 滚轮 = 横向平移（触控板用户）
        c.panX -= event.deltaY;
        c.applyTransform();
        c.scheduleViewport();
        return;
    }
    c.zoomAt(localX, localY, c.zoom * Math.exp(-event.deltaY * 0.0015));
};


export function handleDoubleClick(c: MapCanvas, event: MouseEvent) : void {
    if (!c.active) return;
    const target = event.target as Element | null;
    if (target?.closest?.('.lwm-expand-btn')) return;
    const wrapper = target?.closest?.('.lwm-node[data-uid]') as HTMLElement | null;
    if (!wrapper) return;
    const uid = wrapper.dataset.uid ?? '';
    // 正在编辑的节点：双击属于 mini-CM 的「选词」手势，绝不能上报
    // 「双击节点」——上层收到后会 focusAt(x,y)，把浏览器刚选好的词
    // 塌成一个光标（表现为加粗 / 行内代码里的文字怎么双击都选不上）。
    if (uid && uid === c.editingUid) return;
    const node = c.byUid.get(uid);
    if (node) c.options.onNodeDoubleClick(node, event);
}


/** 展开按钮点击（事件委托）。 */
export function handleLayerClick(c: MapCanvas, event: MouseEvent) : void {
    const target = event.target as Element | null;
    const button = target?.closest?.('.lwm-expand-btn') as HTMLElement | null;
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const uid = button.dataset.uid ?? '';
    const node = c.byUid.get(uid);
    if (!node) return;
    const recursive = event.ctrlKey || event.metaKey;
    if (recursive) {
        // Ctrl 点：整棵子树展开（已展开则保持展开，不反向折叠）
        expandSubtree(node);
        node.expand = true;
    } else {
        node.expand = !node.expand;
    }
    c.options.onExpandChange(uid, node.expand, recursive);
    c.relayout();
    c.updateViewport();
    c.options.onViewChange();
}
