/**
 * Live Preview 样式片段（从 styles.ts 拆出）：媒体与杂项：图片 / 脚注 / Details 折叠块 / 圆点定位。
 *
 * 只是 baseTheme 大对象的一部分；styles.ts 里按原顺序 spread 合并。
 *
 * @module webview/codemirror/extensions/livePreview/stylesMedia
 */

export const MEDIA_STYLES = {
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
            textAlign: 'var(--livewritemd-media-center-align, center)',
        },
        '.cm-md-image': {
            maxWidth: '100%',
            height: 'auto',
            borderRadius: '4px',
            verticalAlign: 'middle',
        },
        // 行内 <img>：表格格子里的海报缩略图（见 InlineHtmlImageWidget）。
        // 尺寸优先听标签的 width/height 属性；没有属性时按图片原始尺寸。
        // max-width 只在正文行里生效（.cm-line 后代）：表格列宽是用屏幕外
        // 量尺量的，量尺宿主是 0 宽，100% 会解析成 0，把图片量成零宽、
        // 列宽跟着算小，最后图片被挤成一条 —— 量尺里必须让 width 属性说了算。
        '.cm-md-inline-image': {
            display: 'inline-block',
            verticalAlign: 'middle',
            height: 'auto',
            borderRadius: '3px',
        },
        '.cm-line .cm-md-inline-image': {
            maxWidth: '100%',
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
        // Bullet dot（水平圆心 = '-' 中点，垂直圆心 = 行盒中心 + 用户微调）
        // =================================================================
        // top 由三部分叠加：
        // - 50%：0 高 inline-block 的 middle 对齐点（见下，盒子无 in-flow 内容）；
        // - --cm-dot-y-correction：middle 点与行盒中心的亚像素差，BulletWidget
        //   实测写入，不补偿圆点会系统性偏下（见 helpers measureBulletYCorrection）；
        // - --livewritemd-bullet-y-offset：设置面板里的「圆点垂直位置」用户微调。
        '.cm-md-bullet-dot': {
            position: 'absolute',
            left: 'var(--cm-mark-center, 0.62em)',
            top:
                'calc(50% + var(--cm-dot-y-correction, 0px) + ' +
                'var(--livewritemd-bullet-y-offset, 0em))',
            width: '12px',
            height: '12px',
            // 字号钉回正文那套：dot 内只有 SVG、无文字，设字号纯粹是为了让
            // 上面 em 偏移的基准 == 正文字号；否则继承 .cm-md-bullet 的 1.1em，
            // 用户的微调会被放大 1.1 倍
            fontSize:
                'calc(var(--livewritemd-editor-font-size, ' +
                'var(--vscode-editor-font-size, 14px)) * ' +
                'var(--livewritemd-font-scale, 1))',
            lineHeight: '1',
            transform: 'translate(-50%, -50%)',
        },

        // =================================================================
        // Gutter fold chevron（折叠箭头放在行号位置）
        // =================================================================
        // 行号格本身是定位上下文：箭头绝对定位铺满它，覆盖在数字之上。
        '.cm-lineNumbers .cm-gutterElement': {
            position: 'relative',
        },
        // 可折叠行号格：悬停时、或已折叠时，数字让位（透明）。
        // 用 color:transparent 而不是改 opacity —— 数字是格内文本节点，
        // 不能单独选；透明后宽度/布局完全不变，不会跳动。
        '.cm-lineNumbers .cm-gutterElement.cm-md-foldable-line:hover, .cm-lineNumbers .cm-gutterElement.cm-md-foldable-line.is-folded':
            {
                color: 'transparent',
            },
        // 箭头本体：绝对定位铺满行号格，默认透明。
        // 颜色用固定变量而非 currentColor —— 父格悬停时 color 已被设为
        // transparent，继承下去箭头会一起消失。
        '.cm-md-gutter-fold': {
            position: 'absolute',
            inset: '0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: '0',
            cursor: 'pointer',
            color: 'var(--livewritemd-fold-color, #4fc1ff)',
            transition: 'opacity 0.15s ease',
        },
        // 悬停行号格：箭头淡入
        '.cm-lineNumbers .cm-gutterElement:hover > .cm-md-gutter-fold': {
            opacity: '1',
        },
        // 折叠态：箭头常驻、旋转朝右
        '.cm-lineNumbers .cm-gutterElement.is-folded > .cm-md-gutter-fold': {
            opacity: '1',
        },
        '.cm-lineNumbers .cm-gutterElement.is-folded > .cm-md-gutter-fold svg':
            {
                transform: 'rotate(-90deg)',
            },
        '&light .cm-md-gutter-fold': {
            color: 'var(--livewritemd-fold-color, #0969da)',
        },
};
