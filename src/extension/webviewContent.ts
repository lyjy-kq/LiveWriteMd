/**
 * Webview HTML Generation and Content Security Policy Configuration
 *
 * This module provides functions for generating secure HTML content for the
 * FlowMD Webview editor, including Content Security Policy (CSP) configuration.
 *
 * @module extension/webviewContent
 *
 * Design Reference: DES-S-001 - Content Security Policy settings
 * Design Reference: DES-A-005 - Theme integration design
 * Requirements: REQ-NF-002 - Security requirements
 * Requirements: REQ-F-008 - Dark/Light theme support
 */

import * as vscode from 'vscode';

// =============================================================================
// Constants
// =============================================================================

// =============================================================================
// Content Security Policy
// =============================================================================

/**
 * Generate the Content Security Policy string for the Webview.
 *
 * The CSP restricts resource loading to enhance security:
 * - default-src 'none': Deny all resources by default
 * - script-src: Allow scripts from VS Code webview source only
 * - style-src: Allow styles from VS Code and inline styles (for CodeMirror)
 * - img-src: Allow images from VS Code, HTTPS, and data URIs
 * - font-src: Allow fonts from VS Code
 *
 * @param webview - The VS Code Webview instance
 * @param _nonce - Unused, kept for backward compatibility
 * @returns The complete CSP string
 *
 * Design Reference: DES-S-001
 * Requirements: REQ-NF-002
 */
