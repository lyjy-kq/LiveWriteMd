/**
 * Webview 设置状态 —— 设置在前端的单一持有者。
 *
 * 职责：
 *
 * 1. 持有当前全部设置（默认值来自 settingsSchema 的 getDefaultSettings）；
 * 2. 把设置同步成 documentElement 上的 CSS 自定义属性（颜色 / 尺寸），
 *    styles.ts 里所有 `var(--livewritemd-*, 默认)` 读的就是这里；
 * 3. 给非渲染逻辑（拖拽阈值、双击钉住、引导线开关等）提供类型化读取。
 *
 * 颜色项：值为空串 `""` 时**移除**对应变量，回到「自动 / 跟随主题」；
 * 非空才写入、覆盖明暗两套主题。
 *
 * @module webview/settingsState
 */

import {
    getDefaultSettings,
    type SettingValue,
} from '../shared/settingsSchema.js';

/** 根元素（:root）。 */
const root = document.documentElement;

/** 写入一个 CSS 自定义属性。 */
function setVar(name: string, value: string): void {
    root.style.setProperty(name, value);
}

/** 移除一个 CSS 自定义属性（回到样式表默认）。 */
function removeVar(name: string): void {
    root.style.removeProperty(name);
}

/**
 * 颜色类设置：空串移除（自动），非空写入。
 *
 * @param key - 设置键
 * @param varName - 对应的 CSS 变量名
 * @param value - 设置值
 */
function applyColor(
    varName: string,
    value: SettingValue
): void {
    const color = String(value).trim();
    if (color) setVar(varName, color);
    else removeVar(varName);
}

/**
 * 把单个设置项应用到 CSS 变量。
 *
 * 列出所有「会影响 CSS」的设置；不在此列的设置（行为类）由各自逻辑直接读取，
 * 不产生 CSS 变量。
 *
 * @param key - 设置键
 * @param value - 设置值
 */
function applyOneToCss(key: string, value: SettingValue): void {
    switch (key) {
        // ---- 标题颜色 ----
        case 'h1Color': applyColor('--livewritemd-h1-color', value); break;
        case 'h2Color': applyColor('--livewritemd-h2-color', value); break;
        case 'h3Color': applyColor('--livewritemd-h3-color', value); break;
        case 'h4Color': applyColor('--livewritemd-h4-color', value); break;
        case 'h5Color': applyColor('--livewritemd-h5-color', value); break;
        case 'h6Color': applyColor('--livewritemd-h6-color', value); break;
        case 'h1Size':
            setVar('--livewritemd-h1-size', `${Number(value)}em`);
            break;

        // ---- 加粗 / 斜体 / 删除线 ----
        case 'boldColor': applyColor('--livewritemd-bold-color', value); break;
        case 'italicColor': applyColor('--livewritemd-italic-color', value); break;
        case 'strikethroughColor':
            applyColor('--livewritemd-strikethrough-color', value);
            break;
        case 'italicSlant':
            setVar('--livewritemd-italic-style', value ? 'italic' : 'normal');
            break;

        // ---- 行内代码 ----
        case 'inlineCodeColor':
            applyColor('--livewritemd-inline-code-color', value);
            break;
        case 'inlineCodeBackground':
            applyColor('--livewritemd-inline-code-background', value);
            break;
        case 'inlineCodeScale':
            setVar('--livewritemd-inline-code-scale', `${Number(value)}em`);
            break;

        // ---- 代码块 ----
        case 'codeblockBackground':
            applyColor('--livewritemd-codeblock-background', value);
            break;
        case 'codeblockEdge':
            applyColor('--livewritemd-codeblock-edge', value);
            break;

        // ---- 链接 / 引用 / 分隔线 ----
        case 'linkColor': applyColor('--livewritemd-link-color', value); break;
        case 'quoteBorderColor':
            applyColor('--livewritemd-quote-border-color', value);
            break;
        case 'quoteTextColor':
            applyColor('--livewritemd-quote-text-color', value);
            break;
        case 'hrColor': applyColor('--livewritemd-hr-color', value); break;

        // ---- 表格 ----
        case 'tableBorderColor':
            applyColor('--livewritemd-table-border-color', value);
            break;
        case 'tableHeaderBackground':
            applyColor('--livewritemd-table-header-background', value);
            break;
        case 'tableStripeBackground':
            applyColor('--livewritemd-table-stripe-background', value);
            break;
        case 'tableSelectedBackground':
            applyColor('--livewritemd-table-selected-background', value);
            break;

        // ---- 列表 / 复选框 ----
        case 'bulletColor': applyColor('--livewritemd-bullet-color', value); break;
        case 'checkboxAccent':
            applyColor('--livewritemd-checkbox-accent', value);
            break;

        // ---- 媒体宽度（变量名沿用历史命名）----
        case 'mediaWidth':
            setVar('--cm-md-media-width', `${Number(value)}%`);
            break;
        case 'mediaCenter':
            setVar('--livewritemd-media-center-align', value ? 'center' : 'left');
            break;

        default:
            // 行为类设置（lineNumbers、dragThreshold 等）不映射 CSS
            break;
    }
}

// =============================================================================
// SettingsState
// =============================================================================

class SettingsStateImpl {
    /** 当前设置值。 */
    private values: Record<string, SettingValue> = getDefaultSettings();

    /**
     * 用一个完整设置对象替换全部值并应用 CSS（INIT / settingsChange）。
     *
     * @param next - 完整设置对象
     */
    replaceAll(next: Record<string, SettingValue>): void {
        this.values = { ...getDefaultSettings(), ...next };
        for (const [key, value] of Object.entries(this.values)) {
            applyOneToCss(key, value);
        }
    }

    /**
     * 更新单项：存值 + 仅应用该项的 CSS（设置面板实时预览用）。
     *
     * @param key - 设置键
     * @param value - 新值
     */
    set(key: string, value: SettingValue): void {
        this.values[key] = value;
        applyOneToCss(key, value);
    }

    /** 读取原始值。 */
    get(key: string): SettingValue {
        return this.values[key];
    }

    /** 按布尔读取。 */
    getBoolean(key: string): boolean {
        return Boolean(this.values[key]);
    }

    /** 按数字读取。 */
    getNumber(key: string): number {
        const n = Number(this.values[key]);
        return Number.isFinite(n) ? n : 0;
    }

    /** 按字符串读取。 */
    getString(key: string): string {
        return String(this.values[key] ?? '');
    }
}

/** Webview 全局单例。 */
export const settingsState = new SettingsStateImpl();
