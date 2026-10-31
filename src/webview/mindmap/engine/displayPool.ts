/**
 * MapCanvas 协作模块（从 canvas.ts 拆出）：显示实例生命周期：wrapper/mini-CM 创建、测量、编辑态尺寸与换真泵（性能打磨核心区，整体搬迁）。
 *
 * 全部是原 MapCanvas 方法，this 换成第一参数 c；跨模块调用走 c 上的薄包装方法，行为与拆前完全一致。
 *
 * @module webview/mindmap/engine/displayPool
 */

import { HEADING_TINT_FALLBACKS, PROGRESSIVE_BATCH, PUMP_PAUSE_MS, TEXT_KINDS, WHEEL_ACTIVE_MS } from './canvasConstants.js';
import { relayout } from './links.js';
import { mountNode } from './mounting.js';
import type { MapCanvas } from './canvas.js';
import { createNodeDisplay } from '../miniCm.js';
import type { NodeDisplay } from '../miniCm.js';
import { walkAll, walkVisible } from './model.js';
import type { MapNode } from './model.js';
import { EditorSelection } from '@codemirror/state';


// ==================================================================
// 节点 DOM / 测量
// ==================================================================

/** 确保节点有包裹元素，并刷新外观。 */
export function ensureWrapper(c: MapCanvas, node: MapNode) : HTMLElement {
    if (!node.wrapper) {
        node.wrapper = document.createElement('div');
    }
    c.refreshWrapperClasses(node);
    return node.wrapper;
}


/** 统一写类名 / data-*（uid 变化、状态变化都走这里）。 */
export function refreshWrapperClasses(c: MapCanvas, node: MapNode | undefined | null) : void {
    if (!node?.wrapper) return;
    const classes = ['lwm-node', `lwm-node-${node.kind}`];
    if (c.expandedFlags.has(node.uid)) classes.push('lwm-node-expanded');
    if (c.editingUid === node.uid) classes.push('lwm-node-editing');
    if (c.selectedUid === node.uid || c.multiSelected.has(node.uid)) {
        classes.push('lwm-node-selected');
    }
    if (c.searchHits.has(node.uid)) classes.push('lwm-search-hit');
    if (c.searchCurrent === node.uid) classes.push('lwm-search-current');
    // 内链跳转后的 1 秒高亮
    if (c.flashUid === node.uid) classes.push('lwm-node-flash');
    if (c.drag?.uid === node.uid) classes.push('lwm-node-dragging');
    if (c.dropCandidate?.targetUid === node.uid) classes.push('lwm-node-drop-target');
    // 属性值没变就不写：每次 setData / relayout 都会把整棵树刷一遍，
    // 几百个节点重复写 className / dataset / 自定义属性会让样式系统
    // 白做无效化与重算。先比较再写，代价是一次字符串比较。
    const className = classes.join(' ');
    if (node.wrapper.className !== className) node.wrapper.className = className;
    const dataset = node.wrapper.dataset;
    if (dataset.uid !== node.uid) dataset.uid = node.uid;
    if (dataset.kind !== node.kind) dataset.kind = node.kind;
    const depth = String(node.depth);
    if (dataset.depth !== depth) dataset.depth = depth;

    // 节点底色轮换：用实时模式的标题色板 h1~h6（CSS 里再混一点透明）。
    // uid 是路径式的（"0/2/1"），最后一段就是同级序号 —— 同级节点依次
    // 换到下一个颜色；再叠一个 depth 偏移，避免直接相连的父子撞成同色。
    // 色板本身和层级无关：根、一级、二级……用的都是这一套颜色。
    const lastSlash = node.uid.lastIndexOf('/');
    const siblingIndex = Number(node.uid.slice(lastSlash + 1)) || 0;
    const tintIndex = (siblingIndex + node.depth) % HEADING_TINT_FALLBACKS.length;
    const tint = `var(--livewritemd-h${tintIndex + 1}-color, ${HEADING_TINT_FALLBACKS[tintIndex]})`;
    // getPropertyValue 只读样式表计算出的声明值，不触发排版
    if (node.wrapper.style.getPropertyValue('--lwm-node-tint') !== tint) {
        node.wrapper.style.setProperty('--lwm-node-tint', tint);
    }
    if (node.kind === 'heading') {
        const level = Number(node.data._headingLevel ?? 0);
        if (level >= 1 && level <= 6) {
            const levelText = String(level);
            if (dataset.level !== levelText) dataset.level = levelText;
        } else if (dataset.level !== undefined) {
            delete dataset.level;
        }
    } else if (dataset.level !== undefined) {
        delete dataset.level;
    }
    // 不再把 note（段落全文 / 媒体源码）塞进 title：
    // 悬停节点时浏览器会弹原生提示框，遮住相邻节点，而且截断文本本来就
    // 能通过编辑态查看全文。这里只负责清掉历史遗留的 title 属性。
    if (node.wrapper.hasAttribute('title')) {
        node.wrapper.removeAttribute('title');
    }
}


