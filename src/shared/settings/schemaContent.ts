/**
 * 设置 Schema · 内容域分组：链接与引用 / 表格 / 列表 / 大纲 / 媒体。
 *
 * 只是 SETTINGS_SCHEMA 的数据片段，最终在 index.ts 拼装。
 */
import type { SettingSection } from './types.js';

export const CONTENT_SECTIONS: SettingSection[] = [
    {
        id: 'link',
        label: '链接与引用',
        icon: '🔗',
        description:
            '影响链接、引用块和分隔线的颜色，觉得这些元素在主题里不够显眼时来这里调。',
        items: [
            {
                key: 'linkColor',
                label: '链接颜色',
                description:
                    '正文链接的颜色；留空 = 跟随主题，改它可让链接更醒目或更低调。',
                control: 'color',
                default: '',
            },
            {
                key: 'quoteBorderColor',
                label: '引用竖线颜色',
                description:
                    '引用块左侧竖线的颜色；留空 = 跟随主题，用它拉开引用与正文的层次。',
                control: 'color',
                default: '',
            },
            {
                key: 'quoteTextColor',
                label: '引用文字颜色',
                description:
                    '引用块内文字的颜色；留空 = 跟随主题，通常比正文略淡以区分出处。',
                control: 'color',
                default: '',
            },
            {
                key: 'hrColor',
                label: '分隔线颜色',
                description:
                    '分隔线（---）的颜色；留空 = 跟随主题，想弱化分节时可把它调淡。',
                control: 'color',
                default: '',
            },
        ],
    },
    {
        id: 'table',
        label: '表格',
        icon: '📊',
        description:
            '控制表格的边框、表头、斑马纹和选中高亮，表格多、看得眼花时来这里调。',
        items: [
            {
                key: 'tableBorderColor',
                label: '表格边框颜色',
                description:
                    '表格边框和网格线的颜色；留空 = 跟随主题，边框太抢眼时可调淡。',
                control: 'color',
                default: '',
            },
            {
                key: 'tableHeaderBackground',
                label: '表头底色',
                description:
                    '表头行的背景色；留空 = 跟随主题，加一层底色可让表头和数据行分开。',
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
                description:
                    '编辑时选中单元格的高亮底色；留空 = 跟随主题，选区不显眼时换个明显的颜色。',
                control: 'color',
                default: '',
            },
        ],
    },
    {
        id: 'list',
        label: '列表与复选框',
        icon: '✅',
        description:
            '影响列表圆点和复选框的颜色与位置，圆点歪了或复选框不够醒目时调这里。',
        items: [
            {
                key: 'bulletColor',
                label: '列表圆点颜色',
                description:
                    '列表圆点和序号标记的颜色；留空 = 跟随主题，想突出层级时可单独上色。',
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
                description:
                    '复选框勾选后的强调色；留空 = 跟随主题，待办很多时上色更易扫读。',
                control: 'color',
                default: '',
            },
        ],
    },
    {
        id: 'outline',
        label: '大纲',
        icon: '🗂️',
        description:
            '控制大纲面板是否自动打开、默认多宽以及有没有层级引导线，常看大纲时调这里。',
        items: [
            {
                key: 'outlineAutoOpen',
                label: '打开文件时展开大纲',
                description:
                    '开启后每次打开 Markdown 文件都自动展开大纲面板；关闭则手动点开。',
                control: 'toggle',
                default: false,
            },
            {
                key: 'outlineWidth',
                label: '大纲默认宽度',
                description:
                    '大纲面板首次打开时的宽度；之后手动拖拽调过的宽度会单独记住。',
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
                description:
                    '开启时大纲条目之间显示缩进引导线，层级更直观；关闭则只靠文字缩进。',
                control: 'toggle',
                default: true,
            },
        ],
    },
    {
        id: 'media',
        label: '图片与媒体',
        icon: '🖼️',
        description:
            '决定图片和媒体放在哪、默认多大、是否居中，插入图片不顺手时来这里调。',
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
                description:
                    '开启时独占一行的图片 / Mermaid 图居中显示；关闭则靠左对齐。',
                control: 'toggle',
                default: true,
            },
        ],
    },
];
