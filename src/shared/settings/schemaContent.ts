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
];
