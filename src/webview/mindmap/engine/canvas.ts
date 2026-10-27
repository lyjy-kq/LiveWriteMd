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
import { DISPLAY_CACHE_CAP, MINIMAP_H, MINIMAP_W, PREWARM_DELAY_MS, PROGRESSIVE_THRESHOLD } from './canvasConstants.js';
import * as displayPool from './displayPool.js';
import * as flags from './flags.js';
import * as links from './links.js';
import * as minimap from './minimap.js';
import * as mounting from './mounting.js';
import * as pointer from './pointer.js';
import * as viewport from './viewport.js';
import { buildExportSvg } from './export.js';
import { computeInternalLinkGeometry, rayExitRect } from './internalLinkGeometry.js';
import { setData as setDataImpl } from './setData.js';


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
     * 解析内链目标（`#` 之后的标题文字）→ 目标标题节点 uid。
     *
     * 导图节点里的内链（Ctrl+点击 `.cm-md-link` 且 href 以 `#` 开头）经这个
     * 回调找到目标节点；找不到（断链）返回 null，只吞掉手势。
     */
    resolveInternalLink?(target: string): string | null;
    /**
     * 跳转到内链目标节点（点击内链箭头 / 导图节点里的内链）。
     * 上层负责展开折叠祖先、居中与短暂高亮。
     */
    onInternalLinkNavigate?(toUid: string): void;
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
    /**
     * 当前模型节点的间接引用（onDisplayChange 闭包只认它）。
     *
     * 为什么不能直接在闭包里捕获 node：setData 重建模型时实例会被
     * 「认领」到新节点上，闭包若持有创建时的旧节点，整条引用链
     * （displays → display → 闭包 → 旧节点 → parent/children）会把
     * **整棵旧模型树**一直挂住 —— 实测大文档每重建一次泄漏约 7MB。
     * 闭包改为读这个盒子的 current，迁移实例时同步更新即可。
     */
    nodeRef: { current: MapNode };
    kind: string;
    /**
     * 实例档位：full = 完整 live preview，lite = 轻量源码渲染。
     * 缩放在两档之间来回跨阈值时，靠它判断现有实例是否还能复用。
     */
    mode: 'full' | 'lite';
}

export class MapCanvas {
    public readonly container: HTMLElement;
    public readonly options: MapCanvasOptions;

    // —— DOM ——
    public readonly canvasEl: HTMLDivElement;
    /**
     * 平移层：只负责 translate（pan），不携带 scale。
     *
     * 分层原因（清晰度）：Chromium 对带 `will-change: transform` 的元素会
     * 按 **1x** 栅格化，之后 transform 里的 scale 只是拿这张位图拉伸采样。
     * 如果 scale 和平移放在同一层，缩小/放大时文字就会整体发虚、边缘带彩边。
     * 把 scale 挪到内层 `.lwm-scaler`（平时不提升、按当前比例正常栅格化），
     * 外层只做平移 —— 平移不改比例，缓存位图可以放心复用，文字始终清晰。
     */
    public readonly worldEl: HTMLDivElement;
    /**
     * 缩放层：只负责 scale，挂在平移层里面。
     *
     * 滚轮缩放期间临时给它加 `will-change: transform`（见 `.lwm-zooming`），
     * 让每帧只改合成属性；缩放手势停下后撤掉，浏览器按最终比例重新栅格化，
     * 文字恢复清晰。
     */
    public readonly scalerEl: HTMLDivElement;
    public readonly nodeLayer: HTMLDivElement;
    public readonly linksSvg: SVGSVGElement;
    public readonly measureLayer: HTMLDivElement;
    /** 拖动时显示在兄弟间隙的插入指示线。 */
    public readonly dropLine: HTMLDivElement;
    /**
     * 右下角缩略图：只画节点方块 + 当前视口框。
     * 画在 canvas 上（比逐节点 DOM 便宜得多），点击 / 拖动跳转视口。
     */
    public readonly minimapEl: HTMLCanvasElement;
    /** 缩略图重绘合并定时器（null = 没有排队）。 */
    public minimapTimer: ReturnType<typeof setTimeout> | null = null;
    /** 正在缩略图上拖动的指针 id（null = 没在拖）。 */
    public minimapPointerId: number | null = null;
    /**
     * 缩略图节点方块的离屏位图缓存。
     *
     * 平移时只有视口框在动，节点方块在世界坐标里纹丝不动，却每 40ms
     * 重画一遍（每个节点一次 fillRect，大文档白白烧掉帧预算）。把方块
     * 画进离屏 canvas，平移期间直接 drawImage 贴回来，只补画视口框与
     * 缩放百分比。key 不一致（缩放 / 范围 / 主题 / 布局变了）才重画。
     */
    public minimapRaster: { key: string; canvas: HTMLCanvasElement } | null = null;
    /**
     * 可见节点包围盒缓存：布局没变时不必每次缩略图重绘都遍历整棵树。
     * relayout / setData / 展开收起都会把它置空。
     */
    public boundsCache: MapBounds | null = null;

