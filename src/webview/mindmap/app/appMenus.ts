/**
 * MindMapApp 协作模块（从 mindmapApp.ts 拆出）：右键菜单（含表格菜单）+ 导图导出入口。
 *
 * 全部是原 MindMapApp 方法，this 换成第一参数 app；跨模块调用走 app 上的薄包装方法。
 *
 * @module webview/mindmap/app/appMenus
 */

import type { MindMapApp } from '../mindmapApp.js';
import { cellAt } from '../../codemirror/extensions/livePreview/table/tableCellSelection.js';
import { runTableCommand } from '../../codemirror/extensions/livePreview/table/tableCommands.js';
import type { TableCommand } from '../../codemirror/extensions/livePreview/table/tableCommands.js';
import { splitRowText } from '../../codemirror/extensions/livePreview/table/tableDetect.js';
import { TABLE_MENU_ITEMS } from '../../editing/editorContextMenu.js';
import { renameNode } from '.././edit/rename.js';
import { rasterizeSvg, toPdfDataUrl, toPngDataUrl } from '.././engine/export.js';
import type { NodeDisplay } from '.././miniCm.js';
import type { EditorView } from '@codemirror/view';


// ==================================================================
// 右键菜单 / 导出
// ==================================================================

/** 创建全局右键菜单（导出 / 适应画布 / 全部展开）。 */
export function createContextMenu(app: MindMapApp) : void {
    app.container.addEventListener('contextmenu', app.onContainerContextMenu);
    document.addEventListener('click', app.onDocumentClick);
    document.addEventListener('keydown', app.onDocumentKeyDown);
    window.addEventListener('blur', app.onWindowBlur);
}


/** 打开右键菜单（贴不住右下就往左/上翻）。 */
export function openContextMenu(app: MindMapApp, event: MouseEvent, table: { uid: string; display: NodeDisplay } | null = null) : void {
    app.closeContextMenu();
    // 本轮的表格上下文：菜单项点击时用它执行命令
    app.tableMenuContext = table;
    const menu = document.createElement('div');
    menu.className = 'lwm-context-menu';
    const items: Array<{ label: string; action: () => void } | 'sep'> = [];
    // 表格节点：增删行列与 live 模式完全同一组菜单项（含顺序/文案）
    if (table) {
        for (const item of TABLE_MENU_ITEMS) {
            items.push({
                label: item.label,
                action: () => app.runTableMenuCommand(item.action),
            });
        }
        items.push('sep');
    }
    if (app.options.onExport) {
        items.push(
            { label: '导出 PNG', action: () => void app.handleExport('png') },
            { label: '导出 SVG', action: () => void app.handleExport('svg') },
            { label: '导出 PDF', action: () => void app.handleExport('pdf') },
            'sep'
        );
    }
    items.push(
        { label: '适应画布', action: () => app.canvas.fit() },
        { label: '全部展开', action: () => app.expandAllNodes() }
    );
    for (const item of items) {
        if (item === 'sep') {
            const sep = document.createElement('div');
            sep.className = 'lwm-context-sep';
            menu.appendChild(sep);
            continue;
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = item.label;
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            // 保留表格上下文：命令要用 display 执行，执行完自己收尾并降档；
            // 这里要是走默认关闭，临时全量实例会先被销毁，命令就作用在
            // 一个已经 destroy 的 EditorView 上。
            app.closeContextMenu(true);
            item.action();
        });
        menu.appendChild(button);
    }
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    let x = event.clientX;
    let y = event.clientY;
    if (x + rect.width > window.innerWidth - 4) x = window.innerWidth - rect.width - 4;
    if (y + rect.height > window.innerHeight - 4) y = window.innerHeight - rect.height - 4;
    menu.style.left = `${Math.max(4, x)}px`;
    menu.style.top = `${Math.max(4, y)}px`;
    app.contextMenuEl = menu;
}


/**
 * 关闭右键菜单。
 *
 * @param keepTableContext - true = 保留表格上下文（菜单项点击后由命令
 *        自己收尾）。默认 false：顺手把右键时临时提升的全量显示实例
 *        降回当前渲染档，避免「只看了一眼菜单，节点就一直全量渲染」。
 */
