/**
 * 导图模式的本地类型定义。
 *
 * 节点数据采用 { data, children } 的通用树结构（自研引擎直接消费），
 * 本项目自定义字段一律下划线开头（设计文档 §4）。
 */

/** 导图节点语义类型。code / table / image / math / mermaid 合称「媒体节点」
 * （设计文档 §6 媒体节点；math/mermaid 为迭代 N1 新增）；
 * meta = 文档 front matter 元数据节点（任务 14，根节点固定首位的叶子）。 */
export type MindMapNodeKind =
    | 'root'
    | 'heading'
    | 'list'
    | 'para'
    | 'code'
    | 'table'
    | 'image'
    | 'math'
    | 'mermaid'
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

/** 导图相关设置（从 allSettings 里抽取）。 */
export interface MindMapRuntimeSettings {
    /** 配色：auto 跟随编辑器明暗 / default 等具体主题名。 */
    mindmapTheme: string;
    /** 默认展开层级 0-6。 */
    mindmapDefaultExpandLevel: number;
    /** 是否开启性能模式（画布外不渲染）。 */
    mindmapPerformanceMode: boolean;
    /**
     * 是否启用显示实例 LRU 淘汰（默认关闭）。
     *
     * 开启后离屏实例最多保留 64 个，超出时销毁最早创建的并降级为纯文本
     * 占位；关闭时离屏实例一直保留，回到视口直接复用，不再重建 CM。
     */
    mindmapDisplayCache: boolean;
    /** 文本节点最大宽度（列，1 列 = 1 个中文字宽 = 1em）。 */
    mindmapNodeMaxWidth: number;
    /** 文本节点最大行数，超出截断加省略号。 */
    mindmapNodeMaxLines: number;
    /** 代码块节点最小宽度（列 = 等宽字符 ch；0 = 不设）。 */
    mindmapCodeMinWidth: number;
    /**
     * 是否启用降级渲染档。
     *
     * 关闭（默认）时无视下面的阈值，任何缩放比例都按全量档渲染；
     * 开启后缩放到 mindmapLiteZoom 以下才进入降级档。
     */
    mindmapLiteEnabled: boolean;
    /**
     * 是否启用纯文本档。
     *
     * 关闭（默认）时永远不会进入纯文本档；开启后缩放到
     * mindmapPlainZoom 以下才用纯文本占位。
     */
    mindmapPlainEnabled: boolean;
    /**
     * 降级渲染阈值（缩放百分比，1-100）。
     * 缩放低于该值时，节点不再挂完整的 live preview 显示扩展
     * （行内格式、代码高亮、表格/公式/mermaid widget 全部省掉），
     * 只保留 Markdown 源码排版与基本文字 —— 小缩放下这些细节根本看不清，
     * 省掉的是每个节点的几十个装饰、测量与 widget 构建。
     */
    mindmapLiteZoom: number;
    /**
     * 纯文本阈值（缩放百分比，1-100，应不大于 mindmapLiteZoom）。
     * 缩放低于该值时连 mini-CM 都不建：节点显示成纯文本占位，
     * 媒体节点只显示摘要（代码 · N 行 / 表格 N 行 × N 列），
     * 保证超大文档在很小缩放下拖动/缩放仍然跟手。
     */
    mindmapPlainZoom: number;
}

/** 导图编辑回调：把导图操作算出的新全文交回宿主（CM dispatch / CONTENT_CHANGE）。 */
export type MindMapEditCallback = (newFullText: string) => void;