/**
 * 确保节点有内容：优先复用同文档的显示实例，否则按渐进策略
 * 创建真实 mini-CM 或静态占位。
 */
export function ensureContent(c: MapCanvas, node: MapNode) : void {
    const wrapper = node.wrapper;
    if (!wrapper) return;
    const { doc, sentinel } = c.options.computeDoc(node);

    const entry = c.displays.get(node.uid);
    if (entry) {
        if (
            entry.display.sourceDoc === doc &&
            entry.display.sentinel === sentinel
        ) {
            entry.node = node;
            entry.nodeRef.current = node;
            entry.wrapper = wrapper;
            // 包裹元素可能被重建过：CM 不在里面才搬，避免无谓 DOM 变更
            if (entry.display.container.parentElement !== wrapper) {
                wrapper.replaceChildren(entry.display.container);
            }
            node.display = entry.display;
            node.placeholder = false;
            return;
        }
        // 文档变了：旧实例作废，重建（尺寸也要重量）
        entry.display.destroy();
        c.displays.delete(node.uid);
        node.display = null;
    }

    // 占位内容没变就原地复用，别重建 DOM、也别重量。
    //
    // setData 每次都会走完整棵树；占位节点没有 display entry，以前一律
    // 在这里 replaceChildren + measured=false。渐进换真队列里的占位动辄
    // 几百个，改一个字提交一次就是几百次 DOM 重建和上千次强制布局
    // （实测 640 节点文档：单节点改名提交 1195 次布局、56ms）。
    //
    // 判定条件必须严：DOM 里那一个子元素就是占位、文本与本次要写的完全
    // 一致、并且尺寸已经量过。三条都满足时，占位内容与排版都和上次一样，
    // 直接沿用即可。文本变了 / 是真实 CM 容器 / 没量过，都走下面的重建。
    if (!entry && node.measured && node.wrapper) {
        const child = node.wrapper.firstElementChild;
        if (
            child instanceof HTMLElement &&
            child.classList.contains('lwm-node-placeholder') &&
            child.textContent === doc
        ) {
            node.display = null;
            node.placeholder = true;
            return;
        }
    }

    // 走到这里说明内容要重新生成（新建 CM 或占位文本）。
    // 必须清掉 measured：复用来的节点可能带着「上一份内容」的尺寸，
    // 尤其占位节点（缓存里没有 display entry）以前完全不会重测，
    // 拖动/改名后就会一直用旧宽度，直到点进编辑再失焦才被刷新。
    node.measured = false;

    if (c.progressiveCount < c.eagerDisplayBudget) {
        c.progressiveCount += 1;
        c.createDisplay(node);
        return;
    }
    c.setPlaceholder(node, doc);
    c.enqueueSwap(node.uid);
}


/**
 * 创建真实显示实例（节点尺寸随后由 measureNode 更新）。
 */
