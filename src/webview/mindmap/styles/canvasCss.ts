/**
 * 导图样式片段（从 mindmapStyles.ts 拆出）：画布骨架：挂载点 / 五层结构 / 连线 / 节点包裹 / 展开按钮 / 层级配色 / 节点内容盒 / 缩放降级档。
 *
 * 注意：本文件是 CSS 模板字符串，注释里禁止写反引号（会提前截断模板）。
 *
 * @module webview/mindmap/styles/canvasCss
 */

export const CANVAS_CSS = `
/* 导图挂载点填满 #editor-pane */
#mindmap {
    position: absolute;
    inset: 0;
    background: var(--vscode-editor-background, #272b33);
    overflow: hidden;
    /* 文本节点尺寸上限（设置 mindmapNodeMaxWidth / mindmapNodeMaxLines 驱动，
       mindmapApp.applyNodeSizeVars 写入；1 列 = 1 个中文字宽 = 1em） */
    --lwm-node-max-width: 20em;
    --lwm-node-max-lines: 3;
}
#mindmap[hidden] {
    display: none !important;
}

/* =================================================================
 * 自研画布（engine/canvas.ts）
 *
 * container
 *   └─ .lwm-canvas
 *        ├─ .lwm-world       平移层（只写 translate）
 *        │    └─ .lwm-scaler 缩放层（只写 scale）
 *        │         ├─ svg.lwm-links
 *        │         └─ .lwm-node-layer
 *        └─ .lwm-measure      离屏测量层
 * ================================================================= */
.lwm-canvas {
    position: absolute;
    inset: 0;
    overflow: hidden;
    /* 触控板/触摸：画布自己接管手势，别让浏览器滚动页面 */
    touch-action: none;
    /* 表格节点的宽度预算（显示态 max-width 与列宽分配共用这一个变量）。
       必须是变量而不是只写在 .lwm-node-table 上：编辑态会把 max-width
       解除（none，见下面的编辑态规则），列宽分配读不到 max-width 就会
       退回「不设上限」——长表格源码一进编辑就横着溢出。
       变量随继承链走，编辑态也拿得到。 */
    --lwm-table-max-width: 60em;
}
.lwm-canvas.lwm-panning {
    cursor: grabbing;
}
.lwm-world {
    position: absolute;
    left: 0;
    top: 0;
    transform-origin: 0 0;
    /* 平移层：只写 translate，不携带 scale（见下面的 .lwm-scaler）。
       拖动期间才带 will-change：平移不改变比例，缓存位图直接复用，
       文字不会被拉伸采样。静止时必须撤掉，原因见下面的 .lwm-panning。 */
}
/* 缩放层：只写 scale，挂在平移层里面。
   平时不提升为合成层 —— 浏览器按当前比例直接栅格化文字，任意缩放都清晰。
   注意：will-change 千万不能加在「带 scale 的这一层」上。Chromium 会按 1x
   栅格化被提升的层，scale 变成拿旧位图拉伸，非 100% 缩放下文字整体发虚、
   边缘出现彩边（实测高频能量比原生排版低约 10%~15%）。
   只有滚轮缩放进行中才临时提升（.lwm-zooming），停下后撤掉重新栅格化。 */
.lwm-scaler {
    position: absolute;
    left: 0;
    top: 0;
    transform-origin: 0 0;
}
.lwm-canvas.lwm-zooming .lwm-scaler {
    will-change: transform;
}
/* 只有平移手势进行中才提升为合成层。
   以前空闲时也提前提升（lwm-layer-ready），为的是省掉「拖动第一帧现场建层」
   的几十 ms。但那会让世界层在静止时也是合成层，而合成层里的文字只能用
   灰度抗锯齿：实测次像素彩边完全消失（Laplacian 217 → 192），和实时模式
   并排看就是「有点糊」。两害相权，现在放弃那一点首帧延迟，保证静止时
   文字渲染路径和实时模式完全相同。 */
.lwm-canvas.lwm-panning .lwm-world {
    will-change: transform;
}
/* 「手势期间保持清晰」（设置里可关）：用更高优先级把上面两条 will-change
   覆盖回 auto。手势期间不建合成层，世界层/缩放层始终按当前比例重新栅格化，
   文字在运动中也保留 LCD 次像素抗锯齿。
   实测（无头 Chrome，--disable-gpu，60~74 个可见节点）：
   - 平移：两种模式的帧间隔完全相同（p50 16.5 / p90 17.4，0 帧 >20ms）；
   - 滚轮缩放：默认模式有一帧 41.6ms 的尖峰（层创建/回收），清晰模式
     反而没有（max 17.6ms）。
   也就是说这个开关在当前体量下几乎不花帧率，换来运动中文字不发灰。 */
.lwm-canvas.lwm-crisp.lwm-panning .lwm-world,
.lwm-canvas.lwm-crisp.lwm-zooming .lwm-scaler {
    will-change: auto;
}
.lwm-links {
    position: absolute;
    left: 0;
    top: 0;
    overflow: visible;
    pointer-events: none;
}
.lwm-links path {
    fill: none;
    stroke: var(--lwm-link-color, #5a6472);
    stroke-width: 1.5;
    stroke-linecap: round;
    /* 正交折线的拐角也做圆角，避免 90° 处出现尖刺 */
    stroke-linejoin: round;
}
/* 内链箭头层（.lwm-ilinks，linksSvg 的第一个子元素，压在树连线与节点之下）。
   注意特异性：.lwm-links path 是 (0,1,1)，这里的规则必须用
   .lwm-links path.lwm-ilink-* (0,2,1) 才能压过它。
   命中靠一条 12px 的透明粗线（1.5px 的虚线本身点不中）；父 svg 是
   pointer-events:none，命中线用 pointer-events:stroke 单独打开。 */
.lwm-links path.lwm-ilink-path {
    fill: none;
    stroke: var(--livewritemd-link-color, #338122);
    stroke-width: 1.5;
    stroke-dasharray: 6 4;
    stroke-linecap: round;
    opacity: 0.4;
}
.lwm-ilink-head {
    fill: var(--livewritemd-link-color, #338122);
    opacity: 0.4;
}
.lwm-links path.lwm-ilink-hit {
    fill: none;
    stroke: rgba(0, 0, 0, 0);
    stroke-width: 12;
    pointer-events: stroke;
    cursor: pointer;
}
/* 悬停箭头 / 源或目标节点被选中：全不透明加粗 */
.lwm-ilink:hover path.lwm-ilink-path,
.lwm-ilink.lwm-ilink-active path.lwm-ilink-path {
    opacity: 1;
    stroke-width: 2.5;
}
.lwm-ilink:hover .lwm-ilink-head,
.lwm-ilink.lwm-ilink-active .lwm-ilink-head {
    opacity: 1;
}
/* 内链跳转后的 1s 高亮（canvas.flashNode 写入类名） */
.lwm-node.lwm-node-flash {
    outline: 2px solid var(--livewritemd-link-color, #338122);
    outline-offset: 2px;
}
.lwm-node-layer {
    position: absolute;
    left: 0;
    top: 0;
}
/* 节点包裹元素本身是世界坐标里的绝对定位盒。
   同样不常驻 will-change：每个节点都是独立合成层时，缩放后 Chromium
   会拿旧缩放的位图拉伸采样，文字发虚（理由同 .lwm-world）。
   另外引擎写的是 2D translate()、不是 translate3d()：3D 变换会无条件建层，
   节点文字就只剩灰度抗锯齿。只有正在被拖动的那个节点需要逐帧改 transform，
   才临时提升。 */
.lwm-node-layer > .lwm-node {
    position: absolute;
    left: 0;
    top: 0;
    transform-origin: 0 0;
}
/* 拖动中的节点才需要合成层（每帧改 transform） */
.lwm-node-layer > .lwm-node.lwm-node-dragging {
    will-change: transform;
}
/* 离屏测量层：跟容器同一套 CSS 变量，但不可见、不可交互 */
.lwm-measure {
    position: absolute;
    left: -100000px;
    top: 0;
    visibility: hidden;
    pointer-events: none;
    contain: layout style;
}

/* 拖动落点指示：作为子节点落进去时给目标描边；兄弟间隙显示一条线 */
.lwm-node.lwm-node-dragging {
    opacity: 0.85;
    z-index: 30;
    pointer-events: none;
}
.lwm-node.lwm-node-drop-target {
    outline: 2px dashed var(--vscode-focusBorder, #007fd4);
    outline-offset: 2px;
}
.lwm-drop-line {
    position: absolute;
    left: 0;
    top: 0;
    height: 2px;
    border-radius: 2px;
    background: var(--vscode-focusBorder, #007fd4);
    pointer-events: none;
    z-index: 25;
}

/* 展开 / 折叠圆点 */
.lwm-expand-btn {
    position: absolute;
    left: 0;
    top: 0;
    width: 16px;
    height: 16px;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    border: 1px solid var(--lwm-node-border, #3c3c3c);
    background: var(--vscode-editorWidget-background, #252526);
    color: var(--vscode-editor-foreground, #d4d4d4);
    font: 12px/1 -apple-system, "Segoe UI", sans-serif;
    cursor: pointer;
    user-select: none;
    z-index: 10;
}
.lwm-expand-btn:hover {
    border-color: var(--vscode-focusBorder, #007fd4);
}
/* 展开态中间的减号：不要用字体里的「−」字形 —— 不同字体的字形基线/上下留白
   不一样，放进 16px 圆里看总是偏上或偏下。改用一条固定尺寸的横线，交给
   flex 居中，横线的几何中心就是圆心。 */
.lwm-expand-btn[data-expanded="true"]::before {
    content: '';
    width: 8px;
    height: 1.5px;
    border-radius: 1px;
    background: currentColor;
}
/* 收起态显示被藏起来的节点数（由 data-count 写入）：
   数字比加减号宽，改用胶囊形自适应宽度，最小仍保持 16px 圆点观感 */
.lwm-expand-btn[data-expanded="false"] {
    width: auto;
    min-width: 16px;
    padding: 0 4px;
    border-radius: 8px;
    font-size: 10px;
    font-variant-numeric: tabular-nums;
}
.lwm-expand-btn[data-expanded="false"]::before {
    content: attr(data-count);
}

/* 节点配色：root / 二级 / 其它三层，跟随明暗主题。
   CodeMirror 的背景在节点里强制透明，节点自己的底色/描边才露得出来。 */
#mindmap[data-lwm-theme="dark"] {
    --lwm-link-color: #5a6472;
    /* 展开按钮的描边色（节点本体的描边跟着标题色走，见下面的 .lwm-node） */
    --lwm-node-border: #39414e;
}
#mindmap[data-lwm-theme="light"] {
    --lwm-link-color: #9aa5b1;
    --lwm-node-border: #d7dee6;
}
/* 浅色主题的节点文字 / 纯文本占位：和实时模式一样用纯黑，
   否则节点里的正文会比编辑器正文淡一档（.lwm-node 的 color 会压过继承）。 */
#mindmap[data-lwm-theme="light"] .lwm-node {
    color: #000;
}
.lwm-node .cm-editor {
    background: transparent !important;
}

/* 自定义节点内容：世界坐标里的绝对定位盒。
   排版全面跟随实时模式正文：字体 / 字号 / 字重与 styles.ts 读同一套变量，
   用户在设置里改正文字号缩放（--livewritemd-font-scale）时导图同步变化。
   宽高由引擎测量后写成内联像素值（见 MapCanvas.measureNode）。

   注意：这里不要写会影响内容的 color / font-weight 覆盖，尤其不要按
   data-depth 改文字颜色。节点内容是一份只读的 live 预览，正文色和标题色
   都该和实时模式保持一致；节点外框只负责「容器」的视觉。 */
.lwm-node {
    box-sizing: border-box;
    width: max-content;
    height: auto;
    display: flex;
    align-items: center;
    /* 单元格本身不留内边距 / 外边距：文字贴边由内部 mini-CM 的
       .cm-content 内边距控制，节点盒不再叠加一圈空白 */
    padding: 0;
    margin: 0;
    /* 底色 = 标题色 + 一点透明。具体用哪一个标题色，由 JS 写在元素上的
       --lwm-node-tint 决定（同级轮换，所有层级共用同一套色板）。
       变量没定义时用 h3 的默认色兜底。 */
    --lwm-node-tint: var(--livewritemd-h3-color, #7db5cd);
    /* 底色浓度可配置（设置 → 导图 → 节点底色浓度）：比例越低，底色越淡、
       文字与底的对比度越高，笔画观感越锐利。16% 是默认值，0 即完全透明。
       注意这只是「对比度」旋钮，不是锐化滤镜 —— 字形栅格化路径不变，
       实测 16% → 0% 时同一段文字的 Laplacian 从 119 升到 133（+12%）。 */
    background: color-mix(in srgb, var(--lwm-node-tint) var(--lwm-node-wash, 8%), transparent);
    /* 边框颜色也跟着这个标题色，但透明度更高一些，轮廓才看得清 */
    border: 1px dotted color-mix(in srgb, var(--lwm-node-tint) 62%, transparent);
    border-radius: 8px;
    /* 极轻的投影：普通节点也有「卡片浮在画布上」的层次，但不抢眼 */
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
    font-family: var(--livewritemd-editor-font-family, var(--vscode-editor-font-family, Consolas, monospace));
    font-size: calc(
        var(--livewritemd-editor-font-size, var(--vscode-editor-font-size, 14px)) *
        var(--livewritemd-font-scale, 1)
    );
    font-weight: var(--livewritemd-font-weight, 400);
    /* 节点是单行，行高固定即可：不跟随 --livewritemd-line-height，
       避免倍行距把节点撑高、导图布局整体变形 */
    line-height: 1.5;
    color: var(--vscode-editor-foreground, #d4d4d4);
    white-space: nowrap;
    user-select: none;
}
/* 层级只用边框样式表达（背景色不按等级区分）：
   根 = 3px 实线，一级 = 2px 实线，二级 = 1px 实线（细线），
   三级及以后 = 1px 点线（点线就是上面的默认值，不用再写 data-depth 规则）。
   二级不用虚线：虚线在浅色底上断断续续、和相邻的 1px 点线也难分辨，
   改成一档更细的实线，层级递进就是「粗→中→细→点」。
   这里只改边框，别顺手加 color / font-weight —— 那会连带改变节点里正文
   和标题的颜色，和实时模式对不上。
   这段 CSS 整体是一个模板字符串，注释里千万别写反引号，
   否则会把字符串提前截断，编译出来的代码运行时报 line is not defined。 */
/* 高倍缩放（>=150%，由 canvas.ts 加 class）：把节点底色浓度按倍数压低。
   依据：同一段文字在纯深底上的 Laplacian 比 16% 淡色底高 12%，
   而高倍下正是「读大字」的时候，底色越淡文字越显利。
   浓度由 settingsState 直接算好写成 --lwm-node-wash-hi：
   开启 = 底色浓度 × 0.35（16% → 5.6%），关闭 = 与普通缩放相同。
   不要改成在 color-mix 里写 calc(...)：Chromium 会丢弃整条声明。 */
.lwm-canvas.lwm-hi-zoom .lwm-node {
    background: color-mix(in srgb, var(--lwm-node-tint) var(--lwm-node-wash-hi, 2.8%), transparent);
}
.lwm-node[data-depth="0"] {
    border: 3px solid color-mix(in srgb, var(--lwm-node-tint) 68%, transparent);
}
.lwm-node[data-depth="1"] {
    border: 2px solid color-mix(in srgb, var(--lwm-node-tint) 62%, transparent);
}
.lwm-node[data-depth="2"] {
    border: 1px solid color-mix(in srgb, var(--lwm-node-tint) 62%, transparent);
}

/* 选中 / 多选：统一用焦点色描边。
   以前选中只体现在工具条上，节点本身没有任何视觉反馈；框选多选之后
   必须能一眼看出哪些节点会被删掉，所以选中态直接画在节点外圈。
   用 outline 而不是 border：不参与盒模型，不会让节点尺寸/布局跳一下。 */
.lwm-node.lwm-node-selected {
    outline: 2px solid var(--vscode-focusBorder, #007fd4);
    outline-offset: 2px;
}
/* 框选矩形（屏幕坐标层，见 MapCanvas.updateMarquee）。 */
.lwm-marquee {
    position: absolute;
    z-index: 20;
    pointer-events: none;
    border: 1px solid var(--vscode-focusBorder, #007fd4);
    border-radius: 2px;
    background: color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 12%, transparent);
}

/* =================================================================
 * 文本节点尺寸上限：宽 = --lwm-node-max-width（列=em），
 * 高 = --lwm-node-max-lines 行（line-clamp，超出自动省略号）。
 * 测量走真实 DOM 布局（库把克隆体插进 #mindmap 量 getBoundingClientRect），
 * 所以这里的 max-width / line-clamp 会决定节点的排版尺寸。
 * root 与媒体节点（code/table/image）不吃这套上限。
 * ================================================================= */
.lwm-node-heading,
.lwm-node-list,
.lwm-node-para,
.lwm-node-quote {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: var(--lwm-node-max-lines);
    max-width: var(--lwm-node-max-width);
    overflow: hidden;
    white-space: normal;
    word-break: break-word;
}
/* 用户点开「展开到最大行数」：去掉行数钳制，宽度保持不变 */
.lwm-node.lwm-node-expanded {
    -webkit-line-clamp: unset;
    overflow: visible;
}
`;
