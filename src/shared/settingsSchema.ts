/**
 * FlowMD 设置 Schema —— 设置功能的单一数据源。
 *
 * 这个文件以**声明式**描述所有可配置项：分在哪个组、用什么控件、
 * 默认值、取值范围、可选项。三处都依赖它：
 *
 * 1. 设置面板（webview/SettingsPanel）据此渲染开关 / 滑块 / 取色器 / 下拉；
 * 2. 扩展侧 ConfigManager.getAllSettings 据此批量读取 VS Code 配置；
 * 3. package.json contributes.configuration 的 properties 与这里的 key / 默认值对齐。
 *
 * ## 默认值约定（重要）
 *
 * - 颜色项默认一律是空串 `""`，语义是「**自动 / 跟随明暗主题**」。
 *   留空时不注入对应 CSS 变量，渲染沿用内置主题默认色（明 / 暗各自的现状），
 *   因此**默认外观与解耦前完全一致**；用户选了颜色才全局覆盖，可一键重置回自动。
 * - 开关 / 滑块 / 下拉的默认值 = 当前产品里正在使用的预设值（「把当前设置作为默认」）。
 *
 * @module shared/settingsSchema
 */

/** 设置值的联合类型。 */
export type SettingValue = boolean | number | string;

/** 控件种类。 */
export type SettingControl =
    | 'toggle'
    | 'slider'
    | 'color'
    | 'select'
    | 'text';

/** 下拉选项。 */
export interface SettingOption {
    /** 存入配置的值。 */
    value: string;
    /** 界面显示名。 */
    label: string;
}

/** 单个设置项的声明。 */
export interface SettingItem {
    /** 配置键（不含 `flowMd.` 前缀）。 */
    key: string;
    /** 界面显示名。 */
    label: string;
    /** 帮助说明，显示在名称下方。 */
    description?: string;
    /** 控件类型。 */
    control: SettingControl;
    /** 默认值。 */
    default: SettingValue;
    /** 滑块 / 数值下限。 */
    min?: number;
    /** 滑块 / 数值上限。 */
    max?: number;
    /** 滑块步长。 */
    step?: number;
    /** 滑块单位（如 px / %），仅用于显示。 */
    unit?: string;
    /** 下拉可选项。 */
    options?: SettingOption[];
    /** 文本输入占位提示。 */
    placeholder?: string;
    /**
     * 滑块在某个特殊值时显示的文字（如 readableLineLength=0 显示「不限」）。
     */
    valueLabels?: Array<{ value: number; label: string }>;
}

/** 设置分组。 */
export interface SettingSection {
    /** 分组标识。 */
    id: string;
    /** 分组显示名。 */
    label: string;
    /** 分组图标（一个 emoji 或字符）。 */
    icon: string;
    /** 组内设置项。 */
    items: SettingItem[];
}

// =============================================================================
// Schema 定义
// =============================================================================