export function createDisplay(c: MapCanvas, node: MapNode) : void {
    const wrapper = node.wrapper;
    if (!wrapper) return;
    // 兜底：调用方本该先销毁旧实例（换主题 / 内容变更）。若没销毁就
    // 直接建新的，旧 EditorView 会变成没有引用的孤儿（监听器、
    // ResizeObserver 都还在），大文档反复拖动会越来越卡。
    if (node.display) {
        node.display.destroy();
        c.displays.delete(node.uid);
        node.display = null;
    }
    const { doc, sentinel } = c.options.computeDoc(node);
    // 节点引用走间接盒子：实例迁移（setData 认领）时只换 current，
    // 避免闭包把旧模型节点（乃至整棵旧树）挂住不放。
    const nodeRef = { current: node };
    const display = createNodeDisplay({
        doc,
        sentinel,
        theme: c.options.getTheme(),
        codeLanguages: c.options.codeLanguages,
        // 显示态按钮（mermaid 宽度、表格加行/列）改了本地文档后，
        // 立刻交给上层回写源文档
        onDisplayChange: (text) => c.options.onDisplayEdit?.(nodeRef.current, text),
    });
    c.createdTotal += 1;
    wrapper.replaceChildren(display.container);
    node.display = display;
    node.placeholder = false;
    // 新建的 CM 要等浏览器/CM 自己完成首帧布局，尺寸才可信
    c.settleUids.add(node.uid);
    c.displays.set(node.uid, {
        display,
        wrapper,
        node,
        nodeRef,
        kind: node.kind,
    });
    // 新内容尺寸可能与占位不同：调用方负责重新测量
}


/** 降级为静态占位（同字体源码文本，尺寸与真实渲染接近）。 */
export function setPlaceholder(c: MapCanvas, node: MapNode, doc?: string) : void {
    const wrapper = node.wrapper;
    if (!wrapper) return;
    const text = doc ?? c.options.computeDoc(node).doc;
    const el = document.createElement('div');
    el.className = 'lwm-node-display lwm-node-placeholder';
    el.textContent = text;
    wrapper.replaceChildren(el);
    node.display = null;
    node.placeholder = true;
    // 占位文本换了，尺寸就可能变：交给调用方重新测量
    node.measured = false;
}


/**
 * 测量节点内容尺寸并写死宽高。
 *
 * 挂到离屏测量层量（同一次任务内挂回），避免 max-content 影响画布上的
 * 最终排版；容器隐藏时量出来是 0，退回一个保守估计，等 setActive 再量。
 */
export function measureNode(c: MapCanvas, node: MapNode) : void {
    c.measureNodes([node]);
}


/**
 * 批量测量节点尺寸（一次强制布局量完）。
 *
 * 单个 measureNode 每调用一次都是一轮「改样式 → 读 rect」的强制同步
 * 重排；一次拖动回写要重量几十个节点时就是几十轮，drop 的手感全耗在
 * 这里。批量做法：先把所有 wrapper 挂进离屏测量层（只写 DOM），
 * 再统一读 rect（一次布局），最后统一写回尺寸/挂回画布。
 */
