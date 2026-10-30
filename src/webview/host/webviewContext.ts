/**
 * Webview 全局运行态（从 main.ts 拆出的共享上下文）。
 *
 * main.ts 拆成 host/ 多个模块后，原本模块级的 `let editor` / `let mindmapApp`
 * 等状态需要一个共同的家：全部收在 `ctx` 这个可变对象上，各模块读写
 * `ctx.editor`、`ctx.outlinePanel` 等字段。不做更复杂的抽象（事件总线 /
 * 依赖注入），字段直读直写最直白。
 *
 * @module webview/host/webviewContext
 */

import type { CodeMirrorEditor } from '../codemirror/editor.js';
import type { MindMapApp } from '../mindmap/mindmapApp.js';
import type { WebviewThemeManager } from '../theme.js';
import type { OutlinePanel } from '../outline/outlinePanel.js';
import type { EditorContextMenu, EditorMode } from '../editing/editorContextMenu.js';
import type { SearchHistoryController } from '../codemirror/extensions/searchHistory.js';
import type { ThemeType } from '../../shared/types.js';
import type { Debounced } from '../../shared/utils.js';
import { WebviewMessageSender } from './messageHandler.js';

/**
 * VS Code API interface as available in Webview context.
 * Declared globally by VS Code when running in Webview.
 *
 * Note: Interface name does not follow "I" prefix convention as it mirrors
 * the actual VS Code API interface naming.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export interface IVsCodeApi {
    /**
     * Send a message to the Extension host
     * @param message - The message to send
     */
    postMessage(message: unknown): void;

    /**
     * Get the persisted state for this Webview
     * @returns The persisted state or undefined
     */
    getState(): unknown;

    /**
     * Set the persisted state for this Webview
     * @param state - The state to persist
     */
    setState(state: unknown): void;
}

/**
 * Global function provided by VS Code to acquire the VS Code API.
 * Must be called exactly once per Webview.
 */
declare function acquireVsCodeApi(): IVsCodeApi;

/**
 * webview 全局运行态的字段表。
 *
 * 实例类字段（editor / mindmapApp / outlinePanel 等）在启动、INIT、
 * 模式切换过程中逐步填充，未填充时一律是 null / 默认值，消费方自己判空。
 */
interface WebviewCtx {
    /** VS Code API 实例，模块加载即获取（全 webview 只能 acquire 一次）。 */
    vscode: IVsCodeApi;
    /** 消息发送器，所有 webview → 扩展的消息出口。 */
    messageSender: WebviewMessageSender;
    /**
     * 文档内容变化回发的防抖包装（300ms，跟随 messageSender）。
     * `.flush()` 用于导图提交这类不能等防抖窗口的离散操作。
     */
    debouncedSendContentChange: Debounced<(content: string) => void>;
    /** 大纲内容更新的防抖包装（250ms，仅「用户打字」路径用）。 */
    debouncedSetOutlineContent: (content: string) => void;
    /** CodeMirror 编辑器实例，INIT 消息到达后创建。 */
    editor: CodeMirrorEditor | null;
    /** 导图应用实例，首次进入导图模式时惰性创建。 */
    mindmapApp: MindMapApp | null;
    /** 当前文档文件名（不含扩展名），导图虚拟根使用。 */
    mindmapFileName: string;
    /** webview 当前明暗主题，导图主题 auto 时跟随。 */
    currentTheme: ThemeType;
    /** 搜索/替换历史控制器（给 CM 搜索面板挂 datalist 并回传变更）。 */
    searchHistoryController: SearchHistoryController | null;
    /** 是否已收到扩展侧 INIT（READY 重试逻辑用，避免永久等待）。 */
    hasReceivedInit: boolean;
    /** Webview 初始化是否已执行（防止 DOMContentLoaded 与直接启动重复跑）。 */
    hasInitialized: boolean;
    /** 当前编辑器模式，用于正文右键菜单的禁用态同步。 */
    currentEditorMode: EditorMode;
    /** 主题管理器实例，初始化时创建。 */
    themeManager: WebviewThemeManager | null;
    /** Markdown 正文右键菜单实例。 */
    editorContextMenu: EditorContextMenu | null;
    /** 右侧大纲面板实例：标题树渲染、分隔条拖拽与跳转交互。 */
    outlinePanel: OutlinePanel | null;
    /** 当前文档 URI，图片路径解析用。 */
    currentDocumentUri: string;
}

const vscodeApi = acquireVsCodeApi();
const messageSender = new WebviewMessageSender(vscodeApi);

/** webview 全局运行态单例。 */
export const ctx: WebviewCtx = {
    vscode: vscodeApi,
    messageSender,
    debouncedSendContentChange: messageSender.createDebouncedSendContentChange(),
    // 防抖（250ms）：打字路径上避免每敲一个字就整棵重建大纲；
    // 一次性更新（打开文档 / 外部改动）仍直接调 setContent
    debouncedSetOutlineContent: (() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let latest = '';
        return (content: string): void => {
            latest = content;
            if (timer !== null) return;
            timer = setTimeout(() => {
                timer = null;
                ctx.outlinePanel?.setContent(latest);
            }, 250);
        };
    })(),
    editor: null,
    mindmapApp: null,
    mindmapFileName: '',
    currentTheme: 'dark',
    searchHistoryController: null,
    hasReceivedInit: false,
    hasInitialized: false,
    currentEditorMode: 'live',
    themeManager: null,
    editorContextMenu: null,
    outlinePanel: null,
    currentDocumentUri: '',
};