    // —— 模型 ——
    public root: MapNode | null = null;
    public readonly byUid = new Map<string, MapNode>();
    public selectedUid: string | null = null;
    public editingUid: string | null = null;
    /** 用户点开「展开到最大行数」的节点（去掉行数截断）。 */
    public readonly expandedFlags = new Set<string>();
    /** 搜索命中的节点 uid。 */
    public searchHits = new Set<string>();
    public searchCurrent: string | null = null;

    // —— 显示实例 / 挂载 ——
    public displays = new Map<string, DisplayEntry>();
    /**
     * 是否启用离屏实例 LRU 淘汰（设置项，默认关闭）。
     *
     * 关闭时离屏节点的真实 mini-CM 一直保留，来回平移直接复用，代价是
     * 内存随文档节点数增长；开启后超过 DISPLAY_CACHE_CAP 的离屏实例
     * 会被销毁并降级为纯文本占位。
     */
    public displayCacheEnabled = false;
    public readonly mounted = new Set<string>();
    public readonly queue: string[] = [];
    public readonly queued = new Set<string>();
    public pumpTimer: ReturnType<typeof setTimeout> | null = null;
    public progressiveCount = 0;
    /**
     * 本次 setData 允许同步创建多少个真实显示实例。
     *
     * 首屏需要一批真实 CM 把内容直接画出来；之后的每次 setData（拖动回写、
     * 外部更新）只重建「内容真的变了」的节点，其余占位节点交给 pump 异步
     * 换真。否则每次 drop 都会同步造 24 个 mini-CM（实测 ~300ms）。
     */
    public eagerDisplayBudget = PROGRESSIVE_THRESHOLD;
    public viewTimer: ReturnType<typeof setTimeout> | null = null;
    /** 首帧后的补偿性重测（见 scheduleMeasureSettle）。 */
    public settleRaf: number | null = null;
    public settleTimer: ReturnType<typeof setTimeout> | null = null;
    /** 需要补偿重测的节点（新建过真实显示实例的）。 */
    public readonly settleUids = new Set<string>();
    /** 下一次 settle 强制全量（字体/图片等全局因素）。 */
    public settleForceAll = false;
    public readonly linkPaths = new Map<string, SVGPathElement>();
    public readonly expandButtons = new Map<string, HTMLDivElement>();
    /**
     * 内链箭头层：linksSvg 的**第一个**子元素，画在树连线之下
     * （树连线的 path 随后 append，DOM 序靠后、盖在箭头上面）。
     */
    public readonly ilinkLayer: SVGGElement;
    /**
     * 内链对（内链所在节点 uid → 目标标题节点 uid）。
     * 由上层（mindmapApp）按文档内容算好后经 setInternalLinks 喂入；
     * 画布只负责几何与绘制，不认识 Markdown。
     */
    public ilinkPairs: Array<{ fromUid: string; toUid: string }> = [];
    /** 内链箭头元素（key = `fromUid->toUid`）。 */
    public readonly ilinkEntries = new Map<
        string,
        { group: SVGGElement; path: SVGPathElement; head: SVGPolygonElement; hit: SVGPathElement }
    >();
    /** 内链跳转后的 1 秒高亮节点（flashNode 写入）。 */
    public flashUid: string | null = null;
    public flashTimer: ReturnType<typeof setTimeout> | null = null;

