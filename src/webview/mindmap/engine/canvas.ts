/**
 * 自研导图画布引擎（替代 simple-mind-map）。
 *
 * 分层：
 *   container
 *     └─ .lwm-canvas                 （视口：裁剪 + 指针事件）
 *          ├─ .lwm-world             （平移层：只写 translate）
 *          │    └─ .lwm-scaler       （缩放层：只写 scale）
 *          │         ├─ svg.lwm-links     （连线，世界坐标）
 *          │         └─ .lwm-node-layer   （节点 + 展开按钮，世界坐标）
 *          └─ .lwm-measure           （离屏测量层，visibility:hidden）
 *
 * 关键设计：
 * - **一份模型**：MapNode 树同时承担布局与渲染状态；
 * - **测量即布局**：节点包裹元素在离屏层用 max-content 量出宽高，再写死尺寸，
 *   布局只跟数字打交道，不做 DOM 二次读取；
 * - **视口虚拟化**：只把当前视口（+ 余量）内的节点挂进 DOM；拖动画布时只改变
 *   世界层 transform，不重建任何节点；
 * - **按 uid 复用**：重排/拖动/编辑后重建模型时，未变化的节点把 wrapper 与
 *   mini-CM 整棵 DOM 搬过去，同时保留滚动/选区/编辑态；
 * - **显示实例缓存**：离屏实例默认保留（平移回来直接复用）；设置里开启
 *   「显示实例 LRU 淘汰」后，超过上限的最旧离屏实例降级回静态占位，
 *   回到视口时按需重建。
 *
 * 该文件不处理 markdown 回写：拖动落点通过 onDrop 交给上层，
 * 由 MarkdownEdit 计算新全文后再 setData 回来。
 */

import { EditorSelection } from '@codemirror/state';
import type { LanguageDescription } from '@codemirror/language';
import type { ThemeType } from '../../../shared/types.js';
import { createNodeDisplay, type NodeDisplay } from '../miniCm.js';
import type { MindMapTreeNode } from '../types.js';
import { layoutMap, computeBounds, V_GAP, H_GAP, type MapBounds } from './layout.js';
import {
    buildMapModel,
    collectSubtreeUids,
    expandAncestors,
    expandSubtree,
    findMapNode,
    walkAll,
    walkVisible,
    type MapNode,
} from './model.js';

/**
 * 同屏真实显示实例的软上限（超出的离屏实例降级为占位）。
 *
 * 仅在设置「显示实例 LRU 淘汰」开启时生效；关闭时离屏实例一直保留。
 */
const DISPLAY_CACHE_CAP = 64;
/** 一次 setData 中直接创建真实显示实例的节点数（其余先占位）。 */
const PROGRESSIVE_THRESHOLD = 24;
/**
 * 换真泵每批处理的节点数。
 *
 * 一次建 12 个轻量 CM 实测 90~130ms，单个任务太长；单个 CM 约 11~22ms，
 * 所以每批 2 个（约 20~45ms 一个任务），16ms 节奏下每秒仍能换 120 个。
 * 松手后第一屏内容一两百毫秒内就能补齐，不会盯着占位文本看很久。
 */
const PROGRESSIVE_BATCH = 2;
/**
 * 手势进行中，换真泵的轮询间隔（ms）。
 *
 * 拖动/缩放时绝不创建 mini-CM：实测创建 8 个轻量 CM 要 90ms，
 * 一次拖动里换真泵跑一批就能让帧间隔从 16ms 跳到 80~300ms。
 * 手势期间只轮询，松手后立刻继续换真。
 */
const PUMP_PAUSE_MS = 100;
/** 最后一次滚轮缩放后，视为「缩放手势进行中」的时长（ms）。 */
const WHEEL_ACTIVE_MS = 120;
/** 视口外挂载余量（屏幕像素）。 */
const VIEW_MARGIN = 320;
/** 按下后移动超过该距离才算拖动（像素）。 */
const DRAG_THRESHOLD = 5;
/** 拖到边缘多少像素内自动平移。 */
const AUTO_PAN_EDGE = 48;
/** 自动平移每帧步长（像素）。 */
const AUTO_PAN_STEP = 14;
/** 缩放范围。 */
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 3;
/**
 * 高倍缩放阈值（1 = 100%）。
 *
 * 超过这个比例时给画布加 `lwm-hi-zoom`：CSS 会把节点底色浓度按比例压低，
 * 文字与底色的对比度随之上升（实测 16% → 6% 时同一段文字的 Laplacian
 * 从 119 升到 128，16% → 0% 升到 133）。
 *
 * 为什么只有这一个旋钮：字形栅格化本身已经到顶 —— 实测 300% 变换里的
 * 节点文字与「原生按 42px 排版」的平面文本逐项指标完全一致
 * （lap 88.15 / lapInk 176.21 / ink 3606 / 彩边 3.36），
 * 再把节点位置对齐到设备像素也是 55.03 → 54.95（无变化）。
 * 也就是说重新排版、重新栅格化、像素对齐都不会更清晰，
 * 高倍下还能真实改善的只有对比度（以及字重 / 字体这类排版选择）。
 */
const HI_ZOOM_THRESHOLD = 1.5;
/** 缩略图尺寸（CSS px）。 */
const MINIMAP_W = 190;
const MINIMAP_H = 120;
/** 缩略图重绘合并间隔（ms）：平移/缩放高频触发时最多 25fps。 */
const MINIMAP_REDRAW_MS = 40;
/**
 * 滚轮缩放停下多久后撤掉缩放层的 will-change（ms）。
 *
 * 缩放期间缩放层是合成层，文字用缓存位图拉伸（运动中略糊，但流畅）；
 * 停下后必须撤掉，让浏览器按最终比例重新栅格化，文字恢复清晰。
 * 与 WHEEL_ACTIVE_MS 接近即可：先恢复清晰，再考虑换真泵。
 */
const ZOOM_SETTLE_MS = 120;

/**
 * 文本类节点（标题 / 列表项 / 段落）。
 * 降级渲染档里只有它们还值得建轻量 mini-CM；媒体节点直接显示摘要文本。
 */
const TEXT_KINDS = new Set<string>(['heading', 'list', 'para']);

/**
 * 渲染档位（由缩放比例自动决定）：
 * - 0 全量：mini-CM + 完整 live preview（行内格式 / 表格 / 公式 / mermaid）；
 * - 1 降级：文本节点用轻量 mini-CM（不挂 live preview），媒体节点只显示摘要；
 * - 2 纯文本：不建任何 mini-CM，所有节点显示纯文本占位，只保留节点框与连线。
 */
type RenderTier = 0 | 1 | 2;

/**
 * 标题色板 h1~h6 的基准色（色相与 live 的默认色一致；live 会把它们
 * 按主题正文色做明度微调，这里只用于节点底色的色相轮换，保持原色即可）。
 * 背景色轮换用：CSS 变量 --livewritemd-hN-color 没定义时拿它兜底。
 */
const HEADING_TINT_FALLBACKS = ['#eb8383', '#ae9acb', '#7db5cd', '#71a796', '#dcbf61', '#dda36a'];

/** 拖动落点。 */
export interface DropPayload {
    /** 被拖动的节点 uid。 */
    dragUid: string;
    /** 新父节点 uid。 */
    parentUid: string;
    /** 插到该兄弟之后（null = 插到最前 / 作为子节点追加）。 */
    prevUid: string | null;
    /** 插到该兄弟之前（null = 追加到末尾）。 */
    nextUid: string | null;
}

/** 画布回调。 */
export interface MapCanvasOptions {
    /**
     * 计算节点显示文档。
     *
     * 上层拿着 markdown 全文与节点的 _lineRange，决定：
     * 标题拼 `#`、root 拼 `# 文件名`、段落裁切、媒体节点取源码区间。
     */
    computeDoc(node: MapNode): { doc: string; sentinel: boolean };
    /** 当前实际明暗主题（mini-CM 用）。 */
    getTheme(): ThemeType;
    /** 代码块嵌套高亮语言表。 */
    codeLanguages?: readonly LanguageDescription[];
    /** 单击节点。 */
    onNodeClick(node: MapNode, event: MouseEvent): void;
    /** 双击节点（进入编辑）。 */
    onNodeDoubleClick(node: MapNode, event: MouseEvent): void;
    /** 点击画布空白。 */
    onCanvasClick(): void;
    /** 展开按钮被点击（expanded = 新状态；recursive = Ctrl 点整棵子树）。 */
    onExpandChange(uid: string, expanded: boolean, recursive: boolean): void;
    /** 拖动结束且落点合法。 */
    onDrop(payload: DropPayload): void;
    /** 视口平移/缩放/布局变化（工具条跟随）。 */
    onViewChange(): void;
    /** 落点预校验（类型规则由上层决定；返回 false 不高亮）。 */
    canDrop?(dragUid: string, parentUid: string): boolean;
    /**
     * Ctrl + 拖拽框选的结果（每次移动都会回调，松手后保留）。
     *
     * @param uids 当前框住的节点 uid（按视图顺序）
     */
    onMarqueeSelect?(uids: string[]): void;
    /**
     * 显示态（非编辑会话）里节点本地文档被改动了。
     *
     * 目前的来源都是 widget 上的按钮：mermaid 的宽度档位（改 info 行里的
     * `{width=…}`）、表格边缘的加行/加列（withEditable 临时可编辑后执行
     * runTableCommand）。这些改动只落在节点自己的 mini-CM 文档里，
     * 必须由上层走 renameNode → 源文档，否则下次 setData 就被覆盖回去。
     *
     * @param node 被改动的节点
     * @param text 改动后的节点源码（已去掉哨兵换行）
     */
    onDisplayEdit?(node: MapNode, text: string): void;
}

/** 指针状态。 */
type PointerState =
    | {
          kind: 'pan';
          pointerId: number;
          startX: number;
          startY: number;
          panX: number;
          panY: number;
          moved: boolean;
      }
    | {
          kind: 'node';
          pointerId: number;
          uid: string;
          startX: number;
          startY: number;
          moved: boolean;
          /** 按下点是否落在 CM 正文里（决定拖动时是选文字还是拖节点）。 */
          fromContent: boolean;
          event: PointerEvent;
      }
    | {
          /**
           * Ctrl + 拖拽框选。
           *
           * 从节点上按下也算：没拖动 = Ctrl 点切换选中；拖了 = 从该点开始框选。
           * 这样既不占用「拖节点移动」（普通拖动），也不和「拖选文字」冲突。
           */
          kind: 'marquee';
          pointerId: number;
          startX: number;
          startY: number;
          moved: boolean;
          /** 按下时落在哪个节点上（Ctrl 点切换选中用）；空白处为 null。 */
          fromNode: { uid: string; event: PointerEvent } | null;
      }
    | null;

/** 拖动落点候选。 */
interface DropCandidate {
    parentUid: string;
    prevUid: string | null;
    nextUid: string | null;
    /** 作为子节点落进去的目标（用于高亮）。 */
    targetUid: string | null;
    /** 兄弟插入指示线（世界坐标）。 */
    line: { x: number; y: number; width: number } | null;
}

/** 拖动状态。 */
interface DragState {
    uid: string;
    node: MapNode;
    startClientX: number;
    startClientY: number;
    /** 节点在拖动开始时的世界坐标。 */
    originX: number;
    originY: number;
    candidate: DropCandidate | null;
    pointerId: number;
}

/** 显示实例缓存条目。 */
interface DisplayEntry {
    display: NodeDisplay;
    wrapper: HTMLElement;
    node: MapNode;
    kind: string;
    /**
     * 实例档位：full = 完整 live preview，lite = 轻量源码渲染。
     * 缩放在两档之间来回跨阈值时，靠它判断现有实例是否还能复用。
     */
    mode: 'full' | 'lite';
}

export class MapCanvas {
    private readonly container: HTMLElement;
    private readonly options: MapCanvasOptions;

    // —— DOM ——
    private readonly canvasEl: HTMLDivElement;
    /**
     * 平移层：只负责 translate（pan），不携带 scale。
     *
     * 分层原因（清晰度）：Chromium 对带 `will-change: transform` 的元素会
     * 按 **1x** 栅格化，之后 transform 里的 scale 只是拿这张位图拉伸采样。
     * 如果 scale 和平移放在同一层，缩小/放大时文字就会整体发虚、边缘带彩边。
     * 把 scale 挪到内层 `.lwm-scaler`（平时不提升、按当前比例正常栅格化），
     * 外层只做平移 —— 平移不改比例，缓存位图可以放心复用，文字始终清晰。
     */
    private readonly worldEl: HTMLDivElement;
    /**
     * 缩放层：只负责 scale，挂在平移层里面。
     *
     * 滚轮缩放期间临时给它加 `will-change: transform`（见 `.lwm-zooming`），
     * 让每帧只改合成属性；缩放手势停下后撤掉，浏览器按最终比例重新栅格化，
     * 文字恢复清晰。
     */
    private readonly scalerEl: HTMLDivElement;
    private readonly nodeLayer: HTMLDivElement;
    private readonly linksSvg: SVGSVGElement;
    private readonly measureLayer: HTMLDivElement;
    /** 拖动时显示在兄弟间隙的插入指示线。 */
    private readonly dropLine: HTMLDivElement;
    /**
     * 右下角缩略图：只画节点方块 + 当前视口框。
     * 画在 canvas 上（比逐节点 DOM 便宜得多），点击 / 拖动跳转视口。
     */
    private readonly minimapEl: HTMLCanvasElement;
    /** 缩略图重绘合并定时器（null = 没有排队）。 */
    private minimapTimer: ReturnType<typeof setTimeout> | null = null;
    /** 正在缩略图上拖动的指针 id（null = 没在拖）。 */
    private minimapPointerId: number | null = null;
    /**
     * 缩略图节点方块的离屏位图缓存。
     *
     * 平移时只有视口框在动，节点方块在世界坐标里纹丝不动，却每 40ms
     * 重画一遍（每个节点一次 fillRect，大文档白白烧掉帧预算）。把方块
     * 画进离屏 canvas，平移期间直接 drawImage 贴回来，只补画视口框与
     * 缩放百分比。key 不一致（缩放 / 范围 / 主题 / 布局变了）才重画。
     */
    private minimapRaster: { key: string; canvas: HTMLCanvasElement } | null = null;
    /**
     * 可见节点包围盒缓存：布局没变时不必每次缩略图重绘都遍历整棵树。
     * relayout / setData / 展开收起都会把它置空。
     */
    private boundsCache: MapBounds | null = null;

    // —— 模型 ——
    private root: MapNode | null = null;
    private readonly byUid = new Map<string, MapNode>();
    private selectedUid: string | null = null;
    private editingUid: string | null = null;
    /** 用户点开「展开到最大行数」的节点（去掉行数截断）。 */
    private readonly expandedFlags = new Set<string>();
    /** 搜索命中的节点 uid。 */
    private searchHits = new Set<string>();
    private searchCurrent: string | null = null;

    // —— 显示实例 / 挂载 ——
    private displays = new Map<string, DisplayEntry>();
    /**
     * 是否启用离屏实例 LRU 淘汰（设置项，默认关闭）。
     *
     * 关闭时离屏节点的真实 mini-CM 一直保留，来回平移直接复用，代价是
     * 内存随文档节点数增长；开启后超过 DISPLAY_CACHE_CAP 的离屏实例
     * 会被销毁并降级为纯文本占位。
     */
    private displayCacheEnabled = false;
    private readonly mounted = new Set<string>();
    private readonly queue: string[] = [];
    private readonly queued = new Set<string>();
    private pumpTimer: ReturnType<typeof setTimeout> | null = null;
    private progressiveCount = 0;
    /**
     * 本次 setData 允许同步创建多少个真实显示实例。
     *
     * 首屏需要一批真实 CM 把内容直接画出来；之后的每次 setData（拖动回写、
     * 外部更新）只重建「内容真的变了」的节点，其余占位节点交给 pump 异步
     * 换真。否则每次 drop 都会同步造 24 个 mini-CM（实测 ~300ms）。
     */
    private eagerDisplayBudget = PROGRESSIVE_THRESHOLD;
    private viewTimer: ReturnType<typeof setTimeout> | null = null;
    /** 首帧后的补偿性重测（见 scheduleMeasureSettle）。 */
    private settleRaf: number | null = null;
    private settleTimer: ReturnType<typeof setTimeout> | null = null;
    /** 需要补偿重测的节点（新建过真实显示实例的）。 */
    private readonly settleUids = new Set<string>();
    /** 下一次 settle 强制全量（字体/图片等全局因素）。 */
    private settleForceAll = false;
    private readonly linkPaths = new Map<string, SVGPathElement>();
    private readonly expandButtons = new Map<string, HTMLDivElement>();
    /**
     * 挂载集合版本号：mount/unmount 时 +1。
     *
     * 连线与展开按钮的可见性只看「端点是否挂载」。平移时如果这一帧没有
     * 节点进出 DOM，可见性必然与上一帧相同 —— 以前每帧仍把全部连线
     * （每个可见节点一条 path）和按钮的 display 重写一遍，大文档下等于
     * 每帧上千次无意义的样式写入。
     */
    private mountedVersion = 0;
    /** 上一次做过可见性同步时的 mountedVersion。 */
    private visibilityVersion = -1;

