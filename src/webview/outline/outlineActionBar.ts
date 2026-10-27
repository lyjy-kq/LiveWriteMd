/**
 * 大纲面板：底部操作栏与悬浮提示（从 outlinePanel.ts 拆出）。
 *
 * 编号操作栏（编号/去编号按钮）+ 标题 hover tooltip。
 * 同 outlineRender：原类方法把 this 换成 panel。
 *
 * @module webview/outline/outlineActionBar
 */

import type { OutlinePanel } from './outlinePanel.js';

/**
 * 瑙ｆ瀽鎴栧垱寤哄簳閮ㄦ搷浣滄爮瀹瑰櫒銆?     *
 * @returns 搴曢儴鎿嶄綔鏍忓厓绱?     */
export function resolveActionBarElement(panel: OutlinePanel): HTMLElement {
    const existing = panel.panelEl.querySelector<HTMLElement>('#outline-actions');
    if (existing) {
        return existing;
    }

    const actionBar = document.createElement('div');
    actionBar.id = 'outline-actions';
    actionBar.className = 'outline-actions';
    panel.panelEl.appendChild(actionBar);
    return actionBar;
}

/**
 * 瑙ｆ瀽鎴栧垱寤烘搷浣滄寜閽€?     *
 * @param action - 鎸夐挳鍔ㄤ綔鏍囪瘑
 * @param label - 鎸夐挳鏂囨湰
 * @returns 鎿嶄綔鎸夐挳鍏冪礌
 */
