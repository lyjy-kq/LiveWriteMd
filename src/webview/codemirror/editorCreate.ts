/**
 * CodeMirrorEditor 的视图装配（从 editor.ts 拆出）。
 *
 * createEditorView 是原 create() 方法：构建整套扩展数组（editable/换行/
 * 搜索/快捷键/live preview/图片粘贴……）并 new EditorView。
 * 另含主题侦测、查看模式复制兜底、window.__lwmDebug 调试句柄。
 * 全部以 editor 实例为第一参数；editor 的相关字段已放开为 public。
 *
 * @module webview/codemirror/editorCreate
 */

import { EditorState, Transaction, type Extension } from '@codemirror/state';
import {
    EditorView,
    keymap,
    highlightActiveLine,
    highlightSpecialChars,
    highlightWhitespace,
    lineNumbers,
    rectangularSelection,
    crosshairCursor,
    drawSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { tunedMarkdownLanguage } from './extensions/markdownParser.js';
import { getSourceRange } from './extensions/livePreview/ranges.js';
import { createThemeExtension } from './extensions/theme';
import { markdownKeymap } from './extensions/keymap.js';
import { codeBlockSelectionPlugin } from './extensions/livePreview/decor/codeBlockSelection.js';
import { createLivePreviewExtension } from './extensions/livePreview/index.js';
import { tableRemeasureEffect } from './extensions/livePreview/state.js';
import { gutterFold } from './extensions/gutterFold.js';
import { listEnterExtension } from './extensions/listEnter.js';
import { settingsState } from '../settings/settingsState.js';
import { searchMatchCount } from './extensions/searchMatchCount.js';
import { searchPanelTheme, searchPanelKeymap, searchPanelPhrases } from './extensions/searchPanel.js';
import { codeLanguages } from './codeLanguages.js';
import type { CodeMirrorEditor } from './editor.js';

/**
 * 检测 VS Code 当前主题类型。
 *
 * VS Code 会在 webview 的 <body> 上自动挂 `vscode-light` / `vscode-dark` /
 * `vscode-high-contrast` / `vscode-high-contrast-light` 类。
 * 默认按深色兜底（与 VS Code 默认主题一致）。
 */
export function detectVsCodeTheme(): 'light' | 'dark' {
    const body = document.body;
    if (
        body.classList.contains('vscode-light') ||
        body.classList.contains('vscode-high-contrast-light')
    ) {
        return 'light';
    }
    return 'dark';
}

/**
 * Copy text to clipboard via Extension's vscode.env.clipboard API.
 * This is the most reliable method in VS Code webviews.
 */
export function copyTextToClipboard(text: string): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vscodeApi = (window as any).__vscodeApi;
    if (vscodeApi) {
        vscodeApi.postMessage({ type: 'copyToClipboard', text });
    }
}

/**
 * Creates and initializes the CodeMirror EditorView.
 *
 * Sets up the editor with Markdown language support, history (undo/redo),
 * and default keybindings.
 *
 * @param initialContent - Optional initial content to populate the editor
 * @returns Promise that resolves when the editor is ready
 */