    // —— 视口 ——
    private zoom = 1;
    private panX = 0;
    private panY = 0;
    private active = false;
    private virtualization = true;
    private hasFit = false;
    /** 最后一次滚轮事件的时间戳（换真泵据此避开缩放手势）。 */
    private lastWheelTime = 0;
    /** 滚轮缩放结束后撤掉缩放层提升的定时器（null = 没排队）。 */
    private zoomTimer: ReturnType<typeof setTimeout> | null = null;
    /** 当前是否处于「高倍缩放」（canvas 上挂着 lwm-hi-zoom）。 */
    private hiZoomActive = false;
    /**
     * 手势期间是否放弃合成层提升（设置：「手势期间保持清晰」）。
     * false = 现状：拖动/缩放时临时提升，帧率优先。
     */
    private gestureCrisp = false;

    // —— 缩放降级渲染 ——
    /** 当前渲染档（0 全量 / 1 降级 / 2 纯文本），随 zoom 自动切换。 */
    private renderTier: RenderTier = 0;
    /**
     * 是否启用降级档（默认关闭）。关闭时 liteZoom 完全不参与判断，
     * 即使缩到很小也保持全量渲染。
     */
    private liteEnabled = false;
    /**
     * 是否启用纯文本档（默认关闭）。关闭时 plainZoom 完全不参与判断。
     */
    private plainEnabled = false;
    /** 降级阈值（缩放比例，0-1）：zoom < liteZoom 进入档 1。 */
    private liteZoom = 0.7;
    /** 纯文本阈值（缩放比例，0-1）：zoom < plainZoom 进入档 2。 */
    private plainZoom = 0.4;
    /** 上一轮容器尺寸：尺寸变化时用位移补偿保持内容视觉居中。 */
    private lastViewWidth = 0;
    private lastViewHeight = 0;

    // —— 交互 ——
    private pointer: PointerState = null;
    private drag: DragState | null = null;
    private dropCandidate: DropCandidate | null = null;
    /** Ctrl 框选的矩形层（屏幕坐标，不参与缩放）。 */
    private readonly marqueeEl: HTMLDivElement;
    /** 多选中的节点 uid（Ctrl 点 / 框选）。与 selectedUid 叠加显示。 */
    private multiSelected = new Set<string>();
    private autoPanTimer: ReturnType<typeof setTimeout> | null = null;
    private autoPanDx = 0;
    private autoPanDy = 0;

    /** 已绑定的事件处理器（销毁时逐个摘掉）。 */
    private readonly handlers: Array<[EventTarget, string, EventListener]> = [];

    constructor(container: HTMLElement, options: MapCanvasOptions) {
        this.container = container;
        this.options = options;

        // 同一容器重复构造（模式切换/热重载）：先清掉旧画布与缩略图，避免叠两层
        container.querySelector(':scope > .lwm-canvas')?.remove();
        container.querySelector(':scope > .lwm-minimap')?.remove();

        this.canvasEl = document.createElement('div');
        this.canvasEl.className = 'lwm-canvas';
        this.worldEl = document.createElement('div');
        this.worldEl.className = 'lwm-world';
        this.scalerEl = document.createElement('div');
        this.scalerEl.className = 'lwm-scaler';
        this.linksSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        this.linksSvg.classList.add('lwm-links');
        this.linksSvg.setAttribute('width', '0');
        this.linksSvg.setAttribute('height', '0');
        this.nodeLayer = document.createElement('div');
        this.nodeLayer.className = 'lwm-node-layer';
        this.scalerEl.append(this.linksSvg, this.nodeLayer);
        this.worldEl.append(this.scalerEl);
        this.measureLayer = document.createElement('div');
        this.measureLayer.className = 'lwm-measure';
        this.canvasEl.append(this.worldEl, this.measureLayer);
        this.dropLine = document.createElement('div');
        this.dropLine.className = 'lwm-drop-line';
        this.dropLine.style.display = 'none';
        this.nodeLayer.appendChild(this.dropLine);
        // 框选矩形挂在未缩放的 canvasEl 上：坐标直接用 client 坐标减画布原点，
        // 不需要再做世界坐标换算
        this.marqueeEl = document.createElement('div');
        this.marqueeEl.className = 'lwm-marquee';
        this.marqueeEl.style.display = 'none';
        this.canvasEl.appendChild(this.marqueeEl);
        container.appendChild(this.canvasEl);

        // 缩略图挂在容器上（不是 .lwm-canvas 里）：它的指针事件
        // 不能被画布的「空白处拖动平移」抢走，点击缩略图是跳转视口。
        this.minimapEl = document.createElement('canvas');
        this.minimapEl.className = 'lwm-minimap';
        this.minimapEl.title = '缩略图：点击 / 拖动跳转';
        this.minimapEl.width = MINIMAP_W;
        this.minimapEl.height = MINIMAP_H;
        container.appendChild(this.minimapEl);

        this.bindEvents();
        this.applyTransform();
        this.applyThemeVars();
        // 初始档位（CSS 钩子；全量档没有额外样式，保留 data 便于调试/探针）
        this.container.dataset.lwmTier = '0';

        // 字体真正就绪前量出来的宽度可能是回退字体的：字体加载完后补测一次
        if (typeof document !== 'undefined' && document.fonts?.ready) {
            void document.fonts.ready.then(() => {
                if (this.active) this.scheduleMeasureSettle(true);
            });
        }
    }

    // ==================================================================
    // 事件绑定
    // ==================================================================

    /** 注册一个事件并记下来，destroy 时统一摘除。 */
    private on<K extends keyof HTMLElementEventMap>(
        target: EventTarget,
        type: K | string,
        handler: (event: never) => void,
        capture = false
    ): void {
        const fn = handler as EventListener;
        target.addEventListener(type, fn, capture);
        this.handlers.push([target, type, fn]);
    }

    private bindEvents(): void {
        this.on(this.canvasEl, 'pointerdown', (e: PointerEvent) => this.handlePointerDown(e));
        this.on(this.canvasEl, 'pointermove', (e: PointerEvent) => this.handlePointerMove(e));
        this.on(this.canvasEl, 'pointerup', (e: PointerEvent) => this.handlePointerUp(e));
        this.on(this.canvasEl, 'pointercancel', (e: PointerEvent) => this.handlePointerCancel(e));
        // wheel 必须非被动，才能 preventDefault 阻止页面滚动
        this.canvasEl.addEventListener('wheel', this.handleWheel, { passive: false });
        this.handlers.push([this.canvasEl, 'wheel', this.handleWheel as EventListener]);
        this.on(this.nodeLayer, 'dblclick', (e: MouseEvent) => this.handleDoubleClick(e));
        this.on(this.nodeLayer, 'click', (e: MouseEvent) => this.handleLayerClick(e));
        // 缩略图：按下 / 拖动 = 把该世界坐标移到视口中心
        this.on(this.minimapEl, 'pointerdown', (e: PointerEvent) =>
            this.handleMinimapPointerDown(e)
        );
        this.on(this.minimapEl, 'pointermove', (e: PointerEvent) =>
            this.handleMinimapPointerMove(e)
        );
        this.on(this.minimapEl, 'pointerup', (e: PointerEvent) => this.handleMinimapPointerUp(e));
        this.on(this.minimapEl, 'pointercancel', (e: PointerEvent) =>
            this.handleMinimapPointerUp(e)
        );
        // 拖到窗口外松手：pointerup 可能收不到，用 window 兜底
        this.on(window, 'pointerup', (e: PointerEvent) => {
            if (this.drag || this.pointer) this.handlePointerUp(e, true);
        });
        // 节点里的图片（live 预览 widget）是异步加载的：加载完尺寸会变，
        // 必须补测一次，否则用户得点进编辑再失焦才能看到正确宽度。
        // load 不冒泡，所以用捕获阶段在 document 上听。
        this.on(
            document,
            'load',
            (event: Event) => {
                const target = event.target;
                if (target instanceof HTMLImageElement && this.canvasEl.contains(target)) {
                    this.scheduleMeasureSettle(true);
                }
            },
            true
        );
    }

    // ==================================================================
    // 数据入口
    // ==================================================================

    /**
     * 用新的数据树替换模型。
     *
     * @param tree 源数据树（已由上层烤入 expand 标记）
     * @param opts.uidRemap 旧 uid → 新 uid（拖动后路径变化时复用 DOM/CM）
     * @param opts.keepView 是否保持当前视口（默认保持；首次渲染会 fit）
     */
    setData(
        tree: MindMapTreeNode,
        opts?: { uidRemap?: Map<string, string>; keepView?: boolean }
    ): void {
        const oldRoot = this.root;
        const oldByUid = new Map(this.byUid);
        const oldDisplays = this.displays;
        const reverseRemap = new Map<string, string>();
        if (opts?.uidRemap) {
            for (const [from, to] of opts.uidRemap) reverseRemap.set(to, from);
        }

        // 内容指纹索引：删除一个节点后，后面所有兄弟的路径式 uid 会整体
        // 前移（0/2 → 0/1），只按 uid 复用的话等于「所有后续兄弟都换了个
        // 人」，wrapper / mini-CM 全部销毁重建 —— 用户看到的就是删一个
        // 节点、整排兄弟和它们的子树闪一下，删得越多越卡。
        //
        // 这里给旧节点按「类型 + 文本 + 标题级别 + 列表类型 + 语言」建索引，
        // 新节点找不到同 uid 的旧节点时按内容认领（先到先得），删一个节点
        // 就只销毁被删的那棵子树，其余节点原地复用。
        const oldNodesInOrder: MapNode[] = [];
        if (oldRoot) walkAll(oldRoot, (node) => oldNodesInOrder.push(node));
        const contentKeyOf = (node: MapNode): string =>
            [
                node.kind,
                node.text,
                node.data._headingLevel ?? '',
                node.data._listOrdered ? 1 : 0,
                node.data._language ?? '',
                node.data._imageUrl ?? '',
            ].join('\u0000');
        const oldByContent = new Map<string, MapNode[]>();
        for (const old of oldNodesInOrder) {
            const key = contentKeyOf(old);
            const bucket = oldByContent.get(key);
            if (bucket) bucket.push(old);
            else oldByContent.set(key, [old]);
        }
        /** 已经被新模型认领的旧节点（防止同一个 DOM/CM 被认领两次）。 */
        const claimedOldNodes = new Set<MapNode>();
        /** 按内容认领一个还没被用掉的旧节点。 */
        const takeByContent = (node: MapNode): MapNode | undefined => {
            const bucket = oldByContent.get(contentKeyOf(node));
            if (!bucket) return undefined;
            while (bucket.length > 0) {
                const candidate = bucket.shift()!;
                if (!claimedOldNodes.has(candidate)) return candidate;
            }
            return undefined;
        };

        // 1. 建新模型
        const newRoot = buildMapModel(tree);
        this.root = newRoot;
        this.byUid.clear();
        walkAll(newRoot, (node) => {
            this.byUid.set(node.uid, node);
        });

        // 2. 按 uid（或拖动映射）把旧节点的包裹元素 / 显示实例搬过来。
        //    注意：先收集「被搬走的 wrapper」，旧模型里没被搬走的稍后移除。
        //
        //    **必须防重复认领**：拖动后兄弟节点会整体错位（第 3 章从
        //    uid 0/2 变成 0/1），而「按相同 uid 复用」会把已经映射给别的
        //    节点（被拖走的 0/1）的 wrapper/CM 再认领一次。两个模型节点
        //    共用一个 DOM 后，后处理的那个会把前一个的内容替换掉，表现为
        //    宽度/内容错乱，直到重新进入编辑刷新才恢复。
        const displays = new Map<string, DisplayEntry>();
        const transferredWrappers = new Set<HTMLElement>();
        const claimedWrappers = new Set<HTMLElement>();
        const claimedDisplays = new Set<NodeDisplay>();
        walkAll(newRoot, (node) => {
            const sourceUid = reverseRemap.get(node.uid) ?? node.uid;
            // 认领顺序（越靠前越可信）：
            //   1. 拖动映射 / 同 uid 且内容完全相同；
            //   2. 内容指纹（删除导致的 uid 整体前移）；
            //   3. 同 uid（改名：内容变了，但 wrapper 还能原地复用）。
            const byUid = oldByUid.get(sourceUid);
            let oldNode: MapNode | undefined;
            if (byUid && !claimedOldNodes.has(byUid) && contentKeyOf(byUid) === contentKeyOf(node)) {
                oldNode = byUid;
            }
            if (!oldNode) oldNode = takeByContent(node);
            if (!oldNode) {
                const sameUid = oldByUid.get(node.uid);
                if (sameUid && !claimedOldNodes.has(sameUid)) oldNode = sameUid;
            }
            if (oldNode) claimedOldNodes.add(oldNode);
            if (oldNode?.wrapper && !claimedWrappers.has(oldNode.wrapper)) {
                node.wrapper = oldNode.wrapper;
                claimedWrappers.add(oldNode.wrapper);
                node.measured = oldNode.measured;
                node.width = oldNode.width;
                node.height = oldNode.height;
                transferredWrappers.add(oldNode.wrapper);
            }
            const entry = oldNode ? oldDisplays.get(oldNode.uid) : undefined;
            // 显示实例跟着它原来的 wrapper 走：实例只能被认领一次。
            //
            // 注意不要写成「wrapper 被认领过就跳过」——上面按 uid 复用
            // wrapper 时已经把它加进 claimedWrappers 了。必须允许
            // **本节点刚认领的那个 wrapper** 继续认领它的显示实例，
            // 否则每次 setData 都会把所有匹配的 mini-CM 全部销毁重建
            // （实测大文档一次拖动回写要 800ms+）。
            if (entry && !claimedDisplays.has(entry.display)) {
                if (!node.wrapper) {
                    if (!claimedWrappers.has(entry.wrapper)) {
                        node.wrapper = entry.wrapper;
                        claimedWrappers.add(entry.wrapper);
                        transferredWrappers.add(entry.wrapper);
                    }
                }
                // 文档内容若已变化（改名 / 拖动跨链转换），ensureContent 会
                // 发现 sourceDoc 不一致并重建成新的
                if (node.wrapper === entry.wrapper) {
                    node.display = entry.display;
                    claimedDisplays.add(entry.display);
                    displays.set(node.uid, {
                        display: entry.display,
                        wrapper: entry.wrapper,
                        node,
                        kind: node.kind,
                        // 沿用旧实例的档位：ensureContent 会检查它是否仍符合当前档
                        mode: entry.mode,
                    });
                    node.placeholder = false;
                }
            }
        });

        // 3. 销毁未复用的显示实例 / 移除未复用的 wrapper
        //    先建一份「活着的实例」集合：以前对每个旧实例都扫一遍新表，
        //    N 个节点就是 O(N²)，删掉一个节点后特别明显。
        const liveDisplays = new Set<NodeDisplay>();
        for (const item of displays.values()) liveDisplays.add(item.display);
        for (const [uid, entry] of oldDisplays) {
            if (!liveDisplays.has(entry.display)) {
                entry.display.destroy();
                // wrapper 可能已经被新节点接手，绝不能误删
                if (!transferredWrappers.has(entry.wrapper)) entry.wrapper.remove();
                // uid 只在调试时用，避免 lint 抱怨未使用
                void uid;
            }
        }
        if (oldRoot) {
            walkAll(oldRoot, (node) => {
                if (node.wrapper && !transferredWrappers.has(node.wrapper)) {
                    node.wrapper.remove();
                }
            });
        }
        this.displays = displays;

        // 4. 重建挂载集合（DOM 里还在 nodeLayer 的才算挂载）。
        //
        // 必须按**新模型 + DOM 实际父节点**重建，不能拿旧的 mounted uid
        // 到新模型里查：删除一个节点后，后面兄弟的路径式 uid 会整体前移
        // （0/2/0 → 0/1/0），用旧 uid 查到的要么不存在、要么根本是另一个
        // 节点。那些真正还挂在画布上的子节点会因此漏出 mounted 集合，
        // 而 relayout() 只给 mounted 里的节点写 transform —— 它们的 DOM
        // 就停在删除前的位置，表现为「下一个兄弟的子节点位置乱一下」，
        // 直到收起再展开（走 mountNode）才被重新定位。
        this.mounted.clear();
        walkAll(newRoot, (node) => {
            if (node.wrapper?.parentElement === this.nodeLayer) {
                this.mounted.add(node.uid);
            }
        });
        // 集合是重建的，版本号对不上旧值：下一轮不要跳过可见性同步
        this.mountedVersion += 1;

        // 5. 重建元素外观；新节点 / 内容变化的节点重新量尺寸
        this.progressiveCount = 0;
        // 只有首次渲染同步建一批真实 CM；后续更新全部交给 pump 按需换真
        this.eagerDisplayBudget = oldRoot ? 0 : PROGRESSIVE_THRESHOLD;
        const toMeasure: MapNode[] = [];
        walkAll(newRoot, (node) => {
            this.ensureWrapper(node);
            this.ensureContent(node);
            // 内容变了的节点 ensureContent 会重建显示实例并把 measured 置 false
            if (!node.measured || node.width <= 0 || node.height <= 0) {
                toMeasure.push(node);
            }
        });
        // 统一量：一次布局而不是每个节点一轮强制重排
        this.measureNodes(toMeasure);

        // 6. 布局 + 连线 + 展开按钮 + 视口
        this.relayout();
        if (!opts?.keepView && !this.hasFit) {
            this.fit();
        }
        this.updateViewport();
        this.options.onViewChange();
        this.scheduleViewport();
        // CM/widget 的真实尺寸要到下一帧才稳定
        this.scheduleMeasureSettle();
    }

