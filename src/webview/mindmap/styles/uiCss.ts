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
/* 编辑态：滚动容器从节点盒换成了 .cm-scroller（节点盒 overflow:hidden）。
   但 .lwm-node 的通用规则把子树里的原生滚动条全隐藏了 —— 编辑一段长代码时
   完全看不到「还能上下滚」，像内容被截断。这里把编辑态 scroller 的
   滚动条放出来（显示态节点盒自己的滚动条不受影响）。
   注意：本文件是 CSS 模板字符串，注释里禁止出现反引号。 */
.lwm-node.lwm-node-editing .cm-scroller {
    scrollbar-width: thin !important;
}
.lwm-node.lwm-node-editing .cm-scroller::-webkit-scrollbar {
    display: block !important;
    width: 10px !important;
    height: 10px !important;
}
.lwm-node.lwm-node-editing .cm-scroller::-webkit-scrollbar-thumb {
    background: rgba(128, 128, 128, 0.5);
    border-radius: 5px;
}
.lwm-node.lwm-node-editing .cm-scroller::-webkit-scrollbar-corner {
    background: transparent;
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

/* =================================================================
 * 快速卡片栏（右边界）
 *
 * 外框视觉（底色 / 点线描边 / 圆角 / 投影 / 字体 / 选中描边）全部复用
 * .lwm-node 那套规则（见 canvasCss 的共用选择器），这里只写卡片独有的部分：
 * - 左侧 4px 色条：收起态唯一露出来的东西；
 * - 收起 = 整张卡片右移（translateX），hover / 选中 / 编辑时滑回原位；
 * - 宽度 = 全局设置 quickCardWidth（拖动左边界改，没有上限），
 *   高度跟内容走；摆放区 = 视口顶部 → 缩略图顶部，
 *   放得下就平铺，放不下就按封顶高度重叠（后一张盖住前一张，
 *   见 JS layoutStack）；
 * - 交互与节点一致：单击选中并出工具条（.lwm-node-selected 的焦点色
 *   描边），再点一下 / 双击进入编辑（光标落在点击处），
 *   右键菜单复用 .lwm-context-menu；选中后可以拖进画布变成节点。
 *
 * 为什么用 transform 平移而不是 clip-path：收起要露的是**左**边缘，
 * 卡片必须整体滑到画布右边界外，露出左 4px。平移不动布局宽度，
 * 展开 / 收起不会让卡内 mini-CM 重新折行；平移后卡片的命中区域也跟着
 * 移出画布，画布照常可用。堆叠区不再自带滚动 / 裁剪，平移出去的部分
 * 由 #mindmap 的 overflow:hidden 统一裁掉。
 * ================================================================= */
.lwm-qcards {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    /* 压住缩略图（15），但让节点工具条（20）保持在上面：
       卡片栏展开时不该挡住正在操作的节点按钮 */
    z-index: 18;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    justify-content: center;
    /* 宽度 = 全局卡片宽度（拖动卡片左边界改的就是这个变量，没有上限） */
    width: var(--lwm-qcard-width, 280px);
    /* 整条栏不接指针事件：收起后的卡片只在边缘色条上响应，
       其余空白处点击直接落到画布 */
    pointer-events: none;
    /* 裁在本列自己的盒子里（= 摆放区：视口顶部 → 缩略图顶部）。
       收起态卡片平移出去后只剩左 4px 色带，正好还在盒内；
       展开的长卡片不会再盖到右下角缩略图上 */
    overflow: hidden;
}

/* live 模式：卡片栏挂在 #editor-pane 上（没有 #mindmap 画布）。
   右侧让出正文自定义滚动条的宽度（14px），否则收起态只剩的那 4px
   色条会被滚动条透明的轨道盖住，鼠标永远悬停不到、卡片展不开。 */
#editor-pane > .lwm-qcards {
    right: 16px;
}

/* 拖卡片进正文时的落点指示线：位置由 JS 按指针所在行写 */
.lwm-qcards-live-dropmark {
    position: absolute;
    height: 2px;
    border-radius: 1px;
    background: var(--vscode-focusBorder, #007fd4);
    box-shadow: 0 0 6px color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 65%, transparent);
    pointer-events: none;
    z-index: 30;
    display: none;
}

