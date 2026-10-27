/**
 * 共享 token 色表（todo.md 任务 3）。
 *
 * 原来代码块语法高亮的颜色写死在 decorations.ts 的两个 HighlightStyle
 * （深/浅各一份，CM 私有格式：tag → 颜色字面值）。为了让 mini-CM（导图节点）
 * 与静态渲染（@lezer/highlight 的 classHighlighter，输出 tok-* 类）也能用
 * 同一套颜色，这里把颜色抽成**单一数据源 + 静态 CSS 变量表**：
 *
 * - `TOKEN_COLOR_DEFS`：每个 token 一条记录（CSS 变量名 / lezer tag / 深色值 / 浅色值）；
 * - `liveWriteMdTokenHighlight`：由表生成的**单个** HighlightStyle，颜色全部
 *   是 `var(--lwm-tok-*)` 引用 —— 深浅色切换不再靠 CM 的 themeType 重配，
 *   CSS 变量随 body 的 `vscode-light` 类自动翻转；
 * - `ensureTokenColorCss()`：把变量表（含静态渲染用的 `.tok-*` 规则）幂等
 *   注入 document，live 编辑器与导图各自调用一次即可。
 *
 * @module webview/codemirror/extensions/livePreview/tokenColors
 */

import { HighlightStyle } from '@codemirror/language';
import { tags, type Tag } from '@lezer/highlight';

/**
 * 一条 token 颜色定义。
 */
interface TokenColorDef {
    /** CSS 变量名后缀：`--lwm-tok-<name>`。 */
    name: string;
    /** CM HighlightStyle 用的 lezer tag（可带 definition/function 修饰）。 */
    tag: Tag;
    /** 深色主题色值。 */
    dark: string;
    /** 浅色主题色值。 */
    light: string;
    /** 静态渲染（classHighlighter）对应的 tok-* 类选择器，缺省不生成静态规则。 */
    staticSelector?: string;
}

/**
 * token 颜色总表（单一数据源）。
 *
 * 色值沿用原 decorations.ts 的深/浅两份 HighlightStyle；同色的合并成一条
 * （如 null/self 与 bool 同色，共用 --lwm-tok-bool）。
 */
const TOKEN_COLOR_DEFS: TokenColorDef[] = [
    {
        name: 'keyword',
        tag: tags.keyword,
        dark: '#af00db',
        light: '#af00db',
        staticSelector: '.tok-keyword',
    },
    {
        name: 'operator',
        tag: tags.operator,
        // 深色下标点必须是浅色：HighlightStyle 全局生效，正文 markdown 的
        // ListMark（"-"）也带 punctuation tag，黑色会看不见
        dark: '#d4d4d4',
        light: '#000000',
        staticSelector: '.tok-operator',
    },
    {
        name: 'punctuation',
        tag: tags.punctuation,
        dark: '#d4d4d4',
        light: '#000000',
        staticSelector: '.tok-punctuation',
    },
    {
        name: 'bracket',
        tag: tags.bracket,
        dark: '#d4d4d4',
        light: '#0431fa',
    },
    {
        name: 'string',
        tag: tags.string,
        dark: '#ce9178',
        light: '#a31515',
        staticSelector: '.tok-string',
    },
    {
        name: 'number',
        tag: tags.number,
        dark: '#b5cea8',
        light: '#098658',
        staticSelector: '.tok-number',
    },
    {
        name: 'bool',
        // bool / null / self 三色同源（深浅都一样）
        tag: [tags.bool, tags.null, tags.self] as unknown as Tag,
        dark: '#569cd6',
        light: '#0000ff',
        staticSelector: '.tok-bool',
    },
    {
        name: 'comment',
        tag: tags.comment,
        dark: '#6a9955',
        light: '#5f6a79',
        staticSelector: '.tok-comment',
    },
    {
        name: 'variableName',
        tag: tags.variableName,
        dark: '#9cdcfe',
        light: '#001080',
        staticSelector: '.tok-variableName',
    },
    {
        name: 'variableDefinition',
        tag: tags.definition(tags.variableName),
        dark: '#4fc1ff',
        light: '#0070c1',
        staticSelector: '.tok-variableName.tok-definition',
    },
    {
        name: 'function',
        // function(variableName) 与 function(propertyName) 同色
        tag: [tags.function(tags.variableName), tags.function(tags.propertyName)] as unknown as Tag,
        dark: '#dcdcaa',
        light: '#795e26',
    },
    {
        name: 'typeName',
        // typeName / className 同色
        tag: [tags.typeName, tags.className] as unknown as Tag,
        dark: '#4ec9b0',
        light: '#267f99',
        staticSelector: '.tok-typeName, .tok-className',
    },
    {
        name: 'propertyName',
        tag: tags.propertyName,
        dark: '#9cdcfe',
        light: '#001080',
        staticSelector: '.tok-propertyName',
    },
    {
        name: 'attributeName',
        tag: tags.attributeName,
        dark: '#9cdcfe',
        light: '#e50000',
    },
    {
        name: 'tagName',
        tag: tags.tagName,
        dark: '#569cd6',
        light: '#800000',
        staticSelector: '.tok-tagName',
    },
    {
        name: 'angleBracket',
        tag: tags.angleBracket,
        dark: '#808080',
        light: '#800000',
    },
    {
        name: 'regexp',
        tag: tags.regexp,
        dark: '#d16969',
        light: '#811f3f',
        staticSelector: '.tok-string2',
    },
    {
        name: 'meta',
        tag: tags.meta,
        dark: '#d4d4d4',
        light: '#000000',
        staticSelector: '.tok-meta',
    },
];

