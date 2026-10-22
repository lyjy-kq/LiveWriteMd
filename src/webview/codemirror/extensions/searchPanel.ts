/**
 * 搜索 / 替换面板：打开命令、快捷键、中文词条与视觉重设计。
 *
 * CodeMirror 自带的搜索面板（@codemirror/search）DOM 是「一条通栏 + 英文文字
 * 按钮 + 三个复选框」，观感与 VS Code 原生查找控件差距较大。这里不重写面板
 * 逻辑（检索、高亮、正则、历史 datalist 全部沿用官方实现），只做三件事：
 *
 * 1. openFindPanel / openReplacePanel 两个命令：
 *    - Ctrl+F 打开面板并收起「替换行」、聚焦查找框；
 *    - Ctrl+H 打开面板并展开「替换行」、聚焦替换框；
 *    - 面板已打开时再按快捷键只切换形态 / 焦点，不重建面板。
 * 2. searchPanelPhrases：把面板里的英文文案翻成中文（CM 的 phrase 机制，
 *    同时作用于可见文字与 aria-label）。
 * 3. searchPanelTheme：把通栏重排为一张圆角悬浮卡片——图标按钮、
 *    Aa / ab| / .* 三枚开关 chip、两行布局，颜色全部取 VS Code 主题变量，
 *    深浅色主题自动适配。
 *
 * 面板 DOM 结构（CM 6.7.x，扁平结构，靠 <br> 分行）：
 *   .cm-panel.cm-search
 *     input[name=search] .cm-textfield
 *     button[name=next] / [prev] / [select] .cm-button
 *     label > input[type=checkbox][name=case]
 *     label > input[type=checkbox][name=re]
 *     label > input[type=checkbox][name=word]
 *     br                      （仅可编辑状态下存在）
 *     input[name=replace] .cm-textfield
 *     button[name=replace] / [replaceAll] .cm-button
 *     button[name=close]      （无 .cm-button 类）
 *
 * @module webview/codemirror/extensions/searchPanel
 */

import type { Extension } from '@codemirror/state';
import { EditorView, type KeyBinding } from '@codemirror/view';
import { openSearchPanel } from '@codemirror/search';

/** 面板展开替换行时挂在 .cm-search 上的类；不带这个类时替换行整体隐藏。 */
export const REPLACE_MODE_CLASS = 'cm-search-mode-replace';

/**
 * 面板内搜索面板的中文文案。
 *
 * CM 通过 view.state.phrase(...) 查这个表；查不到的英文原文原样保留。
 * 即使某些文字被 CSS 用图标替代（如下一个 / 上一个），对应的 aria-label
 * 也会吃到这里的翻译，屏幕阅读器读到的仍是中文。
 */
export const searchPanelPhrases: Record<string, string> = {
    Find: '查找',
    Replace: '替换',
    next: '下一个匹配',
    previous: '上一个匹配',
    all: '全选匹配',
    'match case': '区分大小写',
    regexp: '正则表达式',
    'by word': '全词匹配',
    replace: '替换',
    'replace all': '全部替换',
    close: '关闭',
    // 以下两条只用于 aria 播报，肉眼不可见
    'current match': '当前匹配',
    'on line': '位于第',
};

/**
 * 在面板出现后找到它的根节点。
 *
 * openSearchPanel 内部是一次 dispatch，dispatch 返回时面板 DOM 已经
 * 同步挂载完成，所以命令里直接 querySelector 即可拿到。
 *
 * @param view - 当前编辑器视图
 * @returns 搜索面板根节点；面板不存在时返回 null
 */
function getSearchPanel(view: EditorView): HTMLElement | null {
    return view.dom.querySelector<HTMLElement>('.cm-panel.cm-search');
}

/**
 * 打开「查找」面板：隐藏替换行并聚焦查找框。
 *
 * 面板若处于替换形态，按 Ctrl+F 会收回替换行，回到单行查找控件
 * （与需求里两个快捷键分别唤起两个面板的语义一致）。
 *
 * @param view - 当前编辑器视图
 * @returns 始终返回 true 表示事件已被消费
 */
