/**
 * MindMapApp 协作模块（从 mindmapApp.ts 拆出）：编辑会话状态机：startEdit/撑高/行内格式/拆分选区/finishEdit。
 *
 * 全部是原 MindMapApp 方法，this 换成第一参数 app；跨模块调用走 app 上的薄包装方法。
 *
 * @module webview/mindmap/app/appEditSession
 */

import type { MindMapApp } from '../mindmapApp.js';
import { addChildNode, addSiblingNode } from '.././edit/add.js';
import { isMediaKind, renameNode } from '.././edit/rename.js';
import { MapCanvas } from '.././engine/canvas.js';
import type { MapNode } from '.././engine/model.js';
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { TEXT_NODE_KINDS, type EditSession, type SplitCapture } from '../mindmapApp.js';


/**
 * 进入编辑：显示 CM 原地翻转成编辑态（不重渲染、不重排画布）。
 *
 * @param uid 节点 uid
 * @param x 触发点击的视口 X（键盘入口无坐标）
 * @param y 触发点击的视口 Y
 */
export function startEdit(app: MindMapApp, uid: string, x?: number, y?: number) : void {
    const node = app.canvas.getNode(uid);
    if (!node || node.kind === 'root') return;
    if (app.editSession?.uid === uid) {
        // 已在编辑同一节点：只补焦点，绝不重设选区。
        // focusAt() 会把选区塌成光标 —— 双击选词、拖选到一半再触发
        // 编辑入口时，刚选中的文字会被它清掉（加粗 / 行内代码里的
        // 内容看起来就「选不上」）。正常编辑态本来就有焦点，这里
        // 只兜住少数焦点已丢但会话还没提交的瞬间。
        if (!app.editSession.display.view.hasFocus) {
            app.editSession.display.view.focus();
        }
        return;
    }
    app.commitEditSession();
    // 进入编辑 = 回到单节点操作，框选集合清掉
    if (app.multiSelected.size > 0) {
        app.multiSelected.clear();
        app.canvas.setMultiSelected(app.multiSelected);
        app.updateMultiBar();
    }
    // 占位节点（渐进换真还没轮到它）：先把真实显示实例建出来。
    const display = app.canvas.ensureEditDisplay(uid);
    if (!display) return;
    // commitEditSession 可能刚整树重建过：上面那个 node 可能是旧模型的
    // 对象，高度/种类都取最新的（ensureEditDisplay 还会补量一次尺寸）。
    const current = app.canvas.getNode(uid) ?? node;
    const session: EditSession = {
        uid,
        kind: current.kind,
        initialText: display.getText(),
        // 进编辑前的高度：文本没变时用它把编辑期间撑高的盒子收回去
        baseHeight: current.height,
        // 宽度同理：数学块编辑时按源码撑宽，退出时收回
        baseWidth: current.width,
        display,
    };
    app.editSession = session;
    app.selectedUid = uid;
    app.canvas.setSelected(uid);
    app.canvas.setEditing(uid);
    display.enterEdit({
        kind: node.kind,
        onCommit: (text) => app.finishEdit(session, text),
        // Shift+Enter（文本节点）= 提交当前项 + 新起一个同级节点：
        // 先把当前格的编辑内容提交，再走工具条同一个 addSibling 通道
        // （同级类型 / 缩进由 addSiblingNode 继承），commit() 会自动
        // 选中新节点并进入编辑。
        onShiftEnter: TEXT_NODE_KINDS.has(node.kind)
            ? () => {
                  app.finishEdit(session, display.getText());
                  app.addSibling();
              }
            : undefined,
        // 回车换行 / 自动折行让内容变高时撑高盒子。
        onDocChanged: () => app.scheduleGrowEditingNode(session),
        // 选中一段文字 → 工具条出现「拆分到子节点」；塌回光标 → 收起来
        onSelectionChange: () => app.refreshSplitButton(),
    });
    // 等一帧让 CM 完成重配与布局，再按点击坐标落光标（不全选）。
    // 这一帧里会话可能已经被提交/重建（外部 UPDATE、整树 setData），
    // 那时旧 display 已销毁，再 focusAt 会向已销毁视图派发选区事务。
    requestAnimationFrame(() => {
        if (app.editSession !== session || display.destroyed) return;
        // 媒体节点（公式 / HTML 块 / mermaid / 代码 / 表格 / 图片）：
        // 编辑态显示的是 Markdown 源码，通常比渲染结果宽得多
        // （LaTeX、`<img src="...">`、表格管道行尤其明显）。
        // 进编辑这一帧按源码自然宽度重算一次，**只撑宽不缩窄**
        // （宽度不得低于显示时的宽度）；**高度保持不变**，
        // 装不下的部分在编辑区箱内纵向滚动（见 mindmapStyles）。
        //
        // 但必须有上限（仿 live：源码再长也不该改变排版宽度，
        // 超长的行折行显示）：
        // - 表格：封顶在节点自身的显示上限（60em，与列宽预算同一条
        //   CSS 规则）——宽表的管道源码动辄上千 px，不限会把节点
        //   拉成横跨整个画布；
        // - 其它媒体：允许撑宽看源码，但给一个 60em 的绝对天花板。
        if (isMediaKind(session.kind)) {
            const needed = app.measureEditingSourceWidth(display);
            if (needed > session.baseWidth) {
                const nodeEl = display.container.closest('.lwm-node');
                const computedMax = nodeEl
                    ? Number.parseFloat(getComputedStyle(nodeEl).maxWidth)
                    : NaN;
                const fontSize = Number.parseFloat(
                    getComputedStyle(display.view.contentDOM).fontSize
                );
                // 节点没写死上限（或量不到）时用 60em 兜底
                const fallbackCap = (Number.isFinite(fontSize) ? fontSize : 14) * 60;
                const nodeCap =
                    Number.isFinite(computedMax) && computedMax > 0
                        ? computedMax
                        : fallbackCap;
                const cap =
                    session.kind === 'table'
                        ? nodeCap
                        : Math.max(nodeCap, fallbackCap);
                app.canvas.setNodeWidth(session.uid, Math.min(needed, cap));
            }
        }
        display.focusAt(x, y);
    });
}


