/**
 * 表格边缘的「点线加行/列」。
 *
 * 表格在 live preview 里不是 widget，而是**行/格装饰**（见 tableRender.ts），
 * 所以这里不能像图片那样把按钮塞进 widget，只能：
 *
 * 1. 在 contentDOM 上听 mousemove，用 `closest('.cm-md-tcell')` 找到鼠标下的
 *    格子（不用 posAtCoords —— 导图节点里 CM 的高度缓存常常是旧的，
 *    posAtCoords 会算错行）；
 * 2. 判断指针是否贴在这格的右边框（最后一列）或下边框（最后一行）：
 *    贴边时给格子加类，CSS 把那条边画蓝并叠一个「+」提示；
 * 3. **直接在这条线上按下鼠标**就加行/列（mousedown 捕获阶段处理，
 *    抢在 CodeMirror 放置光标之前）。
 *
 * 为什么不再用浮动按钮：按钮要拿 `getBoundingClientRect()` 算位置，
 * 导图节点的 mini-CM 外面套着 world(translate)+scaler(scale) 两层变换，
 * rect 是**屏幕坐标**而 CSS `left/top` 是**节点局部坐标**，两者差一个缩放，
 * 按钮就会随缩放比例乱飞。点线本身不需要任何坐标换算，全交给浏览器命中测试。
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

/** 贴边判定距离（px）：指针进入这条带子就算「悬停在边框上」。 */
const EDGE_TOLERANCE = 5;

/** 当前悬停的边类型。 */
type EdgeKind = 'col' | 'row';

/** 一次命中的结果。 */
interface EdgeHit {
    /** 命中的格子（悬停右边框时是最后一列格子，下边框时是最后一行格子）。 */
    cell: HTMLElement;
    /** 哪条边。 */
    kind: EdgeKind;
    /** 插入位置对应的文档位置。 */
    pos: number;
}

/**
 * 创建表格边缘加行/加列的插件。
 *
 * 每个 EditorView 一份：hover 类、rAF 句柄都是实例私有的，
 * 多个节点同时显示时互不干扰。
 */