/**
 * 由总表生成的唯一 HighlightStyle：颜色全是 `var(--lwm-tok-*)` 引用，
 * 深浅色靠 CSS 变量翻转，一个实例两种主题通吃（替代原来的
 * liveWriteMdDarkHighlight / liveWriteMdLightHighlight 两个）。
 *
 * 注意：原深色定义里 control/operator/definition/module 四种 keyword
 * 子标签与 keyword 同色 —— tags.keyword 本身是它们的父标签，单条
 * keyword 规则即可全覆盖（tag 继承），无需重复列举。
 */
export const liveWriteMdTokenHighlight = HighlightStyle.define(
    TOKEN_COLOR_DEFS.map((def) => ({
        tag: def.tag,
        color: `var(--lwm-tok-${def.name})`,
    }))
);

/** 注入用 style 元素的 id（幂等判断用）。 */
const TOKEN_COLOR_STYLE_ID = 'lwm-token-colors';

/**
 * 生成 token 变量表的 CSS 文本：
 * - `:root` 下放深色值（应用默认深色系，与 editor.ts 的暗色兜底一致）；
 * - `body.vscode-light` / `body.vscode-high-contrast-light` / 调试页 `html.light`
 *   下放浅色值；
 * - 附带静态渲染（classHighlighter 的 tok-* 类）→ 变量的映射规则，
 *   作用域限定 `.lwm-code-static`，避免影响编辑器里 defaultHighlightStyle
 *   自己的 tok-* 类着色。
 */
function buildTokenColorCss(): string {
    const darkVars = TOKEN_COLOR_DEFS.map(
        (def) => `  --lwm-tok-${def.name}: ${def.dark};`
    ).join('\n');
    const lightVars = TOKEN_COLOR_DEFS.map(
        (def) => `  --lwm-tok-${def.name}: ${def.light};`
    ).join('\n');
    const staticRules = TOKEN_COLOR_DEFS.filter((def) => def.staticSelector)
        .map(
            (def) =>
                `${def.staticSelector!
                    .split(',')
                    .map((sel) => `.lwm-code-static ${sel.trim()}`)
                    .join(',\n')} { color: var(--lwm-tok-${def.name}); }`
        )
        .join('\n');
    return `/* 共享 token 色表（tokenColors.ts，单一数据源，勿手改） */
:root {
${darkVars}
}
body.vscode-light,
body.vscode-high-contrast-light,
html.light body {
${lightVars}
}
${staticRules}
`;
}

/**
 * 幂等注入 token 变量表（live 编辑器与导图各自在初始化时调用一次）。
 */
export function ensureTokenColorCss(): void {
    if (document.getElementById(TOKEN_COLOR_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = TOKEN_COLOR_STYLE_ID;
    style.textContent = buildTokenColorCss();
    document.head.appendChild(style);
}