export function createEditorView(editor: CodeMirrorEditor, initialContent: string = ''): Promise<void> {
    // If already created, destroy first
    if (editor.view) {
        editor.destroy();
    }

    // Build extensions list
    const extensions: Extension[] = [
        // Editable state (dynamically reconfigurable for viewer mode)
        editor.editableCompartment.of(EditorView.editable.of(true)),

        // Line wrapping (dynamically reconfigurable via settings)
        editor.lineWrappingCompartment.of(EditorView.lineWrapping),

        // Visual rendering: active-line / whitespace are settings-driven compartments
        editor.activeLineCompartment.of(
            settingsState.getBoolean('highlightActiveLine') ? highlightActiveLine() : []
        ),
        editor.whitespaceCompartment.of([
            highlightSpecialChars(),
            settingsState.getBoolean('highlightWhitespace') ? highlightWhitespace() : [],
        ]),
        editor.lineNumbersCompartment.of([lineNumbers(), gutterFold]),

        // Multiple selections / cursors (required for rectangular selection)
        EditorState.allowMultipleSelections.of(true),
        drawSelection(),
        // Selection highlight via mark decorations (all modes).
        // Hides drawSelection's selectionLayer and uses inline marks instead,
        // ensuring selection is always visible above element backgrounds.
        codeBlockSelectionPlugin,

        // Rectangular selection (Alt+Shift+Drag, matching VS Code behavior)
        rectangularSelection({ eventFilter: (e) => e.altKey && e.shiftKey }),
        crosshairCursor({ key: 'Alt' }),

        // Fast scroll (Alt+Wheel) - 5x speed, matching VS Code behavior
        EditorView.domEventHandlers({
            wheel: (event: WheelEvent, view: EditorView) => {
                if (event.ctrlKey || event.metaKey) {
                    event.preventDefault();
                    event.stopPropagation();
                    editor.adjustFontScale(event.deltaY);
                    return true;
                }
                if (event.altKey) {
                    event.preventDefault();
                    view.scrollDOM.scrollTop += event.deltaY * 5;
                    return true;
                }
                return false;
            },
            scroll: (_event: Event, view: EditorView) => {
                editor.scheduleViewportLineReport(view);
                return false;
            },
            // Focus support for Viewer Mode (editable: false)
            // When contenteditable=false, clicking doesn't grant focus to the editor.
            // VS Code requires webview focus to activate the editor tab.
            // 但搜索面板和表单控件需要保留自身焦点，不能被正文编辑器强行接管。
            mousedown(event: MouseEvent, view: EditorView) {
                if (!view.state.facet(EditorView.editable)) {
                    const target = event.target;
                    if (
                        target instanceof Element &&
                        target.closest(
                            '.cm-search, input, textarea, select, button, [contenteditable="true"]'
                        )
                    ) {
                        return false;
                    }

                    if (!view.dom.hasAttribute('tabindex')) {
                        view.dom.setAttribute('tabindex', '0');
                    }
                    view.dom.focus({ preventScroll: true });
                }
                return false;
            },
            // Ctrl+C / Cmd+C copy support for Viewer Mode (editable: false)
            // Table cell copy is handled by the global capture-phase handler in main.ts.
            // This handler covers non-table text copy in Viewer mode, where the browser's
            // native copy doesn't fire because contenteditable=false.
            keydown(event: KeyboardEvent, view: EditorView) {
                if ((event.ctrlKey || event.metaKey) && event.key === 'c' && !event.shiftKey) {
                    if (!view.state.facet(EditorView.editable)) {
                        const { from, to } = view.state.selection.main;
                        if (from !== to) {
                            const selectedText = view.state.sliceDoc(from, to);
                            event.preventDefault();
                            copyTextToClipboard(selectedText);
                            return true;
                        }
                    }
                }
                return false;
            },
        }),

        // History support (undo/redo)
        history(),

        // Search support (Ctrl+F find / Ctrl+H replace) with a top-anchored panel.
        search({ top: true }),
        searchMatchCount,
        // 搜索面板的卡片式视觉主题；中文文案通过 EditorState.phrases 注入。
        // （快捷键在下面的 keymap.of 里，需排在 searchKeymap 前面优先命中。）
        searchPanelTheme,
        EditorState.phrases.of(searchPanelPhrases),

        // Keybindings
        listEnterExtension,
        keymap.of([
            indentWithTab,
            ...markdownKeymap,
            ...searchPanelKeymap,
            ...searchKeymap,
            ...defaultKeymap,
            ...historyKeymap,
        ]),

        // Markdown language support with code block syntax highlighting
        markdown({
            base: tunedMarkdownLanguage,
            codeLanguages,
            addKeymap: true,
        }),

        // Theme extension (light/dark, follows VS Code theme kind)
        editor.themeCompartment.of(
            createThemeExtension(detectVsCodeTheme())
        ),

        // Live Preview (Obsidian-style Markdown rendering, dynamically reconfigurable)
        editor.livePreviewCompartment.of(createLivePreviewExtension()),

        // Content change listener
        // Skip during IME composition — compositionend handler below
        // takes care of notifying after composition finishes.
        EditorView.updateListener.of((update) => {
            if (update.docChanged) {
                console.debug(
                    `[LiveWriteMD] updateListener: docChanged=true suppressOnChange=${editor.suppressOnChange} composing=${update.view.composing} hasCallback=${!!editor.onChangeCallback}`
                );
            }
            if (
                update.docChanged &&
                !editor.suppressOnChange &&
                !update.view.composing &&
                editor.onChangeCallback
            ) {
                console.debug(
                    `[LiveWriteMD] updateListener: calling onChangeCallback (docLen=${update.state.doc.length})`
                );
                editor.onChangeCallback(update.state.doc.toString());
            }

            if ((update.docChanged || update.selectionSet) && editor.onSelectionChangeCallback) {
                const activeLine = update.state.doc.lineAt(update.state.selection.main.head).number;
                editor.onSelectionChangeCallback(activeLine);
            }

            if (update.docChanged || update.viewportChanged) {
                editor.scheduleViewportLineReport(update.view);
            }
        }),

        // IME composition end handler
        // CM6 applies doc changes during composition but the updateListener
        // above blocks them (composing=true). After compositionend, CM6 does
        // NOT fire another updateListener (no state change), so we catch it
        // here at the DOM level and send the final content.
        EditorView.domEventHandlers({
            compositionend: (_event: CompositionEvent, view: EditorView) => {
                setTimeout(() => {
                    if (!editor.suppressOnChange && editor.onChangeCallback && !view.composing) {
                        editor.onChangeCallback(view.state.doc.toString());
                    }
                }, 20);
                return false;
            },
            paste: (event: ClipboardEvent, view: EditorView) => {
                if (editor.pasteHandler) {
                    return editor.pasteHandler(event, view);
                }
                return false;
            },
        }),
    ];

    // Create EditorState
    const state = EditorState.create({
        doc: initialContent,
        extensions,
    });

    // Create EditorView and mount to container
    editor.view = new EditorView({
        state,
        parent: editor.container,
    });

    // 初始化字号缩放变量，确保编辑器正文从默认倍率开始渲染。
    editor.applyFontScale();
    editor.reportViewportLine(editor.view);
    installDebugHandle(editor);

    // 监听 VS Code 主题切换：body 类变化时重配主题（深浅色同步切换）
    startThemeObserver(editor);

    return Promise.resolve();
}