    /** 当前模型根节点。 */
    getRoot(): MapNode | null {
        return this.root;
    }

    /** 按 uid 取模型节点。 */
    getNode(uid: string): MapNode | null {
        if (!this.root) return null;
        return this.byUid.get(uid) ?? findMapNode(this.root, uid);
    }

    /** 按 uid 取显示实例（编辑入口用）。 */
    getDisplay(uid: string): NodeDisplay | null {
        return this.displays.get(uid)?.display ?? null;
    }

    /**
     * 按 uid 取显示实例的渲染模式（全量 / 轻量；没有实例时为 null）。
     *
     * 给「临时强制全量、用完要降档」的调用方判断是否真的改过档：
     * 本来就是全量的话，收尾时不必再重建一遍。
     */
    getDisplayMode(uid: string): 'full' | 'lite' | null {
        return this.displays.get(uid)?.mode ?? null;
    }

    /** 遍历全部已创建的显示实例（选区复位用）。 */
    forEachDisplay(visit: (uid: string, display: NodeDisplay) => void): void {
        for (const [uid, entry] of this.displays) visit(uid, entry.display);
    }

    /** 同步一个节点的展开标记（展开层级设置 / 大纲联动后调用）。 */
    setNodeExpand(uid: string, expand: boolean): void {
        const node = this.byUid.get(uid);
        if (!node) return;
        node.expand = expand;
    }

    /**
     * 按默认展开层级重设整棵树的展开状态。
     *
     * @param level 深度 >= level 且有子节点的节点收起
     * @returns 被收起的 uid 集合（上层记入 collapsedUids）
     */
    applyExpandLevel(level: number): Set<string> {
        const collapsed = new Set<string>();
        if (this.root) {
            walkAll(this.root, (node) => {
                const collapse = node.depth >= level && node.children.length > 0;
                node.expand = !collapse;
                if (collapse) collapsed.add(node.uid);
            });
        }
        this.relayout();
        this.updateViewport();
        this.options.onViewChange();
        return collapsed;
    }

    /** 全部展开。 */
    expandAll(): void {
        if (this.root) expandSubtree(this.root);
        this.relayout();
        this.updateViewport();
        this.options.onViewChange();
    }

    /** 展开某个节点的全部祖先并重排（大纲 / 搜索跳转）。 */
    revealUid(uid: string): boolean {
        if (!this.root) return false;
        const changed = expandAncestors(this.root, uid);
        if (changed) {
            this.relayout();
            this.updateViewport();
        }
        return changed;
    }

    // ==================================================================
    // 外观状态
    // ==================================================================

    /** 设置选中节点（只影响类名）。 */
    setSelected(uid: string | null): void {
        const previous = this.selectedUid;
        this.selectedUid = uid;
        if (previous) this.refreshWrapperClasses(this.byUid.get(previous));
        if (uid) this.refreshWrapperClasses(this.byUid.get(uid));
    }

    /**
     * 设置多选集合（Ctrl 点 / Ctrl 框选）。
     *
     * 多选和单选是两套独立的标记：框选时 selectedUid 可能还停在某个节点上，
     * 但删除要按整个集合来。这里只负责刷类名，集合本身由上层（mindmapApp）
     * 持有 —— 构造新树、删除节点后上层要重新给一次。
     */
    setMultiSelected(uids: Iterable<string>): void {
        const next = new Set(uids);
        // 先刷新失去多选标记的节点，再刷新新标记的
        for (const uid of this.multiSelected) {
            if (!next.has(uid)) this.refreshWrapperClasses(this.byUid.get(uid));
        }
        this.multiSelected = next;
        for (const uid of next) this.refreshWrapperClasses(this.byUid.get(uid));
    }

    /** 当前多选集合（副本）。 */
    getMultiSelected(): string[] {
        return [...this.multiSelected];
    }

    /** 设置编辑中的节点（编辑期间不被虚拟化卸下）。 */
    setEditing(uid: string | null): void {
        const previous = this.editingUid;
        this.editingUid = uid;
        if (previous) this.refreshWrapperClasses(this.byUid.get(previous));
        if (uid) {
            this.refreshWrapperClasses(this.byUid.get(uid));
            // 编辑目标必须在 DOM 里
            const node = this.byUid.get(uid);
            if (node && node.wrapper && node.wrapper.parentElement !== this.nodeLayer) {
                this.mountNode(node);
            }
        } else {
            // 编辑期间滚动滚轮缩放可能跨过了降级阈值：那时不能重建实例
            // （会销毁正在编辑的 mini-CM），统一拖到会话结束后补切档。
            this.syncRenderTier();
        }
    }

    /** 节点「展开到最大行数」标记（去/去行数截断）。 */
    setNodeExpandedFlag(uid: string, expanded: boolean): void {
        if (expanded) this.expandedFlags.add(uid);
        else this.expandedFlags.delete(uid);
        const node = this.byUid.get(uid);
        if (!node) return;
        this.refreshWrapperClasses(node);
        // 去掉截断会改变高度：重新量 + 重排
        if (node.wrapper) this.measureNode(node);
        this.relayout();
        this.updateViewport();
    }

    /** 节点内容是否被尺寸上限截断。 */
    isNodeClamped(uid: string): boolean {
        const node = this.byUid.get(uid);
        const wrapper = node?.wrapper;
        if (!wrapper) return false;
        return (
            wrapper.scrollHeight > wrapper.clientHeight + 1 ||
            wrapper.scrollWidth > wrapper.clientWidth + 1
        );
    }

    /** 更新搜索高亮（命中 + 当前项）。 */
    setSearchHighlight(hits: string[], current: string | null): void {
        this.searchHits = new Set(hits);
        this.searchCurrent = current;
        for (const uid of this.mounted) {
            this.refreshWrapperClasses(this.byUid.get(uid));
        }
    }

    /**
     * 拖动后 uid 会整体变化：把按 uid 记的运行时标记一并重定向。
     *
     * @param remap 旧 uid → 新 uid
     */
    remapFlags(remap: Map<string, string>): void {
        const mapUid = (uid: string): string => remap.get(uid) ?? uid;
        const reverse = (set: Set<string>): Set<string> => {
            const next = new Set<string>();
            for (const uid of set) next.add(mapUid(uid));
            return next;
        };
        const expanded = reverse(this.expandedFlags);
        this.expandedFlags.clear();
        for (const uid of expanded) this.expandedFlags.add(uid);
        const hits = reverse(this.searchHits);
        this.searchHits = hits;
        if (this.searchCurrent) this.searchCurrent = mapUid(this.searchCurrent);
    }

    /** 切换明暗主题：重建显示实例（token 颜色跟着 CM 主题走）。 */
    setTheme(theme: ThemeType): void {
        this.applyThemeVars();
        // 主题只影响颜色，不影响尺寸；但必须在每个显示实例里生效。
        // 直接全部销毁、按需懒建（已挂载的会立即重建）。
        for (const entry of this.displays.values()) entry.display.destroy();
        this.displays.clear();
        for (const node of this.byUid.values()) {
            node.display = null;
            node.placeholder = false;
            node.wrapper?.replaceChildren();
        }
        this.queue.length = 0;
        this.queued.clear();
        this.progressiveCount = 0;
        // 主题切换要给已挂载节点重建真实 CM，允许一轮同步创建
        this.eagerDisplayBudget = PROGRESSIVE_THRESHOLD;
        for (const uid of this.mounted) {
            const node = this.byUid.get(uid);
            if (node) this.ensureContent(node);
        }
        this.relayout();
        this.updateViewport();
        this.scheduleMeasureSettle();
        void theme;
    }

    /**
     * 设置缩放降级阈值与两个档位的开关（百分比）。
     *
     * 两个阈值把缩放分成三档，跨越阈值时整树按新档重建内容：
     * - zoom >= lite：全量渲染；
     * - plain <= zoom < lite：降级（文本节点轻量 CM，媒体只显示摘要）；
     * - zoom < plain：纯文本（不建任何 CM）。
     *
     * 两个开关默认关闭：关闭的档位无论缩放多小都不会进入，
     * 因此默认行为是「任何缩放比例都全量渲染」。
     *
     * @param litePercent 降级阈值（1-100）
     * @param plainPercent 纯文本阈值（1-100，超过降级阈值时按降级阈值处理）
     * @param liteEnabled 是否启用降级档（缺省沿用当前值）
     * @param plainEnabled 是否启用纯文本档（缺省沿用当前值）
     */
    setZoomRenderThresholds(
        litePercent: number,
        plainPercent: number,
        liteEnabled: boolean = this.liteEnabled,
        plainEnabled: boolean = this.plainEnabled
    ): void {
        const toRatio = (value: number): number =>
            Math.min(100, Math.max(1, value)) / 100;
        const lite = toRatio(litePercent);
        // plain 高于 lite 时没有意义（会出现空档），钳到 lite
        const plain = Math.min(toRatio(plainPercent), lite);
        const enabledChanged =
            liteEnabled !== this.liteEnabled || plainEnabled !== this.plainEnabled;
        if (
            lite === this.liteZoom &&
            plain === this.plainZoom &&
            !enabledChanged
        ) {
            return;
        }
        this.liteZoom = lite;
        this.plainZoom = plain;
        this.liteEnabled = liteEnabled;
        this.plainEnabled = plainEnabled;
        // 开关变化必须强制重算档位：回差逻辑会让「关闭某个档」卡在原档里
        // （例如当前在纯文本档、用户关掉它，缩放仍低于阈值 → 不越过回差
        // 边界就永远出不来）。这里直接按无回差目标档同步。
        this.syncRenderTier(enabledChanged);
    }

    /**
     * 当前缩放「应该」处的档位（无回差）。
     *
     * 关闭的档位直接跳过：纯文本关掉后哪怕 zoom 很小也最多降到降级档；
     * 两个都关掉则始终是全量档。
     */
    private directTier(): RenderTier {
        const zoom = this.zoom;
        if (this.plainEnabled && zoom < this.plainZoom) return 2;
        if (this.liteEnabled && zoom < this.liteZoom) return 1;
        return 0;
    }

    /**
     * 当前缩放应处的档位。
     *
     * 带回差（2%）：滚轮在阈值附近来回时不会反复触发整树重建 ——
     * 每跨一次阈值都要重建内容 + 重量，抖动一下就是几百毫秒。
     */
    private tierForZoom(): RenderTier {
        const zoom = this.zoom;
        // 先算「无回差」目标档，再按缩放方向决定是否要越过阈值 2% 才生效。
        // 不能只比较相邻档：编辑期间缩放被挂起，结束后可能一次跨两档
        // （例如从 100% 直接滚到 30%），必须一次算到最终档。
        const target: RenderTier = this.directTier();
        if (target === this.renderTier) return target;
        // 当前所在档已被用户关闭：直接跳出去，不走回差。否则缩放仍在
        // 原阈值的死区内（比如 30% < 纯文本阈值 40%），会永远卡在原档。
        if (
            (this.renderTier === 2 && !this.plainEnabled) ||
            (this.renderTier === 1 && !this.liteEnabled)
        ) {
            return target;
        }
        const latch = 0.02;
        const goingDown = target > this.renderTier;
        // 本次要跨过的阈值：向下 = 目标档的上边界；向上 = 当前档的下边界
        const boundary = goingDown
            ? target === 2
                ? this.plainZoom
                : this.liteZoom
            : this.renderTier === 2
              ? this.plainZoom
              : this.liteZoom;
        const deadZone = boundary * latch;
        if (goingDown) {
            return zoom < boundary - deadZone ? target : this.renderTier;
        }
        return zoom > boundary + deadZone ? target : this.renderTier;
    }

    /**
     * 缩放变化后同步档位（无变化时零开销）。
     *
     * @param force 忽略回差、直接按 directTier 切换（开关变化时用）
     */
    private syncRenderTier(force = false): void {
        const next = force ? this.directTier() : this.tierForZoom();
        if (next === this.renderTier) return;
        // 编辑中不能整树重建：applyRenderTier 会销毁所有显示实例，
        // 正在编辑的 mini-CM 也在其中（会话持有它的引用，销毁后直接坏掉）。
        // 编辑结束（setEditing(null)）时会再同步一次。
        if (this.editingUid !== null) return;
        this.applyRenderTier(next);
    }

    /**
     * 切换渲染档：销毁所有显示实例，按新档重建整树内容并重量。
     *
     * 只在跨阈值时发生（回差避免了抖动），一次几百毫秒可以接受；
     * 换来的是小缩放下不再维持成百上千个 live preview 装饰与 widget。
     */
    private applyRenderTier(tier: RenderTier): void {
        this.renderTier = tier;
        // CSS 钩子：纯文本档可以进一步去掉阴影之类的装饰
        this.container.dataset.lwmTier = String(tier);
        // 换真队列只服务全量 / 轻量档
        this.queue.length = 0;
        this.queued.clear();
        if (this.pumpTimer !== null) {
            clearTimeout(this.pumpTimer);
            this.pumpTimer = null;
        }
        if (!this.root) return;

        // 1) 销毁全部实例（wrapper 保留，DOM 复用），清空内容
        for (const entry of this.displays.values()) entry.display.destroy();
        this.displays.clear();
        for (const node of this.byUid.values()) {
            node.display = null;
            node.placeholder = false;
            node.wrapper?.replaceChildren();
        }

        // 2) 按新档重建内容。档 2 下 ensureContent 只写纯文本占位；
        //    档 1 下仍走渐进预算（先 24 个轻量 CM，其余排队换真）。
        //    手势进行中（滚轮缩放跨档）不预建：24 个 CM 同步造出来
        //    要上百毫秒，等缩放停下后交给换真泵慢慢补。
        this.progressiveCount = 0;
        this.eagerDisplayBudget = this.interactionActive() ? 0 : PROGRESSIVE_THRESHOLD;
        const toMeasure: MapNode[] = [];
        walkAll(this.root, (node) => {
            this.ensureWrapper(node);
            this.ensureContent(node);
            toMeasure.push(node);
        });
        this.eagerDisplayBudget = 0;

        // 3) 内容形态变了（源码 ↔ 轻量 CM ↔ 纯文本）：全部重量一次。
        //    批量测量只触发一次强制布局，比逐节点量便宜得多。
        this.measureNodes(toMeasure);
        this.relayout();
        this.updateViewport();
        this.scheduleMeasureSettle();
    }

    /**
     * 显示实例 LRU 淘汰开关（设置项，默认关闭）。
     *
     * 从关到开时立刻执行一轮淘汰，而不是等下一次 createDisplay：
     * 用户可能在关闭状态下已经攒了几百个离屏实例，打开设置后应当马上
     * 释放到上限，而不是继续保留。
     */
    setDisplayCacheEnabled(enabled: boolean): void {
        if (this.displayCacheEnabled === enabled) return;
        this.displayCacheEnabled = enabled;
        if (enabled) this.enforceDisplayCap();
    }

    /** 性能模式开关：false = 不做视口裁剪（所有节点常驻 DOM）。 */
    /**
     * 手势期间是否放弃合成层提升（设置：「手势期间保持清晰」）。
     *
     * 默认关闭：拖动时给世界层、缩放时给缩放层加 will-change，手势期间
     * 每帧只改合成属性，帧率最好；但合成层中的文字只能用灰度抗锯齿
     * （实测次像素彩边归零、Laplacian 214.72 / 192.36 对 194.68）。
     *
     * 开启后手势期间不再加这两个 class：世界层/缩放层始终是普通层，
     * Chromium 每帧按当前比例重新栅格化，文字在运动中也保持 LCD 次像素
     * 抗锯齿；代价是每帧重绘视口（大文档可能掉帧）。切换时顺手把可能
     * 残留的 class 清掉，免得设置改了但要等下一次手势才生效。
     *
     * @param enabled - true = 手势期间也保持清晰（不加 will-change）
     */
    setGestureCrisp(enabled: boolean): void {
        this.gestureCrisp = enabled;
        // 只切一个 class：真正的「不提升」写在 CSS 里（.lwm-canvas.lwm-crisp
        // 覆盖 lwm-panning / lwm-zooming 的 will-change）。这样平移时的
        // cursor: grabbing 之类挂在原 class 上的样式不受影响。
        this.canvasEl.classList.toggle('lwm-crisp', enabled);
    }

    setVirtualization(enabled: boolean): void {
        if (this.virtualization === enabled) return;
        this.virtualization = enabled;
        if (enabled) {
            this.updateViewport();
        } else if (this.root) {
            walkVisible(this.root, (node) => {
                if (node.wrapper) this.mountNode(node);
            });
            this.updateLinksVisibility();
            this.updateExpandButtonsVisibility();
            this.visibilityVersion = this.mountedVersion;
        }
    }

    /**
     * 容器尺寸变化后的轻量更新（节点尺寸不受画布宽高影响）。
     *
     * 尺寸变了（例如隐藏/显示大纲）时把视口位移补偿一半的差值，
     * 内容在视觉上保持居中——不重置用户的缩放比例。
     */
    resize(): void {
        if (!this.active) return;
        const rect = this.container.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        if (this.lastViewWidth > 0 && this.lastViewHeight > 0) {
            this.panX += (rect.width - this.lastViewWidth) / 2;
            this.panY += (rect.height - this.lastViewHeight) / 2;
            this.applyTransform();
        }
        this.lastViewWidth = rect.width;
        this.lastViewHeight = rect.height;
        this.updateViewport();
        this.options.onViewChange();
    }

