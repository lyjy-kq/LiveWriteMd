/**
 * 设置面板取色工具（从 settingsPanel.ts 拆出）。
 *
 * toHexColor 归一化颜色值；sampleEffectiveColor 从页面已生效的 CSS
 * 变量里取当前实际颜色（「自动」态下取色器显示用）。
 *
 * @module webview/settings/colorTools
 */

// =============================================================================
// 工具
// =============================================================================

/**
 * 把任意颜色字符串尽量归一为 #rrggbb（供 input[type=color]）。
 * 失败返回 #888888。
 */
export function toHexColor(value: string): string {
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
export function sampleEffectiveColor(key: string): string | null {
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

