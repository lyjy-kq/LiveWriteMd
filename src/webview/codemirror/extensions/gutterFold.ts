/**
 * Gutter Fold —— 折叠箭头统一放在「行号」位置。
 *
 * CodeMirror 的 lineNumbers 不支持「悬停时把数字换成另一个 widget」：
 * lineNumberMarkers facet 提供的 marker 会**替换**数字（`NumberMarker` 见自定义
 * marker 就让位），做不到「平时显示数字、悬停才变箭头」。
 *
 * 因此这里用一个 ViewPlugin 直接维护 gutter DOM：
 *
 * - 可见的行号格（`.cm-gutterElement`，排除 CM 的宽度 spacer）与
 *   `viewportLineBlocks` 里的文本块按顺序一一对应；
 * - 该行可折叠（含子列表的列表项 / 含章节内容的标题）时，给行号格
 *   挂 `cm-md-foldable-line` 类并注入一个绝对定位的箭头元素（覆盖数字）；
 * - 平时数字照常显示、箭头透明；悬停该格 → 数字淡出、箭头淡入（纯 CSS）；
 * - 折叠态 → 行号格加 `is-folded`，箭头常驻、旋转朝右。
 *
 * 正文内容完全不受影响：点行内容照常进入文本模式（看到 `-` / `#`）。
 */

import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { foldedLinesOf, foldToggleEffect } from './livePreview/state';

/** 标题章节结束位置（与 livePreview/plugin.ts 的 headingSectionEnd 同逻辑）。 */
function headingSectionEnd(heading: SyntaxNode): number {
    const level = Number(heading.name.slice('ATXHeading'.length));
    const parent = heading.parent;
    if (!parent) return heading.to;
    let cur = heading.nextSibling;
    while (cur) {
        const nm = cur.name ?? '';
        let bLevel = 0;
        if (nm.startsWith('ATXHeading')) {
            bLevel = Number(nm.slice('ATXHeading'.length));
        } else if (nm === 'SetextHeading1') {
            bLevel = 1;
        } else if (nm === 'SetextHeading2') {
            bLevel = 2;
        }
        if (bLevel !== 0 && bLevel <= level) return cur.from;
        cur = cur.nextSibling;
    }
    return parent.to;
}

/**
 * 判断某文档行是否「可折叠」。
 *
 * 不能用行首 (line.from) 做 resolveInner —— 嵌套列表行的行首是缩进
 * 空白，该位置在**父级** ListItem 范围内，会拿到祖先节点。正确做法是
 * 在该行范围内找**最深的** ListMark / HeaderMark，用它的直接父节点
 * （即本行真正的 ListItem / ATXHeading）判定。
 */
function linePosIsFoldable(view: EditorView, lineFrom: number): boolean {
    const line = view.state.doc.lineAt(lineFrom);
    const tree = syntaxTree(view.state);
    // 用对象容器持有结果：let 变量在闭包内赋值会被 TS 控制流窄化成 never
    const found: { node: SyntaxNode | null; from: number } = {
        node: null,
        from: -1,
    };
    tree.iterate({
        from: line.from,
        to: line.to + 1,
        enter(n) {
            if (
                (n.name === 'ListMark' || n.name === 'HeaderMark') &&
                n.from > found.from
            ) {
                // 缩进越深的 marker，from 越大；取它即本行自己的 marker
                found.from = n.from;
                found.node = n.node;
            }
        },
    });
    const block = found.node?.parent ?? null;
    if (!block) return false;
    if (block.name === 'ListItem') {
        return !!(block.getChild('BulletList') || block.getChild('OrderedList'));
    }
    if (block.name.startsWith('ATXHeading')) {
        return line.to < headingSectionEnd(block);
    }
    return false;
}

/** 取得（没有则创建）行号格里的箭头元素。 */
function ensureArrow(cell: HTMLElement): HTMLElement {
    let arrow = cell.querySelector<HTMLElement>('.cm-md-gutter-fold');
    if (arrow) return arrow;
    arrow = document.createElement('span');
    arrow.className = 'cm-md-gutter-fold';
    arrow.innerHTML =
        '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">' +
        '<polyline points="3,4.5 6,7.5 9,4.5" fill="none" stroke="currentColor" ' +
        'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    cell.appendChild(arrow);
    return arrow;
}

/** 同步一次 gutter：为可折叠行挂箭头、更新折叠态、清理多余箭头。 */
function syncGutter(view: EditorView): void {
    const gutter = view.dom.querySelector('.cm-lineNumbers');
    if (!gutter) return;
    // 排除 CM 的宽度 spacer（它带 inline visibility:hidden）
    const allCells = Array.from(
        gutter.querySelectorAll<HTMLElement>('.cm-gutterElement')
    );
    const cells = allCells.filter((el) => el.style.visibility !== 'hidden');
    // 关键：viewportLineBlocks 里混着「块级 widget 占位块」（折叠后章节替换
    // 产生的 BlockInfo，type === BlockType.WidgetRange = 3），但 lineNumbers
    // 不会给 widget 渲染行号格。必须只保留真实文本行 (type === 0)，否则一旦
    // 已有折叠，cells 与 blocks 数量错位、索引整体后移 —— 连续折叠第二个时
    // 拿到的行首偏 1，foldedLines 存入错误位置，折叠静默失效。
    const lineBlocks = view.viewportLineBlocks.filter((b) => b.type === 0);
    cells.forEach((cell, i) => {
        const block = lineBlocks[i];
        if (!block) return;
        // 行首直接记在 cell 上：点击时读取，彻底不依赖索引对齐
        cell.dataset.foldPos = String(block.from);
        const foldable = linePosIsFoldable(view, block.from);
        const folded = foldedLinesOf(view.state).has(block.from);
        if (foldable) {
            cell.classList.add('cm-md-foldable-line');
            cell.classList.toggle('is-folded', folded);
            ensureArrow(cell);
        } else {
            cell.classList.remove('cm-md-foldable-line', 'is-folded');
            cell.querySelector('.cm-md-gutter-fold')?.remove();
        }
    });
}

