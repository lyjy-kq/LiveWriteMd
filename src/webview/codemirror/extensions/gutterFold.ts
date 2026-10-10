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
import { foldedLines, foldToggleEffect } from './livePreview/state';

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
    const blocks = view.viewportLineBlocks;
    cells.forEach((cell, i) => {
        const block = blocks[i];
        if (!block) return;
        const foldable = linePosIsFoldable(view, block.from);
        const folded = foldedLines.has(block.from);
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

/** 点击箭头切换折叠（gutter 上的事件委托）。 */
function onGutterMouseDown(view: EditorView, event: MouseEvent): void {
    const arrow = (event.target as HTMLElement | null)?.closest(
        '.cm-md-gutter-fold'
    );
    if (!arrow) return;
    // 用箭头所在行号格反查文档行（data 记录行首）
    const cell = arrow.closest('.cm-gutterElement') as HTMLElement;
    const idx = Array.from(
        cell.parentElement?.querySelectorAll('.cm-gutterElement') ?? []
    ).filter((el) => (el as HTMLElement).style.visibility !== 'hidden').indexOf(cell);
    const block = view.viewportLineBlocks[idx];
    if (!block) return;
    event.preventDefault();
    event.stopPropagation();
    if (foldedLines.has(block.from)) {
        foldedLines.delete(block.from);
    } else {
        foldedLines.add(block.from);
    }
    // 必须带 foldToggleEffect：block StateField 靠它感知折叠集变化、重算子行隐藏
    view.dispatch({ effects: foldToggleEffect.of(null) });
}

export const gutterFold = ViewPlugin.fromClass(
    class {
        constructor(view: EditorView) {
            view.dom
                .querySelector('.cm-lineNumbers')
                ?.addEventListener('mousedown', (e) =>
                    onGutterMouseDown(view, e as MouseEvent)
                );
            syncGutter(view);
        }
        update(update: ViewUpdate): void {
            syncGutter(update.view);
        }
    }
);

/** 供需要时作为 Extension 数组元素引用。 */
export function gutterFoldExtension(): Extension {
    return gutterFold;
}
