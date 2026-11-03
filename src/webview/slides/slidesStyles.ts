/**
 * 幻灯片模式样式（注入 webview document）。
 *
 * 分两层：
 * - #slides 外壳：工具栏 / 画布区 / 缩略图栏，跟随 VS Code 的界面配色；
 * - .slide-page 16:9 页面：deck 自己的纸 / 墨 / 靛主题、版式与块编辑器修正。
 *
 * 注意：本文件是 CSS 模板字符串，注释里禁止写反引号（会提前截断模板）。
 *
 * @module webview/slides/slidesStyles
 */

import { TOKEN_COLOR_DEFS } from '../codemirror/extensions/livePreview/decor/tokenColors.js';

const FONT_STACK =
    'var(--livewritemd-editor-font-family, "Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif)';

/** 生成某个明暗档的 token 变量表，供 deck 主题作用域覆盖。 */
function tokenVars(mode: 'light' | 'dark'): string {
    return TOKEN_COLOR_DEFS.map(
        (def) => `--lwm-tok-${def.name}: ${def[mode]};`
    ).join(' ');
}

const SLIDES_CSS = `
/* =================================================================
 * 外壳：工具栏 / 画布 / 缩略图栏
 * ================================================================= */
#slides {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family, "Segoe UI", system-ui, sans-serif);
}
#slides[hidden] { display: none !important; }

.slides-toolbar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.22));
    background: var(--vscode-editor-background);
    font-size: 12px;
    user-select: none;
}
.slides-toolbar button {
    font: inherit;
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.3));
    border-radius: 4px;
    padding: 2px 8px;
    cursor: pointer;
}
.slides-toolbar button:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.16));
}
.slides-toolbar .slides-pageinfo {
    min-width: 64px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
    font-variant-numeric: tabular-nums;
}
.slides-toolbar .slides-layout {
    color: var(--vscode-descriptionForeground);
}
.slides-toolbar .slides-spacer { flex: 1 1 auto; }

.slides-stage-wrap {
    flex: 1 1 auto;
    min-height: 0;
    /* 快速卡片栏的定位上下文：栏挂在舞台区（工具栏下方），
       不会压住顶部工具栏，也不会被 .slides-stage 的 scale 带走 */
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 14px;
    /* 同上：只裁剪，不当滚动容器，聚焦内容时不会被滚走 */
    overflow: clip;
    background: var(--vscode-editor-background);
}
.slides-stage-box { position: relative; flex: 0 0 auto; }
/* 缩放包装层：1280×720 设计画布；所有已渲染页面都绝对定位叠在里面，
   当前页 visibility:visible，预加载页 hidden（布局照常，mini-CM 能量高）。 */
.slides-stage {
    position: relative;
    width: 1280px;
    height: 720px;
    transform-origin: top left;
}

/* 主题下拉：按钮 + 浮层菜单（绝对定位在工具栏下方） */
.slides-menu {
    position: relative;
    display: inline-flex;
}
.slides-theme-popover {
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    z-index: 30;
    min-width: 152px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px;
    border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
    border-radius: 6px;
    background: var(--vscode-editorWidget-background, #252526);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
}
.slides-theme-popover[hidden] { display: none; }
.slides-theme-popover button {
    text-align: left;
    border: 1px solid transparent;
    background: transparent;
    color: var(--vscode-foreground);
    padding: 4px 9px;
    border-radius: 4px;
}
.slides-theme-popover button:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.16));
}
.slides-theme-popover button.active {
    border-color: var(--vscode-focusBorder, #007acc);
    color: var(--vscode-focusBorder, #007acc);
}

/* 放映态：铺满 webview（浏览器全屏被拒时的兜底），工具栏浮到底部 */
#slides.slides-presenting {
    position: fixed;
    inset: 0;
    z-index: 1000;
}
#slides.slides-presenting .slides-toolbar {
    position: absolute;
    left: 50%;
    bottom: 18px;
    transform: translateX(-50%);
    z-index: 3;
    padding: 4px 14px;
    border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.4));
    border-radius: 999px;
    box-shadow: 0 6px 22px rgba(0, 0, 0, 0.35);
    background: color-mix(in srgb, var(--vscode-editor-background) 90%, transparent);
    opacity: 0;
    transition: opacity 0.16s ease;
}
#slides.slides-presenting:hover .slides-toolbar,
#slides.slides-presenting .slides-toolbar:focus-within {
    opacity: 1;
}
#slides.slides-presenting .slides-layout,
#slides.slides-presenting .slides-status { display: none; }
#slides.slides-presenting .slides-stage-wrap { padding: 0; }
/* 放映时工具栏贴在底部，主题菜单得向上展开，否则会掉出屏幕 */
#slides.slides-presenting .slides-theme-popover {
    top: auto;
    bottom: calc(100% + 6px);
}

.slides-empty {
    color: var(--vscode-descriptionForeground);
    font-size: 13px;
    padding: 24px;
}

/* 测量宿主：离屏、设计像素宽，不受画布缩放影响 */
.slides-measure {
    position: fixed;
    left: -30000px;
    top: 0;
    width: 1136px;
    visibility: hidden;
    pointer-events: none;
}

/* =================================================================
 * 16:9 页面
 * ================================================================= */
.slide-page {
    position: absolute;
    top: 0;
    left: 0;
    transform-origin: top left;
    width: 1280px;
    height: 720px;
    box-sizing: border-box;
    padding: 56px 72px;
    display: flex;
    flex-direction: column;
    /*
     * 用 clip 而不是 hidden：hidden 的盒子仍然是「可滚动容器」，
     * 聚焦页面里的 mini-CM 时浏览器 / CM 的 scrollIntoView 可以把
     * 页面元素本身滚走（内容溢出时尤其容易触发），表现为「点了这里、
     * 光标却跑到别处」。clip 只裁剪，不产生滚动容器。
     */
    overflow: clip;
    font-family: ${FONT_STACK};
    background: var(--deck-bg);
    color: var(--deck-fg);
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.22);
    --livewritemd-editor-font-size: 28px;
    --livewritemd-editor-font-family: ${FONT_STACK};
    --livewritemd-font-scale: 1;
    /* 行高 / 行内代码缩放继承 live 的用户设置（与 map 节点同一套），
       不再写死 1.5em / 0.9，否则同一段文字在两种视图里排版不同。 */
    --livewritemd-media-width: 100%;
    --livewritemd-media-center-align: left;
    --livewritemd-h1-color: var(--deck-fg);
    --livewritemd-h2-color: var(--deck-fg);
    --livewritemd-h3-color: var(--deck-fg);
    --livewritemd-h4-color: var(--deck-fg);
    --livewritemd-h5-color: var(--deck-fg);
    --livewritemd-h6-color: var(--deck-fg);
}
.slides-measure {
    --livewritemd-editor-font-family: ${FONT_STACK};
    --livewritemd-font-scale: 1;
    /* 行高 / 行内代码缩放继承 live 的用户设置（与 map 节点同一套），
       不再写死 1.5em / 0.9，否则同一段文字在两种视图里排版不同。 */
    --livewritemd-media-width: 100%;
    --livewritemd-media-center-align: left;
    --livewritemd-h1-color: var(--deck-fg);
    --livewritemd-h2-color: var(--deck-fg);
    --livewritemd-h3-color: var(--deck-fg);
    --livewritemd-h4-color: var(--deck-fg);
    --livewritemd-h5-color: var(--deck-fg);
    --livewritemd-h6-color: var(--deck-fg);
}
.slide-page * { box-sizing: border-box; }
.slide-page .cm-editor { background: transparent; }
.slide-page .cm-editor.cm-focused { outline: none; }
/* 内容排版跟随 live / map 节点：cm-content 的 8px 上下内边距、cm-line 的
   4px 左右内边距、行高与字重都直接继承 live 的那一套，幻灯片只覆盖字号、
   页面宽度和 deck 主题。以前这里把 padding 压成 0 / 2px，行高又改成 1.5，
   所以看起来和 map 节点不一致。 */
.slide-page .cm-content { color: inherit; }
.slide-page .cm-scroller { overflow: visible; }
/*
 * 块编辑器的排版宽度必须锁在块内。
 *
 * overflow: visible 会让表格行 / 长代码把自己的 min-content 宽度顶到
 * .cm-scroller 上：一张按正文宽度分好列的表会把 editor 撑到 1700+px，
 * 然后整块被 fitPageElement 等比缩小（字变得很小），而表格列宽其实
 * 完全可以按幻灯片可用宽度重新分配。给 editor / scroller / content
 * 都加上宽度上限，availableWidth(view) 才能拿到块宽度，表格会按它
 * 重新分列；长代码仍由 fitPageElement 的宽度兜底缩放。
 */
.slide-page .cm-editor,
.slides-measure .cm-editor {
    width: 100%;
    max-width: 100%;
}
.slide-page .cm-scroller,
.slides-measure .cm-scroller {
    width: 100%;
    max-width: 100%;
    min-width: 0;
}
.slide-page .cm-content,
.slides-measure .cm-content {
    min-width: 0;
    max-width: 100%;
}
.slide-page .cm-gutters { display: none; }

/*
 * 页面装饰（设置 / 工具栏「边框」）。
 * 画在 padding 留白里，绝对定位不参与 flex 排版，pointer-events:none
 * 保证点空白处不会挡住块的点击编辑。颜色取自 deck 的强调色，透明度
 * 压得很低 —— 目标是「有质感」而不是「加了个框」。
 */
.slide-page.frame-rule::after {
    content: '';
    position: absolute;
    inset: 24px;
    border: 1px solid color-mix(in srgb, var(--deck-accent) 24%, transparent);
    border-radius: 3px;
    pointer-events: none;
}
.slide-page.frame-corners::after {
    content: '';
    position: absolute;
    inset: 22px;
    pointer-events: none;
    --frame-line: color-mix(in srgb, var(--deck-accent) 50%, transparent);
    /* 四角各一条横 + 一条竖，八个渐变叠出 L 形角标 */
    background:
        linear-gradient(var(--frame-line), var(--frame-line)) left top / 30px 1.5px no-repeat,
        linear-gradient(var(--frame-line), var(--frame-line)) left top / 1.5px 30px no-repeat,
        linear-gradient(var(--frame-line), var(--frame-line)) right top / 30px 1.5px no-repeat,
        linear-gradient(var(--frame-line), var(--frame-line)) right top / 1.5px 30px no-repeat,
        linear-gradient(var(--frame-line), var(--frame-line)) left bottom / 30px 1.5px no-repeat,
        linear-gradient(var(--frame-line), var(--frame-line)) left bottom / 1.5px 30px no-repeat,
        linear-gradient(var(--frame-line), var(--frame-line)) right bottom / 30px 1.5px no-repeat,
        linear-gradient(var(--frame-line), var(--frame-line)) right bottom / 1.5px 30px no-repeat;
}

.slide-page .lwm-node-display,
.slides-measure .lwm-node-display {
    width: 100%;
    user-select: text;
    -webkit-user-select: text;
    text-align: left;
}
/* 哨兵行必须压 0 高，否则每个块都会多出一整行 */
.slide-page .lwm-sentinel-line,
.slides-measure .lwm-sentinel-line {
    font-size: 0 !important;
    line-height: 0 !important;
    padding: 0 !important;
    height: 0 !important;
    overflow: hidden !important;
}
/*
 * 这里刻意不覆盖 live 渲染的内部结构（圆点位置、rainbow indent、复制 /
 * 缩放按钮）：PPT 块就是主编辑器那套 mini-CM，显示 ↔ 编辑的切换必须和
 * 正文里一样，否则点一下列表圆点会横跳、代码复制按钮也会凭空消失。
 * 列表缩进色带的几何由 listIndentDecorations 按块内真实字体测量并写成
 * 行内样式，字号放大到 28/30px 时宽度/行高会跟着一起放大 —— 直接沿用
 * live 的结果即可，不要在这里关掉或另写一套。
 */
/*
 * 列表圆点跟随正文字号缩放。
 *
 * live 里圆点是固定 12px 的 SVG（相对 14px 正文约 0.86em），到幻灯片 30px
 * 正文下就只剩 0.4em —— 看起来是「一个几乎看不见的小黑点」，和 live 的
 * 实心圆点明显不一致。这里把盒子改成 0.86em（与 live 的 12/14 同比例），
 * SVG 撑满盒子；垂直方向用 translateY(6px - 50%) 把「圆心」钉回原来的
 * 位置（top 锚的是盒子顶边，盒子变大后不补偿会整体下移）。
 * 只作用于幻灯片 / 幻灯片测量层，主编辑器与导图节点不受影响。
 */
.slide-page .cm-md-bullet-dot,
.slides-measure .cm-md-bullet-dot {
    width: 0.86em;
    height: 0.86em;
    transform: translateY(-50%);
}
.slide-page .cm-md-bullet-dot svg,
.slides-measure .cm-md-bullet-dot svg {
    width: 100%;
    height: 100%;
    display: block;
}
/* 单图块居中；mermaid 白底交给 deck 背景 */
.slide-block.kind-image { --livewritemd-media-center-align: center; }
/*
 * 图片在正文里默认只占 75% 宽（编辑器里的缩放按钮可调）。幻灯片是
 * 按页排版，半栏再打七五折会小得看不清：双栏 / 整页媒体页里让图片
 * 铺满可用宽度，高度由渲染后的等比缩放兜底。
 */
.slide-two-col .col .cm-md-image-wrapper,
.slide-page.layout-media .cm-md-image-wrapper { max-width: 100%; }
.slide-block.kind-mermaid .cm-md-mermaid-wrapper { background: transparent !important; }
/*
 * 宽度档位（±）只在正文 / 导图里生效：幻灯片按页面版式自己决定媒体大小，
 * 预览里调过的百分比（尤其超过 100% 的档位）在这里一律忽略，
 * 否则一张图就能把 16:9 页面撑破。
 */
.slide-block .cm-md-image-wrapper,
.slide-block .cm-md-mermaid-wrapper {
    max-width: 100% !important;
}

/* border-box：嵌套节点的左内边距不能把块撑出页面宽度 */
.slide-block { position: relative; border-radius: 4px; min-width: 0; box-sizing: border-box; }
.slide-block-cm { width: 100%; }
.slide-block:hover {
    outline: 1px dashed color-mix(in srgb, var(--deck-accent) 45%, transparent);
    outline-offset: 6px;
}
/* 超高块拆出来的只读片段：不给可编辑的 hover 提示 */
.slide-block-static:hover { outline: none; }
.slide-block:focus-within {
    outline: 1px solid var(--deck-accent);
    outline-offset: 6px;
}
.slide-block .cm-editor { width: 100%; }
/*
 * 代码块的长行在块内横向滚动，**不参与整页等比缩放**。
 * 以前靠 fitPageElement 按 scrollWidth 把整页缩小来「塞下」长行：
 * 一两行超长代码就会把整页压到 0.4，代码字号小到看不清，页面下半截
 * 还空着。这里用 .slide-block.kind-code 的更高优先级把 scroller 的
 * 横向滚动固定住（覆盖 .slide-page .cm-scroller 的 overflow: visible），
 * 配合 fitPageElement 跳过代码块的 scrollWidth。
 */
.slide-block.kind-code .cm-scroller {
    overflow-x: auto;
    overflow-y: hidden;
}

.slide-header { flex: 0 0 auto; margin-bottom: 20px; }
/* 字号以 slidesModel 的 titleFontSize 为准，这里只是 CSS 兜底 */
.slide-title-block { --livewritemd-editor-font-size: 30px; }
.title-rule {
    width: 76px;
    height: 6px;
    border-radius: 3px;
    background: var(--deck-accent);
    margin-top: 8px;
}
.slide-body {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 16px;
}
.slide-two-col {
    flex: 1 1 auto;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 32px;
    align-content: center;
}
.slide-two-col .col {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 16px;
    justify-content: center;
}
/* 列表分栏：两列从同一基线开始，条目多时顶对齐更像一张清单 */
.slide-list-col { align-content: start; align-items: start; }
.slide-list-col .col { justify-content: flex-start; }
.slide-list-col .slide-block { width: 100%; }
.slide-footer {
    position: absolute;
    left: 72px;
    right: 72px;
    /* 24 = 56 内边距下的 8px 栅格对齐点；页脚仍在 padding 区内，
       不需要从正文可用高度里扣。 */
    bottom: 24px;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    color: var(--deck-muted);
    font-size: 14px;
    letter-spacing: 0.02em;
    /*
     * 页脚横跨整条内容宽度，盖在页面底部留白上。内容超出页面时，
     * 块会一直画进这块留白（页面只在外边框处裁切），于是页脚整条
     * 成了「看得见文字、点下去没反应」的死区 —— 表现就是「点的位置
     * 和光标位置对不上」。页脚只是装饰，必须让点击穿透到下面的块。
     */
    pointer-events: none;
}
.slide-footer-title {
    max-width: 70%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
}
.slide-page-no {
    font-size: 16px;
    /* 等宽数字：翻页时页码不左右跳动 */
    font-variant-numeric: tabular-nums;
    color: var(--deck-page);
}
.slide-cont-title {
    font-size: 26px;
    color: var(--deck-muted);
    display: flex;
    align-items: baseline;
    gap: 10px;
}
.slide-cont-title span { font-size: 17px; }
.overflow-badge {
    position: absolute;
    right: 22px;
    top: 18px;
    padding: 4px 9px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--deck-accent) 14%, transparent);
    color: var(--deck-accent);
    font-size: 13px;
    /* 纯提示：内容溢到页角时别让角标挡住下面的文字点击 */
    pointer-events: none;
}

/* 章节页 */
.layout-section { justify-content: center; padding-left: 120px; }
.section-kicker {
    color: var(--deck-accent);
    font-size: 16px;
    letter-spacing: 0.2em;
    margin-bottom: 14px;
}
.section-inner { width: 100%; }
.section-inner .slide-title-block { --livewritemd-editor-font-size: 42px; }

/* 金句页：一句话居中大字，标题降级成 kicker */
.layout-statement {
    justify-content: center;
    align-items: center;
    text-align: center;
    padding: 56px 160px;
}
.statement-inner { width: 100%; }
.statement-kicker {
    color: var(--deck-accent);
    font-size: 20px;
    font-weight: 500;
    letter-spacing: 0.16em;
    margin-bottom: 28px;
}
.layout-statement .slide-block { --livewritemd-line-height: 1.25em; }
/* .lwm-node-display 默认左对齐，金句 / 大数字页要压回居中 */
.layout-statement .lwm-node-display,
.layout-statement .cm-line,
.layout-fact .lwm-node-display,
.layout-fact .cm-line { text-align: center; }

/* 大数字页：整段 96px 加粗居中，点任意位置整段编辑 */
.layout-fact {
    justify-content: center;
    align-items: center;
    text-align: center;
    padding: 56px 160px;
}
.fact-inner { width: 100%; }
.layout-fact .slide-block { --livewritemd-line-height: 1.05em; font-weight: 700; }

/* 半幅图：页面取消内边距；左列文字留白，右列图片满幅裁切 */
.layout-image-split { padding: 0; }
.layout-image-split .slide-two-col {
    gap: 0;
    align-content: stretch;
}
.layout-image-split .slide-two-col .col { justify-content: center; }
.layout-image-split .col-text { padding: 64px 56px 64px 72px; }
.layout-image-split .col-media {
    position: relative;
    padding: 0;
    overflow: hidden;
}
/* 图片块铺满整列：绝对定位避免百分比高度在 CM 行盒里解析不了 */
.layout-image-split .col-media .slide-block.kind-image {
    position: absolute;
    inset: 0;
}
.layout-image-split .col-media .slide-block.kind-image .cm-editor,
.layout-image-split .col-media .slide-block.kind-image .cm-scroller,
.layout-image-split .col-media .slide-block.kind-image .cm-content,
.layout-image-split .col-media .slide-block.kind-image .cm-line {
    height: 100%;
}
.layout-image-split .col-media .cm-md-image-line,
.layout-image-split .col-media .cm-md-image-wrapper,
.layout-image-split .col-media .cm-md-image-content {
    width: 100%;
    height: 100%;
    max-width: none;
}
.layout-image-split .col-media .cm-md-image-wrapper { display: block; }
.layout-image-split .col-media .cm-md-image {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: 0;
}

/* 结束页：只有大标题 + 一行署名 */
.layout-end {
    justify-content: center;
    align-items: center;
    text-align: center;
}
.end-inner { display: flex; flex-direction: column; align-items: center; }
.end-title {
    font-size: 60px;
    font-weight: 600;
    letter-spacing: -0.01em;
}
.end-sub {
    margin-top: 22px;
    font-size: 20px;
    color: var(--deck-muted);
    letter-spacing: 0.2em;
}

/* 封面 */
.layout-cover {
    justify-content: center;
    align-items: flex-start;
    padding-left: 120px;
    background: linear-gradient(135deg, var(--deck-bg) 0%, var(--deck-cover-2) 100%);
}
.cover-inner { max-width: 940px; }
.cover-title {
    font-size: 76px;
    line-height: 1.12;
    font-weight: 600;
    letter-spacing: -0.012em;
}
.cover-rule {
    width: 120px;
    height: 8px;
    border-radius: 4px;
    background: var(--deck-accent);
    margin: 34px 0 26px;
}
.cover-subtitle {
    font-size: 30px;
    color: var(--deck-muted);
    line-height: 1.4;
}
.cover-meta {
    display: flex;
    gap: 22px;
    margin-top: 34px;
    font-size: 17px;
    color: var(--deck-muted);
}

/* =================================================================
 * deck 主题（页面 + 测量宿主 + 块编辑器的文字/代码颜色）
 * ================================================================= */
/*
 * 主题 token（11 个）：
 *   bg/fg/muted/accent/cover-2  —— 页面基础
 *   surface/border/link/code-fg —— 代码、表格、链接
 *   selection/page              —— 选中背景、页码
 *
 * 兼容层把 live 渲染管线里写死的 --vscode-* 映射到 deck token，
 * 这样 tokenColors / 表格 / 行内代码一行都不用改就跟着主题走。
 * color-mix 只在兼容层用，方便以后换 token 值时自动协调。
 */
.deck-paper {
    --deck-bg: #faf8f3; --deck-fg: #1f2328; --deck-muted: #6b6f76;
    --deck-accent: #c2410c; --deck-cover-2: #f1e9dc;
    --deck-surface: #f2ece1; --deck-border: #ddd2bf;
    --deck-link: #9a3412; --deck-code-fg: #1f2328;
    --deck-selection: rgba(194, 65, 12, 0.18); --deck-page: #7a7f86;

    --vscode-editor-background: var(--deck-bg);
    --vscode-editor-foreground: var(--deck-fg);
    --vscode-editorCursor-foreground: var(--deck-accent);
    --vscode-textCodeBlock-background: var(--deck-surface);
    --vscode-textPreformat-background: color-mix(in srgb, var(--deck-surface) 88%, var(--deck-border));
    --vscode-textPreformat-foreground: var(--deck-code-fg);
    --vscode-textLink-foreground: var(--deck-link);
    --vscode-textLink-activeForeground: var(--deck-link);
    --vscode-textBlockQuote-border: var(--deck-border);
    ${tokenVars('light')}
}
.deck-indigo {
    --deck-bg: #eef1fa; --deck-fg: #1c2340; --deck-muted: #5d6684;
    --deck-accent: #0e7490; --deck-cover-2: #dfe6f7;
    --deck-surface: #e3e8f8; --deck-border: #cbd4ec;
    --deck-link: #0e7490; --deck-code-fg: #1c2340;
    --deck-selection: rgba(14, 116, 144, 0.18); --deck-page: #5d6684;

    --vscode-editor-background: var(--deck-bg);
    --vscode-editor-foreground: var(--deck-fg);
    --vscode-editorCursor-foreground: var(--deck-accent);
    --vscode-textCodeBlock-background: var(--deck-surface);
    --vscode-textPreformat-background: color-mix(in srgb, var(--deck-surface) 88%, var(--deck-border));
    --vscode-textPreformat-foreground: var(--deck-code-fg);
    --vscode-textLink-foreground: var(--deck-link);
    --vscode-textLink-activeForeground: var(--deck-link);
    --vscode-textBlockQuote-border: var(--deck-border);
    ${tokenVars('light')}
}
.deck-ink {
    --deck-bg: #15171c; --deck-fg: #e6e8eb; --deck-muted: #8d94a0;
    --deck-accent: #7aa2ff; --deck-cover-2: #1e2430;
    --deck-surface: #1e2430; --deck-border: #2f3745;
    --deck-link: #9db8ff; --deck-code-fg: #e6e8eb;
    --deck-selection: rgba(122, 162, 255, 0.25); --deck-page: #8d94a0;

    --vscode-editor-background: var(--deck-bg);
    --vscode-editor-foreground: var(--deck-fg);
    --vscode-editorCursor-foreground: var(--deck-accent);
    --vscode-textCodeBlock-background: var(--deck-surface);
    --vscode-textPreformat-background: color-mix(in srgb, var(--deck-surface) 88%, var(--deck-border));
    --vscode-textPreformat-foreground: var(--deck-code-fg);
    --vscode-textLink-foreground: var(--deck-link);
    --vscode-textLink-activeForeground: var(--deck-link);
    --vscode-textBlockQuote-border: var(--deck-border);
    ${tokenVars('dark')}
}

/* 选中背景也走 deck 配色，避免在纸色页面上出现一块深色高亮 */
.slide-page ::selection {
    background: var(--deck-selection);
}
`;

/** 幂等注入幻灯片样式。 */
export function ensureSlidesCss(): void {
    const id = 'lwm-slides-style';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = SLIDES_CSS;
    document.head.appendChild(style);
}
