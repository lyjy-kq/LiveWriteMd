/**
 * SettingsPanel —— LiveWriteMD 应用内设置面板（Obsidian 风格）。
 *
 * - 左侧分组导航，右侧当前分组的设置项（滚动）；
 * - 控件：开关、滑块、颜色取色器（含「自动 / 重置」）、下拉、文本；
 * - 任何改动：① 立即写入 settingsState（同一 DOM 实时预览），
 *   ② 通过 onChange 回调交给外部把单项设置持久化到 VS Code 配置；
 * - Esc / 关闭按钮 / 点遮罩关闭。
 *
 * @module webview/settingsPanel
 */

import {
    SETTINGS_SCHEMA,
    getSettingItem,
    type SettingItem,
    type SettingValue,
} from '../shared/settingsSchema.js';
import { settingsState } from './settingsState.js';

/** 设置改动回调：把单项设置持久化。 */
export type SettingChangeHandler = (key: string, value: SettingValue) => void;

// =============================================================================
// 样式（自包含）
// =============================================================================

const PANEL_STYLES = `
#livewritemd-settings-root {
    position: fixed;
    inset: 0;
    z-index: 99999;
    display: none;
}
#livewritemd-settings-root[data-open="true"] { display: block; }

.fms-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.42);
    animation: fms-fade 0.16s ease;
}
@keyframes fms-fade { from { opacity: 0; } }

.fms-window {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(920px, 94vw);
    height: min(720px, 90vh);
    display: flex;
    flex-direction: column;
    background: var(--vscode-editorBackground, #252526);
    color: var(--vscode-editorForeground, #d4d4d4);
    border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.25));
    border-radius: 10px;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.5);
    overflow: hidden;
    animation: fms-pop 0.18s ease;
}
@keyframes fms-pop {
    from { opacity: 0; transform: translate(-50%, -48%); }
}

.fms-header {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 18px;
    border-bottom: 1px solid var(--vscode-editorGroup-border, rgba(128,128,128,0.18));
    font-size: 15px;
    font-weight: 600;
}
.fms-header-title { flex: 1 1 auto; }
.fms-close {
    width: 28px; height: 28px;
    display: inline-flex; align-items: center; justify-content: center;
    border: none; border-radius: 6px;
    background: transparent;
    color: inherit;
    font-size: 18px;
    cursor: pointer;
}
.fms-close:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }

.fms-body { flex: 1 1 auto; display: flex; min-height: 0; }

.fms-nav {
    flex: 0 0 168px;
    overflow-y: auto;
    padding: 10px 8px;
    border-right: 1px solid var(--vscode-editorGroup-border, rgba(128,128,128,0.14));
}
.fms-nav-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 10px;
    margin-bottom: 2px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    text-align: left;
    font-size: 13px;
    cursor: pointer;
}
.fms-nav-btn:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }
.fms-nav-btn[data-active="true"] {
    background: var(--vscode-list-activeSelectionBackground, rgba(79,193,255,0.25));
    color: var(--vscode-list-activeSelectionForeground, inherit);
}
.fms-nav-icon { width: 18px; text-align: center; }

.fms-content {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 8px 22px 28px;
}

.fms-row {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 13px 2px;
    border-bottom: 1px solid var(--vscode-editorGroup-border, rgba(128,128,128,0.1));
}
.fms-info { flex: 1 1 auto; min-width: 0; }
.fms-label { font-size: 13px; font-weight: 500; }
.fms-desc { margin-top: 3px; font-size: 11.5px; color: var(--vscode-descriptionForeground, #999); line-height: 1.5; }
.fms-control { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }

/* toggle switch */
.fms-switch {
    position: relative;
    width: 38px; height: 20px;
    border-radius: 999px;
    background: rgba(128,128,128,0.35);
    border: none;
    cursor: pointer;
    transition: background 0.15s ease;
}
.fms-switch::after {
    content: "";
    position: absolute;
    top: 2px; left: 2px;
    width: 16px; height: 16px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.15s ease;
}
.fms-switch[data-on="true"] { background: var(--vscode-button-background, #0e639c); }
.fms-switch[data-on="true"]::after { transform: translateX(18px); }

/* slider */
.fms-slider { width: 150px; accent-color: var(--vscode-focusBorder, #007acc); }
.fms-slider-value {
    min-width: 52px;
    text-align: right;
    font-size: 12px;
    color: var(--vscode-descriptionForeground, #aaa);
}

/* color */
.fms-color {
    width: 32px; height: 24px;
    padding: 0;
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    border-radius: 5px;
    background: none;
    cursor: pointer;
}
.fms-color::-webkit-color-swatch-wrapper { padding: 2px; }
.fms-color::-webkit-color-swatch { border: none; border-radius: 3px; }
.fms-color-text {
    width: 78px;
    font-size: 11px;
    padding: 3px 6px;
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    border-radius: 4px;
    background: var(--vscode-input-background, #3c3c3c);
    color: inherit;
}
.fms-reset {
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-descriptionForeground, #bbb);
    font-size: 11px;
    padding: 3px 8px;
    cursor: pointer;
}
.fms-reset:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
.fms-auto-tag {
    font-size: 10.5px;
    color: var(--vscode-descriptionForeground, #999);
}

/* select / text */
.fms-select, .fms-text {
    min-width: 200px;
    font-size: 12px;
    padding: 5px 8px;
    border: 1px solid var(--vscode-dropdown-border, rgba(128,128,128,0.3));
    border-radius: 4px;
    background: var(--vscode-dropdown-background, #3c3c3c);
    color: var(--vscode-dropdown-foreground, inherit);
}
.fms-text {
    background: var(--vscode-input-background, #3c3c3c);
    border-color: var(--vscode-input-border, rgba(128,128,128,0.3));
}
.fms-section-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--vscode-descriptionForeground, #888);
    margin: 18px 2px 4px;
}
.fms-section-title:first-child { margin-top: 6px; }
`;

