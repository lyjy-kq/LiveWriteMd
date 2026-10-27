/**
 * 设置 Schema · 编辑器域分组：通用 / 编辑器 / 文本 / 代码。
 *
 * 只是 SETTINGS_SCHEMA 的数据片段，最终在 index.ts 拼装。
 */
import type { SettingSection } from './types.js';

export const EDITOR_SECTIONS: SettingSection[] = [
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
];