/* 卡片堆叠区：整条右侧列都是摆放区（从视口顶部到右下角缩略图顶部，
   高度由 JS 写进宿主的 height）。
   卡片是**绝对定位**的，top 由 layoutStack 一次算好：用 flex 流式排列的话，
   某张卡片展开时高度变化会把后面的卡片一起顶动，鼠标一移过去侧边就重排。
   卡片自己的超出部分由 .lwm-qcard 的 clip-path 按可见高度裁掉；
   平移出画布右边界的那部分由宿主 .lwm-qcards 的 overflow:hidden 裁掉。
   本层保持 visible，别在这里再裁一次（会把展开态也裁掉） */
.lwm-qcards-stack {
    position: relative;
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
}

/* 兜底：卡片多到摆放区放不下时，JS 给宿主写 data-scrollable 并加内联
   overflow-y:auto。stack 改成跟随内容自然高度（不再按宿主高度裁），
   宿主给一条窄滚动条即可。宿主仍保持 pointer-events:none：滚轮事件交给
   JS 转发，别改成 auto，否则整条右侧栏会挡住画布。 */
.lwm-qcards[data-scrollable="true"] {
    overflow-y: auto;
    scrollbar-width: thin;
}
.lwm-qcards[data-scrollable="true"] .lwm-qcards-stack {
    height: auto;
}

/* 拖拽插入位置指示线：拖节点 / 拖卡片到侧边时，标出会插到第几张之间。
   挂在宿主上（不是 stack 里），position 相对宿主，top 由 JS 写 */
.lwm-qcards-dropmark {
    position: absolute;
    left: 0;
    right: 0;
    height: 2px;
    border-radius: 1px;
    background: var(--vscode-focusBorder, #007fd4);
    box-shadow: 0 0 6px color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 65%, transparent);
    /* 高于所有卡片（z-index = 序号，同一 stacking context 里） */
    z-index: 1000;
    pointer-events: none;
}

/* 节点拖到侧边上时的高亮：整列给一层淡淡的强调 */
.lwm-qcards[data-drop="true"] {
    background: color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 12%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 45%, transparent);
}