    /** 显示 / 隐藏。 */
    setActive(active: boolean): void {
        this.active = active;
        if (!active) return;
        // 隐藏期间量出来的尺寸是 0：重新量一遍再布局
        let needMeasure = false;
        if (this.root) {
            walkAll(this.root, (node) => {
                if (!node.measured || node.width <= 0 || node.height <= 0) needMeasure = true;
            });
        }
        if (needMeasure && this.root) {
            this.progressiveCount = 0;
            walkAll(this.root, (node) => {
                this.ensureWrapper(node);
                this.ensureContent(node);
                this.measureNode(node);
            });
        }
        this.relayout();
        // 每次切回导图都 fit 一次（与旧实现一致，容器尺寸可能已经变了）
        this.fit();
        this.updateViewport();
        this.scheduleMeasureSettle();
    }

    // ==================================================================
    // 节点 DOM / 测量
    // ==================================================================

    /** 确保节点有包裹元素，并刷新外观。 */
    private ensureWrapper(node: MapNode): HTMLElement {
        if (!node.wrapper) {
            node.wrapper = document.createElement('div');
        }
        this.refreshWrapperClasses(node);
        return node.wrapper;
    }

    /** 统一写类名 / data-*（uid 变化、状态变化都走这里）。 */
    private refreshWrapperClasses(node: MapNode | undefined | null): void {
        if (!node?.wrapper) return;
        const classes = ['lwm-node', `lwm-node-${node.kind}`];
        if (this.expandedFlags.has(node.uid)) classes.push('lwm-node-expanded');
        if (this.editingUid === node.uid) classes.push('lwm-node-editing');
        if (this.selectedUid === node.uid || this.multiSelected.has(node.uid)) {
            classes.push('lwm-node-selected');
        }
        if (this.searchHits.has(node.uid)) classes.push('lwm-search-hit');
        if (this.searchCurrent === node.uid) classes.push('lwm-search-current');
        if (this.drag?.uid === node.uid) classes.push('lwm-node-dragging');
        if (this.dropCandidate?.targetUid === node.uid) classes.push('lwm-node-drop-target');
        // 属性值没变就不写：每次 setData / relayout 都会把整棵树刷一遍，
        // 几百个节点重复写 className / dataset / 自定义属性会让样式系统
        // 白做无效化与重算。先比较再写，代价是一次字符串比较。
        const className = classes.join(' ');
        if (node.wrapper.className !== className) node.wrapper.className = className;
        const dataset = node.wrapper.dataset;
        if (dataset.uid !== node.uid) dataset.uid = node.uid;
        if (dataset.kind !== node.kind) dataset.kind = node.kind;
        const depth = String(node.depth);
        if (dataset.depth !== depth) dataset.depth = depth;

        // 节点底色轮换：用实时模式的标题色板 h1~h6（CSS 里再混一点透明）。
        // uid 是路径式的（"0/2/1"），最后一段就是同级序号 —— 同级节点依次
        // 换到下一个颜色；再叠一个 depth 偏移，避免直接相连的父子撞成同色。
        // 色板本身和层级无关：根、一级、二级……用的都是这一套颜色。
        const lastSlash = node.uid.lastIndexOf('/');
        const siblingIndex = Number(node.uid.slice(lastSlash + 1)) || 0;
        const tintIndex = (siblingIndex + node.depth) % HEADING_TINT_FALLBACKS.length;
        const tint = `var(--livewritemd-h${tintIndex + 1}-color, ${HEADING_TINT_FALLBACKS[tintIndex]})`;
        // getPropertyValue 只读样式表计算出的声明值，不触发排版
        if (node.wrapper.style.getPropertyValue('--lwm-node-tint') !== tint) {
            node.wrapper.style.setProperty('--lwm-node-tint', tint);
        }
        if (node.kind === 'heading') {
            const level = Number(node.data._headingLevel ?? 0);
            if (level >= 1 && level <= 6) {
                const levelText = String(level);
                if (dataset.level !== levelText) dataset.level = levelText;
            } else if (dataset.level !== undefined) {
                delete dataset.level;
            }
        } else if (dataset.level !== undefined) {
            delete dataset.level;
        }
        if (node.note) {
            if (node.wrapper.title !== node.note) node.wrapper.title = node.note;
        } else if (node.wrapper.hasAttribute('title')) {
            node.wrapper.removeAttribute('title');
        }
    }

    /**
     * 确保节点有内容：优先复用同文档的显示实例，否则按渐进策略
     * 创建真实 mini-CM 或静态占位。
     */
    private ensureContent(node: MapNode): void {
        const wrapper = node.wrapper;
        if (!wrapper) return;
        const { doc, sentinel } = this.options.computeDoc(node);
        // 档位决定这个节点应该长什么样：全量/轻量 CM，或纯文本占位。
        // 编辑中的节点永远用全量实例：编辑要能看到行内元素、表格 widget，
        // 提交后 finishEdit 的 refreshNode 会再把它降回当前档位。
        const wantMode: 'full' | 'lite' | 'plain' =
            this.editingUid === node.uid
                ? 'full'
                : this.renderTier === 2
                  ? 'plain'
                  : this.renderTier === 1 && !TEXT_KINDS.has(node.kind)
                    ? 'plain'
                    : this.renderTier === 1
                      ? 'lite'
                      : 'full';

        const entry = this.displays.get(node.uid);
        if (entry) {
            // 实例档位与当前渲染档不符（缩放下了阈值）：先销毁，
            // 下面按 wantMode 重建。
            const modeOk = entry.mode === wantMode;
            if (
                modeOk &&
                entry.display.sourceDoc === doc &&
                entry.display.sentinel === sentinel
            ) {
                entry.node = node;
                entry.wrapper = wrapper;
                // 包裹元素可能被重建过：CM 不在里面才搬，避免无谓 DOM 变更
                if (entry.display.container.parentElement !== wrapper) {
                    wrapper.replaceChildren(entry.display.container);
                }
                node.display = entry.display;
                node.placeholder = false;
                return;
            }
            // 文档变了 / 档位不符：旧实例作废，重建（尺寸也要重量）
            entry.display.destroy();
            this.displays.delete(node.uid);
            node.display = null;
        }

        // 占位内容没变就原地复用，别重建 DOM、也别重量。
        //
        // setData 每次都会走完整棵树；占位节点没有 display entry，以前一律
        // 在这里 replaceChildren + measured=false。纯文本档 / 渐进换真队列
        // 里的占位动辄几百个，改一个字提交一次就是几百次 DOM 重建和上千次
        // 强制布局（实测 640 节点文档：单节点改名提交 1195 次布局、56ms）。
        //
        // 判定条件必须严：DOM 里那一个子元素就是占位、文本与本次要写的完全
        // 一致、并且尺寸已经量过。三条都满足时，占位内容与排版都和上次一样，
        // 直接沿用即可。文本变了 / 是真实 CM 容器 / 没量过，都走下面的重建。
        if (!entry && node.measured && node.wrapper) {
            const child = node.wrapper.firstElementChild;
            if (
                child instanceof HTMLElement &&
                child.classList.contains('lwm-node-placeholder') &&
                child.textContent === this.placeholderTextOf(node, doc)
            ) {
                node.display = null;
                node.placeholder = true;
                return;
            }
        }

        // 走到这里说明内容要重新生成（新建 CM 或占位文本）。
        // 必须清掉 measured：复用来的节点可能带着「上一份内容」的尺寸，
        // 尤其占位节点（缓存里没有 display entry）以前完全不会重测，
        // 拖动/改名后就会一直用旧宽度，直到点进编辑再失焦才被刷新。
        node.measured = false;

        if (wantMode === 'plain') {
            // 纯文本档：不建 CM、不进换真队列（档 2 下没有「之后换真」）
            this.setPlaceholder(node, this.placeholderTextOf(node, doc));
            return;
        }
        if (wantMode === 'lite') {
            // 降级档：轻量 CM 仍走渐进预算/换真队列，避免一次造几百个
            if (this.progressiveCount < this.eagerDisplayBudget) {
                this.progressiveCount += 1;
                this.createDisplay(node, 'lite');
                return;
            }
            this.setPlaceholder(node, this.placeholderTextOf(node, doc));
            this.enqueueSwap(node.uid);
            return;
        }
        if (this.progressiveCount < this.eagerDisplayBudget) {
            this.progressiveCount += 1;
            this.createDisplay(node, 'full');
            return;
        }
        this.setPlaceholder(node, doc);
        this.enqueueSwap(node.uid);
    }

    /**
     * 纯文本占位应该显示什么。
     *
     * - 全量档的占位（渐进换真之前）就是完整源码，尺寸与真实渲染接近；
     * - 降级 / 纯文本档：媒体节点只显示摘要（`代码 · 12 行` 之类），
     *   把整段围栏源码塞进一个格子既没意义又拖慢测量；
     * - 纯文本档的文本节点用节点文字（node.text），比源码少了 `#`/`-`
     *   这类标记，更接近「只看文字」。
     */
    private placeholderTextOf(node: MapNode, doc?: string): string {
        const source = doc ?? this.options.computeDoc(node).doc;
        if (this.renderTier === 0) return source;
        if (this.renderTier === 1 && TEXT_KINDS.has(node.kind)) return source;
        return node.text || source;
    }

    /**
     * 创建真实显示实例（节点尺寸随后由 measureNode 更新）。
     *
     * @param mode 实例档位；缺省按当前渲染档（档 1 = 轻量、不挂 live preview）
     */
    private createDisplay(node: MapNode, mode?: 'full' | 'lite'): void {
        const wrapper = node.wrapper;
        if (!wrapper) return;
        const effectiveMode: 'full' | 'lite' =
            mode ?? (this.renderTier === 1 ? 'lite' : 'full');
        // 兜底：调用方本该先销毁旧实例（换主题 / 内容变更）。若没销毁就
        // 直接建新的，旧 EditorView 会变成没有引用的孤儿（监听器、
        // ResizeObserver 都还在），大文档反复拖动会越来越卡。
        if (node.display) {
            node.display.destroy();
            this.displays.delete(node.uid);
            node.display = null;
        }
        const { doc, sentinel } = this.options.computeDoc(node);
        const display = createNodeDisplay({
            doc,
            sentinel,
            theme: this.options.getTheme(),
            codeLanguages: this.options.codeLanguages,
            // 轻量档只省显示用的 live preview 扩展，编辑态仍会补回交互插件
            lite: effectiveMode === 'lite',
            // 显示态按钮（mermaid 宽度、表格加行/列）改了本地文档后，
            // 立刻交给上层回写源文档
            onDisplayChange: (text) => this.options.onDisplayEdit?.(node, text),
        });
        wrapper.replaceChildren(display.container);
        node.display = display;
        node.placeholder = false;
        // 新建的 CM 要等浏览器/CM 自己完成首帧布局，尺寸才可信
        this.settleUids.add(node.uid);
        this.displays.set(node.uid, {
            display,
            wrapper,
            node,
            kind: node.kind,
            mode: effectiveMode,
        });
        // 新内容尺寸可能与占位不同：调用方负责重新测量
        this.enforceDisplayCap();
    }

    /** 降级为静态占位（同字体源码文本，尺寸与真实渲染接近）。 */
    private setPlaceholder(node: MapNode, doc?: string): void {
        const wrapper = node.wrapper;
        if (!wrapper) return;
        const text = doc ?? this.placeholderTextOf(node);
        const el = document.createElement('div');
        el.className = 'lwm-node-display lwm-node-placeholder';
        el.textContent = text;
        wrapper.replaceChildren(el);
        node.display = null;
        node.placeholder = true;
        // 占位文本换了，尺寸就可能变：交给调用方重新测量
        node.measured = false;
    }

    /**
     * 测量节点内容尺寸并写死宽高。
     *
     * 挂到离屏测量层量（同一次任务内挂回），避免 max-content 影响画布上的
     * 最终排版；容器隐藏时量出来是 0，退回一个保守估计，等 setActive 再量。
     */
    private measureNode(node: MapNode): void {
        this.measureNodes([node]);
    }

    /**
     * 批量测量节点尺寸（一次强制布局量完）。
     *
     * 单个 measureNode 每调用一次都是一轮「改样式 → 读 rect」的强制同步
     * 重排；一次拖动回写要重量几十个节点时就是几十轮，drop 的手感全耗在
     * 这里。批量做法：先把所有 wrapper 挂进离屏测量层（只写 DOM），
     * 再统一读 rect（一次布局），最后统一写回尺寸/挂回画布。
     */
    private measureNodes(nodes: MapNode[]): void {
        interface Pending {
            node: MapNode;
            wrapper: HTMLElement;
            mounted: boolean;
        }
        const pending: Pending[] = [];
        for (const node of nodes) {
            const wrapper = node.wrapper;
            if (!wrapper) continue;
            pending.push({
                node,
                wrapper,
                mounted: wrapper.parentElement === this.nodeLayer,
            });
            // 量之前清掉写死的尺寸，让 max-width / line-clamp 自然生效
            wrapper.style.width = 'max-content';
            wrapper.style.height = 'auto';
            this.measureLayer.appendChild(wrapper);
        }
        if (pending.length === 0) return;

        // 文本节点量两遍，取宽高各自的最大值：
        //   ① 文本态（整块源码）：所有块级/行内标记露出，live 的宽度补偿
        //      （openScale/openWrap）照常生效。点在某个元素上时单元格必须
        //      容得下这一版排版，否则「渲染一行、点开变两行」。
        //   ② 显示态（原选区）：不点开任何元素时的真实外观。文本态的宽度补偿
        //      可能让折行结构与显示态不同（整体少占一行也是可能的），只量
        //      文本态会把高度量小，CSS line-clamp 就把最后一行裁掉 ——
        //      用户看到的「第二行像消失了」。取 max 两个状态都放得下。
        //
        // 显示态的 live 预览会把块级标记（`#`、`-`）与行内标记（`**`、`` ` ``）
        // 压掉（选区停在哨兵行）；一进编辑，光标落进那一行标记就重新出现。
        // 只测文本节点：root 不可编辑、meta 无正文；代码/表格/公式/mermaid
        // 是 widget 渲染，源码态宽度没有意义。
        const restoreSelections: Array<{
            view: NodeDisplay['view'];
            display: NodeDisplay;
            selection: EditorSelection;
        }> = [];
        for (const item of pending) {
            const display = item.node.display;
            // 编辑中的节点绝对不能动选区（会打断输入 / 输入法组合态）；
            // 已销毁的实例更不能派发 —— 旧 position 落到已换掉的文档上会
            // 把 CM 的 state 搞坏（后续 update 里 lineAt 越界）。
            if (
                !display ||
                display.destroyed ||
                display.editing ||
                !TEXT_KINDS.has(item.node.kind)
            ) {
                continue;
            }
            try {
                const docLength = display.view.state.doc.length;
                if (docLength === 0) continue;
                const selection = display.view.state.selection;
                display.view.dispatch({
                    selection: EditorSelection.single(0, docLength),
                });
                restoreSelections.push({ view: display.view, display, selection });
            } catch {
                /* 视图在测量过程中被销毁：忽略 */
            }
        }

        // 第一遍：文本态。先全部挂好再统一读取（一次布局，后面读缓存）
        const sourceRects = pending.map((item) => item.wrapper.getBoundingClientRect());

        // 选区复位：显示态重新隐藏标记；尺寸取两遍的最大值
        for (const item of restoreSelections) {
            if (item.display.destroyed) continue;
            try {
                item.view.dispatch({ selection: item.selection });
            } catch {
                /* 视图已销毁：忽略 */
            }
        }

        // 第二遍：显示态
        const renderRects = pending.map((item) => item.wrapper.getBoundingClientRect());

        pending.forEach((item, index) => {
            let width = Math.ceil(Math.max(sourceRects[index].width, renderRects[index].width));
            let height = Math.ceil(Math.max(sourceRects[index].height, renderRects[index].height));
            // 量到 0 = 容器 display:none（或测量层被浏览器折叠）。
            // 这时给一个估值，但**不标记为已测量** —— setActive(true)
            // 会检查 measured 并重新量；标 true 的话隐藏时打开的导图
            // 会永远用估值。
            const estimated = width <= 0 || height <= 0;
            if (estimated) {
                width = Math.min(320, Math.max(48, item.node.text.length * 9 + 16));
                height = 28;
            }
            item.node.width = Math.max(24, width);
            item.node.height = Math.max(18, height);
            item.node.measured = !estimated;
            item.wrapper.style.width = `${item.node.width}px`;
            item.wrapper.style.height = `${item.node.height}px`;
            if (item.mounted) {
                this.nodeLayer.appendChild(item.wrapper);
                this.positionNode(item.node);
            } else {
                item.wrapper.remove();
            }
        });
    }

    /**
     * 安排一次「首帧之后」的补偿性重测。
     *
     * 为什么要补：
     * - mini-CM 的排版要等浏览器完成一帧（CodeMirror 自己的 measure
     *   在 rAF 里）才稳定，创建当下立刻量可能拿到的是初始估算；
     * - 图片 widget 是异步加载的，mermaid/表格也会在首帧后重排；
     * - 字体（document.fonts）可能还没就绪，量到的是回退字体宽度。
     *
     * 这些情况下节点宽高会停在旧值，用户必须点进编辑再失焦触发
     * refreshNode 才恢复。这里在下一帧和 300ms 后各补一次轻量重测，
     * 只量已经挂载的节点，尺寸确实变了才重排。
     */
    private scheduleMeasureSettle(forceAll = false): void {
        if (forceAll) this.settleForceAll = true;
        if (this.settleRaf === null) {
            // 双 rAF：第一个回调时样式已应用，第二个回调时 CM 的 measure
            //（它自己也排了 rAF）大概率已经跑完
            this.settleRaf = requestAnimationFrame(() => {
                this.settleRaf = requestAnimationFrame(() => {
                    this.settleRaf = null;
                    this.settleMounted();
                });
            });
        }
        if (this.settleTimer === null) {
            this.settleTimer = setTimeout(() => {
                this.settleTimer = null;
                this.settleMounted();
            }, 300);
        }
    }