export function measureNodes(c: MapCanvas, nodes: MapNode[]) : void {
    interface Pending {
        node: MapNode;
        wrapper: HTMLElement;
        mounted: boolean;
    }
    const pending: Pending[] = [];
    for (const node of nodes) {
        const wrapper = node.wrapper;
        if (!wrapper) continue;
        pending.push({
            node,
            wrapper,
            mounted: wrapper.parentElement === c.nodeLayer,
        });
        // 量之前清掉写死的尺寸，让 max-width / line-clamp 自然生效
        wrapper.style.width = 'max-content';
        wrapper.style.height = 'auto';
        c.measureLayer.appendChild(wrapper);
    }
    if (pending.length === 0) return;

    // 文本节点量两遍，取宽高各自的最大值：
    //   ① 文本态（整块源码）：所有块级/行内标记露出，live 的宽度补偿
    //      （openScale/openWrap）照常生效。点在某个元素上时单元格必须
    //      容得下这一版排版，否则「渲染一行、点开变两行」。
    //   ② 显示态（原选区）：不点开任何元素时的真实外观。文本态的宽度补偿
    //      可能让折行结构与显示态不同（整体少占一行也是可能的），只量
    //      文本态会把高度量小，CSS line-clamp 就把最后一行裁掉 ——
    //      用户看到的「第二行像消失了」。取 max 两个状态都放得下。
    //
    // 显示态的 live 预览会把块级标记（`#`、`-`）与行内标记（`**`、`` ` ``）
    // 压掉（选区停在哨兵行）；一进编辑，光标落进那一行标记就重新出现。
    // 只测文本节点：root 不可编辑、meta 无正文；代码/表格/公式/mermaid
    // 是 widget 渲染，源码态宽度没有意义。
    const restoreSelections: Array<{
        view: NodeDisplay['view'];
        display: NodeDisplay;
        selection: EditorSelection;
    }> = [];
    for (const item of pending) {
        const display = item.node.display;
        // 编辑中的节点绝对不能动选区（会打断输入 / 输入法组合态）；
        // 已销毁的实例更不能派发 —— 旧 position 落到已换掉的文档上会
        // 把 CM 的 state 搞坏（后续 update 里 lineAt 越界）。
        if (
            !display ||
            display.destroyed ||
            display.editing ||
            !TEXT_KINDS.has(item.node.kind)
        ) {
            continue;
        }
        try {
            const docLength = display.view.state.doc.length;
            if (docLength === 0) continue;
            const selection = display.view.state.selection;
            display.view.dispatch({
                selection: EditorSelection.single(0, docLength),
            });
            restoreSelections.push({ view: display.view, display, selection });
        } catch {
            /* 视图在测量过程中被销毁：忽略 */
        }
    }

    // 第一遍：文本态。先全部挂好再统一读取（一次布局，后面读缓存）
    const sourceRects = pending.map((item) => item.wrapper.getBoundingClientRect());

    // 选区复位：显示态重新隐藏标记；尺寸取两遍的最大值
    for (const item of restoreSelections) {
        if (item.display.destroyed) continue;
        try {
            item.view.dispatch({ selection: item.selection });
        } catch {
            /* 视图已销毁：忽略 */
        }
    }

    // 第二遍：显示态
    const renderRects = pending.map((item) => item.wrapper.getBoundingClientRect());

    pending.forEach((item, index) => {
        let width = Math.ceil(Math.max(sourceRects[index].width, renderRects[index].width));
        let height = Math.ceil(Math.max(sourceRects[index].height, renderRects[index].height));
        // 量到 0 = 容器 display:none（或测量层被浏览器折叠）。
        // 这时给一个估值，但**不标记为已测量** —— setActive(true)
        // 会检查 measured 并重新量；标 true 的话隐藏时打开的导图
        // 会永远用估值。
        const estimated = width <= 0 || height <= 0;
        if (estimated) {
            width = Math.min(320, Math.max(48, item.node.text.length * 9 + 16));
            height = 28;
        }
        item.node.width = Math.max(24, width);
        item.node.height = Math.max(18, height);
        item.node.measured = !estimated;
        item.wrapper.style.width = `${item.node.width}px`;
        item.wrapper.style.height = `${item.node.height}px`;
        if (item.mounted) {
            c.nodeLayer.appendChild(item.wrapper);
            c.positionNode(item.node);
        } else {
            item.wrapper.remove();
        }
    });
}


/**
 * 安排一次「首帧之后」的补偿性重测。
 *
 * 为什么要补：
 * - mini-CM 的排版要等浏览器完成一帧（CodeMirror 自己的 measure
 *   在 rAF 里）才稳定，创建当下立刻量可能拿到的是初始估算；
 * - 图片 widget 是异步加载的，mermaid/表格也会在首帧后重排；
 * - 字体（document.fonts）可能还没就绪，量到的是回退字体宽度。
 *
 * 这些情况下节点宽高会停在旧值，用户必须点进编辑再失焦触发
 * refreshNode 才恢复。这里在下一帧和 300ms 后各补一次轻量重测，
 * 只量已经挂载的节点，尺寸确实变了才重排。
 */
export function scheduleMeasureSettle(c: MapCanvas, forceAll = false) : void {
    if (forceAll) c.settleForceAll = true;
    if (c.settleRaf === null) {
        // 双 rAF：第一个回调时样式已应用，第二个回调时 CM 的 measure
        //（它自己也排了 rAF）大概率已经跑完
        c.settleRaf = requestAnimationFrame(() => {
            c.settleRaf = requestAnimationFrame(() => {
                c.settleRaf = null;
                c.settleMounted();
            });
        });
    }
    if (c.settleTimer === null) {
        c.settleTimer = setTimeout(() => {
            c.settleTimer = null;
            c.settleMounted();
        }, 300);
    }
}


/**
 * 重测「需要补偿」的节点；尺寸有变化就重排。
 *
 * 默认只量 settleUids（新建过真实显示实例的节点）——拖动回写后
 * 绝大多数节点尺寸是可信的，没必要整棵树再量一遍（那是 drop 卡顿的
 * 大头）。字体就绪 / 图片加载这类全局事件会置 settleForceAll，
 * 下一次做全量。
 */
