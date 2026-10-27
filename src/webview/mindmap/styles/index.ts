/**
 * 导图模式的样式文本（注入到 webview document）—— 拼装入口。
 *
 * CSS 按域拆在同目录 canvasCss / nodeContentCss / uiCss 三个片段，
 * 这里按原顺序拼接。
 *
 * @module webview/mindmap/styles
 */

import { ensureTokenColorCss } from '../../codemirror/extensions/livePreview/decor/tokenColors.js';
import { CANVAS_CSS } from './canvasCss.js';
import { NODE_CONTENT_CSS } from './nodeContentCss.js';
import { UI_CSS } from './uiCss.js';

export const MINDMAP_CSS = CANVAS_CSS + NODE_CONTENT_CSS + UI_CSS;

/** 幂等注入导图样式（顺带注入共享 token 色表：代码块节点高亮要用）。 */
export function ensureMindMapCss(): void {
    ensureTokenColorCss();
    const STYLE_ID = 'lwm-mindmap-style';
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = MINDMAP_CSS;
    document.head.appendChild(style);
}
