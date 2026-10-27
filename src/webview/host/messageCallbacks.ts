/**
 * INIT / UPDATE / THEME_CHANGE 三个主消息的处理（从 main.ts 拆出）。
 *
 * handleInit 是全应用的装配点：重建 CodeMirror、搜索历史、主题、
 * 图片拖放、初始模式。共享状态同样在 webviewContext.ctx 上。
 *
 * @module webview/host/messageCallbacks
 */

import { switchTheme } from '../codemirror/extensions/theme.js';
import { setMermaidTheme } from '../codemirror/extensions/livePreview/state.js';
import { CodeMirrorEditor } from '../codemirror/editor.js';
import { WebviewThemeManager } from '../theme.js';
import { createSearchHistoryController } from '../codemirror/extensions/searchHistory.js';
import {
    setupImageDropHandler,
    createImagePasteHandler,
} from '../editing/imageDropHandler.js';
import { settingsState } from '../settings/settingsState.js';
import type { ThemeType, LiveWriteMdEditorSettings } from '../../shared/types.js';
import type { SearchHistoryState } from '../../shared/searchHistory.js';
import type { SettingValue } from '../../shared/settings/index.js';
import type { EditorMode } from '../editing/editorContextMenu.js';
import { ctx } from './webviewContext.js';
import { sendLog } from './logForward.js';
import { updateBootStatus, hideBootStatus } from './bootStatus.js';
import {
    getOrCreateEditorHost,
    getMindmapHost,
    fileNameFromUri,
    enterMindmapMode,
    syncOutlineActiveLine,
} from './appState.js';

/**
 * Handle INIT message from Extension.
 * Sets up the CodeMirror ctx.editor with initial content and theme.
 *
 * @param content - The initial markdown content
 * @param theme - The initial theme setting
 * @param documentUri - The document URI for image path resolution
 *
 * Design Reference: DES-A-004, DES-API-003
 */
export async function handleInit(
    content: string,
    theme: ThemeType,
    documentUri: string,
    searchHistory: SearchHistoryState,
    settings?: LiveWriteMdEditorSettings,
    mode?: EditorMode,
    outlineWidth?: number,
    allSettings?: Record<string, SettingValue>
): Promise<void> {
    ctx.hasReceivedInit = true;
    updateBootStatus('已收到 INIT，正在创建 CodeMirror 编辑器。');
    sendLog('INFO', `INIT received: contentLength=${content.length}, theme=${theme}`);

    ctx.currentTheme = theme;
    ctx.mindmapFileName = fileNameFromUri(documentUri);

    try {
        // Destroy any stale search history controller before rebuilding the ctx.editor.
        ctx.searchHistoryController?.destroy();
        ctx.searchHistoryController = null;

        // Store document URI for image path resolution
        ctx.currentDocumentUri = documentUri;

        // 在创建编辑器前，把全部设置（颜色 / 个性化项）写入 settingsState，
        // CSS 变量先就位，首屏即按用户设置渲染、不闪。
        settingsState.replaceAll(allSettings ?? {});

        // Make sure the right-side outline starts at the saved width.
        if (Number.isFinite(outlineWidth ?? NaN)) {
            ctx.outlinePanel?.setWidth(outlineWidth as number);
        }

        // Get or create the ctx.editor container
        const container = getOrCreateEditorHost();
        sendLog(
            'INFO',
            `Editor host prepared: id=${container.id}, childCount=${container.childElementCount}, documentUri=${documentUri}`
        );

        // Destroy existing ctx.editor if any
        if (ctx.editor) {
            sendLog('DEBUG', 'Destroying existing CodeMirror ctx.editor before INIT rebuild');
            ctx.editor.destroy();
            ctx.editor = null;
        }
        // 导图实例同样重建，容器可见性复位到文本态
        ctx.mindmapApp?.destroy();
        ctx.mindmapApp = null;
        getMindmapHost().hidden = true;
        getOrCreateEditorHost().hidden = false;

        // Create new CodeMirror ctx.editor
        sendLog('INFO', 'Creating CodeMirror ctx.editor instance');
        ctx.editor = new CodeMirrorEditor(container);
        ctx.editor.setFontScaleChangeHandler((fontScale: number) => {
            ctx.messageSender.sendFontScaleChange(fontScale);
        });
        ctx.editor.onSelectionChange((lineNumber: number) => {
            ctx.outlinePanel?.setActiveLine(lineNumber);
        });
        ctx.editor.onViewportLineChange((lineNumber: number) => {
            ctx.outlinePanel?.setActiveLine(lineNumber);
        });

        // Initialize the ctx.editor with content
        sendLog('INFO', `Calling CodeMirrorEditor.create: contentLength=${content.length}`);
        await ctx.editor.create(content);
        sendLog('INFO', 'CodeMirrorEditor.create completed');

        // Initialize search/replace history UI and persistence hooks.
        ctx.searchHistoryController?.destroy();
        const editorView = ctx.editor.getView();
        if (!editorView) {
            throw new Error('Cannot initialize search history controller: ctx.editor view is missing.');
        }
        ctx.searchHistoryController = createSearchHistoryController(
            editorView,
            searchHistory,
            (history: SearchHistoryState) => {
                ctx.messageSender.sendSearchHistoryChange(history);
            }
        );

        hideBootStatus();
        ctx.currentEditorMode = mode ?? 'live';
        ctx.editorContextMenu?.attach(ctx.editor.getView()?.contentDOM ?? null);

        // Register change callback to send updates to Extension (debounced)
        ctx.editor.onChange((newContent: string) => {
            // 大纲内容**防抖**更新：setContent 会把整篇重扫一遍标题、再把大纲整棵重建，
            // 1547 行的文档实测一次 3.4ms —— 每敲一个字都做一次是白花的（打字延迟里
            // 它占了三分之一）。内容晚 250ms 跟上完全够用；「高亮当前行」走的是另一条
            // 路（setActiveLine），仍然是实时的。
            ctx.debouncedSetOutlineContent(newContent);
            ctx.debouncedSendContentChange(newContent);
        });

        // Keep the outline aligned with the freshly loaded Markdown document
        ctx.outlinePanel?.setContent(content);
        syncOutlineActiveLine();
        if (Number.isFinite(outlineWidth ?? NaN)) {
            ctx.outlinePanel?.setWidth(outlineWidth as number);
        }

        // Apply initial theme using ThemeManager (for CSS classes)
        if (!ctx.themeManager) {
            ctx.themeManager = new WebviewThemeManager(theme);
        } else {
            ctx.themeManager.setTheme(theme);
        }

        // Apply theme to CodeMirror ctx.editor and Mermaid
        setMermaidTheme(theme);
        if (ctx.editor.isReady()) {
            const view = (ctx.editor as unknown as { view: { dispatch: (tr: unknown) => void } }).view;
            if (view) {
                switchTheme(view as Parameters<typeof switchTheme>[0], theme);
            }
        }

        // Set up image drag & drop handler (document.body level)
        setupImageDropHandler(
            () => ctx.editor?.getView() ?? null,
            (msg) => ctx.vscode.postMessage(msg)
        );

        // Set up image paste handler via CM6 domEventHandlers
        const pasteHandler = createImagePasteHandler((msg) => ctx.vscode.postMessage(msg));
        ctx.editor.setPasteHandler(pasteHandler);

        // Apply ctx.editor settings (word wrap, readable line length)
        if (settings) {
            ctx.editor.applySettings(settings);
            sendLog(
                'INFO',
                `Settings applied: lineNumbers=${settings.lineNumbers}, wordWrap=${settings.wordWrap}, readableLineLength=${settings.readableLineLength}, fontScale=${settings.fontScale}`
            );
        }

        // Apply default ctx.editor mode
        if (mode === 'mindmap') {
            await enterMindmapMode();
            ctx.currentEditorMode = 'mindmap';
            sendLog('INFO', 'Default ctx.editor mode applied: mindmap');
        } else if (mode && mode !== 'live') {
            ctx.editor.setMode(mode);
            ctx.currentEditorMode = mode;
            sendLog('INFO', `Default ctx.editor mode applied: ${mode}`);
        }

        sendLog('INFO', 'CodeMirror ctx.editor initialized successfully');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        sendLog('ERROR', `Editor initialization failed: ${errorMessage}`);
        ctx.messageSender.sendError(errorMessage, errorStack, 'EDITOR_INIT_ERROR');
    }
}

