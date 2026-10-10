/**
 * LiveWriteMD 消息类型常量定义。
 *
 * 这个文件集中维护扩展与 Webview 之间的消息类型字符串，避免各模块
 * 分散硬编码导致契约不一致。
 *
 * @module shared/messageTypes
 *
 * Design Reference: DES-API-001
 */

/**
 * 消息类型常量集合。
 *
 * 每个字段都对应一个可直接用于 postMessage 的消息类型字符串。
 */
export const MESSAGE_TYPES = {
    // ========================================================================
    // Extension -> Webview 消息类型
    // ========================================================================

    /**
     * 初始化消息类型。
     * 扩展侧在 Webview 准备完成后发送，用于下发内容、主题和设置。
     */
    INIT: 'init',

    /**
     * 外部内容更新消息类型。
     * 当 VS Code 文本编辑器内容变化时发送给 Webview。
     */
    UPDATE: 'update',

    /**
     * 主题切换消息类型。
     * 当 VS Code 颜色主题变化时发送给 Webview。
     */
    THEME_CHANGE: 'themeChange',

    // ========================================================================
    // Webview -> Extension 消息类型
    // ========================================================================

    /**
     * 内容变更消息类型。
     * Webview 在 Markdown 内容变化后发送给扩展侧。
     */
    CONTENT_CHANGE: 'contentChange',

    /**
     * Webview 就绪消息类型。
     * Webview 脚本加载完成后发送给扩展侧，触发 INIT 下发。
     */
    READY: 'ready',

    /**
     * 错误消息类型。
     * Webview 出现错误时发送给扩展侧用于展示和日志记录。
     */
    ERROR: 'error',

    /**
     * 大纲宽度变更消息类型。
     * Webview 在用户拖动右侧大纲分隔条时发送给扩展侧。
     */
    OUTLINE_WIDTH_CHANGE: 'outlineWidthChange',

    /**
     * 搜索/替换历史变更消息类型。
     * Webview 在历史列表变化后发送给扩展侧进行持久化。
     */
    SEARCH_HISTORY_CHANGE: 'searchHistoryChange',

    // ========================================================================
    // Extension -> Webview 扩展消息类型
    // ========================================================================

    /**
     * 编辑器模式变更消息类型。
     * 扩展侧在 live/viewer/source 之间切换后发送给 Webview。
     */
    EDITOR_MODE: 'editorMode',

    /**
     * 设置变更消息类型。
     * 扩展侧在编辑器设置变化后发送给 Webview。
     */
    SETTINGS_CHANGE: 'settingsChange',

    /**
     * 命令执行消息类型。
     * 扩展侧通过该消息触发 Webview 中的命令。
     */
    EXECUTE_COMMAND: 'executeCommand',

    /**
     * 切换大纲显示消息类型。
     * 扩展侧点击标题栏按钮或执行命令后发送，Webview 收到后反转大纲可见性。
     */
    OUTLINE_TOGGLE: 'outlineToggle',

    /**
     * 打开设置面板消息类型。
     * 扩展侧执行「LiveWriteMD: 设置」命令后发给当前编辑器。
     */
    OPEN_SETTINGS: 'openSettings',

    // ========================================================================
    // Webview -> Extension 扩展消息类型
    // ========================================================================

    /**
     * 重新加载内容消息类型。
     * Webview 点击重载按钮后发送给扩展侧。
     */
    RELOAD_CONTENT: 'reloadContent',

    /**
     * 更新单项设置消息类型。
     * 设置面板里改动后发给扩展侧持久化到 VS Code 配置。
     */
    UPDATE_SETTING: 'updateSetting',

    // ========================================================================
    // 图片保存消息类型
    // ========================================================================

    /**
     * 保存图片请求消息类型。
     * Webview 在拖拽或粘贴图片时发送给扩展侧。
     */
    SAVE_IMAGE: 'saveImage',

    /**
     * 图片保存成功消息类型。
     * 扩展侧保存图片成功后发送回 Webview。
     */
    IMAGE_SAVED: 'imageSaved',

    /**
     * 图片保存失败消息类型。
     * 扩展侧保存图片失败后发送回 Webview。
     */
    IMAGE_SAVE_ERROR: 'imageSaveError',
} as const;

/**
 * 消息类型字面量联合类型。
 *
 * 通过该类型可以在 switch 分支和消息定义中保持严格的字符串字面量约束。
 */
export type MessageType = (typeof MESSAGE_TYPES)[keyof typeof MESSAGE_TYPES];