export function settleMounted(c: MapCanvas) : void {
    if (!c.root || !c.active) return;
    const forceAll = c.settleForceAll;
    c.settleForceAll = false;

    // 小图连离屏节点一起量（第一次测量可能早于 CM 首帧布局）；
    // 大图只看挂载集合，避免一次 settle 把整棵树拿去做强制布局。
    let visibleCount = 0;
    walkVisible(c.root, () => {
        visibleCount += 1;
    });
    const measureOffscreen = visibleCount <= 400;

    const targets: MapNode[] = [];
    const previous = new Map<MapNode, { width: number; height: number }>();
    const consider = (node: MapNode): void => {
        // 编辑中的节点不能动（重测会把 DOM 挪进离屏层，打断输入）
        if (node.uid === c.editingUid || c.drag?.uid === node.uid) return;
        if (!measureOffscreen && node.wrapper?.parentElement !== c.nodeLayer) return;
        if (!node.wrapper) return;
        targets.push(node);
        previous.set(node, { width: node.width, height: node.height });
    };
    if (forceAll) {
        // 字体/图片影响所有节点，且可能改变任意节点：量全部可见节点
        walkVisible(c.root, consider);
    } else {
        for (const uid of [...c.settleUids]) {
            const node = c.byUid.get(uid);
            // 已删除节点的 uid 不会自己从集合里消失：以前只跳过不删除，
            // 长时间反复增删之后这个集合只涨不落，每次 settle 都要白跑
            // 一遍。顺手清掉（uid 是路径式的，别的节点可能重新用上它，
            // 但那会重新 add，不影响正确性）。
            if (!node) {
                c.settleUids.delete(uid);
                continue;
            }
            consider(node);
        }
    }
    if (targets.length === 0) return;

    // 批量测量：一次强制布局，而不是每个节点一轮
    c.measureNodes(targets);
    let changed = false;
    for (const node of targets) {
        const before = previous.get(node);
        if (!before) continue;
        c.settleUids.delete(node.uid);
        if (
            Math.abs(node.width - before.width) > 0.5 ||
            Math.abs(node.height - before.height) > 0.5
        ) {
            changed = true;
        }
    }
    if (changed) {
        c.relayout();
        c.updateViewport();
        c.options.onViewChange();
    }
}


/** 重新测量所有节点（设置里的尺寸类变更）。 */
export function remeasureAll(c: MapCanvas) : void {
    if (!c.root) return;
    const all: MapNode[] = [];
    walkAll(c.root, (node) => {
        c.ensureWrapper(node);
        c.ensureContent(node);
        all.push(node);
    });
    c.measureNodes(all);
    c.relayout();
    c.updateViewport();
}


/**
 * 节点内容变化后刷新：重建显示实例、重新测量、重排。
 *
 * @param uid 节点 uid
 * @param force 忽略渐进阈值，立即建真实实例
 *              （编辑入口请用 ensureEditDisplay）
 */
export function refreshNode(c: MapCanvas, uid: string, force = false) : void {
    const node = c.byUid.get(uid);
    if (!node) return;
    const entry = c.displays.get(uid);
    if (entry) {
        entry.display.destroy();
        c.displays.delete(uid);
        node.display = null;
    }
    if (node.wrapper) node.wrapper.replaceChildren();
    if (force) {
        c.ensureWrapper(node);
        c.createDisplay(node);
    } else {
        c.ensureContent(node);
    }
    if (node.wrapper) c.measureNode(node);
    c.relayout();
    c.updateViewport();
    c.scheduleMeasureSettle();
}


/**
 * 编辑结束、文本**没有变化**时的快速收尾。
 *
 * 编辑用的本来就是完整的显示实例（enterEdit 只是换了组 compartment），
 * exitEdit 之后它就已经是正常的显示态。以前无条件走
 * refreshNode(uid, true) —— 那会 destroy + 重建整个 mini-CM，一次失焦
 * 白花 30~40ms，用户能明显看到一顿。这里只把编辑期间被撑高的盒子
 * 收回原高度（Enter 加行又删掉的情况），再重排一次。
 *
 * @param uid 节点 uid
 * @param baseHeight 进入编辑前的节点高度（0 = 没记录，不恢复）
 * @returns 是否已就地处理完
 */