// =============================================================================
// 工具
// =============================================================================

/**
 * 把任意颜色字符串尽量归一为 #rrggbb（供 input[type=color]）。
 * 失败返回 #888888。
 */
function toHexColor(value: string): string {
    const v = value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
    if (/^#[0-9a-fA-F]{3}$/.test(v)) {
        return (
            '#' +
            v
                .slice(1)
                .split('')
                .map((c) => c + c)
                .join('')
        );
    }
    // 用浏览器解析 rgb()/rgba()/命名色
    const probe = document.createElement('span');
    probe.style.color = v;
    document.body.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    const m = computed.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) {
        return (
            '#' +
            [m[1], m[2], m[3]]
                .map((n) => Number(n).toString(16).padStart(2, '0'))
                .join('')
        );
    }
    return '#888888';
}

/**
 * 颜色设置为「自动」时，尝试从一个代表性元素读取当前实际颜色。
 * 选择器表：color key -> 用来读 computed color 的选择器。
 */
const COLOR_SAMPLE_SELECTOR: Record<string, string> = {
    h1Color: '.cm-md-heading-1',
    h2Color: '.cm-md-heading-2',
    h3Color: '.cm-md-heading-3',
    h4Color: '.cm-md-heading-4',
    h5Color: '.cm-md-heading-5',
    h6Color: '.cm-md-heading-6',
    boldColor: '.cm-md-bold',
    italicColor: '.cm-md-italic',
    strikethroughColor: '.cm-md-strikethrough',
    inlineCodeColor: '.cm-md-code',
    inlineCodeBackground: '.cm-md-code',
    codeblockBackground: '.cm-md-codeblock',
    codeblockEdge: '.cm-md-codeblock',
    linkColor: '.cm-md-link',
    quoteBorderColor: '.cm-md-blockquote',
    quoteTextColor: '.cm-md-blockquote',
    hrColor: '.cm-md-hr',
    tableBorderColor: '.cm-md-tcell',
    tableHeaderBackground: '.cm-md-table-header .cm-md-tcell',
    tableStripeBackground: '.cm-md-tcell',
    tableSelectedBackground: '.cm-md-tcell-selected',
    bulletColor: '.cm-md-bullet',
    checkboxAccent: '.cm-md-checkbox',
};

/** 背景类颜色应读 backgroundColor，其余读 color。 */
const BACKGROUND_KEYS = new Set([
    'inlineCodeBackground',
    'codeblockBackground',
    'tableHeaderBackground',
    'tableStripeBackground',
]);