/**
 * Handle UPDATE message from Extension.
 * Updates the ctx.editor content when external changes occur.
 *
 * @param content - The updated markdown content
 *
 * Design Reference: DES-API-003
 */
export function handleUpdate(content: string): void {
    sendLog('DEBUG', `UPDATE received: contentLength=${content.length}`);
    console.debug(
        `[LiveWriteMD] handleUpdate: contentLen=${content.length} editorReady=${ctx.editor?.isReady()}`
    );

    if (!ctx.editor || !ctx.editor.isReady()) {
        sendLog('ERROR', 'Cannot update: ctx.editor not ready');
        return;
    }

    try {
        console.debug(`[LiveWriteMD] handleUpdate: calling setContent...`);
        // setContent() does NOT trigger onChange (feedback loop prevention)
        ctx.editor.setContent(content);
        ctx.outlinePanel?.setContent(content);
        // 外部变更同步给导图（导图自身回写不会触发 UPDATE，无环）
        ctx.mindmapApp?.setDocument(content, ctx.mindmapFileName);
        syncOutlineActiveLine();
        sendLog('DEBUG', 'UPDATE applied successfully');
        console.debug(`[LiveWriteMD] handleUpdate: setContent completed`);
        // Stop reload spinner if it was active
        document.getElementById('reload-content')?.classList.remove('spinning');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        sendLog('ERROR', `Update failed: ${errorMessage}`);
        ctx.messageSender.sendError(errorMessage, errorStack, 'SYNC_ERROR');
    }
}

/**
 * Handle THEME_CHANGE message from Extension.
 * Updates the ctx.editor theme to match VS Code theme.
 *
 * @param theme - The new theme setting
 *
 * Design Reference: DES-A-006
 * Requirements: REQ-F-008
 */
export function handleThemeChange(theme: ThemeType): void {
    sendLog('DEBUG', `THEME_CHANGE received: theme=${theme}`);
    ctx.currentTheme = theme;
    ctx.mindmapApp?.setTheme(theme);

    try {
        // Apply theme change using ThemeManager (for CSS classes)
        if (ctx.themeManager) {
            ctx.themeManager.setTheme(theme);
        } else {
            ctx.themeManager = new WebviewThemeManager(theme);
        }

        // Apply theme to CodeMirror ctx.editor and Mermaid
        setMermaidTheme(theme);
        if (ctx.editor && ctx.editor.isReady()) {
            const view = (ctx.editor as unknown as { view: { dispatch: (tr: unknown) => void } }).view;
            if (view) {
                switchTheme(view as Parameters<typeof switchTheme>[0], theme);
            }
        }

        sendLog('DEBUG', 'Theme applied successfully');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        sendLog('ERROR', `Theme change failed: ${errorMessage}`);
    }
}
