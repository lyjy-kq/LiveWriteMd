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

// =============================================================================
// 中文字体：@font-face + unicode-range
// =============================================================================

/** 中文回退字体使用的 CSS 家族别名（只覆盖 CJK 码位）。 */
const CJK_FONT_FAMILY = 'LiveWriteMD-CJK';
/** 动态 @font-face 的 style 元素 id（每个 webview 只保留一份）。 */
const CJK_FONT_STYLE_ID = 'livewritemd-cjk-font-face';

/**
 * CJK 码位范围。
 *
 * 用 unicode-range 把「中文字体」限制在汉字 / 中文标点上，拉丁字母和数字
 * 就不会被它接管，可以继续用「英文字体」或 VS Code 编辑器字体。
 *
 * 覆盖：CJK 部首、康熙部首、CJK 标点、笔画、扩展 A、基本区、兼容汉字、
 * 兼容形式、全角字符、扩展 B 及以后（含兼容补充）。
 */
const CJK_UNICODE_RANGE =
    'U+2E80-2EFF, U+2F00-2FDF, U+3000-303F, U+31C0-31EF, U+3400-4DBF, ' +
    'U+4E00-9FFF, U+F900-FAFF, U+FE30-FE4F, U+FF00-FFEF, U+20000-2FA1F';

/**
 * 写入 / 更新「中文字体」对应的 @font-face。
 *
 * 为什么不能直接把中文字体塞进 font-family 列表：
 * 浏览器对每个字符按家族列表逐个匹配，`var(--vscode-editor-font-family)`
 * 展开后末尾通常带 `monospace` 这类泛型家族，而泛型家族本身能匹配汉字
 * （系统等宽字体带 CJK 回退），于是排在它后面的中文字体永远轮不到 ——
 * 用户选「华文中宋」看不到任何变化，根因就在这里。
 *
 * 改成 `src: local(...)` + `unicode-range` 之后：
 * - 这个别名只参与汉字 / 中文标点的匹配，排在第一也能让拉丁字符跳过它；
 * - 中文字体因此总能命中，而英文仍然交给后面的英文字体 / 主题字体。
 *
 * @param name 字体家族名；空串表示清除
 */
function applyCjkFontFace(name: string): void {
    const existing = document.getElementById(CJK_FONT_STYLE_ID) as HTMLStyleElement | null;
    if (!name) {
        existing?.remove();
        return;
    }
    const style = existing ?? document.createElement('style');
    if (!existing) {
        style.id = CJK_FONT_STYLE_ID;
        document.head.appendChild(style);
    }
    // local() 里的字符串要转义：去掉换行，转义反斜杠和双引号
    const escaped = name
        .replace(/[\n\r]/g, ' ')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');
    style.textContent =
        `@font-face { font-family: "${CJK_FONT_FAMILY}"; ` +
        `src: local("${escaped}"); unicode-range: ${CJK_UNICODE_RANGE}; ` +
        `font-display: swap; }`;
}

/**
 * 把「英文字体 / 中文字体」两个设置合成一个字体栈。
 *
 * 顺序决定字符落到哪套字体：
 * 1. 中文别名（只有设置了中文字体时存在）—— 靠 unicode-range 只接管 CJK，
 *    拉丁字符会跳过它；
 * 2. 英文字体 —— 拉丁字母 / 数字；
 * 3. VS Code 编辑器字体 + 等宽兜底 —— 两套都没覆盖到的字符。
 *
 * 两个都留空时移除变量和 @font-face，完全回到改造前的字体。
 * 代码块 / 行内代码不读这个变量（它们固定用 --vscode-editor-font-family），
 * 因此选比例字体也不会把代码变成非等宽。
 */