/**
 * 读取某颜色设置当前实际生效的颜色（自动状态下用于取色器占位显示）。
 */
function sampleEffectiveColor(key: string): string | null {
    const selector = COLOR_SAMPLE_SELECTOR[key];
    if (!selector) return null;
    const el = document.querySelector(selector);
    if (!el) return null;
    const cs = getComputedStyle(el as Element);
    const raw = BACKGROUND_KEYS.has(key) ? cs.backgroundColor : cs.color;
    const m = raw.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return null;
    return (
        '#' +
        [m[1], m[2], m[3]]
            .map((n) => Number(n).toString(16).padStart(2, '0'))
            .join('')
    );
}

// =============================================================================
// 控件渲染
// =============================================================================

/** 控件公共上下文。 */
interface ControlContext {
    commit: (value: SettingValue) => void;
}

/** 开关。 */
function renderToggle(item: SettingItem, ctx: ControlContext): HTMLElement {
    const btn = document.createElement('button');
    btn.className = 'fms-switch';
    btn.type = 'button';
    const sync = () => btn.setAttribute('data-on', String(settingsState.getBoolean(item.key)));
    sync();
    btn.addEventListener('click', () => {
        ctx.commit(!settingsState.getBoolean(item.key));
        sync();
    });
    return btn;
}

/** 滑块（含特殊值文字）。 */
function renderSlider(item: SettingItem, ctx: ControlContext): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '8px';

    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'fms-slider';
    input.min = String(item.min ?? 0);
    input.max = String(item.max ?? 100);
    input.step = String(item.step ?? 1);
    input.value = String(settingsState.getNumber(item.key));

    const valueEl = document.createElement('span');
    valueEl.className = 'fms-slider-value';
    const formatValue = (): string => {
        const n = settingsState.getNumber(item.key);
        const special = item.valueLabels?.find((vl) => vl.value === n);
        if (special) return special.label;
        const decimals = (String(item.step ?? 1).split('.')[1] ?? '').length;
        return `${n.toFixed(decimals)}${item.unit ?? ''}`;
    };
    const refresh = () => {
        valueEl.textContent = formatValue();
    };
    refresh();

    input.addEventListener('input', () => {
        ctx.commit(Number(input.value));
        refresh();
    });

    wrap.appendChild(input);
    wrap.appendChild(valueEl);
    return wrap;
}

/** 颜色取色器 + hex 输入 + 自动/重置。 */
function renderColor(item: SettingItem, ctx: ControlContext): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '6px';

    const picker = document.createElement('input');
    picker.type = 'color';
    picker.className = 'fms-color';

    const text = document.createElement('input');
    text.type = 'text';
    text.className = 'fms-color-text';
    text.spellcheck = false;

    const autoTag = document.createElement('span');
    autoTag.className = 'fms-auto-tag';

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'fms-reset';
    reset.textContent = '重置';

    const currentValue = (): string => settingsState.getString(item.key);
    const isAuto = (): boolean => currentValue().trim() === '';

    const refresh = (): void => {
        if (isAuto()) {
            // 自动：取色器显示当前实际生效色（读不到用灰），文本显示「自动」
            picker.value = sampleEffectiveColor(item.key) ?? '#888888';
            text.value = '自动';
            autoTag.textContent = '跟随主题';
            reset.style.display = 'none';
        } else {
            const hex = toHexColor(currentValue());
            picker.value = hex;
            text.value = currentValue();
            autoTag.textContent = '';
            reset.style.display = '';
        }
    };

    picker.addEventListener('input', () => {
        ctx.commit(picker.value);
        refresh();
    });
    text.addEventListener('change', () => {
        const v = text.value.trim();
        if (v === '' || v === '自动') ctx.commit('');
        else ctx.commit(v);
        refresh();
    });
    reset.addEventListener('click', () => {
        ctx.commit('');
        refresh();
    });

    refresh();
    wrap.appendChild(picker);
    wrap.appendChild(text);
    wrap.appendChild(autoTag);
    wrap.appendChild(reset);
    return wrap;
}

