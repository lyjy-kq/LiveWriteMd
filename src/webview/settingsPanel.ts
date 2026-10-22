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
    type SettingOption,
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

/* 底部操作栏：应用按钮固定在左下角 */
.fms-footer {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    border-top: 1px solid var(--vscode-editorGroup-border, rgba(128,128,128,0.18));
}
.fms-apply {
    padding: 5px 20px;
    border: none;
    border-radius: 4px;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
    font-size: 12px;
    cursor: pointer;
}
.fms-apply:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
.fms-apply:active { transform: translateY(1px); }
.fms-apply-hint {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #999);
    opacity: 0;
    transition: opacity 0.15s ease;
}
.fms-apply-hint[data-show="true"] { opacity: 1; }

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

/* 字体选择：输入框 + datalist + 「跟随」按钮 */
.fms-font {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
}
.fms-font .fms-text {
    flex: 1;
    min-width: 190px;
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

// =============================================================================
// 字体列表（由扩展宿主枚举后下发）
// =============================================================================

/**
 * 本机已安装字体。Webview 的浏览器不提供系统字体枚举接口，所以这里的数据
 * 来自扩展宿主的 `systemFonts` 消息；消息还没到（或枚举失败）时为空数组，
 * 下拉退回到 schema 里的常用字体。
 */
let systemFonts: string[] = [];

/** 当前渲染出来的 datalist；字体列表晚到时就地填充，不重建面板。 */
const fontListTargets = new Set<HTMLDataListElement>();

/**
 * 文本 / 字体输入框里「已经预览、还没写进 VS Code 配置」的值。
 *
 * 打字过程中每敲一个字符就写配置会不停触发 onDidChangeConfiguration，
 * 所以输入时只更新 settingsState（画面实时变），失焦 / 回车或点「应用」
 * 时才真正持久化。切换分组 / 关面板时这些值也一并提交，避免丢失。
 */
const pendingEdits = new Map<string, SettingValue>();

/** 把字体名写进 datalist。 */
function appendFontOptions(list: HTMLDataListElement, names: string[]): void {
    for (const name of names) {
        const opt = document.createElement('option');
        opt.value = name;
        list.appendChild(opt);
    }
}

/** 填充 datalist：优先系统字体，没有则用 schema 候选兜底。 */
function fillFontList(list: HTMLDataListElement, fallback?: SettingOption[]): void {
    list.innerHTML = '';
    if (systemFonts.length > 0) {
        appendFontOptions(list, systemFonts);
        return;
    }
    const names = (fallback ?? [])
        .map((option) => option.value)
        .filter((value) => value.length > 0);
    appendFontOptions(list, names);
}

/**
 * 字体选择控件：可输入的输入框 + datalist + 「跟随」重置。
 *
 * 用可输入的下拉而不是几百项的 `<select>`：输入几个字母即可筛选
 * （比如打 "sim" 找宋体、打 "雅" 找微软雅黑），也允许直接输入枚举
 * 不到的字体名。改动只在 change（回车 / 失焦 / 选中列表项）时提交，
 * 避免每敲一个字符就写一次 VS Code 配置。
 */
function renderFont(item: SettingItem, ctx: ControlContext): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'fms-font';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'fms-text';
    input.value = settingsState.getString(item.key);
    input.placeholder = item.placeholder ?? '输入字体名筛选，或展开列表选择';
    input.spellcheck = false;

    // datalist 用元素 id 关联；key 唯一，重建面板时旧节点已从 Set 里清掉
    const listId = `fms-font-list-${item.key}`;
    input.setAttribute('list', listId);
    const list = document.createElement('datalist');
    list.id = listId;
    fillFontList(list, item.options);
    fontListTargets.add(list);

    // 输入过程中只做预览：字体栈 / @font-face 立刻更新，但不写 settings.json
    input.addEventListener('input', () => {
        const value = input.value.trim();
        pendingEdits.set(item.key, value);
        settingsState.set(item.key, value);
    });
    // 回车 / 失焦 / 从 datalist 选中 → 持久化
    input.addEventListener('change', () => {
        pendingEdits.delete(item.key);
        ctx.commit(input.value.trim());
    });

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'fms-reset';
    reset.textContent = '跟随';
    reset.title = '清空，改用默认字体';
    reset.addEventListener('click', () => {
        input.value = '';
        pendingEdits.delete(item.key);
        ctx.commit('');
    });

    wrap.appendChild(input);
    wrap.appendChild(list);
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
    // 同样：输入时预览，失焦 / 回车 / 点「应用」时持久化
    input.addEventListener('input', () => {
        pendingEdits.set(item.key, input.value);
        settingsState.set(item.key, input.value);
    });
    input.addEventListener('change', () => {
        pendingEdits.delete(item.key);
        ctx.commit(input.value);
    });
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
        case 'font': return renderFont(item, ctx);
        default: return document.createElement('span');
    }
}

