/**
 * CodeMirrorEditor Class Implementation
 *
 * This module implements the CodeMirrorEditor class, which wraps CodeMirror 6
 * to provide a clean API for the FlowMD Webview editor.
 *
 * @module webview/codemirror/editor
 *
 * Design References:
 * - DES-A-004: CodeMirror 6 editor design
 * - DES-F-003: Webview file responsibilities
 *
 * Requirements:
 * - REQ-F-002: Webview CodeMirror initialization
 * - REQ-F-003: File loading and CodeMirror display
 * - REQ-F-004: CodeMirror edit content file save
 * - REQ-F-010: Image display
 */

import { EditorState, Transaction, type Extension, Compartment } from '@codemirror/state';
import {
    EditorView,
    keymap,
    highlightActiveLine,
    highlightSpecialChars,
    lineNumbers,
    rectangularSelection,
    crosshairCursor,
    drawSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language';

// CM6 language packages (static imports for IIFE bundle compatibility)
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/lang-go';
import { sql } from '@codemirror/lang-sql';
import { php } from '@codemirror/lang-php';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';

// Legacy modes (CM5 → CM6 via StreamLanguage)
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { diff } from '@codemirror/legacy-modes/mode/diff';

import { createThemeExtension } from './extensions/theme';
import { markdownKeymap } from './extensions/keymap.js';
import { codeBlockSelectionPlugin } from './extensions/livePreview/codeBlockSelection.js';
import { createLivePreviewExtension } from './extensions/livePreview/index.js';
import { searchMatchCount } from './extensions/searchMatchCount.js';

import type { ContentChangeCallback } from './types';
import type { FlowMdEditorSettings } from '../../shared/types.js';

/**
 * 光标行变化回调。
 *
 * @param lineNumber - 当前光标所在行号，从 1 开始。
 * @returns void
 */
type SelectionLineChangeCallback = (lineNumber: number) => void;

/**
 * 视口阅读行变化回调。
 *
 * @param lineNumber - 当前视口顶部附近的正文行号，从 1 开始。
 * @returns void
 */
type ViewportLineChangeCallback = (lineNumber: number) => void;

/**
 * 创建延迟加载的代码块语言描述。
 *
 * @param options - 语言名称、别名、扩展名与加载函数。
 * @returns CodeMirror 可识别的语言描述。
 */
function createLazyLanguageDescription(options: {
    /** 语言展示名称。 */
    name: string;
    /** 代码块 info 字符串可使用的别名。 */
    alias?: string[];
    /** 文件扩展名提示。 */
    extensions?: string[];
    /** 真正需要解析该语言时才执行的支持构造函数。 */
    load: () => LanguageSupport;
}): LanguageDescription {
    return LanguageDescription.of({
        name: options.name,
        alias: options.alias,
        extensions: options.extensions,
        load: async () => options.load(),
    });
}

/**
 * Statically-loaded language descriptions for fenced code block syntax highlighting.
 * Uses direct imports instead of @codemirror/language-data's dynamic import()
 * which doesn't work in esbuild IIFE bundles.
 */
const codeLanguages: readonly LanguageDescription[] = [
    createLazyLanguageDescription({
        name: 'JavaScript',
        alias: ['js', 'jsx', 'ecmascript', 'node'],
        extensions: ['js', 'mjs', 'cjs', 'jsx'],
        load: () => javascript({ jsx: true }),
    }),
    createLazyLanguageDescription({
        name: 'TypeScript',
        alias: ['ts', 'tsx'],
        extensions: ['ts', 'tsx', 'mts', 'cts'],
        load: () => javascript({ typescript: true, jsx: true }),
    }),
    createLazyLanguageDescription({
        name: 'Python',
        alias: ['py'],
        extensions: ['py', 'pyw'],
        load: () => python(),
    }),
    createLazyLanguageDescription({
        name: 'HTML',
        alias: ['htm'],
        extensions: ['html', 'htm'],
        load: () => html(),
    }),
    createLazyLanguageDescription({ name: 'CSS', extensions: ['css'], load: () => css() }),
    createLazyLanguageDescription({
        name: 'JSON',
        alias: ['jsonc'],
        extensions: ['json'],
        load: () => json(),
    }),
    createLazyLanguageDescription({ name: 'Java', extensions: ['java'], load: () => java() }),
    createLazyLanguageDescription({
        name: 'C++',
        alias: ['cpp', 'c', 'cc', 'cxx', 'h', 'hpp'],
        extensions: ['cpp', 'c', 'cc', 'h', 'hpp'],
        load: () => cpp(),
    }),
    createLazyLanguageDescription({ name: 'Rust', alias: ['rs'], extensions: ['rs'], load: () => rust() }),
    createLazyLanguageDescription({ name: 'Go', alias: ['golang'], extensions: ['go'], load: () => go() }),
    createLazyLanguageDescription({ name: 'SQL', extensions: ['sql'], load: () => sql() }),
    createLazyLanguageDescription({ name: 'PHP', extensions: ['php'], load: () => php() }),
    createLazyLanguageDescription({
        name: 'XML',
        alias: ['svg', 'xsl', 'xsd'],
        extensions: ['xml', 'svg', 'xsl'],
        load: () => xml(),
    }),
    createLazyLanguageDescription({
        name: 'YAML',
        alias: ['yml'],
        extensions: ['yaml', 'yml'],
        load: () => yaml(),
    }),
    createLazyLanguageDescription({
        name: 'Shell',
        alias: ['bash', 'sh', 'zsh', 'ksh'],
        extensions: ['sh', 'bash', 'zsh'],
        load: () => new LanguageSupport(StreamLanguage.define(shell)),
    }),
    createLazyLanguageDescription({
        name: 'PowerShell',
        alias: ['ps1', 'psm1', 'pwsh'],
        extensions: ['ps1', 'psm1'],
        load: () => new LanguageSupport(StreamLanguage.define(powerShell)),
    }),
    createLazyLanguageDescription({
        name: 'Ruby',
        alias: ['rb'],
        extensions: ['rb'],
        load: () => new LanguageSupport(StreamLanguage.define(ruby)),
    }),
    createLazyLanguageDescription({
        name: 'Dockerfile',
        alias: ['docker'],
        extensions: ['dockerfile'],
        load: () => new LanguageSupport(StreamLanguage.define(dockerFile)),
    }),
    createLazyLanguageDescription({
        name: 'TOML',
        extensions: ['toml'],
        load: () => new LanguageSupport(StreamLanguage.define(toml)),
    }),
    createLazyLanguageDescription({
        name: 'Diff',
        alias: ['patch'],
        extensions: ['diff', 'patch'],
        load: () => new LanguageSupport(StreamLanguage.define(diff)),
    }),
];

/**
 * Copy text to clipboard via Extension's vscode.env.clipboard API.
 * This is the most reliable method in VS Code webviews.
 */
function copyTextToClipboard(text: string): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vscodeApi = (window as any).__vscodeApi;
    if (vscodeApi) {
        vscodeApi.postMessage({ type: 'copyToClipboard', text });
    }
}

