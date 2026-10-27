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
