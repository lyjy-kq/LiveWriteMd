/**
 * Live Preview 样式片段（从 styles.ts 拆出）：块级元素：选区 / 列表圆点 / Setext / hr / HTML 块 / 隐藏行 / 表格 / Mermaid / 复选框。
 *
 * 只是 baseTheme 大对象的一部分；styles.ts 里按原顺序 spread 合并。
 *
 * @module webview/codemirror/extensions/livePreview/stylesBlock
 */

import { CHECK_SVG } from './stylesHelpers.js';

export const BLOCK_STYLES = {
        // =================================================================
        // List bullets
        // =================================================================
        // 宽度由 BulletWidget 按源码里 `- ` 的实际宽度现算后写成行内样式，
        // 这里的 1.2em 只是量不到字宽时的兜底值（保证不会挤成一团）。
        '.cm-md-bullet': {
            position: 'relative',
            color: 'var(--livewritemd-bullet-color, #aab1bf)',
            display: 'inline-block',
            width: '1.2em',
            textAlign: 'center',
            fontWeight: 'bold',
            fontSize: '1.1em',
            lineHeight: '1',
            verticalAlign: 'middle',
            // 阻断列表行悬挂 text-indent 的继承
            textIndent: '0',
            whiteSpace: 'nowrap',
        },
        // 浅色主题下圆点默认 #191919：浅底上深色圆点最干净。
        // 深色主题默认浅灰——#191919 在深底上对比度只有 1.1:1，等于看不见。
        // 显式设置 --livewritemd-bullet-color 时两主题统一用用户色。
        '&light .cm-md-bullet': {
            color: 'var(--livewritemd-bullet-color, #191919)',
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
            '--cm-md-hr-color': 'var(--livewritemd-hr-color, rgba(128,128,128,0.3))',
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
            '--cm-md-hr-color': 'var(--livewritemd-hr-color, #d0d7de)',
        },

        // =================================================================
        // HTML 块（README 顶部的居中标题 / 徽章图片行）
        // =================================================================
        // 整块被 block widget 替换，里面就是用户写的 HTML（白名单重建）。
        // 只做「正文里能安放」的最小修正：图片不撑破正文宽度、段落不要
        // 浏览器默认的上下大间距。
        '.cm-md-html-block': {
            display: 'block',
            width: '100%',
            boxSizing: 'border-box',
        },
        '.cm-md-html-block img': {
            maxWidth: '100%',
            height: 'auto',
            verticalAlign: 'middle',
        },
        '.cm-md-html-block p': {
            margin: '0.35em 0',
        },
        '.cm-md-html-block > :first-child': {
            marginTop: '0',
        },
        '.cm-md-html-block > :last-child': {
            marginBottom: '0',
        },
        '.cm-md-html-block a': {
            // 复用 live 链接颜色，但不加下划线（README 徽章行里全是图）
            color: 'var(--vscode-textLink-foreground, #4fc1ff)',
            textDecoration: 'none',
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
            // 悬停边框时的「+」提示是 ::after 绝对定位，需要格子当包含块。
            // inline-block + relative 不改变排版，只建立一个定位上下文。
            position: 'relative',
            padding: '2px 10px',
            // 空格子（`|  |`、整行空、整列空）里没有任何内容，盒子会塌成一条线；
            // 给个下限让它和正常格子一样高（行高 + 上下内边距 4px + 上下边框 2px）
            minHeight: 'calc(1.7em + 6px)',
            // 相邻格子各画一条 1px 的右边框会变成 2px，用负边距让它们叠在一起
            marginLeft: '-1px',
            border: '1px solid var(--livewritemd-table-border-color, rgba(128,128,128,0.28))',
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
        // 表格**最左边**那格的左边框：所有格子都用 marginLeft:-1px 把相邻
        // 边框叠成一条，第一格也被一起左移了 1px，左边框落到行盒外面，
        // 视觉上表格像「没有左边」。把第一格退回 0，左边框落回盒内。
        '.cm-md-tcell.cm-md-tcell-start': {
            marginLeft: '0',
        },
        // 悬停右边框/下边框时那条边泛蓝（tableHoverControls 加的类）。
        // 这两类会加到**整条边界**涉及的所有格子上（最后一列的每一行 /
        // 最后一行的每一格），所以视觉上是一条贯穿整张表格的线，
        // 而不是鼠标下那一格的一小段。
        // 这条线本身就是**点击热区**：按下去直接加列/加行，不再有浮动按钮
        // （浮动按钮在导图节点的缩放变换里坐标会算错，到处乱飞）。
        '.cm-md-tcell-edge-col': {
            boxShadow: 'inset -2px 0 0 var(--vscode-focusBorder, #007fd4)',
            cursor: 'copy',
        },
        '.cm-md-tcell-edge-row': {
            boxShadow: 'inset 0 -2px 0 var(--vscode-focusBorder, #007fd4)',
            cursor: 'copy',
        },
        // 线中点叠一个纯 CSS 的「+」：只是提示，pointer-events:none 让点击
        // 穿透到格子本身（命中检测在 tableHoverControls 里）。
        // 整条边界上只有一个加号，且固定在整个边界的正中（不是鼠标位置）；
        // 落在哪个格子由 placePlus 计算，再用 --lwm-edge-shift 修正到边界中点。
        '.cm-md-tcell-edge-plus::after': {
            content: '"+"',
            position: 'absolute',
            zIndex: '20',
            width: '18px',
            height: '18px',
            borderRadius: '999px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '14px',
            lineHeight: '1',
            color: '#ffffff',
            backgroundColor: 'var(--vscode-focusBorder, #007fd4)',
            boxShadow: '0 1px 5px rgba(0, 0, 0, 0.35)',
            pointerEvents: 'none',
            userSelect: 'none',
            boxSizing: 'border-box',
        },
        // 右边界：加号骑在右边框上，纵向锚点 = 格子中心 + 到整条边界中点的偏移
        // （--lwm-edge-shift 由 tableHoverControls 按边界总高度算，默认 0）
        '.cm-md-tcell-edge-col.cm-md-tcell-edge-plus::after': {
            right: '-9px',
            top: 'calc(50% + var(--lwm-edge-shift, 0px))',
            transform: 'translateY(-50%)',
        },
        // 下边界：加号骑在下边框上，横向锚点同理
        '.cm-md-tcell-edge-row.cm-md-tcell-edge-plus::after': {
            bottom: '-9px',
            left: 'calc(50% + var(--lwm-edge-shift, 0px))',
            transform: 'translateX(-50%)',
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
            backgroundColor: 'var(--livewritemd-table-header-background, rgba(128,128,128,0.10))',
        },
        // 斑马纹（偶数数据行）：变量留空时 fallback transparent、无视觉变化
        '.cm-md-table-stripe .cm-md-tcell': {
            backgroundColor: 'var(--livewritemd-table-stripe-background, transparent)',
        },
        // 表头行即使带 stripe 标记也以表头底色为准（表头不参与斑马纹）
        '.cm-md-table-header.cm-md-table-stripe .cm-md-tcell': {
            backgroundColor: 'var(--livewritemd-table-header-background, rgba(128,128,128,0.10))',
        },
        // 被框选到的格子：整格上高亮（原生选区只涂文字，看着像没选中）
        '.cm-md-tcell-selected': {
            backgroundColor: 'var(--livewritemd-table-selected-background, rgba(79,193,255,0.22))',
        },
        '.cm-md-table-header .cm-md-tcell-selected': {
            backgroundColor: 'var(--livewritemd-table-selected-background, rgba(79,193,255,0.28))',
        },
        '&light .cm-md-tcell-selected': {
            backgroundColor: 'var(--livewritemd-table-selected-background, rgba(9,105,218,0.16))',
        },
        '&light .cm-md-table-header .cm-md-tcell-selected': {
            backgroundColor: 'var(--livewritemd-table-selected-background, rgba(9,105,218,0.22))',
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
        // 自定义复选框：原生框在深底上白得刺眼、与整体不协调。
        '.cm-md-checkbox': {
            appearance: 'none',
            WebkitAppearance: 'none',
            cursor: 'pointer',
            boxSizing: 'border-box',
            width: '16px',
            height: '16px',
            verticalAlign: 'middle',
            // 清掉 UA input legacy margin（左 4 / 上下 3），只留右 gap
            margin: '0 4px 0 0',
            padding: '0',
            border:
                '1.5px solid var(--livewritemd-checkbox-border, rgba(205,210,220,0.4))',
            borderRadius: '4px',
            backgroundColor: 'transparent',
            transition:
                'background-color 0.13s ease, border-color 0.13s ease',
        },
        '.cm-md-checkbox:hover': {
            borderColor: 'var(--livewritemd-checkbox-border-hover, rgba(205,210,220,0.75))',
        },
        // 已勾选：accent 底 + 白色 SVG 对勾（input 不支持 ::after）
        '.cm-md-checkbox:checked': {
            borderColor: 'var(--livewritemd-checkbox-accent, #4fc1ff)',
            backgroundColor: 'var(--livewritemd-checkbox-accent, #4fc1ff)',
            backgroundImage: CHECK_SVG,
            backgroundRepeat: 'no-repeat',
            backgroundPosition: 'center',
            backgroundSize: '11px 11px',
        },
        // 浅色主题：边框与 accent 换色
        '&light .cm-md-checkbox': {
            borderColor:
                'var(--livewritemd-checkbox-border, rgba(20,25,35,0.35))',
        },
        '&light .cm-md-checkbox:hover': {
            borderColor:
                'var(--livewritemd-checkbox-border-hover, rgba(20,25,35,0.6))',
        },
        '&light .cm-md-checkbox:checked': {
            borderColor: 'var(--livewritemd-checkbox-accent, #0969da)',
            backgroundColor: 'var(--livewritemd-checkbox-accent, #0969da)',
        },

};