/**
 * 估算编辑态源码需要多宽（px）。
 *
 * 不用 DOM 量：编辑区的 .cm-line 是自动折行的，scrollWidth 永远等于
 * 盒子宽度，量不出「一整行源码有多长」。用 canvas 按 .cm-content 的
 * 实际字体逐行 measureText（与排版用的是同一套字体，误差只有几个 px），
 * 取最长一行再加上节点左右留白。
 *
 * @param display 已经翻成编辑态的节点显示实例
 * @returns 需要的宽度；拿不到 2D 上下文时返回 0（调用方会跳过撑宽）
 */
export function measureEditingSourceWidth(app: MindMapApp, display: NonNullable<ReturnType<MapCanvas['getDisplay']>>) : number {
    const content = display.view.contentDOM;
    const style = getComputedStyle(content);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return 0;
    // 字体必须与 CM 内容一致；canvas 的 font 语法与 CSS 一致
    ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    let max = 0;
    for (const line of display.getText().split('\n')) {
        if (line.length === 0) continue;
        max = Math.max(max, ctx.measureText(line).width);
    }
    if (max <= 0) return 0;
    // 节点内边距 + 光标/滚动条的安全余量
    return Math.ceil(max) + 28;
}


/**
 * 编辑中内容变高时撑高单元格（合并到下一帧，每帧最多量一次）。
 *
 * 段落里按回车新增一行、列表项太长自动折行，都会让 mini-CM 的内容
 * 高于节点盒子；不撑高的话编辑态的内部滚动会把新行裁掉，看起来
 * 像「回车没反应」。媒体节点（代码/表格/公式）不参与，保持盒内滚动。
 */
export function scheduleGrowEditingNode(app: MindMapApp, session: EditSession) : void {
    if (app.growFrame !== null) return;
    app.growFrame = requestAnimationFrame(() => {
        app.growFrame = null;
        if (app.editSession !== session) return;
        if (!TEXT_NODE_KINDS.has(session.kind)) return;
        app.canvas.growNodeHeight(session.uid, session.display.contentHeight());
    });
}


/** 取消待执行的撑高帧（会话结束/销毁时调用）。 */
export function cancelGrowEditingNode(app: MindMapApp) : void {
    if (app.growFrame === null) return;
    cancelAnimationFrame(app.growFrame);
    app.growFrame = null;
}


/**
 * 在选中节点上执行 live 模式的行内格式快捷键（Ctrl/Cmd+B/I/G）。
 *
 * 导图平时的节点是只读 mini-CM，命令本身只改 EditorState，不会自动
 * 进入编辑；所以这里先翻转成编辑态，再对同一个 view 执行命令。
 *
 * 有个时序坑：`startEdit` 内部排了一帧 rAF 调 `focusAt()`，键盘入口
 * 没有坐标 → 光标被甩到文末（显示文档末尾还有一行哨兵换行）。如果
 * 直接执行命令，`**` 会插进隐藏的哨兵行，源文档里多出一对看不见的
 * 标记。所以：
 * 1. 进编辑前先记下显示态选区（用户可能已经拖选了一段文字）；
 * 2. 我们的 rAF 排在 startEdit 的 focusAt 之后，先把选区恢复回来；
 * 3. 空选区且停在文末时，把光标左移一个字符（哨兵换行之前），
 *    这样空标记落在正文末尾，和 live 里「光标处插一对空标记、
 *    光标停在中间」的行为一致。
 */
