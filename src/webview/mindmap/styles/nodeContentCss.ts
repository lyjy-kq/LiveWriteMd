/**
 * 导图样式片段（从 mindmapStyles.ts 拆出）：节点内容：mini-CM 显示态修正 / 媒体节点（code/table/image/math/mermaid/html/meta）尺寸上限 / 右键菜单 / 性能提示 / 空文档提示 / 浮动工具条。
 *
 * 注意：本文件是 CSS 模板字符串，注释里禁止写反引号（会提前截断模板）。
 *
 * @module webview/mindmap/styles/nodeContentCss
 */

export const NODE_CONTENT_CSS = `
/* =================================================================
 * 统一显示态（新需求 1/2）：节点内容 = 只读 mini-CM 挂完整 live 扩展，
 * 视觉全部来自 live 自身的样式（styles.ts / tokenColors.ts），
 * 这里只管「节点级」的尺寸上限与导图特有的修正。
 * ================================================================= */
.lwm-node-display {
    width: 100%;
    /* 显示态文字不参与节点选择态的 user-select 限制（CM 选区要用）。
       .lwm-node 上的 user-select: none 会继承到整棵子树，只给容器改不够 ——
       必须在这里显式写 text，节点里的加粗 / 斜体 / 代码 / 表格文字才能
       像 live 模式一样用鼠标拖选。 */
    user-select: text;
    -webkit-user-select: text;
    text-align: left;
    /* 布局隔离：导图全树渲染时库会逐节点量尺寸，每次强排都是全文档布局；
       contain 把每个节点的布局成本锁在自己子树内，避免 O(n²) 抖动 */
    contain: layout style;
}

/* 导图节点里的滚动条一律消失（bug 1：单元格右侧出现划不动的滑动栏——
   显示态内容截断交给节点 CSS，不需要任何滚动条）。
   编辑态允许盒内滚动但仍不显示条（拖内容即可滚）。 */
.lwm-node * {
    scrollbar-width: none !important;
}
.lwm-node *::-webkit-scrollbar {
    display: none !important;
    width: 0 !important;
    height: 0 !important;
}
.lwm-node .cm-scroller {
    overflow: hidden !important;
}
.lwm-node.lwm-node-editing .cm-scroller {
    overflow-y: auto !important;
}

/* 导图节点的列表行不显示 rainbow indent 色带（bug 3；live 模式不受影响，
   色带是 plugin 写在行内样式里的线性渐变，这里按类压掉背景图） */
.lwm-node .cm-md-indent {
    background-image: none !important;
}

/* 渐进挂载的静态占位：字体/内边距与 CM 内容对齐，
   让库量出的节点尺寸与换真后基本一致（不位移）。
   行高用正文的倍行距变量：mini-CM 里的 .cm-line 吃的是 live 的行高变量
   （1.7em），不是节点盒的 1.5 —— 占位对齐错了会让每次换真都变尺寸，
   换真泵的「尺寸没变就跳过重排」优化整批失效（实测重排数 11 → 25） */
.lwm-node-placeholder {
    box-sizing: border-box;
    padding: 2px 0;
    font-family: inherit;
    font-size: inherit;
    line-height: var(--livewritemd-line-height, 1.7em);
    white-space: pre-wrap;
    word-break: break-word;
    /* 占位内容用户可读（换真前的过渡态），只是没有渲染效果 */
    color: inherit;
}
/* widget 自带的放大/复制/尺寸按钮在导图节点里隐藏：保持节点紧凑、
   点击行为统一（点击图片/图表 = 选中节点，不进浮层）。
   mermaid 例外：用户要求复用 live 的「放大查看 / 尺寸调节」，
   这两组按钮在 mermaid 节点里原样显示（见下面的恢复规则）。 */
/* 只有 mermaid 与图片保留右下角操作胶囊（放大查看 / 复制 / 缩放宽度）。
   图片节点此前一并被这条规则藏掉了，用户反馈找不到这些按钮 ——
   按钮本身在 ImageWidget 里一直都在，只是被 display:none 压住。 */
.lwm-node:not(.lwm-node-mermaid):not(.lwm-node-image) .cm-md-preview-actions,
.lwm-node:not(.lwm-node-mermaid):not(.lwm-node-image) .cm-md-resize-actions {
    display: none !important;
}
/* 哨兵行（显示 CM 末尾的隐藏空行）：压 0 高，把选区引出块外，
   让「整篇一个块」的文档也能拿到 live 的块装饰/表格/公式 widget */
.lwm-node-display .lwm-sentinel-line {
    font-size: 0 !important;
    line-height: 0 !important;
    padding: 0 !important;
    height: 0 !important;
    overflow: hidden !important;
}

/* =================================================================
 * 媒体节点尺寸上限（内容与实时模式同源，超出截断、点击展开全部）。
 * ================================================================= */
.lwm-node-code,
.lwm-node-table,
.lwm-node-image,
.lwm-node-math,
.lwm-node-mermaid,
.lwm-node-meta {
    display: block;
    overflow: hidden;
    white-space: normal;
    align-items: flex-start;
}
/* 媒体节点：用内容本身当节点，不再套一层导图外框。
   代码块 / 表格 / 图片 / mermaid 在 live 里已经各自带边框和底色，
   再叠一层半透明色块 + 点线框，视觉上就是「卡片里又套一张卡片」。
   这里只去掉导图给的装饰；选中态 outline / 搜索高亮仍然生效。
   两个类名叠加是为了压过 .lwm-node[data-depth="0|1|2"] 的边框规则。 */
.lwm-node.lwm-node-code,
.lwm-node.lwm-node-table,
.lwm-node.lwm-node-image,
.lwm-node.lwm-node-math,
.lwm-node.lwm-node-mermaid {
    background: transparent;
    border: none;
    box-shadow: none;
    border-radius: 0;
}
/* 高倍缩放条规则的「画布 + 高倍 + 节点」是 3 个类，
   特异性高于上面 2 个类的媒体规则；放大到 150% 时媒体节点又会冒出
   导图底色，所以这里要再用同等特异性压一次。 */
.lwm-canvas.lwm-hi-zoom .lwm-node.lwm-node-code,
.lwm-canvas.lwm-hi-zoom .lwm-node.lwm-node-table,
.lwm-canvas.lwm-hi-zoom .lwm-node.lwm-node-image,
.lwm-canvas.lwm-hi-zoom .lwm-node.lwm-node-math,
.lwm-canvas.lwm-hi-zoom .lwm-node.lwm-node-mermaid {
    background: transparent;
}
/* 代码块节点：上限 40 列 × 20 行；
   最小宽度走设置 mindmapCodeMinWidth（容器变量 --lwm-code-min-width） */
.lwm-node-code {
    min-width: var(--lwm-code-min-width, 10ch);
    max-width: 40ch;
    max-height: calc(20 * var(--livewritemd-line-height, 1.7em) + 1.4em);
}
/* 表格节点：宽度封顶 60em，高度不限、行数尽量全渲染。
   取值考虑：README 海报墙那种「一行 4 张 170px 缩略图」的表格约需 750px，
   30em（≈420px）会把图片格子挤得太小，所以取比其它媒体节点（30em）宽的一档；
   仍必须有上限 —— 列宽分配（tableRender.availableWidth 的导图分支）直接读
   这个 max-width 当「可用宽」预算，没有它超宽文本表格会把节点撑成无限宽。
   改这里的值，列宽预算跟着变。 */
.lwm-node-table {
    max-width: var(--lwm-table-max-width, 60em);
}
/* 图片节点：自带上限。
   高度上限与公式/mermaid 一致（20em）：图片的宽度档位是
   「30em × 25/50/75/100%」，100% 那一档按常见横图比例约 20em 高，
   上限太小会把最大档直接压回去，点「+」看不出变化。 */
.lwm-node-image {
    max-width: 30em;
    max-height: 20em;
}
/* 图片节点：节点盒贴合图片本身。
   默认的正文排版会给图片多留一圈空白 ——
   .cm-content 上下各 2px 内边距、.cm-line 左右各 4px 内边距，
   行盒还会按 1.7em 行高留出基线空间（小图尤其明显，节点比图片高出一截）；
   live 里图片按容器 75% 限宽，量节点时又拿这个百分比去算 max-content，
   结果节点被撑到 30em、图片只占其中 75%，两边各空一大块。
   这里只改「图片节点 + 非编辑态」：显示态贴图，点开编辑仍按正文排版。 */
.lwm-node-image:not(.lwm-node-editing) .cm-content {
    padding: 0;
}
.lwm-node-image:not(.lwm-node-editing) .cm-line {
    padding-left: 0;
    padding-right: 0;
    /* 行高归零：小图（比一行文字还矮）不再被行盒撑高 */
    line-height: 0;
}
.lwm-node-image:not(.lwm-node-editing) .cm-md-image-wrapper {
    /* 宽度档位（25/50/75/100%）在导图里以节点上限 30em 为基准：
       默认 75% → 22.5em。--cm-md-media-ratio 是 ImageWidget 写入的
       无单位小数（0.75），这里才能用 calc 乘出长度。 */
    max-width: calc(30em * var(--cm-md-media-ratio, 0.75));
    /* 行高归零后按顶边对齐，避免 vertical-align: middle 的基线偏移 */
    vertical-align: top;
}
.lwm-node-image:not(.lwm-node-editing) .cm-md-image {
    /* 宽度跟着 wrapper 的档位走；高度上限与节点一致，
       宽高同时受限时浏览器会按比例缩放，不会裁掉一截 */
    max-width: 100%;
    max-height: 20em;
    width: auto;
    height: auto;
    vertical-align: top;
}
/* 双击展开：取消大小的上限，按图片原始尺寸显示 */
.lwm-node-image.lwm-node-expanded .cm-md-image-wrapper {
    max-width: none;
}
.lwm-node-image.lwm-node-expanded .cm-md-image {
    max-width: none;
    max-height: none;
}
/* 数学块 / mermaid 节点：图可能很高，默认截断 */
.lwm-node-math,
.lwm-node-mermaid {
    max-width: 30em;
    max-height: 20em;
}
/* HTML 块节点（居中段落 / 徽章图）：按图片节点的口径收一收宽度；
   带 width 属性的图片不能把节点撑到整块画布那么宽，
   图片由 live 的 .cm-md-html-block img { max-width:100% } 跟着缩。 */
.lwm-node-html {
    max-width: 30em;
    max-height: 24em;
    overflow: hidden;
}
/* 元数据节点（--- 块纯文本，与 live 一致） */
.lwm-node-meta {
    max-width: 30em;
}
.lwm-node-code.lwm-node-expanded,
.lwm-node-image.lwm-node-expanded,
.lwm-node-math.lwm-node-expanded,
.lwm-node-mermaid.lwm-node-expanded,
.lwm-node-html.lwm-node-expanded,
.lwm-node-meta.lwm-node-expanded {
    max-width: none;
    max-height: none;
    overflow: visible;
}

/* 导图右键菜单（新需求 4/5）：样式复用主编辑器右键菜单的视觉 */
.lwm-context-menu {
    position: fixed;
    z-index: 9999;
    min-width: 140px;
    padding: 4px;
    border: 1px solid var(--vscode-widget-border, #454545);
    border-radius: 6px;
    background: var(--vscode-menu-background, var(--vscode-editor-background, #1e1e1e));
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.36);
}
.lwm-context-menu button {
    display: block;
    width: 100%;
    padding: 4px 12px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-menu-foreground, var(--vscode-editor-foreground, #d4d4d4));
    font-size: 12px;
    text-align: left;
    cursor: pointer;
}
.lwm-context-menu button:hover {
    background: var(--vscode-menu-selectionBackground, rgba(0, 120, 215, 0.3));
}
.lwm-context-menu .lwm-context-sep {
    height: 1px;
    margin: 4px 8px;
    background: var(--vscode-widget-border, #454545);
}
/* 画布上的临时提示（如导出失败） */
.lwm-perf-notice {
    position: absolute;
    left: 50%;
    bottom: 20px;
    transform: translateX(-50%);
    z-index: 10;
    padding: 8px 14px;
    border-radius: 8px;
    background: var(--vscode-editorWidget-background, #252526);
    border: 1px solid var(--vscode-editorWidget-border, #454545);
    color: var(--vscode-editorWidget-foreground, #d4d4d4);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
    font-size: 13px;
    pointer-events: none;
}

/* 性能监控浮层（设置「性能监控面板」开启）：画布右上角，半透明小字；
   整体不接指针事件（不挡画布拖动），只有复制按钮可点 */
.lwm-perf-hud {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 45;
    padding: 5px 8px;
    border-radius: 6px;
    background: rgba(20, 24, 31, 0.82);
    border: 1px solid var(--vscode-widget-border, #454545);
    color: #9fd3a8;
    font: 11px/1.6 Consolas, monospace;
    pointer-events: none;
    user-select: none;
    max-width: 46%;
}
#mindmap[data-lwm-theme="light"] .lwm-perf-hud {
    background: rgba(255, 255, 255, 0.9);
    color: #1c6fb5;
}
/* 极简档：右上角一行小字，无边框、无底色（文字阴影保证任何背景上可读） */
#mindmap[data-lwm-theme] .lwm-perf-hud.lwm-perf-hud-minimal {
    top: 6px;
    right: 10px;
    padding: 0;
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--vscode-editor-foreground, #d4d4d4);
    font-size: 11px;
    line-height: 1.4;
    opacity: 0.72;
    text-shadow: 0 0 3px var(--vscode-editor-background, #1e1e1e);
}
#mindmap[data-lwm-theme="light"] .lwm-perf-hud.lwm-perf-hud-minimal {
    background: transparent;
    color: var(--vscode-editor-foreground, #333);
    text-shadow: 0 0 3px var(--vscode-editor-background, #fff);
}
.lwm-perf-hud-spikes {
    color: #d8a04a;
}
.lwm-perf-hud-copy {
    pointer-events: auto;
    margin-top: 2px;
    padding: 1px 8px;
    font-size: 11px;
    border: 1px solid var(--vscode-widget-border, #454545);
    border-radius: 4px;
    background: transparent;
    color: inherit;
    cursor: pointer;
}

/* 空文档 / 纯代码块文档：只有虚拟根时的引导提示 */
.lwm-empty-hint {
    position: absolute;
    left: 50%;
    top: 18%;
    transform: translateX(-50%);
    z-index: 5;
    max-width: 70%;
    padding: 8px 14px;
    border-radius: 8px;
    background: var(--vscode-editorWidget-background, #252526);
    border: 1px dashed var(--vscode-editorWidget-border, #454545);
    color: var(--vscode-descriptionForeground, #9d9d9d);
    font-size: 13px;
    line-height: 1.6;
    pointer-events: none;
    text-align: center;
}

/* 节点悬浮工具条 */
.lwm-toolbar {
    position: absolute;
    z-index: 20;
    display: flex;
    gap: 4px;
    padding: 4px;
    border-radius: 8px;
    background: var(--vscode-editorWidget-background, #252526);
    border: 1px solid var(--vscode-editorWidget-border, #454545);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
}
.lwm-toolbar button {
    border: none;
    border-radius: 5px;
    padding: 3px 8px;
    font-size: 12px;
    color: var(--vscode-editorWidget-foreground, #d4d4d4);
    background: transparent;
    cursor: pointer;
}
.lwm-toolbar button:hover:not(:disabled) {
    background: var(--vscode-toolbar-hoverBackground, rgba(127, 127, 127, 0.25));
}
.lwm-toolbar button:disabled {
    opacity: 0.4;
    cursor: default;
}
/* 删除按钮的「待确认」态：第一次点击变红，第二次点击才真正删除。
   不用 window.confirm —— webview 里确认框会被浏览器吞掉，
   有子节点的删除看起来就像没反应。 */
.lwm-toolbar button.lwm-danger {
    background: var(--vscode-inputValidation-errorBackground, #b93b3b);
    color: #ffffff;
    box-shadow: inset 0 0 0 1px var(--vscode-errorForeground, #f14c4c);
}

/* 多选操作条：定位到「最下面那个选中节点」的下方（positionMultiBar
   每帧跟随画布），和单节点工具条同一套跟随逻辑。
   只在 Ctrl 多选 / Ctrl 框选后出现，按钮文案带数量，避免误删。 */
.lwm-multi-toolbar {
    top: 0;
    left: 0;
}
.lwm-multi-toolbar button {
    padding: 4px 12px;
}
`;