export function getContentSecurityPolicy(webview: vscode.Webview, _nonce: string): string {
    const directives = [
        // Deny all resource loading by default
        "default-src 'none'",

        // Allow scripts from VS Code webview source only (DES-S-001)
        `script-src ${webview.cspSource}`,

        // Allow styles from VS Code CDN and inline styles (required for CodeMirror)
        `style-src ${webview.cspSource} 'unsafe-inline'`,

        // Allow images from VS Code CDN, HTTPS URLs, and data URIs
        `img-src ${webview.cspSource} https: data:`,

        // Allow fonts from VS Code CDN
        `font-src ${webview.cspSource}`,

        // Allow connections for source maps (development) and VS Code resources
        `connect-src ${webview.cspSource} https:`,
    ];

    return directives.join('; ');
}

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
    font-family: var(--vscode-editor-font-family, "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace);
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

/* 正文宽度上限由 flowMd.readableLineLength 决定（默认 900px，设 0 则不限制）。
   宽度封顶后，多出来的空间用 auto margin 平分到两侧，让「行号 + 正文」作为一组
   整体居中，而不是正文贴着左边、右边空一大片。 */
#editor .cm-content {
    max-width: var(--flowmd-max-width, 900px);
    padding: 24px 32px !important;
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
    width: var(--flowmd-outline-width, 280px);
    flex: 0 0 var(--flowmd-outline-width, 280px);
    flex-shrink: 0;
    min-width: 220px;
    max-width: 480px;
    height: 100%;
    overflow: hidden;
    background: var(--vscode-editor-background, #272b33);
    color: var(--vscode-editor-foreground, #d4d4d4);
    font-family: var(--vscode-editor-font-family, "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace);
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
    line-height: var(--flowmd-line-height, 1.7em);
}

.flowmd-outline-content {
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
    min-height: var(--flowmd-line-height, 1.7em);
    padding: 0 6px 0 2px;
    border: 1px solid transparent;
    border-bottom-color: rgba(128, 128, 128, 0.1);
    border-radius: 4px;
    background: transparent;
    color: var(--outline-foreground, inherit);
    cursor: pointer;
    text-align: left;
    font: inherit;
    line-height: var(--flowmd-line-height, 1.7em);
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

/* 展开/收起靠左，关闭按钮靠右，三个按钮不会挤在一起。 */
.outline-action-btn[data-outline-action="close-outline"] {
    margin-left: auto;
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
    right: calc(var(--flowmd-outline-width, 280px) + 24px);
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

// =============================================================================
// Editor.fontWeight bridge
// =============================================================================

/**
 * Read VS Code's `editor.fontWeight` and return a CSS-safe value string for
 * injection as the `--flowmd-font-weight` custom property.
 *
 * VS Code does not expose `editor.fontWeight` as a CSS variable in webviews
 * (unlike `--vscode-editor-font-family` and `--vscode-editor-font-size`), so
 * we read it on the extension side and forward it.
 *
 * Accepted values:
 * - `'normal'` / `'bold'` 鈥?CSS keywords
 * - Numeric `1`銆渀1000` (string or number) 鈥?CSS Fonts Level 4 range
 * - Anything else falls back to `'400'`
 *
 * Validation prevents unexpected values from breaking the inline `<style>`
 * block that sets `:root { --flowmd-font-weight: <value>; }`.
 */
function getEditorFontWeightCss(): string {
    const raw = vscode.workspace.getConfiguration('editor').get<string | number>('fontWeight');

    if (raw === undefined || raw === null) {
        return '400';
    }
    if (raw === 'normal' || raw === 'bold') {
        return raw;
    }
    const num = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
    if (Number.isFinite(num) && num >= 1 && num <= 1000) {
        return String(num);
    }
    return '400';
}

/**
 * Read VS Code's `editor.lineHeight` and return a CSS-safe value string for
 * injection as the `--flowmd-line-height` custom property.
 *
 * VS Code does not expose `editor.lineHeight` as a CSS variable in webviews
 * (unlike `--vscode-editor-font-family` and `--vscode-editor-font-size`), so
 * we read it on the extension side and forward it.
 *
 * VS Code semantics for `editor.lineHeight`:
 * - `0` (or unset) 鈥?auto: derive from font size; we map this to the existing
 *   `1.7em` fallback to preserve prior behaviour.
 * - `< 8` 鈥?multiplier of font size. We append `em` so the parent's computed
 *   pixel value is inherited by child elements (e.g. `.cm-md-code` at
 *   `font-size: 0.9em`) instead of being re-evaluated against each child's
 *   font size, which would cause height-estimation mismatches and scroll jumps.
 * - `>= 8` 鈥?explicit pixel value.
 *
 * Anything that fails type/finiteness checks falls back to `1.7em` so a broken
 * setting cannot inject invalid CSS or open the inline `<style>` block to XSS.
 */
function getEditorLineHeightCss(): string {
    const raw = vscode.workspace.getConfiguration('editor').get<number>('lineHeight');

    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
        return '1.7em';
    }
    if (raw === 0) {
        return '1.7em';
    }
    if (raw < 8) {
        return `${raw}em`;
    }
    return `${raw}px`;
}

// =============================================================================
// HTML Generation
// =============================================================================

/**
 * Generate the complete HTML content for the FlowMD Webview.
 *
 * Creates a secure HTML document with:
 * - Proper DOCTYPE and charset declarations
 * - Content Security Policy meta tag (DES-S-001)
 * - Viewport configuration for responsive design
 * - Inline CSS styles for theming
 * - Editor container element
 * - Script tag for webview.js (CodeMirror initialization)
 *
 * @param webview - The VS Code Webview instance
 * @param extensionUri - The URI of the extension's root directory
 * @param outlineWidth - Saved width of the outline panel in pixels
 * @returns Complete HTML string for the Webview
 *
 * Design Reference: DES-S-001, DES-F-002
 * Requirements: REQ-NF-002, REQ-F-008
 */
export function getHtmlForWebview(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    outlineWidth: number = 280
): string {
    // Generate script URI for webview.js (contains CodeMirror initialization)
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));

    // Generate Content Security Policy (nonce not used per DES-S-001)
    const csp = getContentSecurityPolicy(webview, '');

    // Get inline CSS styles
    const styles = getInlineStyles();

    // Convert script URI to string for template literal
    const scriptUriString = scriptUri.toString();

    // VS Code does not expose `editor.fontWeight` or `editor.lineHeight` as
    // CSS variables in webviews (unlike --vscode-editor-font-family /
    // --vscode-editor-font-size), so we read the settings on the extension
    // side and inject them as CSS custom properties. CodeMirror styles read
    // them via var(--flowmd-font-weight, 400) and var(--flowmd-line-height,
    // 1.7em).
    const fontWeight = getEditorFontWeightCss();
    const lineHeight = getEditorLineHeightCss();
    const safeOutlineWidth = Number.isFinite(outlineWidth) && outlineWidth > 0 ? outlineWidth : 280;

    // Return the complete HTML document
    // Note: Script tag does not use nonce - CSP uses cspSource instead (DES-S-001)
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>FlowMD Editor</title>
    <style>:root {
        --flowmd-font-weight: ${fontWeight};
        --flowmd-line-height: ${lineHeight};
        --flowmd-font-scale: 1;
        --flowmd-editor-font-size: var(--vscode-editor-font-size, 14px);
        --flowmd-outline-width: ${safeOutlineWidth}px;
    }</style>
    <style>
${styles}
    </style>
</head>
<body>
    <div id="app-shell">
        <div id="editor-pane">
            <div id="boot-status">
                <span class="boot-status-title">FlowMD 正在启动 Webview...</span>
                <span class="boot-status-detail">如果这里长时间不消失，说明 webview.js 可能没有加载或没有收到 INIT，请查看 FlowMD 输出。</span>
            </div>
            <div id="editor"></div>
        </div>
        <div id="outline-resizer" role="separator" aria-orientation="vertical" aria-label="Resize outline panel"></div>
        <aside id="outline-pane" aria-label="Markdown outline">
            <div id="outline-content">
                <div class="outline-empty">标题大纲会在这里显示。</div>
            </div>
            <div id="outline-actions" class="outline-actions" aria-label="Outline actions"></div>
            <div id="outline-tooltip" class="outline-tooltip" role="tooltip" aria-hidden="true"></div>
        </aside>
    </div>
    <script src="${scriptUriString}"></script>
</body>
</html>`;
}
