/**
 * CodeMirror Theme Extension
 *
 * This module provides theme configuration for the LiveWriteMD editor,
 * including light and dark themes that integrate with VS Code's
 * color scheme using CSS variables.
 *
 * Features:
 * - Light and dark theme definitions using EditorView.theme()
 * - VS Code CSS variable integration (--vscode-editor-*)
 * - Dynamic theme switching using Compartment
 * - Theme switch completion within 200ms (per REQ-F-008)
 *
 * @module webview/codemirror/extensions/theme
 *
 * Design References:
 * - DES-A-006: Theme integration design
 * - DES-F-003: Webview file responsibilities
 *
 * Requirements:
 * - REQ-F-008: Dark/Light theme support
 */

import { type Extension, Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { ThemeType } from '../../../shared/types';

// =============================================================================
// Theme Compartment for Dynamic Reconfiguration
// =============================================================================

/**
 * Compartment for dynamic theme reconfiguration.
 *
 * This compartment allows the theme to be changed at runtime without
 * recreating the entire editor. Use this with EditorView.dispatch()
 * to switch themes.
 *
 * @example
 * ```typescript
 * // Switch to dark theme
 * view.dispatch({
 *     effects: themeCompartment.reconfigure(darkTheme)
 * });
 *
 * // Switch to light theme
 * view.dispatch({
 *     effects: themeCompartment.reconfigure(lightTheme)
 * });
 * ```
 */
export const themeCompartment = new Compartment();

// =============================================================================
// Light Theme Definition
// =============================================================================

/**
 * Light theme for CodeMirror editor.
 *
 * This theme uses VS Code CSS variables to ensure visual consistency
 * with the VS Code editor environment. All colors are derived from
 * VS Code's theme CSS variables.
 *
 * Design Reference: DES-A-006
 *
 * @example
 * ```typescript
 * import { lightTheme, themeCompartment } from './theme';
 *
 * const state = EditorState.create({
 *     doc: '# Hello',
 *     extensions: [themeCompartment.of(lightTheme)],
 * });
 * ```
 */
export const lightTheme: Extension = EditorView.theme(
    {
        // Root editor container — LiveWriteMD独自カラー
        '&': {
            // 浅色主题的兜底值要和主题一致：原来错用了深色的 #1e1e1e / #d4d4d4，
            // 一旦 VS Code 变量缺失会变成「白底配浅字」；正文色本身仍跟随主题。
            backgroundColor: 'var(--vscode-editor-background, #ffffff)',
            color: 'var(--vscode-editor-foreground, #24292e)',
            height: '100%',
            // 中英文字体设置合成到 --livewritemd-editor-font-family；
            // 未设置时逐层回退，和改造前完全一致。代码块不走这条规则。
            fontFamily:
                'var(--livewritemd-editor-font-family, var(--vscode-editor-font-family, "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace))',
        },

        // Content area (main editing region)
        // lineHeight uses 'em' fallback (not unitless) so that child elements
        // with different font-size (e.g. code blocks at 0.9em) inherit the
        // computed pixel value rather than a multiplier, preventing height
        // estimation mismatches that cause scroll jumps.
        '.cm-content': {
            fontFamily: 'inherit',
            fontSize:
                'calc(var(--livewritemd-editor-font-size, var(--vscode-editor-font-size, 14px)) * var(--livewritemd-font-scale, 1))',
            fontWeight: 'var(--livewritemd-font-weight, 400)',
            lineHeight: 'var(--livewritemd-line-height, 1.7em)',
            color: 'inherit',
            caretColor: 'var(--vscode-editorCursor-foreground, var(--vscode-editor-foreground, #d4d4d4))',
            padding: '8px 0',
        },

        // Scroller container
        '.cm-scroller': {
            fontFamily: 'inherit',
            overflow: 'auto',
        },

        // Focused state
        '&.cm-focused': {
            outline: 'none',
        },

        // Selection styling — drawSelection() + ネイティブ選択の両対応
        '& ::selection': {
            backgroundColor: 'rgba(0, 120, 215, 0.3)',
        },
        // drawSelection() のオーバーレイ（矩形選択・複数カーソル用）
        '.cm-selectionBackground': {
            backgroundColor: 'rgba(0, 120, 215, 0.3) !important',
        },
        // drawSelection()使用時はネイティブ選択を透明にして二重表示を防ぐ
        '&.cm-focused .cm-line ::selection': {
            backgroundColor: 'transparent',
        },

        // Selection mark decoration (codeBlockSelectionPlugin)
        '.cm-codeblock-selected': {
            backgroundColor: 'rgba(0, 120, 215, 0.3)',
            borderRadius: '2px',
        },
        // Widget selection highlight (replace-decoration widgets)
        '.cm-widget-selected': {
            outline: '2px solid rgba(0, 120, 215, 0.5)',
            outlineOffset: '-1px',
            borderRadius: '3px',
        },

        // Inactive selection (when editor loses focus)
        '.cm-selectionMatch': {
            backgroundColor: 'rgba(0, 120, 215, 0.1)',
        },

        // Active line highlighting
        '.cm-activeLine': {
            backgroundColor: 'rgba(0, 0, 0, 0.04)',
        },

        // Line numbers gutter
        '.cm-gutters': {
            backgroundColor: 'transparent',
            color: '#6a737d',
            border: 'none',
            borderRight: '1px solid #e0e0e0',
        },

        // Active line number
        '.cm-activeLineGutter': {
            backgroundColor: 'rgba(0, 0, 0, 0.04)',
            color: '#24292e',
        },

        // Fold gutter
        '.cm-foldGutter': {
            color: '#6a737d',
        },

        // 行号数字在格子里**垂直居中**。
        //
        // CM6 给每个行号格子（.cm-gutterElement）写死的高度 = 对应正文行的总高
        // （GutterElement.update 里 style.height = height + 'px'），但数字是裸文本
        // 节点，按行号栏自己继承的行高从格子**顶部**开始排 —— 行号栏不在
        // .cm-content 里，吃不到正文那条 1.7em 行高，于是普通行就差 1.4px，
        // 标题 / 折行段落 / 高表格行这种「行比默认高很多」的偏得更多
        // （实测 47.6px 的表格行差 13.3px，数字明显吊在上面）。
        // 改成 flex 纵向居中后，数字的中心永远 = 格子的中心 = 行的中心；
        // justify-content: flex-end 接替原来 text-align: right 的右对齐。
        '.cm-lineNumbers .cm-gutterElement': {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
        },

        // Search match highlighting
        '.cm-searchMatch': {
            backgroundColor: 'rgba(255, 255, 0, 0.4)',
            borderRadius: '2px',
        },

        // Current search match
        '.cm-searchMatch.cm-searchMatch-selected': {
            backgroundColor: 'rgba(255, 215, 0, 0.6)',
        },

        // Matching brackets
        '&.cm-focused .cm-matchingBracket': {
            backgroundColor: 'rgba(0, 100, 0, 0.1)',
            outline: '1px solid #b9b9b9',
        },

        // Tooltip styling
        '.cm-tooltip': {
            backgroundColor: '#ffffff',
            color: '#24292e',
            border: '1px solid #c8c8c8',
            borderRadius: '4px',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
        },

        // 搜索 / 替换面板（.cm-panels / .cm-search / 输入框 / 按钮 / 计数）
        // 的样式统一在 searchPanel.ts 中按 VS Code 主题变量定义，深浅色共用，
        // 这里不再重复，避免硬编码颜色与卡片主题打架。

        // Markdown 语义颜色（源码编辑态）
        '.cm-line .tok-heading, .cm-line .tok-heading1': {
            color: '#eb8383',
        },
        '.cm-line .tok-heading2': {
            color: '#ae9acb',
        },
        '.cm-line .tok-heading3': {
            color: '#7db5cd',
        },
        '.cm-line .tok-heading4': {
            color: '#71a796',
        },
        '.cm-line .tok-heading5': {
            color: '#dcbf61',
        },
        '.cm-line .tok-heading6': {
            color: '#dda36a',
        },
        '.cm-line .tok-strong, .cm-line .tok-strongEmphasis': {
            color: '#d9a37a',
            // 和实时模式的「加粗真加粗」共用同一个变量：默认 inherit（不加粗），
            // 打开设置后才写入 700，两种模式表现一致。
            fontWeight: 'var(--livewritemd-bold-weight, inherit)',
        },
        '.cm-line .tok-emphasis': {
            color: '#2bbac5',
        },
        '.cm-line .tok-link, .cm-line .tok-url': {
            color: '#b8f5a2',
            textDecoration: 'underline',
            textUnderlineOffset: '3px',
        },
        '.cm-line .tok-codeText, .cm-line .tok-inlineCode, .cm-line .tok-codeMark': {
            color: '#f29a9a',
        },

        // 左内边距 = 正文与行号竖线的距离（设置项 lineGutterGap），
        // 右侧 4px 保持原有视觉留白
        '.cm-line': {
            paddingLeft: 'var(--livewritemd-line-padding-left, 4px)',
            paddingRight: '4px',
        },
    },
    { dark: false }
);

// =============================================================================
// Dark Theme Definition
// =============================================================================

/**
 * Dark theme for CodeMirror editor.
 *
 * This theme uses VS Code CSS variables to ensure visual consistency
 * with the VS Code editor environment in dark mode. All colors are
 * derived from VS Code's theme CSS variables.
 *
 * Design Reference: DES-A-006
 *
 * @example
 * ```typescript
 * import { darkTheme, themeCompartment } from './theme';
 *
 * const state = EditorState.create({
 *     doc: '# Hello',
 *     extensions: [themeCompartment.of(darkTheme)],
 * });
 * ```
 */
export const darkTheme: Extension = EditorView.theme(
    {
        // Root editor container — LiveWriteMD独自カラー
        '&': {
            backgroundColor: 'var(--vscode-editor-background, #1e1e1e)',
            color: 'var(--vscode-editor-foreground, #d4d4d4)',
            height: '100%',
            // 中英文字体设置合成到 --livewritemd-editor-font-family；
            // 未设置时逐层回退，和改造前完全一致。代码块不走这条规则。
            fontFamily:
                'var(--livewritemd-editor-font-family, var(--vscode-editor-font-family, "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace))',
        },

        // Content area (main editing region)
        // lineHeight uses 'em' fallback (not unitless) so that child elements
        // with different font-size (e.g. code blocks at 0.9em) inherit the
        // computed pixel value rather than a multiplier, preventing height
        // estimation mismatches that cause scroll jumps.
        '.cm-content': {
            fontFamily: 'inherit',
            fontSize:
                'calc(var(--livewritemd-editor-font-size, var(--vscode-editor-font-size, 14px)) * var(--livewritemd-font-scale, 1))',
            fontWeight: 'var(--livewritemd-font-weight, 400)',
            lineHeight: 'var(--livewritemd-line-height, 1.7em)',
            color: 'inherit',
            caretColor: 'var(--vscode-editorCursor-foreground, var(--vscode-editor-foreground, #d4d4d4))',
            padding: '8px 0',
        },

        // Scroller container
        '.cm-scroller': {
            fontFamily: 'inherit',
            overflow: 'auto',
        },

        // Focused state
        '&.cm-focused': {
            outline: 'none',
        },

        // Selection styling — drawSelection() + ネイティブ選択の両対応
        '& ::selection': {
            backgroundColor: 'rgba(38, 118, 220, 0.55) !important',
        },
        '.cm-selectionBackground': {
            backgroundColor: 'rgba(38, 118, 220, 0.55) !important',
        },
        '&.cm-focused .cm-line ::selection': {
            backgroundColor: 'transparent',
        },

        // Selection mark decoration (codeBlockSelectionPlugin)
        '.cm-codeblock-selected': {
            backgroundColor: 'rgba(38, 118, 220, 0.55)',
            borderRadius: '2px',
        },
        // Widget selection highlight (replace-decoration widgets)
        '.cm-widget-selected': {
            outline: '2px solid rgba(38, 118, 220, 0.6)',
            outlineOffset: '-1px',
            borderRadius: '3px',
        },

        // Inactive selection (when editor loses focus)
        '.cm-selectionMatch': {
            backgroundColor: 'rgba(38, 118, 220, 0.30)',
        },

        // Active line highlighting
        '.cm-activeLine': {
            backgroundColor: 'rgba(255, 255, 255, 0.04)',
        },

        // Line numbers gutter
        '.cm-gutters': {
            backgroundColor: 'transparent',
            color: '#858585',
            border: 'none',
            borderRight: '1px solid #444444',
        },

        // Active line number
        '.cm-activeLineGutter': {
            backgroundColor: 'rgba(255, 255, 255, 0.04)',
            color: '#c6c6c6',
        },

        // Fold gutter
        '.cm-foldGutter': {
            color: '#858585',
        },

        // 行号数字在格子里垂直居中 —— 说明见上面 lightTheme 里的同一条规则。
        '.cm-lineNumbers .cm-gutterElement': {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
        },

        // Search match highlighting
        '.cm-searchMatch': {
            backgroundColor: 'rgba(234, 92, 0, 0.4)',
            borderRadius: '2px',
        },

        // Current search match
        '.cm-searchMatch.cm-searchMatch-selected': {
            backgroundColor: 'rgba(81, 92, 106, 0.6)',
        },

        // Matching brackets
        '&.cm-focused .cm-matchingBracket': {
            backgroundColor: 'rgba(0, 100, 0, 0.2)',
            outline: '1px solid #888888',
        },

        // Tooltip styling
        '.cm-tooltip': {
            backgroundColor: '#252526',
            color: '#cccccc',
            border: '1px solid #454545',
            borderRadius: '4px',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.36)',
        },

        // 搜索 / 替换面板（.cm-panels / .cm-search / 输入框 / 按钮 / 计数）
        // 的样式统一在 searchPanel.ts 中按 VS Code 主题变量定义，深浅色共用，
        // 这里不再重复，避免硬编码颜色与卡片主题打架。

        // Markdown 语义颜色（源码编辑态）
        '.cm-line .tok-heading, .cm-line .tok-heading1': {
            color: '#eb8383',
        },
        '.cm-line .tok-heading2': {
            color: '#ae9acb',
        },
        '.cm-line .tok-heading3': {
            color: '#7db5cd',
        },
        '.cm-line .tok-heading4': {
            color: '#71a796',
        },
        '.cm-line .tok-heading5': {
            color: '#dcbf61',
        },
        '.cm-line .tok-heading6': {
            color: '#dda36a',
        },
        '.cm-line .tok-strong, .cm-line .tok-strongEmphasis': {
            color: '#d9a37a',
            // 和实时模式的「加粗真加粗」共用同一个变量：默认 inherit（不加粗），
            // 打开设置后才写入 700，两种模式表现一致。
            fontWeight: 'var(--livewritemd-bold-weight, inherit)',
        },
        '.cm-line .tok-emphasis': {
            color: '#2bbac5',
        },
        '.cm-line .tok-link, .cm-line .tok-url': {
            color: '#b8f5a2',
            textDecoration: 'underline',
            textUnderlineOffset: '3px',
        },
        '.cm-line .tok-codeText, .cm-line .tok-inlineCode, .cm-line .tok-codeMark': {
            color: '#f29a9a',
        },

        // 左内边距 = 正文与行号竖线的距离（设置项 lineGutterGap），
        // 右侧 4px 保持原有视觉留白
        '.cm-line': {
            paddingLeft: 'var(--livewritemd-line-padding-left, 4px)',
            paddingRight: '4px',
        },
    },
    { dark: true }
);