export function applyInlineFormat(app: MindMapApp, uid: string, command: (view: EditorView) => boolean,) : void {
    const node = app.canvas.getNode(uid);
    if (!node) return;
    // root 不可编辑；代码/表格/公式/YAML 里插行内标记只会破坏语法
    if (node.kind === 'root' || node.kind === 'meta' || isMediaKind(node.kind)) {
        return;
    }
    const display = app.canvas.getDisplay(uid);
    const saved = display && !display.editing ? display.view.state.selection : null;
    app.startEdit(uid);
    const session = app.editSession;
    if (!session || session.uid !== uid) return;
    requestAnimationFrame(() => {
        // 会话可能已经结束，或者显示实例在 rAF 之前被 setData / 换档
        // 销毁（销毁后的 view 仍接受 dispatch，但会带着旧文档位置把
        // CM 的内部状态搞坏，后续 lineAt 越界）。两种情况都直接放弃。
        if (app.editSession !== session || session.display.destroyed) return;
        const view = session.display.view;
        let selection = saved ?? view.state.selection;
        try {
            if (
                selection.main.empty &&
                selection.main.head >= view.state.doc.length
            ) {
                // 文末哨兵换行不属于正文：光标挪到正文末尾
                selection = EditorSelection.single(
                    Math.max(0, view.state.doc.length - 1),
                );
            }
            view.dispatch({ selection });
        } catch {
            /* 视图已销毁：忽略 */
        }
        command(view);
        // dispatch 不会自动给焦点，编辑态没焦点就没法接着打字
        view.focus();
    });
}


/**
 * 显示态按钮改动了节点本地文档（mermaid 宽度档位 / 表格加行加列）。
 *
 * 这些操作不经过编辑会话，改动只存在于节点的 mini-CM 里。这里按 uid
 * 走 renameNode → commit 回写 markdown；放到微任务里执行，避免在上面的
 * CM dispatch 过程中同步重建整棵树（会把正在派发的 view 销毁掉）。
 * 编辑会话里不处理：那种改动由 blur/Esc 的提交路径统一回写。
 */
export function handleDisplayEdit(app: MindMapApp, node: MapNode, text: string) : void {
    if (app.editSession) return;
    const uid = node.uid;
    queueMicrotask(() => {
        if (app.editSession || !app.currentTree) return;
        // 期间可能整树重建过：按 uid 重新确认节点还在
        if (!app.canvas.getNode(uid)) return;
        app.commit(renameNode(app.markdown, app.currentTree, uid, text));
    });
}


/** 提交当前编辑会话（如有）。 */
export function commitEditSession(app: MindMapApp) : void {
    const session = app.editSession;
    if (!session) return;
    app.finishEdit(session, session.display.getText());
}


/**
 * Ctrl/Cmd+S：强制写回 + 保存。
 *
 * 平时的提交靠 blur/Esc；实际用下来 blur 偶尔送不到（见
 * MindMapApp.onWindowBlur / onDocumentPointerDown 的注释），改动会留在
 * mini-CM 里。这里走同一条 renameNode 通道把文本落回源文档，然后不管
 * 有没有改动都把手里的全文交给宿主立即落盘（onSave），不等 300ms 防抖。
 */
export function forceWrite(app: MindMapApp) : void {
    if (app.editSession) app.commitEditSession();
    app.options.onSave?.(app.markdown);
}


/**
 * 销毁前提交（只写回文档，不重建画布）。
 *
 * INIT 重建时 MindMapApp 会被销毁；直接 exitEdit 会把用户刚输入的内容
 * 丢掉（webview 里的文本还在，但扩展侧拿不到）。马上要销毁画布，
 * 所以复用 renameNode → onEdit 这条纯文本通道，跳过 setData。
 */
export function flushEditBeforeDestroy(app: MindMapApp) : void {
    const session = app.editSession;
    if (!session) return;
    app.editSession = null;
    app.splitCapture = null;
    app.cancelGrowEditingNode();
    if (!session.display.destroyed) session.display.exitEdit();
    const text = session.display.getText();
    if (text === session.initialText || !app.currentTree) return;
    const result = renameNode(app.markdown, app.currentTree, session.uid, text);
    if (result.text === app.markdown) return;
    app.setMarkdown(result.text);
    app.options.onEdit(result.text);
}


/**
 * 刷新「拆分到子节点」按钮：备快照 + 按有无选区显隐。
 *
 * 调用时机：编辑态选区变化（miniCm 的 onSelectionChange）、
 * 会话结束（清空）。选中文字 → 按钮出现；塌成光标 → 按钮消失。
 */
