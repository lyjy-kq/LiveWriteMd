/**
 * MapCanvas 协作模块（从 canvas.ts 拆出）：挂载与虚拟化：视口双圈挂载卸载、空闲预热。
 *
 * 全部是原 MapCanvas 方法，this 换成第一参数 c；跨模块调用走 c 上的薄包装方法，行为与拆前完全一致。
 *
 * @module webview/mindmap/engine/mounting
 */

import type { MapCanvas } from './canvas.js';
import type { MapNode } from './model.js';


// ==================================================================
// 挂载 / 虚拟化
// ==================================================================

/** 挂载节点到画布。 */
export function mountNode(c: MapCanvas, node: MapNode) : void {
    if (!node.wrapper) return;
    c.mountTotal += 1;
    c.refreshWrapperClasses(node);
    const alreadyMounted =
        c.mounted.has(node.uid) && node.wrapper.parentElement === c.nodeLayer;
    if (node.wrapper.parentElement !== c.nodeLayer) {
        c.nodeLayer.appendChild(node.wrapper);
    }
    c.mounted.add(node.uid);
    // 挂载集合真的变了才升级版本（可见性同步据此去重）
    if (!alreadyMounted) c.mountedVersion += 1;
    // 兜底：挂到画布上的 wrapper 必须真的有内容。
    //
    // setTheme 会清空所有 wrapper，然后只给「当时已挂载」的节点重建；
    // 而主题设置是即时生效的（导图隐藏 / 首屏还没挂载时也会走）。那些
    // 当时没挂载的节点就成了空壳，且 measured 还是 true，setActive 的
    // 「需要重量」判断不会触发重建 —— 切回导图只看到一片空白。
    //
    // 这里按「既没有 display 也没有 placeholder」判断空壳，正好不会
    // 碰正常的占位节点（placeholder=true）和真实实例（display!=null）。
    if (!node.display && !node.placeholder && !node.wrapper.firstElementChild) {
        c.ensureContent(node);
    }
    c.positionNode(node);
    // 占位节点进入视口：排队换真。
    //
    // 这里**不能**再用 `displays.size < DISPLAY_CACHE_CAP` 做门槛：
    // 缓存满 64 个之后，新进入视口的占位节点永远排不上队；而淘汰
    // 只发生在 createDisplay 里 —— 于是死锁，屏幕上留下一批永远是
    // 纯文本占位的节点（看起来「渲染和宽度都不对」，点进编辑再失焦
    // 才被 refreshNode 强制变成真实 CM）。让 pump 去创建，创建时
    // enforceDisplayCap 会自动淘汰离屏实例。
    if (node.placeholder) c.enqueueSwap(node.uid);
    // 之前离屏、没赶上 settle 的新实例：进入视口后补一次
    else if (c.settleUids.has(node.uid)) c.scheduleMeasureSettle();
}


/** 从画布卸下节点（显示实例保留在缓存里）。 */
export function unmountNode(c: MapCanvas, uid: string) : void {
    // 编辑中的节点不能卸；正在拖动的节点也不能卸 ——
    // 拖动时 wrapper 跟着指针走，但布局盒还停在原位，
    // 自动平移可能把「布局盒」移出视口，误把用户手里的节点收走。
    if (uid === c.editingUid || uid === c.drag?.uid) return;
    const node = c.byUid.get(uid);
    if (!node?.wrapper) return;
    c.unmountTotal += 1;
    if (node.wrapper.parentElement === c.nodeLayer) node.wrapper.remove();
    if (c.mounted.delete(uid)) c.mountedVersion += 1;
}


/**
 * 节点左上角的世界坐标写到 transform。
 *
 * 用 2D `translate()` 而不是 `translate3d()`：3D 变换会让每个节点都成为
 * 独立合成层，合成层里的文字用灰度抗锯齿 —— 整张导图的字都会比实时模式
 * 「糊一点」。2D 平移不建层，节点文字的渲染路径才和实时模式一致。
 */