// =============================================================================
// SettingsPanel
// =============================================================================

class SettingsPanelImpl {
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
    /** 「已应用」提示的定时器。 */
    private applyHintTimer: number | null = null;

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
                <div class="fms-footer">
                    <button class="fms-apply" type="button">应用</button>
                    <span class="fms-apply-hint"></span>
                </div>
            </div>
        `;
        document.body.appendChild(this.root);

        this.navEl = this.root.querySelector('.fms-nav')!;
        this.contentEl = this.root.querySelector('.fms-content')!;

        // 底部「应用」：把输入框里尚未持久化的值写回配置，并完整重跑一遍 CSS；
        // 顺便给一个短提示，避免用户不确定有没有生效。
        const applyBtn = this.root.querySelector<HTMLButtonElement>('.fms-apply')!;
        const applyHint = this.root.querySelector<HTMLElement>('.fms-apply-hint')!;
        applyBtn.addEventListener('click', () => {
            this.applyPending();
            applyHint.textContent = '已应用';
            applyHint.setAttribute('data-show', 'true');
            if (this.applyHintTimer !== null) window.clearTimeout(this.applyHintTimer);
            this.applyHintTimer = window.setTimeout(() => {
                applyHint.setAttribute('data-show', 'false');
            }, 1200);
        });

        // 关闭交互
        this.root.querySelector('.fms-close')!.addEventListener('click', () => this.close());
        this.root.querySelector('.fms-overlay')!.addEventListener('click', () => this.close());
        this.root.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.close();
        });

        this.buildNav();
    }

    /**
     * 注册设置改动的持久化回调。
     *
     * 设置面板的打开入口统一收编到 VSCode 编辑器标题栏（openSettings 命令），
     * webview 内不再挂启动按钮；这里只保存回调，供 open() 时提交改动使用。
     *
     * @param onChange - 设置改动的持久化回调
     */
    registerChangeHandler(onChange: SettingChangeHandler): void {
        this.onChange = onChange;
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
        // 旧 datalist 已随 innerHTML 一起销毁，同步清掉引用，避免字体列表
        // 晚到时往已脱离文档的节点里填数据。
        fontListTargets.clear();

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

    /**
     * 收到扩展宿主枚举出的系统字体列表。
     *
     * 面板可能已经渲染好（先打开、字体列表后到），这里就地更新每个
     * datalist 的选项，不重建面板，避免用户正在看的内容被重置。
     *
     * @param fonts 字体家族名（扩展侧已去重排序）
     */
    setSystemFonts(fonts: string[]): void {
        const clean = (Array.isArray(fonts) ? fonts : [])
            .filter((name): name is string => typeof name === 'string')
            .map((name) => name.trim())
            .filter((name) => name.length > 0);
        if (clean.length === 0) return;
        systemFonts = clean;
        for (const list of fontListTargets) {
            list.innerHTML = '';
            appendFontOptions(list, systemFonts);
        }
    }

    /**
     * 提交所有「已预览未保存」的输入，并重跑一遍全部 CSS 变量。
     *
     * 正常失焦时 change 已经提交过，这里主要覆盖：
     * - 用户打字后直接点「应用」；
     * - 焦点还在输入框里时用 Esc 关闭面板。
     */
    private applyPending(): void {
        for (const [key, value] of pendingEdits) {
            settingsState.set(key, value);
            this.onChange?.(key, value);
        }
        pendingEdits.clear();
        settingsState.reapplyAll();
    }

    /** 关闭面板。 */
    close(): void {
        // 关面板前把没来得及提交的输入保存掉，避免「看着已经改了、重开又变回去」
        if (pendingEdits.size > 0) this.applyPending();
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
