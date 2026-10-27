/**
 * setData —— MapCanvas 的数据入口（从 canvas.ts 拆出）。
 *
 * 新旧模型 diff：uid 复用 + 拖拽 remap + 内容指纹认领旧 DOM/CM 实例。
 * 用旧 uid 在删除后整体前移的模型里查会漏掉兄弟子节点（历史 bug），
 * 所以认领要按新模型重建。
 *
 * @module webview/mindmap/engine/setData
 */

import type { MapCanvas } from './canvas.js';
import type { NodeDisplay } from '../miniCm.js';
import type { MindMapTreeNode } from '../types.js';
import { PROGRESSIVE_THRESHOLD } from './canvasConstants.js';
import { buildMapModel, walkAll } from './model.js';
import type { MapNode } from './model.js';
import { PROGRESSIVE_THRESHOLD } from './canvasConstants.js';

/**
 * 用新的数据树替换模型。
 *
 * @param tree 源数据树（已由上层烤入 expand 标记）
 * @param opts.uidRemap 旧 uid → 新 uid（拖动后路径变化时复用 DOM/CM）
 * @param opts.keepView 是否保持当前视口（默认保持；首次渲染会 fit）
 */
export function setData(
    c: MapCanvas,
    tree: MindMapTreeNode,
    opts?: { uidRemap?: Map<string, string>; keepView?: boolean }
): void {
    const oldRoot = c.root;
    const oldByUid = new Map(c.byUid);
    const oldDisplays = c.displays;
    const reverseRemap = new Map<string, string>();
    if (opts?.uidRemap) {
        for (const [from, to] of opts.uidRemap) reverseRemap.set(to, from);
    }

    // 内容指纹索引：删除一个节点后，后面所有兄弟的路径式 uid 会整体
    // 前移（0/2 → 0/1），只按 uid 复用的话等于「所有后续兄弟都换了个
    // 人」，wrapper / mini-CM 全部销毁重建 —— 用户看到的就是删一个
    // 节点、整排兄弟和它们的子树闪一下，删得越多越卡。
    //
    // 这里给旧节点按「类型 + 文本 + 标题级别 + 列表类型 + 语言」建索引，
    // 新节点找不到同 uid 的旧节点时按内容认领（先到先得），删一个节点
    // 就只销毁被删的那棵子树，其余节点原地复用。
    const oldNodesInOrder: MapNode[] = [];
    if (oldRoot) walkAll(oldRoot, (node) => oldNodesInOrder.push(node));
    const contentKeyOf = (node: MapNode): string =>
        [
            node.kind,
            node.text,
            node.data._headingLevel ?? '',
            node.data._listOrdered ? 1 : 0,
            node.data._language ?? '',
            node.data._imageUrl ?? '',
        ].join('\u0000');
    const oldByContent = new Map<string, MapNode[]>();
    for (const old of oldNodesInOrder) {
        const key = contentKeyOf(old);
        const bucket = oldByContent.get(key);
        if (bucket) bucket.push(old);
        else oldByContent.set(key, [old]);
    }
    /** 已经被新模型认领的旧节点（防止同一个 DOM/CM 被认领两次）。 */
    const claimedOldNodes = new Set<MapNode>();
    /** 按内容认领一个还没被用掉的旧节点。 */
    const takeByContent = (node: MapNode): MapNode | undefined => {
        const bucket = oldByContent.get(contentKeyOf(node));
        if (!bucket) return undefined;
        while (bucket.length > 0) {
            const candidate = bucket.shift()!;
            if (!claimedOldNodes.has(candidate)) return candidate;
        }
        return undefined;
    };

    // 1. 建新模型
    const newRoot = buildMapModel(tree);
    c.root = newRoot;
    c.byUid.clear();
    walkAll(newRoot, (node) => {
        c.byUid.set(node.uid, node);
    });

    // 2. 按 uid（或拖动映射）把旧节点的包裹元素 / 显示实例搬过来。
    //    注意：先收集「被搬走的 wrapper」，旧模型里没被搬走的稍后移除。
    //
    //    **必须防重复认领**：拖动后兄弟节点会整体错位（第 3 章从
    //    uid 0/2 变成 0/1），而「按相同 uid 复用」会把已经映射给别的
    //    节点（被拖走的 0/1）的 wrapper/CM 再认领一次。两个模型节点
    //    共用一个 DOM 后，后处理的那个会把前一个的内容替换掉，表现为
    //    宽度/内容错乱，直到重新进入编辑刷新才恢复。
    const displays = new Map<string, DisplayEntry>();
    const transferredWrappers = new Set<HTMLElement>();
    const claimedWrappers = new Set<HTMLElement>();
    const claimedDisplays = new Set<NodeDisplay>();
    walkAll(newRoot, (node) => {
        const sourceUid = reverseRemap.get(node.uid) ?? node.uid;
        // 认领顺序（越靠前越可信）：
        //   1. 拖动映射 / 同 uid 且内容完全相同；
        //   2. 内容指纹（删除导致的 uid 整体前移）；
        //   3. 同 uid（改名：内容变了，但 wrapper 还能原地复用）。
        const byUid = oldByUid.get(sourceUid);
        let oldNode: MapNode | undefined;
        if (byUid && !claimedOldNodes.has(byUid) && contentKeyOf(byUid) === contentKeyOf(node)) {
            oldNode = byUid;
        }
        if (!oldNode) oldNode = takeByContent(node);
        if (!oldNode) {
            const sameUid = oldByUid.get(node.uid);
            if (sameUid && !claimedOldNodes.has(sameUid)) oldNode = sameUid;
        }
        if (oldNode) claimedOldNodes.add(oldNode);
        if (oldNode?.wrapper && !claimedWrappers.has(oldNode.wrapper)) {
            node.wrapper = oldNode.wrapper;
            claimedWrappers.add(oldNode.wrapper);
            node.measured = oldNode.measured;
            node.width = oldNode.width;
            node.height = oldNode.height;
            transferredWrappers.add(oldNode.wrapper);
        }
        const entry = oldNode ? oldDisplays.get(oldNode.uid) : undefined;
        // 显示实例跟着它原来的 wrapper 走：实例只能被认领一次。
        //
        // 注意不要写成「wrapper 被认领过就跳过」——上面按 uid 复用
        // wrapper 时已经把它加进 claimedWrappers 了。必须允许
        // **本节点刚认领的那个 wrapper** 继续认领它的显示实例，
        // 否则每次 setData 都会把所有匹配的 mini-CM 全部销毁重建
        // （实测大文档一次拖动回写要 800ms+）。
        if (entry && !claimedDisplays.has(entry.display)) {
            if (!node.wrapper) {
                if (!claimedWrappers.has(entry.wrapper)) {
                    node.wrapper = entry.wrapper;
                    claimedWrappers.add(entry.wrapper);
                    transferredWrappers.add(entry.wrapper);
                }
            }
            // 文档内容若已变化（改名 / 拖动跨链转换），ensureContent 会
            // 发现 sourceDoc 不一致并重建成新的
            if (node.wrapper === entry.wrapper) {
                node.display = entry.display;
                claimedDisplays.add(entry.display);
                // 实例迁到新节点：同步间接引用，onDisplayChange 才不会
                // 把改动写回旧模型节点（顺带避免闭包挂住整棵旧树）
                entry.nodeRef.current = node;
                displays.set(node.uid, {
                    display: entry.display,
                    wrapper: entry.wrapper,
                    node,
                    nodeRef: entry.nodeRef,
                    kind: node.kind,
                    // 沿用旧实例的档位：ensureContent 会检查它是否仍符合当前档
                    mode: entry.mode,
                });
                node.placeholder = false;
            }
        }
    });

    // 3. 销毁未复用的显示实例 / 移除未复用的 wrapper
    //    先建一份「活着的实例」集合：以前对每个旧实例都扫一遍新表，
    //    N 个节点就是 O(N²)，删掉一个节点后特别明显。
    const liveDisplays = new Set<NodeDisplay>();
    for (const item of displays.values()) liveDisplays.add(item.display);
    for (const [uid, entry] of oldDisplays) {
        if (!liveDisplays.has(entry.display)) {
            entry.display.destroy();
            // wrapper 可能已经被新节点接手，绝不能误删
            if (!transferredWrappers.has(entry.wrapper)) entry.wrapper.remove();
            // uid 只在调试时用，避免 lint 抱怨未使用
            void uid;
        }
    }
    if (oldRoot) {
        walkAll(oldRoot, (node) => {
            if (node.wrapper && !transferredWrappers.has(node.wrapper)) {
                node.wrapper.remove();
            }
        });
    }
    c.displays = displays;

    // 4. 重建挂载集合（DOM 里还在 nodeLayer 的才算挂载）。
    //
    // 必须按**新模型 + DOM 实际父节点**重建，不能拿旧的 mounted uid
    // 到新模型里查：删除一个节点后，后面兄弟的路径式 uid 会整体前移
    // （0/2/0 → 0/1/0），用旧 uid 查到的要么不存在、要么根本是另一个
    // 节点。那些真正还挂在画布上的子节点会因此漏出 mounted 集合，
    // 而 relayout() 只给 mounted 里的节点写 transform —— 它们的 DOM
    // 就停在删除前的位置，表现为「下一个兄弟的子节点位置乱一下」，
    // 直到收起再展开（走 mountNode）才被重新定位。
    c.mounted.clear();
    walkAll(newRoot, (node) => {
        if (node.wrapper?.parentElement === c.nodeLayer) {
            c.mounted.add(node.uid);
        }
    });
    // 集合是重建的，版本号对不上旧值：下一轮不要跳过可见性同步
    c.mountedVersion += 1;

    // 5. 重建元素外观；新节点 / 内容变化的节点重新量尺寸
    c.progressiveCount = 0;
    // 只有首次渲染同步建一批真实 CM；后续更新全部交给 pump 按需换真
    c.eagerDisplayBudget = oldRoot ? 0 : PROGRESSIVE_THRESHOLD;
    const toMeasure: MapNode[] = [];
    walkAll(newRoot, (node) => {
        c.ensureWrapper(node);
        c.ensureContent(node);
        // 内容变了的节点 ensureContent 会重建显示实例并把 measured 置 false
        if (!node.measured || node.width <= 0 || node.height <= 0) {
            toMeasure.push(node);
        }
    });
    // 统一量：一次布局而不是每个节点一轮强制重排
    c.measureNodes(toMeasure);

    // 6. 布局 + 连线 + 展开按钮 + 视口
    c.relayout();
    if (!opts?.keepView && !c.hasFit) {
        c.fit();
    }
    c.updateViewport();
    c.options.onViewChange();
    c.scheduleViewport();
    // CM/widget 的真实尺寸要到下一帧才稳定
    c.scheduleMeasureSettle();
}