export function refreshSplitButton(app: MindMapApp) : void {
    app.splitCapture = app.captureSplitSelection();
    // 整个「拆分」菜单（主按钮 + 二级菜单）一起显隐
    const menu = app.toolbarEl?.querySelector<HTMLElement>(
        '.lwm-tool-menu[data-menu="split"]'
    );
    if (menu) menu.style.display = app.splitCapture ? '' : 'none';
}


/** 「拆分到子节点」当前的选区快照（没有可拆分选区时返回 null）。 */
export function captureSplitSelection(app: MindMapApp) : SplitCapture | null {
    const session = app.editSession;
    // 限文本节点：媒体节点（代码/表格/公式…）编辑的是源码，
    // 从中剪一段走只会得到一截坏语法。
    if (!session || !TEXT_NODE_KINDS.has(session.kind)) return null;
    if (session.display.destroyed) return null;
    const sel = session.display.view.state.selection.main;
    if (sel.empty) return null;
    const text = session.display.view.state
        .sliceDoc(sel.from, sel.to)
        .replace(/\s*\n\s*/g, ' ')
        .trim();
    if (!text) return null;
    return {
        uid: session.uid,
        from: sel.from,
        to: sel.to,
        text,
        fullText: session.display.getText(),
    };
}


/**
 * 「拆分到子节点」：把编辑态选中的文字从当前节点剪掉，作为新子节点的内容。
 *
 * 为什么要捕获而不是点菜单时再读选区：点击菜单按钮必然让编辑区
 * **失焦**，而 mini-CM 的 blur 处理器会立刻提交编辑会话 ——
 * 轮到菜单 action 执行时 editSession 已经是 null，现场读的方案
 * 会静默什么都不做（实测「点了没反应」）。所以打开菜单时就把
 * 选区位置 / 选中文字 / 节点全文都快照下来。
 *
 * 执行时按会话是否还活着分两条路：
 * 1. 会话还活着（无头测试 / 焦点没丢）：先在 mini-CM 里挖掉选区，
 *    连同其它未提交改动一起提交；
 * 2. 会话已被失焦提交（真实点击）：源文档里是「剪掉前」的全文，
 *    按快照位置算出删掉选中段后的文本，直接 renameNode 写回。
 * 最后用剪下来的文字新建子节点 / 兄弟节点 —— commit 会自动选中并进编辑。
 *
 * @param placement - child = 新子节点；sibling = 当前节点后面的同级节点
 */
export function splitSelection(app: MindMapApp, captured: SplitCapture, placement: 'child' | 'sibling') : void {
    const session = app.editSession;
    if (
        session &&
        session.uid === captured.uid &&
        !session.display.destroyed
    ) {
        session.display.view.dispatch({
            changes: { from: captured.from, to: captured.to },
        });
        app.commitEditSession();
    } else if (app.currentTree) {
        const newText =
            captured.fullText.slice(0, captured.from) +
            captured.fullText.slice(captured.to);
        app.commit(
            renameNode(app.markdown, app.currentTree, captured.uid, newText)
        );
    }
    if (!app.currentTree) return;
    app.commit(
        placement === 'sibling'
            ? addSiblingNode(
                  app.markdown,
                  app.currentTree,
                  captured.uid,
                  captured.text
              )
            : addChildNode(
                  app.markdown,
                  app.currentTree,
                  captured.uid,
                  captured.text
              )
    );
}


/** 结束编辑会话：文本有变化走 renameNode → commit。 */
export function finishEdit(app: MindMapApp, session: EditSession, text: string | null) : void {
    if (app.editSession !== session) return;
    app.editSession = null;
    // 会话结束：拆分快照作废，按钮收起
    app.splitCapture = null;
    app.refreshSplitButton();
    // 会话结束后不再撑高（提交路径会完整重测，允许回缩）
    app.cancelGrowEditingNode();
    session.display.exitEdit();
    app.canvas.setEditing(null);
    if (text !== null && text !== session.initialText && app.currentTree) {
        app.commit(renameNode(app.markdown, app.currentTree, session.uid, text));
        return;
    }
    // 编辑期间到达的外部更新：setData 会整树重建并复用/重建各节点内容，
    // 以前先 refreshNode 再 setData，等于把同一个节点重建两遍。直接整树替换。
    if (app.pendingTree) {
        const tree = app.pendingTree;
        app.pendingTree = null;
        app.currentTree = tree;
        app.canvas.setData(app.bakeExpandState(tree));
        // 树变了：内链箭头按新内容重算
        app.syncInternalLinks();
        app.toggleEmptyHint(tree.children.length === 0);
        return;
    }
    // 文本没变：显示实例本来就是完整的，exitEdit 已经切回显示态，
    // 就地收尾即可（只把编辑时撑高的盒子收回去）。
    if (app.canvas.finishEditDisplay(session.uid, session.baseHeight, session.baseWidth)) {
        return;
    }
    app.canvas.refreshNode(session.uid, true);
}