/** 下拉。 */
function renderSelect(item: SettingItem, ctx: ControlContext): HTMLElement {
    const select = document.createElement('select');
    select.className = 'fms-select';
    for (const option of item.options ?? []) {
        const opt = document.createElement('option');
        opt.value = option.value;
        opt.textContent = option.label;
        select.appendChild(opt);
    }
    select.value = settingsState.getString(item.key) || String(item.default);
    select.addEventListener('change', () => ctx.commit(select.value));
    return select;
}

/** 文本。 */
function renderText(item: SettingItem, ctx: ControlContext): HTMLElement {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'fms-text';
    input.value = settingsState.getString(item.key);
    if (item.placeholder) input.placeholder = item.placeholder;
    input.addEventListener('change', () => ctx.commit(input.value));
    return input;
}

/** 按控件类型分发渲染。 */
function renderControl(item: SettingItem, ctx: ControlContext): HTMLElement {
    switch (item.control) {
        case 'toggle': return renderToggle(item, ctx);
        case 'slider': return renderSlider(item, ctx);
        case 'color': return renderColor(item, ctx);
        case 'select': return renderSelect(item, ctx);
        case 'text': return renderText(item, ctx);
        default: return document.createElement('span');
    }
}

// =============================================================================
// SettingsPanel
// =============================================================================

class SettingsPanelImpl {
    /** webview 内常驻启动按钮的元素 id。 */
    private static readonly LAUNCHER_ID = 'livewritemd-settings-launcher';

    /** 根元素。 */
    private root: HTMLElement;
    /** 导航按钮容器。 */
    private navEl: HTMLElement;
    /** 设置项容器。 */
    private contentEl: HTMLElement;
    /** 当前选中分组 id。 */
    private activeSection = SETTINGS_SCHEMA[0].id;
    /** 持久化回调。 */
    private onChange: SettingChangeHandler | null = null;

