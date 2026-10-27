/**
 * Webview HTML Generation and Content Security Policy Configuration
 *
 * This module provides functions for generating secure HTML content for the
 * LiveWriteMD Webview editor, including Content Security Policy (CSP) configuration.
 *
 * @module extension/webviewContent
 *
 * Design Reference: DES-S-001 - Content Security Policy settings
 * Design Reference: DES-A-005 - Theme integration design
 * Requirements: REQ-NF-002 - Security requirements
 * Requirements: REQ-F-008 - Dark/Light theme support
 */

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { getInlineStyles } from './webviewStyles.js';

/**
 * webview bundle 的缓存破坏参数。
 *
 * VS Code 的 webview 资源走 Service Worker 缓存，**同名 URL 在 Reload Window
 * 之后经常还是旧包**（调试时「代码改了不生效」的常客）。取 dist 文件的
 * mtime 当版本号拼进 query —— 每次构建后 URL 自动变化，缓存自然失效。
 * chunk 文件自带内容哈希名，webview.js 一换新，chunk 链路全是新的。
 */
function bundleVersion(extensionUri: vscode.Uri, bundleName: string): string {
    try {
        return String(
            fs.statSync(vscode.Uri.joinPath(extensionUri, 'dist', bundleName).fsPath).mtimeMs
        );
    } catch {
        // 取不到（罕见：文件不存在）就用当前时间，保证每次都不一样
        return String(Date.now());
    }
}

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

// 内联 CSS 已拆到同目录 webviewStyles.ts（500+ 行，独立成文件便于维护）

// =============================================================================
// Editor.fontWeight bridge
// =============================================================================

/**
 * Read VS Code's `editor.fontWeight` and return a CSS-safe value string for
 * injection as the `--livewritemd-font-weight` custom property.
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
 * block that sets `:root { --livewritemd-font-weight: <value>; }`.
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
 * injection as the `--livewritemd-line-height` custom property.
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
 * Generate the complete HTML content for the LiveWriteMD Webview.
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
    // 带构建版本号的 query：绕开 webview 资源缓存（见 bundleVersion 的说明）
    const scriptUri = webview
        .asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'))
        .with({ query: `v=${bundleVersion(extensionUri, 'webview.js')}` });

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
    // them via var(--livewritemd-font-weight, 400) and var(--livewritemd-line-height,
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
    <title>LiveWriteMD Editor</title>
    <style>:root {
        --livewritemd-font-weight: ${fontWeight};
        --livewritemd-line-height: ${lineHeight};
        /* 基础行高（未乘行间距倍数）：webview 侧 --livewritemd-line-height 会被
           lineHeightScale 设置覆盖，换算时必须以这个不被覆盖的副本为基准。 */
        --livewritemd-line-height-base: ${lineHeight};
        --livewritemd-font-scale: 1;
        --livewritemd-editor-font-size: var(--vscode-editor-font-size, 14px);
        --livewritemd-outline-width: ${safeOutlineWidth}px;
    }</style>
    <style>
${styles}
    </style>
</head>
<body>
    <div id="app-shell">
        <div id="editor-pane">
            <div id="boot-status">
                <span class="boot-status-title">LiveWriteMD 正在启动 Webview...</span>
                <span class="boot-status-detail">如果这里长时间不消失，说明 webview.js 可能没有加载或没有收到 INIT，请查看 LiveWriteMD 输出。</span>
            </div>
            <div id="editor"></div>
            <div id="mindmap" hidden></div>
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
    <script type="module" src="${scriptUriString}"></script>
</body>
</html>`;
}

/**
 * 生成独立导图面板（WebviewPanel）的 HTML（设计文档 §3.2）。
 *
 * 面板是轻量入口：只挂一个填满视口的 #mindmap 容器与 mindmapPanel.js，
 * 不加载 CodeMirror / 大纲 / 标题栏等编辑器外壳；CSP 与主编辑器一致。
 *
 * @param webview - 面板对应的 Webview 实例
 * @param extensionUri - 扩展根目录 URI
 * @returns 面板 HTML 字符串
 */
export function getMindmapPanelHtml(
    webview: vscode.Webview,
    extensionUri: vscode.Uri
): string {
    const scriptUri = webview
        .asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'mindmapPanel.js'))
        .with({ query: `v=${bundleVersion(extensionUri, 'mindmapPanel.js')}` });
    const csp = getContentSecurityPolicy(webview, '');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LiveWriteMD Mind Map</title>
    <style>
        html, body {
            width: 100%;
            height: 100%;
            margin: 0;
            padding: 0;
            overflow: hidden;
            background-color: var(--vscode-editor-background, #272b33);
        }
        /* mindmapStyles.ts 里的 #mindmap 规则为 absolute inset:0，这里提供定位上下文 */
        body { position: relative; }
    </style>
</head>
<body>
    <div id="mindmap"></div>
    <script type="module" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}
