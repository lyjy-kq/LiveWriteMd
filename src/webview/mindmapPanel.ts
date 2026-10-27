/**
 * 独立导图面板（WebviewPanel）的轻量入口（设计文档 §3.2）。
 *
 * 与主编辑器 webview（main.ts）共用同一条消息协议：
 * 扩展侧 READY 握手后下发 INIT，之后通过 UPDATE 同步外部改动、
 * SETTINGS_CHANGE / THEME_CHANGE 同步设置与明暗。
 *
 * 区别：面板不挂 CodeMirror，导图编辑产生的新全文直接通过 CONTENT_CHANGE
 * 发回扩展侧（不存在 CM 撤销栈，撤销由 VS Code 文档 undo 承担）。
 */

import { MindMapApp } from './mindmap/mindmapApp.js';
import { settingsState } from './settingsState.js';
import { MESSAGE_TYPES } from '../shared/messageTypes.js';
import { getDefaultSettings, type SettingValue } from '../shared/settings/index.js';
import type { MindMapRuntimeSettings } from './mindmap/types.js';
import type { ThemeType } from '../shared/types.js';

/** VS Code 注入的 webview API（每个 webview 只能 acquire 一次）。 */
interface VsCodeApi {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

/** 收到的消息（只按本面板需要的字段宽松解析）。 */
interface IncomingMessage {
    type?: string;
    content?: string;
    theme?: ThemeType;
    documentUri?: string;
    allSettings?: Record<string, SettingValue>;
}

/**
 * 从 allSettings 抽取导图三项运行时设置，缺失时回落 schema 默认值。
 *
 * @param all INIT / settingsChange 下发的完整设置
 * @returns 导图运行时设置
 */
function readMindmapSettings(
    all: Record<string, SettingValue> | undefined
): MindMapRuntimeSettings {
    const defaults = getDefaultSettings();
    const pick = (key: string): SettingValue => all?.[key] ?? defaults[key];
    const expandLevel = Number(pick('mindmapDefaultExpandLevel'));
    const codeMinWidth = Number(pick('mindmapCodeMinWidth'));
    return {
        mindmapTheme: String(pick('mindmapTheme') || 'auto'),
        mindmapDefaultExpandLevel: Number.isFinite(expandLevel) ? expandLevel : 2,
        mindmapPerformanceMode: Boolean(pick('mindmapPerformanceMode')),
        // 离屏实例 LRU 淘汰：默认关闭
        mindmapDisplayCache: Boolean(pick('mindmapDisplayCache')),
        // 顺带补齐尺寸类设置（此前面板只取三项，靠 CSS 回落兜底）
        mindmapNodeMaxWidth: Number(pick('mindmapNodeMaxWidth')) || 20,
        mindmapNodeMaxLines: Number(pick('mindmapNodeMaxLines')) || 3,
        mindmapCodeMinWidth: Number.isFinite(codeMinWidth) ? codeMinWidth : 10,
        // 缩放降级开关：默认关闭，关闭时阈值不参与判断
        mindmapLiteEnabled: Boolean(pick('mindmapLiteEnabled')),
        mindmapPlainEnabled: Boolean(pick('mindmapPlainEnabled')),
        // 缩放降级阈值（百分比）
        mindmapLiteZoom: Number(pick('mindmapLiteZoom')) || 70,
        mindmapPlainZoom: Number(pick('mindmapPlainZoom')) || 40,
        // 手势期清晰度优先：默认关闭
        mindmapGestureCrisp: Boolean(pick('mindmapGestureCrisp')),
        // 内链箭头层：默认开启
        mindmapInternalLinks: Boolean(pick('mindmapInternalLinks')),
        // 性能监控浮层：默认关闭
        mindmapPerfHud: Boolean(pick('mindmapPerfHud')),
    };
}

/**
 * 从文档 URI 推导文件名（不含扩展名），作为导图虚拟根文本。
 *
 * @param uri 文档 URI
 * @returns 去扩展名后的文件名
 */
function fileNameFromUri(uri: string): string {
    try {
        const withoutQuery = decodeURIComponent(uri.split('?')[0] ?? uri);
        const base = withoutQuery.split(/[\\/]/).pop() ?? '';
        return base.replace(/\.(md|markdown)$/i, '');
    } catch {
        const fallback = uri.split(/[\\/]/).pop() ?? '';
        return fallback.replace(/\.(md|markdown)$/i, '');
    }
}

/** 把错误上报给扩展侧弹提示，避免面板静默失败。 */
function reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    vscode.postMessage({ type: MESSAGE_TYPES.ERROR, message, stack });
}