/**
 * Error thrown when editor operations are attempted before initialization.
 */
class EditorNotReadyError extends Error {
    constructor(operation: string) {
        super(`Cannot ${operation}: Editor is not initialized. Call create() first.`);
        this.name = 'EditorNotReadyError';
    }
}

/**
 * Error thrown when an invalid container is provided.
 */
class InvalidContainerError extends Error {
    constructor() {
        super('Container element is required and must be a valid HTMLElement.');
        this.name = 'InvalidContainerError';
    }
}

/**
 * CodeMirrorEditor class
 *
 * Wraps CodeMirror 6 EditorView to provide a simplified API for the FlowMD editor.
 * Handles editor lifecycle (create/destroy), content management (set/get),
 * and content change notifications.
 *
 * @example
 * ```typescript
 * const container = document.getElementById('editor');
 * const editor = new CodeMirrorEditor(container);
 *
 * await editor.create('# Initial Content');
 * editor.onChange((content) => console.log('Changed:', content));
 *
 * // Later...
 * editor.destroy();
 * ```
 */
export class CodeMirrorEditor {
    /** The container element where the editor is mounted */
    private readonly container: HTMLElement;

    /** The CodeMirror EditorView instance */
    private view: EditorView | null = null;

    /** Callback for content changes */
    private onChangeCallback: ContentChangeCallback | undefined;

    /** Callback for active line changes. */
    private onSelectionChangeCallback: SelectionLineChangeCallback | undefined;