    constructor() {
        // 注入样式
        const style = document.createElement('style');
        style.textContent = PANEL_STYLES;
        document.head.appendChild(style);

        this.root = document.createElement('div');
        this.root.id = 'livewritemd-settings-root';
        this.root.innerHTML = `
            <div class="fms-overlay"></div>
            <div class="fms-window" role="dialog" aria-modal="true" aria-label="LiveWriteMD 设置">
                <div class="fms-header">
                    <span class="fms-header-title">LiveWriteMD 设置</span>
                    <button class="fms-close" type="button" aria-label="关闭">✕</button>
                </div>
                <div class="fms-body">
                    <div class="fms-nav"></div>
                    <div class="fms-content"></div>
                </div>
            </div>
        `;
        document.body.appendChild(this.root);

        this.navEl = this.root.querySelector('.fms-nav')!;
        this.contentEl = this.root.querySelector('.fms-content')!;

        // 关闭交互
        this.root.querySelector('.fms-close')!.addEventListener('click', () => this.close());
        this.root.querySelector('.fms-overlay')!.addEventListener('click', () => this.close());
        this.root.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.close();
        });

        this.buildNav();
    }

    /**
     * 把「设置」齿轮按钮挂到大纲面板底部的操作按钮组（#outline-actions），
     * 与「展开全部 / 收起全部 / 标题编号 / 关闭大纲」等按钮排成一排。
     *
     * 复用 .outline-action-btn 的样式，外观与同组按钮完全一致；按钮带
     * data-outline-action="open-settings"，大纲操作组的点击处理不认识该动作会
     * 直接忽略，避免误触大纲行为。
     *
     * 注意调用时机：必须在 OutlinePanel 创建（#outline-actions 已存在）之后调用。
     *
     * @param onChange - 设置改动的持久化回调，保存下来供打开面板时使用
     */
    mountLauncher(onChange?: SettingChangeHandler): void {
        if (onChange) this.onChange = onChange;
        const existing = document.getElementById(SettingsPanelImpl.LAUNCHER_ID);
        if (existing) return;

        const button = document.createElement('button');
        button.type = 'button';
        button.id = SettingsPanelImpl.LAUNCHER_ID;
        // 与大纲操作组按钮同款（28×28、边框、图标居中）
        button.className = 'outline-action-btn';
        button.setAttribute('data-outline-action', 'open-settings');
        button.title = 'LiveWriteMD 设置';
        button.setAttribute('aria-label', 'LiveWriteMD 设置');
        button.innerHTML = `
            <span class="outline-action-icon" aria-hidden="true">
                <svg viewBox="0 0 16 16" style="width:15px;height:15px;fill:currentColor">
                    <path d="M9.1 1.5l.5 1.6 1.3.7 1.6-.4.9 1.4-1.1 1.2v1.5l1.1 1.2-.9 1.4-1.6-.4-1.3.8-.5 1.5h-1.8l-.5-1.5-1.3-.8-1.6.4-.9-1.4 1.1-1.2V6L3 4.8l.9-1.4 1.6.4 1.3-.7.5-1.6h1.8zM8 9.4a1.4 1.4 0 100-2.8 1.4 1.4 0 000 2.8z"></path>
                </svg>
            </span>
        `;
        // 点击齿轮 → 打开设置面板（open 复用已保存的 onChange 持久化回调）
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            if (!this.isOpen) this.open();
        });

        // 挂到大纲操作按钮组；正常流程下该组已由 OutlinePanel 创建
        const actionBar = document.getElementById('outline-actions');
        (actionBar ?? document.body).appendChild(button);
    }

    /** 构建左侧分组导航。 */
    private buildNav(): void {
        for (const section of SETTINGS_SCHEMA) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'fms-nav-btn';
            btn.innerHTML = `<span class="fms-nav-icon">${section.icon}</span><span>${section.label}</span>`;
            btn.addEventListener('click', () => {
                this.activeSection = section.id;
                this.syncNavActive();
                this.buildContent();
            });
            this.navEl.appendChild(btn);
        }
    }

    /** 同步导航高亮。 */
    private syncNavActive(): void {
        const buttons = this.navEl.querySelectorAll('.fms-nav-btn');
        SETTINGS_SCHEMA.forEach((section, index) => {
            buttons[index].setAttribute(
                'data-active',
                String(section.id === this.activeSection)
            );
        });
    }

    /** 构建当前分组的设置项。 */
    private buildContent(): void {
        const section = SETTINGS_SCHEMA.find((s) => s.id === this.activeSection);
        if (!section) return;
        this.contentEl.scrollTop = 0;
        this.contentEl.innerHTML = '';

        const title = document.createElement('div');
        title.className = 'fms-section-title';
        title.textContent = `${section.icon} ${section.label}`;
        this.contentEl.appendChild(title);

        for (const item of section.items) {
            const row = document.createElement('div');
            row.className = 'fms-row';

            const info = document.createElement('div');
            info.className = 'fms-info';
            info.innerHTML = `<div class="fms-label">${item.label}</div>`;
            if (item.description) {
                const desc = document.createElement('div');
                desc.className = 'fms-desc';
                desc.textContent = item.description;
                info.appendChild(desc);
            }

            const control = renderControl(item, {
                commit: (value: SettingValue) => {
                    // ① 实时写入（同一 DOM 立即预览）
                    settingsState.set(item.key, value);
                    // ② 持久化
                    this.onChange?.(item.key, value);
                },
            });

            const ctrlWrap = document.createElement('div');
            ctrlWrap.className = 'fms-control';
            ctrlWrap.appendChild(control);

            row.appendChild(info);
            row.appendChild(ctrlWrap);
            this.contentEl.appendChild(row);
        }
    }

    /**
     * 打开面板。
     *
     * @param onChange - 单项设置持久化回调
     */
    open(onChange?: SettingChangeHandler): void {
        if (onChange) this.onChange = onChange;
        this.syncNavActive();
        this.buildContent();
        this.root.setAttribute('data-open', 'true');
        // 焦点放到窗口以便 Esc
        (this.root.querySelector('.fms-window') as HTMLElement).focus();
    }

    /** 关闭面板。 */
    close(): void {
        this.root.setAttribute('data-open', 'false');
    }

    /** 是否打开。 */
    get isOpen(): boolean {
        return this.root.getAttribute('data-open') === 'true';
    }
}

/** 全局单例。 */
export const settingsPanel = new SettingsPanelImpl();

// 防止未使用告警（getSettingItem 供外部按需使用）
void getSettingItem;
