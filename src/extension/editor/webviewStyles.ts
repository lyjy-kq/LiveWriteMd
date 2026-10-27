/**
 * Webview 内联 CSS（从 webviewContent.ts 拆出）。
 *
 * 只含 getInlineStyles 一个导出：拼接基础布局与明暗主题变量的完整 CSS 串，
 * 由 webviewContent.ts 的 HTML 生成注入 <style>。
 *
 * @module extension/editor/webviewStyles
 */

// =============================================================================
// CSS Styles (Inline)
// =============================================================================

/**
 * Generate inline CSS styles for the Webview.
 *
 * Combines base styles with light and dark theme variables.
 * Uses data-theme attribute selector for theme switching.
 *
 * @returns Complete CSS string for the Webview
 *
 * Design Reference: DES-A-005
 * Requirements: REQ-F-008
 */
export function getInlineStyles(): string {
    return `
/* =============================================================================
 * Base Layout - CodeMirror Editor
 * ============================================================================= */

html {
    width: 100%;
    height: 100%;
}

body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    background-color: var(--vscode-editor-background, #272b33);
    color: var(--vscode-editor-foreground, #d4d4d4);
    font-family: var(--livewritemd-editor-font-family, var(--vscode-editor-font-family, "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace));
    font-size: var(--vscode-editor-font-size, 14px);
    overflow: hidden;
}

#app-shell {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: row;
    overflow: hidden;
}

#editor-pane {
    flex: 1 1 0;
    min-width: 0;
    position: relative;
}

#editor {
    width: 100%;
    height: 100%;
}

/* 导图容器：与 #editor 互斥，mindmap 模式下由 webview 切换 hidden */
#mindmap {
    position: absolute;
    inset: 0;
    overflow: hidden;
}
#mindmap[hidden] {
    display: none !important;
}

#boot-status {
    position: absolute;
    left: 24px;
    top: 24px;
    right: 24px;
    z-index: 2;
    padding: 14px 16px;
    border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
    border-radius: 10px;
    background: var(--vscode-editor-background, #272b33);
    color: var(--vscode-editor-foreground, #d4d4d4);
    line-height: 1.6;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
    pointer-events: none;
}

#boot-status[hidden] {
    display: none !important;
}

.boot-status-title {
    display: block;
    font-weight: 700;
    margin-bottom: 4px;
}

.boot-status-detail {
    display: block;
    color: var(--vscode-descriptionForeground, #999);
}

/* CodeMirror fills the editor container */
#editor .cm-editor {
    height: 100%;
}

/* 正文宽度上限由 liveWriteMd.readableLineLength 决定（默认 900px，设 0 则不限制）。
   宽度封顶后，多出来的空间用 auto margin 平分到两侧，让「行号 + 正文」作为一组
   整体居中，而不是正文贴着左边、右边空一大片。 */
#editor .cm-content {
    max-width: var(--livewritemd-max-width, 900px);
    padding: 0 !important;
    /* 右侧剩余空间由正文吃掉，把正文推到中间。 */
    margin-right: auto;
}

/* 有行号栏时，左侧剩余空间交给行号栏，行号因此始终紧贴正文。 */
#editor .cm-scroller > .cm-gutters {
    margin-left: auto;
}

/* 关掉行号后 .cm-content 会成为第一个子元素，此时左侧也要由正文自己吃掉，
   否则正文会被单边的 auto margin 推到右边而不是居中。 */
#editor .cm-scroller > .cm-content:first-child {
    margin-left: auto;
}

/* Scroller */
#editor .cm-scroller {
    overflow: auto;
    scrollbar-gutter: stable;
}

#outline-resizer {
    width: 6px;
    flex: 0 0 6px;
    cursor: col-resize;
    background: transparent;
    position: relative;
    z-index: 5;
}

#outline-resizer::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 1px;
    transform: translateX(-50%);
    background: rgba(128, 128, 128, 0.22);
    transition: background-color 0.15s ease;
}

#outline-resizer:hover::before,
#outline-resizer[data-dragging="true"]::before {
    background: rgba(79, 193, 255, 0.65);
}

#outline-resizer[hidden],
#outline-pane[hidden] {
    display: none !important;
}

#outline-pane {
    width: var(--livewritemd-outline-width, 280px);
    flex: 0 0 var(--livewritemd-outline-width, 280px);
    flex-shrink: 0;
    min-width: 220px;
    max-width: 480px;
    height: 100%;
    overflow: hidden;
    background: var(--vscode-editor-background, #272b33);
    color: var(--vscode-editor-foreground, #d4d4d4);
    font-family: var(--livewritemd-editor-font-family, var(--vscode-editor-font-family, "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace));
    font-size: var(--vscode-editor-font-size, 14px);
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    position: relative;
}

/* 右侧大纲滚动区：自身承担滚动，保证内容从面板左上角直接起始。 */
#outline-content {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: auto;
    scrollbar-gutter: stable;
    padding: 0;
    font-size: inherit;
    line-height: var(--livewritemd-line-height, 1.7em);
}

.livewritemd-outline-content {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1 1 auto;
}

.outline-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    scrollbar-gutter: stable;
    padding: 0;
}

.outline-tree {
    padding: 0;
    margin: 0;
}

.outline-empty {
    display: block;
    padding: 0;
    margin: 0;
    color: var(--vscode-descriptionForeground, #999);
    font-size: inherit;
    line-height: inherit;
}

.outline-item {
    position: relative;
    margin: 0;
    padding: 0;
}

.outline-node {
    margin: 0;
    overflow: hidden;
}

.outline-node[data-level="1"],
.outline-item[data-level="1"] {
    --outline-accent: rgba(235, 131, 131, 0.5);
}

.outline-node[data-level="2"],
.outline-item[data-level="2"] {
    --outline-accent: rgba(174, 154, 203, 0.5);
}

.outline-node[data-level="3"],
.outline-item[data-level="3"] {
    --outline-accent: rgba(125, 181, 205, 0.5);
}

.outline-node[data-level="4"],
.outline-item[data-level="4"] {
    --outline-accent: rgba(113, 167, 150, 0.5);
}

.outline-node[data-level="5"],
.outline-item[data-level="5"] {
    --outline-accent: rgba(220, 191, 97, 0.5);
}

.outline-node[data-level="6"],
.outline-item[data-level="6"] {
    --outline-accent: rgba(221, 163, 106, 0.5);
}

.outline-row {
    display: flex;
    align-items: center;
    gap: 3px;
    min-height: var(--livewritemd-line-height, 1.7em);
    padding: 0 6px 0 2px;
    border: 1px solid transparent;
    border-bottom-color: rgba(128, 128, 128, 0.1);
    border-radius: 4px;
    background: transparent;
    color: var(--outline-foreground, inherit);
    cursor: pointer;
    text-align: left;
    font: inherit;
    line-height: var(--livewritemd-line-height, 1.7em);
    box-sizing: border-box;
    transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.outline-row:hover {
    background: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.1));
    border-color: rgba(128, 128, 128, 0.14);
}

.outline-row[data-active="true"] {
    background: color-mix(in srgb, var(--outline-accent, rgba(79, 193, 255, 0.5)) 20%, transparent);
    border-color: color-mix(in srgb, var(--outline-accent, rgba(79, 193, 255, 0.5)) 58%, transparent);
}

.outline-toggle {
    width: 12px;
    height: 12px;
    flex: 0 0 12px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: color-mix(in srgb, var(--outline-accent, rgba(128, 128, 128, 0.5)) 54%, var(--vscode-editor-foreground, #d4d4d4));
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
    margin: 0;
    opacity: 0.82;
    transform: translateY(-0.5px);
}

.outline-toggle-spacer {
    opacity: 0;
    pointer-events: none;
}

.outline-toggle:hover {
    background: rgba(127, 127, 127, 0.12);
    opacity: 1;
}

.outline-toggle svg {
    width: 11px;
    height: 11px;
    fill: currentColor;
    display: block;
    pointer-events: none;
}

.outline-guides {
    display: inline-flex;
    align-self: stretch;
    flex: 0 0 auto;
    min-height: 100%;
    margin-left: 1px;
    pointer-events: none;
}

.outline-guide {
    position: relative;
    width: 8px;
    flex: 0 0 8px;
    align-self: stretch;
}

.outline-guide::before {
    content: "";
    position: absolute;
    left: 3px;
    top: 0;
    bottom: 0;
    width: 1px;
    background: color-mix(in srgb, var(--outline-accent, rgba(127, 127, 127, 0.3)) 44%, rgba(127, 127, 127, 0.18));
}

.outline-toggle:disabled {
    opacity: 0;
    cursor: default;
}

.outline-label {
    flex: 1 1 auto;
    min-width: 0;
    border: none;
    background: transparent;
    color: color-mix(in srgb, var(--outline-accent, rgba(128, 128, 128, 0.5)) 58%, var(--vscode-editor-foreground, #d4d4d4));
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 0;
    font: inherit;
    line-height: inherit;
}

.outline-row[data-active="true"] .outline-label {
    color: color-mix(in srgb, var(--outline-accent, rgba(79, 193, 255, 0.5)) 72%, var(--vscode-editor-foreground, #d4d4d4));
    font-weight: 600;
}

.outline-meta {
    flex: 0 0 auto;
    color: color-mix(in srgb, var(--outline-accent, rgba(128, 128, 128, 0.5)) 42%, var(--vscode-editor-foreground, #d4d4d4));
    font-size: 0.85em;
    line-height: inherit;
}

.outline-children {
    margin: 0;
    padding: 0;
}

.outline-item {
    position: relative;
}

.outline-node.is-collapsed > .outline-children,
.outline-item.is-collapsed > .outline-children {
    display: none;
}

/* 底部操作栏：固定在大纲面板底部，和内容区自然分离。 */
.outline-actions {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 6px;
    padding: 6px 6px 6px 6px;
    border-top: 1px solid rgba(128, 128, 128, 0.18);
    background: inherit;
}

.outline-actions:empty {
    display: none;
}

.outline-action-btn {
    width: 28px;
    height: 28px;
    flex: 0 0 28px;
    border: 1px solid rgba(127, 127, 127, 0.24);
    border-radius: 4px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 15px;
    line-height: 1;
    padding: 0;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.outline-action-btn:hover {
    background: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.1));
    border-color: rgba(128, 128, 128, 0.28);
}

.outline-action-btn:disabled {
    opacity: 0.6;
}

.outline-action-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    flex: 0 0 auto;
    line-height: 1;
}

.outline-tooltip {
    position: absolute;
    z-index: 9999;
    max-width: min(360px, calc(100vw - 24px));
    padding: 6px 8px;
    border-radius: 4px;
    background: var(--vscode-editorHoverWidget-background, rgba(40, 44, 52, 0.98));
    color: var(--vscode-editorHoverWidget-foreground, var(--vscode-editor-foreground, #d4d4d4));
    border: 1px solid var(--vscode-editorHoverWidget-border, rgba(128, 128, 128, 0.28));
    box-shadow: 0 8px 22px rgba(0, 0, 0, 0.24);
    pointer-events: none;
    font-size: 12px;
    line-height: 1.5;
    white-space: normal;
    word-break: break-word;
}

.outline-tooltip[aria-hidden="true"],
.outline-tooltip[data-visible="false"] {
    display: none !important;
}

.outline-tooltip[hidden] {
    display: none !important;
}

/* “展开大纲”浮动按钮的样式由 webview 侧的 OutlinePanel 自行注入，
   这样样式和创建按钮的代码始终在同一个 bundle 里，不会因扩展宿主未重启而脱节。 */

/* Scroll jump buttons */
.scroll-jump-container {
    position: fixed;
    right: calc(var(--livewritemd-outline-width, 280px) + 24px);
    bottom: 24px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    z-index: 100;
}
.scroll-jump-btn {
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 6px;
    background: rgba(128, 128, 128, 0.2);
    color: #888;
    font-size: 14px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0.6;
    transition: opacity 0.15s ease, background-color 0.15s ease;
}
.scroll-jump-btn:hover {
    opacity: 1;
    background: rgba(128, 128, 128, 0.4);
    color: #ccc;
}
@keyframes spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
}
.scroll-jump-btn.spinning {
    opacity: 1;
    pointer-events: none;
}
.scroll-jump-btn.spinning .btn-icon {
    display: inline-block;
    animation: spin 0.8s linear infinite;
    color: var(--vscode-focusBorder, #007acc);
}
`;
}
