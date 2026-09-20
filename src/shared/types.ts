/**
 * FlowMD 共享类型定义。
 *
 * 这个文件集中存放扩展与 Webview 之间的消息类型、编辑器设置类型，
 * 以及一些通用状态定义，避免各个模块各自维护一份不一致的契约。
 */

import type { SearchHistoryState } from './searchHistory.js';

// =============================================================================
// 基础消息
// =============================================================================

/**
 * 所有消息的基础结构。
 */
export interface BaseMessage {
    /** 消息类型标识。 */
    type: string;
}

// =============================================================================
// 编辑器设置
// =============================================================================

/**
 * 扩展侧传给 Webview 的编辑器设置。
 */
export interface FlowMdEditorSettings {
    /** 是否显示行号。 */
    lineNumbers: boolean;
    /** 是否开启自动换行。 */
    wordWrap: boolean;
    /** 可读行宽，单位像素，0 表示不限制。 */
    readableLineLength: number;
    /** 编辑器正文字体缩放倍率。 */
    fontScale: number;
}

// =============================================================================
// 扩展 -> Webview 消息
// =============================================================================

/**
 * 主题类型。
 */
export type ThemeType = 'light' | 'dark';

/**
 * 初始化消息。
 */
export interface InitMessage extends BaseMessage {
    /** 消息类型。 */
    type: 'init';
    /** Markdown 内容。 */
    content: string;
    /** 当前主题。 */
    theme: ThemeType;
    /** 当前文档 URI。 */
    documentUri: string;
    /** 编辑器设置。 */
    settings?: FlowMdEditorSettings;
    /** 初始右侧大纲宽度，单位像素。 */
    outlineWidth?: number;
    /** 兼容旧版本字段名。 */
    outlinePanelWidth?: number;
    /** 搜索/替换历史状态。 */
    searchHistory: SearchHistoryState;
}

/**
 * 外部更新消息。
 */
export interface UpdateMessage extends BaseMessage {
    /** 消息类型。 */
    type: 'update';
    /** 更新后的 Markdown 内容。 */
    content: string;
}

/**
 * 主题切换消息。
 */
export interface ThemeChangeMessage extends BaseMessage {
    /** 消息类型。 */
    type: 'themeChange';
    /** 新主题。 */
    theme: ThemeType;
}

/**
 * 编辑器字体缩放变更消息。
 */
export interface FontScaleChangeMessage extends BaseMessage {
    /** 消息类型。 */
    type: 'fontScaleChange';
    /** 新的字体缩放倍率。 */
    fontScale: number;
}

/**
 * 扩展 -> Webview 的消息联合类型。
 */
export type ExtensionToWebviewMessage =
    | InitMessage
    | UpdateMessage
    | ThemeChangeMessage
    | ImageSavedMessage
    | ImageSaveErrorMessage;

// =============================================================================
// Webview -> 扩展 消息
// =============================================================================

/**
 * 内容变更消息。
 */
export interface ContentChangeMessage extends BaseMessage {
    /** 消息类型。 */
    type: 'contentChange';
    /** 最新 Markdown 内容。 */
    content: string;
}

/**
 * Webview 就绪消息。
 */
export interface ReadyMessage extends BaseMessage {
    /** 消息类型。 */
    type: 'ready';
}

/**
 * 大纲宽度变更消息。
 */
export interface OutlineWidthChangeMessage extends BaseMessage {
    /** 消息类型。 */
    type: 'outlineWidthChange';
    /** 当前大纲宽度，单位像素。 */
    width: number;
}

/**
 * 编辑器正文右键动作消息。
 */
export interface EditorActionMessage extends BaseMessage {
    /** 消息类型。 */
    type: 'editorAction';
    /** 动作类型。 */
    action: 'insertImage' | 'setMode' | 'exportAsHtml' | 'exportAsPdf' | 'downloadRemoteImages';
    /** 目标模式，仅在切换模式时使用。 */
    mode?: 'live' | 'viewer' | 'source';
}

/**
 * 错误消息。
 */
export interface ErrorMessage extends BaseMessage {
    /** 消息类型。 */
    type: 'error';
    /** 错误信息。 */
    message: string;
    /** 错误码，可选。 */
    code?: string;
    /** 错误堆栈，可选。 */
    stack?: string;
}

/**
 * 搜索/替换历史变更消息。
 */
export interface SearchHistoryChangeMessage extends BaseMessage {
    /** 消息类型。 */
    type: 'searchHistoryChange';
    /** 最新的搜索/替换历史状态。 */
    history: SearchHistoryState;
}

/**
 * Webview -> 扩展 的消息联合类型。
 */
export type WebviewToExtensionMessage =
    | ContentChangeMessage
    | ReadyMessage
    | ErrorMessage
    | SearchHistoryChangeMessage
    | OutlineWidthChangeMessage
    | FontScaleChangeMessage
    | EditorActionMessage
    | SaveImageMessage;

// =============================================================================
// 图片保存消息
// =============================================================================

/**
 * 保存图片请求消息。
 */
export interface SaveImageMessage extends BaseMessage {
    /** 消息类型。 */
    type: 'saveImage';
    /** Base64 图片数据。 */
    data: string;
    /** 文件名。 */
    fileName: string;
}

/**
 * 图片保存成功消息。
 */
export interface ImageSavedMessage extends BaseMessage {
    /** 消息类型。 */
    type: 'imageSaved';
    /** 图片相对路径。 */
    relativePath: string;
    /** 最终文件名。 */
    fileName: string;
}

/**
 * 图片保存失败消息。
 */
export interface ImageSaveErrorMessage extends BaseMessage {
    /** 消息类型。 */
    type: 'imageSaveError';
    /** 错误信息。 */
    error: string;
}

// =============================================================================
// 编辑器状态
// =============================================================================

/**
 * 更新来源。
 */
export type UpdateSource = 'extension' | 'webview' | null;

/**
 * 编辑器状态。
 */
export interface EditorState {
    /** 是否已经就绪。 */
    isReady: boolean;
    /** 是否有未保存修改。 */
    isDirty: boolean;
    /** 最近一次同步的内容。 */
    lastSyncedContent: string;
    /** 等待应用的更新内容。 */
    pendingUpdate: string | null;
}

/**
 * 同步状态。
 */
export interface SyncState {
    /** 扩展是否正在向 Webview 推送更新。 */
    isExtensionUpdating: boolean;
    /** Webview 是否正在向扩展推送更新。 */
    isWebviewUpdating: boolean;
    /** 最近一次更新来源。 */
    lastUpdateSource: UpdateSource;
}

// =============================================================================
// 配置
// =============================================================================

/**
 * FlowMD 配置。
 */
export interface FlowMdConfiguration {
    /** 大文件阈值，单位字节。 */
    largeFileThreshold: number;
    /** 内容同步防抖时间，单位毫秒。 */
    debounceDelay: number;
    /** 是否启用调试日志。 */
    debug: boolean;
}

/**
 * 默认配置。
 */
export const DEFAULT_CONFIG: FlowMdConfiguration = {
    /** 默认阈值：1MB。 */
    largeFileThreshold: 1 * 1024 * 1024,
    /** 默认防抖：300ms。 */
    debounceDelay: 300,
    /** 默认关闭调试。 */
    debug: false,
};