function applyEditorFontFamily(): void {
    const english = settingsState.getString('fontFamilyEnglish').trim();
    const chinese = settingsState.getString('fontFamilyChinese').trim();
    const fallback =
        'var(--vscode-editor-font-family, "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace)';
    if (!english && !chinese) {
        removeVar('--livewritemd-editor-font-family');
        applyCjkFontFace('');
        return;
    }
    // 统一加引号，防止用户从 VS Code 设置里直接写入带空格 / 特殊字符的名字
    const quote = (name: string): string => `"${name.replace(/["\\\n\r]/g, '')}"`;
    applyCjkFontFace(chinese);
    const stack: string[] = [];
    // 别名放在最前：unicode-range 已经保证它只匹配 CJK，不会抢拉丁字符
    if (chinese) stack.push(`"${CJK_FONT_FAMILY}"`);
    if (english) stack.push(quote(english));
    stack.push(fallback);
    setVar('--livewritemd-editor-font-family', stack.join(', '));
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
        // ---- 字体（中英文分开选，合成一个字体栈）----
        case 'fontFamilyEnglish':
        case 'fontFamilyChinese':
            applyEditorFontFamily();
            break;

        // ---- 正文行左内边距（正文与行号线的距离）----
        // theme.ts 的 .cm-line 与 helpers.ts 的列表悬挂缩进 calc 都读这个变量；
        // 值为 0 时正文紧贴行号线。
        case 'lineGutterGap':
            setVar('--livewritemd-line-padding-left', `${Number(value)}px`);
            break;

        // ---- 行间距倍数（Word 式 x.x 倍行距）----
        // 最终行高 = 基础行高 × 倍数。基础行高读 --livewritemd-line-height-base
        // （webviewContent.ts 注入，永远不会被覆盖）；不能读 --livewritemd-line-height
        // 本身——第一次覆盖之后拿到的就是乘过倍数的值，会越乘越大。
        case 'lineHeightScale': {
            const baseRaw = getComputedStyle(root)
                .getPropertyValue('--livewritemd-line-height-base')
                .trim();
            const match = baseRaw.match(/^(\d+(?:\.\d+)?)(em|px)$/);
            if (match) {
                const scaled = (Number.parseFloat(match[1]) * Number(value)).toFixed(3);
                setVar('--livewritemd-line-height', `${scaled}${match[2]}`);
            }
            // 解析失败（变量缺失/格式异常）则不动，保持样式表注入的原值
            break;
        }

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
        // ---- 导图节点底色浓度 ----
        // 只改背景色的混比，不动字形 / 栅格化路径：比例越低对比度越高，
        // 大字（高倍缩放）下的观感差别最明显。两个 webview 共用这套变量。
        // 底色浓度有两个落点：普通缩放的浓度、高倍缩放（>=150%）时的浓度。
        // 两个键都会影响这一组变量，所以放在同一个分支里一起重算。
        // 这里直接算出百分比写进两个变量，而不是在 CSS 里用 calc 相乘 ——
        // Chromium 不接受 color-mix 的百分比参数里放 calc()（实测整条声明
        // 被丢弃，底色完全不生效）。
        case 'mindmapNodeWash':
        case 'mindmapHiZoomContrast': {
            // 注意不能用 `|| 16` 兜底：0% 是合法取值（完全透明），会被 || 吃掉。
            const raw = Number(settingsState.get('mindmapNodeWash'));
            const base = Number.isFinite(raw) ? raw : 8;
            const boost = settingsState.getBoolean('mindmapHiZoomContrast');
            setVar('--lwm-node-wash', `${base}%`);
            setVar('--lwm-node-wash-hi', `${(base * (boost ? 0.35 : 1)).toFixed(2)}%`);
            break;
        }
        case 'headingBold':
            // 默认不加粗：两个变量都删掉，样式表回退到 inherit（跟随正文）。
            // 开启时保留原设计的级差：一级 700，二~六级 600。
            if (value) {
                setVar('--livewritemd-heading-weight-1', '700');
                setVar('--livewritemd-heading-weight', '600');
            } else {
                removeVar('--livewritemd-heading-weight-1');
                removeVar('--livewritemd-heading-weight');
            }
            break;

        // ---- 加粗 / 斜体 / 删除线 ----
        case 'boldColor': applyColor('--livewritemd-bold-color', value); break;
        case 'boldWeight':
            // 默认不加粗：移除变量，样式表回退到 inherit（跟随正文字重）。
            // 开启时才写入 700，不改颜色，颜色仍由 boldColor / 主题微调决定。
            if (value) setVar('--livewritemd-bold-weight', '700');
            else removeVar('--livewritemd-bold-weight');
            break;
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
        case 'inlineCodeBackground': {
            // 自定义底色仍然统一「掺 50% 透明」：用户此前反馈过行内代码不能
            // 变成一块不透明贴纸。把混合放在写入变量这一步，而不是样式表里，
            // 是为了让「没自定义」时能原样使用主题的
            // --vscode-textPreformat-background —— 主题色通常已经带透明度，
            // 再 mix 一次会被二次淡化，几乎看不见。
            const color = String(value).trim();
            if (color) {
                setVar(
                    '--livewritemd-inline-code-background',
                    `color-mix(in srgb, ${color} 50%, transparent)`
                );
            } else {
                removeVar('--livewritemd-inline-code-background');
            }
            break;
        }
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
        // 圆点垂直位置：0 也照常写入（变量默认 0em，写不写都行，
        // 统一写可避免用户归零后残留上一次的非零值）
        case 'bulletYOffset':
            setVar(
                '--livewritemd-bullet-y-offset',
                `${Number(value).toFixed(2)}em`
            );
            break;
        case 'checkboxAccent':
            applyColor('--livewritemd-checkbox-acent', value);
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
     * 重新把当前所有值写入 CSS 变量。
     *
     * 设置面板的「应用」按钮用：输入框在打字过程中只做预览，点应用时
     * 再完整跑一遍，确保字体栈 / @font-face 等组合型变量不会停在中间态。
     */
    reapplyAll(): void {
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
