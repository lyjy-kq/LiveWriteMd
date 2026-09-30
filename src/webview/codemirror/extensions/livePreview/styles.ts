/**
 * Live Preview Styles
 *
 * EditorView.baseTheme() CSS-in-JS definitions for all live preview elements.
 *
 * Colors are hardcoded (not CSS variables) so that FlowMD's theme override
 * works independently of VS Code's active color theme. Dark colors are the
 * default; light overrides use the `&light` baseTheme prefix.
 *
 * @module webview/codemirror/extensions/livePreview/styles
 */

import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

/**
 * Creates the base theme extension with all live preview CSS styles.
 */
export function createBaseThemeStyles(): Extension {
    return EditorView.baseTheme({
        // =================================================================
        // Override default syntax highlighting (remove dated styles)
        // =================================================================
        '.cm-line .tok-heading': {
            textDecoration: 'none',
            fontWeight: 'inherit',
            color: 'inherit',
        },
        '.cm-line .tok-heading1, .cm-line .tok-heading2, .cm-line .tok-heading3': {
            textDecoration: 'none',
            fontWeight: 'inherit',
            color: 'inherit',
        },
        '.cm-line .tok-heading4, .cm-line .tok-heading5, .cm-line .tok-heading6': {
            textDecoration: 'none',
            fontWeight: 'inherit',
            color: 'inherit',
        },

        // =================================================================
        // Headings - Modern & clean
        // =================================================================
        '.cm-md-heading': {
            lineHeight: '1.6',
        },
        '.cm-md-heading-1': {
            fontSize: '1.2em',
            fontWeight: '700',
            letterSpacing: '-0.02em',
            color: '#eb8383',
        },
        '.cm-md-heading-2': {
            fontSize: 'inherit',
            fontWeight: '600',
            letterSpacing: '-0.01em',
            color: '#ae9acb',
        },
        '.cm-md-heading-3': {
            fontSize: 'inherit',
            fontWeight: '600',
            color: '#7db5cd',
        },
        '.cm-md-heading-4': {
            fontSize: 'inherit',
            fontWeight: '600',
            color: '#71a796',
        },
        '.cm-md-heading-5': {
            fontSize: 'inherit',
            fontWeight: '600',
            color: '#dcbf61',
        },
        '.cm-md-heading-6': {
            fontSize: 'inherit',
            fontWeight: '600',
            color: '#dda36a',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
        },

        // =================================================================
        // Bold & Italic
        // =================================================================
        // line-height: 1 —— 见上面行内代码那段的说明：渲染态的盒子只要和正文的
        // 行高不一样（粗体面、等宽体的 ascent/descent 分布都和正文不同），
        // 行盒就可能被顶高零点几个像素，聚焦展开时又落回正文行高，
        // 于是「点一下，下面整块跟着上下跳一下」。盒子压到 1em 之后就永远躲在正文行盒里。
        '.cm-md-bold': {
            fontWeight: '700',
            lineHeight: '1',
            color: '#d9a37a',
        },
        // 斜体只变色、不倾斜：合成斜体（italic）默认约 14°，斜得过头；
        // 字体自带真斜体时又不受角度控制，所以干脆只用颜色区分。
        '.cm-md-italic': {
            fontStyle: 'normal',
            lineHeight: '1',
            color: '#2bbac5',
        },
        '.cm-md-strikethrough': {
            textDecoration: 'line-through',
            lineHeight: '1',
            opacity: '0.6',
        },

        // =================================================================
        // Markdown 标记符（编辑态）
        // =================================================================
        // 块级标记（`# `、`> `、围栏）平时压成 0 宽：渲染态本来就是隐藏的，
        // 编辑态若原样显示，整行连同缩进都会挪。注意不能用 display:none /
        // visibility:hidden，那样字符无法测量、光标会飘；font-size:0 只是
        // 让字形不占宽度，布局仍然正常，光标照样能停在上面。
        '.cm-md-src-mark': {
            fontSize: '0',
            letterSpacing: '0',
            // line-height 必须是 1，**不能继承正文的 23.8px**：
            // 字号为 0 的盒子如果还顶着 23.8px 的行高，那 23.8px 会以基线为中心
            // 上下摊开（每边 11.9px），而正文的基线下面只留 7px，于是整行被顶高约 5px。
            // 代码块围栏 ` ``` ` 平时就是这么压 0 宽的 —— 光标一进代码块、
            // 上下两行被顶高，整块内容跟着往下挪，屏幕上就是「抖一下」。
            // 设成 1 之后盒高为 0（字号 0 × 行高 1），安安静静躲在正文撑起的行盒里。
            lineHeight: '1',
        },
        // 光标/选区进入块级标记内部时展开：正常字号 + 弱化颜色
        '.cm-md-src-mark-active': {
            color: '#7d8590',
        },
        '&light .cm-md-src-mark-active': {
            color: '#8a8f98',
        },
        // 行内元素展开态（`**加粗**`）：外层缩放在行内 style 里给（见 focusMarks.ts），
        // 这里只负责把标记符压灰，以及把行内代码的样式改成「跟着一起缩」。
        '.cm-md-src-delim': {
            color: '#7d8590',
        },
        '&light .cm-md-src-delim': {
            color: '#8a8f98',
        },
        // 展开态（`**加粗**`）是纯文本，字号在行内 style 里整体缩放。
        //
        // 这里必须把 line-height 设成 1，**不能继承正文的 23.8px**：
        // 正文的行高是按正文字号算出来的绝对像素值，缩小的字再套这个值，
        // 上下半行距（half-leading）会把它的盒子往下撑出一截，
        // 于是「聚焦一个行内元素时，本行和下一行的间距多了一丝」（实测 +1px）。
        // 设成 1 之后盒高只有自己的字号那么高，永远躲在正文撑起来的行盒里。
        // font-family / 内边距同理：等宽字体的 ascent/descent 也会顶高行盒。
        '.cm-md-src-open, .cm-md-src-open *': {
            lineHeight: '1',
            fontFamily: 'inherit',
            paddingTop: '0',
            paddingBottom: '0',
        },

        // =================================================================
        // Inline code
        // =================================================================
        // 字号只用比正文小一点点（0.95em），而且必须是**相对单位**：
        // 原来写的是 var(--vscode-editor-font-size)，那是个绝对像素值，
        // 正文一旦被「字体缩放」（--flowmd-font-scale）放大，代码还是老大小，
        // 看起来就小了一大截。
        // line-height 设成 1 和展开态同理：等宽字体的 ascent/descent 分布和正文不同，
        // 行盒高度取的是「最大 ascent + 最大 descent」，两块盒子的分布一不一样就会多出零点几像素，
        // 于是「渲染态比文本态高一点」，切来切去整行下面就会跳。
        '.cm-md-code': {
            fontFamily:
                'var(--vscode-editor-font-family, "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace)',
            fontSize: '0.95em',
            lineHeight: '1',
            fontWeight: 'var(--flowmd-font-weight, 400)',
            backgroundColor: '#f0ece0',
            padding: '2px 6px',
            borderRadius: '4px',
            color: '#f29a9a',
        },
        '&light .cm-md-code': {
            backgroundColor: '#eff1f3',
            color: '#f29a9a',
        },

        // 被 widget 顶替掉的源码（行内公式、单元格复选框）：压 0 宽藏起来，
        // 内容由 widget 画在旁边（见 decorations.ts 的 hiddenSourceDeco）
        '.cm-md-src-hidden': {
            fontSize: '0',
            letterSpacing: '0',
            // 同上：行内公式的源码也是压在 0 宽里，行高必须跟着归零，否则整行会被顶高
            lineHeight: '1',
        },

        // =================================================================
        // Links
        // =================================================================
        '.cm-md-link, .cm-md-file-link': {
            color: '#338122',
            textDecoration: 'underline',
            textDecorationColor: '#338122',
            textDecorationSkipInk: 'auto',
            textUnderlineOffset: '3px',
            cursor: 'pointer',
            transition: 'opacity 0.15s ease',
        },
        '.cm-md-link:hover, .cm-md-file-link:hover': {
            opacity: '0.8',
        },
        '&light .cm-md-link, &light .cm-md-file-link': {
            color: '#338122',
            textDecorationColor: '#338122',
        },

        // =================================================================
        // Blockquotes
        // =================================================================
        '.cm-md-blockquote': {
            borderLeft: '3px solid #007acc',
            paddingLeft: '1.2em !important',
            color: '#999',
        },
        '&light .cm-md-blockquote': {
            borderLeft: '3px solid #d0d7de',
            color: '#656d76',
        },
        '.cm-md-blockquote-2': {
            paddingLeft: '2.4em !important',
            backgroundImage: 'linear-gradient(#007acc, #007acc)',
            backgroundSize: '3px 100%',
            backgroundRepeat: 'no-repeat',
            backgroundPosition: '1.2em 0',
        },
        '&light .cm-md-blockquote-2': {
            backgroundImage: 'linear-gradient(#d0d7de, #d0d7de)',
        },
        '.cm-md-blockquote-3': {
            paddingLeft: '3.6em !important',
            backgroundImage: 'linear-gradient(#007acc, #007acc), linear-gradient(#007acc, #007acc)',
            backgroundSize: '3px 100%, 3px 100%',
            backgroundRepeat: 'no-repeat, no-repeat',
            backgroundPosition: '1.2em 0, 2.4em 0',
        },
        '&light .cm-md-blockquote-3': {
            backgroundImage: 'linear-gradient(#d0d7de, #d0d7de), linear-gradient(#d0d7de, #d0d7de)',
        },
        '.cm-md-blockquote-4': {
            paddingLeft: '4.8em !important',
            backgroundImage:
                'linear-gradient(#007acc, #007acc), linear-gradient(#007acc, #007acc), linear-gradient(#007acc, #007acc)',
            backgroundSize: '3px 100%, 3px 100%, 3px 100%',
            backgroundRepeat: 'no-repeat, no-repeat, no-repeat',
            backgroundPosition: '1.2em 0, 2.4em 0, 3.6em 0',
        },
        '&light .cm-md-blockquote-4': {
            backgroundImage:
                'linear-gradient(#d0d7de, #d0d7de), linear-gradient(#d0d7de, #d0d7de), linear-gradient(#d0d7de, #d0d7de)',
        },
        '.cm-md-blockquote-5': {
            paddingLeft: '6em !important',
            backgroundImage:
                'linear-gradient(#007acc, #007acc), linear-gradient(#007acc, #007acc), linear-gradient(#007acc, #007acc), linear-gradient(#007acc, #007acc)',
            backgroundSize: '3px 100%, 3px 100%, 3px 100%, 3px 100%',
            backgroundRepeat: 'no-repeat, no-repeat, no-repeat, no-repeat',
            backgroundPosition: '1.2em 0, 2.4em 0, 3.6em 0, 4.8em 0',
        },
        '&light .cm-md-blockquote-5': {
            backgroundImage:
                'linear-gradient(#d0d7de, #d0d7de), linear-gradient(#d0d7de, #d0d7de), linear-gradient(#d0d7de, #d0d7de), linear-gradient(#d0d7de, #d0d7de)',
        },

        // =================================================================
        // Code blocks (fenced)
        // =================================================================
        // Selection is handled by codeBlockSelectionPlugin (mark decorations)
        // which works above all backgrounds regardless of z-index.
        '.cm-md-codeblock': {
            fontFamily:
                'inherit',
            fontSize: 'inherit',
            fontWeight: 'inherit',
            lineHeight: 'inherit',
            color: 'inherit',
            backgroundColor: 'var(--vscode-textCodeBlock-background, rgba(128,128,128,0.08))',
            // 四条边线一律**不用 border**、改用 inset 阴影，原因见下面 first/last 的说明：
            // 上下边的 1px border 会计入 `.cm-line` 实测盒高（进文本模式后行高跳变）；
            // 左右边在 border-box 下会把正文内容往里挤 1px，文本模式没有竖边，
            // 整块代码左右各漂 1px（2026-09-22 反馈：「正文变文本模式时会左右漂移」）。
            // inset 阴影同色同位置但不占布局：行高、内容宽度两态完全一致，
            // 长代码的折行位置也不会变（两态内容宽度相同）。
            // 边线颜色抽成 CSS 变量：浅色只覆盖这一个变量即可，不用重复整段阴影。
            '--cm-codeblock-edge': 'rgba(255, 255, 255, 0.12)',
            boxShadow:
                'inset 1px 0 0 var(--cm-codeblock-edge), inset -1px 0 0 var(--cm-codeblock-edge)',
            // 这里的 0.9em 横向 padding 实际被 theme.ts 的「`.cm-line` { padding: 0 4px }」
            // 覆盖（theme 优先于 baseTheme），保留仅作兜底语义
            padding: '0 0.9em',
            boxSizing: 'border-box',
        },
        '&light .cm-md-codeblock': {
            backgroundColor: 'var(--vscode-textCodeBlock-background, rgba(0, 0, 0, 0.035))',
            // 浅色边线：只换变量，first/last 那几条 box-shadow 自动跟着变色
            '--cm-codeblock-edge': 'rgba(0, 0, 0, 0.1)',
        },
        // （旧的逐行说明已并入上面 `.cm-md-codeblock` 主规则的注释）
        // 围栏行的上下边**不用 border**：1px border 会计入 `.cm-line` 的实际盒高
        // （实测两条围栏行 24.8px，比普通行高 1px），而进入文本模式后 FencedCode 的
        // 行装饰整棵跳过、边框消失，两条围栏行各矮 1px —— 块下面的行号和内容累计
        // 上移 2px，退出时再下移回来，用户看到的就是「行间距细微变化、行号偏移」。
        // 改用 inset 阴影：同色同位置的一条 1px 线，但不占布局，
        // 渲染态/文本态围栏行高都是 23.8px，切换时垂直方向零位移。
        // 上下边为什么不用 border、左右边为什么也一并换成 inset 阴影，
        // 都写在上面 `.cm-md-codeblock` 那条注释里了。
        '.cm-md-codeblock-first': {
            borderTopLeftRadius: '12px',
            borderTopRightRadius: '12px',
            // 顶部横线 + 左右两条竖线。**box-shadow 不会跨规则叠加**：本规则给出的
            // box-shadow 会整体顶替 `.cm-md-codeblock` 上那条，所以两条竖线必须照抄
            boxShadow:
                'inset 0 1px 0 var(--cm-codeblock-edge), inset 1px 0 0 var(--cm-codeblock-edge), inset -1px 0 0 var(--cm-codeblock-edge)',
        },
        '.cm-md-codeblock-last': {
            borderBottomLeftRadius: '12px',
            borderBottomRightRadius: '12px',
            // 底部横线 + 左右竖线，理由同 first
            boxShadow:
                'inset 0 -1px 0 var(--cm-codeblock-edge), inset 1px 0 0 var(--cm-codeblock-edge), inset -1px 0 0 var(--cm-codeblock-edge)',
        },
        // Code block copy button
        '.cm-md-codeblock-copy': {
            float: 'right',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            padding: '0.2em 0.75em',
            fontFamily:
                'var(--vscode-editor-font-family, "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace)',
            fontSize: '0.72em',
            lineHeight: '1.4',
            borderRadius: '999px',
            border: '1px solid rgba(255, 255, 255, 0.14)',
            backgroundColor: 'rgba(255, 255, 255, 0.06)',
            color: '#aab1bf',
            userSelect: 'none',
            transition:
                'background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease, opacity 0.15s ease',
            marginLeft: '0.75em',
            marginTop: '0.05em',
        },
        '.cm-md-codeblock-copy:hover': {
            backgroundColor: 'rgba(255, 255, 255, 0.12)',
            color: '#d4d4d4',
            borderColor: 'rgba(255, 255, 255, 0.24)',
        },
        '&light .cm-md-codeblock-copy': {
            backgroundColor: 'rgba(255, 255, 255, 0.06)',
            color: '#aab1bf',
            borderColor: 'rgba(255, 255, 255, 0.14)',
        },
        '&light .cm-md-codeblock-copy:hover': {
            backgroundColor: 'rgba(255, 255, 255, 0.12)',
            color: '#d4d4d4',
            borderColor: 'rgba(255, 255, 255, 0.24)',
        },

        // =================================================================
        // List bullets
        // =================================================================
        // 宽度由 BulletWidget 按源码里 `- ` 的实际宽度现算后写成行内样式，
        // 这里的 1.2em 只是量不到字宽时的兜底值（保证不会挤成一团）。
        '.cm-md-bullet': {
            color: '#aab1bf',
            display: 'inline-block',
            width: '1.2em',
            textAlign: 'center',
            fontWeight: 'bold',
            fontSize: '1.1em',
            lineHeight: '1',
            verticalAlign: 'middle',
        },
        // 浅色主题下圆点用 #191919：浅底上深色圆点最干净。
        // 深色主题继续用浅灰——#191919 在深底上对比度只有 1.1:1，等于看不见。
        '&light .cm-md-bullet': {
            color: '#191919',
        },

        // =================================================================
        // Setext heading underline (collapsed)
        // =================================================================
        '.cm-md-setext-underline': {
            fontSize: '0',
            lineHeight: '0',
            height: '0',
            overflow: 'hidden',
            padding: '0 !important',
        },

        // =================================================================
        // Horizontal rules
        // =================================================================
        // `<hr>` 的浏览器默认样式是**块级** + 上下 0.5em 外边距，放进编辑器的一行里
        // 会把这一行（连带下一行）整体撑开——「`---` 渲染后行间距变大」就是这么来的。
        // 这里改成 0 高的行内盒，靠一条 1px 上边框画线：行盒仍然由正文撑，
        // 渲染态和文本态的行高完全一致。
        // 线本身用**背景**画（一条 1px 高的色带，压在盒子正中），盒子高度给到 1.2em。
        //
        // 以前是「height: 0 + 1px 上边框」：线画出来了，但整个盒子的命中区只有 1px 高，
        // 鼠标点上去十有八九落在上下两行里 —— 于是「点这条线进不了文本模式」。
        // 撑到 1.2em（仍然小于正文行高 1.7em，藏在行盒里不会把行顶高）之后，
        // 整行高度上点哪儿都命中它，光标就落到这一行，`---` 的原文露出来。
        '.cm-md-hr': {
            '--cm-md-hr-color': 'rgba(128,128,128,0.3)',
            display: 'inline-block',
            width: '100%',
            height: '1.2em',
            backgroundImage:
                'linear-gradient(var(--cm-md-hr-color), var(--cm-md-hr-color))',
            backgroundSize: '100% 1px',
            backgroundPosition: '0 50%',
            backgroundRepeat: 'no-repeat',
            border: 'none',
            margin: '0',
            padding: '0',
            boxSizing: 'border-box',
            // 和文字中线对齐，画出来的线落在行的中间
            verticalAlign: 'middle',
        },
        '&light .cm-md-hr': {
            '--cm-md-hr-color': '#d0d7de',
        },

        // =================================================================
        // Hidden lines (for block widget rendering)
        // =================================================================
        '.cm-md-hidden-line': {
            fontSize: '0',
            lineHeight: '0',
            height: '0',
            overflow: 'hidden',
            padding: '0 !important',
            margin: '0 !important',
        },
        // Prevent hidden line gutter numbers from overflowing
        '.cm-gutterElement': {
            overflow: 'hidden',
        },

        // =================================================================
        // Tables（就地渲染的网格）
        // =================================================================
        // 表格不再是一个 widget，而是「保留源码 + 装饰」：
        // 管道线和两侧空白被压成 0 宽，单元格内容包在定宽的盒子里撑出格子。
        // 每一列的宽度由 tableRender.ts 量出来后写成行内 style，所以同一列的格子左右对齐。
        //
        // 整行是 **flex 容器**、格子是它的 flex item：一行里有的格子写三行、有的写一行时，
        // flex 默认的 align-items:stretch 会把同一行的格子拉到一样高，边框连成整整齐齐的网格
        // （行内块做不到这一点，矮的那些格子边框会缺一块）。行内块还会在行尾放不下时折行，
        // 把表格拆成上下两截，flex 的 nowrap 也一并挡掉了。
        //
        // 行高跟正文一致（1.7em）：格子里的行内块撑起行盒时，
        // 正文那一档行高刚好能把复选框这类 16px 的行内元素吸收掉，
        // 压到 1.5 会让带复选框的那一行比别的行高一倍。
        // justifyContent: center —— 表格整体在正文列里**居中**：
        // 行的宽度永远是满宽（它是 .cm-line，块级元素），但里面的格子是定宽的
        // flex item，居中之后整张表就落在中间，而不是贴着左边。
        // 选择器写成 .cm-line.cm-md-table-row（双类名）：theme.ts 里
        // `.cm-line { padding: 0 4px }` 与单类名规则同特异性、注入顺序又不受
        // 我们控制，单写 `.cm-md-table-row { padding-left:0 }` 会被它顶掉。
        '.cm-line.cm-md-table-row': {
            display: 'flex',
            alignItems: 'stretch',
            justifyContent: 'center',
            lineHeight: '1.7',
            // 横向 padding 必须清零：列宽分配的上限是「正文文字区宽度」（见
            // tableRender 的 availableWidth，已扣过 cm-content 的 32px padding），
            // 但行盒自己再留 4px 横 padding，格子铺满上限时就会把行盒撑出 4px、
            // 连带 cm-content 宽出 scroller（右侧被大纲盖住）。格子自身有 10px
            // 横向内边距，视觉上不需要行盒再补。
            paddingLeft: '0',
            paddingRight: '0',
        },
        // 单元格：定宽 + 上对齐，宽度和列对得上，全表的格子就排成网格
        '.cm-md-tcell': {
            // display 必须**写死**成 inline-block：格子平时是整行的 flex item
            // （flex 会把 inline-block 块化成 block，一个样），可它一旦被别的
            // mark 套住就成了普通行内元素 —— 那时 width / padding / border /
            // min-height 全部不算数，格子会缩成文字宽度、整行跟着串位。
            // 写成 inline-block 之后，「盒子」这件事不再取决于它在哪一层。
            display: 'inline-block',
            flex: '0 0 auto',
            verticalAlign: 'top',
            padding: '2px 10px',
            // 空格子（`|  |`、整行空、整列空）里没有任何内容，盒子会塌成一条线；
            // 给个下限让它和正常格子一样高（行高 + 上下内边距 4px + 上下边框 2px）
            minHeight: 'calc(1.7em + 6px)',
            // 相邻格子各画一条 1px 的右边框会变成 2px，用负边距让它们叠在一起
            marginLeft: '-1px',
            border: '1px solid rgba(128,128,128,0.28)',
            boxSizing: 'border-box',
            // 内容比钉子列宽还长时在格子内部换行，不要撑破表格。
            //
            // overflow-wrap 必须是 break-word 而不是 anywhere：**anywhere 会影响
            // min-content 的计算**（等于告诉浏览器「这串东西到处都能断」，
            // min-content 就退化成一个字宽），而列宽分配要拿 min-content 当物理下限
            // （见 tableRender.ts 的 floorsOf）。两者在**渲染**上是一回事：都是
            // 「实在放不下才从中间断开」，长 URL、长代码照断不误。
            whiteSpace: 'normal',
            overflowWrap: 'break-word',
        },
        // 管道线：压 0 宽但保留在文档里（光标还能停上去，方向键能跨过去）
        // flex 容器里它也是个 item，靠 font-size:0 把宽度吃掉
        '.cm-md-tgap': {
            fontSize: '0',
            letterSpacing: '0',
            flex: '0 0 auto',
        },
        // 表头行：加粗 + 淡底
        '.cm-md-table-header .cm-md-tcell': {
            fontWeight: '600',
            backgroundColor: 'rgba(128,128,128,0.10)',
        },
        // 被框选到的格子：整格上高亮（原生选区只涂文字，看着像没选中）
        '.cm-md-tcell-selected': {
            backgroundColor: 'rgba(79,193,255,0.22)',
        },
        '.cm-md-table-header .cm-md-tcell-selected': {
            backgroundColor: 'rgba(79,193,255,0.28)',
        },
        '&light .cm-md-tcell-selected': {
            backgroundColor: 'rgba(9,105,218,0.16)',
        },
        '&light .cm-md-table-header .cm-md-tcell-selected': {
            backgroundColor: 'rgba(9,105,218,0.22)',
        },
        // 分隔行（|---|:--:|）：整行折叠，光标停在上面时由 tableRender 放开
        '.cm-md-table-delimiter': {
            fontSize: '0',
            lineHeight: '0',
            height: '0',
            overflow: 'hidden',
            padding: '0 !important',
        },
        // =================================================================
        // 选区高亮层
        // =================================================================
        // 选区高亮走 mark 装饰（codeBlockSelection.ts），drawSelection 那一层矩形不要：
        // 多行选区的中间那些行会被画成通栏色块，和只涂文字的 mark 叠在一起就是「两重选择框」。
        //
        // 必须用 !important：CodeMirror 的 LayerView 在 Chrome 下会走 webkit 分支，
        // 每次重画都把内联的 display 改回 ''（只有没内容时才设成 none），
        // codeBlockSelection 在构造函数里设的那一次 display:none 会被它抹掉 —— 实测过。
        '.cm-selectionLayer': {
            display: 'none !important',
        },
        // =================================================================
        // Mermaid diagrams
        // =================================================================
        // Mermaid 图同样默认 75% 宽并居中；它是块级 widget，直接靠 auto margin 居中即可。
        '.cm-md-mermaid-wrapper': {
            position: 'relative',
            borderTop: '12px solid transparent',
            borderBottom: '12px solid transparent',
            backgroundClip: 'padding-box',
            padding: '16px',
            backgroundColor: '#272b33',
            borderRadius: '6px',
            textAlign: 'center',
            overflow: 'auto',
            minHeight: '200px',
            maxWidth: 'var(--cm-md-media-width, 75%)',
            margin: '0 auto',
        },
        '.cm-md-mermaid-content': {
            position: 'relative',
            zIndex: '1',
        },
        '.cm-md-mermaid-wrapper.cm-md-mermaid-rendered': {
            minHeight: 'unset',
        },
        '&light .cm-md-mermaid-wrapper': {
            backgroundColor: '#ffffff',
        },
        '.cm-md-mermaid-wrapper svg': {
            maxWidth: '100%',
            height: 'auto',
        },
        '.cm-md-mermaid-placeholder': {
            color: '#888',
            fontStyle: 'italic',
            padding: '24px',
        },
        '&light .cm-md-mermaid-placeholder': {
            color: '#656d76',
        },
        '.cm-md-mermaid-error': {
            color: '#f44747',
            fontFamily: '"SF Mono", Monaco, Consolas, monospace',
            fontSize: '0.85em',
            padding: '8px 12px',
            backgroundColor: 'rgba(244, 71, 71, 0.1)',
            borderRadius: '4px',
            textAlign: 'left',
            whiteSpace: 'pre-wrap',
        },
        '&light .cm-md-mermaid-error': {
            color: '#cf222e',
            backgroundColor: 'rgba(207, 34, 46, 0.1)',
        },

        // =================================================================
        // Checkboxes
        // =================================================================
        '.cm-md-checkbox': {
            cursor: 'pointer',
            width: '16px',
            height: '16px',
            verticalAlign: 'middle',
            marginRight: '4px',
            accentColor: '#4fc1ff',
        },
        '&light .cm-md-checkbox': {
            accentColor: '#0969da',
        },

        // =================================================================
        // Images
        // =================================================================
        // 图片默认占正文宽度的 75%，范围由 −/+ 按钮控制（见 --cm-md-media-width）。
        // 图片是行内 decoration，这里必须保持 inline-block：行内 widget 的根元素
        // 一旦变成块级，CM6 的高度估算会跟实际布局对不上，还会把行内图片强制断行。
        '.cm-md-image-wrapper': {
            position: 'relative',
            display: 'inline-block',
            maxWidth: 'var(--cm-md-media-width, 75%)',
            verticalAlign: 'middle',
        },
        '.cm-md-image-content': {
            display: 'block',
        },
        // 图片独占一行时让它居中。这个 class 由插件按源码判断后挂上
        // （见 decorations.ts 的 imageLineDeco）：行里除了图片还有文字时不会命中，
        // 所以不会像原来那样把「文字 + 图片」的行也整行居中。
        '.cm-md-image-line': {
            textAlign: 'center',
        },
        '.cm-md-image': {
            maxWidth: '100%',
            height: 'auto',
            borderRadius: '4px',
            verticalAlign: 'middle',
        },
        '.cm-md-image-fallback': {
            display: 'inline-block',
            color: '#888',
            fontStyle: 'italic',
            padding: '4px 8px',
            backgroundColor: 'rgba(128, 128, 128, 0.1)',
            borderRadius: '4px',
            border: '1px dashed rgba(128, 128, 128, 0.3)',
        },
        '&light .cm-md-image-fallback': {
            color: '#656d76',
        },
        '.cm-md-preview-actions': {
            position: 'absolute',
            right: '6px',
            bottom: '6px',
            zIndex: '10',
            display: 'inline-flex',
            gap: '4px',
            padding: '2px',
            borderRadius: '999px',
            backgroundColor: 'rgba(25, 25, 25, 0.55)',
            backdropFilter: 'blur(8px)',
            boxShadow: '0 1px 6px rgba(0, 0, 0, 0.18)',
        },
        '&light .cm-md-preview-actions': {
            backgroundColor: 'rgba(255, 255, 255, 0.82)',
            boxShadow: '0 1px 6px rgba(15, 23, 42, 0.12)',
        },
        '.cm-md-preview-action-status': {
            position: 'absolute',
            right: '0',
            bottom: 'calc(100% + 6px)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            maxWidth: '240px',
            padding: '4px 8px',
            borderRadius: '999px',
            fontSize: '11px',
            lineHeight: '1.25',
            color: '#e5eefb',
            backgroundColor: 'rgba(37, 99, 235, 0.88)',
            boxShadow: '0 1px 4px rgba(0, 0, 0, 0.18)',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
        },
        '.cm-md-preview-action-status:empty': {
            display: 'none',
        },
        '.cm-md-preview-action-status[data-state=\"error\"]': {
            color: '#fff1f2',
            backgroundColor: 'rgba(185, 28, 28, 0.92)',
        },
        '&light .cm-md-preview-action-status': {
            color: '#0f172a',
            backgroundColor: 'rgba(191, 219, 254, 0.96)',
        },
        '&light .cm-md-preview-action-status[data-state=\"error\"]': {
            color: '#7f1d1d',
            backgroundColor: 'rgba(254, 202, 202, 0.96)',
        },
        // 图片 / Mermaid 的宽度调整按钮组，嵌在 .cm-md-preview-actions 胶囊内部。
        '.cm-md-resize-actions': {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '2px',
        },
        '.cm-md-resize-btn': {
            // − / + 字形比 ⤢ / ⧉ 窄，稍微放宽一点更好点。
            width: '20px',
            fontSize: '13px',
        },
        '.cm-md-resize-btn:disabled': {
            opacity: '0.35',
            cursor: 'default',
        },
        '.cm-md-resize-value': {
            minWidth: '32px',
            textAlign: 'center',
            fontSize: '11px',
            lineHeight: '1',
            color: '#f3f4f6',
            fontVariantNumeric: 'tabular-nums',
            userSelect: 'none',
        },
        '.cm-md-preview-action': {
            width: '18px',
            height: '18px',
            padding: '0',
            border: 'none',
            borderRadius: '999px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '11px',
            lineHeight: '1',
            cursor: 'pointer',
            userSelect: 'none',
            color: '#f3f4f6',
            backgroundColor: 'rgba(255, 255, 255, 0.08)',
            transition: 'transform 0.15s ease, background-color 0.15s ease, color 0.15s ease',
        },
        '.cm-md-preview-action:hover': {
            transform: 'translateY(-1px)',
            backgroundColor: 'rgba(255, 255, 255, 0.16)',
        },
        '&light .cm-md-preview-action': {
            color: '#1f2937',
            backgroundColor: 'rgba(15, 23, 42, 0.06)',
        },
        '&light .cm-md-preview-action:hover': {
            backgroundColor: 'rgba(15, 23, 42, 0.1)',
        },
        '.cm-md-preview-overlay': {
            position: 'fixed',
            inset: '0',
            zIndex: '10000',
        },
        '.cm-md-preview-backdrop': {
            position: 'absolute',
            inset: '0',
            backgroundColor: 'rgba(8, 11, 16, 0.72)',
        },
        '.cm-md-preview-panel': {
            position: 'absolute',
            inset: '5vh 5vw',
            display: 'flex',
            flexDirection: 'column',
            borderRadius: '16px',
            overflow: 'hidden',
            backgroundColor: '#0f1115',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            boxShadow: '0 18px 60px rgba(0, 0, 0, 0.45)',
        },
        '&light .cm-md-preview-panel': {
            backgroundColor: '#f8fafc',
            border: '1px solid rgba(15, 23, 42, 0.1)',
            boxShadow: '0 18px 60px rgba(15, 23, 42, 0.18)',
        },
        '.cm-md-preview-header': {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 12px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            color: '#d7dce3',
            fontSize: '13px',
        },
        '&light .cm-md-preview-header': {
            color: '#334155',
            borderBottom: '1px solid rgba(15, 23, 42, 0.08)',
        },
        '.cm-md-preview-title': {
            fontWeight: '600',
            letterSpacing: '0.02em',
        },
        '.cm-md-preview-close': {
            width: '24px',
            height: '24px',
            border: 'none',
            borderRadius: '999px',
            cursor: 'pointer',
            fontSize: '18px',
            lineHeight: '1',
            backgroundColor: 'transparent',
            color: 'inherit',
        },
        '.cm-md-preview-close:hover': {
            backgroundColor: 'rgba(255, 255, 255, 0.08)',
        },
        '&light .cm-md-preview-close:hover': {
            backgroundColor: 'rgba(15, 23, 42, 0.08)',
        },
        '.cm-md-preview-viewport': {
            position: 'relative',
            flex: '1 1 auto',
            overflow: 'hidden',
            touchAction: 'none',
        },
        '.cm-md-preview-stage': {
            width: '100%',
            height: '100%',
            transformOrigin: 'center center',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
        },
        '.cm-md-preview-content': {
            position: 'relative',
            maxWidth: 'none',
            maxHeight: 'none',
        },
        '.cm-md-preview-image': {
            display: 'block',
            maxWidth: 'none',
            maxHeight: 'none',
            userSelect: 'none',
            pointerEvents: 'none',
            borderRadius: '8px',
            boxShadow: '0 10px 30px rgba(0, 0, 0, 0.28)',
        },
        '.cm-md-preview-mermaid-rendered': {
            display: 'inline-block',
            padding: '20px',
        },
        // Mermaid 浮层的 2:1 分栏：左图右码。
        // 两栏都用 flex 比例，窗口变大变小自动跟着分，不用算像素。
        '.cm-md-preview-split': {
            flex: '1 1 auto',
            display: 'flex',
            minHeight: '0',
            overflow: 'hidden',
        },
        '.cm-md-preview-split-main': {
            // flex-basis 写 0 而不是 auto：basis 为 auto 时"内容有多宽"会参与分配，
            // 一张宽图就能把左栏顶到 80%，2:1 直接失效
            flex: '2 1 0',
            // min-width 也必须写死 0：flex item 默认 min-width:auto，
            // 长代码行 / 宽图会把栏位撑开，同样破坏 2:1
            minWidth: '0',
            display: 'flex',
            position: 'relative',
        },
        '.cm-md-preview-split-side': {
            flex: '1 1 0',
            minWidth: '0',
            display: 'flex',
            borderLeft: '1px solid rgba(255, 255, 255, 0.08)',
        },
        '&light .cm-md-preview-split-side': {
            borderLeft: '1px solid rgba(15, 23, 42, 0.08)',
        },
        '.cm-md-preview-mermaid-editor': {
            flex: '1 1 auto',
            width: '100%',
            margin: '0',
            padding: '12px',
            border: 'none',
            outline: 'none',
            // 底色跟面板一致：这里是个"代码区"，不是表单输入框，别做出输入框的框子
            background: 'transparent',
            color: 'inherit',
            resize: 'none',
            fontFamily: 'monospace',
            fontSize: '13px',
            lineHeight: '1.6',
            // Tab 缩进看起来是 4 格，方便对齐 mermaid 的分支写法
            tabSize: '4',
        },
        '.cm-md-preview-mermaid-rendered svg': {
            maxWidth: 'none',
            height: 'auto',
        },
        '.cm-md-preview-fallback': {
            color: '#94a3b8',
            fontStyle: 'italic',
            padding: '24px',
        },
        '&light .cm-md-preview-fallback': {
            color: '#64748b',
        },
        '.cm-md-preview-error': {
            color: '#f87171',
        },
        '.cm-md-preview-dragging': {
            cursor: 'grabbing',
        },

        // =================================================================
        // Footnotes
        // =================================================================
        '.cm-md-footnote-ref': {
            color: '#4fc1ff',
            cursor: 'pointer',
            fontSize: '0.75em',
            verticalAlign: 'super',
            lineHeight: '0',
            padding: '0 2px',
            borderRadius: '2px',
            transition: 'background-color 0.15s ease',
        },
        '&light .cm-md-footnote-ref': {
            color: '#0969da',
        },
        '.cm-md-footnote-ref:hover': {
            backgroundColor: 'rgba(79, 193, 255, 0.15)',
        },
        '&light .cm-md-footnote-ref:hover': {
            backgroundColor: 'rgba(9, 105, 218, 0.15)',
        },
        '.cm-md-footnote-def': {
            borderLeft: '2px solid #4fc1ff',
            paddingLeft: '12px',
            color: '#999',
            fontSize: '0.9em',
        },
        '&light .cm-md-footnote-def': {
            borderLeft: '2px solid #0969da',
            color: '#656d76',
        },
        '.cm-md-footnote-def-label': {
            display: 'inline-block',
            color: '#4fc1ff',
            fontSize: '0.8em',
            fontWeight: '600',
            lineHeight: '1',
            padding: '2px 5px',
            marginRight: '6px',
            borderRadius: '3px',
            backgroundColor: 'rgba(79, 193, 255, 0.15)',
        },
        '&light .cm-md-footnote-def-label': {
            color: '#0969da',
            backgroundColor: 'rgba(9, 105, 218, 0.12)',
        },

        // =================================================================
        // Details/Summary (foldable blocks)
        // =================================================================
        '.cm-md-details': {
            margin: '4px 0',
            padding: '4px 0',
            borderLeft: '2px solid rgba(128, 128, 128, 0.3)',
            paddingLeft: '8px',
        },
        '.cm-md-details-summary': {
            cursor: 'pointer',
            color: 'inherit',
            fontWeight: '600',
            userSelect: 'none',
            padding: '4px 8px',
            borderRadius: '4px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
        },
        '.cm-md-details-summary:hover': {
            backgroundColor: 'rgba(128, 128, 128, 0.1)',
        },
        '.cm-md-details-arrow': {
            fontSize: '10px',
            color: '#888',
            width: '12px',
            textAlign: 'center',
            transition: 'transform 0.15s ease',
            flexShrink: '0',
        },
        '&light .cm-md-details-arrow': {
            color: '#656d76',
        },
        '.cm-md-details-open .cm-md-details-arrow': {
            color: '#4fc1ff',
        },
        '&light .cm-md-details-open .cm-md-details-arrow': {
            color: '#0969da',
        },
        '.cm-md-details-content': {
            padding: '8px 16px 8px 26px',
            color: 'inherit',
            whiteSpace: 'pre-wrap',
        },

        // =================================================================
        // List fold arrows
        // =================================================================
        '.cm-md-fold-arrow': {
            display: 'inline-block',
            width: '16px',
            fontSize: '11px',
            color: '#4fc1ff',
            cursor: 'pointer',
            textAlign: 'center',
            userSelect: 'none',
            marginLeft: '-20px',
            marginRight: '4px',
            verticalAlign: 'middle',
            lineHeight: '1',
            borderRadius: '3px',
            padding: '2px 0',
            opacity: '0.7',
            transition:
                'color 0.15s ease, background-color 0.15s ease, opacity 0.15s ease, transform 0.15s ease',
        },
        '&light .cm-md-fold-arrow': {
            color: '#0969da',
        },
        '.cm-md-fold-arrow:hover': {
            opacity: '1',
            backgroundColor: 'rgba(128, 128, 128, 0.15)',
        },
        // Collapsed: ▼ rotated to ▶
        '.cm-md-fold-arrow-collapsed': {
            transform: 'rotate(-90deg)',
        },
        // Expanded: ▼ as-is
        '.cm-md-fold-arrow-open': {
            color: '#888',
            opacity: '0.5',
            transform: 'rotate(0deg)',
        },
        '&light .cm-md-fold-arrow-open': {
            color: '#656d76',
        },
        '.cm-md-fold-arrow-open:hover': {
            color: '#4fc1ff',
            opacity: '1',
        },
        '&light .cm-md-fold-arrow-open:hover': {
            color: '#0969da',
        },
        // Folded line: bullet gets accent color to match arrow
        '.cm-md-fold-collapsed-line .cm-md-bullet': {
            color: '#4fc1ff',
            opacity: '0.7',
        },
        '&light .cm-md-fold-collapsed-line .cm-md-bullet': {
            color: '#0969da',
        },

        // =================================================================
        // Indent guide lines (for nested list items)
        // =================================================================
        // 层级引导线：一条 repeating-linear-gradient 竖着铺，铺的范围由
        // background-size 卡死在「层级 × 缩进单位」里，所以一级缩进看到一条线、
        // 三级缩进看到三条线。层级和单位由 plugin.ts 现算后写进这两个变量
        // （见 collectListIndentDecorations），默认值只是拿不到测量结果时的兜底。
        // 两层背景，一层画「祖先那几条线」，另一层画「自己圆点那一条」：
        //
        // - 祖先线（第 0 … level-1 条）是**接上一行**过来的，要铺满整行高度才连得上；
        // - 自己那条线要从**圆点中心**往下垂（直到最后一级），所以只画下半行：
        //   起点压在垂直中点（50%）上，高度 50%。`--cm-md-indent-own` 没有子级时给 0%，
        //   那条线就不画了（光杆条目下面没有东西可指）。
        //
        // 横向位置统一加上 `--cm-md-indent-dot`：圆点的圆心在 `- ` 盒子里
        // 「半个 `-` 宽」的位置（需求：圆点以 `-` 的中点为圆心），竖线不跟着挪
        // 就会从圆点左边擦过去。这个偏移由 helpers.ts 量出来，见 collectListIndentDecorations。
        '.cm-md-indent': {
            '--cm-md-indent-color': 'rgba(128,128,128,0.25)',
            // 定位原点是**正文内容区**的左边缘（不是行盒边缘）：行内边距由 CSS 自己算，
            // 竖线的横向坐标就只剩「层级 × 缩进单位 + 半个 `-` 宽」，不用去问 DOM。
            backgroundOrigin: 'content-box',
            backgroundImage:
                'repeating-linear-gradient(to right, var(--cm-md-indent-color) 0 1px, transparent 1px var(--cm-md-indent-unit, 1.6em)), linear-gradient(to right, var(--cm-md-indent-color) 0 1px, transparent 1px)',
            backgroundSize:
                'calc(var(--cm-md-indent-level, 0) * var(--cm-md-indent-unit, 1.6em)) 100%, 1px var(--cm-md-indent-own, 0%)',
            backgroundRepeat: 'no-repeat, no-repeat',
            backgroundPosition:
                'var(--cm-md-indent-dot, 0px) top, calc(var(--cm-md-indent-level, 0) * var(--cm-md-indent-unit, 1.6em) + var(--cm-md-indent-dot, 0px)) 50%',
        },
        '&light .cm-md-indent': {
            '--cm-md-indent-color': 'rgba(0,0,0,0.14)',
        },
        // 行首空白被压成一个定宽空盒：宽高都由样式给，里面的空白不再占宽度，
        // 于是「空格缩进」和「Tab 缩进」写出来占的位置完全一样。
        // height:0 是为了不参与行盒高度计算——否则行高会被悄悄垫高一点。
        '.cm-md-indent-space': {
            display: 'inline-block',
            height: '0',
            overflow: 'hidden',
            verticalAlign: 'baseline',
        },

        // =================================================================
        // Code block indent guides
        // =================================================================
        '.cm-md-codeblock-indent': {
            backgroundRepeat: 'no-repeat',
        },

        // =================================================================
        // Frontmatter (YAML Properties Panel)
        // =================================================================
        '.cm-md-frontmatter': {
            borderBottom: '16px solid transparent',
            backgroundClip: 'padding-box',
            padding: '14px 18px 12px',
            backgroundColor: 'var(--vscode-textCodeBlock-background, rgba(128,128,128,0.08))',
            borderRadius: '8px',
        },
        '&light .cm-md-frontmatter': {
            backgroundColor: 'rgba(0, 0, 0, 0.03)',
        },
        '.cm-md-frontmatter-header': {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '0.8em',
            fontWeight: '600',
            color: 'var(--vscode-descriptionForeground, #888)',
            marginBottom: '10px',
            letterSpacing: '0.02em',
        },
        '.cm-md-frontmatter-header-icon': {
            fontSize: '0.95em',
            lineHeight: '1',
        },
        '.cm-md-frontmatter-grid': {
            display: 'grid',
            gridTemplateColumns: '20px auto 1fr',
            gap: '0',
            alignItems: 'baseline',
        },
        '.cm-md-frontmatter-icon': {
            color: 'var(--vscode-descriptionForeground, #555)',
            fontSize: '0.95em',
            textAlign: 'center',
            padding: '6px 0',
            opacity: '0.6',
        },
        '.cm-md-frontmatter-key': {
            color: 'var(--vscode-descriptionForeground, #888)',
            fontSize: '0.85em',
            padding: '6px 12px 6px 4px',
            whiteSpace: 'nowrap',
        },
        '.cm-md-frontmatter-value': {
            color: 'var(--vscode-editor-foreground, #d4d4d4)',
            fontSize: '0.85em',
            padding: '6px 8px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            minWidth: '0',
            borderRadius: '4px',
        },
        '.cm-md-frontmatter-value:hover': {
            backgroundColor: 'rgba(128, 128, 128, 0.08)',
        },
        '&light .cm-md-frontmatter-value:hover': {
            backgroundColor: 'rgba(0, 0, 0, 0.04)',
        },

        // =================================================================
        // Math (KaTeX)
        // =================================================================
        '.cm-md-math-inline': {
            display: 'inline',
            verticalAlign: 'baseline',
        },
        '.cm-md-math-inline math': {
            fontSize: '1em',
        },
        // 块级公式的外框**照着代码块的框来做**（同样的圆角、底色、内边距）：
        // 公式和代码块在正文里是同一类「整块的东西」，长得一样看着才顺；
        // 公式本身仍然居中，字号比正文大一点。
        // 公式比这个框高就整体缩放塞进去（见 widgets.ts），于是「一行的小公式」和
        // 「六行的长推导」在正文里占的高度是同一个数 —— 打字、滚动时下面的内容不会跳。
        // 内容居中，超出的一小部分裁掉。
        //
        // 高度**就是 2.5 行**，而且这条公式写在这里、不写进行内 style：
        //   - 行高跟着 `--flowmd-line-height`（webviewContent.ts 注进来的用户设置），
        //     用 em 现算，所以改字号/滚轮缩放/换行高设置都会自己跟上；
        //   - 换成 JS 写死的 px 会**钉死**在首次构建那一刻：那时 `.cm-line` 还不存在，
        //     行高量不到、只能猜，猜错的值会被 CM 连同 DOM 一起缓存住
        //     （widget.eq 为真时 DOM 复用、toDOM 不再跑），框就一直比正文高一截。
        //
        // **上下不许有 margin**：这个框是块级 widget，直接挂在 `.cm-content` 底下，
        // 而 CM 量块高量的是「元素自己的盒」—— margin 在盒子外面，量不到。
        // 于是高度表里少掉的正是这两条 margin，下面每一行的行号、点击落点
        // 统统往上偏同样多（2026-09-21 反馈：3 行源码 → 2.5 行的框，点下面的行
        // 差了半行）。留白一律用 padding 做在盒子**里面**，或者交给源码里的空行。
        '.cm-md-math-block': {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: 'calc(2.5 * var(--flowmd-line-height, 1.7em))',
            overflow: 'hidden',
            textAlign: 'center',
            margin: '0',
            padding: '0 0.9em',
            borderRadius: '12px',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            backgroundColor: 'var(--vscode-textCodeBlock-background, rgba(128,128,128,0.08))',
            boxSizing: 'border-box',
            // 公式整块是替换 widget，光标进不去 —— 鼠标样式明示「可以点进去改源码」
            cursor: 'text',
        },
        // 缩放层：内容比框高时整体缩小（transform 不影响布局，框高始终是 2.5 行）
        '.cm-md-math-inner': {
            display: 'block',
            transformOrigin: 'center center',
        },
        '.cm-md-math-block:hover': {
            borderColor: 'rgba(79, 193, 255, 0.45)',
        },
        '&light .cm-md-math-block': {
            border: '1px solid rgba(0, 0, 0, 0.1)',
            backgroundColor: 'var(--vscode-textCodeBlock-background, rgba(0, 0, 0, 0.035))',
        },
        '&light .cm-md-math-block:hover': {
            borderColor: 'rgba(9, 105, 218, 0.45)',
        },
        '.cm-md-math-block math': {
            fontSize: '1.15em',
        },
    });
}