    /** 视口阅读行变化回调，用于正文滚动驱动外部大纲关注点。 */
    private onViewportLineChangeCallback: ViewportLineChangeCallback | undefined;

    /** 视口行上报的动画帧编号，用于合并连续滚动事件。 */
    private viewportLineFrame: number | null = null;

    /** 最近一次已经上报的视口行号，用于避免重复通知。 */
    private lastReportedViewportLine: number | null = null;

    /** Flag to suppress onChange during programmatic updates */
    private suppressOnChange: boolean = false;

    /** Compartment for dynamic editable reconfiguration */
    private editableCompartment = new Compartment();

    /** Compartment for dynamic live preview reconfiguration */
    private livePreviewCompartment = new Compartment();

    /** Compartment for dynamic line wrapping reconfiguration */
    private lineWrappingCompartment = new Compartment();

    /** Compartment for dynamic line numbers reconfiguration */
    private lineNumbersCompartment = new Compartment();

    /** External paste handler for image paste support (DES-API-003) */
    private pasteHandler: ((event: ClipboardEvent, view: EditorView) => boolean) | null = null;
    /** 字体缩放变化回调，用于把 Ctrl+滚轮的结果同步回扩展侧配置。 */
    private fontScaleChangeHandler: ((fontScale: number) => void) | null = null;

    /** 编辑器正文字号缩放倍率，1 表示保持 VS Code 原始字号。 */
    private fontScale: number = 1;

    /** 编辑器正文缩放的最小倍率，避免缩得过小后无法阅读。 */
    private static readonly MIN_FONT_SCALE = 0.5;

    /** 编辑器正文缩放的最大倍率，避免缩得过大后破坏布局。 */
    private static readonly MAX_FONT_SCALE = 2;

    /** 每次滚轮缩放的步进值，数值越大缩放越快。 */
    private static readonly FONT_SCALE_STEP = 0.1;

    /**
     * Creates a new CodeMirrorEditor instance.
     *
     * @param container - The HTML element to mount the editor in
     * @throws {InvalidContainerError} If container is null or undefined
     */
    constructor(container: HTMLElement) {
        if (!container) {
            throw new InvalidContainerError();
        }
        this.container = container;
    }

    /**
     * 将当前字号缩放倍率写入编辑器容器。
     *
     * 这样可以只放大 Markdown 正文文本，不影响整个 webview 的布局。
     *
     * @returns void
     */
    private applyFontScale(): void {
        this.container.style.setProperty('--flowmd-font-scale', this.fontScale.toFixed(2));
    }

    /**
     * 按滚轮方向调整编辑器正文字号缩放倍率。
     *
     * @param deltaY - 滚轮的垂直位移，负数表示放大，正数表示缩小
     * @returns void
     */
    private adjustFontScale(deltaY: number): void {
        const previousScale = this.fontScale;
        const direction = deltaY < 0 ? 1 : -1;
        const nextScale = this.fontScale + direction * CodeMirrorEditor.FONT_SCALE_STEP;
        this.fontScale = Math.min(
            CodeMirrorEditor.MAX_FONT_SCALE,
            Math.max(CodeMirrorEditor.MIN_FONT_SCALE, nextScale)
        );
        this.applyFontScale();
        if (this.fontScale !== previousScale) {
            this.fontScaleChangeHandler?.(this.fontScale);
        }
    }

    /**
     * 安排在下一帧上报当前视口顶部正文行。
     *
     * @param view - 当前 CodeMirror 编辑器视图。
     * @returns void
     */
    private scheduleViewportLineReport(view: EditorView): void {
        if (!this.onViewportLineChangeCallback) {
            return;
        }

        if (this.viewportLineFrame !== null) {
            return;
        }

        this.viewportLineFrame = window.requestAnimationFrame(() => {
            this.viewportLineFrame = null;
            this.reportViewportLine(view);
        });
    }

