/**
 * 设置 Schema 的类型定义（从原 settingsSchema.ts 拆出）。
 *
 * 数据部分见同目录 schemaEditor / schemaContent / schemaMindmap，
 * 拼装与工具函数见 index.ts。
 *
 * @module shared/settings/types
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
    /**
     * 分组说明（显示在面板右侧标题下方）。
     * 一句话讲清「这一组影响什么」，新手据此判断该去哪个分组找。
     */
    description?: string;
    /** 组内设置项。 */
    items: SettingItem[];
}
