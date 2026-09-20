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
        '.cm-md-bold': {
            fontWeight: '700',
            color: '#d9a37a',
        },
        '.cm-md-italic': {
            fontStyle: 'italic',
            color: '#2bbac5',
        },
        '.cm-md-strikethrough': {
            textDecoration: 'line-through',
            opacity: '0.6',
        },

        // =================================================================
        // Inline code
        // =================================================================
        '.cm-md-code': {
            fontFamily:
                'var(--vscode-editor-font-family, "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace)',
            fontSize: 'var(--vscode-editor-font-size, 0.9em)',
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
            borderLeft: '1px solid rgba(255, 255, 255, 0.12)',
            borderRight: '1px solid rgba(255, 255, 255, 0.12)',
            padding: '0 0.9em',
            boxSizing: 'border-box',
        },
        '&light .cm-md-codeblock': {
            backgroundColor: 'var(--vscode-textCodeBlock-background, rgba(0, 0, 0, 0.035))',
            borderLeft: '1px solid rgba(0, 0, 0, 0.1)',
            borderRight: '1px solid rgba(0, 0, 0, 0.1)',
        },
        '.cm-md-codeblock-first': {
            borderTop: '1px solid rgba(255, 255, 255, 0.12)',
            borderTopLeftRadius: '12px',
            borderTopRightRadius: '12px',
        },
        '.cm-md-codeblock-last': {
            borderBottom: '1px solid rgba(255, 255, 255, 0.12)',
            borderBottomLeftRadius: '12px',
            borderBottomRightRadius: '12px',
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
        '&light .cm-md-bullet': {
            color: '#636c76',
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
        '.cm-md-hr': {
            border: 'none',
            height: '1px',
            background: 'rgba(128,128,128,0.3)',
            margin: '-6px 0',
        },
        '&light .cm-md-hr': {
            background: '#d0d7de',
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
        // Tables
        // =================================================================
        // 表格宽度随内容走，整块在正文里居中；fit-content 保证加列按钮条
        // 仍然紧贴表格右边，而不是被撑到正文宽度。
        '.cm-md-table-wrapper': {
            padding: '8px 0',
            display: 'flex',
            width: 'fit-content',
            maxWidth: '100%',
            margin: '0 auto',
            flexDirection: 'column',
            alignItems: 'stretch',
        },
        '.cm-md-table-top-row': {
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'stretch',
        },
        '.cm-md-table': {
            width: 'auto',
            borderCollapse: 'collapse',
            fontSize: 'inherit',
            fontFamily: 'inherit',
        },
        '.cm-md-table-th': {
            border: '1px solid rgba(128,128,128,0.3)',
            padding: '6px 12px',
            minWidth: '3em',
            fontWeight: '600',
            backgroundColor: 'rgba(128,128,128,0.1)',
            color: 'inherit',
            textAlign: 'left',
        },
        '&light .cm-md-table-th': {
            border: '1px solid #d0d7de',
            backgroundColor: '#f6f8fa',
        },
        '.cm-md-table-td': {
            border: '1px solid rgba(128,128,128,0.3)',
            padding: '6px 12px',
            minWidth: '3em',
            color: 'inherit',
        },
        '&light .cm-md-table-td': {
            border: '1px solid #d0d7de',
        },
        '.cm-md-table tr:nth-child(even) td': {
            backgroundColor: 'rgba(128,128,128,0.04)',
        },

        // Row add bar (bottom - full table width, flow layout)
        '.cm-md-table-add-row-bar': {
            height: '14px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: '0',
            transition: 'opacity 0.15s ease, background-color 0.15s ease',
            borderRadius: '0 0 3px 3px',
            position: 'relative',
        },
        '.cm-md-table-wrapper:hover .cm-md-table-add-row-bar': {
            opacity: '1',
        },
        '.cm-md-table-add-row-bar::before': {
            content: '""',
            position: 'absolute',
            left: '0',
            right: '0',
            top: '50%',
            height: '2px',
            backgroundColor: 'rgba(79, 193, 255, 0.35)',
            transform: 'translateY(-50%)',
            borderRadius: '1px',
        },
        '.cm-md-table-add-row-bar:hover::before': {
            backgroundColor: 'rgba(79, 193, 255, 0.7)',
        },
        '&light .cm-md-table-add-row-bar::before': {
            backgroundColor: 'rgba(9, 105, 218, 0.3)',
        },
        '&light .cm-md-table-add-row-bar:hover::before': {
            backgroundColor: 'rgba(9, 105, 218, 0.6)',
        },

        // Column add bar (right - full table height, flow layout)
        '.cm-md-table-add-col-bar': {
            width: '14px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: '0',
            transition: 'opacity 0.15s ease, background-color 0.15s ease',
            borderRadius: '0 3px 3px 0',
            position: 'relative',
        },
        '.cm-md-table-wrapper:hover .cm-md-table-add-col-bar': {
            opacity: '1',
        },
        '.cm-md-table-add-col-bar::before': {
            content: '""',
            position: 'absolute',
            top: '0',
            bottom: '0',
            left: '50%',
            width: '2px',
            backgroundColor: 'rgba(79, 193, 255, 0.35)',
            transform: 'translateX(-50%)',
            borderRadius: '1px',
        },
        '.cm-md-table-add-col-bar:hover::before': {
            backgroundColor: 'rgba(79, 193, 255, 0.7)',
        },
        '&light .cm-md-table-add-col-bar::before': {
            backgroundColor: 'rgba(9, 105, 218, 0.3)',
        },
        '&light .cm-md-table-add-col-bar:hover::before': {
            backgroundColor: 'rgba(9, 105, 218, 0.6)',
        },

        // Plus icon shared style
        '.cm-md-table-add-icon': {
            fontSize: '12px',
            fontWeight: '700',
            color: 'rgba(79, 193, 255, 0.7)',
            lineHeight: '1',
            zIndex: '1',
            backgroundColor: '#272b33',
            padding: '0 3px',
            borderRadius: '2px',
            userSelect: 'none',
        },
        '&light .cm-md-table-add-icon': {
            color: 'rgba(9, 105, 218, 0.6)',
            backgroundColor: '#ffffff',
        },
        '.cm-md-table-add-row-bar:hover .cm-md-table-add-icon': {
            color: '#4fc1ff',
        },
        '.cm-md-table-add-col-bar:hover .cm-md-table-add-icon': {
            color: '#4fc1ff',
        },
        '&light .cm-md-table-add-row-bar:hover .cm-md-table-add-icon': {
            color: '#0969da',
        },
        '&light .cm-md-table-add-col-bar:hover .cm-md-table-add-icon': {
            color: '#0969da',
        },

        // Hide add-row/add-col bars in viewer mode (not editable)
        '.cm-content[contenteditable="false"] .cm-md-table-add-row-bar': {
            display: 'none',
        },
        '.cm-content[contenteditable="false"] .cm-md-table-add-col-bar': {
            display: 'none',
        },

        // Cell selection highlight (drag select within table)
        // Higher specificity (0,2,2) overrides even-row rule (0,2,1)
        '.cm-md-table-cell-selected': {
            backgroundColor: 'rgba(59,130,246,0.22)',
        },
        '.cm-md-table tr td.cm-md-table-cell-selected': {
            backgroundColor: 'rgba(59,130,246,0.22)',
        },
        '.cm-md-table tr th.cm-md-table-cell-selected': {
            backgroundColor: 'rgba(59,130,246,0.22)',
        },
        '&light .cm-md-table-cell-selected': {
            backgroundColor: 'rgba(9,105,218,0.15)',
        },
        '&light .cm-md-table tr td.cm-md-table-cell-selected': {
            backgroundColor: 'rgba(9,105,218,0.15)',
        },
        '&light .cm-md-table tr th.cm-md-table-cell-selected': {
            backgroundColor: 'rgba(9,105,218,0.15)',
        },
        // Rectangular border on selection edges
        '.cm-md-table-cell-sel-top': { borderTop: '2px solid rgba(59,130,246,0.8)' },
        '.cm-md-table-cell-sel-bottom': { borderBottom: '2px solid rgba(59,130,246,0.8)' },
        '.cm-md-table-cell-sel-left': { borderLeft: '2px solid rgba(59,130,246,0.8)' },
        '.cm-md-table-cell-sel-right': { borderRight: '2px solid rgba(59,130,246,0.8)' },
        '&light .cm-md-table-cell-sel-top': { borderTop: '2px solid rgba(9,105,218,0.7)' },
        '&light .cm-md-table-cell-sel-bottom': { borderBottom: '2px solid rgba(9,105,218,0.7)' },
        '&light .cm-md-table-cell-sel-left': { borderLeft: '2px solid rgba(9,105,218,0.7)' },
        '&light .cm-md-table-cell-sel-right': { borderRight: '2px solid rgba(9,105,218,0.7)' },

        // Table extent selection: subtle outline when CM6 selection covers the table (no cell drag active)
        '.cm-md-table-wrapper.cm-md-table-extent-selected': {
            outline: '1px dashed rgba(59,130,246,0.5)',
            outlineOffset: '2px',
        },
        '&light .cm-md-table-wrapper.cm-md-table-extent-selected': {
            outline: '1px dashed rgba(9,105,218,0.5)',
            outlineOffset: '2px',
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
        // 整行只有一张图片时让它居中；行内还有文字时保持内联，不打断原有排版。
        // 注意 :only-child 不数文本节点，所以“文字+图片”的行也会命中这条，
        // 那种情况下整行居中，是刻意的取舍。
        '.cm-line:has(> .cm-md-image-wrapper:only-child)': {
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
        '.cm-md-indent': {
            position: 'relative',
        },
        '.cm-md-indent-1': {
            borderLeft: '1px solid rgba(128, 128, 128, 0.2)',
            marginLeft: '0.5em',
            paddingLeft: '0.5em !important',
        },
        '.cm-md-indent-2': {
            borderLeft: '1px solid rgba(128, 128, 128, 0.2)',
            marginLeft: '0.5em',
            paddingLeft: '0.5em !important',
        },
        '.cm-md-indent-3': {
            borderLeft: '1px solid rgba(128, 128, 128, 0.2)',
            marginLeft: '0.5em',
            paddingLeft: '0.5em !important',
        },
        '.cm-md-indent-4': {
            borderLeft: '1px solid rgba(128, 128, 128, 0.2)',
            marginLeft: '0.5em',
            paddingLeft: '0.5em !important',
        },
        '.cm-md-indent-5': {
            borderLeft: '1px solid rgba(128, 128, 128, 0.2)',
            marginLeft: '0.5em',
            paddingLeft: '0.5em !important',
        },
        '.cm-md-indent-6': {
            borderLeft: '1px solid rgba(128, 128, 128, 0.2)',
            marginLeft: '0.5em',
            paddingLeft: '0.5em !important',
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
        '.cm-md-math-block': {
            display: 'block',
            textAlign: 'center',
            padding: '20px 0',
        },
        '.cm-md-math-block math': {
            fontSize: '1.15em',
        },
    });
}
