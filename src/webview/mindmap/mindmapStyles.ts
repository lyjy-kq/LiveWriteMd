/**
 * 导图模式的样式文本（注入到 webview document）。
 *
 * simple-mind-map 自身的 css 由库实例化时注入（smm-* 类）；
 * 这里只管本项目自定义节点内容 / 容器 / 后续编辑浮层。
 */

import { ensureTokenColorCss } from '../codemirror/extensions/livePreview/tokenColors.js';

export const MINDMAP_CSS = `
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
 * 缩放降级档（容器 data-lwm-tier，由 MapCanvas 随缩放写入）
 * 2 = 纯文本档：节点内容已是纯文本占位，这里再去掉投影和圆角装饰，
 *     只保留「节点框 + 连线」这两种基本图形（缩到很小时也看不清细节，
 *     少一层像素合成就少一分卡顿）。
 * ================================================================= */
#mindmap[data-lwm-tier="2"] .lwm-node {
    box-shadow: none;
    border-radius: 4px;
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
.lwm-node-para {
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
   让库量出的节点尺寸与换真后基本一致（不位移） */
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
/* 表格节点：不限宽高，尽量全部渲染（任务 12） */
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
/* 节点过多自动开启性能模式的一次性提示 */
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
