/**
 * 大纲面板：标题树渲染（从 outlinePanel.ts 拆出）。
 *
 * 全部是把 this 换成 panel 的原类方法；字段直读直写（panel 字段已放开
 * 为 public），跨模块调用仍走 panel 上的薄包装方法。
 *
 * @module webview/outline/outlineRender
 */

// OutlinePanel 只当类型用，别在这里取值：type 导入会被 esbuild 擦掉，
// 写成 OutlinePanel.XXX 运行时就是 ReferenceError。类静态常量统一从
// outlineConstants.js 走值导入。
import type { OutlinePanel, OutlineNode } from './outlinePanel.js';
import { OUTLINE_LEVEL_ACCENT_PALETTE } from './outlineConstants.js';
import { settingsState } from '../settings/settingsState.js';

/**
 * 娓叉煋澶х翰瑙嗗浘銆?     *
 * @returns void
 */
export function render(panel: OutlinePanel): void {
    const previousScrollTop = panel.contentEl.scrollTop;
    const previousScrollLeft = panel.contentEl.scrollLeft;
    panel.hideTooltip();
    panel.activeNodeId = panel.findActiveNodeId(panel.nodes, panel.activeLine);

    if (panel.nodes.length === 0) {
        // 空状态提示：旧文案是被错误转码的乱码，这里换回正常中文。
        panel.contentEl.innerHTML =
            '<div class="outline-empty">标题大纲</div>';
        panel.panelEl.classList.add('is-empty');
        panel.updateActionBarState();
        panel.restoreScrollPosition(previousScrollTop, previousScrollLeft);
        return;
    }

    panel.panelEl.classList.remove('is-empty');
    const activeNodeId = panel.findActiveNodeId(panel.nodes, panel.activeLine);
    const html = panel.renderNodes(panel.nodes, activeNodeId);
    panel.contentEl.innerHTML = `<div class="outline-tree" role="tree">${html}</div>`;
    panel.updateActionBarState();
    panel.restoreScrollPosition(previousScrollTop, previousScrollLeft);
}

/**
 * 閫掑綊娓叉煋鏍囬鑺傜偣銆?     *
 * @param nodes - 褰撳墠灞傜骇鑺傜偣
 * @param activeNodeId - 褰撳墠楂樹寒鑺傜偣 ID
 * @returns HTML 瀛楃涓?     */
export function renderNodes(panel: OutlinePanel, nodes: OutlineNode[], activeNodeId: string | null): string {
    return nodes
        .map((node) => {
            const accentIndex = (node.level - 1) % OUTLINE_LEVEL_ACCENT_PALETTE.length;
            const accent = OUTLINE_LEVEL_ACCENT_PALETTE[accentIndex];
            const isCollapsed = panel.collapsedNodeIds.has(node.id);
            const hasChildren = node.children.length > 0;
            const isActive = node.id === activeNodeId;
            const toggleIcon = hasChildren ? panel.buildToggleIcon(isCollapsed) : '';
            const indentGuides = panel.buildIndentGuides(node.level);
            const childrenHtml =
                hasChildren && !isCollapsed
                    ? `<div class="outline-children">${panel.renderNodes(
                          node.children,
                          activeNodeId
                      )}</div>`
                    : '';

            return `
                <div
                    class="outline-item"
                    data-node-id="${panel.escapeHtml(node.id)}"
                    data-level="${node.level}"
                    style="--outline-accent: ${accent}; --outline-indent: ${(Math.max(0, node.level - 1) * 8)}px;"
                >
                    <div
                        class="outline-row"
                        data-outline-action="jump"
                        data-level="${node.level}"
                        data-line="${node.line}"
                        data-outline-title="${panel.escapeHtml(node.text)}"
                        data-active="${isActive ? 'true' : 'false'}"
                        role="button"
                        tabindex="0"
                        aria-label="跳转到第 ${node.line} 行：${panel.escapeHtml(node.text)}"
                    >
                        <span
                            class="outline-toggle${hasChildren ? '' : ' outline-toggle-spacer'}"
                            data-outline-action="toggle"
                            data-node-id="${node.id}"
                            data-collapsed="${isCollapsed ? 'true' : 'false'}"
                            aria-hidden="true"
                        >${toggleIcon}</span>
                        ${indentGuides}
                        <span class="outline-label">${panel.escapeHtml(node.text)}</span>
                        <span class="outline-meta">${node.line}</span>
                    </div>
                    ${childrenHtml}
                </div>
            `;
        })
        .join('');
}

/**
 * 鏌ユ壘褰撳墠楂樹寒琛屽搴旂殑鏈€杩戞爣棰樿妭鐐广€?     *
 * @param nodes - 鏍囬鑺傜偣鍒楄〃
 * @param lineNumber - 褰撳墠琛屽彿
 * @returns 鑺傜偣 ID锛屾病鏈夊垯杩斿洖 null
 */
export function findActiveNodeId(panel: OutlinePanel, nodes: OutlineNode[], lineNumber: number): string | null {
    let lastMatch: OutlineNode | null = null;

    const walk = (items: OutlineNode[]): void => {
        for (const node of items) {
            if (node.line <= lineNumber) {
                lastMatch = node;
            }
            if (node.children.length > 0 && node.line <= lineNumber) {
                walk(node.children);
            }
        }
    };

    walk(nodes);
    return lastMatch?.id ?? null;
}

/**
 * 同步当前激活行对应的大纲高亮状态。
 *
 * @returns void
 */
export function syncActiveState(panel: OutlinePanel): void {
    const nextActiveNodeId = panel.findActiveNodeId(panel.nodes, panel.activeLine);
    if (panel.activeNodeId === nextActiveNodeId) {
        return;
    }

    if (panel.activeNodeId) {
        const previous = panel.contentEl.querySelector<HTMLElement>(
            `[data-node-id="${CSS.escape(panel.activeNodeId)}"] > .outline-row`
        );
        previous?.setAttribute('data-active', 'false');
    }

    panel.activeNodeId = nextActiveNodeId;
    if (!panel.activeNodeId) {
        return;
    }

    const current = panel.contentEl.querySelector<HTMLElement>(
        `[data-node-id="${CSS.escape(panel.activeNodeId)}"] > .outline-row`
    );
    current?.setAttribute('data-active', 'true');
    current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/**
 * 生成折叠与展开图标。
 *
 * @param collapsed - 是否处于折叠状态
 * @returns SVG 图标字符串
 */
export function buildToggleIcon(panel: OutlinePanel, collapsed: boolean): string {
    const rotate = collapsed ? '0deg' : '90deg';
    return `
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" style="transform: rotate(${rotate}); transform-origin: 50% 50%;">
            <path d="M5.5 3.5L10 8l-4.5 4.5-.7-.7L8.6 8 4.8 4.2z"></path>
        </svg>
    `;
}

/**
 * 生成缩进引导线，用于表现树状层级结构。
 *
 * @param level - 标题层级
 * @returns HTML 字符串
 */
export function buildIndentGuides(panel: OutlinePanel, level: number): string {
    // 设置项 outlineGuides 关闭时不渲染缩进引导线
    if (!settingsState.getBoolean('outlineGuides')) return '';
    const guideCount = Math.max(0, level - 1);
    if (guideCount === 0) {
        return '';
    }

    return `
        <span class="outline-guides" aria-hidden="true">
            ${Array.from({ length: guideCount }, (_, index) => {
                const isLast = index === guideCount - 1;
                return `<span class="outline-guide${isLast ? ' is-last' : ''}"></span>`;
            }).join('')}
        </span>
    `;
}
