/**
 * LiveWriteMD 设置 Schema —— 设置功能的单一数据源。
 *
 * 以**声明式**描述所有可配置项：分在哪个组、用什么控件、默认值、取值范围、
 * 可选项。三处都依赖它：
 *
 * 1. 设置面板（webview/settings）据此渲染开关 / 滑块 / 取色器 / 下拉；
 * 2. 扩展侧 ConfigManager.getAllSettings 据此批量读取 VS Code 配置；
 * 3. package.json contributes.configuration 的 properties 与这里的 key / 默认值对齐
 *    （由 scripts/syncConfiguration.mjs 同步）。
 *
 * ## 默认值约定（重要）
 *
 * - 颜色项默认一律是空串 `""`，语义是「**自动 / 跟随明暗主题**」。
 *   留空时不注入对应 CSS 变量，渲染沿用内置主题默认色（明 / 暗各自的现状），
 *   因此**默认外观与解耦前完全一致**；用户选了颜色才全局覆盖，可一键重置回自动。
 * - 开关 / 滑块 / 下拉的默认值 = 当前产品里正在使用的预设值（「把当前设置作为默认」）。
 *
 * ## 文件组织
 *
 * 数据按域拆在同目录三个文件中，这里只做拼装与工具函数：
 * - types.ts          类型定义（SettingValue / SettingItem / SettingSection 等）
 * - schemaEditor.ts   通用 / 编辑器 / 文本 / 代码
 * - schemaContent.ts  链接与引用 / 表格 / 列表 / 大纲 / 媒体
 * - schemaMindmap.ts  思维导图 / 高级
 *
 * @module shared/settings
 */

import type { SettingItem, SettingSection, SettingValue } from './types.js';
import { EDITOR_SECTIONS } from './schemaEditor.js';
import { CONTENT_SECTIONS } from './schemaContent.js';
import { MINDMAP_SECTIONS } from './schemaMindmap.js';

// 类型从这里统一出口，外部只需 import 本文件
export type {
    SettingValue,
    SettingControl,
    SettingOption,
    SettingItem,
    SettingSection,
} from './types.js';

/** 全部设置分组，按面板展示顺序。 */
export const SETTINGS_SCHEMA: SettingSection[] = [
    ...EDITOR_SECTIONS,
    ...CONTENT_SECTIONS,
    ...MINDMAP_SECTIONS,
];

/**
 * 收集叶子分组（真正承载 items 的分组）。
 *
 * schema 支持一层嵌套：父分组只有 children，自身不放设置项。
 * 面板导航、搜索、跳转都以叶子为准，所以这里递归摊平一遍；
 * 虽然目前只有一层，写成递归也让以后加深层级时不用改调用方。
 */
function collectLeafSections(sections: SettingSection[]): SettingSection[] {
    const leaves: SettingSection[] = [];
    for (const section of sections) {
        if (section.children && section.children.length > 0) {
            leaves.push(...collectLeafSections(section.children));
        } else {
            leaves.push(section);
        }
    }
    return leaves;
}

/** 全部叶子分组（扁平，按面板展示顺序）。 */
export const SETTING_SECTIONS_FLAT: SettingSection[] = collectLeafSections(
    SETTINGS_SCHEMA
);

/** 全部设置项（扁平），按 schema 顺序；children 里的项也会算进来。 */
export const ALL_SETTING_ITEMS: SettingItem[] = SETTING_SECTIONS_FLAT.flatMap(
    (section) => section.items ?? []
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