export function openFindPanel(view: EditorView): boolean {
    openSearchPanel(view);

    const panel = getSearchPanel(view);
    if (!panel) {
        return true;
    }

    panel.classList.remove(REPLACE_MODE_CLASS);

    const searchInput = panel.querySelector<HTMLInputElement>('input[name="search"]');
    if (searchInput) {
        searchInput.focus();
        searchInput.select();
    }
    return true;
}

/**
 * 打开「替换」面板：展开替换行并聚焦替换框。
 *
 * 只读（Viewer）模式下面板里根本没有替换控件，此时退化为普通查找，
 * 避免快捷键看起来「没反应」。
 *
 * @param view - 当前编辑器视图
 * @returns 始终返回 true 表示事件已被消费
 */
export function openReplacePanel(view: EditorView): boolean {
    openSearchPanel(view);

    const panel = getSearchPanel(view);
    if (!panel) {
        return true;
    }

    const replaceInput = panel.querySelector<HTMLInputElement>('input[name="replace"]');
    if (replaceInput) {
        panel.classList.add(REPLACE_MODE_CLASS);
        replaceInput.focus();
        replaceInput.select();
    } else {
        // 只读模式没有替换行：退回查找形态
        panel.classList.remove(REPLACE_MODE_CLASS);
        panel.querySelector<HTMLInputElement>('input[name="search"]')?.focus();
    }
    return true;
}

/**
 * 搜索 / 替换面板快捷键。
 *
 * scope 写成 'editor search-panel' 是 CM 的约定：带这个 scope 的绑定
 * 会同时注册到「正文编辑」和「面板输入框」两个作用域，所以面板打开后
 * 焦点在输入框里时 Ctrl+F / Ctrl+H 依然能切换形态。
 *
 * 注意 Mod-g（查找下一个）属于 searchKeymap，不能与它抢；
 * 这里只管 Ctrl+F 与 Ctrl+H。
 */
export const searchPanelKeymap: readonly KeyBinding[] = [
    {
        key: 'Mod-f',
        run: openFindPanel,
        scope: 'editor search-panel',
        preventDefault: true,
    },
    {
        key: 'Mod-h',
        run: openReplacePanel,
        scope: 'editor search-panel',
        preventDefault: true,
    },
];

/**
 * 搜索 / 替换面板的视觉重设计主题。
 *
 * 布局思路：
 * - 外层 .cm-panels 变透明、留 8px 外边距，让 .cm-search 成为卡片；
 * - 卡片用 flex + flex-wrap，<br> 在替换形态下充当 100% 宽的换行占位，
 *   查找形态下直接 display:none，整份控件只剩一行；
 * - 上一个 / 下一个 / 关闭用 24×24 幽灵图标按钮；
 *   全选 / 替换 / 全部替换保留中文文字（phrase 已翻译），做成轻量文字按钮；
 * - 三个复选框收进 label  chip：原生 input 透明铺满，::before 画
 *   Aa / ab| / .* 三个符号，:checked 时用 VS Code 的 activeOption 变量。
 */
