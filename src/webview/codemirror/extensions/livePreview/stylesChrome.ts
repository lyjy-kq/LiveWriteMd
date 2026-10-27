/**
 * Live Preview 样式片段（从 styles.ts 拆出）：界面构件：折叠箭头 / 折叠角花 / 缩进引导线 / 标题折叠 / 代码块缩进导引 / Frontmatter / KaTeX。
 *
 * 只是 baseTheme 大对象的一部分；styles.ts 里按原顺序 spread 合并。
 *
 * @module webview/codemirror/extensions/livePreview/stylesChrome
 */

export const CHROME_STYLES = {
        // =================================================================
        // Fold corner armor（折叠行矩形左缘的「两角铠甲」）
        // =================================================================
        // 折叠列表项 / 标题后，该行矩形**左上、左下**各长出一段内收 L 形角花，
        // 像半个锁定框，表明这一行收拢了内容；颜色与折叠箭头同源。无底色无
        // 文字，不碰正文。早先的整条背景色、行尾徽章、四角版用户均不满意，
        // 最终只留左两角。
        //
        // 实现：一个 ::before 绝对定位铺满行矩形，用 **4 层线性渐变**（两角各
        // 一条水平臂 + 一条垂直臂）拼出 2 个 L。
        //
        // 层叠口径与旧背景版一致：position:relative + isolation:isolate 建立
        // 层叠上下文，z-index:-1 的伪元素绘于「列表色带背景之上、正文文字
        // 之下」，角花不会盖住字。
        '.cm-md-fold-armor': {
            position: 'relative',
            isolation: 'isolate',
        },
        '.cm-md-fold-armor::before': {
            content: '""',
            position: 'absolute',
            // 角花整体内收 2px，不顶到矩形边，「内收」感
            top: '2px',
            bottom: '2px',
            // 左缘抵消 .cm-line 的左 padding（lineGutterGap），角花贴到行矩形
            // 最左缘
            left: 'calc(2px - var(--livewritemd-line-padding-left, 0px))',
            // 必须显式给宽：去掉 right 后绝对定位元素 shrink-to-fit，而背景
            // 渐变不占布局空间，宽度会塌成 0、角花整条被裁掉
            width: '10px',
            zIndex: '-1',
            pointerEvents: 'none',
            backgroundRepeat: 'no-repeat',
            // ::before 只画**左侧上下两角**：各一条水平臂 + 垂直臂，共 4 层
            backgroundImage: [
                'linear-gradient(to right, var(--livewritemd-fold-color, #4fc1ff) 10px, transparent 10px)',
                'linear-gradient(to right, var(--livewritemd-fold-color, #4fc1ff) 10px, transparent 10px)',
                'linear-gradient(to bottom, var(--livewritemd-fold-color, #4fc1ff) 10px, transparent 10px)',
                'linear-gradient(to bottom, var(--livewritemd-fold-color, #4fc1ff) 10px, transparent 10px)',
            ].join(','),
            backgroundPosition: [
                'left top', 'left bottom', 'left top', 'left bottom',
            ].join(','),
            backgroundSize: [
                '10px 1.5px', '10px 1.5px', '1.5px 10px', '1.5px 10px',
            ].join(','),
        },
        // 浅色主题：左侧角花 fallback 换 #0969da
        '&light .cm-md-fold-armor::before': {
            backgroundImage: [
                'linear-gradient(to right, var(--livewritemd-fold-color, #0969da) 10px, transparent 10px)',
                'linear-gradient(to right, var(--livewritemd-fold-color, #0969da) 10px, transparent 10px)',
                'linear-gradient(to bottom, var(--livewritemd-fold-color, #0969da) 10px, transparent 10px)',
                'linear-gradient(to bottom, var(--livewritemd-fold-color, #0969da) 10px, transparent 10px)',
            ].join(','),
        },
        // =================================================================
        // Indent guide lines (for nested list items)
        // =================================================================
        // 这个类本身只定义引导线的**颜色变量**；竖线背景、悬挂缩进（padding/
        // text-indent）、定位原点全部由 plugin.ts 按真实测量结果写成行内样式，
        // 见 collectListIndentDecorations 与 helpers.ts 的 createListIndentStyle。
        //
        // 引导线载体类（背景由 plugin 按层级写成行内样式；颜色为 rainbow，
        // 见 helpers.ts 的 rainbowIndentColor）。此处无需颜色变量。

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
        // Heading fold chevron（标题章节折叠箭头）
        // =================================================================
        // 根盒 0 宽、1em 高：为内部箭头提供垂直居中参照；
        // 水平位置由 widget 行内 left:-4px 推到行号/正文分界处。
        '.cm-md-heading-fold': {
            position: 'relative',
            display: 'inline-block',
            width: '0',
            height: '1em',
            margin: '0',
            // 默认低调，hover 该行才出现
            color:
                'var(--livewritemd-fold-color, rgba(200,205,215,0.6))',
            opacity: '0',
            cursor: 'pointer',
            transition: 'opacity 0.15s ease',
        },
        '.cm-md-heading-fold svg': {
            position: 'absolute',
            left: '0',
            top: '50%',
            transform: 'translate(-50%, -50%)',
        },
        '.cm-line:hover > .cm-md-heading-fold, .cm-md-heading-fold.is-folded':
            {
                opacity: '1',
            },
        // 悬停（未折叠）：与列表 chevron 一致，用 accent 色
        '.cm-line:hover > .cm-md-heading-fold:not(.is-folded)': {
            color:
                'var(--livewritemd-fold-color, var(--livewritemd-accent, #4fc1ff))',
        },
        // 折叠态：accent 色 + 旋转朝右
        '.cm-md-heading-fold.is-folded': {
            color:
                'var(--livewritemd-fold-color, var(--livewritemd-accent, #4fc1ff))',
        },
        '.cm-md-heading-fold.is-folded svg': {
            transform: 'translate(-50%, -50%) rotate(-90deg)',
        },
        // 浅色主题：默认低调
        '&light .cm-md-heading-fold': {
            color:
                'var(--livewritemd-fold-color, rgba(25,30,40,0.55))',
        },
        '&light .cm-line:hover > .cm-md-heading-fold:not(.is-folded), &light .cm-md-heading-fold.is-folded': {
            color: 'var(--livewritemd-fold-color, #0969da)',
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
            // 等高设计：min-height（行数×行高）由 widget 内联写入，这里只做
            // 纵向 flex 布局，键值网格超出时内部滚动而不是把卡片撑得比源码高
            display: 'flex',
            flexDirection: 'column',
            boxSizing: 'border-box',
            cursor: 'text',
        },
        '&light .cm-md-frontmatter': {
            backgroundColor: 'rgba(0, 0, 0, 0.03)',
        },
        // 折叠态：只剩一条标题栏，键值网格隐藏
        '.cm-md-frontmatter.cm-md-frontmatter-collapsed .cm-md-frontmatter-grid': {
            display: 'none',
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
            flex: '0 0 auto',
        },
        '.cm-md-frontmatter.cm-md-frontmatter-collapsed .cm-md-frontmatter-header': {
            marginBottom: '0',
        },
        '.cm-md-frontmatter-header-icon': {
            fontSize: '0.95em',
            lineHeight: '1',
        },
        // 标题文字占满中间，折叠箭头推到最右
        '.cm-md-frontmatter-header-text': {
            flex: '1 1 auto',
        },
        '.cm-md-frontmatter-toggle': {
            flex: '0 0 auto',
            cursor: 'pointer',
            padding: '0 4px',
            borderRadius: '4px',
            lineHeight: '1.4',
            userSelect: 'none',
        },
        '.cm-md-frontmatter-toggle:hover': {
            backgroundColor: 'rgba(128, 128, 128, 0.16)',
        },
        '.cm-md-frontmatter-grid': {
            display: 'grid',
            gridTemplateColumns: '20px auto 1fr',
            gap: '0',
            alignItems: 'baseline',
            // 等高卡片内：网格吃剩余高度，键值多了内部滚动
            flex: '1 1 auto',
            minHeight: '0',
            overflowY: 'auto',
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
        //   - 行高跟着 `--livewritemd-line-height`（webviewContent.ts 注进来的用户设置），
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
            height: 'calc(2.5 * var(--livewritemd-line-height, 1.7em))',
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
};