export function closeContextMenu(app: MindMapApp, keepTableContext = false) : void {
    app.contextMenuEl?.remove();
    app.contextMenuEl = null;
    if (keepTableContext) return;
    const table = app.tableMenuContext;
    app.tableMenuContext = null;
    // 编辑会话里的 display 不能动（refreshNode 会重建 DOM 打断输入）
    if (table && app.editSession?.uid !== table.uid) {
        // 右键把选区挪进了格子（表格 widget 会暂时变回源码），先复位
        table.display.resetSelection();
        app.canvas.refreshNode(table.uid, true);
    }
}


/**
 * 解析右键落点是否落在表格节点的某一格上。
 *
 * 与 live 模式的行为对齐（main.ts 的 resolveTableContext）：
 * 不进入编辑态、不弹 node 自己的菜单，而是把**整格**变成选区，
 * 后续增删行列作用在「选区覆盖的格子」上。
 *
 * @param event - contextmenu 事件
 * @returns 表格节点 uid + 可执行命令的显示实例；不是表格格子时返回 null
 */
export function resolveTableMenuContext(app: MindMapApp, event: MouseEvent) : { uid: string; display: NodeDisplay } | null {
    const target = event.target instanceof Element ? event.target : null;
    const wrapper = target?.closest<HTMLElement>('.lwm-node[data-kind="table"]');
    if (!wrapper || !wrapper.closest('.lwm-node-layer')) return null;
    const uid = wrapper.dataset.uid;
    if (!uid) return null;
    // 缩放降级档下节点可能只有占位文本，没有表格 widget / 可定位的 CM：
    // 强制建一个全量实例（菜单关闭或命令执行完再按档降回去）
    const modeBefore = app.canvas.getDisplayMode(uid);
    const display = app.canvas.ensureEditDisplay(uid);
    if (!display) return null;
    const pos = app.tablePosAtEvent(display.view, event);
    const cell = pos == null ? null : cellAt(display.view.state, pos);
    if (!cell) {
        // 点在节点边框 / 表格外面：菜单照常弹，但别把临时全量实例留着
        if (modeBefore !== 'full' && app.editSession?.uid !== uid) {
            app.canvas.refreshNode(uid, true);
        }
        return null;
    }
    const selection = display.view.state.selection.main;
    // 已经框选了一片格子、右键又落在选区里：保持框选（与 live 一致）
    const insideSelection =
        !selection.empty && selection.from <= cell.to && cell.from <= selection.to;
    if (!insideSelection) {
        display.view.dispatch({ selection: { anchor: cell.from, head: cell.to } });
    }
    return { uid, display };
}


/**
 * 右键落点 → 表格源码里的文档位置。
 *
 * 不能只靠 `view.posAtCoords`：导图节点的 mini-CM 里，表格行被 live
 * 预览的行装饰撑高（实测约 30px 一行），而 CM 的高度缓存还停在装饰
 * 生效前的 14px。posAtCoords 是「y → 高度缓存里的行 → 行内扫描」，
 * 缓存对不上时要么返回 null，要么落到分隔行（cellAt 按设计返回 null）。
 *
 * 这里优先用真实 DOM：`event.target` 往上找 `.cm-line`，再用
 * `posAtDOM` 换成文档位置 —— 行一定是对的；列再按点击 x 与这一行
 * 各格子在屏幕上的左右区间比较，取最近的一格（`coordsAtPos` 直接读
 * 行内 DOM，不受高度缓存影响）。
 *
 * @param view - 表格节点的 mini-CM
 * @param event - contextmenu 事件
 * @returns 文档位置；完全定位不到时返回 null
 */
export function tablePosAtEvent(app: MindMapApp, view: EditorView, event: MouseEvent) : number | null {
    const target = event.target instanceof Element ? event.target : null;
    // event.target 可能已经脱离 DOM：降级档里右键的是占位文本，
    // ensureEditDisplay 刚把它整块 replaceChildren 成真实 CM，旧节点
    // 已经不在文档里。这时按坐标重新做一次命中测试，拿到新的 .cm-line。
    const targetLine = target?.closest('.cm-line') ?? null;
    const hit =
        targetLine && view.contentDOM.contains(targetLine)
            ? targetLine
            : (document
                  .elementFromPoint(event.clientX, event.clientY)
                  ?.closest('.cm-line') ?? null);
    const lineEl =
        hit && view.contentDOM.contains(hit) ? hit : null;
    if (lineEl) {
        try {
            // 行首位置（posAtDOM 按真实 DOM 结构映射，不走高度缓存）
            const linePos = view.posAtDOM(lineEl, 0);
            return app.nearestCellPosByX(view, linePos, event.clientX) ?? linePos;
        } catch {
            // DOM 映射失败（例如行正在被替换）：退回原生坐标命中
        }
    }
    // CM 的 posAtCoords 类型是 number | null，实测在高度缓存异常时
    // 会真的返回 undefined，这里统一归一成 null
    return view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? null;
}


