/**
 * CodeMirrorEditor Class Implementation
 *
 * This module implements the CodeMirrorEditor class, which wraps CodeMirror 6
 * to provide a clean API for the LiveWriteMD Webview editor.
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
    highlightWhitespace,
    lineNumbers,
    rectangularSelection,
    crosshairCursor,
    drawSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';
import { tunedMarkdownLanguage } from './extensions/markdownParser.js';
import { LanguageDescription, syntaxTree } from '@codemirror/language';
// 代码块语言表拆到同目录 codeLanguages.ts；re-export 保持调用方不变
import { codeLanguages } from './codeLanguages.js';
import { createEditorView } from './editorCreate.js';
export { codeLanguages } from './codeLanguages.js';
// 调试句柄用（installDebugHandle）：聚焦区间诊断
import { getSourceRange } from './extensions/livePreview/ranges.js';


import { createThemeExtension } from './extensions/theme';
import { markdownKeymap } from './extensions/keymap.js';
import { codeBlockSelectionPlugin } from './extensions/livePreview/codeBlockSelection.js';
import { createLivePreviewExtension } from './extensions/livePreview/index.js';
// lineGutterGap 设置变化时，列表引导线装饰要按新横坐标重建
import { tableRemeasureEffect } from './extensions/livePreview/state.js';
import { gutterFold } from './extensions/gutterFold.js';
import { listEnterExtension } from './extensions/listEnter.js';
import { settingsState } from '../settings/settingsState.js';
import { searchMatchCount } from './extensions/searchMatchCount.js';
// 搜索 / 替换面板：Ctrl+F / Ctrl+H 命令、中文词条与卡片式重设计
import { searchPanelTheme, searchPanelKeymap, searchPanelPhrases } from './extensions/searchPanel.js';

import type { LiveWriteMdEditorSettings } from '../../shared/types.js';

/**
 * 文档内容变化回调。
 *
 * 原本从 './types' 导入，但该模块并不存在（幽灵 import，esbuild 对 type-only
 * import 不做解析所以一直没暴露）。签名按实际调用点确定为全文字符串单参。
 *
 * @param content - 变化后的 Markdown 全文。
 */