    /**
     * 重测「需要补偿」的节点；尺寸有变化就重排。
     *
     * 默认只量 settleUids（新建过真实显示实例的节点）——拖动回写后
     * 绝大多数节点尺寸是可信的，没必要整棵树再量一遍（那是 drop 卡顿的
     * 大头）。字体就绪 / 图片加载这类全局事件会置 settleForceAll，
     * 下一次做全量。
     */
    private settleMounted(): void {
        if (!this.root || !this.active) return;
        const forceAll = this.settleForceAll;
        this.settleForceAll = false;

        // 小图连离屏节点一起量（第一次测量可能早于 CM 首帧布局）；
        // 大图只看挂载集合，避免一次 settle 把整棵树拿去做强制布局。
        let visibleCount = 0;
        walkVisible(this.root, () => {
            visibleCount += 1;
        });
        const measureOffscreen = visibleCount <= 400;

        const targets: MapNode[] = [];
        const previous = new Map<MapNode, { width: number; height: number }>();
        const consider = (node: MapNode): void => {
            // 编辑中的节点不能动（重测会把 DOM 挪进离屏层，打断输入）
            if (node.uid === this.editingUid || this.drag?.uid === node.uid) return;
            if (!measureOffscreen && node.wrapper?.parentElement !== this.nodeLayer) return;
            if (!node.wrapper) return;
            targets.push(node);
            previous.set(node, { width: node.width, height: node.height });
        };
        if (forceAll) {
            // 字体/图片影响所有节点，且可能改变任意节点：量全部可见节点
            walkVisible(this.root, consider);
        } else {
            for (const uid of [...this.settleUids]) {
                const node = this.byUid.get(uid);
                // 已删除节点的 uid 不会自己从集合里消失：以前只跳过不删除，
                // 长时间反复增删之后这个集合只涨不落，每次 settle 都要白跑
                // 一遍。顺手清掉（uid 是路径式的，别的节点可能重新用上它，
                // 但那会重新 add，不影响正确性）。
                if (!node) {
                    this.settleUids.delete(uid);
                    continue;
                }
                consider(node);
            }
        }
        if (targets.length === 0) return;

        // 批量测量：一次强制布局，而不是每个节点一轮
        this.measureNodes(targets);
        let changed = false;
        for (const node of targets) {
            const before = previous.get(node);
            if (!before) continue;
            this.settleUids.delete(node.uid);
            if (
                Math.abs(node.width - before.width) > 0.5 ||
                Math.abs(node.height - before.height) > 0.5
            ) {
                changed = true;
            }
        }
        if (changed) {
            this.relayout();
            this.updateViewport();
            this.options.onViewChange();
        }
    }

    /** 重新测量所有节点（设置里的尺寸类变更）。 */
    remeasureAll(): void {
        if (!this.root) return;
        const all: MapNode[] = [];
        walkAll(this.root, (node) => {
            this.ensureWrapper(node);
            this.ensureContent(node);
            all.push(node);
        });
        this.measureNodes(all);
        this.relayout();
        this.updateViewport();
    }

    /**
     * 节点内容变化后刷新：重建显示实例、重新测量、重排。
     *
     * @param uid 节点 uid
     * @param force 忽略渐进阈值，立即按**当前渲染档**建实例
     *              （纯文本档建占位；编辑入口请用 ensureEditDisplay）
     */
    refreshNode(uid: string, force = false): void {
        const node = this.byUid.get(uid);
        if (!node) return;
        const entry = this.displays.get(uid);
        if (entry) {
            entry.display.destroy();
            this.displays.delete(uid);
            node.display = null;
        }
        if (node.wrapper) node.wrapper.replaceChildren();
        if (force) {
            this.ensureWrapper(node);
            // 纯文本档不建 CM；其余档立即建（轻量档建轻量实例）
            if (this.renderTier === 2 && this.editingUid !== uid) {
                this.setPlaceholder(node);
            } else {
                this.createDisplay(node);
            }
        } else {
            this.ensureContent(node);
        }
        if (node.wrapper) this.measureNode(node);
        this.relayout();
        this.updateViewport();
        this.scheduleMeasureSettle();
    }

    /**
     * 编辑结束、文本**没有变化**时的快速收尾。
     *
     * 全量档下编辑用的本来就是完整的显示实例（enterEdit 只是换了组
     * compartment），exitEdit 之后它就已经是正常的显示态。以前无条件走
     * refreshNode(uid, true) —— 那会 destroy + 重建整个 mini-CM，一次失焦
     * 白花 30~40ms，用户能明显看到一顿。这里只把编辑期间被撑高的盒子
     * 收回原高度（Enter 加行又删掉的情况），再重排一次。
     *
     * 轻量 / 纯文本档不能就地保留：实例是全量档的，和当前档不符，必须
     * 重建降档。返回 false 让调用方走 refreshNode。
     *
     * @param uid 节点 uid
     * @param baseHeight 进入编辑前的节点高度（0 = 没记录，不恢复）
     * @returns 是否已就地处理完
     */
    finishEditDisplay(uid: string, baseHeight: number, baseWidth?: number): boolean {
        const node = this.byUid.get(uid);
        if (!node) return false;
        const entry = this.displays.get(uid);
        if (!entry || entry.mode !== 'full' || this.renderTier !== 0) return false;
        let changed = false;
        // 编辑期间 growNodeHeight 只增不减，文本没变就恢复到进编辑前的高度
        const target =
            Number.isFinite(baseHeight) && baseHeight > 0 ? baseHeight : node.height;
        if (Math.abs(node.height - target) > 0.5) {
            node.height = target;
            if (node.wrapper) {
                node.wrapper.style.height = `${target}px`;
                this.positionNode(node);
            }
            changed = true;
        }
        // 宽度回缩：数学块进编辑时可能按源码自然宽度撑宽了（见 setNodeWidth），
        // 文本没变就退回进编辑前的宽度；文本变了会走 commit → 完整重测。
        if (
            baseWidth !== undefined &&
            Number.isFinite(baseWidth) &&
            baseWidth > 0 &&
            Math.abs(node.width - baseWidth) > 0.5
        ) {
            node.width = baseWidth;
            if (node.wrapper) {
                node.wrapper.style.width = `${baseWidth}px`;
                this.positionNode(node);
            }
            changed = true;
        }
        if (changed) {
            this.relayout();
            this.updateViewport();
            this.options.onViewChange();
        }
        return true;
    }

    /**
     * 直接改写节点盒子的宽度（编辑态按内容宽度撑宽用）。
     *
     * 与 growNodeHeight 同款：只写 node.width + 内联样式，然后 relayout，
     * **不动 node.height**。数学块编辑时源码（LaTeX）往往比渲染出来的公式长，
     * 不撑宽的话编辑区会挤成一条窄缝、只能左右滚动，很难改。
     *
     * @param uid 节点 uid
     * @param width 目标宽度（px）
     * @returns 是否真的改了宽度
     */
    setNodeWidth(uid: string, width: number): boolean {
        const node = this.byUid.get(uid);
        const next = Math.ceil(width);
        if (!node?.wrapper || !Number.isFinite(next) || next <= 0) return false;
        if (Math.abs(node.width - next) <= 0.5) return false;
        node.width = next;
        node.measured = true;
        node.wrapper.style.width = `${next}px`;
        this.positionNode(node);
        this.relayout();
        this.updateViewport();
        this.options.onViewChange();
        return true;
    }

    /**
     * 编辑入口：保证节点有一个**全量**显示实例可翻转成编辑态。
     *
     * 缩放降级档（1）下挂的是轻量实例（没有 live preview 显示扩展），
     * 纯文本档（2）下根本没有实例；直接进去编辑会看到「行内元素全变源码」。
     * 这里无视档位强制建一个全量实例。编辑结束后 finishEdit 走
     * refreshNode(uid, true)，会按当前档位降回去。
     */
    ensureEditDisplay(uid: string): NodeDisplay | null {
        const node = this.byUid.get(uid);
        if (!node?.wrapper) return null;
        const entry = this.displays.get(uid);
        if (entry) {
            if (entry.mode === 'full') return entry.display;
            entry.display.destroy();
            this.displays.delete(uid);
            node.display = null;
            node.wrapper.replaceChildren();
        }
        this.createDisplay(node, 'full');
        // 全量实例的尺寸可能在上一档下没量准：补量一次再进编辑
        this.measureNode(node);
        return this.displays.get(uid)?.display ?? null;
    }

    /**
     * 编辑中按内容高度撑高节点（只增不减，绝不重建显示实例）。
     *
     * 节点的盒子尺寸是布局时写死的；编辑时按回车新增一行、或长行自动折行后，
     * 内容会比盒子高，默认会被编辑态的滚动区裁掉。这里在编辑会话里把盒子
     * 撑到内容高度，节点下方的兄弟会跟着重排；提交后 finishEdit 会走
     * refreshNode 完整重测，那时才允许回缩。
     *
     * @param contentHeight 内容区高度（不含节点边框）
     * @returns 是否真的变高了
     */
    growNodeHeight(uid: string, contentHeight: number): boolean {
        const node = this.byUid.get(uid);
        if (!node) return false;
        const wrapper = node.wrapper;
        if (!wrapper) return false;
        // 盒子是 border-box：内容高度之外还要留出上下边框，
        // 否则刚好差 2~6px，最后一行仍会被裁掉一点
        const style = getComputedStyle(wrapper);
        const border =
            (parseFloat(style.borderTopWidth) || 0) +
            (parseFloat(style.borderBottomWidth) || 0);
        const next = Math.ceil(contentHeight + border);
        if (!Number.isFinite(next) || next <= node.height + 0.5) return false;
        node.height = next;
        node.measured = true;
        wrapper.style.height = `${next}px`;
        this.positionNode(node);
        this.relayout();
        this.updateViewport();
        this.options.onViewChange();
        return true;
    }

    /** 显示实例超上限时，把最旧的离屏实例降级回占位。 */
    private enforceDisplayCap(): void {
        // 设置关闭时不做任何淘汰：离屏实例保留，回到视口直接复用
        if (!this.displayCacheEnabled) return;
        if (this.displays.size <= DISPLAY_CACHE_CAP) return;
        for (const [uid, entry] of this.displays) {
            if (uid === this.editingUid) continue;
            if (entry.wrapper.parentElement === this.nodeLayer) continue;
            entry.display.destroy();
            this.displays.delete(uid);
            const node = entry.node;
            node.display = null;
            if (node.wrapper) this.setPlaceholder(node);
            if (this.displays.size <= DISPLAY_CACHE_CAP) return;
        }
    }

    /** 把节点加入换真队列（去重）。 */
    private enqueueSwap(uid: string): void {
        // 纯文本档没有「换真」这回事：占位就是最终形态
        if (this.renderTier === 2) return;
        if (this.queued.has(uid)) return;
        this.queued.add(uid);
        this.queue.push(uid);
        this.schedulePump();
    }

    /**
     * 手势是否正在进行：拖动 / 节点拖动 / 刚滚过滚轮。
     *
     * 换真泵据此暂停：创建 mini-CM 是主线程重活，绝不能在用户拖动
     * 或缩放时干。占位文本本身就能正常显示，松手后 100ms 内补齐。
     */
    private interactionActive(): boolean {
        return (
            this.pointer !== null ||
            this.drag !== null ||
            performance.now() - this.lastWheelTime < WHEEL_ACTIVE_MS
        );
    }

    /** 换真泵：每次 ~16ms 把一批可见占位换成真实显示实例。 */
    private schedulePump(delay = 16): void {
        if (this.pumpTimer !== null) return;
        this.pumpTimer = setTimeout(() => {
            this.pumpTimer = null;
            // 排队期间缩到了纯文本档：队列已清空，不再造 CM
            if (this.renderTier === 2) return;
            // 手势进行中只轮询不干活。这里必须轮询而不是直接 return：
            // mountNode/enqueueSwap 不会在松手时再触发一次 schedulePump，
            // 直接丢弃定时器会让队列一直躺着。
            if (this.interactionActive()) {
                this.schedulePump(PUMP_PAUSE_MS);
                return;
            }
            const batch = this.queue.splice(0, PROGRESSIVE_BATCH);
            let changed = false;
            const created: MapNode[] = [];
            for (const uid of batch) {
                this.queued.delete(uid);
                const node = this.byUid.get(uid);
                if (!node?.wrapper || !node.placeholder) continue;
                // 只换「在画布上」的占位：离屏节点等挂载时再入队，避免
                // 大文档一次性把几十个 CM 全建出来（内存/首屏都受益）
                if (node.wrapper.parentElement !== this.nodeLayer) continue;
                // 已排队期间可能被 setData 复用了真实显示实例（拖动回写里
                // 很常见）：此时再走 createDisplay 会白造一个 CM，旧的
                // EditorView 还会因为没人 destroy 而泄漏，所以直接跳过。
                if (node.display) continue;
                this.createDisplay(node);
                created.push(node);
                changed = true;
            }
            // 一批统一测：避免每个换真节点各触发一次强制布局
            this.measureNodes(created);
            if (changed) {
                this.relayout();
                this.updateViewport();
                // 换真后的 CM 也是下一帧才排好，补一次
                this.scheduleMeasureSettle();
            }
            if (this.queue.length > 0) {
                this.schedulePump();
            }
        }, delay);
    }

    /**
     * 手势结束：立刻恢复换真，不必等下一次 100ms 轮询。
     *
     * 拖动期间队列只积压不处理；松手后用户马上就能看到真实渲染，
     * 而不是先盯着占位文本看半秒。
     */
    private resumePump(): void {
        if (this.queue.length === 0) return;
        if (this.pumpTimer !== null) {
            clearTimeout(this.pumpTimer);
            this.pumpTimer = null;
        }
        this.schedulePump(0);
    }

    // ==================================================================
    // 挂载 / 虚拟化
    // ==================================================================

    /** 挂载节点到画布。 */
    private mountNode(node: MapNode): void {
        if (!node.wrapper) return;
        this.refreshWrapperClasses(node);
        const alreadyMounted =
            this.mounted.has(node.uid) && node.wrapper.parentElement === this.nodeLayer;
        if (node.wrapper.parentElement !== this.nodeLayer) {
            this.nodeLayer.appendChild(node.wrapper);
        }
        this.mounted.add(node.uid);
        // 挂载集合真的变了才升级版本（可见性同步据此去重）
        if (!alreadyMounted) this.mountedVersion += 1;
        // 兜底：挂到画布上的 wrapper 必须真的有内容。
        //
        // setTheme 会清空所有 wrapper，然后只给「当时已挂载」的节点重建；
        // 而主题设置是即时生效的（导图隐藏 / 首屏还没挂载时也会走）。那些
        // 当时没挂载的节点就成了空壳，且 measured 还是 true，setActive 的
        // 「需要重量」判断不会触发重建 —— 切回导图只看到一片空白。
        //
        // 这里按「既没有 display 也没有 placeholder」判断空壳，正好不会
        // 碰正常的占位节点（placeholder=true）和真实实例（display!=null）。
        if (!node.display && !node.placeholder && !node.wrapper.firstElementChild) {
            this.ensureContent(node);
        }
        this.positionNode(node);
        // 占位节点进入视口：排队换真。
        //
        // 这里**不能**再用 `displays.size < DISPLAY_CACHE_CAP` 做门槛：
        // 缓存满 64 个之后，新进入视口的占位节点永远排不上队；而淘汰
        // 只发生在 createDisplay 里 —— 于是死锁，屏幕上留下一批永远是
        // 纯文本占位的节点（看起来「渲染和宽度都不对」，点进编辑再失焦
        // 才被 refreshNode 强制变成真实 CM）。让 pump 去创建，创建时
        // enforceDisplayCap 会自动淘汰离屏实例。
        if (node.placeholder) this.enqueueSwap(node.uid);
        // 之前离屏、没赶上 settle 的新实例：进入视口后补一次
        else if (this.settleUids.has(node.uid)) this.scheduleMeasureSettle();
    }

    /** 从画布卸下节点（显示实例保留在缓存里）。 */
    private unmountNode(uid: string): void {
        // 编辑中的节点不能卸；正在拖动的节点也不能卸 ——
        // 拖动时 wrapper 跟着指针走，但布局盒还停在原位，
        // 自动平移可能把「布局盒」移出视口，误把用户手里的节点收走。
        if (uid === this.editingUid || uid === this.drag?.uid) return;
        const node = this.byUid.get(uid);
        if (!node?.wrapper) return;
        if (node.wrapper.parentElement === this.nodeLayer) node.wrapper.remove();
        if (this.mounted.delete(uid)) this.mountedVersion += 1;
    }

    /**
     * 节点左上角的世界坐标写到 transform。
     *
     * 用 2D `translate()` 而不是 `translate3d()`：3D 变换会让每个节点都成为
     * 独立合成层，合成层里的文字用灰度抗锯齿 —— 整张导图的字都会比实时模式
     * 「糊一点」。2D 平移不建层，节点文字的渲染路径才和实时模式一致。
     */
    private positionNode(node: MapNode): void {
        if (!node.wrapper) return;
        node.wrapper.style.transform = `translate(${node.x}px, ${node.y}px)`;
    }

