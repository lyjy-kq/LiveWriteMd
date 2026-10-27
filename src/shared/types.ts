/**
 * LiveWriteMD 共享类型定义。
 *
 * 这个文件集中存放扩展与 Webview 之间的消息类型、编辑器设置类型，
 * 以及一些通用状态定义，避免各个模块各自维护一份不一致的契约。
 */

import type { SearchHistoryState } from './searchHistory.js';
import type { SettingValue } from './settings/index.js';

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
export interface LiveWriteMdEditorSettings {
    /** 是否显示行号。 */
    lineNumbers: boolean;
    /** 正文行最左缘与行号竖线的距离，单位像素，最低为 0。 */
    lineGutterGap: number;
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
 * 编辑器模式：实时预览 / 只读阅读 / 源码 / 思维导图。
 *
 * 四种模式并列；mindmap 模式下 webview 隐藏 CodeMirror、显示导图容器，
 * 但 CodeMirror 实例不销毁（撤销栈 / 光标 / 滚动位置保留）。
 */
export type EditorMode = 'live' | 'viewer' | 'source' | 'mindmap';

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
    /** 编辑器设置（结构化：行号 / 换行 / 行宽 / 字号）。 */
    settings?: LiveWriteMdEditorSettings;
    /** 全部设置（含颜色、个性化项），供 settingsState 注入 CSS 变量与运行时读取。 */
    allSettings?: Record<string, SettingValue>;
    /** 初始编辑器模式；缺省按实时模式处理。 */
    mode?: EditorMode;
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
 * 设置变更消息（扩展 -> Webview）。
 * 任何 liveWriteMd 配置变化都重发完整设置。
 */
export interface SettingsChangeMessage extends BaseMessage {
    /** 消息类型。 */
    type: 'settingsChange';
    /** 结构化编辑器设置。 */
    settings?: LiveWriteMdEditorSettings;
    /** 全部设置。 */
    allSettings?: Record<string, SettingValue>;
}

/**
 * 系统字体列表消息（扩展 -> Webview）。
 *
 * Webview 自己拿不到本机已安装字体，由扩展宿主枚举后下发，
 * 设置面板的「英文字体 / 中文字体」用它渲染可选列表。
 */
export interface SystemFontsMessage extends BaseMessage {
    /** 消息类型。 */
    type: 'systemFonts';
    /** 已安装字体家族名（已去重排序）。 */
    fonts: string[];
}

/**
 * 扩展 -> Webview 的消息联合类型。
 */
export type ExtensionToWebviewMessage =
    | InitMessage
    | UpdateMessage
    | SystemFontsMessage
    | ThemeChangeMessage
    | SettingsChangeMessage
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
    mode?: EditorMode;
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
 * 单项设置更新消息（Webview -> 扩展）。
 * 设置面板改动后发给扩展持久化。
 */
export interface UpdateSettingMessage extends BaseMessage {
    /** 消息类型。 */
    type: 'updateSetting';
    /** 设置键（不含 liveWriteMd.）。 */
    key: string;
    /** 新值。 */
    value: SettingValue;
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
    | UpdateSettingMessage
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
 * LiveWriteMD 配置。
 */
export interface LiveWriteMdConfiguration {
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
export const DEFAULT_CONFIG: LiveWriteMdConfiguration = {
    /** 默认阈值：1MB。 */
    largeFileThreshold: 1 * 1024 * 1024,
    /** 默认防抖：300ms。 */
    debounceDelay: 300,
    /** 默认关闭调试。 */
    debug: false,
};