    // —— 性能监控计数（HUD 用；纯自增整数，零成本）——
    /** 累计创建的真实显示实例数（换真速率 = 它的增量/时间）。 */
    public createdTotal = 0;
    /** 累计 LRU 淘汰的实例数。 */
    public evictedTotal = 0;
    /** 累计挂载 / 卸载次数（手势期间应该纹丝不动——双圈预热制的验收口径）。 */
    public mountTotal = 0;
    public unmountTotal = 0;
    /**
     * 挂载集合版本号：mount/unmount 时 +1。
     *
     * 连线与展开按钮的可见性只看「端点是否挂载」。平移时如果这一帧没有
     * 节点进出 DOM，可见性必然与上一帧相同 —— 以前每帧仍把全部连线
     * （每个可见节点一条 path）和按钮的 display 重写一遍，大文档下等于
     * 每帧上千次无意义的样式写入。
     */
    public mountedVersion = 0;
    /** 上一次做过可见性同步时的 mountedVersion。 */
    public visibilityVersion = -1;

    // —— 视口 ——
    public zoom = 1;
    public panX = 0;
    public panY = 0;
    public active = false;
    public virtualization = true;
    public hasFit = false;
    /** 最后一次滚轮事件的时间戳（换真泵据此避开缩放手势）。 */
    public lastWheelTime = 0;
    /** 滚轮缩放结束后撤掉缩放层提升的定时器（null = 没排队）。 */
    public zoomTimer: ReturnType<typeof setTimeout> | null = null;
    /** 当前是否处于「高倍缩放」（canvas 上挂着 lwm-hi-zoom）。 */
    public hiZoomActive = false;
    /**
     * 手势期间是否放弃合成层提升（设置：「手势期间保持清晰」）。
     * false = 现状：拖动/缩放时临时提升，帧率优先。
     */
    public gestureCrisp = false;

    // —— 缩放降级渲染 ——
    /** 当前渲染档（0 全量 / 1 降级 / 2 纯文本），随 zoom 自动切换。 */
    public renderTier: RenderTier = 0;
    /**
     * 是否启用降级档（默认关闭）。关闭时 liteZoom 完全不参与判断，
     * 即使缩到很小也保持全量渲染。
     */
    public liteEnabled = false;
    /**
     * 是否启用纯文本档（默认关闭）。关闭时 plainZoom 完全不参与判断。
     */
    public plainEnabled = false;
    /** 降级阈值（缩放比例，0-1）：zoom < liteZoom 进入档 1。 */
    public liteZoom = 0.7;
    /** 纯文本阈值（缩放比例，0-1）：zoom < plainZoom 进入档 2。 */
    public plainZoom = 0.4;
    /** 上一轮容器尺寸：尺寸变化时用位移补偿保持内容视觉居中。 */
    public lastViewWidth = 0;
    public lastViewHeight = 0;

    // —— 交互 ——
    public pointer: PointerState = null;
    public drag: DragState | null = null;
    public dropCandidate: DropCandidate | null = null;
    /** Ctrl 框选的矩形层（屏幕坐标，不参与缩放）。 */
    public readonly marqueeEl: HTMLDivElement;
    /** 多选中的节点 uid（Ctrl 点 / 框选）。与 selectedUid 叠加显示。 */
    public multiSelected = new Set<string>();
    public autoPanTimer: ReturnType<typeof setTimeout> | null = null;
    public autoPanDx = 0;
    public autoPanDy = 0;
    /** 预热挂载的定时器（null = 没有排队）。 */
    public prewarmTimer: ReturnType<typeof setTimeout> | null = null;

    /** 已绑定的事件处理器（销毁时逐个摘掉）。 */
    public readonly handlers: Array<[EventTarget, string, EventListener]> = [];

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
        // 内链箭头层压底：作为 linksSvg 第一个子元素，树连线与节点都盖在它上面。
        // 注意 .lwm-links 整体 pointer-events:none，箭头自己的命中线用
        // pointer-events:stroke 单独打开（见 mindmapStyles.ts）
        this.ilinkLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        this.ilinkLayer.classList.add('lwm-ilinks');
        this.linksSvg.appendChild(this.ilinkLayer);
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

