/**
 * 导图样式片段（从 mindmapStyles.ts 拆出）：界面件：添加菜单三级 hover / 缩略图 / 编辑态 / 搜索条。
 *
 * 注意：本文件是 CSS 模板字符串，注释里禁止写反引号（会提前截断模板）。
 *
 * @module webview/mindmap/styles/uiCss
 */

export const UI_CSS = `
/* =================================================================
 * 添加菜单（悬浮在 ＋子节点 / ＋兄弟 上）：
 * 一级菜单 = 节点类型；标题与表格再展开三级菜单（右侧）。
 * 全部走 :hover 显示，不需要 JS 维护开关状态。
 * ================================================================= */
.lwm-tool-menu {
    position: relative;
    display: inline-flex;
}
.lwm-tool-popup {
    display: none;
    position: absolute;
    /* 默认在按钮下方展开（工具条本身在节点下方） */
    top: calc(100% + 6px);
    left: 0;
    z-index: 30;
    min-width: 136px;
    padding: 4px;
    border: 1px solid var(--vscode-widget-border, #454545);
    border-radius: 6px;
    background: var(--vscode-menu-background, var(--vscode-editor-background, #1e1e1e));
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.32);
}
/* 透明桥接：一级菜单与按钮之间有 6px 间隙，直接把鼠标斜着挪进去会
   离开 :hover 导致菜单闪没。用 ::before 把这段空白也算进菜单的命中区域 */
.lwm-tool-popup::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: -8px;
    height: 8px;
}
.lwm-tool-menu:hover > .lwm-tool-popup,
.lwm-tool-menu:focus-within > .lwm-tool-popup {
    display: block;
}
/* 禁用（如段落节点不能加子节点）：悬停也不弹菜单 */
.lwm-tool-menu.lwm-menu-disabled:hover > .lwm-tool-popup {
    display: none;
}
/* 靠近容器底边：一级菜单翻到工具条上方 */
.lwm-toolbar-up .lwm-tool-menu > .lwm-tool-popup {
    top: auto;
    bottom: calc(100% + 6px);
}
/* 向上展开时桥接也跟着挪到菜单下沿 */
.lwm-toolbar-up .lwm-tool-menu > .lwm-tool-popup::before {
    top: auto;
    bottom: -8px;
}
/* 靠近右边缘：一级菜单改为右对齐，三级菜单改为向左展开 */
.lwm-toolbar-flip-x .lwm-tool-menu > .lwm-tool-popup {
    left: auto;
    right: 0;
}
.lwm-toolbar-flip-x .lwm-tool-popup-right {
    left: auto;
    right: calc(100% + 4px);
}
.lwm-tool-popup > button {
    display: block;
    width: 100%;
    text-align: left;
}
/* class 式禁用（不用 disabled 属性）：禁用按钮不派发鼠标事件，
   title 提示会永远看不到，而我们恰恰要靠 title 解释「为什么不让点」 */
.lwm-tool-popup > button.lwm-item-disabled {
    opacity: 0.45;
    cursor: not-allowed;
}
/* 带三级菜单的条目（标题 / 表格）：悬停展开右侧子菜单 */
.lwm-tool-item {
    position: relative;
}
.lwm-tool-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 3px 8px;
    border-radius: 5px;
    font-size: 12px;
    color: var(--vscode-menu-foreground, var(--vscode-editor-foreground, #d4d4d4));
    cursor: default;
    user-select: none;
}
.lwm-tool-label::after {
    content: '▸';
    margin-left: 14px;
    opacity: 0.7;
}
.lwm-tool-item:hover > .lwm-tool-label {
    background: var(--vscode-toolbar-hoverBackground, rgba(127, 127, 127, 0.25));
}
.lwm-tool-item:hover > .lwm-tool-popup-right,
.lwm-tool-item:focus-within > .lwm-tool-popup-right {
    display: block;
}
.lwm-tool-popup-right {
    top: 0;
    left: calc(100% + 4px);
}
/* 三级菜单的桥接改到左侧（横向 4px 间隙） */
.lwm-tool-popup-right::before {
    top: 0;
    bottom: 0;
    left: -6px;
    right: auto;
    width: 6px;
    height: auto;
}
/* 表格尺寸选择：4×4 方格，悬停高亮到当前行列 */
.lwm-table-grid {
    display: grid;
    grid-template-columns: repeat(4, 18px);
    gap: 3px;
    padding: 4px;
}
.lwm-toolbar .lwm-table-grid button {
    width: 18px;
    height: 18px;
    padding: 0;
    border: 1px solid var(--vscode-widget-border, #454545);
    border-radius: 3px;
    background: transparent;
}
.lwm-toolbar .lwm-table-grid button.lwm-table-hit {
    background: var(--vscode-focusBorder, #007fd4);
    border-color: var(--vscode-focusBorder, #007fd4);
}
.lwm-table-hint {
    padding: 0 0 2px;
    font-size: 11px;
    text-align: center;
    opacity: 0.75;
    color: var(--vscode-menu-foreground, var(--vscode-editor-foreground, #d4d4d4));
}
.lwm-toolbar button.lwm-danger:hover:not(:disabled) {
    background: var(--vscode-errorForeground, #f14c4c);
    color: #ffffff;
}

/* =================================================================
 * 右下角缩略图：只画节点方块 + 当前视口框（见 canvas.ts）
 * ================================================================= */
.lwm-minimap {
    position: absolute;
    right: 16px;
    bottom: 16px;
    width: 190px;
    height: 120px;
    box-sizing: border-box;
    z-index: 15;
    display: none;
    border: 1px solid var(--vscode-widget-border, #454545);
    border-radius: 8px;
    background: rgba(20, 24, 31, 0.78);
    /* 不要投影：缩略图是平铺在画布上的辅助层，加阴影会显得像浮起的卡片 */
    box-shadow: none;
    cursor: pointer;
    /* 触控板 / 触摸：拖动缩略图自己处理，不要滚页面 */
    touch-action: none;
}
.lwm-minimap.lwm-minimap-visible {
    display: block;
}
#mindmap[data-lwm-theme="light"] .lwm-minimap {
    background: rgba(255, 255, 255, 0.86);
    border-color: #c8d3df;
    /* 亮色主题同样保持扁平，不加立体投影 */
    box-shadow: none;
}

/* 节点编辑态的 mini-CM 容器（任务 10）：节点原位换成迷你 CodeMirror，
   宽度由会话按节点宽度写入，高度随内容自适应（库按实测高度重新布局）。
   字体字号与 .lwm-node 同一套变量，保证编辑态与显示态文字不跳。 */
.lwm-node-minicm {
    box-sizing: border-box;
    padding: 0 4px;
    border: 1px solid var(--vscode-focusBorder, #007fd4);
    border-radius: 6px;
    background: var(--vscode-editor-background, #272b33);
    color: var(--vscode-editor-foreground, #d4d4d4);
    font-family: var(--livewritemd-editor-font-family, var(--vscode-editor-font-family, Consolas, monospace));
    font-size: calc(
        var(--livewritemd-editor-font-size, var(--vscode-editor-font-size, 14px)) *
        var(--livewritemd-font-scale, 1)
    );
    font-weight: var(--livewritemd-font-weight, 400);
    line-height: 1.5;
    text-align: left;
    cursor: text;
    user-select: text;
}
.lwm-node-minicm .cm-editor {
    /* mini-CM 高度随内容（主主题的 height:100% 已由会话内高优先级主题覆盖，
       这里再兜一层） */
    height: auto;
}
.lwm-node-minicm .cm-content {
    /* 与节点显示态的 padding 对齐，避免进编辑时文字横向跳 4px */
    padding: 2px 0;
}

/* 节点编辑态（显示 CM 原地翻转）：焦点环 + 解除截断 + 内部滚动。
   节点盒尺寸由导图布局固定，内容比盒高时在盒内滚动（不重排画布） */
.lwm-node.lwm-node-editing {
    outline: 1px solid var(--vscode-focusBorder, #007fd4);
    outline-offset: 1px;
    border-radius: 6px;
    max-width: none !important;
    max-height: none !important;
    -webkit-line-clamp: unset !important;
    overflow: hidden !important;
    white-space: normal;
}
.lwm-node-editing .cm-scroller {
    overflow-y: auto !important;
    max-height: 100%;
}
/* 数学块编辑态：源码区只露两行（$$ 行与公式行），其余箱内滚动。
   高度不重算，仍沿用显示态节点盒子的高度，只是把可视窗口收紧。 */
.lwm-node-math.lwm-node-editing .cm-scroller {
    max-height: calc(2 * var(--livewritemd-line-height, 1.7em)) !important;
}
.lwm-node-editing .cm-content {
    cursor: text;
    user-select: text;
}

/* =================================================================
 * 导图内搜索条（任务 15）
 *
 * 卡片的全部视觉（圆角、背景、描边、输入框、chip、按钮、计数）都来自
 * live 搜索面板的共享样式（searchBar.ts 首次打开时注入 searchPanelCss）。
 * 这里只负责「浮到画布顶部居中」。
 *
 * 定位方式刻意抄了 live 的两层结构：外层 .cm-panels 通栏、透明、
 * 不接事件；卡片在里层用 margin:auto 居中。这样卡片的 width:fit-content
 * 是按整条画布宽度算的，和 live 面板里一致。若把 absolute 直接挂在卡片上，
 * 收缩宽度只能拿到画布的一半，替换行会被挤到第三行。
 * 选择器带三个类，特异性高于共享样式里的 .cm-panel.cm-search 规则，
 * 不依赖样式注入顺序。（注意：这是模板字符串里的 CSS，注释里不能出现
 * 反引号，否则会提前结束字符串。）
 * ================================================================= */
.lwm-searchbar-host {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 40;
    /* 定位带铺满整个宽度，但画布拖动 / 点击不能被他挡住 */
    pointer-events: none;
}
.lwm-searchbar-host > .lwm-searchbar.cm-panel.cm-search {
    margin: 0 auto;
    pointer-events: auto;
    font-size: 12px;
}
/* 搜索命中节点：边框 + 淡底色；当前命中加深 */
.lwm-node.lwm-search-hit {
    outline: 2px solid rgba(255, 200, 0, 0.6);
    outline-offset: 1px;
    background: rgba(255, 200, 0, 0.12);
}
.lwm-node.lwm-search-current {
    outline: 2px solid rgba(255, 160, 0, 0.95);
    background: rgba(255, 200, 0, 0.25);
}
`;