/**
 * 调试句柄：常驻挂到 window.__lwmDebug（不挂设置开关 —— 开关的传播链
 * 本身就是故障点，排查时多一个变量）。句柄是惰性的：不被调用就零开销。
 *
 * buildStamp 用于一眼分辨 webview 跑的是不是最新构建。
 * 供 Webview 开发者工具控制台抓现场：视图 / 语法树 / 聚焦区间
 * （装饰、聚焦问题在探针环境复现不了时用它定位）。
 */
export function installDebugHandle(editor: CodeMirrorEditor): void {
    (window as unknown as Record<string, unknown>).__lwmDebug = {
        buildStamp: '2026-10-26T2100+quote-fix',
        view: editor.view,
        syntaxTree: () => syntaxTree(editor.view!.state),
        getSourceRange: () => getSourceRange(editor.view!.state),
    };
}

/** 监听 document.body 上的 VS Code 主题类变化，动态切换编辑器主题。 */
export function startThemeObserver(editor: CodeMirrorEditor): void {
    let current = detectVsCodeTheme();
    editor.themeObserver = new MutationObserver(() => {
        const next = detectVsCodeTheme();
        if (next === current || !editor.view) return;
        current = next;
        editor.view.dispatch({
            effects: editor.themeCompartment.reconfigure(
                createThemeExtension(next)
            ),
        });
    });
    editor.themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['class'],
    });
}