    /**
     * 按当前视口挂载 / 卸载节点。
     *
     * 平移缩放都只改世界层 transform；这里只维护「哪些节点在 DOM 里」。
     * 用 setTimeout 合并高频调用（无头 Chrome 的 rAF 不可靠，项目老坑）。
     */
    private updateViewport(): void {
        if (!this.active || !this.root) return;
        // 容器尺寸用缓存：updateViewport 在平移时每帧都跑，而上一帧刚
        // 挂载/卸载过节点，此时 getBoundingClientRect 会强制同步布局。
        // 尺寸由 ResizeObserver → resize() 维护，只有还没量过时才回退读取。
        const view = this.viewSize();
        if (view.width <= 0 || view.height <= 0) return;
        const margin = VIEW_MARGIN / this.zoom;
        const left = (-this.panX) / this.zoom - margin;
        const top = (-this.panY) / this.zoom - margin;
        const right = (view.width - this.panX) / this.zoom + margin;
        const bottom = (view.height - this.panY) / this.zoom + margin;

        // 先记下这一轮「应该可见」的集合，再统一卸载：
        // 折叠操作会让整棵子树从 walkVisible 里消失，如果只在遍历里卸载，
        // 已经挂载但不再被访问的节点会永远留在 DOM 里（层级 0 实测 27 个）。
        const visible = new Set<string>();
        walkVisible(this.root, (node) => {
            const inside =
                node.x + node.width >= left &&
                node.x <= right &&
                node.y + node.height >= top &&
                node.y <= bottom;
            const shouldMount = !this.virtualization || inside || node.uid === this.editingUid;
            if (!shouldMount) return;
            visible.add(node.uid);
            if (node.wrapper?.parentElement !== this.nodeLayer) this.mountNode(node);
            else if (!this.mounted.has(node.uid)) {
                this.mounted.add(node.uid);
                this.mountedVersion += 1;
            }
        });
        for (const uid of Array.from(this.mounted)) {
            if (!visible.has(uid)) this.unmountNode(uid);
        }
        // 没有任何节点进出 DOM：连线/按钮可见性与上一帧相同，整轮跳过
        if (this.mountedVersion !== this.visibilityVersion) {
            this.visibilityVersion = this.mountedVersion;
            this.updateLinksVisibility();
            this.updateExpandButtonsVisibility();
        }
        // 视口 / 容器尺寸变化：缩略图范围与视口框都要跟上
        this.scheduleMinimap();
    }

    /** 合并同一轮的高频视口更新。 */
    private scheduleViewport(): void {
        if (this.viewTimer !== null) return;
        this.viewTimer = setTimeout(() => {
            this.viewTimer = null;
            this.updateViewport();
            this.options.onViewChange();
        }, 0);
    }

    // ==================================================================
    // 连线 / 展开按钮
    // ==================================================================

    /** 重排后同步节点位置、连线、展开按钮。 */
    private relayout(): void {
        if (!this.root) return;
        // 节点坐标/尺寸要变了：包围盒缓存与缩略图位图都作废
        this.boundsCache = null;
        this.minimapRaster = null;
        layoutMap(this.root);
        for (const uid of this.mounted) {
            const node = this.byUid.get(uid);
            if (node) this.positionNode(node);
        }
        this.syncLinksExtent();
        this.syncLinks();
        this.syncExpandButtons();
        // 节点坐标变了：缩略图里的方块要重画（合并到下一轮）
        this.scheduleMinimap();
    }

    /**
     * 把连线 SVG 的尺寸撑到整棵树的范围。
     *
     * 外层的 `<svg>` 默认只有 0×0。虽然可以靠 CSS `overflow: visible`
     * 把内容画到视口外，但不同浏览器/导出路径（foreignObject）表现不一致，
     * 实测会出现「节点都在、线全没了」—— 所以按包围盒显式给宽高。
     * 布局从 (0,0) 向右生长，坐标恒为非负，不需要 viewBox 平移。
     */
    private syncLinksExtent(): void {
        if (!this.root) return;
        const bounds = this.getBounds();
        if (!bounds) return;
        // 正交折线全部落在节点包围盒内，留一点余量防端点被裁
        const pad = 64;
        this.linksSvg.setAttribute('width', String(Math.max(1, Math.ceil(bounds.right + pad))));
        this.linksSvg.setAttribute('height', String(Math.max(1, Math.ceil(bounds.bottom + pad))));
    }

    /** 同步连线（只保留可见父子对）。 */
    private syncLinks(): void {
        if (!this.root) return;
        const alive = new Set<string>();
        walkVisible(this.root, (node) => {
            const parent = node.parent;
            if (!parent || !parent.expand) return;
            alive.add(node.uid);
            let path = this.linkPaths.get(node.uid);
            if (!path) {
                path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                path.classList.add('lwm-link');
                this.linksSvg.appendChild(path);
                this.linkPaths.set(node.uid, path);
            }
            // —— 正交连线（逻辑树样式）——
            // 多个子节点：父节点右侧引出一条横线 → 一条贯穿所有子节点中心的
            // 竖线（并列总线）→ 每个子节点各引一条横线。
            // 只有一个子节点：一条横线直接连过去，不需要竖线。
            const x1 = parent.x + parent.width;
            const y1 = parent.y + parent.height / 2;
            const x2 = node.x;
            const y2 = node.y + node.height / 2;
            // 总线放在父子间距的正中，留出展开按钮的视觉空间
            const busX = x1 + H_GAP / 2;
            const single = parent.children.length === 1;
            const d = single
                ? `M ${x1} ${y1} L ${x2} ${y2}`
                : `M ${x1} ${y1} H ${busX} V ${y2} H ${x2}`;
            path.setAttribute('d', d);
        });
        for (const [uid, path] of this.linkPaths) {
            if (!alive.has(uid)) {
                path.remove();
                this.linkPaths.delete(uid);
            }
        }
        this.updateLinksVisibility();
        // 刚做过一次全量可见性同步：记下版本，avoid 下一帧 viewport 重复
        this.visibilityVersion = this.mountedVersion;
    }

    /** 连线可见性：端点任一在 DOM 里就显示（跨视口的长线也不会丢）。 */
    private updateLinksVisibility(): void {
        for (const [uid, path] of this.linkPaths) {
            const node = this.byUid.get(uid);
            const parentMounted = node?.parent ? this.mounted.has(node.parent.uid) : false;
            path.style.display = this.mounted.has(uid) || parentMounted ? '' : 'none';
        }
    }

    /** 同步展开按钮（有子节点的可见节点各一个）。 */
    private syncExpandButtons(): void {
        if (!this.root) return;
        const alive = new Set<string>();
        walkVisible(this.root, (node) => {
            if (node.children.length === 0) return;
            alive.add(node.uid);
            let button = this.expandButtons.get(node.uid);
            if (!button) {
                button = document.createElement('div');
                button.className = 'lwm-expand-btn';
                button.dataset.uid = node.uid;
                this.nodeLayer.appendChild(button);
                this.expandButtons.set(node.uid, button);
            }
            button.dataset.uid = node.uid;
            button.dataset.expanded = node.expand ? 'true' : 'false';
            // 收起态显示「后面藏了几项」（全部后代，含更深层）；
            // 展开态仍是减号，两个状态靠 CSS 的 ::before 切换文案
            button.dataset.count =
                node.descendantCount > 99 ? '99+' : String(node.descendantCount);
            button.title = node.expand
                ? '收起'
                : `展开（收起了 ${node.descendantCount} 项）`;
            button.style.transform = `translate(${node.x + node.width + 4}px, ${
                node.y + node.height / 2 - 8
            }px)`;
        });
        for (const [uid, button] of this.expandButtons) {
            if (!alive.has(uid)) {
                button.remove();
                this.expandButtons.delete(uid);
            }
        }
        this.updateExpandButtonsVisibility();
    }

    private updateExpandButtonsVisibility(): void {
        if (!this.virtualization) {
            for (const button of this.expandButtons.values()) button.style.display = '';
            return;
        }
        for (const [uid, button] of this.expandButtons) {
            const node = this.byUid.get(uid);
            if (!node) continue;
            const parentMounted = node.parent ? this.mounted.has(node.parent.uid) : true;
            button.style.display =
                this.mounted.has(uid) || parentMounted ? '' : 'none';
        }
    }

    // ==================================================================
    // 视口操作
    // ==================================================================

    /**
     * 世界层变换（唯一改动 translate/scale 的地方）。
     *
     * 平移与缩放拆成两层：
     * - `.lwm-world` 只写 translate。拖动时带 will-change，但平移不改变比例，
     *   Chromium 可以安全复用 1x 位图，文字不发虚；
     * - `.lwm-scaler` 只写 scale。平时不提升，浏览器按当前比例直接栅格化；
     *   只有在滚轮缩放的过程中才临时提升（见 markZooming）。
     *
     * 以前两者写在同一个元素上：will-change 把位图钉在 1x，scale 只是拉伸
     * 采样，非 100% 缩放下文字整体发虚、边缘出现彩边。
     *
     * 这里用 2D `translate()`，**不要**换成 `translate3d()`：3D 变换会让元素
     * 无条件变成合成层，而合成层里的文字只能用灰度抗锯齿（实测次像素彩边
     * 完全消失、Laplacian 217 → 215），和实时模式一比就显得「有点糊」。
     * 2D 平移不建层，静止时文字和实时模式走同一条次像素渲染路径。
     *
     * 平移量必须对齐到**设备像素**：拖动期间世界层仍是合成层（lwm-panning），
     * 合成层被小数平移时，Chromium 会拿整层位图做双线性重采样 —— 实测整数平移
     * 的 Laplacian 能量约 138，小数平移只剩 49（约六成），整屏文字就是「有点糊」。
     * 而 panX/panY 是浮点数（fit 居中、缩放锚点换算都会得到 401.738 这种值），
     * 所以这里只把写进 CSS 的值按 devicePixelRatio 取整；this.panX/panY 保持原值，
     * 命中测试、缩放锚点、缩略图视口框的数学都不受影响。
     */
    private applyTransform(): void {
        const dpr = window.devicePixelRatio || 1;
        const panX = Math.round(this.panX * dpr) / dpr;
        const panY = Math.round(this.panY * dpr) / dpr;
        this.worldEl.style.transform = `translate(${panX}px, ${panY}px)`;
        this.scalerEl.style.transform = `scale(${this.zoom})`;
        // 高倍缩放下的阅读增强：只切一个 class，真正的「压底色」写在 CSS 里。
        // 这里只在跨过阈值时动 DOM，平移/缩放的每一帧不会重复写 classList。
        const hiZoom = this.zoom >= HI_ZOOM_THRESHOLD;
        if (hiZoom !== this.hiZoomActive) {
            this.hiZoomActive = hiZoom;
            this.canvasEl.classList.toggle('lwm-hi-zoom', hiZoom);
        }
        // 视口框跟着动；重绘是合并的，拖动画布时也不会每帧都重画整棵树
        this.scheduleMinimap();
    }

    /**
     * 标记「正在滚轮缩放」：给缩放层临时提升合成层。
     *
     * 缩放时每帧都要改 scale，如果不提升，浏览器每帧都得按新比例重新栅格化
     * 视口内的文字（大文档会掉帧）。提升后每帧只改合成属性，代价是运动中
     * 文字由缓存位图拉伸（略糊）—— 正在动，看不出来。
     *
     * 手势停下 ZOOM_SETTLE_MS 后撤掉 class，缩放层退回普通渲染，浏览器
     * 按最终比例重新栅格化，文字立刻恢复清晰。
     */
    private markZooming(): void {
        this.canvasEl.classList.add('lwm-zooming');
        if (this.zoomTimer !== null) clearTimeout(this.zoomTimer);
        this.zoomTimer = setTimeout(() => {
            this.zoomTimer = null;
            this.canvasEl.classList.remove('lwm-zooming');
        }, ZOOM_SETTLE_MS);
    }

    /**
     * 撤掉世界层的空闲合成提升。
     *
     * 以前这里是「空闲 160ms 后加 will-change，免得下次拖动第一帧现场建层」。
     * 但 will-change 会把世界层变成合成层，合成层里的文字只能用灰度抗锯齿：
     * 实测有提升时文字次像素彩边完全消失（Laplacian 217 → 192，且缩放后
     * 旧位图还会被拉伸），和实时模式并排一看就是「有点糊」。
     *
     * 现在清晰度优先：静止时绝不提升，只有拖动（lwm-panning）和滚轮缩放
     * （lwm-zooming）期间才临时提升。代价是每次开始拖动的第一帧要现场
     * 建层 + 栅格化（一次性几十 ms），换来的是松手后立刻恢复和实时模式
     * 完全一致的次像素抗锯齿。
     */
    private scheduleWorldLayer(): void {
        this.canvasEl.classList.remove('lwm-layer-ready');
    }

    /**
     * 容器可视尺寸（优先用缓存）。
     *
     * 平移期间每帧都会调用；getBoundingClientRect 在刚改过 DOM 之后会
     * 触发一次同步布局，能省则省。resize()/fit() 会写这两个缓存值。
     */
    private viewSize(): { width: number; height: number } {
        if (this.lastViewWidth > 0 && this.lastViewHeight > 0) {
            return { width: this.lastViewWidth, height: this.lastViewHeight };
        }
        const rect = this.container.getBoundingClientRect();
        if (rect.width > 0) this.lastViewWidth = rect.width;
        if (rect.height > 0) this.lastViewHeight = rect.height;
        return { width: rect.width, height: rect.height };
    }

    /**
     * 可见节点包围盒（带缓存）。
     *
     * 布局是纯数字计算，重排在 relayout 一次完成；之后包围盒不会再变。
     * 缩略图每 40ms 就要用一次，以前每次都遍历整棵树（大文档平移时
     * 等于每帧多走两遍全树）。relayout 负责把缓存置空。
     */
    private getBounds(): MapBounds | null {
        if (!this.root) return null;
        if (!this.boundsCache) this.boundsCache = computeBounds(this.root);
        return this.boundsCache;
    }

    /** 屏幕坐标 → 世界坐标。 */
    private screenToWorld(clientX: number, clientY: number): { x: number; y: number } {
        const rect = this.container.getBoundingClientRect();
        return {
            x: (clientX - rect.left - this.panX) / this.zoom,
            y: (clientY - rect.top - this.panY) / this.zoom,
        };
    }

    /** 以容器内某点为锚缩放。 */
    private zoomAt(screenX: number, screenY: number, nextZoom: number): void {
        const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
        if (zoom === this.zoom) return;
        const worldX = (screenX - this.panX) / this.zoom;
        const worldY = (screenY - this.panY) / this.zoom;
        this.zoom = zoom;
        this.panX = screenX - worldX * zoom;
        this.panY = screenY - worldY * zoom;
        // 缩放进行中：缩放层临时提升为合成层，每帧只改 scale 不重栅格化
        this.markZooming();
        // 跨过降级阈值：先按新档重建内容，再做视口更新
        this.syncRenderTier();
        this.applyTransform();
        this.scheduleViewport();
        // 缩放改变了栅格化比例：撤掉空闲合成层，停下后按新比例再提升
        this.scheduleWorldLayer();
    }

    /** 适应画布。 */
    fit(): void {
        if (!this.root) return;
        const rect = this.container.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const bounds = this.getBounds();
        if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
        const padding = 64;
        const scale = Math.min(
            MAX_ZOOM,
            Math.max(
                MIN_ZOOM,
                Math.min(
                    (rect.width - padding * 2) / bounds.width,
                    (rect.height - padding * 2) / bounds.height,
                    1.25
                )
            )
        );
        this.zoom = scale;
        this.panX = rect.width / 2 - (bounds.left + bounds.width / 2) * scale;
        this.panY = rect.height / 2 - (bounds.top + bounds.height / 2) * scale;
        // fit 已按当前尺寸居中：记下基准，后续 resize 只补偿增量
        this.lastViewWidth = rect.width;
        this.lastViewHeight = rect.height;
        this.hasFit = true;
        // 大文档 fit 出来可能远低于降级阈值：先切档再更新视口，
        // 否则会先把全量节点挂上去再拆掉
        this.syncRenderTier();
        this.applyTransform();
        this.updateViewport();
        this.options.onViewChange();
        // fit 改变缩放：等这一轮渲染稳定后再提升合成层
        this.scheduleWorldLayer();
    }

    /**
     * 直接把缩放设成指定百分比（以容器中心为锚点）。
     *
     * 模式切换用：从 live 进导图时要求固定 100%，而 setActive 里的 fit()
     * 会按整棵树自动算一个缩放。zoomAt 是唯一能同时维护 pan/zoom 与
     * 降级档位的入口，所以这里包一层，不直接改 this.zoom。
     *
     * @param percent 缩放百分比（100 = 原始大小）
     */
    setZoomPercent(percent: number): void {
        const rect = this.container.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        this.zoomAt(rect.width / 2, rect.height / 2, percent / 100);
    }

