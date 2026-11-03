/**
 * 设置 Schema · 幻灯片域分组。
 *
 * 只放 PPT 模式自己的少量选项：配色主题、按哪一级标题分页。
 * 版面的长宽 / 留白仍是 deck 设计；正文的字体族、字号与缩放沿用
 * 「编辑器」分组里的设置，因此同一份 Markdown 在 live / 导图 / PPT
 * 里的字宽与缩进基准一致。
 *
 * @module shared/settings/schemaSlides
 */
import type { SettingSection } from './types.js';

export const SLIDES_SECTIONS: SettingSection[] = [
    {
        id: 'slides',
        label: '幻灯片',
        icon: '🖥️',
        description:
            'PPT 模式下同一份 Markdown 的配色与分页方式。正文的字体、字号与缩放沿用「编辑器」设置，三个模式使用同一套排版基准。',
        items: [
            {
                key: 'slidesTheme',
                label: '幻灯片主题',
                description:
                    '自动跟随 VS Code 明暗：浅色用「纸」、深色用「墨」。也可以固定成纸 / 墨 / 靛。',
                control: 'select',
                default: 'auto',
                options: [
                    { value: 'auto', label: '自动（跟随编辑器明暗）' },
                    { value: 'paper', label: '纸（暖白 + 朱红）' },
                    { value: 'ink', label: '墨（深色 + 冷蓝）' },
                    { value: 'indigo', label: '靛（浅靛 + 青绿）' },
                ],
            },
            {
                key: 'slidesFrame',
                label: '页面边框装饰',
                description:
                    '在页面内容区四周的留白里加一点克制的装饰：内嵌发丝线或四角标记。只影响 PPT 渲染，不改文档。工具栏「边框」按钮也能直接切换。',
                control: 'select',
                default: 'none',
                options: [
                    { value: 'none', label: '无' },
                    { value: 'rule', label: '细线框' },
                    { value: 'corners', label: '四角标记' },
                ],
            },
            {
                key: 'slidesHeadingLevel',
                label: '自动分页标题级别',
                description:
                    '按哪一级标题开启新页。选自动时：同时有 H1/H2 就把 H1 当章节页、H2 当内容页；只有一级标题时直接用那一级。',
                control: 'select',
                default: 'auto',
                options: [
                    { value: 'auto', label: '自动' },
                    { value: '1', label: '一级标题（H1）' },
                    { value: '2', label: '二级标题（H2）' },
                    { value: '3', label: '三级标题（H3）' },
                ],
            },
        ],
    },
];
