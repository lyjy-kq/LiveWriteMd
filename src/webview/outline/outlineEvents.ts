/**
 * 大纲面板：事件装配（从 outlinePanel.ts 拆出）。
 *
 * bindEvents 一个方法独占：拖拽调宽、点击折叠/跳转、hover 提示的
 * 事件监听全在这里登记。
 *
 * @module webview/outline/outlineEvents
 */

import type { OutlinePanel } from './outlinePanel.js';

/**
 * 缁戝畾鎷栨嫿銆佹姌鍙犮€佸睍寮€銆佽烦杞拰鎮诞鎻愮ず鐩稿叧浜嬩欢銆?     *
 * @returns void
 */
export function bindEvents(panel: OutlinePanel): void {
    panel.resizerEl.addEventListener('pointerdown', panel.handleResizerPointerDown);
    panel.contentEl.addEventListener('click', panel.handleContentClick);
    panel.contentEl.addEventListener('keydown', panel.handleContentKeyDown);
    panel.contentEl.addEventListener('pointerover', panel.handleContentPointerOver);
    panel.contentEl.addEventListener('pointerout', panel.handleContentPointerOut);
    panel.contentEl.addEventListener('scroll', panel.handleContentScroll, { passive: true });
    panel.actionBarEl.addEventListener('click', panel.handleActionBarClick);
}

/**
 * 澶勭悊鍒嗛殧鏉℃寜涓嬩簨浠跺苟鍚姩鎷栨嫿銆?     *
 * @param event - 鎸囬拡鎸変笅浜嬩欢
 * @returns void
 */
private readonly handleResizerPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
        return;
    }

    event.preventDefault();
    panel.dragging = true;
    panel.dragStartX = event.clientX;
    panel.dragStartWidth = panel.width;
    panel.resizerEl.dataset.dragging = 'true';
    document.body.classList.add('livewritemd-outline-resizing');

    const onMove = (moveEvent: PointerEvent): void => {
        if (!panel.dragging) {
            return;
        }

        const delta = moveEvent.clientX - panel.dragStartX;
        // 右侧面板宽度越大，分割线越靠左，所以拖拽方向需要反向计算。
        panel.applyWidth(panel.dragStartWidth - delta);
    };

    const onUp = (upEvent: PointerEvent): void => {
        if (!panel.dragging) {
            return;
        }

        panel.dragging = false;
        panel.resizerEl.dataset.dragging = 'false';
        document.body.classList.remove('livewritemd-outline-resizing');
        panel.resizerEl.releasePointerCapture(upEvent.pointerId);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        panel.onWidthChange(panel.width);
    };

    panel.resizerEl.setPointerCapture(event.pointerId);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
};

/**
 * 澶勭悊鍐呭鍖虹偣鍑讳簨浠讹紝鏀寔璺宠浆涓庤妭鐐规姌鍙犮€?     *
 * @param event - 榧犳爣鐐瑰嚮浜嬩欢
 * @returns void
 */
private readonly handleContentClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    if (!target) {
        return;
    }

    const toggleEl = target.closest<HTMLElement>('[data-outline-action="toggle"]');
    if (toggleEl) {
        event.preventDefault();
        event.stopPropagation();
        const nodeId = toggleEl.getAttribute('data-node-id');
        if (nodeId) {
            if (panel.collapsedNodeIds.has(nodeId)) {
                panel.collapsedNodeIds.delete(nodeId);
            } else {
                panel.collapsedNodeIds.add(nodeId);
            }
            panel.render();
        }
        return;
    }

    const rowEl = target.closest<HTMLElement>('[data-outline-action="jump"]');
    if (!rowEl) {
        return;
    }

    const lineValue = rowEl.getAttribute('data-line');
    const lineNumber = Number.parseInt(lineValue ?? '', 10);
    if (Number.isFinite(lineNumber)) {
        panel.onNavigateToLine(lineNumber);
    }
};

