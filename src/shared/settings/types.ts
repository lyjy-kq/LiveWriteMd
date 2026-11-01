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
     * 不在设置面板里显示（仍写入 package.json / 参与默认值与持久化）。
     *
     * 用于「只在界面上直接操作、但需要记住值」的设置，
     * 例如快速卡片的宽度：拖动卡片左边界调，面板里不再放滑杆。
     */
    hidden?: boolean;
    /**
     * 滑块在某个特殊值时显示的文字（如 readableLineLength=0 显示「不限」）。
     */
    valueLabels?: Array<{ value: number; label: string }>;
}

/**
 * 设置分组。
 *
 * 支持一层嵌套：带 `children` 的分组只作为左侧导航的「父项」（可展开 / 收起），
 * 本身不放设置项；真正承载 `items` 的是它的子分组（叶子）。
 * 这样「思维导图」这种项很多的分组可以再按语义拆分，而导航层级、搜索跳转
 * 仍然以叶子分组为准 —— 面板的 activeSection 始终是叶子 id。
 */
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
    /**
     * 组内设置项。
     * 有 children 的父分组可以省略（或留空），此时它只负责导航归组。
     */
    items?: SettingItem[];
    /**
     * 子分组（仅一层）。
     * 父分组本身不直接展示设置项，点击展开后在导航里缩进显示子分组。
     */
    children?: SettingSection[];
}
