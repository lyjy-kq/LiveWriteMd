/**
 * 表格边缘的「+」按钮：悬停右边框加一列、下边框加一行。
 *
 * 表格在 live preview 里不是 widget，而是**行/格装饰**（见 tableRender.ts），
 * 所以这里不能像图片那样把按钮塞进 widget，只能：
 *
 * 1. 在 contentDOM 上听 mousemove，用 `closest('.cm-md-tcell')` 找到鼠标下的
 *    格子（不用 posAtCoords —— 导图节点里 CM 的高度缓存常常是旧的，
 *    posAtCoords 会算错行）；
 * 2. 判断指针是否贴在这格的右边框（最后一列）或下边框（最后一行）；
 * 3. 把一个绝对定位的「+」按钮挂到 view.dom（编辑器的定位上下文）上，
 *    同时给格子加一个类让那条边泛蓝；
 * 4. 点击按钮时把光标位置（posAtDOM）交给 runTableCommand 加行/列。
 *
 * 只读的导图节点怎么办？显示态 `EditorView.editable === false`，
 * runTableCommand 会直接拒绝。miniCm 通过 {@link tableEditBridge} facet
 * 提供了一个「临时可编辑」的桥（withEditable），这里优先走桥；
 * 主编辑器没有桥，且本来就是可编辑的，走默认分支。
 *
 * @module webview/codemirror/extensions/livePreview/tableHoverControls
 */

import { Facet } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { CELL_LAST_CLASS, ROW_LAST_CLASS } from './tableRender.js';
import { runTableCommand, type TableCommand } from './tableCommands.js';

/**
 * 显示态执行表格命令的桥。
 *
 * 参数与 runTableCommand 一致（命令 + 文档位置），返回是否真的改了文档。
 * 导图节点显示态不可编辑，必须借这个 facet 临时放开 editable；
 * 主编辑器不提供（空数组），插件退回直接执行。
 */
export const tableEditBridge = Facet.define<
    (command: TableCommand, pos: number) => boolean
>();

/** 按钮离边框的判定距离（px）：鼠标进入这条带子就算「悬停在边框上」。 */
const EDGE_TOLERANCE = 5;

/** 按钮尺寸（px）：以边框中点为圆心摆放。 */
const BUTTON_SIZE = 18;

/** 当前悬停的边类型。 */
type EdgeKind = 'col' | 'row';

/**
 * 创建表格边缘加行/加列的插件。
 *
 * 每个 EditorView 一份：按钮 DOM、hover 类、rAF 句柄都是实例私有的，
 * 多个节点同时显示时互不干扰。
 */