export function finishEditDisplay(c: MapCanvas, uid: string, baseHeight: number, baseWidth?: number) : boolean {
    const node = c.byUid.get(uid);
    if (!node) return false;
    const entry = c.displays.get(uid);
    if (!entry) return false;
    let changed = false;
    // 编辑期间 growNodeHeight 只增不减，文本没变就恢复到进编辑前的高度
    const target =
        Number.isFinite(baseHeight) && baseHeight > 0 ? baseHeight : node.height;
    if (Math.abs(node.height - target) > 0.5) {
        node.height = target;
        if (node.wrapper) {
            node.wrapper.style.height = `${target}px`;
            c.positionNode(node);
        }
        changed = true;
    }
    // 宽度回缩：数学块进编辑时可能按源码自然宽度撑宽了（见 setNodeWidth），
    // 文本没变就退回进编辑前的宽度；文本变了会走 commit → 完整重测。
    if (
        baseWidth !== undefined &&
        Number.isFinite(baseWidth) &&
        baseWidth > 0 &&
        Math.abs(node.width - baseWidth) > 0.5
    ) {
        node.width = baseWidth;
        if (node.wrapper) {
            node.wrapper.style.width = `${baseWidth}px`;
            c.positionNode(node);
        }
        changed = true;
    }
    if (changed) {
        c.relayout();
        c.updateViewport();
        c.options.onViewChange();
    }
    return true;
}


/**
 * 直接改写节点盒子的宽度（编辑态按内容宽度撑宽用）。
 *
 * 与 growNodeHeight 同款：只写 node.width + 内联样式，然后 relayout，
 * **不动 node.height**。数学块编辑时源码（LaTeX）往往比渲染出来的公式长，
 * 不撑宽的话编辑区会挤成一条窄缝、只能左右滚动，很难改。
 *
 * @param uid 节点 uid
 * @param width 目标宽度（px）
 * @returns 是否真的改了宽度
 */
export function setNodeWidth(c: MapCanvas, uid: string, width: number) : boolean {
    const node = c.byUid.get(uid);
    const next = Math.ceil(width);
    if (!node?.wrapper || !Number.isFinite(next) || next <= 0) return false;
    if (Math.abs(node.width - next) <= 0.5) return false;
    node.width = next;
    node.measured = true;
    node.wrapper.style.width = `${next}px`;
    c.positionNode(node);
    c.relayout();
    c.updateViewport();
    c.options.onViewChange();
    return true;
}


/**
 * 编辑入口：保证节点有一个显示实例可翻转成编辑态。
 *
 * 占位节点（渐进换真还没轮到它）没有实例；这里按需建一个。
 */
export function ensureEditDisplay(c: MapCanvas, uid: string) : NodeDisplay | null {
    const node = c.byUid.get(uid);
    if (!node?.wrapper) return null;
    const entry = c.displays.get(uid);
    if (entry) return entry.display;
    c.createDisplay(node);
    // 新实例的尺寸可能还没量准：补量一次再进编辑
    c.measureNode(node);
    return c.displays.get(uid)?.display ?? null;
}


/**
 * 编辑中按内容高度撑高节点（只增不减，绝不重建显示实例）。
 *
 * 节点的盒子尺寸是布局时写死的；编辑时按回车新增一行、或长行自动折行后，
 * 内容会比盒子高，默认会被编辑态的滚动区裁掉。这里在编辑会话里把盒子
 * 撑到内容高度，节点下方的兄弟会跟着重排；提交后 finishEdit 会走
 * refreshNode 完整重测，那时才允许回缩。
 *
 * @param contentHeight 内容区高度（不含节点边框）
 * @returns 是否真的变高了
 */
export function growNodeHeight(c: MapCanvas, uid: string, contentHeight: number) : boolean {
    const node = c.byUid.get(uid);
    if (!node) return false;
    const wrapper = node.wrapper;
    if (!wrapper) return false;
    // 盒子是 border-box：内容高度之外还要留出上下边框，
    // 否则刚好差 2~6px，最后一行仍会被裁掉一点
    const style = getComputedStyle(wrapper);
    const border =
        (parseFloat(style.borderTopWidth) || 0) +
        (parseFloat(style.borderBottomWidth) || 0);
    const next = Math.ceil(contentHeight + border);
    if (!Number.isFinite(next) || next <= node.height + 0.5) return false;
    node.height = next;
    node.measured = true;
    wrapper.style.height = `${next}px`;
    c.positionNode(node);
    c.relayout();
    c.updateViewport();
    c.options.onViewChange();
    return true;
}