type ContentChangeCallback = (content: string) => void;

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
 * Wraps CodeMirror 6 EditorView to provide a simplified API for the LiveWriteMD editor.
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
    public readonly container: HTMLElement;

    /** The CodeMirror EditorView instance */
    public view: EditorView | null = null;

    /** Callback for content changes */
    public onChangeCallback: ContentChangeCallback | undefined;

    /** Callback for active line changes. */
    public onSelectionChangeCallback: SelectionLineChangeCallback | undefined;

    /** 视口阅读行变化回调，用于正文滚动驱动外部大纲关注点。 */
    private onViewportLineChangeCallback: ViewportLineChangeCallback | undefined;

    /** 视口行上报的动画帧编号，用于合并连续滚动事件。 */
    private viewportLineFrame: number | null = null;

    /** 最近一次已经上报的视口行号，用于避免重复通知。 */
    private lastReportedViewportLine: number | null = null;

    /** Flag to suppress onChange during programmatic updates */
    public suppressOnChange: boolean = false;

    /** Compartment for dynamic editable reconfiguration */
    public editableCompartment = new Compartment();

    /** Compartment for dynamic live preview reconfiguration */
    public livePreviewCompartment = new Compartment();

    /** Compartment for dynamic theme (light/dark) reconfiguration */
    public themeCompartment = new Compartment();

    /** Observer for VS Code theme kind changes */
    public themeObserver: MutationObserver | null = null;

    /** Compartment for dynamic line wrapping reconfiguration */
    public lineWrappingCompartment = new Compartment();

    /** Compartment for dynamic line numbers reconfiguration */
    public lineNumbersCompartment = new Compartment();

    /** Compartment for active-line highlight toggle */
    public activeLineCompartment = new Compartment();

    /** Compartment for whitespace marker toggle */
    public whitespaceCompartment = new Compartment();

    /** External paste handler for image paste support (DES-API-003) */
    public pasteHandler: ((event: ClipboardEvent, view: EditorView) => boolean) | null = null;
    /** 字体缩放变化回调，用于把 Ctrl+滚轮的结果同步回扩展侧配置。 */
    private fontScaleChangeHandler: ((fontScale: number) => void) | null = null;

    /** 编辑器正文字号缩放倍率，1 表示保持 VS Code 原始字号。 */
    private fontScale: number = 1;

    /**
     * 上一轮已生效的「正文与行号线距离」（px）。
     * 初始 NaN：首次 applySettings 时装饰本来就是按 settingsState 构建的，
     * 只记录值、不触发重测。
     */
    private lineGutterGap: number = Number.NaN;

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
        this.container.style.setProperty('--livewritemd-font-scale', this.fontScale.toFixed(2));
    }

    /**
     * 按滚轮方向调整编辑器正文字号缩放倍率。
     *
     * @param deltaY - 滚轮的垂直位移，负数表示放大，正数表示缩小
     * @returns void
     */
    public adjustFontScale(deltaY: number): void {
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
    public scheduleViewportLineReport(view: EditorView): void {
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
    public reportViewportLine(view: EditorView): void {
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
     * Destroys the editor and cleans up resources.
     *
     * Safe to call multiple times or before create().
     */
    /**
     * Create and initialize the CodeMirror editor.
     * 实现已拆到 editorCreate.ts（扩展装配太长，独立成文件），这里只做转发。
     *
     * @param initialContent - Optional initial content to populate the editor
     * @returns Promise that resolves when the editor is ready
     */
    create(initialContent: string = ''): Promise<void> {
        return createEditorView(this, initialContent);
    }

    destroy(): void {
        if (this.themeObserver) {
            this.themeObserver.disconnect();
            this.themeObserver = null;
        }
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
                `[LiveWriteMD] setContent SKIPPED (composing=true) contentLen=${content.length}`
            );
            return;
        }

        // Suppress onChange during programmatic update
        this.suppressOnChange = true;

        try {
            // Skip dispatch if content hasn't changed (prevents cursor reset after Ctrl+Z)
            if (this.view.state.doc.toString() === content) {
                console.debug(
                    `[LiveWriteMD] setContent SKIPPED (content unchanged) contentLen=${content.length}`
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
                `[LiveWriteMD] setContent DISPATCHING: currentLen=${currentLength} newLen=${content.length} cursorPos=${cursorPos} newCursorPos=${newCursorPos} hasFocus=${this.view.hasFocus}`
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

            console.debug(`[LiveWriteMD] setContent DONE: hasFocus=${this.view.hasFocus}`);

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
     * 当前视口**垂直中点**所在的正文行号（1 开始）。
     *
     * live → 导图切换时用：扩展侧只下发模式，不带位置；导图要从
     * 「用户正在看的这一屏中间」开始，就得在编辑器还可见时量出来
     * （容器一旦 hidden，clientHeight 就是 0，后面再量已经晚了）。
     *
     * @returns 行号；编辑器未创建或不可见时返回 null
     */
    getViewportMiddleLine(): number | null {
        if (!this.view) return null;
        const scroller = this.view.scrollDOM;
        const height = scroller.clientHeight;
        if (height <= 0) return null;
        const block = this.view.lineBlockAtHeight(scroller.scrollTop + height / 2);
        return this.view.state.doc.lineAt(block.from).number;
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
    applySettings(settings: LiveWriteMdEditorSettings): void {
        if (!this.view) return;

        this.fontScale = Math.min(
            CodeMirrorEditor.MAX_FONT_SCALE,
            Math.max(CodeMirrorEditor.MIN_FONT_SCALE, settings.fontScale)
        );

        // Line numbers
        this.view.dispatch({
            effects: this.lineNumbersCompartment.reconfigure(
                settings.lineNumbers ? [lineNumbers(), gutterFold] : []
            ),
        });

        // Word wrap
        this.view.dispatch({
            effects: this.lineWrappingCompartment.reconfigure(
                settings.wordWrap ? EditorView.lineWrapping : []
            ),
        });

        // Active-line highlight / whitespace markers
        this.view.dispatch({
            effects: [
                this.activeLineCompartment.reconfigure(
                    settingsState.getBoolean('highlightActiveLine')
                        ? highlightActiveLine()
                        : []
                ),
                this.whitespaceCompartment.reconfigure([
                    highlightSpecialChars(),
                    settingsState.getBoolean('highlightWhitespace')
                        ? highlightWhitespace()
                        : [],
                ]),
            ],
        });

        // Readable line length via CSS variable
        const editorEl = this.container;
        const maxWidth =
            settings.readableLineLength > 0 ? `${settings.readableLineLength}px` : '100%';
        editorEl.style.setProperty('--livewritemd-max-width', maxWidth);

        // 正文与行号线距离：.cm-line 左内边距由 CSS 变量直接生效，
        // 但列表引导线 / 色带的横坐标是装饰构建时写死的数值，
        // 值变化时必须派发重测 effect、强制重建窗口装饰
        if (
            Number.isFinite(settings.lineGutterGap) &&
            settings.lineGutterGap !== this.lineGutterGap
        ) {
            if (!Number.isNaN(this.lineGutterGap)) {
                this.view.dispatch({ effects: tableRemeasureEffect.of(null) });
            }
            this.lineGutterGap = settings.lineGutterGap;
        }

        this.applyFontScale();
    }
}