export const searchPanelStyleSpec: Record<string, Record<string, string | number>> = {
    // ---- 面板外层容器：去通栏底色，只负责给卡片留边距 ----
    '.cm-panels': {
        backgroundColor: 'transparent',
        color: 'var(--vscode-editorWidget-foreground, var(--vscode-foreground, #cccccc))',
        border: 'none',
        padding: '8px 10px',
        fontFamily: 'inherit',
        fontSize: '12px',
    },
    // CM 基础主题给 top/bottom 容器画了一条分隔线，卡片形态下不需要。
    // 选择器写成两个类叠加以压过基础主题 &light .cm-panels-top 的优先级。
    '.cm-panels.cm-panels-top': {
        borderBottom: 'none',
    },
    '.cm-panels.cm-panels-bottom': {
        borderTop: 'none',
    },

    // ---- 面板内通用输入框 / 按钮（gotoLine 等其它对话框也吃到） ----
    '.cm-panels .cm-textfield': {
        height: '24px',
        boxSizing: 'border-box',
        backgroundColor: 'var(--vscode-input-background, rgba(255, 255, 255, 0.04))',
        color: 'var(--vscode-input-foreground, inherit)',
        border: '1px solid var(--vscode-input-border, transparent)',
        borderRadius: '3px',
        padding: '0 8px',
        fontSize: '12px',
        outline: 'none',
    },
    '.cm-panels .cm-textfield::placeholder': {
        color: 'var(--vscode-input-placeholderForeground, rgba(128, 128, 128, 0.5))',
    },
    '.cm-panels .cm-textfield:focus': {
        borderColor: 'var(--vscode-focusBorder, #007fd4)',
        outline: 'none',
    },
    '.cm-panels .cm-button': {
        height: '24px',
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'var(--vscode-button-background, #0e639c)',
        color: 'var(--vscode-button-foreground, #ffffff)',
        border: 'none',
        borderRadius: '3px',
        padding: '0 10px',
        fontSize: '12px',
        cursor: 'pointer',
    },
    '.cm-panels .cm-button:hover': {
        backgroundColor: 'var(--vscode-button-hoverBackground, #1177bb)',
    },

    // ---- 搜索卡片本体 ----
    // 注意：CM 搜索基础主题的选择器是 `.cm-panel.cm-search ...`，特异性不低，
    // 这里所有规则都带上 `.cm-panel.cm-search` 前缀，保证顺序在后且不丢特异性。
    '.cm-panel.cm-search': {
        position: 'relative' as any,
        display: 'flex',
        flexWrap: 'wrap' as any,
        alignItems: 'center',
        gap: '2px',
        width: 'fit-content',
        maxWidth: '100%',
        padding: '4px 30px 4px 4px',
        backgroundColor: 'var(--vscode-editorWidget-background, #252526)',
        color: 'var(--vscode-foreground, #cccccc)',
        border: '1px solid var(--vscode-editorWidget-border, #454545)',
        borderRadius: '6px',
        boxShadow: '0 2px 10px rgba(0, 0, 0, 0.28)',
    },
    // 基础主题给 input / button / label 都加了 .2em .6em 的右外边距，
    // 卡片里统一用 gap 控制间距，先整体清零（元素选择器，特异性对齐基础主题）。
    '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': {
        margin: '0',
    },

    // 查找框 / 替换框：固定基准宽度，容器变窄时允许收缩
    '.cm-panel.cm-search input[name="search"], .cm-panel.cm-search input[name="replace"]': {
        width: '180px',
        flex: '0 1 180px',
        minWidth: '110px',
        margin: '0 2px',
    },

    // ---- 图标按钮：上一个 / 下一个 ----
    '.cm-panel.cm-search .cm-button[name="next"], .cm-panel.cm-search .cm-button[name="prev"]':
        {
            width: '24px',
            minWidth: '24px',
            padding: '0',
            backgroundColor: 'transparent',
            color: 'var(--vscode-foreground, #cccccc)',
            borderRadius: '4px',
            // 隐藏中文原文（phrase 已翻译），改用 ::before 画箭头；
            // 原文仍留在无障碍树里，屏幕阅读器读到的是「上一个匹配」
            fontSize: '0',
        },
    '.cm-panel.cm-search .cm-button[name="next"]:hover, .cm-panel.cm-search .cm-button[name="prev"]:hover':
        {
            backgroundColor: 'var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.25))',
        },
    '.cm-panel.cm-search .cm-button[name="next"]:active, .cm-panel.cm-search .cm-button[name="prev"]:active':
        {
            backgroundColor: 'var(--vscode-toolbar-activeBackground, rgba(128, 128, 128, 0.4))',
        },
    '.cm-panel.cm-search .cm-button[name="next"]::before': {
        content: '"↓"',
        fontSize: '13px',
        lineHeight: '1',
    },
    '.cm-panel.cm-search .cm-button[name="prev"]::before': {
        content: '"↑"',
        fontSize: '13px',
        lineHeight: '1',
    },

    // ---- 文字按钮：全选匹配 / 替换 / 全部替换（幽灵风格） ----
    '.cm-panel.cm-search .cm-button[name="select"], .cm-panel.cm-search .cm-button[name="replace"], .cm-panel.cm-search .cm-button[name="replaceAll"]':
        {
            padding: '0 8px',
            backgroundColor: 'transparent',
            color: 'var(--vscode-foreground, #cccccc)',
            borderRadius: '4px',
            whiteSpace: 'nowrap' as any,
        },
    '.cm-panel.cm-search .cm-button[name="select"]:hover, .cm-panel.cm-search .cm-button[name="replace"]:hover, .cm-panel.cm-search .cm-button[name="replaceAll"]:hover':
        {
            backgroundColor: 'var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.25))',
        },
    '.cm-panel.cm-search .cm-button[name="select"]:active, .cm-panel.cm-search .cm-button[name="replace"]:active, .cm-panel.cm-search .cm-button[name="replaceAll"]:active':
        {
            backgroundColor:
                'var(--vscode-toolbar-activeBackground, rgba(128, 128, 128, 0.4))',
        },

    // ---- 三枚选项 chip：区分大小写 / 全词匹配 / 正则 ----
    '.cm-panel.cm-search label': {
        position: 'relative' as any,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '24px',
        height: '24px',
        padding: '0',
        borderRadius: '4px',
        color: 'var(--vscode-foreground, #cccccc)',
        whiteSpace: 'nowrap' as any,
        // label 里的中文说明（区分大小写等）不再需要，chip 符号由 ::before 承担
        fontSize: '0',
        cursor: 'pointer',
    },
    '.cm-panel.cm-search label:hover': {
        backgroundColor: 'var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.25))',
    },
    // 原生复选框透明铺满整个 chip，点击 / 键盘空格行为全部沿用原生
    '.cm-panel.cm-search label input[type="checkbox"]': {
        position: 'absolute' as any,
        inset: '0',
        width: '100%',
        height: '100%',
        margin: '0',
        appearance: 'none',
        opacity: '0',
        cursor: 'pointer',
    },
    '.cm-panel.cm-search label::before': {
        fontSize: '12px',
        lineHeight: '1',
        pointerEvents: 'none' as any,
    },
    '.cm-panel.cm-search label:has(input[name="case"])::before': {
        content: '"Aa"',
        fontSize: '11px',
        fontWeight: '600',
    },
    '.cm-panel.cm-search label:has(input[name="word"])::before': {
        content: '"ab|"',
        fontSize: '10px',
        letterSpacing: '-0.5px',
    },
    '.cm-panel.cm-search label:has(input[name="re"])::before': {
        content: '".*"',
        fontSize: '12px',
        fontFamily: 'var(--vscode-editor-font-family, Consolas, "Courier New", monospace)',
    },
    // DOM 顺序是 case / re / word，VS Code 习惯是 Aa / ab| / .*，用 order 调一下
    '.cm-panel.cm-search label:has(input[name="word"])': {
        order: 2,
    },
    '.cm-panel.cm-search label:has(input[name="re"])': {
        order: 3,
    },
    // 选中态：VS Code inputOption 三色变量
    '.cm-panel.cm-search label:has(input:checked)': {
        backgroundColor: 'var(--vscode-inputOption-activeBackground, rgba(0, 127, 212, 0.4))',
        color: 'var(--vscode-inputOption-activeForeground, #ffffff)',
        boxShadow: 'inset 0 0 0 1px var(--vscode-inputOption-activeBorder, transparent)',
    },
    // 键盘聚焦时画焦点环（鼠标点击不显示）
    '.cm-panel.cm-search label:has(input:focus-visible)': {
        outline: '1px solid var(--vscode-focusBorder, #007fd4)',
        outlineOffset: '-1px',
    },

    // ---- 匹配计数（由 searchMatchCount 插件插到查找框后面） ----
    '.cm-panel.cm-search .cm-search-match-count': {
        minWidth: '48px',
        padding: '0 4px',
        textAlign: 'center' as any,
        fontSize: '11px',
        lineHeight: '20px',
        color: 'var(--vscode-descriptionForeground, #989898)',
        whiteSpace: 'nowrap' as any,
        userSelect: 'none' as any,
    },
    '.cm-panel.cm-search .cm-search-match-count-none': {
        color: 'var(--vscode-errorForeground, #f48771)',
    },

    // ---- 关闭按钮：右上角 24×24 幽灵图标 ----
    '.cm-panel.cm-search button[name="close"]': {
        position: 'absolute' as any,
        top: '4px',
        right: '4px',
        width: '24px',
        height: '24px',
        padding: '0',
        backgroundColor: 'transparent',
        color: 'inherit',
        border: 'none',
        borderRadius: '4px',
        fontSize: '15px',
        lineHeight: '1',
        cursor: 'pointer',
    },
    '.cm-panel.cm-search button[name="close"]:hover': {
        backgroundColor: 'var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.25))',
    },

    // ---- 替换行的显隐 ----
    // 查找形态（默认）：<br>、替换框和两个替换按钮全部不占位。
    '.cm-panel.cm-search:not(.cm-search-mode-replace) br, .cm-panel.cm-search:not(.cm-search-mode-replace) input[name="replace"], .cm-panel.cm-search:not(.cm-search-mode-replace) button[name="replace"], .cm-panel.cm-search:not(.cm-search-mode-replace) button[name="replaceAll"]':
        {
            display: 'none',
        },
    // 替换形态：<br> 变成 100% 宽、4px 高的换行占位，既把替换行折到下一行，
    // 又顺带充当两行之间的垂直间距。
    // order 必须排在三枚 chip（case=0 / word=2 / re=3）之后，
    // 否则 word / re 会被默认 DOM 顺序带到第二行；
    // 替换行三个控件统一 order:11，落在换行占位（10）之后。
    '.cm-panel.cm-search.cm-search-mode-replace br': {
        order: 10,
        flexBasis: '100%',
        width: '0',
        height: '4px',
        margin: '0',
        padding: '0',
        border: '0',
        overflow: 'hidden',
    },
    '.cm-panel.cm-search.cm-search-mode-replace input[name="replace"], .cm-panel.cm-search.cm-search-mode-replace button[name="replace"], .cm-panel.cm-search.cm-search-mode-replace button[name="replaceAll"]':
        {
            order: 11,
        },
    // 替换框在第二行吃满剩余宽度，使两行右缘大致对齐
    '.cm-panel.cm-search.cm-search-mode-replace input[name="replace"]': {
        flex: '1 1 180px',
    },

    // ---- 面板自身被 Tab 聚焦时不要画默认轮廓 ----
    '.cm-panel.cm-search:focus': {
        outline: 'none',
    },
};