export function positionNode(c: MapCanvas, node: MapNode) : void {
    if (!node.wrapper) return;
    // 先比较再写：整树重排时大多数节点位置没变，不碰 DOM
    const transform = `translate(${node.x}px, ${node.y}px)`;
    if (node.wrapper.style.transform !== transform) {
        node.wrapper.style.transform = transform;
    }
}


/**
 * 按当前视口挂载 / 卸载节点。
 *
 * 平移缩放都只改世界层 transform；这里只维护「哪些节点在 DOM 里」。
 * 用 setTimeout 合并高频调用（无头 Chrome 的 rAF 不可靠，项目老坑）。
 */
export function updateViewport(c: MapCanvas) : void {
    if (!c.active || !c.root) return;
    // 容器尺寸用缓存：updateViewport 在平移时每帧都跑，而上一帧刚
    // 挂载/卸载过节点，此时 getBoundingClientRect 会强制同步布局。
    // 尺寸由 ResizeObserver → resize() 维护，只有还没量过时才回退读取。
    const view = c.viewSize();
    if (view.width <= 0 || view.height <= 0) return;
    const margin = VIEW_MARGIN / c.zoom;
    const left = (-c.panX) / c.zoom - margin;
    const top = (-c.panY) / c.zoom - margin;
    const right = (view.width - c.panX) / c.zoom + margin;
    const bottom = (view.height - c.panY) / c.zoom + margin;
    // 卸载用大圈（常挂载余量的 UNMOUNT_MARGIN_MULT 倍）
    const outerMargin = margin * UNMOUNT_MARGIN_MULT;
    const outerLeft = (-c.panX) / c.zoom - outerMargin;
    const outerTop = (-c.panY) / c.zoom - outerMargin;
    const outerRight = (view.width - c.panX) / c.zoom + outerMargin;
    const outerBottom = (view.height - c.panY) / c.zoom + outerMargin;

    // 先记下这一轮「应该可见」的集合，再统一卸载：
    // 折叠操作会让整棵子树从 walkVisible 里消失，如果只在遍历里卸载，
    // 已经挂载但不再被访问的节点会永远留在 DOM 里（层级 0 实测 27 个）。
    const visible = new Set<string>();
    // 整棵可见树的 uid（不论在不在挂载圈里）：折叠消失的子树不在其中，
    // 卸载判据要靠它，不能靠大圈（折叠节点的坐标还停在原地，会被大圈留住）
    const allVisible = new Set<string>();
    const interacting = c.interactionActive();
    walkVisible(c.root, (node) => {
        allVisible.add(node.uid);
        const inside =
            node.x + node.width >= left &&
            node.x <= right &&
            node.y + node.height >= top &&
            node.y <= bottom;
        const shouldMount = !c.virtualization || inside || node.uid === c.editingUid;
        if (!shouldMount) return;
        visible.add(node.uid);
        if (node.wrapper?.parentElement !== c.nodeLayer) {
            // 手势期间不新挂载（用户要求：拖到没挂的区域先空着，松手后
            // 预热泵分批平滑补齐）。挂载带 CM 子树的节点会触发它的
            // 重测量，一批叠起来就是「起步卡」的那串长任务
            if (interacting) return;
            c.mountNode(node);
        } else if (!c.mounted.has(node.uid)) {
            c.mounted.add(node.uid);
            c.mountedVersion += 1;
        }
    });
    // 折叠 / 删除而离开可见树的节点无条件卸载（大圈判据不适用：
    // 它们的坐标还停在原地，光看出身会被大圈误留）
    for (const uid of Array.from(c.mounted)) {
        if (visible.has(uid)) continue;
        if (!allVisible.has(uid)) {
            c.unmountNode(uid);
            continue;
        }
        // 手势期间不卸载：拖回来时马上就要它，卸载再挂会触发 CM 重测量
        if (interacting) continue;
        // 小圈外、大圈内 = 预热挂载区：留住（见 UNMOUNT_MARGIN_MULT）
        const node = c.byUid.get(uid);
        if (node) {
            const inOuter =
                node.x + node.width >= outerLeft &&
                node.x <= outerRight &&
                node.y + node.height >= outerTop &&
                node.y <= outerBottom;
            if (inOuter) continue;
        }
        c.unmountNode(uid);
    }
    // 没有任何节点进出 DOM：连线/按钮可见性与上一帧相同，整轮跳过
    if (c.mountedVersion !== c.visibilityVersion) {
        c.visibilityVersion = c.mountedVersion;
        c.updateLinksVisibility();
        c.updateInternalLinksVisibility();
        c.updateExpandButtonsVisibility();
    }
    // 视口 / 容器尺寸变化：缩略图范围与视口框都要跟上
    c.scheduleMinimap();
    // 空闲时把大圈预热填满（手势中这一轮会自动跳过）
    c.schedulePrewarm();
}