    // ---- 薄包装：实现已拆到同目录协作模块（displayPool/mounting/viewport/links/minimap/pointer/flags/export）----
    // displayPool
    public ensureWrapper(node: MapNode) : HTMLElement { return displayPool.ensureWrapper(this, node); }
    public refreshWrapperClasses(node: MapNode | undefined | null) : void { return displayPool.refreshWrapperClasses(this, node); }
    public ensureContent(node: MapNode) : void { return displayPool.ensureContent(this, node); }
    public placeholderTextOf(node: MapNode, doc?: string) : string { return displayPool.placeholderTextOf(this, node, doc); }
    public createDisplay(node: MapNode, mode?: 'full' | 'lite') : void { return displayPool.createDisplay(this, node, mode); }
    public setPlaceholder(node: MapNode, doc?: string) : void { return displayPool.setPlaceholder(this, node, doc); }
    public measureNode(node: MapNode) : void { return displayPool.measureNode(this, node); }
    public measureNodes(nodes: MapNode[]) : void { return displayPool.measureNodes(this, nodes); }
    public scheduleMeasureSettle(forceAll = false) : void { return displayPool.scheduleMeasureSettle(this, forceAll = false); }
    public settleMounted() : void { return displayPool.settleMounted(this); }
    public remeasureAll() : void { return displayPool.remeasureAll(this); }
    public refreshNode(uid: string, force = false) : void { return displayPool.refreshNode(this, uid, force = false); }
    public finishEditDisplay(uid: string, baseHeight: number, baseWidth?: number) : boolean { return displayPool.finishEditDisplay(this, uid, baseHeight, baseWidth); }
    public setNodeWidth(uid: string, width: number) : boolean { return displayPool.setNodeWidth(this, uid, width); }
    public ensureEditDisplay(uid: string) : NodeDisplay | null { return displayPool.ensureEditDisplay(this, uid); }
    public growNodeHeight(uid: string, contentHeight: number) : boolean { return displayPool.growNodeHeight(this, uid, contentHeight); }
    public enforceDisplayCap() : void { return displayPool.enforceDisplayCap(this); }
    public enqueueSwap(uid: string) : void { return displayPool.enqueueSwap(this, uid); }
    public interactionActive() : boolean { return displayPool.interactionActive(this); }
    public schedulePump(delay = 16) : void { return displayPool.schedulePump(this, delay = 16); }
    public resumePump() : void { return displayPool.resumePump(this); }
    // mounting
    public mountNode(node: MapNode) : void { return mounting.mountNode(this, node); }
    public unmountNode(uid: string) : void { return mounting.unmountNode(this, uid); }
    public positionNode(node: MapNode) : void { return mounting.positionNode(this, node); }
    public updateViewport() : void { return mounting.updateViewport(this); }
    public scheduleViewport() : void { return mounting.scheduleViewport(this); }
    public schedulePrewarm(delay = PREWARM_DELAY_MS) : void { return mounting.schedulePrewarm(this, delay = PREWARM_DELAY_MS); }
    // viewport
    public setZoomRenderThresholds(litePercent: number, plainPercent: number, liteEnabled: boolean = this.liteEnabled, plainEnabled: boolean = this.plainEnabled) : void { return viewport.setZoomRenderThresholds(this, litePercent, plainPercent, liteEnabled, plainEnabled); }
    public directTier() : RenderTier { return viewport.directTier(this); }
    public tierForZoom() : RenderTier { return viewport.tierForZoom(this); }
    public syncRenderTier(force = false) : void { return viewport.syncRenderTier(this, force = false); }
    public applyRenderTier(tier: RenderTier) : void { return viewport.applyRenderTier(this, tier); }
    public setDisplayCacheEnabled(enabled: boolean) : void { return viewport.setDisplayCacheEnabled(this, enabled); }
    public setGestureCrisp(enabled: boolean) : void { return viewport.setGestureCrisp(this, enabled); }
    public setVirtualization(enabled: boolean) : void { return viewport.setVirtualization(this, enabled); }
    public applyTransform() : void { return viewport.applyTransform(this); }
    public markZooming() : void { return viewport.markZooming(this); }
    public scheduleWorldLayer() : void { return viewport.scheduleWorldLayer(this); }
    public viewSize() : { width: number; height: number } { return viewport.viewSize(this); }
    public getBounds() : MapBounds | null { return viewport.getBounds(this); }
    public screenToWorld(clientX: number, clientY: number) : { x: number; y: number } { return viewport.screenToWorld(this, clientX, clientY); }
    public zoomAt(screenX: number, screenY: number, nextZoom: number) : void { return viewport.zoomAt(this, screenX, screenY, nextZoom); }
    public fit() : void { return viewport.fit(this); }
    public setZoomPercent(percent: number) : void { return viewport.setZoomPercent(this, percent); }
    public getNodeAtViewportCenter() : MapNode | null { return viewport.getNodeAtViewportCenter(this); }
    public centerOn(uid: string) : void { return viewport.centerOn(this, uid); }
    public getNodeRect(uid: string) : { left: number; top: number; right: number; bottom: number } | null { return viewport.getNodeRect(this, uid); }
    // links
    public relayout() : void { return links.relayout(this); }
    public syncLinksExtent() : void { return links.syncLinksExtent(this); }
    public syncLinks() : void { return links.syncLinks(this); }
    public updateLinksVisibility() : void { return links.updateLinksVisibility(this); }
    public updateInternalLinksVisibility() : void { return links.updateInternalLinksVisibility(this); }
    public updateInternalLinkEmphasis() : void { return links.updateInternalLinkEmphasis(this); }
    public syncInternalLinks() : void { return links.syncInternalLinks(this); }
    public syncExpandButtons() : void { return links.syncExpandButtons(this); }
    public updateExpandButtonsVisibility() : void { return links.updateExpandButtonsVisibility(this); }
    // minimap
    public scheduleMinimap() : void { return minimap.scheduleMinimap(this); }
    public minimapGeometry() : { s: number; ox: number; oy: number; /** 容器视口在缩略图里的像素矩形。 */ view: { x: number; y: number; w: number; h: number }; } | null { return minimap.minimapGeometry(this); }
    public drawMinimap() : void { return minimap.drawMinimap(this); }
    public minimapScreenToWorld(clientX: number, clientY: number) : { x: number; y: number } | null { return minimap.minimapScreenToWorld(this, clientX, clientY); }
    public handleMinimapPointerDown(event: PointerEvent) : void { return minimap.handleMinimapPointerDown(this, event); }
    public handleMinimapPointerMove(event: PointerEvent) : void { return minimap.handleMinimapPointerMove(this, event); }
    public handleMinimapPointerUp(event: PointerEvent) : void { return minimap.handleMinimapPointerUp(this, event); }
    public minimapJumpTo(clientX: number, clientY: number) : void { return minimap.minimapJumpTo(this, clientX, clientY); }
    // pointer
    /** 数据入口：新旧模型 diff + 实例认领（实现见 setData.ts）。 */
    public setData(tree: MindMapTreeNode, opts?: { uidRemap?: Map<string, string>; keepView?: boolean }) { return setDataImpl(this, tree, opts); }

