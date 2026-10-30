/**
 * 设置面板内联样式（从 settingsPanel.ts 拆出）。
 *
 * 约 240 行 CSS，构造面板时一次性注入 <style>。
 *
 * @module webview/settings/settingsPanelStyles
 */

// =============================================================================
// 样式（自包含）
// =============================================================================

export const PANEL_STYLES = `
#livewritemd-settings-root {
    position: fixed;
    inset: 0;
    z-index: 99999;
    display: none;
}
#livewritemd-settings-root[data-open="true"] { display: block; }

.fms-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.42);
    animation: fms-fade 0.16s ease;
}
@keyframes fms-fade { from { opacity: 0; } }

.fms-window {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(920px, 94vw);
    height: min(720px, 90vh);
    display: flex;
    flex-direction: column;
    background: var(--vscode-editorBackground, #252526);
    color: var(--vscode-editorForeground, #d4d4d4);
    border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.25));
    border-radius: 10px;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.5);
    overflow: hidden;
    animation: fms-pop 0.18s ease;
}
@keyframes fms-pop {
    from { opacity: 0; transform: translate(-50%, -48%); }
}

.fms-header {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 18px;
    border-bottom: 1px solid var(--vscode-editorGroup-border, rgba(128,128,128,0.18));
    font-size: 15px;
    font-weight: 600;
}
.fms-header-title { flex: 1 1 auto; }
.fms-header-sub {
    font-size: 11px;
    font-weight: 400;
    color: var(--vscode-descriptionForeground, #999);
    margin-right: 4px;
}
.fms-help {
    width: 26px; height: 26px;
    display: inline-flex; align-items: center; justify-content: center;
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    border-radius: 50%;
    background: transparent;
    color: inherit;
    font-size: 12px;
    cursor: pointer;
}
.fms-help:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
.fms-close {
    width: 28px; height: 28px;
    display: inline-flex; align-items: center; justify-content: center;
    border: none; border-radius: 6px;
    background: transparent;
    color: inherit;
    font-size: 18px;
    cursor: pointer;
}
.fms-close:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }

.fms-body { flex: 1 1 auto; display: flex; min-height: 0; }

/* 底部操作栏：应用按钮固定在左下角 */
.fms-footer {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    border-top: 1px solid var(--vscode-editorGroup-border, rgba(128,128,128,0.18));
}
/* 常驻说明：告诉新手不用找「保存」按钮 */
.fms-footer-note {
    flex: 1 1 auto;
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #888);
}
.fms-reset-all {
    padding: 4px 12px;
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-descriptionForeground, #bbb);
    font-size: 11.5px;
    cursor: pointer;
}
.fms-reset-all:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
/* 二次确认态：变红提醒「这一下真的会重置全部」 */
.fms-reset-all[data-armed="true"] {
    color: var(--vscode-errorForeground, #f48771);
    border-color: var(--vscode-errorForeground, #f48771);
    background: rgba(244, 135, 113, 0.12);
}
.fms-apply {
    padding: 5px 20px;
    border: none;
    border-radius: 4px;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
    font-size: 12px;
    cursor: pointer;
}
.fms-apply:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
.fms-apply:active { transform: translateY(1px); }
.fms-apply-hint {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #999);
    opacity: 0;
    transition: opacity 0.15s ease;
}
.fms-apply-hint[data-show="true"] { opacity: 1; }

/* 左栏：搜索框固定在顶部，分组列表自己滚动 */
.fms-nav {
    flex: 0 0 186px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    padding: 10px 8px;
    border-right: 1px solid var(--vscode-editorGroup-border, rgba(128,128,128,0.14));
}
.fms-nav-list {
    flex: 1 1 auto;
    overflow-y: auto;
}
.fms-search {
    flex: 0 0 auto;
    width: 100%;
    box-sizing: border-box;
    padding: 5px 8px;
    font-size: 12px;
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    border-radius: 4px;
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, inherit);
    outline: none;
}
.fms-search:focus { border-color: var(--vscode-focusBorder, #007acc); }
.fms-search::placeholder { color: var(--vscode-input-placeholderForeground, #888); }
.fms-nav-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 10px;
    margin-bottom: 2px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    text-align: left;
    font-size: 13px;
    cursor: pointer;
}
.fms-nav-btn:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }
.fms-nav-btn[data-active="true"] {
    background: var(--vscode-list-activeSelectionBackground, rgba(79,193,255,0.25));
    color: var(--vscode-list-activeSelectionForeground, inherit);
}
.fms-nav-icon { width: 18px; text-align: center; }

.fms-content {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 8px 22px 28px;
}

.fms-row {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 13px 2px;
    border-bottom: 1px solid var(--vscode-editorGroup-border, rgba(128,128,128,0.1));
}
.fms-info { flex: 1 1 auto; min-width: 0; }
.fms-label { font-size: 13px; font-weight: 500; }
.fms-desc { margin-top: 3px; font-size: 11.5px; color: var(--vscode-descriptionForeground, #999); line-height: 1.5; }
.fms-control { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }

/* toggle switch */
.fms-switch {
    position: relative;
    width: 38px; height: 20px;
    border-radius: 999px;
    background: rgba(128,128,128,0.35);
    border: none;
    cursor: pointer;
    transition: background 0.15s ease;
}
.fms-switch::after {
    content: "";
    position: absolute;
    top: 2px; left: 2px;
    width: 16px; height: 16px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.15s ease;
}
.fms-switch[data-on="true"] { background: var(--vscode-button-background, #0e639c); }
.fms-switch[data-on="true"]::after { transform: translateX(18px); }

/* slider */
.fms-slider { width: 150px; accent-color: var(--vscode-focusBorder, #007acc); }
.fms-slider-value {
    min-width: 52px;
    text-align: right;
    font-size: 12px;
    color: var(--vscode-descriptionForeground, #aaa);
}

/* color */
.fms-color {
    width: 32px; height: 24px;
    padding: 0;
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    border-radius: 5px;
    background: none;
    cursor: pointer;
}
.fms-color::-webkit-color-swatch-wrapper { padding: 2px; }
.fms-color::-webkit-color-swatch { border: none; border-radius: 3px; }
.fms-color-text {
    width: 78px;
    font-size: 11px;
    padding: 3px 6px;
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    border-radius: 4px;
    background: var(--vscode-input-background, #3c3c3c);
    color: inherit;
}
.fms-reset {
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-descriptionForeground, #bbb);
    font-size: 11px;
    padding: 3px 8px;
    cursor: pointer;
}
.fms-reset:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
.fms-auto-tag {
    font-size: 10.5px;
    color: var(--vscode-descriptionForeground, #999);
}

/* 字体选择：输入框 + datalist + 「跟随」按钮 */
.fms-font {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
}
.fms-font .fms-text {
    flex: 1;
    min-width: 190px;
}

/* select / text */
.fms-select, .fms-text {
    min-width: 200px;
    font-size: 12px;
    padding: 5px 8px;
    border: 1px solid var(--vscode-dropdown-border, rgba(128,128,128,0.3));
    border-radius: 4px;
    background: var(--vscode-dropdown-background, #3c3c3c);
    color: var(--vscode-dropdown-foreground, inherit);
}
.fms-text {
    background: var(--vscode-input-background, #3c3c3c);
    border-color: var(--vscode-input-border, rgba(128,128,128,0.3));
}
/* 分组标题 + 一句话说明 */
.fms-section-head { margin: 14px 2px 2px; }
.fms-section-head:first-child { margin-top: 4px; }
.fms-section-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--vscode-editorForeground, inherit);
}
.fms-section-desc {
    margin-top: 4px;
    font-size: 11.5px;
    line-height: 1.55;
    color: var(--vscode-descriptionForeground, #999);
}

/* 新手引导卡片 */
.fms-guide {
    margin: 6px 0 14px;
    padding: 12px 14px;
    border: 1px solid var(--vscode-focusBorder, rgba(0,122,204,0.55));
    border-radius: 8px;
    background: var(--vscode-editorWidget-background, rgba(79,193,255,0.07));
}
.fms-guide-head {
    display: flex;
    align-items: center;
    gap: 8px;
}
.fms-guide-title {
    flex: 1 1 auto;
    font-size: 13px;
    font-weight: 600;
}
.fms-guide-close {
    border: none;
    background: transparent;
    color: var(--vscode-descriptionForeground, #999);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    padding: 0 2px;
}
.fms-guide-close:hover { color: var(--vscode-editorForeground, inherit); }
.fms-guide-steps {
    margin: 8px 0 0;
    padding-left: 18px;
    font-size: 12px;
    line-height: 1.65;
    color: var(--vscode-editorForeground, inherit);
}
.fms-guide-steps li { margin-bottom: 4px; }
.fms-guide-tip {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px dashed var(--vscode-editorGroup-border, rgba(128,128,128,0.2));
    font-size: 11.5px;
    line-height: 1.6;
    color: var(--vscode-descriptionForeground, #999);
}

/* 已改动标记 / 行尾恢复默认 / 搜索里的分组标签 */
.fms-mod-badge {
    display: none;
    margin-left: 8px;
    padding: 1px 6px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 400;
    color: var(--vscode-focusBorder, #4fc1ff);
    background: rgba(79, 193, 255, 0.15);
}
.fms-row[data-modified="true"] .fms-mod-badge { display: inline-block; }
.fms-row-reset {
    flex: 0 0 auto;
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-descriptionForeground, #bbb);
    font-size: 10.5px;
    padding: 3px 8px;
    cursor: pointer;
    white-space: nowrap;
}
.fms-row-reset:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
.fms-row-chip {
    margin-right: 6px;
    padding: 1px 6px;
    border: 1px solid var(--vscode-editorGroup-border, rgba(128,128,128,0.3));
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-descriptionForeground, #999);
    font-size: 10.5px;
    font-weight: 400;
    cursor: pointer;
}
.fms-row-chip:hover {
    color: var(--vscode-editorForeground, inherit);
    border-color: var(--vscode-focusBorder, #007acc);
}
/* 从搜索跳回分组时，目标行闪一下，帮助眼睛定位 */
.fms-row[data-flash="true"] { animation: fms-flash 1.2s ease; }
@keyframes fms-flash {
    0% { background: rgba(79, 193, 255, 0.22); }
    100% { background: transparent; }
}

/* 搜索无结果 */
.fms-empty {
    padding: 28px 8px;
    font-size: 12.5px;
    line-height: 1.8;
    text-align: center;
    color: var(--vscode-descriptionForeground, #999);
}
`;