/* 单张卡片：外框视觉来自 .lwm-qcard 共用的节点规则，这里只加卡片自己的东西 */
.lwm-qcard {
    /* 绝对定位：top 由 layoutStack 写死，展开 / 收起高度变化不影响其它卡片 */
    position: absolute;
    left: 0;
    top: 0;
    /* 宽度统一跟设置走；高度跟内容走，长内容自动长高 */
    width: 100%;
    max-width: none;
    height: auto;
    overflow: hidden;
    /* 卡片底不透明：默认的 8% 透明底会把画布内容透出来，读不清。
       混进编辑器底色，等于在节点的 tint 底色上垫一层白/黑底 */
    background: color-mix(
        in srgb,
        var(--lwm-node-tint) var(--lwm-node-wash, 8%),
        var(--vscode-editor-background, #1e1e1e)
    );
    /* 左边这条实色就是收起态唯一露出来的东西：4px 宽，颜色取卡片自己的色 */
    border-left: 4px solid color-mix(in srgb, var(--lwm-node-tint) 78%, transparent);
    /* 上边框不单独加深：深色横线在收起态的 4px 色带上会多出一截很显眼的
       黑边，用户明确要求去掉。顶端分界由卡片自己的（浅色）描边负责 */
    /* 收起：整体右移到画布边界外，只留左边缘那条色带。
       4px 是色带宽；平移量 = 卡片宽 - 4px */
    transform: translateX(calc(100% - 4px));
    transition: transform 0.16s ease-out;
    pointer-events: auto;
    cursor: pointer;
    user-select: none;
}
/* 被压缩的卡片自己只画到「可见高度」（layoutStack 写 --lwm-qcard-visible）。
   不裁的话卡片左侧那条 border 会按自然高度继续往下画，越过下一张卡片的
   顶边（收起态的下一张只画出 4px 宽的边框，盖不住它）。
   只在真正被压缩时才裁：clip-path 会把盒子外的投影一起裁掉，没压缩的卡片
   不该丢阴影。clip-path 不影响 offsetHeight，下一轮还能量到自然高度 */
.lwm-qcard[data-clipped="true"] {
    clip-path: inset(0 0 calc(100% - var(--lwm-qcard-visible, 100%)) 0);
}

/* 选中描边：节点用外圈 outline（见 canvasCss），但卡片栏宿主是
   overflow:hidden，外圈描边会在卡片左右两侧被裁掉。卡片改用 inset
   阴影画一圈焦点色（box-shadow 同样不参与盒模型，不影响摆放几何）。
   顺带保留节点那套基础投影，避免选中瞬间投影消失闪一下。 */
.lwm-qcard.lwm-node-selected {
    outline: none;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18),
        inset 0 0 0 2px var(--vscode-focusBorder, #007fd4);
}
/* 键盘焦点（JS 给卡片加 tabindex=0）：负 offset 把焦点环画在盒内，
   避免被宿主 overflow:hidden 裁掉。编辑态由下面的 editing 规则统一清掉。 */
.lwm-qcard:focus-visible {
    outline: 2px solid var(--vscode-focusBorder, #007fd4);
    outline-offset: -2px;
}

/* 展开：悬停的那一张 / 选中的 / 编辑中的，整张卡片向左滑出来。
   层次靠 z-index 递增（下面的卡片盖住上面的卡片）：展开的卡片不提层级，
   所以它下面的卡片收起后那条 4px 边框仍然画在它右边缘之上；它上面的卡片
   收起后则被展开卡片的底色盖住。
   高度在这里不裁：整张卡片滑出来。 */
.lwm-qcard:hover,
.lwm-qcard.lwm-node-selected,
.lwm-qcard[data-editing="true"],
.lwm-qcard[data-pinned="true"] {
    transform: translateX(0);
    clip-path: none;
}
/* 固定（右键菜单）：取消选中 / 鼠标移开也保持展开，方便对照着操作画布。
   与 hover 展开同一套高度上限：越过缩略图顶部时卡片内部滚动。 */
.lwm-qcard[data-pinned="true"] .lwm-qcard-body {
    max-height: var(--lwm-qcard-max-h, none);
    overflow-y: auto;
    overscroll-behavior: contain;
}
/* 固定态的小圆点：不打扰正文，只提示「这张是钉住的，不是悬停展开」 */
.lwm-qcard[data-pinned="true"]::after {
    content: '';
    position: absolute;
    top: 6px;
    right: 6px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--vscode-focusBorder, #007fd4);
    opacity: 0.75;
    pointer-events: none;
}
/* 展开时如果会越过右下角缩略图，底部就停在缩略图顶部，内部可以滚动；
   放得下（max-height 大于自然高度）时和原来一样，不出现滚动 */
.lwm-qcard:hover .lwm-qcard-body,
.lwm-qcard.lwm-node-selected .lwm-qcard-body,
.lwm-qcard[data-editing="true"] .lwm-qcard-body {
    max-height: var(--lwm-qcard-max-h, none);
    overflow-y: auto;
    overscroll-behavior: contain;
}
/* 测量态：layoutStack 量卡片自然高度时会临时给宿主加 lwm-qcards-measuring，
   必须解除上面的 max-height / overflow，否则 offsetHeight 会被封顶高度截断，
   算出来的摆放位置全部偏小。 */
.lwm-qcards-measuring .lwm-qcard-body {
    max-height: none !important;
    overflow: visible !important;
}
/* 编辑中不画任何描边 / 焦点环：卡片已经展开（transform 归零），再套蓝框
   看起来就是「编辑区边界」。选中态改成了 inset 阴影，这里也要把它清掉，
   只保留节点那套基础投影；:focus-visible 的特异性更高，一并列出。 */
.lwm-qcard[data-editing="true"],
.lwm-qcard[data-editing="true"]:focus-visible {
    outline: none;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
}
/* 草稿卡片（还没写回文档）：虚线提醒「还没落地」 */
.lwm-qcard-draft {
    border-style: dashed;
}

/* 卡片正文：节点显示态那套 mini-CM（字体 / 行高由 CM 主题给），
   只留一圈内边距，高度随内容 */
.lwm-qcard-body {
    box-sizing: border-box;
    width: 100%;
    /* 与普通节点一致：编辑器内部不留内边距 */
    padding: 0;
    text-align: left;
    cursor: text;
    user-select: text;
}
/* mini-CM 主题自带 .cm-content { padding: 2px 0 }，卡片里压成全 0 */
.lwm-qcard .cm-content {
    padding: 0 !important;
}
/* 编辑中不显示左边界拖手：铺平 0 内边距后它会盖住开头几个字 */
.lwm-qcard[data-editing="true"] .lwm-qcard-resize {
    display: none;
}
/* 拖动中：淡一点 + 手型，提示正在往外拖 */
.lwm-qcard-dragging {
    opacity: 0.6;
    cursor: grabbing !important;
}

/* 左边界拖手：压在 4px 色带上，往左拖变宽、往右拖变窄（全局生效）。
   卡片 overflow:hidden，所以从 0 开始画（负偏移会被裁掉）。
   默认透明且不接事件：收起态只剩左 4px 色条，常驻的拖手会把它整个盖住，
   看起来像鼠标一碰就变宽。只有卡片真正展开时才显示。 */
.lwm-qcard-resize {
    position: absolute;
    z-index: 2;
    left: 0;
    top: 0;
    bottom: 0;
    width: 10px;
    cursor: ew-resize;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.16s ease-out;
}
/* 展开（hover / 选中 / 编辑）时显出拖手。编辑态另有 display:none
   （见上面「编辑中不显示左边界拖手」），实际仍不会盖住正文。 */
.lwm-qcard:hover .lwm-qcard-resize,
.lwm-qcard.lwm-node-selected .lwm-qcard-resize,
.lwm-qcard[data-editing="true"] .lwm-qcard-resize {
    opacity: 1;
    pointer-events: auto;
}

/* 加号：它就是一张「带加号的侧边卡片」——外框、收起 / 悬浮展开、
   层叠顺序全部沿用 .lwm-qcard，只有内容是一个加号、点击语义是新建卡片。
   宽度固定两个字符，不跟全局卡片宽度走（它只是一枚按钮，不需要
   展开成整张卡片的宽度） */
.lwm-qcard.lwm-qcards-add {
    display: flex;
    align-items: center;
    justify-content: center;
    /* 卡片都是绝对定位（left:0）：加号比普通卡片窄，靠右站 */
    left: auto;
    right: 0;
    /* 宽度 = 两个汉字宽（2em），不跟全局卡片宽度走 */
    width: 2em;
    min-width: 2em;
    min-height: 26px;
    padding: 0;
    /* 固定深蓝：加号是操作入口，不参与卡片的标题色轮换。
       描边 / 底色 / 收起色条 / 图标全跟着这个变量走，改一处即可 */
    --lwm-node-tint: #1e3a8a;
    /* SVG 图标用 currentColor，就是上面这抹深蓝 */
    color: var(--lwm-node-tint);
    transition: transform 0.16s ease-out, background 0.16s ease-out;
}
/* 加号图标：内联 SVG（圆头描边），尺寸固定，不跟字体走。
   字体里的「＋」各字体基线不一，塞进小卡片总是偏上或偏下 */
.lwm-qcards-add-icon {
    display: block;
    width: 12px;
    height: 12px;
    flex: none;
}
.lwm-qcards-add:hover {
    background: color-mix(
        in srgb,
        var(--lwm-node-tint) 22%,
        var(--vscode-editor-background, #1e1e1e)
    );
}
/* 加号颜色按主题分档：浅色沿用默认深蓝（#1e3a8a，在浅底上够醒目）；
   深色底下深蓝太暗，换成浅蓝。--lwm-node-tint 同时驱动背景 wash、
   描边、收起色条和图标 currentColor，只改变量就能整体对齐。
   高对比度主题放在最后：VS Code 的高对比模式 body 上还带 vscode-dark /
   vscode-light，靠源顺序让高对比色生效。 */
body.vscode-dark .lwm-qcard.lwm-qcards-add {
    --lwm-node-tint: #93c5fd;
    color: var(--lwm-node-tint);
}
body.vscode-high-contrast .lwm-qcard.lwm-qcards-add {
    --lwm-node-tint: var(--vscode-contrastActiveBorder, #ffffff);
    color: var(--lwm-node-tint);
}

/* 复制提示词后的小浮条（挂在 body 上，右下角淡入淡出） */
.lwm-qcards-toast {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 70;
    box-sizing: border-box;
    max-width: 320px;
    padding: 6px 12px;
    border-radius: 6px;
    background: var(--vscode-notifications-background, var(--vscode-editorWidget-background, #252526));
    color: var(--vscode-notifications-foreground, var(--vscode-editor-foreground, #d4d4d4));
    border: 1px solid var(--vscode-notifications-border, var(--vscode-panel-border, #3c3c3c));
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    font-size: 12px;
    pointer-events: none;
    opacity: 0;
    transform: translateY(4px);
    transition: opacity 0.16s ease-out, transform 0.16s ease-out;
}
.lwm-qcards-toast[data-show='true'] {
    opacity: 1;
    transform: translateY(0);
}
`;
