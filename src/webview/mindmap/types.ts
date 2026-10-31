/**
 * 导图模式的本地类型定义。
 *
 * 节点数据采用 { data, children } 的通用树结构（自研引擎直接消费），
 * 本项目自定义字段一律下划线开头（设计文档 §4）。
 */

/** 导图节点语义类型。code / table / image / math / mermaid / html 合称
 * 「媒体节点」（设计文档 §6 媒体节点；math/mermaid 为迭代 N1 新增，
 * html 用于 README 常见的居中段落 / 徽章图片块）；
 * meta = 文档 front matter 元数据节点（任务 14，根节点固定首位的叶子）。 */
export type MindMapNodeKind =
    | 'root'
    | 'heading'
    | 'list'
    | 'para'
    | 'quote'
    | 'code'
    | 'table'
    | 'image'
    | 'math'
    | 'mermaid'
    | 'html'
    | 'meta';

/** 节点在源 Markdown 中对应的 0-based 行区间（含两端）。根节点没有行区间。 */
export interface NodeLineRange {
    fromLine: number;
    toLine: number;
}

/** 导图节点 data 负载（下划线字段为本项目自定义）。 */
export interface MindMapNodePayload {
    /** 节点显示用文本（md 行内源码；段落截断时为截断版）。 */
    text: string;
    /** 段落全文（截断显示时使用），其它节点不带。 */
    note?: string;
    /** 是否展开（根恒为 true）。 */
    expand: boolean;
    /** 路径式 uid，如 "0/2/1"，用于重建后恢复展开状态。 */
    uid: string;
    /** 节点语义类型。 */
    _kind: MindMapNodeKind;
    /**
     * 源文档行区间（**含全部子节点**，用于拖动/删除等整块操作）。
     *
     * 注意：不能拿去渲染节点自身内容 —— 列表项的区间会包含嵌套子列表，
     * 直接展示会出现「父节点里又画了一遍子节点」。渲染/改名用
     * {@link _selfLineRange}。
     */
    _lineRange?: NodeLineRange;
    /**
     * 节点**自身**内容占用的行区间（不含子节点）。
     *
     * 列表项的首段可能有续行，所以不能简单取 fromLine 一行；
     * code/table 等媒体节点自身即叶子，两者相同。
     */
    _selfLineRange?: NodeLineRange;
    /** 标题层级 1-6。 */
    _headingLevel?: number;
    /** 列表节点是否有序列表。 */
    _listOrdered?: boolean;
    /** 代码块节点的语言标识（ fenced ``` 后的 info 串，可空）。 */
    _language?: string;
    /** 图片节点的地址（原始 md 里的写法，未解析）。 */
    _imageUrl?: string;
    /** 图片节点的替代文本。 */
    _imageAlt?: string;
}

/** 导图树节点。 */
export interface MindMapTreeNode {
    data: MindMapNodePayload;
    children: MindMapTreeNode[];
}

/** 性能监测浮层档位：关闭 / 极简 / 完整。 */
export type PerfMonitorMode = 'off' | 'minimal' | 'full';

/** 导图相关设置（从 allSettings 里抽取）。 */
export interface MindMapRuntimeSettings {
    /** 配色：auto 跟随编辑器明暗 / default 等具体主题名。 */
    mindmapTheme: string;
    /** 默认展开层级 0-6。 */
    mindmapDefaultExpandLevel: number;
    /** 文本节点最大宽度（列，1 列 = 1 个中文字宽 = 1em）。 */
    mindmapNodeMaxWidth: number;
    /** 文本节点最大行数，超出截断加省略号。 */
    mindmapNodeMaxLines: number;
    /** 代码块节点最小宽度（列 = 等宽字符 ch；0 = 不设）。 */
    mindmapCodeMinWidth: number;
    /**
     * 手势期间是否放弃合成层提升（清晰度优先）。
     *
     * 关闭（默认）= 拖动 / 滚轮缩放期间给世界层或缩放层加 will-change，
     * 每帧只改合成属性，帧率最好，但合成层里的文字只能用灰度抗锯齿
     * （实测次像素彩边归零）。
     *
     * 开启 = 手势期间也保持非合成层：文字始终按当前比例重新栅格化、
     * 保留 LCD 次像素抗锯齿，代价是每帧要重绘视口内容，大文档可能掉帧。
     */
    mindmapGestureCrisp: boolean;
    /**
     * 是否绘制内链箭头层（默认开启）。
     *
     * 文档内链接（`[[#标题]]` / `[文字](#标题)`）在导图中呈现为置于底层的
     * 虚线箭头，从内链所在节点指向目标标题节点，点击箭头跳转聚焦目标。
     */
    mindmapInternalLinks: boolean;
    /**
     * 画布右上角的性能监测浮层（默认关闭）。
     *
     * - minimal：无边框，只显示帧率与堆内存；
     * - full：另含实例数 / 换真队列 / 强制布局速率与尖峰记录。
     */
    mindmapPerfMonitor: PerfMonitorMode;
}

/** 导图编辑回调：把导图操作算出的新全文交回宿主（CM dispatch / CONTENT_CHANGE）。 */
export type MindMapEditCallback = (newFullText: string) => void;