/** 若事件点中的是折叠箭头，返回它所在的行号格，否则 null。 */
function arrowCellFromEvent(event: Event): HTMLElement | null {
    const arrow = (event.target as HTMLElement | null)?.closest(
        '.cm-md-gutter-fold'
    );
    if (!arrow) return null;
    return arrow.closest('.cm-gutterElement') as HTMLElement;
}

/**
 * mousedown：**只拦截默认行为**，不切换折叠。
 *
 * 必须 preventDefault / stopPropagation：
 * - 阻止 CodeMirror 把这次 mousedown 当「设置选区」处理（点行号不应移光标）；
 * - 阻止编辑器因点到不可编辑的 gutter 而失焦。
 *
 * 不能在这里切换状态 + dispatch：CodeMirror 在 mousedown 事件处理中途会把
 * dispatch 的 DOM 更新（measure + 应用装饰）推迟到 mouseup，表现为「点完
 * 不刷新，要再动焦点才更新」。真正的切换放到 onArrowClick。
 */
function onArrowMouseDown(view: EditorView, event: MouseEvent): void {
    void view;
    if (!arrowCellFromEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
}

/**
 * click：真正切换折叠并立即重建。
 *
 * click 在 mousedown + mouseup 之后触发，已离开 CodeMirror 的 mousedown
 * 抑制窗口，这次 dispatch 会同步完成 measure 与 DOM 更新，外观立刻刷新。
 */
function onArrowClick(view: EditorView, event: MouseEvent): void {
    const cell = arrowCellFromEvent(event);
    if (!cell) return;
    // 行首直接读 cell 上的记录（syncGutter 写入），不靠 cells/blocks 索引对齐
    const lineFrom = Number(cell.dataset.foldPos);
    if (!Number.isInteger(lineFrom)) return;
    event.preventDefault();
    event.stopPropagation();
    // 折叠集合按编辑器实例隔离（任务 4）：主编辑器与导图 mini-CM 各自一份
    const foldedSet = foldedLinesOf(view.state);
    if (foldedSet.has(lineFrom)) {
        foldedSet.delete(lineFrom);
    } else {
        foldedSet.add(lineFrom);
    }
    // 必须带 foldToggleEffect：block StateField 靠它感知折叠集变化、重算子行隐藏
    view.dispatch({ effects: foldToggleEffect.of(null) });
}

export const gutterFold = ViewPlugin.fromClass(
    class {
        /** 当前挂上监听器的行号 gutter 元素。 */
        private gutterEl: Element | null = null;

        /**
         * 为什么必须持有这个稳定引用（2026-10-10 修复）：
         *
         * 本插件在 editor.ts 里放在 **Compartment** 中，INIT 后 applySettings
         * 会 reconfigure 一次 `[lineNumbers(), gutterFold]`。reconfigure 时
         * CodeMirror 会**重建 `.cm-lineNumbers` DOM 元素**，但同一个插件对象
         * 对应的插件实例被保留、构造函数不再执行 —— 旧监听器就此挂在已经
         * 脱离文档的旧 gutter 上：箭头照常被 syncGutter 画出来，点击却完全
         * 没反应。因此每次 update 都要比对 gutter 元素身份，元素一换就把
         * 监听器迁移过去。
         */
        // 两个稳定监听引用：mousedown 只拦截默认行为，click 才切换折叠。
        // 必须是箭头函数以绑定 this；迁移 / 销毁时靠同一引用才能摘除。
        private readonly onMouseDown = (e: Event): void =>
            onArrowMouseDown(this.view, e as MouseEvent);
        private readonly onClick = (e: Event): void =>
            onArrowClick(this.view, e as MouseEvent);

        constructor(private readonly view: EditorView) {
            this.attachGutter();
            syncGutter(view);
        }

        /** 把监听器挂到当前的 .cm-lineNumbers 上；元素变了就整体迁移。 */
        private attachGutter(): void {
            const gutter = this.view.dom.querySelector('.cm-lineNumbers');
            if (gutter === this.gutterEl) return;
            // 先从旧元素摘除两个监听，避免残留在脱离文档的节点上
            this.gutterEl?.removeEventListener('mousedown', this.onMouseDown);
            this.gutterEl?.removeEventListener('click', this.onClick);
            this.gutterEl = gutter;
            gutter?.addEventListener('mousedown', this.onMouseDown);
            gutter?.addEventListener('click', this.onClick);
        }

        update(update: ViewUpdate): void {
            // 必须在 syncGutter 之前迁移监听：reconfigure 当次更新就会换元素
            this.attachGutter();
            syncGutter(update.view);
        }

        /** 插件被移除（关掉行号 / 视图销毁）时清理两个监听。 */
        destroy(): void {
            this.gutterEl?.removeEventListener('mousedown', this.onMouseDown);
            this.gutterEl?.removeEventListener('click', this.onClick);
            this.gutterEl = null;
        }
    }
);

/** 供需要时作为 Extension 数组元素引用。 */
export function gutterFoldExtension(): Extension {
    return gutterFold;
}
