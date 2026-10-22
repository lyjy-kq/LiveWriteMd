/**
 * LiveWriteMD 设置 Schema —— 设置功能的单一数据源。
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
    | 'text'
    | 'font';

/** 下拉选项。 */
export interface SettingOption {
    /** 存入配置的值。 */
    value: string;
    /** 界面显示名。 */
    label: string;
}

/** 单个设置项的声明。 */
export interface SettingItem {
    /** 配置键（不含 `liveWriteMd.` 前缀）。 */
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
                    { value: 'mindmap', label: '思维导图（画布式大纲）' },
                ],
            },
            {
                key: 'modeSwitcher',
                label: '标题栏模式切换样式',
                control: 'select',
                default: 'cycle',
                options: [
                    { value: 'cycle', label: '循环（单按钮轮流切换）' },
                    { value: 'buttons', label: '按钮（直达另外三种模式）' },
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
                key: 'lineGutterGap',
                label: '正文与行号线距离',
                description:
                    '正文行最左缘与行号竖线之间的间距。关闭行号后，即为正文与编辑器左边缘的距离。',
                control: 'slider',
                default: 4,
                min: 0,
                max: 24,
                step: 1,
                unit: 'px',
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
                key: 'lineHeightScale',
                label: '行间距倍数',
                description:
                    'Word 式倍行距：在基础行高（VS Code 的 editor.lineHeight，未设置时为 1.7 倍字号）上乘以该倍数。1.0 为单倍行距。',
                control: 'slider',
                default: 1,
                min: 1,
                max: 3,
                step: 0.05,
                unit: 'x',
                valueLabels: [{ value: 1, label: '单倍' }],
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
                key: 'fontFamilyEnglish',
                label: '英文字体',
                description:
                    '英文、数字使用的字体。列表来自本机已安装字体，可直接输入筛选；留空跟随 VS Code 编辑器字体。',
                control: 'font',
                default: '',
                placeholder: '输入字体名筛选，或展开列表选择',
                // options 仅作为「系统字体还没取到」时的兜底候选
                options: [
                    { value: '', label: '跟随 VS Code（默认）' },
                    { value: 'Consolas', label: 'Consolas' },
                    { value: 'Cascadia Code', label: 'Cascadia Code' },
                    { value: 'Cascadia Mono', label: 'Cascadia Mono' },
                    { value: 'JetBrains Mono', label: 'JetBrains Mono' },
                    { value: 'Fira Code', label: 'Fira Code' },
                    { value: 'Source Code Pro', label: 'Source Code Pro' },
                    { value: 'SF Mono', label: 'SF Mono' },
                    { value: 'Menlo', label: 'Menlo' },
                    { value: 'Monaco', label: 'Monaco' },
                    { value: 'Courier New', label: 'Courier New' },
                    { value: 'Segoe UI', label: 'Segoe UI' },
                    { value: 'Arial', label: 'Arial' },
                ],
            },
            {
                key: 'fontFamilyChinese',
                label: '中文字体',
                description:
                    '中文汉字使用的字体。列表来自本机已安装字体，可直接输入筛选；留空跟随系统默认。',
                control: 'font',
                default: '',
                placeholder: '输入字体名筛选，或展开列表选择',
                // options 仅作为「系统字体还没取到」时的兜底候选
                options: [
                    { value: '', label: '跟随系统（默认）' },
                    { value: 'Microsoft YaHei', label: '微软雅黑' },
                    { value: 'Microsoft YaHei UI', label: '微软雅黑 UI' },
                    { value: 'SimSun', label: '宋体' },
                    { value: 'SimHei', label: '黑体' },
                    { value: 'KaiTi', label: '楷体' },
                    { value: 'FangSong', label: '仿宋' },
                    { value: 'DengXian', label: '等线' },
                    { value: 'PingFang SC', label: '苹方（PingFang SC）' },
                    { value: 'Noto Sans SC', label: 'Noto Sans SC' },
                    { value: 'Noto Serif SC', label: 'Noto Serif SC' },
                    { value: 'Source Han Sans SC', label: '思源黑体' },
                    { value: 'HarmonyOS Sans SC', label: 'HarmonyOS Sans' },
                ],
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
                // 和「加粗真加粗」同一思路：默认只用字号 / 颜色区分标题，
                // 字重与正文一致，密集文档里不会满屏粗体；需要传统粗标题时再打开。
                key: 'headingBold',
                label: '标题加粗',
                description:
                    '关闭（默认）时标题与正文同字重，只靠字号和颜色区分层级；开启后一级标题用 700、其余级别用 600。',
                control: 'toggle',
                default: false,
            },
            {
                key: 'boldColor',
                label: '加粗颜色',
                control: 'color',
                default: '',
            },
            {
                // 与「斜体真倾斜」对称：默认只用颜色区分加粗，字重保持正文，
                // 避免密集正文里粗体块太重；需要真粗体时再打开。
                key: 'boldWeight',
                label: '加粗真加粗',
                description:
                    '关闭（默认）时加粗只以颜色区分、字重与正文一致；开启后使用粗体字形。',
                control: 'toggle',
                default: false,
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
                key: 'bulletYOffset',
                label: '圆点垂直位置',
                description:
                    '圆点相对行中心的上下微调：0 为行正中，负值向上、正值向下。',
                control: 'slider',
                default: 0,
                min: -0.3,
                max: 0.3,
                step: 0.01,
                unit: 'em',
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
        id: 'mindmap',
        label: '思维导图',
        icon: '🧠',
        items: [
            {
                key: 'mindmapTheme',
                label: '导图配色',
                description: '设为自动时跟随编辑器当前的明 / 暗主题。',
                control: 'select',
                default: 'auto',
                options: [
                    { value: 'auto', label: '自动（跟随编辑器）' },
                    { value: 'default', label: '默认（经典浅色）' },
                    { value: 'dark', label: '深色' },
                ],
            },
            {
                key: 'mindmapDefaultExpandLevel',
                label: '默认展开层级',
                description: '打开导图时默认展开到第几层，0 = 只显示根节点。',
                control: 'slider',
                default: 2,
                min: 0,
                max: 6,
                step: 1,
                unit: '层',
            },
            {
                key: 'mindmapPerformanceMode',
                label: '性能模式',
                description: '画布可视区域外的节点不渲染，大文档更流畅。',
                control: 'toggle',
                default: true,
            },
            {
                key: 'mindmapDisplayCache',
                label: '显示实例 LRU 淘汰',
                description:
                    '开启后，离屏节点的真实渲染实例最多保留 64 个，超出时把最早创建的降级为纯文本占位，回到视口再重建。关闭（默认）时不淘汰，离屏实例一直保留，来回平移不会重复创建 CodeMirror，代价是内存随节点数增长。',
                control: 'toggle',
                default: false,
            },
            {
                // 影响「文字观感」的旋钮：底色越淡，文字与底色的对比度越高。
                // 实测同一段文字 16% → 0% 时 Laplacian 119 → 133（+12%），
                // 高倍缩放下大字占比更高，观感差别更明显。
                key: 'mindmapNodeWash',
                label: '节点底色浓度',
                description:
                    '节点背景色 = 标题色按该比例混入。比例越低，底色越淡、文字与底色的对比越强，笔画看起来更清晰；0 = 完全透明（只剩边框）。',
                control: 'slider',
                default: 8,
                min: 0,
                max: 40,
                step: 1,
                unit: '%',
            },
            {
                // 高倍缩放时的「阅读增强」：只压底色浓度，不动字形和布局。
                // 这是目前唯一实测能提升高倍下文字观感的旋钮（见 canvas.ts
                // HI_ZOOM_THRESHOLD 的说明：重新排版 / 像素对齐都实测无变化）。
                key: 'mindmapHiZoomContrast',
                label: '高倍缩放增强清晰度',
                description:
                    '缩放超过 150% 时，把节点底色浓度压到原来的 35%，提高文字与底色的对比，大字更清晰；关闭后任何缩放比例都保持统一底色。',
                control: 'toggle',
                default: true,
            },
            {
                // 手势期间默认提升合成层（帧率优先）。打开后不要提升：
                // 文字在拖动/缩放过程中也保持 LCD 次像素抗锯齿并按当前比例
                // 重新栅格化，代价是每帧重绘视口，大文档可能掉帧。
                key: 'mindmapGestureCrisp',
                label: '手势期间保持清晰',
                description:
                    '开启（默认）时，拖动和滚轮缩放期间不提升合成层，文字在运动中也按当前比例重新栅格化、保留次像素抗锯齿；关闭后手势期间临时提升合成层换帧率，运动中的文字是缓存位图（略灰）。实测 60~74 个可见节点时两者帧间隔相同。',
                control: 'toggle',
                default: true,
            },
            {
                key: 'mindmapNodeMaxWidth',
                label: '节点最大宽度',
                description:
                    '文本节点一行最多排几列（1 列 = 1 个中文字宽），超出换行；与「节点最大行数」共同决定截断点。',
                control: 'slider',
                default: 20,
                min: 5,
                max: 60,
                step: 1,
                unit: '列',
            },
            {
                key: 'mindmapNodeMaxLines',
                label: '节点最大行数',
                description:
                    '文本节点最多显示几行，超出部分截断加省略号；点击已选中的节点可先展开到最大行数，再点进入编辑。',
                control: 'slider',
                default: 3,
                min: 1,
                max: 10,
                step: 1,
                unit: '行',
            },
            {
                key: 'mindmapCodeMinWidth',
                label: '代码块最小宽度',
                description:
                    '代码块节点的最小宽度（1 列 = 1 个等宽字符宽），避免短代码的节点过窄；0 = 不设最小宽度。',
                control: 'slider',
                default: 10,
                min: 0,
                max: 60,
                step: 1,
                unit: '列',
            },
            {
                key: 'mindmapLiteEnabled',
                label: '启用降级渲染',
                description:
                    '开启后，缩小到「降级渲染缩放」以下时省掉行内格式、代码高亮、表格 / 公式 / mermaid 图。关闭（默认）时任何缩放比例都保持完整渲染。',
                control: 'toggle',
                default: false,
            },
            {
                key: 'mindmapLiteZoom',
                label: '降级渲染缩放',
                description:
                    '缩放到该比例以下才进入降级渲染。仅在开启「启用降级渲染」后生效。',
                control: 'slider',
                default: 70,
                min: 10,
                max: 100,
                step: 5,
                unit: '%',
            },
            {
                key: 'mindmapPlainEnabled',
                label: '启用纯文本缩放',
                description:
                    '开启后，缩小到「纯文本缩放」以下时节点只用纯文本占位（媒体节点显示摘要），不创建任何 CodeMirror 实例。关闭（默认）时不进入该档。',
                control: 'toggle',
                default: false,
            },
            {
                key: 'mindmapPlainZoom',
                label: '纯文本缩放',
                description:
                    '缩放到该比例以下才进入纯文本档。仅在开启「启用纯文本缩放」后生效；建议不高于「降级渲染缩放」。',
                control: 'slider',
                default: 40,
                min: 5,
                max: 100,
                step: 5,
                unit: '%',
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
                description: '详细日志输出到「输出」面板的 LiveWriteMD 通道。',
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
 * @param key - 配置键（不含 liveWriteMd.）
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