export const SETTINGS_SCHEMA: SettingSection[] = [
    {
        id: 'general',
        label: '通用',
        icon: '⚙️',
        items: [
            {
                key: 'defaultMode',
                label: '默认打开模式',
                description: '打开 Markdown 文件时进入的模式。',
                control: 'select',
                default: 'live',
                options: [
                    { value: 'live', label: '实时预览（边写边渲染）' },
                    { value: 'source', label: '源码（只看 Markdown 原文）' },
                    { value: 'viewer', label: '阅读（只读渲染视图）' },
                ],
            },
            {
                key: 'modeSwitcher',
                label: '标题栏模式切换样式',
                control: 'select',
                default: 'cycle',
                options: [
                    { value: 'cycle', label: '循环（单按钮轮流切换）' },
                    { value: 'buttons', label: '按钮（直达另外两种模式）' },
                ],
            },
            {
                key: 'rememberLastMode',
                label: '记住每个文件的模式',
                description:
                    '开启后重新打开同一文件时回到上次使用的模式，而不是统一用「默认打开模式」。',
                control: 'toggle',
                default: true,
            },
            {
                key: 'smartUrlPaste',
                label: '粘贴网址自动转链接',
                description: '粘贴单独的 URL 时自动包裹成 Markdown 链接文字。',
                control: 'toggle',
                default: true,
            },
        ],
    },
    {
        id: 'editor',
        label: '编辑器',
        icon: '📝',
        items: [
            {
                key: 'lineNumbers',
                label: '显示行号',
                control: 'toggle',
                default: true,
            },
            {
                key: 'wordWrap',
                label: '自动换行',
                description: '长行按正文宽度折行，而不是横向滚动。',
                control: 'toggle',
                default: true,
            },
            {
                key: 'readableLineLength',
                label: '正文最大宽度',
                description: '超过此宽度后正文居中、两侧留白。设为 0 则不限制。',
                control: 'slider',
                default: 900,
                min: 0,
                max: 1600,
                step: 10,
                unit: 'px',
                valueLabels: [{ value: 0, label: '不限' }],
            },
            {
                key: 'fontScale',
                label: '正文字号缩放',
                description: '也可在编辑器里按 Ctrl/Cmd + 滚轮调整。',
                control: 'slider',
                default: 1,
                min: 0.5,
                max: 1.6,
                step: 0.05,
                valueLabels: [{ value: 1, label: '标准' }],
            },
            {
                key: 'highlightActiveLine',
                label: '高亮当前行',
                description: '光标所在行加上淡背景。',
                control: 'toggle',
                default: true,
            },
            {
                key: 'highlightWhitespace',
                label: '显示空白字符',
                description: '把空格 / 制表符用淡点标记出来。',
                control: 'toggle',
                default: false,
            },
        ],
    },
    {
        id: 'text',
        label: '标题与文字',
        icon: '🎨',
        items: [
            {
                key: 'h1Color',
                label: '一级标题颜色',
                control: 'color',
                default: '',
            },
            {
                key: 'h2Color',
                label: '二级标题颜色',
                control: 'color',
                default: '',
            },
            {
                key: 'h3Color',
                label: '三级标题颜色',
                control: 'color',
                default: '',
            },
            {
                key: 'h4Color',
                label: '四级标题颜色',
                control: 'color',
                default: '',
            },
            {
                key: 'h5Color',
                label: '五级标题颜色',
                control: 'color',
                default: '',
            },
            {
                key: 'h6Color',
                label: '六级标题颜色',
                control: 'color',
                default: '',
            },
            {
                key: 'h1Size',
                label: '一级标题字号',
                description: '相对于正文的字号倍率。',
                control: 'slider',
                default: 1.2,
                min: 0.9,
                max: 2,
                step: 0.01,
            },
            {
                key: 'boldColor',
                label: '加粗颜色',
                control: 'color',
                default: '',
            },
            {
                key: 'italicColor',
                label: '斜体颜色',
                control: 'color',
                default: '',
            },
            {
                key: 'italicSlant',
                label: '斜体真倾斜',
                description:
                    '关闭（默认）时斜体只以颜色区分、字形不倾斜；开启后使用真斜体字形。',
                control: 'toggle',
                default: false,
            },
            {
                key: 'strikethroughColor',
                label: '删除线颜色',
                control: 'color',
                default: '',
            },
        ],
    },
    {
        id: 'code',
        label: '代码',
        icon: '💻',
        items: [
            {
                key: 'inlineCodeColor',
                label: '行内代码文字色',
                control: 'color',
                default: '',
            },
            {
                key: 'inlineCodeBackground',
                label: '行内代码底色',
                control: 'color',
                default: '',
            },
            {
                key: 'inlineCodeScale',
                label: '行内代码字号',
                description: '相对于正文的字号倍率（默认略小一点）。',
                control: 'slider',
                default: 0.95,
                min: 0.8,
                max: 1.05,
                step: 0.01,
            },
            {
                key: 'codeblockBackground',
                label: '代码块底色',
                description: '留空则跟随 VS Code 主题。',
                control: 'color',
                default: '',
            },
            {
                key: 'codeblockEdge',
                label: '代码块边线色',
                description: '留空则跟随 VS Code 主题。',
                control: 'color',
                default: '',
            },
        ],
    },
    {
        id: 'link',
        label: '链接与引用',
        icon: '🔗',
        items: [
            {
                key: 'linkColor',
                label: '链接颜色',
                control: 'color',
                default: '',
            },
            {
                key: 'quoteBorderColor',
                label: '引用竖线颜色',
                control: 'color',
                default: '',
            },
            {
                key: 'quoteTextColor',
                label: '引用文字颜色',
                control: 'color',
                default: '',
            },
            {
                key: 'hrColor',
                label: '分隔线颜色',
                control: 'color',
                default: '',
            },
        ],
    },
    {
        id: 'table',
        label: '表格',
        icon: '📊',
        items: [
            {
                key: 'tableBorderColor',
                label: '表格边框颜色',
                control: 'color',
                default: '',
            },
            {
                key: 'tableHeaderBackground',
                label: '表头底色',
                control: 'color',
                default: '',
            },
            {
                key: 'tableStripeBackground',
                label: '斑马纹底色',
                description:
                    '为偶数数据行加底色；留空（默认）则不显示斑马纹。',
                control: 'color',
                default: '',
            },
            {
                key: 'tableSelectedBackground',
                label: '选中格子高亮色',
                control: 'color',
                default: '',
            },
        ],
    },
    {
        id: 'list',
        label: '列表与复选框',
        icon: '✅',
        items: [
            {
                key: 'bulletColor',
                label: '列表圆点颜色',
                control: 'color',
                default: '',
            },
            {
                key: 'checkboxAccent',
                label: '复选框强调色',
                control: 'color',
                default: '',
            },
        ],
    },
    {
        id: 'outline',
        label: '大纲',
        icon: '🗂️',
        items: [
            {
                key: 'outlineAutoOpen',
                label: '打开文件时展开大纲',
                control: 'toggle',
                default: false,
            },
            {
                key: 'outlineWidth',
                label: '大纲默认宽度',
                control: 'slider',
                default: 280,
                min: 220,
                max: 480,
                step: 4,
                unit: 'px',
            },
            {
                key: 'outlineGuides',
                label: '显示大纲缩进引导线',
                control: 'toggle',
                default: true,
            },
        ],
    },
    {
        id: 'media',
        label: '图片与媒体',
        icon: '🖼️',
        items: [
            {
                key: 'imageSaveFolder',
                label: '图片保存目录',
                description: '拖拽 / 粘贴的图片相对当前 Markdown 所在目录存放。',
                control: 'text',
                default: 'assets',
                placeholder: 'assets',
            },
            {
                key: 'mediaWidth',
                label: '媒体默认宽度',
                description: '图片 / Mermaid 初始占正文宽度的百分比。',
                control: 'slider',
                default: 75,
                min: 20,
                max: 100,
                step: 1,
                unit: '%',
            },
            {
                key: 'mediaCenter',
                label: '独占一行的媒体居中',
                control: 'toggle',
                default: true,
            },
        ],
    },
    {
        id: 'advanced',
        label: '高级',
        icon: '🧩',
        items: [
            {
                key: 'theme',
                label: '主题',
                description: '设为自动时跟随 VS Code 当前主题。',
                control: 'select',
                default: 'auto',
                options: [
                    { value: 'auto', label: '自动（跟随 VS Code）' },
                    { value: 'dark', label: '深色' },
                    { value: 'light', label: '浅色' },
                ],
            },
            {
                key: 'syncDebounceMs',
                label: '同步防抖时间',
                description: 'Webview 与文档同步前的等待毫秒数，打字快时可适当调大。',
                control: 'slider',
                default: 300,
                min: 50,
                max: 2000,
                step: 50,
                unit: 'ms',
            },
            {
                key: 'dragThreshold',
                label: '拖拽判定距离',
                description: '鼠标移动超过多少像素才视为「拖选」并展开整行。',
                control: 'slider',
                default: 4,
                min: 2,
                max: 15,
                step: 1,
                unit: 'px',
            },
            {
                key: 'doubleClickPin',
                label: '双击钉住源码态',
                description: '关闭后双击不再钉住整行的源码显示。',
                control: 'toggle',
                default: true,
            },
            {
                key: 'largeFileWarningThreshold',
                label: '大文件警告阈值',
                description: '单位字节，0 表示关闭警告。',
                control: 'text',
                default: 1048576,
                placeholder: '1048576',
            },
            {
                key: 'pdfBrowserPath',
                label: 'PDF 导出浏览器路径',
                description: '导出 PDF 所用 Edge/Chrome 可执行文件，留空自动探测。',
                control: 'text',
                default: '',
                placeholder: '留空自动探测',
            },
            {
                key: 'enableDebugLog',
                label: '启用调试日志',
                description: '详细日志输出到「输出」面板的 FlowMD 通道。',
                control: 'toggle',
                default: false,
            },
        ],
    },
];

// =============================================================================
// 工具函数
// =============================================================================

/** 全部设置项（扁平），按 schema 顺序。 */
export const ALL_SETTING_ITEMS: SettingItem[] = SETTINGS_SCHEMA.flatMap(
    (section) => section.items
);

/** key -> SettingItem 查找表。 */
const ITEM_BY_KEY: Map<string, SettingItem> = new Map(
    ALL_SETTING_ITEMS.map((item) => [item.key, item])
);

/**
 * 按配置键查设置项声明。
 *
 * @param key - 配置键（不含 flowMd.）
 * @returns 设置项；未登记时 undefined
 */
export function getSettingItem(key: string): SettingItem | undefined {
    return ITEM_BY_KEY.get(key);
}

/**
 * 收集「key -> 默认值」。
 *
 * @returns 以配置键为键、默认值为值的对象
 */
export function getDefaultSettings(): Record<string, SettingValue> {
    const result: Record<string, SettingValue> = {};
    for (const item of ALL_SETTING_ITEMS) result[item.key] = item.default;
    return result;
}