/**
 * live 搜索面板的样式扩展（只作用于 CodeMirror 自己的面板 DOM）。
 */
export const searchPanelTheme: Extension = EditorView.theme(searchPanelStyleSpec);

/** camelCase → kebab-case（CSS 自定义属性 --x 原样保留）。 */
function toKebabCase(name: string): string {
    if (name.startsWith('--')) return name;
    return name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

/**
 * 把同一份样式规格序列化成普通 CSS 文本。
 *
 * CodeMirror 的 `EditorView.theme` 只能把样式挂进编辑器自己的 DOM 作用域，
 * 导图模式的搜索条不在编辑器里，没法直接吃到那份主题。这里用同一份
 * spec 生成 CSS 文本，由导图侧注入到 document —— 两个搜索界面的视觉
 * 永远同源，改一处两边同步，不会出现「live 改了、导图忘改」的漂移。
 *
 * 约定：spec 是扁平的「选择器 → 声明对象」，支持嵌套选择器与
 * 伪类（当前实现只用到了这两类），不支持 `&` 占位符。
 *
 * @returns 可直接写进 `<style>` 的 CSS 文本
 */
export function searchPanelCss(): string {
    const blocks: string[] = [];
    for (const [selector, declarations] of Object.entries(searchPanelStyleSpec)) {
        const lines: string[] = [];
        for (const [property, value] of Object.entries(declarations)) {
            if (value === null || value === undefined) continue;
            lines.push(`    ${toKebabCase(property)}: ${value};`);
        }
        blocks.push(`${selector} {\n${lines.join('\n')}\n}`);
    }
    return blocks.join('\n');
}