/** 合并同一轮的高频视口更新。 */
export function scheduleViewport(c: MapCanvas) : void {
    if (c.viewTimer !== null) return;
    c.viewTimer = setTimeout(() => {
        c.viewTimer = null;
        c.updateViewport();
        c.options.onViewChange();
    }, 0);
}


/**
 * 空闲预热挂载：把「大圈」（卸载圈）里还没挂载的节点分批挂进 DOM。
 *
 * 与换真泵的分工：泵管「内容实例」（占位 → 真实 CM），预热管「DOM 挂载」。
 * 手势期间不跑——用户拖到没挂载的区域时画面先空着，松手后这里分批
 * 平滑补齐（schedulePrewarm(30)），起步不再有「一批 CM 子树同时插入
 * DOM → 各自重测量」的长任务簇。换真泵有积压时让路（内容没建好，
 * 挂上也还是占位）。挂上的占位节点会自然进换真队列。
 */
export function schedulePrewarm(c: MapCanvas, delay = PREWARM_DELAY_MS) : void {
    if (c.prewarmTimer !== null) return;
    c.prewarmTimer = setTimeout(() => {
        c.prewarmTimer = null;
        if (!c.active || !c.root || !c.virtualization) return;
        // 手势优先：这轮不跑，结束后由 handlePointerUp 再排
        if (c.interactionActive()) return;
        if (c.queue.length > 0) {
            c.schedulePrewarm();
            return;
        }
        if (c.mounted.size >= PREWARM_CAP) return;
        const view = c.viewSize();
        if (view.width <= 0 || view.height <= 0) return;
        const margin = VIEW_MARGIN / c.zoom;
        const outerMargin = margin * UNMOUNT_MARGIN_MULT;
        const inner = {
            left: -c.panX / c.zoom - margin,
            top: -c.panY / c.zoom - margin,
            right: (view.width - c.panX) / c.zoom + margin,
            bottom: (view.height - c.panY) / c.zoom + margin,
        };
        const outer = {
            left: -c.panX / c.zoom - outerMargin,
            top: -c.panY / c.zoom - outerMargin,
            right: (view.width - c.panX) / c.zoom + outerMargin,
            bottom: (view.height - c.panY) / c.zoom + outerMargin,
        };
        const inBox = (node: MapNode, box: typeof inner): boolean =>
            node.x + node.width >= box.left &&
            node.x <= box.right &&
            node.y + node.height >= box.top &&
            node.y <= box.bottom;
        let mountedRing = 0;
        let more = false;
        walkVisible(c.root, (node) => {
            if (!node.wrapper || node.wrapper.parentElement === c.nodeLayer) return;
            // 小圈必须始终是满的（数量有限，一次补齐）
            if (inBox(node, inner)) {
                c.mountNode(node);
                return;
            }
            if (!inBox(node, outer)) return;
            if (c.mounted.size >= PREWARM_CAP) return;
            if (mountedRing >= PREWARM_BATCH) {
                more = true;
                return;
            }
            c.mountNode(node);
            mountedRing++;
        });
        // 大圈外圈还有存货就接着排下一轮
        if (more) c.schedulePrewarm();
    }, delay);
}