    /**
     * 计算并上报当前视口顶部附近的正文行。
     *
     * @param view - 当前 CodeMirror 编辑器视图。
     * @returns void
     */
    private reportViewportLine(view: EditorView): void {
        if (!this.onViewportLineChangeCallback) {
            return;
        }

        const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
        const lineNumber = view.state.doc.lineAt(block.from).number;
        if (lineNumber === this.lastReportedViewportLine) {
            return;
        }

        this.lastReportedViewportLine = lineNumber;
        this.onViewportLineChangeCallback(lineNumber);
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
    create(initialContent: string = ''): Promise<void> {
        // If already created, destroy first
        if (this.view) {
            this.destroy();
        }

        // Build extensions list
        const extensions: Extension[] = [
            // Editable state (dynamically reconfigurable for viewer mode)
            this.editableCompartment.of(EditorView.editable.of(true)),

            // Line wrapping (dynamically reconfigurable via settings)
            this.lineWrappingCompartment.of(EditorView.lineWrapping),

            // Visual rendering (active line, line numbers)
            highlightActiveLine(),
            highlightSpecialChars(),
            this.lineNumbersCompartment.of(lineNumbers()),

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
                        this.adjustFontScale(event.deltaY);
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
                    this.scheduleViewportLineReport(view);
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

            // Search support (Ctrl+F / Ctrl+H) with a top-anchored panel.
            search({ top: true }),
            searchMatchCount,

            // Keybindings
            keymap.of([
                indentWithTab,
                ...markdownKeymap,
                ...searchKeymap,
                ...defaultKeymap,
                ...historyKeymap,
            ]),

            // Markdown language support with code block syntax highlighting
            markdown({
                base: markdownLanguage,
                codeLanguages,
                addKeymap: true,
            }),

            // Theme extension (VS Code integration, cursor/selection colors)
            ...createThemeExtension(),

            // Live Preview (Obsidian-style Markdown rendering, dynamically reconfigurable)
            this.livePreviewCompartment.of(createLivePreviewExtension()),

            // Content change listener
            // Skip during IME composition — compositionend handler below
            // takes care of notifying after composition finishes.
            EditorView.updateListener.of((update) => {
                if (update.docChanged) {
                    console.debug(
                        `[FlowMD] updateListener: docChanged=true suppressOnChange=${this.suppressOnChange} composing=${update.view.composing} hasCallback=${!!this.onChangeCallback}`
                    );
                }
                if (
                    update.docChanged &&
                    !this.suppressOnChange &&
                    !update.view.composing &&
                    this.onChangeCallback
                ) {
                    console.debug(
                        `[FlowMD] updateListener: calling onChangeCallback (docLen=${update.state.doc.length})`
                    );
                    this.onChangeCallback(update.state.doc.toString());
                }

                if ((update.docChanged || update.selectionSet) && this.onSelectionChangeCallback) {
                    const activeLine = update.state.doc.lineAt(update.state.selection.main.head).number;
                    this.onSelectionChangeCallback(activeLine);
                }

                if (update.docChanged || update.viewportChanged) {
                    this.scheduleViewportLineReport(update.view);
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
                        if (!this.suppressOnChange && this.onChangeCallback && !view.composing) {
                            this.onChangeCallback(view.state.doc.toString());
                        }
                    }, 20);
                    return false;
                },
                paste: (event: ClipboardEvent, view: EditorView) => {
                    if (this.pasteHandler) {
                        return this.pasteHandler(event, view);
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
        this.view = new EditorView({
            state,
            parent: this.container,
        });

        // 初始化字号缩放变量，确保编辑器正文从默认倍率开始渲染。
        this.applyFontScale();
        this.reportViewportLine(this.view);

        return Promise.resolve();
    }

    /**
     * Destroys the editor and cleans up resources.
     *
     * Safe to call multiple times or before create().
     */
    destroy(): void {
        if (this.view) {
            if (this.viewportLineFrame !== null) {
                window.cancelAnimationFrame(this.viewportLineFrame);
                this.viewportLineFrame = null;
            }
            this.view.destroy();
            this.view = null;
        }
        this.onChangeCallback = undefined;
        this.onViewportLineChangeCallback = undefined;
        this.pasteHandler = null;
        this.fontScaleChangeHandler = null;
        this.suppressOnChange = false;
        this.lastReportedViewportLine = null;
    }

    /**
     * Sets the editor content.
     *
     * Replaces all content in the editor. Does NOT trigger the onChange callback
     * to prevent feedback loops during external updates.
     *
     * @param content - The new content to set
     * @throws {EditorNotReadyError} If called before create()
     */
    setContent(content: string): void {
        if (!this.view) {
            throw new EditorNotReadyError('setContent');
        }

        // During IME composition, skip external content updates entirely.
        // Replacing the document mid-composition destroys the composing text
        // and causes cursor jumps. The updateListener detects the composing→
        // not-composing transition and sends the final content at that point.
        if (this.view.composing) {
            console.debug(
                `[FlowMD] setContent SKIPPED (composing=true) contentLen=${content.length}`
            );
            return;
        }

        // Suppress onChange during programmatic update
        this.suppressOnChange = true;

        try {
            // Skip dispatch if content hasn't changed (prevents cursor reset after Ctrl+Z)
            if (this.view.state.doc.toString() === content) {
                console.debug(
                    `[FlowMD] setContent SKIPPED (content unchanged) contentLen=${content.length}`
                );
                return;
            }

            const currentLength = this.view.state.doc.length;
            // Preserve cursor position (clamped to new content length)
            const cursorPos = this.view.state.selection.main.head;
            const newCursorPos = Math.min(cursorPos, content.length);
            // Preserve scroll position across external content updates
            const scrollTop = this.view.scrollDOM.scrollTop;

            console.debug(
                `[FlowMD] setContent DISPATCHING: currentLen=${currentLength} newLen=${content.length} cursorPos=${cursorPos} newCursorPos=${newCursorPos} hasFocus=${this.view.hasFocus}`
            );

            // Replace all content while preserving cursor and scroll
            this.view.dispatch({
                changes: {
                    from: 0,
                    to: currentLength,
                    insert: content,
                },
                selection: { anchor: newCursorPos },
                annotations: Transaction.addToHistory.of(false),
            });

            console.debug(`[FlowMD] setContent DONE: hasFocus=${this.view.hasFocus}`);

            // Restore scroll position (external updates shouldn't move the view)
            this.view.scrollDOM.scrollTop = scrollTop;
        } finally {
            this.suppressOnChange = false;
        }
    }

    /**
     * Gets the current editor content.
     *
     * @returns The current content as a string
     * @throws {EditorNotReadyError} If called before create()
     */
    getContent(): string {
        if (!this.view) {
            throw new EditorNotReadyError('getContent');
        }

        return this.view.state.doc.toString();
    }

    /**
     * Gets the current line number of the editor selection.
     *
     * @returns The current line number, starting at 1
     * @throws {EditorNotReadyError} If called before create()
     */
    getCurrentLine(): number {
        if (!this.view) {
            throw new EditorNotReadyError('getCurrentLine');
        }

        return this.view.state.doc.lineAt(this.view.state.selection.main.head).number;
    }

    /**
     * Registers a callback for content changes.
     *
     * The callback is invoked when the user edits the content (typing, pasting, etc.).
     * It is NOT invoked when setContent() is called (to prevent feedback loops).
     *
     * @param callback - Function to call with the new content when it changes
     */
    onChange(callback: ContentChangeCallback): void {
        this.onChangeCallback = callback;
    }

    /**
     * Registers a callback for active line changes.
     *
     * The callback is invoked when the editor selection moves to a different
     * line, including keyboard navigation, mouse clicks, and programmatic
     * selection changes.
     *
     * @param callback - Function to call with the current line number
     * @returns void
     */
    onSelectionChange(callback: SelectionLineChangeCallback): void {
        this.onSelectionChangeCallback = callback;
    }

    /**
     * 注册正文视口阅读行变化回调。
     *
     * 滚动正文时会以上方可见行作为阅读位置，用于同步右侧大纲关注点。
     *
     * @param callback - 接收当前视口行号的回调函数。
     * @returns void
     */
    onViewportLineChange(callback: ViewportLineChangeCallback): void {
        this.onViewportLineChangeCallback = callback;
        if (this.view) {
            this.reportViewportLine(this.view);
        }
    }

    /**
     * Sets an external paste handler for image paste support.
     *
     * The handler is called from the CM6 domEventHandlers paste event.
     * It should return true if the event was consumed (preventing default paste),
     * or false to allow normal paste behavior.
     *
     * @param handler - Paste event handler that returns true if event was consumed
     *
     * @see DES-API-003
     */
    setPasteHandler(handler: (event: ClipboardEvent, view: EditorView) => boolean): void {
        this.pasteHandler = handler;
    }

    /**
     * Sets the callback that receives editor font scale changes.
     *
     * @param handler - Callback invoked when Ctrl+wheel changes the font scale
     * @returns void
     */
    setFontScaleChangeHandler(handler: ((fontScale: number) => void) | null): void {
        this.fontScaleChangeHandler = handler;
    }

    /**
     * Gets the underlying EditorView instance.
     *
     * Returns null if the editor has not been initialized or has been destroyed.
     *
     * Used by ImageDropHandler for:
     * - posAtCoords() to determine drop position
     * - view.state.selection for cursor position
     * - view.dispatch() for text insertion
     *
     * @returns The EditorView instance, or null if not initialized
     *
     * @see DES-API-004
     */
    getView(): EditorView | null {
        return this.view;
    }

    /**
     * Checks if the editor is ready (initialized).
     *
     * @returns true if the editor has been created and not destroyed
     */
    isReady(): boolean {
        return this.view !== null;
    }

    /**
     * 当前是否可编辑（查看模式下为 false）。
     *
     * 给「改文档」的入口用：查看模式下右键菜单里那些增删行列不该出现，
     * 弹出来点了却没反应最让人困惑。
     *
     * @returns 可编辑时返回 true；编辑器还没建好时返回 false
     */
    isEditable(): boolean {
        if (!this.view) {
            return false;
        }
        return this.view.state.facet(EditorView.editable);
    }

    /**
     * Focuses the editor.
     *
     * Safe to call before create() (no-op).
     */
    focus(): void {
        if (this.view) {
            this.view.focus();
        }
    }

    /**
     * 将编辑器滚动到指定行。
     *
     * 该方法用于大纲面板点击标题后的跳转定位。
     *
     * @param lineNumber - 目标行号，从 1 开始
     */
    scrollToLine(lineNumber: number): void {
        if (!this.view) return;
        if (!Number.isFinite(lineNumber) || lineNumber < 1) return;

        const line = Math.min(this.view.state.doc.lines, Math.floor(lineNumber));
        const target = this.view.state.doc.line(line);
        this.view.dispatch({
            selection: { anchor: target.from },
            effects: EditorView.scrollIntoView(target.from, { y: 'start' }),
        });
        this.view.focus();
    }

    /**
     * Sets the editor's editable state.
     *
     * When set to false, the editor becomes read-only (viewer mode).
     * All live preview decorations remain visible with no focused editing range.
     *
     * @param editable - Whether the editor should be editable
     */
    setEditable(editable: boolean): void {
        if (this.view) {
            this.view.dispatch({
                effects: this.editableCompartment.reconfigure(EditorView.editable.of(editable)),
            });
        }
    }

    /**
     * Sets the editor mode.
     *
     * - 'live': Live preview + editable (default)
     * - 'viewer': Live preview + read-only
     * - 'source': No live preview + editable (raw Markdown)
     *
     * @param mode - The editor mode to set
     */
    setMode(mode: 'live' | 'viewer' | 'source'): void {
        if (!this.view) return;

        const editable = mode !== 'viewer';
        const livePreview = mode !== 'source';

        this.view.dispatch({
            effects: [
                this.editableCompartment.reconfigure(EditorView.editable.of(editable)),
                this.livePreviewCompartment.reconfigure(
                    livePreview ? createLivePreviewExtension() : []
                ),
            ],
        });
    }

    /**
     * Applies editor settings (word wrap, readable line length).
     *
     * @param settings - The editor settings to apply
     */
    applySettings(settings: FlowMdEditorSettings): void {
        if (!this.view) return;

        this.fontScale = Math.min(
            CodeMirrorEditor.MAX_FONT_SCALE,
            Math.max(CodeMirrorEditor.MIN_FONT_SCALE, settings.fontScale)
        );

        // Line numbers
        this.view.dispatch({
            effects: this.lineNumbersCompartment.reconfigure(
                settings.lineNumbers ? lineNumbers() : []
            ),
        });

        // Word wrap
        this.view.dispatch({
            effects: this.lineWrappingCompartment.reconfigure(
                settings.wordWrap ? EditorView.lineWrapping : []
            ),
        });

        // Readable line length via CSS variable
        const editorEl = this.container;
        const maxWidth =
            settings.readableLineLength > 0 ? `${settings.readableLineLength}px` : '100%';
        editorEl.style.setProperty('--flowmd-max-width', maxWidth);

        this.applyFontScale();
    }
}