export function resolveActionButton(panel: OutlinePanel, action: string, label: string): HTMLButtonElement {
    const existing = panel.panelEl.querySelector<HTMLButtonElement>(`button[data-outline-action="${action}"]`);
    if (existing) {
        return existing;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'outline-action-btn';
    button.setAttribute('data-outline-action', action);
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
    button.innerHTML = `<span class="outline-action-icon" aria-hidden="true">${panel.buildActionGlyph(action)}</span>`;
    panel.actionBarEl.appendChild(button);
    return button;
}

/**
 * 生成底部操作按钮所使用的 SVG 图标。
 *
 * @param action - 按钮动作标识
 * @returns 可直接显示的 SVG 图标字符串
 */
export function buildActionGlyph(panel: OutlinePanel, action: string): string {
    // 标题编号 / 取消编号：画成「编号列表」的样子（1/2/3 + 三条横线），
    // 取消编号再压一道斜杠，两个按钮互相对应、也好和加减号区分。
    if (action === 'add-numbering' || action === 'remove-numbering') {
        const slash =
            action === 'remove-numbering'
                ? '<path d="M2.2 14L13.8 2" stroke-width="1.5"></path>'
                : '';
        return `
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
                    <path d="M6 4h7.5M6 8h7.5M6 12h7.5"></path>
                    ${slash}
                </g>
                <g fill="currentColor" font-family="var(--vscode-editor-font-family, monospace)" font-size="4.6">
                    <text x="1.1" y="5.7">1</text>
                    <text x="1.1" y="9.7">2</text>
                    <text x="1.1" y="13.7">3</text>
                </g>
            </svg>
        `;
    }

    // 展开/收起用加减号，两个按钮一眼可区分。
    const glyphPaths: Record<string, string> = {
        'collapse-all': 'M3.5 8h9',
        'expand-all': 'M3.5 8h9M8 3.5v9',
    };
    const path = glyphPaths[action] ?? glyphPaths['expand-all'];
    return `
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="${path}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>
        </svg>
    `;
}

/**
 * 瑙ｆ瀽鎴栧垱寤?tooltip 瀹瑰櫒銆?     *
 * @returns tooltip 鍏冪礌
 */
export function resolveTooltipElement(panel: OutlinePanel): HTMLDivElement {
    const existing = panel.panelEl.querySelector<HTMLDivElement>('#outline-tooltip');
    if (existing) {
        return existing;
    }

    const tooltip = document.createElement('div');
    tooltip.id = 'outline-tooltip';
    tooltip.className = 'outline-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.setAttribute('aria-hidden', 'true');
    panel.panelEl.appendChild(tooltip);
    return tooltip;
}

/**
 * 璁″垝鏄剧ず鎮诞鎻愮ず銆?     *
 * @param rowEl - 闇€瑕佹樉绀烘彁绀虹殑琛屽厓绱?     * @returns void
 */
export function scheduleTooltip(panel: OutlinePanel, rowEl: HTMLElement, clientX: number, clientY: number): void {
    const title = rowEl.getAttribute('data-outline-title')?.trim() ?? '';
    if (!title) {
        return;
    }

    panel.cancelTooltipTimer();
    panel.hoveredRowEl = rowEl;
    panel.hoveredTitle = title;
    panel.hoveredClientX = clientX;
    panel.hoveredClientY = clientY;
    panel.hoverTimer = window.setTimeout(() => {
        if (panel.hoveredRowEl !== rowEl) {
            return;
        }
        panel.showTooltip(rowEl, title, clientX, clientY);
    }, OutlinePanel.TOOLTIP_DELAY_MS);
}

/**
 * 鍙栨秷鎮诞鎻愮ず瀹氭椂鍣ㄣ€?     *
 * @returns void
 */
export function cancelTooltipTimer(panel: OutlinePanel): void {
    if (panel.hoverTimer !== null) {
        window.clearTimeout(panel.hoverTimer);
        panel.hoverTimer = null;
    }
}

/**
 * 鏄剧ず鎮诞鎻愮ず锛屽苟鏍规嵁褰撳墠琛屼綅缃畾浣嶃€?     *
 * @param rowEl - 鐩爣琛屽厓绱?     * @param title - 瀹屾暣鏍囬鏂囨湰
 * @returns void
 */
export function showTooltip(panel: OutlinePanel, rowEl: HTMLElement, title: string, clientX: number, clientY: number): void {
    panel.tooltipEl.textContent = title;
    panel.tooltipEl.dataset.visible = 'true';
    panel.tooltipEl.setAttribute('aria-hidden', 'false');
    panel.tooltipEl.style.visibility = 'hidden';

    window.requestAnimationFrame(() => {
        if (panel.hoveredRowEl !== rowEl || panel.hoveredTitle !== title) {
            return;
        }

        panel.positionTooltip(clientX, clientY);
        panel.tooltipEl.style.visibility = 'visible';
    });
}

/**
 * 璁＄畻骞舵洿鏂版偓娴彁绀轰綅缃€?     *
 * @param rowEl - 鐩爣琛屽厓绱?     * @returns void
 */
export function positionTooltip(panel: OutlinePanel, clientX: number, clientY: number): void {
    const panelRect = panel.panelEl.getBoundingClientRect();
    const tooltipRect = panel.tooltipEl.getBoundingClientRect();
    const mouseX = clientX - panelRect.left;
    const mouseY = clientY - panelRect.top;
    const gap = 8;
    const padding = 8;

    let left = mouseX - tooltipRect.width - gap;
    let top = mouseY + gap;

    left = Math.max(padding, Math.min(left, panelRect.width - tooltipRect.width - padding));
    top = Math.max(padding, Math.min(top, panelRect.height - tooltipRect.height - padding));

    panel.tooltipEl.style.left = `${left}px`;
    panel.tooltipEl.style.top = `${top}px`;
    panel.tooltipEl.dataset.placement = 'cursor';
}

/**
 * 闅愯棌鎮诞鎻愮ず銆?     *
 * @returns void
 */
export function hideTooltip(panel: OutlinePanel): void {
    panel.cancelTooltipTimer();
    panel.hoveredRowEl = null;
    panel.hoveredTitle = '';
    panel.tooltipEl.dataset.visible = 'false';
    panel.tooltipEl.setAttribute('aria-hidden', 'true');
}

/**
 * 鎭㈠鍐呭鍖烘粴鍔ㄤ綅缃紝閬垮厤閲嶆覆鏌撳甫鏉ョ殑瑙嗚璺冲姩銆?     *
 * @param scrollTop - 涔嬪墠鐨勫瀭鐩存粴鍔ㄤ綅缃?     * @param scrollLeft - 涔嬪墠鐨勬按骞虫粴鍔ㄤ綅缃?     * @returns void
 */
export function restoreScrollPosition(panel: OutlinePanel, scrollTop: number, scrollLeft: number): void {
    // 先同步恢复滚动位置，避免下一帧才回填造成的可见跳动。
    panel.contentEl.scrollTop = scrollTop;
    panel.contentEl.scrollLeft = scrollLeft;

    // 再用下一帧做一次兜底，防止布局重算后被浏览器重新夹紧。
    window.requestAnimationFrame(() => {
        if (panel.contentEl.scrollTop !== scrollTop) {
            panel.contentEl.scrollTop = scrollTop;
        }
        if (panel.contentEl.scrollLeft !== scrollLeft) {
            panel.contentEl.scrollLeft = scrollLeft;
        }
    });
}

/**
 * 鏇存柊搴曢儴鎸夐挳鐘舵€併€?     *
 * @returns void
 */
export function updateActionBarState(panel: OutlinePanel): void {
    const hasNodes = panel.nodes.length > 0;
    panel.expandAllButtonEl.disabled = !hasNodes;
    panel.collapseAllButtonEl.disabled = !hasNodes;
    // 编号按钮：没有标题或只读模式都不可用
    const numberingDisabled = !hasNodes || !panel.isEditable();
    panel.addNumberingButtonEl.disabled = numberingDisabled;
    panel.removeNumberingButtonEl.disabled = numberingDisabled;
}

/**
 * 杞箟 HTML 鏂囨湰锛岄伩鍏嶆爣棰樺唴瀹圭牬鍧忕粨鏋勩€?     *
 * @param value - 鍘熷鏂囨湰
 * @returns 瀹夊叏鐨?HTML 鏂囨湰
 */
export function escapeHtml(panel: OutlinePanel, value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