const host = document.getElementById('mindmap') as HTMLElement | null;

/** 导图应用（INIT 时惰性创建，之后复用）。 */
let app: MindMapApp | null = null;
/** 当前明暗主题，auto 配色跟随它。 */
let currentTheme: ThemeType = 'dark';
/** 当前文件名（虚拟根文本）。 */
let currentFileName = '';

/**
 * 惰性创建导图应用。面板没有 CM 实例，onEdit 直接发 CONTENT_CHANGE。
 *
 * @returns 导图应用实例；容器缺失时返回 null
 */
function ensureApp(): MindMapApp | null {
    if (app) return app;
    if (!host) {
        reportError(new Error('Mind map panel host element #mindmap is missing'));
        return null;
    }
    app = new MindMapApp(host, {
        onEdit: (newFullText: string) => {
            vscode.postMessage({ type: MESSAGE_TYPES.CONTENT_CHANGE, content: newFullText });
        },
        // 迭代 N8：面板没有隐藏 CM，撤销/重做经 extension 走文档 undo/redo
        onUndo: () => {
            vscode.postMessage({ type: 'mindmapUndoRedo', kind: 'undo' });
        },
        onRedo: () => {
            vscode.postMessage({ type: 'mindmapUndoRedo', kind: 'redo' });
        },
        // 迭代 N3：导图导出 → extension 存盘
        onExport: (payload) => {
            vscode.postMessage({ type: 'saveMindmapExport', ...payload });
        },
    });
    app.setTheme(currentTheme);
    return app;
}

window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as IncomingMessage | undefined;
    if (!msg?.type) return;
    try {
        if (msg.type === MESSAGE_TYPES.INIT) {
            currentTheme = msg.theme ?? 'dark';
            currentFileName = fileNameFromUri(String(msg.documentUri ?? ''));
            // 面板没有主编辑器那套初始化，字体 / 颜色等 CSS 变量要自己落到
            // :root，否则「英文字体 / 中文字体」等设置在这个独立窗口里不生效。
            settingsState.replaceAll(msg.allSettings ?? {});
            const instance = ensureApp();
            if (!instance) return;
            instance.setSettings(readMindmapSettings(msg.allSettings));
            instance.setDocument(String(msg.content ?? ''), currentFileName);
            // 面板 webview 在后台创建时容器尺寸可能为 0，就绪并激活后再 fit 一次
            void instance.whenReady().then(() => instance.setActive(true));
        } else if (msg.type === MESSAGE_TYPES.UPDATE) {
            app?.setDocument(String(msg.content ?? ''), currentFileName);
        } else if (msg.type === MESSAGE_TYPES.THEME_CHANGE) {
            if (msg.theme) {
                currentTheme = msg.theme;
                app?.setTheme(currentTheme);
            }
        } else if (msg.type === MESSAGE_TYPES.SETTINGS_CHANGE) {
            if (msg.allSettings) settingsState.replaceAll(msg.allSettings);
            app?.setSettings(readMindmapSettings(msg.allSettings));
        }
    } catch (error) {
        reportError(error);
    }
});

// 握手：扩展侧收到 READY 后下发 INIT
vscode.postMessage({ type: MESSAGE_TYPES.READY });