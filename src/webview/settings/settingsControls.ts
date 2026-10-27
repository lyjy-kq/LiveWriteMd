/**
 * 设置面板控件渲染（从 settingsPanel.ts 拆出）。
 *
 * renderToggle/renderSlider/renderColor/renderFont/renderSelect/renderText
 * 六种控件的 DOM 构建 + renderControl 分发；fontListTargets / pendingEdits
 * 两个模块级集合被面板类（打开/关闭/提交时）直接读写，故导出。
 *
 * @module webview/settings/settingsControls
 */

import type { SettingItem, SettingOption, SettingValue } from '../../shared/settings/index.js';
import { settingsState } from './settingsState.js';
import { toHexColor, sampleEffectiveColor } from './colorTools.js';

// =============================================================================
// 控件渲染
// =============================================================================

/** 控件公共上下文。 */
export interface ControlContext {
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
export const fontListTargets = new Set<HTMLDataListElement>();

/**
 * 文本 / 字体输入框里「已经预览、还没写进 VS Code 配置」的值。
 *
 * 打字过程中每敲一个字符就写配置会不停触发 onDidChangeConfiguration，
 * 所以输入时只更新 settingsState（画面实时变），失焦 / 回车或点「应用」
 * 时才真正持久化。切换分组 / 关面板时这些值也一并提交，避免丢失。
 */
export const pendingEdits = new Map<string, SettingValue>();

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
export function renderControl(item: SettingItem, ctx: ControlContext): HTMLElement {
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

