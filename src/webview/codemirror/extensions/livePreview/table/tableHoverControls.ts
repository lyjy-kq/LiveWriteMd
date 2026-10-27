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
import { CELL_LAST_CLASS, DELIMITER_CLASS, ROW_CLASS, ROW_LAST_CLASS } from './tableTypes.js';
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
        /**
         * 当前高亮的整条边界：悬停右边框时是**每一行**的最后一列格子，
         * 悬停下边框时是**最后一行**的全部格子。
         *
         * 线要沿整张表格画满，不能只亮鼠标下那一格 —— 用户加的是一整列/一整行，
         * 提示就应该是一条贯穿表格边界的线。
         */
        private hoverCells: HTMLElement[] = [];
        /** 当前悬停的边（null = 没贴边）。 */
        private edge: EdgeKind | null = null;
        /**
         * 边界中点叠「+」的格子。
         *
         * 注意不是鼠标下那一格：加号固定落在**整条边界**的中点，
         * 鼠标沿边界移动时它不会跟着跑。偏移量通过 CSS 变量
         * `--lwm-edge-shift` 从格子中心修正到真正的边界中点。
         */
        private plusCell: HTMLElement | null = null;
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
            this.hoverCells = [];
            this.plusCell = null;
            this.edge = null;
        }

        /** 移除整条蓝色边 + 「+」提示。 */
        private clearHighlight(): void {
            // 加号的位置修正是内联 CSS 变量，换格子/收起时都要清干净，
            // 否则同一格下次被复用时还带着上一次的偏移
            this.plusCell?.style.removeProperty('--lwm-edge-shift');
            for (const cell of this.hoverCells) {
                cell.classList.remove(
                    'cm-md-tcell-edge-col',
                    'cm-md-tcell-edge-row',
                    'cm-md-tcell-edge-plus'
                );
            }
            this.hoverCells = [];
            this.plusCell = null;
            this.edge = null;
        }

        /**
         * 把「+」放到整条边界的正中间。
         *
         * - col：纵向范围取「第一行最后一格的顶边 → 最后一行最后一格的底边」；
         * - row：横向范围取「该行第一格的左边 → 最后一格的右边」。
         *
         * 中点多半落在中间某个格子里。给该格加 -plus 类后，`::after`
         * 默认定位在这个格子的 50% 处，再用 --lwm-edge-shift 把它平移到
         * 真正的边界中点 —— 否则格子高度不均时加号会偏半格。
         *
         * @param cells - 整条边界涉及的格子（col：上→下；row：左→右）
         * @param kind - 边的方向
         */
        private placePlus(cells: HTMLElement[], kind: EdgeKind): void {
            if (cells.length === 0) return;
            const rects = cells.map((cell) => cell.getBoundingClientRect());
            // 边界在屏幕上的起止：col 看 y，row 看 x。
            // 数组顺序就是沿边界的顺序，首尾各取一端即可
            const edgeStart = kind === 'col' ? rects[0].top : rects[0].left;
            const edgeEnd =
                kind === 'col' ? rects[rects.length - 1].bottom : rects[rects.length - 1].right;
            const mid = (edgeStart + edgeEnd) / 2;

            // 找包含中点的格子；中点正好落在两格之间的间隙（管道线）时取最近的
            let target = cells[0];
            let targetRect = rects[0];
            let best = Infinity;
            for (let i = 0; i < cells.length; i++) {
                const rect = rects[i];
                const lo = kind === 'col' ? rect.top : rect.left;
                const hi = kind === 'col' ? rect.bottom : rect.right;
                const distance = mid < lo ? lo - mid : mid > hi ? mid - hi : 0;
                if (distance < best) {
                    best = distance;
                    target = cells[i];
                    targetRect = rect;
                }
            }

            // 屏幕坐标差 → 局部 CSS 像素差。导图节点的 mini-CM 外面套着
            // transform: scale()，rect 是缩放后的屏幕像素，除以缩放比才能
            // 直接写进 CSS（否则缩放越大偏移越大）。
            const localSize = kind === 'col' ? target.offsetHeight : target.offsetWidth;
            const screenSize = kind === 'col' ? targetRect.height : targetRect.width;
            const scale = localSize > 0 ? screenSize / localSize : 1;
            const center =
                kind === 'col'
                    ? (targetRect.top + targetRect.bottom) / 2
                    : (targetRect.left + targetRect.right) / 2;
            const shift = scale > 0 ? (mid - center) / scale : 0;

            target.classList.add('cm-md-tcell-edge-plus');
            target.style.setProperty('--lwm-edge-shift', `${shift.toFixed(2)}px`);
            this.plusCell = target;
        }

        /**
         * 取悬停格子所在的整张表的所有行（连续的 `.cm-md-table-row` 兄弟行）。
         *
         * 表格在 live preview 里是「一行一个 .cm-line」，同一张表的行是连续的
         * 兄弟节点；用连续兄弟判定不会把下面另一张表的行也带进来。
         */
        private tableRowsOf(cell: HTMLElement): HTMLElement[] {
            // 分隔行（`|---|---|`）夹在表头行和数据行之间，class 不是
            // cm-md-table-row，但它是同一张表的一部分：遍历必须跨过它，
            // 否则表头行会被漏掉，右边框只画到一半。
            const isTableLine = (el: Element | null): el is HTMLElement =>
                !!el &&
                (el.classList.contains(ROW_CLASS) ||
                    el.classList.contains(DELIMITER_CLASS));
            let first = cell.closest('.cm-line') as HTMLElement | null;
            if (!first || !isTableLine(first)) return [];
            while (isTableLine(first.previousElementSibling)) {
                first = first.previousElementSibling as HTMLElement;
            }
            const rows: HTMLElement[] = [];
            let current: HTMLElement | null = first;
            while (isTableLine(current)) {
                rows.push(current);
                current = current.nextElementSibling as HTMLElement | null;
            }
            return rows;
        }

        /**
         * 把一条边铺满整张表：返回需要加线类的格子。
         *
         * - col：每一行的最后一列格子；
         * - row：最后一行（悬停行）的全部格子。
         */
        private boundaryCells(hit: EdgeHit): HTMLElement[] {
            const rows = this.tableRowsOf(hit.cell);
            if (rows.length === 0) return [hit.cell];
            if (hit.kind === 'row') {
                const row = hit.cell.closest('.cm-line');
                return row
                    ? Array.from(
                          row.querySelectorAll<HTMLElement>('.cm-md-tcell')
                      )
                    : [hit.cell];
            }
            const cells: HTMLElement[] = [];
            for (const row of rows) {
                const last = Array.from(
                    row.querySelectorAll<HTMLElement>('.cm-md-tcell')
                ).find((cell) => cell.classList.contains(CELL_LAST_CLASS));
                if (last) cells.push(last);
            }
            return cells.length > 0 ? cells : [hit.cell];
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

        /** mousemove 主逻辑：贴边就高亮整条边界，离开就清掉。 */
        private handleMove(event: MouseEvent): void {
            const hit = this.resolveEdge(event);
            if (!hit) {
                this.hide();
                return;
            }
            // 同一条边的高亮与加号位置固定（不随指针移动），无需重复铺类
            if (this.edge === hit.kind) return;
            this.clearHighlight();
            const cells = this.boundaryCells(hit);
            const lineClass =
                hit.kind === 'col' ? 'cm-md-tcell-edge-col' : 'cm-md-tcell-edge-row';
            for (const cell of cells) {
                cell.classList.add(lineClass);
            }
            // 加号固定在整条边界的中点，不跟鼠标跑
            this.placePlus(cells, hit.kind);
            this.hoverCells = cells;
            this.edge = hit.kind;
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