// =============================================================================
// Theme Helper Functions
// =============================================================================

/**
 * Creates the theme extension with the specified initial theme.
 *
 * This function returns a Compartment-wrapped theme extension that
 * can be reconfigured at runtime using themeCompartment.reconfigure().
 *
 * @param theme - The initial theme ('light' or 'dark'). Defaults to 'dark'.
 * @returns Array of CodeMirror extensions for theme support
 *
 * @example
 * ```typescript
 * import { createThemeExtension, themeCompartment, darkTheme } from './theme';
 *
 * // Create editor with light theme
 * const state = EditorState.create({
 *     doc: '# Hello',
 *     extensions: createThemeExtension('light'),
 * });
 *
 * // Later, switch to dark theme
 * view.dispatch({
 *     effects: themeCompartment.reconfigure(darkTheme)
 * });
 * ```
 */
export function createThemeExtension(theme: ThemeType = 'dark'): Extension[] {
    const selectedTheme = theme === 'light' ? lightTheme : darkTheme;
    return [themeCompartment.of(selectedTheme)];
}

/**
 * Switches the editor theme dynamically.
 *
 * This helper function simplifies theme switching by encapsulating
 * the Compartment reconfigure dispatch.
 *
 * @param view - The EditorView instance to switch themes on
 * @param theme - The target theme ('light' or 'dark')
 *
 * @example
 * ```typescript
 * import { switchTheme } from './theme';
 *
 * // Switch to light theme
 * switchTheme(view, 'light');
 *
 * // Switch to dark theme
 * switchTheme(view, 'dark');
 * ```
 */
export function switchTheme(view: EditorView, theme: ThemeType): void {
    const selectedTheme = theme === 'light' ? lightTheme : darkTheme;
    view.dispatch({
        effects: themeCompartment.reconfigure(selectedTheme),
    });
}