export const tableHoverControls = ViewPlugin.fromClass(
    class {
        /** 当前高亮的格子（悬停右边框时是最后一列格子，下边框时是最后一行格子）。 */
        private hoverCell: HTMLElement | null = null;
        /** 当前悬停的边（null = 没贴边）。 */
        private edge: EdgeKind | null = null;
        /** 最近一次 mousemove 的坐标：一帧只处理一次，避免每 move 都量 DOM。 */
        private lastEvent: MouseEvent | null = null;
        /** 已排队的 rAF。 */
        private frame: number | null = null;
        /**
         * pointerdown 已经处理过这次按压 → 紧随其后的 mousedown 要吞掉。
         *
         * 导图画布在 canvasEl 上听的是 **pointerdown**（冒泡阶段），
         * 而 CodeMirror 和选字逻辑吃的是 **mousedown** —— 两个事件都得拦：
         * 只拦 mousedown 的话，画布仍会把「点线」当成单击节点（第二次点
         * 还会进编辑态）。
         */
        private swallowMouseDown = false;
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
            // 滚动时表格位置变了，旧的高亮/命中结果不再可信：直接收起
            const onScroll = (): void => this.hide();
            // 捕获阶段 + pointerdown：抢在画布的节点单击/拖动判断之前
            const onPointerDown = (event: PointerEvent): void => this.handlePointerDown(event);
            // 捕获阶段 + mousedown：抢在 CodeMirror 放置光标/开始拖选之前
            const onMouseDown = (event: MouseEvent): void => {
                if (!this.swallowMouseDown) return;
                this.swallowMouseDown = false;
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
            };
            content.addEventListener('mousemove', onMove);
            content.addEventListener('mouseleave', onLeave);
            content.addEventListener('pointerdown', onPointerDown, true);
            content.addEventListener('mousedown', onMouseDown, true);
            view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
            this.cleanup.push(() => {
                content.removeEventListener('mousemove', onMove);
                content.removeEventListener('mouseleave', onLeave);
                content.removeEventListener('pointerdown', onPointerDown, true);
                content.removeEventListener('mousedown', onMouseDown, true);
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
            this.hoverCell = null;
            this.edge = null;
        }

        /** 移除蓝色边 + 「+」提示。 */
        private clearHighlight(): void {
            if (!this.hoverCell) return;
            this.hoverCell.classList.remove(
                'cm-md-tcell-edge-col',
                'cm-md-tcell-edge-row'
            );
            this.hoverCell = null;
            this.edge = null;
        }

        /** 清掉高亮。 */
        private hide(): void {
            this.clearHighlight();
        }

        /**
         * 命中检测：指针是不是贴在某格的右边框/下边框上。
         *
         * 返回 null 表示没贴边。纯几何判断，鼠标移动和按下共用一套规则。
         *
         * @param event - 鼠标事件
         * @returns 命中信息（格子 / 边 / 文档位置）
         */
        private resolveEdge(event: MouseEvent): EdgeHit | null {
            const target = event.target as Element | null;
            // 只认格子本身：贴边带在格子 border-box 内侧，指针不会跑出格子
            const cell = target?.closest?.('.cm-md-tcell') as HTMLElement | null;
            if (!cell) return null;

            const rect = cell.getBoundingClientRect();
            const nearRight =
                cell.classList.contains(CELL_LAST_CLASS) &&
                event.clientX >= rect.right - EDGE_TOLERANCE &&
                event.clientX <= rect.right + EDGE_TOLERANCE &&
                event.clientY >= rect.top &&
                event.clientY <= rect.bottom;
            const row = cell.closest('.cm-line');
            // 下边框用格子的底边判断：最后一行的每个格子都贴边
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
            if (!kind) return null;

            // 只读且没有桥（viewer 模式 / 纯只读编辑器）：点了也改不了文档，
            // 干脆不高亮，免得用户以为坏了。
            if (!this.canEdit()) return null;

            // posAtDOM 拿格子起点的文档位置（这个位置上一定在表格块内）
            let pos = -1;
            try {
                pos = this.view.posAtDOM(cell, 0);
            } catch {
                pos = -1;
            }
            if (pos < 0) return null;

            return { cell, kind, pos };
        }

        /** 当前视图能不能执行表格命令（主编辑器可编辑 / 导图显示态有桥）。 */
        private canEdit(): boolean {
            return (
                !!this.view.state.facet(tableEditBridge)[0] ||
                this.view.state.facet(EditorView.editable)
            );
        }

        /** mousemove 主逻辑：贴边就高亮那条线，离开就清掉。 */
        private handleMove(event: MouseEvent): void {
            const hit = this.resolveEdge(event);
            if (!hit) {
                this.hide();
                return;
            }
            if (this.hoverCell !== hit.cell || this.edge !== hit.kind) {
                this.clearHighlight();
                hit.cell.classList.add(
                    hit.kind === 'col' ? 'cm-md-tcell-edge-col' : 'cm-md-tcell-edge-row'
                );
                this.hoverCell = hit.cell;
                this.edge = hit.kind;
            }
        }

        /**
         * pointerdown：正好按在线上 → 直接加行/列。
         *
         * 用 pointerdown 而不是 mousedown，是为了先于导图画布的
         * 「单击选中 / 开始拖动」判断拿到事件（画布听的就是 pointerdown）。
         *
         * @param event - pointerdown 事件
         */
        private handlePointerDown(event: PointerEvent): void {
            if (event.button !== 0) return;
            const hit = this.resolveEdge(event);
            if (!hit) return;

            // 不放置光标、不开始拖选，也不让事件继续传给画布/CM
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            // 鼠标还会再补一个 mousedown（CM 的选字靠它），标记一下吞掉；
            // 触摸端 preventDefault 后可能没有 mousedown，用 0ms 定时器清标记
            this.swallowMouseDown = true;
            window.setTimeout(() => {
                this.swallowMouseDown = false;
            }, 0);

            const command: TableCommand = hit.kind === 'row' ? 'row-below' : 'col-right';
            // 命令会重排整张表，旧格子立即失效；先收起 UI 再改文档
            this.hide();
            // 主编辑器没有桥，且本来就 editable；导图节点由桥临时放开
            const bridge = this.view.state.facet(tableEditBridge)[0];
            if (bridge) {
                bridge(command, hit.pos);
            } else if (this.view.state.facet(EditorView.editable)) {
                runTableCommand(this.view, command, hit.pos);
            }
        }
    }
);