    /**
     * 视口中心所在的节点（取包含中心点的最深一层）。
     *
     * live → map 的「从当前页中间开始」反向操作用：map → live 时如果
     * 没有选中节点，就以用户正在看的画面中心为准。
     */
    getNodeAtViewportCenter(): MapNode | null {
        if (!this.root) return null;
        const rect = this.container.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const worldX = (rect.width / 2 - this.panX) / this.zoom;
        const worldY = (rect.height / 2 - this.panY) / this.zoom;
        // byUid 含折叠子树里的节点；只从**可见**节点里挑，否则会返回
        // 一个根本不在屏幕上的节点位置
        let best: MapNode | null = null;
        walkVisible(this.root, (node) => {
            if (
                worldX < node.x ||
                worldX > node.x + node.width ||
                worldY < node.y ||
                worldY > node.y + node.height
            ) {
                return;
            }
            // 包含中心点的节点里取最深的一层（节点之间可能有重叠的布局盒子）
            if (!best || node.depth > best.depth) best = node;
        });
        return best;
    }

    /** 把节点平移到容器中心。 */
    centerOn(uid: string): void {
        const node = this.byUid.get(uid);
        if (!node) return;
        const rect = this.container.getBoundingClientRect();
        this.panX = rect.width / 2 - (node.x + node.width / 2) * this.zoom;
        this.panY = rect.height / 2 - (node.y + node.height / 2) * this.zoom;
        this.applyTransform();
        this.updateViewport();
        this.options.onViewChange();
    }

    /** 节点相对容器的屏幕盒子（工具条定位用）。 */
    getNodeRect(
        uid: string
    ): { left: number; top: number; right: number; bottom: number } | null {
        const node = this.byUid.get(uid);
        if (!node) return null;
        const rect = this.container.getBoundingClientRect();
        const left = this.panX + node.x * this.zoom;
        const top = this.panY + node.y * this.zoom;
        return {
            left,
            top,
            right: left + node.width * this.zoom,
            bottom: top + node.height * this.zoom,
        };
    }

    // ==================================================================
    // 缩略图（右下角）
    // ==================================================================

    /** 合并高频重绘：平移 / 缩放每帧都会调到这里。 */
    private scheduleMinimap(): void {
        if (!this.active) return;
        if (this.minimapTimer !== null) return;
        this.minimapTimer = setTimeout(() => {
            this.minimapTimer = null;
            this.drawMinimap();
        }, MINIMAP_REDRAW_MS);
    }

