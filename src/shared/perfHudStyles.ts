/**
 * 全局性能监测浮层的 CSS。
 *
 * 浮层挂在 document.body 上（fixed），主编辑器 webview 和独立导图面板
 * 都要加载这段样式，所以放在 shared 里由两边共同引用：
 * - 主编辑器：webviewStyles.ts 拼进内联 <style>；
 * - 独立面板：webviewContent.ts 的 getMindmapPanelHtml 拼进 <style>。
 *
 * 配色直接吃 VS Code 主题变量，不再依赖 #mindmap[data-lwm-theme]，
 * 这样文本 / 幻灯片模式下也能和主题保持一致。
 *
 * @module shared/perfHudStyles
 */

export const PERF_HUD_CSS = `
/* 性能监测浮层：窗口右上角，所有模式共用。
   整体不接指针事件（不挡正文 / 画布操作），只有复制按钮可点。
   z-index 低于导图右侧快速卡片栏（18）：卡片展开时覆盖监控条。 */
.lwm-perf-hud {
    position: fixed;
    top: 6px;
    /* 贴着编辑区右上角：主 webview 里减去右侧大纲的宽度（变量随拖拽实时
       更新，大纲隐藏时仍保留原宽度，属于可接受的轻微偏移）。独立面板没有
       这个变量，fallback 0 就是贴右边缘。 */
    right: calc(var(--livewritemd-outline-width, 0px) + 8px);
    z-index: 17;
    max-width: 70%;
    padding: 5px 8px;
    border: 1px solid var(--vscode-widget-border, #454545);
    border-radius: 6px;
    background: var(--vscode-editorWidget-background, rgba(20, 24, 31, 0.85));
    color: var(--vscode-editorWidget-foreground, #9fd3a8);
    font: 11px/1.6 Consolas, "Cascadia Mono", monospace;
    pointer-events: none;
    user-select: none;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.18);
}

/* 极简档：一行小字，无边框、无底色（文字阴影保证任何背景上可读） */
.lwm-perf-hud.lwm-perf-hud-minimal {
    top: 4px;
    right: calc(var(--livewritemd-outline-width, 0px) + 8px);
    padding: 0;
    border: none;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    color: var(--vscode-editor-foreground, #d4d4d4);
    font-size: 11px;
    line-height: 1.4;
    opacity: 0.72;
    text-shadow: 0 0 3px var(--vscode-editor-background, #1e1e1e);
}

.lwm-perf-hud-spikes {
    color: var(--vscode-editorWarning-foreground, #d8a04a);
}

.lwm-perf-hud-copy {
    margin-top: 2px;
    padding: 1px 8px;
    border: 1px solid var(--vscode-widget-border, #454545);
    border-radius: 4px;
    background: transparent;
    color: inherit;
    font-size: 11px;
    cursor: pointer;
    pointer-events: auto;
}
`;