/**
 * 在一行里按点击 x 找最接近的格子起点。
 *
 * @param view - 编辑器视图
 * @param linePos - 这一行的任意文档位置
 * @param x - 点击的视口 x
 * @returns 最近格子的行内起点；不是表格行时返回 null
 */
export function nearestCellPosByX(app: MindMapApp, view: EditorView, linePos: number, x: number) : number | null {
    const line = view.state.doc.lineAt(linePos);
    const segments = splitRowText(line.text);
    if (segments.length === 0) return null;
    let best: number | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const seg of segments) {
        const from = line.from + seg.from;
        const to = line.from + seg.to;
        // 格子左右边界：首字符右侧 / 末字符右侧；取不到就跳过
        const startRect = view.coordsAtPos(from, 1) ?? view.coordsAtPos(from);
        const endRect = view.coordsAtPos(to, -1) ?? view.coordsAtPos(to);
        if (!startRect) continue;
        const left = startRect.left;
        const right = endRect ? endRect.right : startRect.right;
        const dist = x < left ? left - x : x > right ? x - right : 0;
        if (dist < bestDist) {
            bestDist = dist;
            best = from;
        }
    }
    return best;
}


/**
 * 执行一项表格命令并把结果写回源文档。
 *
 * 显示态 mini-CM 是只读的，runTableCommand 会检查 editable，所以用
 * withEditable 临时放开；命令改的是同一份 EditorState，执行完
 * getText() 就是新表格源码，走 renameNode → commit 给宿主回写。
 *
 * @param command - 表格命令（增删行列）
 */
export function runTableMenuCommand(app: MindMapApp, command: TableCommand) : void {
    const table = app.tableMenuContext;
    app.tableMenuContext = null;
    if (!table || !app.currentTree) return;
    const { uid, display } = table;
    const view = display.view;
    // 正在编辑同一个表格节点：命令直接改编辑会话的 view。与 live 模式
    // 一致，改完**保持编辑态**，走失焦 / Esc 的统一提交链路
    // （finishEdit 里 renameNode → commit），不在这里额外退出编辑。
    const session = app.editSession?.uid === uid ? app.editSession : null;
    const changed = display.withEditable(() =>
        runTableCommand(view, command, view.state.selection.main.from)
    );
    if (changed) {
        if (session) return;
        const text = display.getText();
        const next = renameNode(app.markdown, app.currentTree, uid, text);
        if (next.text !== app.markdown) {
            app.commit({ text: next.text });
            return;
        }
    }
    // 没改动（例如只剩一列不能删）或文档内容碰巧没变：
    // 编辑会话保持原样，否则把临时全量实例降回当前档
    if (!session) app.canvas.refreshNode(uid, true);
}


/**
 * 执行导出：画布克隆 → SVG / PNG / PDF → onExport 交宿主存盘。
 */
export async function handleExport(app: MindMapApp, format: 'png' | 'svg' | 'pdf') : Promise<void> {
    if (!app.options.onExport || app.exportInFlight) return;
    app.exportInFlight = true;
    const name = app.fileName || 'mindmap';
    try {
        const { svg, width, height } = app.canvas.buildExportSvg();
        if (format === 'svg') {
            app.options.onExport({ format, name, svgText: svg });
        } else {
            const raster = await rasterizeSvg(svg, width, height, format === 'png' ? 2 : 1.5);
            const dataUrl =
                format === 'png' ? toPngDataUrl(raster.canvas) : toPdfDataUrl(raster.canvas);
            app.options.onExport({ format, name, dataUrl });
        }
    } catch (error) {
        const notice = document.createElement('div');
        notice.className = 'lwm-perf-notice';
        notice.textContent = `导出失败: ${
            error instanceof Error ? error.message : String(error)
        }`;
        app.container.appendChild(notice);
        setTimeout(() => notice.remove(), 3000);
    } finally {
        app.exportInFlight = false;
    }
}