    /**
     * 缩略图坐标映射：世界坐标 → 画布像素。
     *
     * 范围取「可见节点包围盒 ∪ 当前视口」，这样放大到某一角时，
     * 视口框也不会跑出缩略图外。
     */
    private minimapGeometry(): {
        s: number;
        ox: number;
        oy: number;
        /** 容器视口在缩略图里的像素矩形。 */
        view: { x: number; y: number; w: number; h: number };
    } | null {
        if (!this.root) return null;
        const size = this.viewSize();
        if (size.width <= 0 || size.height <= 0) return null;
        const w = MINIMAP_W;
        const h = MINIMAP_H;
        const bounds = this.getBounds();
        if (!bounds) return null;
        const view = {
            left: -this.panX / this.zoom,
            top: -this.panY / this.zoom,
            right: (size.width - this.panX) / this.zoom,
            bottom: (size.height - this.panY) / this.zoom,
        };
        const left = Math.min(bounds.left, view.left);
        const top = Math.min(bounds.top, view.top);
        const right = Math.max(bounds.right, view.right);
        const bottom = Math.max(bounds.bottom, view.bottom);
        const bw = Math.max(1, right - left);
        const bh = Math.max(1, bottom - top);
        const pad = 8;
        const s = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh);
        // 内容在缩略图里居中
        const ox = (w - bw * s) / 2 - left * s;
        const oy = (h - bh * s) / 2 - top * s;
        return {
            s,
            ox,
            oy,
            view: {
                x: ox + view.left * s,
                y: oy + view.top * s,
                w: (view.right - view.left) * s,
                h: (view.bottom - view.top) * s,
            },
        };
    }

    /** 重画缩略图：节点方块 + 视口框（不做文字/连线，保持轻量）。 */
    private drawMinimap(): void {
        const canvas = this.minimapEl;
        if (!this.active || !this.root) {
            canvas.classList.remove('lwm-minimap-visible');
            return;
        }
        const geo = this.minimapGeometry();
        if (!geo) {
            canvas.classList.remove('lwm-minimap-visible');
            return;
        }
        const w = MINIMAP_W;
        const h = MINIMAP_H;
        const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
        const pxW = Math.round(w * dpr);
        const pxH = Math.round(h * dpr);
        if (canvas.width !== pxW || canvas.height !== pxH) {
            canvas.width = pxW;
            canvas.height = pxH;
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        canvas.classList.add('lwm-minimap-visible');

        const dark = this.container.dataset.lwmTheme !== 'light';

        // —— 节点方块：缓存到离屏位图 ——
        // 平移时 geo 不变（内容比视口大时取的是内容包围盒）、节点坐标也不变，
        // 只有视口框在动。重复 walkVisible + 每节点 fillRect 纯属浪费。
        const key = `${geo.s}|${geo.ox}|${geo.oy}|${dpr}|${dark ? 1 : 0}`;
        let raster = this.minimapRaster;
        if (!raster || raster.key !== key) {
            const off = raster?.canvas ?? document.createElement('canvas');
            off.width = pxW;
            off.height = pxH;
            const offCtx = off.getContext('2d');
            if (!offCtx) return;
            offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
            offCtx.clearRect(0, 0, w, h);
            // 缩略图只做定位示意，不跟节点的标题色轮换走：按深度给不同亮度，
            // root 最亮、越深越暗，小图里更容易分清主干和末梢
            const fillFor = (depth: number): string => {
                if (depth === 0) return dark ? '#5d9df0' : '#1c6fb5';
                if (depth === 1) return dark ? 'rgba(148,186,232,0.9)' : 'rgba(56,116,176,0.9)';
                return dark ? 'rgba(198,208,224,0.42)' : 'rgba(86,102,124,0.36)';
            };
            walkVisible(this.root, (node) => {
                if (node.width <= 0 || node.height <= 0) return;
                offCtx.fillStyle = fillFor(node.depth);
                const x = geo.ox + node.x * geo.s;
                const y = geo.oy + node.y * geo.s;
                // 至少 2px：缩到很小时方块仍可见（缩略图只需要「有东西」）
                const rw = Math.max(2, node.width * geo.s);
                const rh = Math.max(2, node.height * geo.s);
                offCtx.fillRect(x, y, rw, rh);
            });
            raster = { key, canvas: off };
            this.minimapRaster = raster;
        }
        // 源位图尺寸就是 pxW×pxH，按 CSS 尺寸 w×h 贴回来（ctx 已带 dpr 变换）
        ctx.drawImage(raster.canvas, 0, 0, w, h);

        // 当前视口框
        ctx.strokeStyle = dark ? 'rgba(255,255,255,0.78)' : 'rgba(30,45,65,0.72)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(
            geo.view.x + 0.75,
            geo.view.y + 0.75,
            Math.max(2, geo.view.w - 1.5),
            Math.max(2, geo.view.h - 1.5)
        );

        // 右下角缩放比例徽标：用户据此判断当前是否已进入降级 / 纯文本档，
        // 也方便对照设置里的两个阈值（缩放以容器中心为准，显示取整百分比）。
        const label = `${Math.round(this.zoom * 100)}%`;
        ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        const labelTextWidth = ctx.measureText(label).width;
        const boxW = Math.ceil(labelTextWidth) + 10;
        const boxH = 15;
        const boxX = w - boxW - 4;
        const boxY = h - boxH - 4;
        // 半透明底：缩略图里节点方块很密，没有底衬时数字看不清
        ctx.fillStyle = dark ? 'rgba(18,20,26,0.72)' : 'rgba(255,255,255,0.82)';
        ctx.fillRect(boxX, boxY, boxW, boxH);
        ctx.fillStyle = dark ? 'rgba(236,241,250,0.95)' : 'rgba(22,32,46,0.88)';
        ctx.fillText(label, boxX + boxW - 5, boxY + boxH - 2);
    }

    /** 缩略图画布坐标 → 世界坐标。 */
    private minimapScreenToWorld(
        clientX: number,
        clientY: number
    ): { x: number; y: number } | null {
        const geo = this.minimapGeometry();
        if (!geo) return null;
        const rect = this.minimapEl.getBoundingClientRect();
        return {
            x: (clientX - rect.left - geo.ox) / geo.s,
            y: (clientY - rect.top - geo.oy) / geo.s,
        };
    }

    /** 按下缩略图：跳转，并进入拖动模式。 */
    private handleMinimapPointerDown(event: PointerEvent): void {
        if (!this.active || event.button === 2) return;
        event.preventDefault();
        event.stopPropagation();
        this.minimapPointerId = event.pointerId;
        try {
            this.minimapEl.setPointerCapture(event.pointerId);
        } catch {
            /* 某些环境不支持捕获：拖动退化为单次点击 */
        }
        this.minimapJumpTo(event.clientX, event.clientY);
    }

    private handleMinimapPointerMove(event: PointerEvent): void {
        if (this.minimapPointerId !== event.pointerId) return;
        event.preventDefault();
        this.minimapJumpTo(event.clientX, event.clientY);
    }

    private handleMinimapPointerUp(event: PointerEvent): void {
        if (this.minimapPointerId !== event.pointerId) return;
        this.minimapPointerId = null;
        try {
            this.minimapEl.releasePointerCapture(event.pointerId);
        } catch {
            /* 已释放 */
        }
    }

    /** 把点击处的世界坐标移到容器中心。 */
    private minimapJumpTo(clientX: number, clientY: number): void {
        const world = this.minimapScreenToWorld(clientX, clientY);
        if (!world) return;
        const rect = this.container.getBoundingClientRect();
        this.panX = rect.width / 2 - world.x * this.zoom;
        this.panY = rect.height / 2 - world.y * this.zoom;
        this.applyTransform();
        this.scheduleViewport();
    }

    // ==================================================================
    // 指针交互
    // ==================================================================

    private handlePointerDown(event: PointerEvent): void {
        if (!this.active || event.button === 2) return;
        const target = event.target as Element | null;

        // 展开按钮：交给 click 处理（要读 ctrlKey），不要启动拖动
        if (target?.closest?.('.lwm-expand-btn')) {
            event.stopPropagation();
            return;
        }

        // mermaid 节点右下角的「放大 / 复制 / 尺寸」按钮组：完全交给 widget
        // 自己处理（按钮的 mousedown 由 CM 的 ignoreEvent 放行）。这里不能
        // 建 node 指针，否则 pointerup 会被当成「单击节点」——第一次点按钮
        // 选中节点，第二次就顺手进了编辑态，按钮看着像失灵。
        if (target?.closest?.('.cm-md-preview-actions, .cm-md-resize-actions')) {
            return;
        }

        const wrapper = target?.closest?.('.lwm-node[data-uid]') as HTMLElement | null;
        const inNode = !!wrapper && wrapper.parentElement === this.nodeLayer;
        const uid = inNode ? (wrapper!.dataset.uid ?? '') : '';
        // 编辑中的节点：CM 自己处理选字/光标（含拖动选择）
        if (inNode && uid === this.editingUid) return;

        // Ctrl / Cmd + 按下：进入「框选或切换选中」手势。
        // 不抢占文字选择：落在 CM 正文里且没拖动时，交给上层当 Ctrl 点处理。
        if (event.ctrlKey || event.metaKey) {
            this.pointer = {
                kind: 'marquee',
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                moved: false,
                fromNode: inNode ? { uid, event } : null,
            };
            this.capturePointer(event.pointerId);
            return;
        }

        if (inNode) {
            // 关键：这里**不能** setPointerCapture。
            // 指针一旦被画布捕获，浏览器会把后续 mousedown/mousemove 也重定向到
            // 画布元素，CodeMirror 挂在 contentDOM 上的 mousedown 收不到事件 ——
            // 表现就是节点里的文字（包括加粗 / 斜体 / 代码 / 表格）怎么拖都
            // 选不中。改为真正开始拖节点时再捕获（见 handlePointerMove）。
            this.pointer = {
                kind: 'node',
                pointerId: event.pointerId,
                uid,
                startX: event.clientX,
                startY: event.clientY,
                moved: false,
                // 落在正文里 = 用户可能是想拖选文字；没按 Alt 时不启动节点拖动
                fromContent: !!target?.closest?.('.cm-content'),
                event,
            };
            return;
        }

        // 空白处：平移画布
        this.pointer = {
            kind: 'pan',
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            panX: this.panX,
            panY: this.panY,
            moved: false,
        };
        this.canvasEl.classList.add('lwm-panning');
        this.capturePointer(event.pointerId);
    }

    /** setPointerCapture 在合成事件/已释放指针上会抛异常，统一兜住。 */
    private capturePointer(pointerId: number): void {
        try {
            this.canvasEl.setPointerCapture?.(pointerId);
        } catch {
            /* 合成事件或指针已失效：忽略 */
        }
    }

    private handlePointerMove(event: PointerEvent): void {
        const pointer = this.pointer;
        if (!pointer || pointer.pointerId !== event.pointerId) return;
        const dx = event.clientX - pointer.startX;
        const dy = event.clientY - pointer.startY;

        if (pointer.kind === 'pan') {
            if (!pointer.moved && Math.abs(dx) + Math.abs(dy) > 3) pointer.moved = true;
            if (!pointer.moved) return;
            this.panX = pointer.panX + dx;
            this.panY = pointer.panY + dy;
            this.applyTransform();
            this.scheduleViewport();
            return;
        }

        // Ctrl 框选：超过阈值才开始画框；没拖动就是一次 Ctrl 点（切换选中）
        if (pointer.kind === 'marquee') {
            if (!pointer.moved) {
                if (Math.abs(dx) + Math.abs(dy) <= 3) return;
                pointer.moved = true;
            }
            this.updateMarquee(pointer.startX, pointer.startY, event.clientX, event.clientY);
            return;
        }

        // node：超过阈值才进入拖动
        if (!this.drag) {
            if (Math.abs(dx) + Math.abs(dy) <= DRAG_THRESHOLD) return;
            pointer.moved = true;
            // 从 CM 正文里按下：让浏览器/CodeMirror 完成文字拖选。
            // Alt+拖动是「我就是要挪这个节点」的显式覆盖。
            if (pointer.fromContent && !event.altKey) return;
            const node = this.byUid.get(pointer.uid);
            if (!node) {
                this.pointer = null;
                return;
            }
            // 确认是拖节点而不是选文字，这时才捕获指针（见 handlePointerDown）
            this.capturePointer(event.pointerId);
            this.drag = {
                uid: pointer.uid,
                node,
                startClientX: pointer.startX,
                startClientY: pointer.startY,
                originX: node.x,
                originY: node.y,
                candidate: null,
                pointerId: event.pointerId,
            };
            this.refreshWrapperClasses(node);
            node.wrapper?.classList.add('lwm-node-dragging');
        }
        this.updateDrag(event);
    }

    /**
     * 更新 Ctrl 框选矩形并回调命中节点。
     *
     * 用屏幕坐标和 getBoundingClientRect 相交判断：节点少（可见节点通常
     * 几十个）、且框选本身是低频手势，没必要再维护一套世界坐标换算。
     */
    private updateMarquee(startX: number, startY: number, endX: number, endY: number): void {
        const rect = this.canvasEl.getBoundingClientRect();
        const left = Math.min(startX, endX) - rect.left;
        const top = Math.min(startY, endY) - rect.top;
        const width = Math.abs(endX - startX);
        const height = Math.abs(endY - startY);
        const style = this.marqueeEl.style;
        style.display = 'block';
        style.left = `${left}px`;
        style.top = `${top}px`;
        style.width = `${width}px`;
        style.height = `${height}px`;

        // 与画布可见节点的屏幕矩形求交
        const box = {
            left: rect.left + left,
            top: rect.top + top,
            right: rect.left + left + width,
            bottom: rect.top + top + height,
        };
        const hits: string[] = [];
        for (const uid of this.mounted) {
            const wrapper = this.byUid.get(uid)?.wrapper;
            if (!wrapper) continue;
            const r = wrapper.getBoundingClientRect();
            if (
                r.right >= box.left &&
                r.left <= box.right &&
                r.bottom >= box.top &&
                r.top <= box.bottom
            ) {
                hits.push(uid);
            }
        }
        this.options.onMarqueeSelect?.(hits);
    }

    /** 拖动中：移动节点、算落点、边缘自动平移。 */
    private updateDrag(event: PointerEvent): void {
        const drag = this.drag;
        if (!drag) return;
        const dx = (event.clientX - drag.startClientX) / this.zoom;
        const dy = (event.clientY - drag.startClientY) / this.zoom;
        const wrapper = drag.node.wrapper;
        if (wrapper) {
            // 拖动中的节点自己有 will-change（独立合成层），小数平移会让
            // Chromium 拿位图做双线性重采样、节点文字发糊；对齐设备像素后
            // 拖动全程都是清晰的。只取整写进 CSS 的值，模型坐标不受影响。
            const dpr = window.devicePixelRatio || 1;
            const tx = Math.round((drag.originX + dx) * dpr) / dpr;
            const ty = Math.round((drag.originY + dy) * dpr) / dpr;
            // 仍写 2D，松手后 positionNode 会写回同一形式，不会闪一下。
            wrapper.style.transform = `translate(${tx}px, ${ty}px)`;
        }

        // 边缘自动平移：每帧移动一小步，指针不动也能继续滚
        const rect = this.container.getBoundingClientRect();
        const localX = event.clientX - rect.left;
        const localY = event.clientY - rect.top;
        this.autoPanDx = localX < AUTO_PAN_EDGE ? AUTO_PAN_STEP : localX > rect.width - AUTO_PAN_EDGE ? -AUTO_PAN_STEP : 0;
        this.autoPanDy = localY < AUTO_PAN_EDGE ? AUTO_PAN_STEP : localY > rect.height - AUTO_PAN_EDGE ? -AUTO_PAN_STEP : 0;
        if (this.autoPanDx !== 0 || this.autoPanDy !== 0) this.startAutoPan();
        else this.stopAutoPan();

        this.updateDropCandidate(event.clientX, event.clientY);
    }

    private startAutoPan(): void {
        if (this.autoPanTimer !== null) return;
        this.autoPanTimer = setTimeout(() => {
            this.autoPanTimer = null;
            if (!this.drag) return;
            if (this.autoPanDx === 0 && this.autoPanDy === 0) return;
            this.panX += this.autoPanDx;
            this.panY += this.autoPanDy;
            this.applyTransform();
            this.updateViewport();
            this.startAutoPan();
        }, 16);
    }

    private stopAutoPan(): void {
        if (this.autoPanTimer !== null) {
            clearTimeout(this.autoPanTimer);
            this.autoPanTimer = null;
        }
    }

    /** 计算指针下方的落点候选并更新高亮。 */
    private updateDropCandidate(clientX: number, clientY: number): void {
        const drag = this.drag;
        if (!drag) return;
        const point = this.screenToWorld(clientX, clientY);
        const excluded = collectSubtreeUids(drag.node);
        let hovered: MapNode | null = null;
        let nearest: MapNode | null = null;
        let nearestDist = Infinity;

        if (!this.root) return;
        walkVisible(this.root, (node) => {
            if (excluded.has(node.uid)) return;
            // 1) 命中（取最深的一个）
            if (
                point.x >= node.x &&
                point.x <= node.x + node.width &&
                point.y >= node.y &&
                point.y <= node.y + node.height
            ) {
                if (!hovered || node.depth > hovered.depth) hovered = node;
            }
            // 2) 最近（兄弟间隙落点）
            const cx = Math.max(node.x, Math.min(point.x, node.x + node.width));
            const cy = Math.max(node.y, Math.min(point.y, node.y + node.height));
            const dist = Math.hypot(point.x - cx, point.y - cy);
            if (dist < nearestDist) {
                nearestDist = dist;
                nearest = node;
            }
        });

        let candidate: DropCandidate | null = null;
        if (hovered) {
            const target = hovered as MapNode;
            if (this.canDrop(drag.uid, target.uid)) {
                candidate = {
                    parentUid: target.uid,
                    prevUid: null,
                    nextUid: null,
                    targetUid: target.uid,
                    line: null,
                };
            }
        }
        // 悬停节点不合法（例如落进段落/媒体节点）或点在空白：用最近节点的兄弟间隙
        if (!candidate && nearest && nearestDist <= 220) {
            const near = nearest as MapNode;
            const parent = near.parent;
            if (parent) {
                const siblings = parent.children.filter((child) => child.expand || child === near);
                const index = siblings.indexOf(near);
                const before = point.y < near.y + near.height / 2;
                const prev = before ? siblings[index - 1] ?? null : near;
                const next = before ? near : siblings[index + 1] ?? null;
                if (this.canDrop(drag.uid, parent.uid)) {
                    candidate = {
                        parentUid: parent.uid,
                        prevUid: prev?.uid ?? null,
                        nextUid: next?.uid ?? null,
                        targetUid: null,
                        line: {
                            x: near.x - 8,
                            y: before ? near.y - V_GAP / 2 : near.y + near.height + V_GAP / 2,
                            width: near.width + 16,
                        },
                    };
                }
            }
        }

        const previous = this.dropCandidate;
        this.dropCandidate = candidate;
        drag.candidate = candidate;
        if (previous?.targetUid) this.refreshWrapperClasses(this.byUid.get(previous.targetUid));
        if (candidate?.targetUid) this.refreshWrapperClasses(this.byUid.get(candidate.targetUid));
        if (candidate?.line) {
            this.dropLine.style.display = '';
            this.dropLine.style.transform = `translate(${candidate.line.x}px, ${candidate.line.y}px)`;
            this.dropLine.style.width = `${candidate.line.width}px`;
        } else {
            this.dropLine.style.display = 'none';
        }
    }

    /** 类型规则交给上层（上层看得到 markdown 语义）。 */
    private canDrop(dragUid: string, parentUid: string): boolean {
        return this.options.canDrop ? this.options.canDrop(dragUid, parentUid) : true;
    }

    private handlePointerUp(event: PointerEvent, fromWindow = false): void {
        const pointer = this.pointer;
        const drag = this.drag;
        if (!pointer && !drag) return;
        if (pointer && pointer.pointerId !== event.pointerId && !fromWindow) return;

        if (drag) this.finishDrag();
        else if (pointer?.kind === 'pan') {
            this.canvasEl.classList.remove('lwm-panning');
            // 松手立刻退回非合成层：文字恢复次像素抗锯齿（见 scheduleWorldLayer）
            this.scheduleWorldLayer();
            this.pointer = null;
            if (!pointer.moved) this.options.onCanvasClick();
        } else if (pointer?.kind === 'marquee') {
            this.pointer = null;
            this.marqueeEl.style.display = 'none';
            if (!pointer.moved) {
                if (pointer.fromNode) {
                    // Ctrl 点节点 = 切换该节点的多选状态（上层按 ctrlKey 判断）
                    const node = this.byUid.get(pointer.fromNode.uid);
                    if (node) {
                        this.options.onNodeClick(
                            node,
                            pointer.fromNode.event as unknown as MouseEvent
                        );
                    }
                } else {
                    // Ctrl 点空白 = 清空多选
                    this.options.onCanvasClick();
                }
            }
        } else if (pointer?.kind === 'node') {
            this.pointer = null;
            // 拖选文字时 moved 也会置位：此时绝不能上报「单击节点」，
            // 否则上层会立刻进入编辑态并把刚选好的选区塌成光标。
            if (!pointer.moved) {
                const node = this.byUid.get(pointer.uid);
                if (node) this.options.onNodeClick(node, event as unknown as MouseEvent);
            }
        }
        try {
            this.canvasEl.releasePointerCapture?.(event.pointerId);
        } catch {
            /* 指针已释放：忽略 */
        }
        // 手势结束：换真泵可以继续建 CM 了
        this.resumePump();
    }

    private handlePointerCancel(event: PointerEvent): void {
        // 拖动被系统取消（触控板手势/窗口失焦）：原地落回，不写文档
        if (this.drag) {
            const drag = this.drag;
            this.drag = null;
            this.dropCandidate = null;
            this.stopAutoPan();
            this.dropLine.style.display = 'none';
            this.refreshWrapperClasses(drag.node);
            this.positionNode(drag.node);
        }
        this.pointer = null;
        this.marqueeEl.style.display = 'none';
        this.canvasEl.classList.remove('lwm-panning');
        this.scheduleWorldLayer();
        try {
            this.canvasEl.releasePointerCapture?.(event.pointerId);
        } catch {
            /* 忽略 */
        }
        this.resumePump();
    }

    /** 拖动结束：合法落点交给上层写文档，然后清掉所有拖动态。 */
    private finishDrag(): void {
        const drag = this.drag;
        if (!drag) return;
        const candidate = drag.candidate;
        this.drag = null;
        this.dropCandidate = null;
        this.pointer = null;
        this.stopAutoPan();
        this.dropLine.style.display = 'none';
        this.refreshWrapperClasses(drag.node);
        // 先回到布局位置：若上层 setData 复用同一 wrapper，起点就是正确的
        this.positionNode(drag.node);
        if (candidate) {
            this.options.onDrop({
                dragUid: drag.uid,
                parentUid: candidate.parentUid,
                prevUid: candidate.prevUid,
                nextUid: candidate.nextUid,
            });
        }
        this.updateViewport();
        this.options.onViewChange();
    }

    private handleWheel = (event: WheelEvent): void => {
        if (!this.active) return;
        event.preventDefault();
        // 记下滚轮活动：换真泵在滚动结束后 120ms 内不建 CM
        this.lastWheelTime = performance.now();
        const rect = this.container.getBoundingClientRect();
        const localX = event.clientX - rect.left;
        const localY = event.clientY - rect.top;
        if (event.shiftKey) {
            // Shift + 滚轮 = 横向平移（触控板用户）
            this.panX -= event.deltaY;
            this.applyTransform();
            this.scheduleViewport();
            return;
        }
        this.zoomAt(localX, localY, this.zoom * Math.exp(-event.deltaY * 0.0015));
    };

    private handleDoubleClick(event: MouseEvent): void {
        if (!this.active) return;
        const target = event.target as Element | null;
        if (target?.closest?.('.lwm-expand-btn')) return;
        const wrapper = target?.closest?.('.lwm-node[data-uid]') as HTMLElement | null;
        if (!wrapper) return;
        const uid = wrapper.dataset.uid ?? '';
        // 正在编辑的节点：双击属于 mini-CM 的「选词」手势，绝不能上报
        // 「双击节点」——上层收到后会 focusAt(x,y)，把浏览器刚选好的词
        // 塌成一个光标（表现为加粗 / 行内代码里的文字怎么双击都选不上）。
        if (uid && uid === this.editingUid) return;
        const node = this.byUid.get(uid);
        if (node) this.options.onNodeDoubleClick(node, event);
    }

    /** 展开按钮点击（事件委托）。 */
    private handleLayerClick(event: MouseEvent): void {
        const target = event.target as Element | null;
        const button = target?.closest?.('.lwm-expand-btn') as HTMLElement | null;
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        const uid = button.dataset.uid ?? '';
        const node = this.byUid.get(uid);
        if (!node) return;
        const recursive = event.ctrlKey || event.metaKey;
        if (recursive) {
            // Ctrl 点：整棵子树展开（已展开则保持展开，不反向折叠）
            expandSubtree(node);
            node.expand = true;
        } else {
            node.expand = !node.expand;
        }
        this.options.onExpandChange(uid, node.expand, recursive);
        this.relayout();
        this.updateViewport();
        this.options.onViewChange();
    }

    // ==================================================================
    // 主题 / 销毁
    // ==================================================================

    /** 把主题落到容器上（连线颜色由 CSS 变量控制）。 */
    private applyThemeVars(): void {
        const theme = this.options.getTheme();
        this.container.dataset.lwmTheme = theme === 'light' ? 'light' : 'dark';
        // 缩略图配色跟随明暗主题
        this.scheduleMinimap();
    }

    /** 销毁：摘监听、停定时器、销毁全部显示实例。 */
    destroy(): void {
        for (const [target, type, handler] of this.handlers) {
            target.removeEventListener(type, handler);
        }
        this.handlers.length = 0;
        if (this.pumpTimer !== null) clearTimeout(this.pumpTimer);
        if (this.viewTimer !== null) clearTimeout(this.viewTimer);
        if (this.settleTimer !== null) clearTimeout(this.settleTimer);
        if (this.settleRaf !== null) cancelAnimationFrame(this.settleRaf);
        if (this.minimapTimer !== null) clearTimeout(this.minimapTimer);
        this.minimapTimer = null;
        if (this.zoomTimer !== null) clearTimeout(this.zoomTimer);
        this.zoomTimer = null;
        this.stopAutoPan();
        for (const entry of this.displays.values()) entry.display.destroy();
        this.displays.clear();
        this.settleUids.clear();
        this.queue.length = 0;
        this.queued.clear();
        this.canvasEl.remove();
        this.minimapEl.remove();
    }

    // ==================================================================
    // 导出
    // ==================================================================

    /**
     * 生成导出用 SVG 文本。
     *
     * 步骤：
     * 1. 临时关掉虚拟化，把全部可见节点挂进 DOM 并换成真实显示实例
     *    （占位的纯文本导出去没有意义）；
     * 2. 把世界层整体克隆进一个 foreignObject；
     * 3. 把页面上全部 <style> 与容器上的 CSS 变量一起塞进去 —— 我们的
     *    .lwm-* 样式与 token 颜色都不是内联的，不注入就会全丢；
     * 4. 恢复虚拟化，按视口重新裁剪。
     *
     * @returns SVG 文本与逻辑尺寸
     */
    buildExportSvg(): { svg: string; width: number; height: number } {
        const fallback = {
            svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
            width: 1,
            height: 1,
        };
        if (!this.root) return fallback;

        const wasVirtual = this.virtualization;
        // 导出中途可能抛错（克隆/序列化）；用 finally 保证临时关闭的
        // 虚拟化一定恢复，否则画布会永远全量挂载、内存回落不了。
        try {
        this.virtualization = false;
        walkVisible(this.root, (node) => {
            this.ensureWrapper(node);
            // 导出前把占位换成真实显示（上限 500 个，超大文档保留占位保底）
            if (!node.display && this.displays.size < 500) {
                this.createDisplay(node);
                this.measureNode(node);
            }
            this.mountNode(node);
        });
        this.relayout();
        this.updateViewport();

        const bounds = computeBounds(this.root);
        const padding = 40;
        const width = Math.max(1, Math.ceil(bounds.width + padding * 2));
        const height = Math.max(1, Math.ceil(bounds.height + padding * 2));

        const clone = this.worldEl.cloneNode(true) as HTMLDivElement;
        clone.style.transform = `translate3d(${padding - bounds.left}px, ${
            padding - bounds.top
        }px, 0)`;
        // 缩放层带着运行时的 scale（屏幕缩放），导出必须还原成世界坐标：
        // 导出图由外层 wrapper 决定尺寸，内容应保持 1:1。
        clone.querySelector<HTMLElement>('.lwm-scaler')?.style.setProperty(
            'transform',
            ''
        );
        // 交互用的浮层不参与导出
        clone
            .querySelectorAll('.lwm-expand-btn, .lwm-drop-line')
            .forEach((el) => el.remove());
        // CodeMirror 的 .cm-widgetBuffer 是无 src 的布局占位 <img>：
        // SVG 作为 <img> 解码时，foreignObject 里的 <img> 会让画布被 taint，
        // 导致 PNG/PDF 导出抛 SecurityError。它们只是空占位，删掉不影响排版。
        clone.querySelectorAll('img.cm-widgetBuffer').forEach((el) => el.remove());
        // 视口裁剪时留下 display:none 的连线/节点一律恢复显示（此时都已挂载）
        clone.querySelectorAll<HTMLElement>('.lwm-links path').forEach((path) => {
            path.style.display = '';
        });
        // 连线层是嵌套 <svg>：克隆体已经按当前包围盒给了尺寸，但导出图
        // 额外加了 padding 且可能被平移，这里统一放大到整张导出图的范围，
        // 并显式允许溢出，避免 foreignObject 把超出视口的线裁掉。
        const linksClone = clone.querySelector('.lwm-links') as SVGSVGElement | null;
        if (linksClone) {
            linksClone.setAttribute('width', String(width));
            linksClone.setAttribute('height', String(height));
            linksClone.style.overflow = 'visible';
        }

        // 页面全部样式（含 CodeMirror 注入的 StyleModule 与 token 色表）
        const styleText = Array.from(document.querySelectorAll('style'))
            .map((el) => el.textContent ?? '')
            .join('\n');

        // 容器上的 CSS 变量逐条抄进导出根节点：var(--vscode-*) / 字体缩放
        // 这些都定义在 webview 根/容器上，克隆体自己继承不到
        const computed = getComputedStyle(this.container);
        let vars = '';
        for (let i = 0; i < computed.length; i += 1) {
            const name = computed[i];
            if (!name.startsWith('--')) continue;
            vars += `${name}:${computed.getPropertyValue(name)};`;
        }
        const background =
            computed.getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e';

        const wrapper = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
        wrapper.setAttribute(
            'style',
            `position:relative;width:${width}px;height:${height}px;overflow:hidden;` +
                `background:${background};${vars}`
        );
        const styleEl = document.createElement('style');
        styleEl.textContent = styleText;
        wrapper.appendChild(styleEl);
        wrapper.appendChild(clone);

        const svgRoot = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svgRoot.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        svgRoot.setAttribute('width', String(width));
        svgRoot.setAttribute('height', String(height));
        svgRoot.setAttribute('viewBox', `0 0 ${width} ${height}`);
        const foreignObject = document.createElementNS(
            'http://www.w3.org/2000/svg',
            'foreignObject'
        );
        foreignObject.setAttribute('x', '0');
        foreignObject.setAttribute('y', '0');
        foreignObject.setAttribute('width', String(width));
        foreignObject.setAttribute('height', String(height));
        foreignObject.appendChild(wrapper);
        svgRoot.appendChild(foreignObject);

        const svg = new XMLSerializer().serializeToString(svgRoot);

        return { svg, width, height };
        } finally {
            // 恢复性能模式：按视口重新裁剪，顺带把导出时多创建的实例收进 LRU
            this.virtualization = wasVirtual;
            if (wasVirtual) this.updateViewport();
            this.enforceDisplayCap();
        }
    }

    /** 调试快照（探针用）：只暴露数量与视口，不暴露内部对象。 */
    debugState(): Record<string, unknown> {
        return {
            nodes: this.byUid.size,
            mounted: this.mounted.size,
            displays: this.displays.size,
            links: this.linkPaths.size,
            zoom: this.zoom,
            panX: this.panX,
            panY: this.panY,
            active: this.active,
        };
    }
}