export const tableHoverControls = ViewPlugin.fromClass(
    class {
        /** 挂在 view.dom 上的「+」按钮（惰性创建，之后复用）。 */
        private button: HTMLDivElement | null = null;
        /** 当前高亮的格子（悬停右边框时是最后一列格子，下边框时是最后一行格子）。 */
        private hoverCell: HTMLElement | null = null;
        /** 当前悬停的边（null = 没贴边，按钮隐藏）。 */
        private edge: EdgeKind | null = null;
        /** 按钮对应的插入位置（文档位置）。 */
        private targetPos = -1;
        /** 最近一次 mousemove 的坐标：一帧只处理一次，避免每 move 都量 DOM。 */
        private lastEvent: MouseEvent | null = null;
        /** 已排队的 rAF。 */
        private frame: number | null = null;
        /** 事件监听解绑函数。 */
        private cleanup: Array<() => void> = [];

        constructor(private view: EditorView) {
            const content = view.contentDOM;
            const onMove = (event: MouseEvent): void => {
                this.lastEvent = event;
                if (this.frame !== null) return;
                this.frame = requestAnimationFrame(() => {
                    this.frame = null;
                    const pending = this.lastEvent;
                    this.lastEvent = null;
                    if (pending) this.handleMove(pending);
                });
            };
            const onLeave = (): void => this.hide();
            // 滚动时表格位置变了，按钮按旧坐标会飘；直接收起，等下一次移动再出现
            const onScroll = (): void => this.hide();
            content.addEventListener('mousemove', onMove);
            content.addEventListener('mouseleave', onLeave);
            view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
            this.cleanup.push(() => {
                content.removeEventListener('mousemove', onMove);
                content.removeEventListener('mouseleave', onLeave);
                view.scrollDOM.removeEventListener('scroll', onScroll);
            });
        }

        update(update: ViewUpdate): void {
            // 文档/视口变化后旧的格子引用可能已经不在 DOM 里：先收起
            if (update.docChanged || update.viewportChanged) this.hide();
        }

        destroy(): void {
            for (const fn of this.cleanup) fn();
            this.cleanup = [];
            if (this.frame !== null) cancelAnimationFrame(this.frame);
            this.frame = null;
            this.button?.remove();
            this.button = null;
            this.hoverCell = null;
        }

        /** 让一条边泛蓝（加类），并记录目标位置。 */
        private setEdge(cell: HTMLElement, kind: EdgeKind, pos: number): void {
            if (this.hoverCell !== cell || this.edge !== kind) {
                this.clearHighlight();
                cell.classList.add(
                    kind === 'col' ? 'cm-md-tcell-edge-col' : 'cm-md-tcell-edge-row'
                );
                this.hoverCell = cell;
                this.edge = kind;
            }
            this.targetPos = pos;
            this.showButton();
        }

        /** 移除蓝色边。 */
        private clearHighlight(): void {
            if (!this.hoverCell) return;
            this.hoverCell.classList.remove(
                'cm-md-tcell-edge-col',
                'cm-md-tcell-edge-row'
            );
            this.hoverCell = null;
            this.edge = null;
        }

        /** 隐藏按钮 + 清掉蓝色边。 */
        private hide(): void {
            this.clearHighlight();
            this.targetPos = -1;
            if (this.button) this.button.style.display = 'none';
        }

        /** 惰性创建按钮（只绑一次事件）。 */
        private ensureButton(): HTMLDivElement {
            if (this.button) return this.button;
            const button = document.createElement('div');
            button.className = 'cm-md-table-add';
            button.setAttribute('aria-hidden', 'true');
            button.textContent = '+';
            // 按钮在编辑器内部：mousedown 必须拦住，否则编辑器会把点击
            // 当成放置光标/开始拖选，click 可能根本不触发。
            button.addEventListener('mousedown', (event) => {
                event.preventDefault();
                event.stopPropagation();
            });
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const command: TableCommand = this.edge === 'row' ? 'row-below' : 'col-right';
                const pos = this.targetPos;
                const cell = this.hoverCell;
                if (pos < 0) return;
                // 先收起 UI 再改文档：命令会重排整张表，旧格子立即失效
                this.hide();
                // 主编辑器没有桥，且本来就 editable；导图节点由桥临时放开
                const bridge = this.view.state.facet(tableEditBridge)[0];
                if (bridge) {
                    bridge(command, pos);
                } else if (this.view.state.facet(EditorView.editable)) {
                    runTableCommand(this.view, command, pos);
                }
                // cell 只用于读位置；命令后不再引用，避免误用失效 DOM
                void cell;
            });
            this.view.dom.appendChild(button);
            this.button = button;
            return button;
        }

        /** 按当前 edge/targetPos 摆好按钮。 */
        private showButton(): void {
            if (!this.hoverCell || this.edge === null) return;
            const button = this.ensureButton();
            const cellRect = this.hoverCell.getBoundingClientRect();
            const hostRect = this.view.dom.getBoundingClientRect();
            const half = BUTTON_SIZE / 2;
            // 两条边都用格子的 rect 算：给格子加类后边框颜色变了，尺寸不变。
            // 按钮以「边框中点」为圆心摆放，所以两个方向都要退半个按钮。
            let left: number;
            let top: number;
            if (this.edge === 'col') {
                left = cellRect.right - hostRect.left - half;
                top = cellRect.top - hostRect.top + cellRect.height / 2 - half;
            } else {
                left = cellRect.left - hostRect.left + cellRect.width / 2 - half;
                top = cellRect.bottom - hostRect.top - half;
            }
            button.style.display = 'flex';
            button.style.left = `${left}px`;
            button.style.top = `${top}px`;
            button.textContent = '+';
            button.title = this.edge === 'col' ? '在右侧插入一列' : '在下方插入一行';
        }

        /** mousemove 主逻辑：找格子 → 判断贴哪条边 → 显示/隐藏。 */
        private handleMove(event: MouseEvent): void {
            const target = event.target as Element | null;
            const cell = target?.closest?.('.cm-md-tcell') as HTMLElement | null;
            if (!cell) {
                this.hide();
                return;
            }
            const rect = cell.getBoundingClientRect();
            const nearRight =
                cell.classList.contains(CELL_LAST_CLASS) &&
                event.clientX >= rect.right - EDGE_TOLERANCE &&
                event.clientX <= rect.right + EDGE_TOLERANCE &&
                event.clientY >= rect.top &&
                event.clientY <= rect.bottom;
            const row = cell.closest('.cm-line');
            const nearBottom =
                !!row?.classList.contains(ROW_LAST_CLASS) &&
                event.clientY >= rect.bottom - EDGE_TOLERANCE &&
                event.clientY <= rect.bottom + EDGE_TOLERANCE &&
                event.clientX >= rect.left &&
                event.clientX <= rect.right;

            // 两条边都贴（右下角）时选更近的那条
            let kind: EdgeKind | null = null;
            if (nearRight && nearBottom) {
                const dRight = Math.abs(event.clientX - rect.right);
                const dBottom = Math.abs(event.clientY - rect.bottom);
                kind = dRight <= dBottom ? 'col' : 'row';
            } else if (nearRight) {
                kind = 'col';
            } else if (nearBottom) {
                kind = 'row';
            }
            if (!kind) {
                this.hide();
                return;
            }
            // 只读且没有桥（viewer 模式 / 纯只读编辑器）：按钮点了也改不了文档，
            // 干脆不出现，免得用户以为坏了。
            const canEdit =
                !!this.view.state.facet(tableEditBridge)[0] ||
                this.view.state.facet(EditorView.editable);
            if (!canEdit) {
                this.hide();
                return;
            }
            // posAtDOM 拿格子起点的文档位置（这个位置上一定在表格块内）
            let pos = -1;
            try {
                pos = this.view.posAtDOM(cell, 0);
            } catch {
                pos = -1;
            }
            if (pos < 0) {
                this.hide();
                return;
            }
            this.setEdge(cell, kind, pos);
        }
    }
);
