/**
 * Live Preview 样式片段（从 styles.ts 拆出）：文本与语法：语法高亮覆盖 / 标题 / 粗斜体 / 标记符压 0 宽 / 行内代码 / 链接 / 引用 / 围栏代码块。
 *
 * 只是 baseTheme 大对象的一部分；styles.ts 里按原顺序 spread 合并。
 *
 * @module webview/codemirror/extensions/livePreview/stylesText
 */

import { tone } from './stylesHelpers.js';

export const TEXT_STYLES = {
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

        // 浅色主题下正文直接用纯黑（#000）。
        // 标题 / 加粗 / 斜体的颜色都是「色相 + 正文色」混出来的，
        // 正文本身偏灰的话整体观感都会发虚；这里只动浅色主题，
        // 深色主题的正文保持 VS Code 给的浅灰不变。
        // 不再和 editor-foreground 做 color-mix：用户要的就是最深的黑，
        // 混比再往上加也只是逼近 #000，不如直接写死。
        // 选择器只能写「&light .cm-content」：`&light` 生成的是「祖先带主题
        // class」的形式（.ͼ2 .xxx），而主题 class 挂在 .cm-editor 自身，所以
        // `&light .cm-editor` 永远匹配不到；.cm-content 是它的后代才行。
        // 重复一次类名把优先级抬到 (0,3,0)：theme.ts 里那条 `.cm-content
        // { color: inherit }` 也是 (0,2,0)，同一优先级下靠顺序决胜负，赢不了。
        '&light .cm-content.cm-content': {
            color: '#000',
        },

        // =================================================================
        // Headings - Modern & clean
        // =================================================================
        '.cm-md-heading': {
            lineHeight: '1.6',
        },
        // 字重走变量：默认 inherit（与正文同字重，只靠字号/颜色区分层级）。
        // 设置里的「标题加粗」打开后，settingsState 会写入
        // --livewritemd-heading-weight-1 = 700、--livewritemd-heading-weight = 600，
        // 保留「一级标题比其余级别更重」的原设计。两个变量分开是因为
        // 一个变量装不下两档字重；关掉时把两个变量一起删掉即可回到 inherit。
        '.cm-md-heading-1': {
            fontSize: 'var(--livewritemd-h1-size, 1.2em)',
            fontWeight: 'var(--livewritemd-heading-weight-1, inherit)',
            letterSpacing: '-0.02em',
            color: `var(--livewritemd-h1-color, ${tone('#eb8383')})`,
        },
        '.cm-md-heading-2': {
            fontSize: 'inherit',
            fontWeight: 'var(--livewritemd-heading-weight, inherit)',
            letterSpacing: '-0.01em',
            // 二级标题的紫色加深一档：基准色更饱和（#ae9acb → #a17fe0），
            // 深色主题混入的正文色从 25% 降到 12%
            color: `var(--livewritemd-h2-color, ${tone('#a17fe0', false, 46, 12)})`,
        },
        '.cm-md-heading-3': {
            fontSize: 'inherit',
            fontWeight: 'var(--livewritemd-heading-weight, inherit)',
            color: `var(--livewritemd-h3-color, ${tone('#7db5cd')})`,
        },
        '.cm-md-heading-4': {
            fontSize: 'inherit',
            fontWeight: 'var(--livewritemd-heading-weight, inherit)',
            color: `var(--livewritemd-h4-color, ${tone('#71a796')})`,
        },
        '.cm-md-heading-5': {
            fontSize: 'inherit',
            fontWeight: 'var(--livewritemd-heading-weight, inherit)',
            color: `var(--livewritemd-h5-color, ${tone('#dcbf61')})`,
        },
        '.cm-md-heading-6': {
            fontSize: 'inherit',
            fontWeight: 'var(--livewritemd-heading-weight, inherit)',
            color: `var(--livewritemd-h6-color, ${tone('#dda36a')})`,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
        },
        // 浅色主题：同一色相，混入更暗的正文色（见 tone() 的说明）。
        // 只加这 6 条覆盖，形状 / 字重 / 字号仍由上面的主规则负责。
        '&light .cm-md-heading-1': {
            color: `var(--livewritemd-h1-color, ${tone('#eb8383', true)})`,
        },
        '&light .cm-md-heading-2': {
            // 紫色在白底上本来就偏浅，比其它级别多混（46 → 66），
            // 混完仍是紫灰而不是黑；基准色与深色主题同步加深
            color: `var(--livewritemd-h2-color, ${tone('#a17fe0', true, 66)})`,
        },
        '&light .cm-md-heading-3': {
            color: `var(--livewritemd-h3-color, ${tone('#7db5cd', true)})`,
        },
        '&light .cm-md-heading-4': {
            color: `var(--livewritemd-h4-color, ${tone('#71a796', true)})`,
        },
        '&light .cm-md-heading-5': {
            // 黄色系在白底上最吃亏，多混一点正文色，保证至少 3:1 的可读性
            color: `var(--livewritemd-h5-color, ${tone('#dcbf61', true, 56)})`,
        },
        '&light .cm-md-heading-6': {
            color: `var(--livewritemd-h6-color, ${tone('#dda36a', true)})`,
        },

        // =================================================================
        // Bold & Italic
        // =================================================================
        // line-height: 1 —— 见上面行内代码那段的说明：渲染态的盒子只要和正文的
        // 行高不一样（粗体面、等宽体的 ascent/descent 分布都和正文不同），
        // 行盒就可能被顶高零点几个像素，聚焦展开时又落回正文行高，
        // 于是「点一下，下面整块跟着上下跳一下」。盒子压到 1em 之后就永远躲在正文行盒里。
        '.cm-md-bold': {
            // 默认 inherit（跟随正文字重），只有打开「加粗真加粗」时才由
            // settingsState 写入 700；这样默认状态下加粗只靠颜色区分。
            fontWeight: 'var(--livewritemd-bold-weight, inherit)',
            lineHeight: '1',
            // 深色主题直接用纯金：暗底上金色（#ffd700）亮度足够、对比约 12:1，
            // 再和正文色混反而变成灰扑扑的土黄。浅色主题的白底上纯金几乎
            // 不可读（对比不到 1.3:1），所以浅色覆盖仍然混成暗金，见下面
            // `&light .cm-md-bold` —— 两套主题不再共用同一个混比。
            color: 'var(--livewritemd-bold-color, #ffd700)',
        },
        // 斜体默认只变色、不倾斜：合成斜体（italic）默认约 14°，斜得过头。
        // fontStyle 走变量，设置里开启「斜体真倾斜」时由应用层改为 italic。
        '.cm-md-italic': {
            fontStyle: 'var(--livewritemd-italic-style, normal)',
            lineHeight: '1',
            color: `var(--livewritemd-italic-color, ${tone('#2bbac5')})`,
        },
        '&light .cm-md-bold': {
            // 浅色主题：正文已经压到纯黑，加粗若再用「压深的金」
            // （rgb(105,84,67) 那种深棕）会比正文还灰，完全看不出重点。
            // 这里换成饱和度更高的暗金（#a86b00，白底对比约 4.4:1）：
            // 色相明确是金/琥珀，又不会亮到读不清，才压得住纯黑正文。
            color: `var(--livewritemd-bold-color, #a86b00)`,
        },
        '&light .cm-md-italic': {
            color: `var(--livewritemd-italic-color, ${tone('#2bbac5', true)})`,
        },
        '.cm-md-strikethrough': {
            textDecoration: 'line-through',
            lineHeight: '1',
            opacity: '0.6',
            color: 'var(--livewritemd-strikethrough-color, inherit)',
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
            color: '#6b7280',
        },
        // 行内元素展开态（`**加粗**`）：外层缩放在行内 style 里给（见 focusMarks.ts），
        // 这里只负责把标记符压灰，以及把行内代码的样式改成「跟着一起缩」。
        '.cm-md-src-delim': {
            color: '#7d8590',
        },
        '&light .cm-md-src-delim': {
            color: '#6b7280',
        },
        // 有序列表序号（1. 2. …）：与 # / - 同色（中性深灰）。
        // syntaxHighlighting 会在内层 span 上再染 punctuation 色，所以要
        // 用后代选择器把灰色强制渗透进去。
        '.cm-md-ordmark, .cm-md-ordmark > *': {
            color: '#7d8590',
        },
        '&light .cm-md-ordmark, &light .cm-md-ordmark > *': {
            color: '#6b7280',
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
        // 正文一旦被「字体缩放」（--livewritemd-font-scale）放大，代码还是老大小，
        // 看起来就小了一大截。
        // line-height 设成 1 和展开态同理：等宽字体的 ascent/descent 分布和正文不同，
        // 行盒高度取的是「最大 ascent + 最大 descent」，两块盒子的分布一不一样就会多出零点几像素，
        // 于是「渲染态比文本态高一点」，切来切去整行下面就会跳。
        '.cm-md-code': {
            fontFamily:
                'var(--vscode-editor-font-family, "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace)',
            fontSize: 'var(--livewritemd-inline-code-scale, 0.95em)',
            lineHeight: '1',
            fontWeight: 'var(--livewritemd-font-weight, 400)',
            // 底色 / 文字色优先跟随 VS Code 主题的 textPreformat 配色：
            // - 主题定义了 --vscode-textPreformat-background /
            //   --vscode-textPreformat-foreground 时直接用，换任何主题都协调；
            // - 主题没定义时用中性半透明灰兜底（深浅两套各有一档），
            //   不再出现「深色一块明显中灰、浅色几乎看不见」的偏差；
            // - 用户在设置里自定义时，--livewritemd-inline-code-* 会覆盖主题色；
            //   自定义底色在 settingsState 写入变量时已经掺过 50% 透明，
            //   这里不再 mix，避免把主题色二次淡化；
            // - 形状（padding / 圆角 / 行高）保持不变。
            backgroundColor:
                'var(--livewritemd-inline-code-background, var(--vscode-textPreformat-background, rgba(127, 127, 127, 0.16)))',
            padding: '2px 6px',
            borderRadius: '4px',
            color: 'var(--livewritemd-inline-code-color, var(--vscode-textPreformat-foreground, inherit))',
        },
        '&light .cm-md-code': {
            backgroundColor:
                'var(--livewritemd-inline-code-background, var(--vscode-textPreformat-background, rgba(0, 0, 0, 0.055)))',
            color: 'var(--livewritemd-inline-code-color, var(--vscode-textPreformat-foreground, inherit))',
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
            color: `var(--livewritemd-link-color, ${tone('#338122')})`,
            textDecoration: 'underline',
            textDecorationColor: `var(--livewritemd-link-color, ${tone('#338122')})`,
            textDecorationSkipInk: 'auto',
            textUnderlineOffset: '3px',
            cursor: 'pointer',
            transition: 'opacity 0.15s ease',
        },
        '.cm-md-link:hover, .cm-md-file-link:hover': {
            opacity: '0.8',
        },
        '&light .cm-md-link, &light .cm-md-file-link': {
            color: `var(--livewritemd-link-color, ${tone('#338122', true)})`,
            textDecorationColor: `var(--livewritemd-link-color, ${tone('#338122', true)})`,
        },
        // 内链（文档内 #标题 跳转）：虚线下划线，与外链的实线区分
        '.cm-md-link-internal': {
            textDecorationStyle: 'dashed',
        },
        // 断链（目标标题不存在）：灰显、不给手型（点击退回普通文本行为）
        '.cm-md-link-broken': {
            color: 'var(--vscode-descriptionForeground, #888888)',
            textDecorationColor: 'var(--vscode-descriptionForeground, #888888)',
            cursor: 'default',
        },
        // 内链跳转后目标行的 1s 高亮（anchorFlashField 写入，到点撤掉）
        '.cm-md-anchor-flash': {
            backgroundColor:
                'color-mix(in srgb, var(--livewritemd-link-color, #338122) 22%, transparent)',
        },

        // =================================================================
        // Blockquotes
        // =================================================================
        '.cm-md-blockquote': {
            borderLeft: '3px solid var(--livewritemd-quote-border-color, #007acc)',
            paddingLeft: '1.2em !important',
            color: 'var(--livewritemd-quote-text-color, #999)',
        },
        '&light .cm-md-blockquote': {
            borderLeft: '3px solid var(--livewritemd-quote-border-color, #d0d7de)',
            color: 'var(--livewritemd-quote-text-color, #656d76)',
        },
        '.cm-md-blockquote-2': {
            paddingLeft: '2.4em !important',
            backgroundImage: 'linear-gradient(var(--livewritemd-quote-border-color, #007acc), var(--livewritemd-quote-border-color, #007acc))',
            backgroundSize: '3px 100%',
            backgroundRepeat: 'no-repeat',
            backgroundPosition: '1.2em 0',
        },
        '&light .cm-md-blockquote-2': {
            backgroundImage: 'linear-gradient(var(--livewritemd-quote-border-color, #d0d7de), var(--livewritemd-quote-border-color, #d0d7de))',
        },
        '.cm-md-blockquote-3': {
            paddingLeft: '3.6em !important',
            backgroundImage: 'linear-gradient(var(--livewritemd-quote-border-color, #007acc), var(--livewritemd-quote-border-color, #007acc)), linear-gradient(var(--livewritemd-quote-border-color, #007acc), var(--livewritemd-quote-border-color, #007acc))',
            backgroundSize: '3px 100%, 3px 100%',
            backgroundRepeat: 'no-repeat, no-repeat',
            backgroundPosition: '1.2em 0, 2.4em 0',
        },
        '&light .cm-md-blockquote-3': {
            backgroundImage: 'linear-gradient(var(--livewritemd-quote-border-color, #d0d7de), var(--livewritemd-quote-border-color, #d0d7de)), linear-gradient(var(--livewritemd-quote-border-color, #d0d7de), var(--livewritemd-quote-border-color, #d0d7de))',
        },
        '.cm-md-blockquote-4': {
            paddingLeft: '4.8em !important',
            backgroundImage:
                'linear-gradient(var(--livewritemd-quote-border-color, #007acc), var(--livewritemd-quote-border-color, #007acc)), linear-gradient(var(--livewritemd-quote-border-color, #007acc), var(--livewritemd-quote-border-color, #007acc)), linear-gradient(var(--livewritemd-quote-border-color, #007acc), var(--livewritemd-quote-border-color, #007acc))',
            backgroundSize: '3px 100%, 3px 100%, 3px 100%',
            backgroundRepeat: 'no-repeat, no-repeat, no-repeat',
            backgroundPosition: '1.2em 0, 2.4em 0, 3.6em 0',
        },
        '&light .cm-md-blockquote-4': {
            backgroundImage:
                'linear-gradient(var(--livewritemd-quote-border-color, #d0d7de), var(--livewritemd-quote-border-color, #d0d7de)), linear-gradient(var(--livewritemd-quote-border-color, #d0d7de), var(--livewritemd-quote-border-color, #d0d7de)), linear-gradient(var(--livewritemd-quote-border-color, #d0d7de), var(--livewritemd-quote-border-color, #d0d7de))',
        },
        '.cm-md-blockquote-5': {
            paddingLeft: '6em !important',
            backgroundImage:
                'linear-gradient(var(--livewritemd-quote-border-color, #007acc), var(--livewritemd-quote-border-color, #007acc)), linear-gradient(var(--livewritemd-quote-border-color, #007acc), var(--livewritemd-quote-border-color, #007acc)), linear-gradient(var(--livewritemd-quote-border-color, #007acc), var(--livewritemd-quote-border-color, #007acc)), linear-gradient(var(--livewritemd-quote-border-color, #007acc), var(--livewritemd-quote-border-color, #007acc))',
            backgroundSize: '3px 100%, 3px 100%, 3px 100%, 3px 100%',
            backgroundRepeat: 'no-repeat, no-repeat, no-repeat, no-repeat',
            backgroundPosition: '1.2em 0, 2.4em 0, 3.6em 0, 4.8em 0',
        },
        '&light .cm-md-blockquote-5': {
            backgroundImage:
                'linear-gradient(var(--livewritemd-quote-border-color, #d0d7de), var(--livewritemd-quote-border-color, #d0d7de)), linear-gradient(var(--livewritemd-quote-border-color, #d0d7de), var(--livewritemd-quote-border-color, #d0d7de)), linear-gradient(var(--livewritemd-quote-border-color, #d0d7de), var(--livewritemd-quote-border-color, #d0d7de)), linear-gradient(var(--livewritemd-quote-border-color, #d0d7de), var(--livewritemd-quote-border-color, #d0d7de))',
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
            backgroundColor:
                'var(--livewritemd-codeblock-background, var(--vscode-textCodeBlock-background, rgba(128,128,128,0.08)))',
            // 四条边线一律**不用 border**、改用 inset 阴影，原因见下面 first/last 的说明：
            // 上下边的 1px border 会计入 `.cm-line` 实测盒高（进文本模式后行高跳变）；
            // 左右边在 border-box 下会把正文内容往里挤 1px，文本模式没有竖边，
            // 整块代码左右各漂 1px（2026-09-22 反馈：「正文变文本模式时会左右漂移」）。
            // inset 阴影同色同位置但不占布局：行高、内容宽度两态完全一致，
            // 长代码的折行位置也不会变（两态内容宽度相同）。
            // 边线颜色抽成 CSS 变量：浅色只覆盖这一个变量即可，不用重复整段阴影。
            '--cm-codeblock-edge':
                'var(--livewritemd-codeblock-edge, rgba(255, 255, 255, 0.12))',
            boxShadow:
                'inset 1px 0 0 var(--cm-codeblock-edge), inset -1px 0 0 var(--cm-codeblock-edge)',
            // 这里的 0.9em 横向 padding 实际被 theme.ts 的「`.cm-line` { padding: 0 4px }」
            // 覆盖（theme 优先于 baseTheme），保留仅作兜底语义
            padding: '0 0.9em',
            boxSizing: 'border-box',
        },
        '&light .cm-md-codeblock': {
            backgroundColor:
                'var(--livewritemd-codeblock-background, var(--vscode-textCodeBlock-background, rgba(0, 0, 0, 0.035)))',
            // 浅色边线：只换变量，first/last 那几条 box-shadow 自动跟着变色
            '--cm-codeblock-edge':
                'var(--livewritemd-codeblock-edge, rgba(0, 0, 0, 0.1))',
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

};