    public bindEvents() : void { return pointer.bindEvents(this); }
    public handlePointerDown(event: PointerEvent) : void { return pointer.handlePointerDown(this, event); }
    public openLinkAt(event: PointerEvent) : boolean { return pointer.openLinkAt(this, event); }
    public capturePointer(pointerId: number) : void { return pointer.capturePointer(this, pointerId); }
    public handlePointerMove(event: PointerEvent) : void { return pointer.handlePointerMove(this, event); }
    public updateMarquee(startX: number, startY: number, endX: number, endY: number) : void { return pointer.updateMarquee(this, startX, startY, endX, endY); }
    public updateDrag(event: PointerEvent) : void { return pointer.updateDrag(this, event); }
    public startAutoPan() : void { return pointer.startAutoPan(this); }
    public stopAutoPan() : void { return pointer.stopAutoPan(this); }
    public updateDropCandidate(clientX: number, clientY: number) : void { return pointer.updateDropCandidate(this, clientX, clientY); }
    public canDrop(dragUid: string, parentUid: string) : boolean { return pointer.canDrop(this, dragUid, parentUid); }
    public handlePointerUp(event: PointerEvent, fromWindow = false) : void { return pointer.handlePointerUp(this, event, fromWindow = false); }
    public handlePointerCancel(event: PointerEvent) : void { return pointer.handlePointerCancel(this, event); }
    public finishDrag() : void { return pointer.finishDrag(this); }
    public handleWheel = (event: WheelEvent): void => { pointer.handleWheel(this, event); };
    public handleDoubleClick(event: MouseEvent) : void { return pointer.handleDoubleClick(this, event); }
    public handleLayerClick(event: MouseEvent) : void { return pointer.handleLayerClick(this, event); }
    // flags
    public setNodeExpand(uid: string, expand: boolean) : void { return flags.setNodeExpand(this, uid, expand); }
    public applyExpandLevel(level: number) : Set<string> { return flags.applyExpandLevel(this, level); }
    public expandAll() : void { return flags.expandAll(this); }
    public revealUid(uid: string) : boolean { return flags.revealUid(this, uid); }
    public setSelected(uid: string | null) : void { return flags.setSelected(this, uid); }
    public setInternalLinks(pairs: Array<{ fromUid: string; toUid: string }>) : void { return flags.setInternalLinks(this, pairs); }
    public flashNode(uid: string) : void { return flags.flashNode(this, uid); }
    public setMultiSelected(uids: Iterable<string>) : void { return flags.setMultiSelected(this, uids); }
    public getMultiSelected() : string[] { return flags.getMultiSelected(this); }
    public setEditing(uid: string | null) : void { return flags.setEditing(this, uid); }
    public setNodeExpandedFlag(uid: string, expanded: boolean) : void { return flags.setNodeExpandedFlag(this, uid, expanded); }
    public isNodeClamped(uid: string) : boolean { return flags.isNodeClamped(this, uid); }
    public setSearchHighlight(hits: string[], current: string | null) : void { return flags.setSearchHighlight(this, hits, current); }
    public remapFlags(remap: Map<string, string>) : void { return flags.remapFlags(this, remap); }
    public setTheme(theme: ThemeType) : void { return flags.setTheme(this, theme); }
    // export
    public buildExportSvg(): string { return buildExportSvg(this); }