/**
 * 澶勭悊鍐呭鍖洪敭鐩樹簨浠讹紝鏀寔鍥炶溅鍜岀┖鏍艰烦杞€?     *
 * @param event - 閿洏浜嬩欢
 * @returns void
 */
private readonly handleContentKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (!target) {
        return;
    }

    const rowEl = target.closest<HTMLElement>('[data-outline-action="jump"]');
    if (!rowEl) {
        return;
    }

    if (event.key !== 'Enter' && event.key !== ' ') {
        return;
    }

    event.preventDefault();
    const lineValue = rowEl.getAttribute('data-line');
    const lineNumber = Number.parseInt(lineValue ?? '', 10);
    if (Number.isFinite(lineNumber)) {
        panel.onNavigateToLine(lineNumber);
    }
};

/**
 * 澶勭悊鍐呭鍖烘偓娴繘鍏ヤ簨浠跺苟鍚姩 1 绉掓彁绀哄欢杩熴€?     *
 * @param event - 鎸囬拡鎮诞浜嬩欢
 * @returns void
 */
private readonly handleContentPointerOver = (event: PointerEvent): void => {
    const target = event.target as HTMLElement | null;
    if (!target) {
        return;
    }

    const rowEl = target.closest<HTMLElement>('[data-outline-action="jump"]');
    if (!rowEl || rowEl === panel.hoveredRowEl) {
        return;
    }

    panel.hoveredClientX = event.clientX;
    panel.hoveredClientY = event.clientY;
    panel.scheduleTooltip(rowEl, event.clientX, event.clientY);
};

/**
 * 澶勭悊鍐呭鍖烘偓娴寮€浜嬩欢锛岀寮€鍚庣珛鍗抽殣钘忔彁绀恒€?     *
 * @param event - 鎸囬拡绂诲紑浜嬩欢
 * @returns void
 */
private readonly handleContentPointerOut = (event: PointerEvent): void => {
    const target = event.target as HTMLElement | null;
    if (!target) {
        return;
    }

    const rowEl = target.closest<HTMLElement>('[data-outline-action="jump"]');
    const relatedTarget = event.relatedTarget as Node | null;
    if (rowEl && relatedTarget && rowEl.contains(relatedTarget)) {
        return;
    }

    if (rowEl && rowEl === panel.hoveredRowEl) {
        panel.hideTooltip();
    }
};

/**
 * 澶勭悊鍐呭鍖烘粴鍔ㄤ簨浠讹紝閬垮厤鎻愮ず璺熺潃鏃т綅缃仠鐣欍€?     *
 * @returns void
 */
private readonly handleContentScroll = (): void => {
    if (panel.hoveredRowEl) {
        panel.hideTooltip();
    }
};

/**
 * 澶勭悊搴曢儴鎿嶄綔鏍忕偣鍑讳簨浠躲€?     *
 * @param event - 榧犳爣鐐瑰嚮浜嬩欢
 * @returns void
 */
private readonly handleActionBarClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    if (!target) {
        return;
    }

    const actionButton = target.closest<HTMLButtonElement>('[data-outline-action]');
    if (!actionButton) {
        return;
    }

    const action = actionButton.getAttribute('data-outline-action');

    // 标题编号 / 取消编号：取编辑器实时全文算修改，再交 main.ts 写回。
    // 必须用实时文档：面板缓存有 250ms 防抖，用户刚打完字就点会错位。
    if (action === 'add-numbering' || action === 'remove-numbering') {
        // 按钮 disabled 之外再兜底一次：只读模式直接不处理
        if (!panel.isEditable()) return;
        const doc = panel.getDocument();
        const edits =
            action === 'add-numbering'
                ? buildHeadingNumberingEdits(doc)
                : buildHeadingUnnumberEdits(doc);
        if (edits.length > 0) {
            panel.onApplyHeadingEdits(edits);
        }
        return;
    }
    if (action === 'expand-all') {
        panel.expandAll();
    } else if (action === 'collapse-all') {
        panel.collapseAll();
    }
};