/** 把节点加入换真队列（去重）。 */
export function enqueueSwap(c: MapCanvas, uid: string) : void {
    if (c.queued.has(uid)) return;
    c.queued.add(uid);
    c.queue.push(uid);
    c.schedulePump();
}


/**
 * 手势是否正在进行：拖动 / 节点拖动 / 刚滚过滚轮。
 *
 * 换真泵据此暂停：创建 mini-CM 是主线程重活，绝不能在用户拖动
 * 或缩放时干。占位文本本身就能正常显示，松手后 100ms 内补齐。
 */
export function interactionActive(c: MapCanvas) : boolean {
    return (
        c.pointer !== null ||
        c.drag !== null ||
        performance.now() - c.lastWheelTime < WHEEL_ACTIVE_MS
    );
}


/** 换真泵：每次 ~16ms 把一批可见占位换成真实显示实例。 */
export function schedulePump(c: MapCanvas, delay = 16) : void {
    if (c.pumpTimer !== null) return;
    c.pumpTimer = setTimeout(() => {
        c.pumpTimer = null;
        // 手势进行中只轮询不干活。这里必须轮询而不是直接 return：
        // mountNode/enqueueSwap 不会在松手时再触发一次 schedulePump，
        // 直接丢弃定时器会让队列一直躺着。
        if (c.interactionActive()) {
            c.schedulePump(PUMP_PAUSE_MS);
            return;
        }
        const batch = c.queue.splice(0, PROGRESSIVE_BATCH);
        let changed = false;
        const created: MapNode[] = [];
        for (const uid of batch) {
            c.queued.delete(uid);
            const node = c.byUid.get(uid);
            if (!node?.wrapper || !node.placeholder) continue;
            // 只换「在画布上」的占位：离屏节点等挂载时再入队，避免
            // 大文档一次性把几十个 CM 全建出来（内存/首屏都受益）
            if (node.wrapper.parentElement !== c.nodeLayer) continue;
            // 已排队期间可能被 setData 复用了真实显示实例（拖动回写里
            // 很常见）：此时再走 createDisplay 会白造一个 CM，旧的
            // EditorView 还会因为没人 destroy 而泄漏，所以直接跳过。
            if (node.display) continue;
            c.createDisplay(node);
            created.push(node);
            changed = true;
        }
        // 换真前的尺寸记下来：占位文本按设计就和真实渲染尺寸接近
        const sizeBefore = created.map((n) => ({ w: n.width, h: n.height }));
        // 一批统一测：避免每个换真节点各触发一次强制布局
        c.measureNodes(created);
        if (changed) {
            // 只有尺寸真的变了才整树重排：以前每批都无条件 relayout，
            // 全挂载的大文档里等于每 16ms 把全部节点的 transform、
            // 连线、展开按钮重写一遍（实测 425 节点时每一批就是一个
            // ~500ms 的长任务，HUD 尖峰记录里每 +2 实例一对尖峰）。
            // 占位尺寸本来就贴近真实值，绝大多数批次尺寸不变、直接跳过。
            const sizeChanged = created.some(
                (n, i) =>
                    Math.abs(n.width - sizeBefore[i].w) > 0.5 ||
                    Math.abs(n.height - sizeBefore[i].h) > 0.5
            );
            if (sizeChanged) {
                c.relayout();
                c.updateViewport();
            }
            // 换真后的 CM 下一帧才排好，补一次补偿重测
            // （settleMounted 内部只在尺寸真的变了时才重排）
            c.scheduleMeasureSettle();
        }
        if (c.queue.length > 0) {
            c.schedulePump();
        }
    }, delay);
}


/**
 * 手势结束：立刻恢复换真，不必等下一次 100ms 轮询。
 *
 * 拖动期间队列只积压不处理；松手后用户马上就能看到真实渲染，
 * 而不是先盯着占位文本看半秒。
 */
export function resumePump(c: MapCanvas) : void {
    if (c.queue.length === 0) return;
    if (c.pumpTimer !== null) {
        clearTimeout(c.pumpTimer);
        c.pumpTimer = null;
    }
    c.schedulePump(0);
}