    // ==================================================================
    // 事件绑定
    // ==================================================================

    /** 注册一个事件并记下来，destroy 时统一摘除。 */
    public on<K extends keyof HTMLElementEventMap>(
        target: EventTarget,
        type: K | string,
        handler: (event: never) => void,
        capture = false
    ): void {
        const fn = handler as EventListener;
        target.addEventListener(type, fn, capture);
        this.handlers.push([target, type, fn]);
    }

    // ==================================================================
    // 数据入口
    // ==================================================================


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
    // 主题 / 销毁
    // ==================================================================

    /** 把主题落到容器上（连线颜色由 CSS 变量控制）。 */
    public applyThemeVars(): void {
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
        if (this.prewarmTimer !== null) clearTimeout(this.prewarmTimer);
        if (this.viewTimer !== null) clearTimeout(this.viewTimer);
        if (this.settleTimer !== null) clearTimeout(this.settleTimer);
        if (this.settleRaf !== null) cancelAnimationFrame(this.settleRaf);
        if (this.minimapTimer !== null) clearTimeout(this.minimapTimer);
        this.minimapTimer = null;
        if (this.zoomTimer !== null) clearTimeout(this.zoomTimer);
        this.zoomTimer = null;
        if (this.flashTimer !== null) clearTimeout(this.flashTimer);
        this.flashTimer = null;
        this.stopAutoPan();
        for (const entry of this.displays.values()) entry.display.destroy();
        this.displays.clear();
        this.settleUids.clear();
        this.queue.length = 0;
        this.queued.clear();
        this.canvasEl.remove();
        this.minimapEl.remove();
    }

    /** 调试快照（探针 / 性能监控 HUD 用）：只暴露数量与视口，不暴露内部对象。 */
    debugState(): Record<string, unknown> {
        return {
            nodes: this.byUid.size,
            mounted: this.mounted.size,
            displays: this.displays.size,
            links: this.linkPaths.size,
            ilinks: this.ilinkEntries.size,
            zoom: this.zoom,
            panX: this.panX,
            panY: this.panY,
            active: this.active,
            // —— 性能监控 ——
            queue: this.queue.length,
            tier: this.renderTier,
            interacting: this.interactionActive(),
            editing: this.editingUid !== null,
            createdTotal: this.createdTotal,
            evictedTotal: this.evictedTotal,
            mountTotal: this.mountTotal,
            unmountTotal: this.unmountTotal,
        };
    }
}

