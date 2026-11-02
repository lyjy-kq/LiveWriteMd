/**
 * 导图右边界「快速卡片」栏。
 *
 * 卡片不是导图节点，内容直接以 `<<<` / `>>>` 独立行写进 Markdown
 * （格式与纯编辑函数见 edit/staging.ts），因此：
 * - live 模式里就是普通文字，天然同步，不需要任何额外渲染；
 * - 这里只负责把 `#mindmap` 容器里的卡片**显示**出来，所有修改都通过
 *   options.commit 走 app.commit → 一次导图操作 = 一步 undo。
 *
 * 视觉与交互刻意向普通节点靠：
 * - 外框（底色 / 点线描边 / 圆角 / 投影 / 字体）与选中态描边直接用
 *   .lwm-node 那套共用 CSS（见 canvasCss 的 .lwm-node, .lwm-qcard 规则），
 *   卡片只加左侧色条、平移收起和全局宽度；
 * - 卡片正文用和节点同一套只读 mini-CM（createNodeDisplay），
 *   Markdown 渲染、代码块 / 表格 / 公式等 widget 与节点完全一致；
 * - 底色 / 描边取标题色板 h1~h6（--livewritemd-hN-color）轮换，
 *   和兄弟节点换色是同一个套路；
 * - 交互照抄节点：单击选中（.lwm-node-selected）、再点一下 / 双击进入编辑；
 * - 右键菜单就是节点那套 .lwm-context-menu。
 *
 * 收起状态贴画布右边界只露卡片**左**边缘 4px 的色条；hover / 选中 /
 * 编辑时整张卡片向左平移出来（transform，布局宽度恒定，mini-CM 不重新
 * 折行）。收起态卡片被平移到画布右侧外，命中区域也跟着走，只有那条
 * 色条能 hover / 点击，画布照常可用。
 *
 * 交互：
 * - 鼠标悬浮哪一张，只展开哪一张（其余仍是色条）；
 * - 单击 = 选中；点已经选中的卡片 = 编辑；双击未选中的卡片 = 只选中
 *   （与节点 handleNodeClick 的判定完全一致）；
 * - 选中卡片后拖动 = 拖进画布变节点（拖动中画布按拖普通节点的规则
 *   预览落点：压在节点上 = 子节点，落在旁边 = 兄弟）；在侧边栏里上下拖
 *   = 调整卡片顺序；
 *   导图节点拖到侧边 = 变卡片，落点决定插到第几张（有指示线）；
 * - Ctrl/Cmd + C/X/V = 复制 / 剪切当前卡片、在它下面粘贴一张新卡片；
 * - 拖动卡片左边界 = 调全局卡片宽度（松手才落盘到设置）；
 * - 右键卡片：收起（取消选中） / 删除；
 * - 右键加号：复制「到文末回答」提示词；加号本身可拖进任意文本框；
 * - 加号本身就是一张「带加号的侧边卡片」：同样收起 / 悬浮展开 / 参与
 *   重叠排序，宽度固定一个字符（1em），不走全局宽度；它永远排在最后
 *   （层叠最高、贴着摆放区底部）。
 *
 * 尺寸：宽度 = 设置里的全局 quickCardWidth（没有上限，拖动左边界改），
 * 高度跟内容走。摆放区 = 画布顶部 → 右下角缩略图（缩放概览）顶部；
 * 放得下就平铺，放不下就按「封顶高度」重叠，**收起态**下面的卡片盖住上面的
 * （z-index 按顺序递增）。被截断的卡片收起后露出「封顶高度 + 半行」，一眼
 * 能看出它下面还有内容；这张卡片用 clip-path 裁掉多余部分，但会多画
 * SEAM_PAD 垫到下一张的左上圆角底下（下一张的实心底色盖住其余部分），
 * 接缝处的圆角缺口里透出上一张的色、而不是画布白底。圆角本身不改：
 * 没被压缩的短卡片垫不过去时保持原样。展开的卡片不提层级：下面的卡片
 * 仍然压在它右边缘上，上面的卡片则被它盖住。展开高度越过缩略图顶部时
 * 底部停在缩略图顶部、卡片内部滚动。
 *
 * @module webview/mindmap/quickCardRail
 */

import type { LanguageDescription } from '@codemirror/language';
import type { ThemeType } from '../../shared/types.js';
import {
    appendQuickCard,
    deleteQuickCard,
    insertQuickCard,
    moveQuickCard,
    parseQuickCards,
    updateQuickCard,
} from './edit/staging.js';
import type { QuickCard } from './edit/staging.js';
import { createNodeDisplay } from './miniCm.js';
import type { NodeDisplay } from './miniCm.js';
import { HEADING_TINT_FALLBACKS } from './engine/canvasConstants.js';

/** 快速卡片栏的宿主回调（不直接依赖 MindMapApp，避免循环引用）。 */
export interface QuickCardRailOptions {
    /** 当前文档全文。 */
    getMarkdown: () => string;
    /** 写回文档（走 app.commit：同步画布 + 进入 CM 撤销栈）。 */
    commit: (text: string) => void;
    /** 当前的卡片栏设置：开关 + 全局卡片宽度（宽度由拖动左边界改）。 */
    getSettings: () => {
        enabled: boolean;
        width: number;
    };
    /** 当前明暗主题（card 里的 mini-CM 创建时要用）。 */
    getTheme: () => ThemeType;
    /** 代码块嵌套高亮语言表（与节点共用）。 */
    codeLanguages?: readonly LanguageDescription[];
    /** 当前文件名（右键加号生成「到文件末尾回答」的提示词要用）。 */
    getFileName?: () => string;
    /**
     * 拖动左边界改完宽度后回调（宿主负责持久化到设置）。
     * 拖动过程中只改本地 CSS 变量，松手才落盘，避免每帧写配置。
     */
    onResize?: (width: number) => void;
    /** 写剪贴板（宿主有 relay 实现；缺省退回浏览器剪贴板）。 */
    copyText?: (text: string) => Promise<boolean>;
    /** 读剪贴板（粘贴到卡片时用；读不到返回空串）。 */
    readText?: () => Promise<string>;
    /**
     * 卡片拖动过程中的落点预览。
     *
     * at = 指针在画布上的屏幕坐标：宿主让画布按拖普通节点那套规则高亮
     * （压在节点上 = 子节点描边，落在旁边 = 兄弟插入线）；at = null
     * 表示指针回到侧边栏里 / 拖动结束，宿主撤掉高亮。
     */
    onCardDragPreview?: (at: { clientX: number; clientY: number } | null) => void;
    /**
     * 选中卡片后拖到画布上松手：卡片内容按落点变成节点（子节点或兄弟）。
     *
     * 宿主负责找落点、写文档；卡片本身的删除也在宿主那边一起完成
     * （一次 commit = 一步撤销）。
     */
    onCardDropOnMap?: (index: number, clientX: number, clientY: number) => void;
    /**
     * 卡片被激活（选中 / 右键 / 新建草稿）时通知宿主。
     *
     * 卡片不是导图节点：点它时事件不会经过画布，画布的 selectedUid 会一直
     * 留着。宿主接这个回调清掉节点选中，否则接着按 Tab / Enter 会去改
     * 「上一轮选中的节点」，而 Ctrl+C 又已经归卡片，语义分裂。
     */
    onActivate?: () => void;
}

/** 卡片宽度下限（px）。没有上限：用户拖动左边界想多宽就多宽。 */
const MIN_CARD_WIDTH = 160;
/** 放得下时卡片之间的间距（px）：紧密排列，整组垂直居中。 */
const STACK_GAP = 6;
/** 放不下时每张卡片至少保留的可见高度（px），保证还能点到下一张。 */
const MIN_PEEK = 18;
/**
 * 卡片底色的取用顺序（值是 HEADING_TINT_FALLBACKS 的下标）。
 *
 * 直接按 0,1,2… 取会出现「绿→蓝」「黄→橙」这种相邻近色：收起成色带后
 * 上下两张几乎分不出来。这里按冷暖交替重排 —— 绿、红、蓝、黄、紫、橙，
 * 相邻两张的色差最大。
 */
const CARD_TINT_ORDER = [3, 0, 2, 4, 1, 5];
/**
 * 量不到行高时用的半行高度（px）。
 *
 * 被压缩的卡片收起后，可见高度 = 封顶高度 + 半行：多露半行的理由和
 * 「半截字」一样 —— 一眼能看出这张卡被截断了，不是内容只有这么高。
 */
const FALLBACK_HALF_LINE = 10;
/**
 * 卡片圆角半径的兜底值（px）。
 *
 * 实际值在 layoutStack 里从 `.lwm-qcard` 的 computed style 读（与
 * canvasCss 的 `border-radius` 单一来源），读不到时才用这个数。
 *
 * 收起态只露左边 4px，这么大的圆角会在每段色条的顶部 / 底部切出缺口。
 * 被压缩的卡片向下多画「半径 + 2px」垫到下一张圆角底下消除缺口（见
 * layoutStack）；没被压缩的短卡片垫不过去，圆角保持原样，不做压平。
 */
const CARD_RADIUS = 8;
/** 拖卡片进入画布的启动阈值（px）。 */
const CARD_DRAG_THRESHOLD = 4;

/** 拖动结束后短暂吞掉 click（pointerup 之后浏览器还会补一个 click）。 */
const SUPPRESS_CLICK_MS = 300;

/** 双击判定窗口：第一下刚选中、第二下落在窗口内，算一次双击（只选中不编辑）。 */
const DOUBLE_CLICK_WINDOW_MS = 700;

/**
 * 卡片栏。
 *
 * 只在 map 模式可见：宿主把 `#mindmap` 隐藏（`hidden`）时整条栏一起隐藏，
 * 不需要额外的显示/隐藏逻辑。
 */
export class QuickCardRail {
    /** 卡片栏挂载的导图容器（`#mindmap`）。 */
    private readonly container: HTMLElement;
    private readonly options: QuickCardRailOptions;

    /** 整条栏（占满画布右侧整列）。 */
    private readonly host: HTMLDivElement;
    /** 卡片堆叠区（放不下时重叠摆放，见 layoutStack）。 */
    private readonly stack: HTMLDivElement;
    /**
     * 加号：它本身就是「一张带加号的侧边卡片」——和普通卡片同一套
     * 收起 / 悬浮展开 / 外观，只是点击的语义是新建卡片。
     */
    private readonly addButton: HTMLButtonElement;
    /** 卡片被选中时显示的浮动工具条（复用节点的 .lwm-toolbar 样式）。 */
    private readonly toolbarEl: HTMLDivElement;
    /** 拖拽插入位置指示线（拖节点或卡片到侧边时出现）。 */
    private readonly dropMark: HTMLDivElement;

    /** 当前解析出来的卡片（文档顺序）。 */
    private cards: QuickCard[] = [];
    /** 每张卡片对应的只读 mini-CM（index 与 cards 对齐）。 */
    private displays = new Map<number, NodeDisplay>();

    /** 选中的卡片（与节点的 .lwm-node-selected 同一套视觉）；null = 没选中。 */
    private activeIndex: number | null = null;
    /**
     * 固定的卡片序号。
     *
     * 固定 = 即使没 hover / 没选中也保持展开，方便「一边看这张卡一边操作
     * 画布」。序号会随文档增删卡片漂移，所以另外记一份内容锚点
     * （原文 + 行号），每次重新解析后按锚点找回序号。
     */
    private pinned = new Set<number>();
    /** 固定卡片的锚点（与 pinned 同步维护）。 */
    private pinnedAnchors: Array<{ text: string; fromLine: number }> = [];
    /** 上一次「只选中」的卡片与时间：复刻节点的单击/双击判定。 */
    private selectOnlyIndex: number | null = null;
    private selectOnlyAt = 0;
    /** 当前卡片宽度（px）：全局生效，拖动左边界时实时改。 */
    private currentWidth = 280;
    /** 进行中的宽度拖动。 */
    private resize: {
        pointerId: number;
        startX: number;
        startWidth: number;
        moved: boolean;
        /** 拖手元素：窗口失焦收尾时要在这里释放指针捕获。 */
        handle: HTMLElement;
    } | null = null;
    /**
     * 刚由 pointerup 自己处理过的那一次点击。
     *
     * pointerdown 被 preventDefault 后浏览器可能仍补一个 click，需要吞掉，
     * 否则同一手势会被当成「第二下」直接进编辑。不能用「时间窗内全部吞掉」：
     * 用户紧接着点另一张卡也会落空。只吞「同位置、极短时间内」的那一个。
     */
    private suppressClick: { x: number; y: number; until: number } | null = null;
    /** 当前指示线对应的插入序号：拖动中每帧都调 setDropIndex，值没变就不动 DOM。 */
    private dropShown: number | null = null;
    /** 卡片栏当前是否启用（关掉时只解析、不建 mini-CM）。 */
    private enabled = true;
    /** 缩略图显隐会改变摆放区高度：监听 class 变化重排。 */
    private minimapObserver: MutationObserver | null = null;
    /** 合并同一帧里的多次重排请求（缩略图 class 可能连续变两次）。 */
    private relayoutRaf = 0;

    /** 复制提示词后的小浮条（挂在 body 上，复用一份）。 */
    private toastEl: HTMLDivElement | null = null;
    private toastTimer = 0;

    /**
     * 已选中卡片的拖动（与节点一致：先单击选中，再拖就是移动）。
     *
     * 拖出右侧栏、落在画布上松手 = 把卡片内容变成导图节点（见
     * options.onCardDropOnMap）；没拖动就是一次普通点击。
     */
    private cardDrag: {
        index: number;
        pointerId: number;
        startX: number;
        startY: number;
        moved: boolean;
        el: HTMLElement;
    } | null = null;

    /**
     * 正在编辑的卡片。
     *
     * draft = true 表示这是「还没写回文档」的新卡片（只有 DOM）。
     * clickX/clickY = 进入编辑那一下的屏幕坐标：光标落在点到的位置
     * （与普通节点「再点一下就从点击处出光标」一致）。
     */
    private editing: {
        index: number;
        display: NodeDisplay;
        original: string;
        draft: boolean;
        cardEl: HTMLElement;
        clickX?: number;
        clickY?: number;
        /**
         * 编辑期间外部把这张卡改没了（最新全文里找不到 original）。
         * 提交时不能再按序号写（会覆盖别人），改成追加成新卡片。
         */
        detached?: boolean;
    } | null = null;
    /** 草稿卡片的 display（不在 displays 里，单独销毁）。 */
    private draftDisplay: NodeDisplay | null = null;

    /**
     * 编辑期间到来的文档更新。
     *
     * 编辑时重建 DOM 会把输入框连同用户正在敲的内容一起抹掉，所以先存着，
     * 等这次编辑结束（提交或取消）再按最新全文重画。
     */
    private pendingMarkdown: string | null = null;
    /**
     * 延后的刷新是否要求强制重建。
     *
     * 换主题时 mini-CM 必须重建（明暗主题创建时烘进去了）；编辑中到来的
     * force 请求如果只存文本，编辑结束后会按默认 force=false 刷新，卡片
     * 就永远停在旧主题。这里跟着 pendingMarkdown 一起记。
     */
    private pendingForce = false;

    /** 卡片右键菜单。 */
    private menuEl: HTMLDivElement | null = null;

    private destroyed = false;

    constructor(container: HTMLElement, options: QuickCardRailOptions) {
        this.container = container;
        this.options = options;

        this.host = document.createElement('div');
        this.host.className = 'lwm-qcards';

        this.stack = document.createElement('div');
        this.stack.className = 'lwm-qcards-stack';

        this.addButton = document.createElement('button');
        this.addButton.type = 'button';
        // 加号就是一张带加号的侧边卡片：收起 / 悬浮展开 / 外观全走卡片那套
        this.addButton.className = 'lwm-qcard lwm-qcards-add';
        // 图标用内联 SVG：字体里的「＋」各字体基线不一致，塞进小卡片总是
        // 偏上或偏下；CSS 两条线拼的十字又太生硬。圆头描边的 SVG 不受
        // 字体影响，尺寸也和卡片按像素对齐
        this.addButton.appendChild(this.buildPlusIcon());
        // 只留无障碍名称，不要 title —— 加号很小，悬浮说明框反而碍事
        this.addButton.setAttribute('aria-label', '新建快速卡片');
        // 加号可以拖到别的应用（聊天框 / 记事本）里，落下的就是提示词
        this.addButton.draggable = true;
        this.addButton.addEventListener('dragstart', (event) => {
            const text = this.promptText();
            event.dataTransfer?.setData('text/plain', text);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
        });

        this.toolbarEl = this.buildToolbar();
        // 插入指示线挂在宿主上（不在 stack 里）：stack 的子元素全被
        // layoutStack 当成卡片排布，混一根线进去会打乱高度计算
        this.dropMark = document.createElement('div');
        this.dropMark.className = 'lwm-qcards-dropmark';
        this.dropMark.style.display = 'none';
        this.host.append(this.stack, this.dropMark);
        container.append(this.host, this.toolbarEl);

        this.host.addEventListener('click', this.onClick);
        this.host.addEventListener('dblclick', this.onDblClick);
        this.host.addEventListener('contextmenu', this.onContextMenu);
        // 选中后拖动 = 把卡片拖进画布；用捕获阶段，抢在 mini-CM 的
        // 选字逻辑之前记录起点（是否真开始拖还要看移动阈值）
        this.host.addEventListener('pointerdown', this.onCardPointerDown, true);
        // 卡片多到连最小可见高度都摆不下时（见 layoutStack 的滚动兜底），
        // 宿主变成滚动容器。宿主是 pointer-events:none，滚轮会落在卡片上
        // 再冒泡到这里；不是滚动态就完全不拦。
        this.host.addEventListener('wheel', this.onHostWheel, { passive: false });
        // 点别处取消选中。捕获阶段跑在页面其它点击之前。
        document.addEventListener('pointerdown', this.onDocPointerDown, true);
        document.addEventListener('keydown', this.onDocKeyDown, true);
        window.addEventListener('blur', this.onWindowBlur);
        // 摆放区下边界跟着缩略图顶部走：缩略图出现 / 消失都要重排，
        // 否则会一直按首次算出来的占位留空（或压住缩略图）。
        const minimap = container.querySelector<HTMLElement>(':scope > .lwm-minimap');
        if (minimap) {
            this.minimapObserver = new MutationObserver(() => this.scheduleRelayout());
            this.minimapObserver.observe(minimap, {
                attributes: true,
                attributeFilter: ['class'],
            });
        }

        // 直接 render（而不是 refresh）：refresh 在「卡片没变」时会跳过
        // 重建，第一次就永远挂不上加号卡片
        this.render();
    }

    // ==================================================================
    // 对外接口
    // ==================================================================

    /**
     * 文档内容 / 主题变化后刷新（编辑中则延后到编辑结束）。
     *
     * @param markdown - 新全文；缺省取 options.getMarkdown()
     * @param force - true 时即使卡片内容没变也重建（换主题必须重建：
     *                mini-CM 的明暗主题在创建时就烘进去了）
     */
    public refresh(markdown?: string, force = false): void {
        // 已销毁：destroy 里提交编辑会走到这里，别再重建一批 mini-CM
        if (this.destroyed) return;
        const text = markdown ?? this.options.getMarkdown();
        this.applySettings();
        if (this.editing) {
            this.pendingMarkdown = text;
            // force 不能丢：编辑中切主题，结束时必须强制重建
            this.pendingForce = this.pendingForce || force;
            // 编辑期间外部可能插入 / 删除了卡片：把被编辑卡片的序号按
            // 「原文本 + 最近行号」重新定位，提交时才不会写到别人身上。
            // 注意只改 session.index，不更新 this.cards / 不重画 DOM
            // （DOM 里的 data-index 还是编辑开始时那一套，重画会打断输入）。
            this.remapEditingIndex(text);
            return;
        }
        this.pendingMarkdown = null;
        this.pendingForce = false;
        const next = parseQuickCards(text);
        // 卡片没变就不重建 DOM：每建一个 mini-CM 要 10~20ms，而 setMarkdown
        // 在主编辑器每次输入都会调到这里，全量重建会把打字拖卡
        const same =
            next.length === this.cards.length &&
            next.every((card, i) => card.text === this.cards[i].text);
        const previous = { cards: this.cards, displays: this.displays };
        // 行号可能因为上方编辑而整体偏移，卡片本身没变也要更新区间
        this.cards = next;
        // 卡片增删后序号会漂移：固定的卡片按锚点重新定位
        this.remapPinned(next);
        // 关掉卡片栏时只更新解析结果，不建 mini-CM（建了也看不见）。
        // 已经清空过就别每敲一个字再清一次。
        if (!this.enabled) {
            if (this.displays.size > 0 || this.stack.childElementCount > 0) {
                this.destroyDisplays();
                this.stack.textContent = '';
            }
            return;
        }
        if (same && !force) return;
        // force（换主题）必须整批重建：mini-CM 的主题在创建时烘进去了。
        // 普通刷新只重建文本真的变了的那几张，其余 display 直接复用。
        this.render(force ? null : previous);
    }

    /**
     * 编辑期间外部文档更新：按锚点重新定位被编辑的卡片。
     *
     * 卡片序号是会漂移的（外部在它前面插 / 删一张，同一个 index 就指向
     * 另一张卡）。提交时按旧序号写回会覆盖别人。这里用「编辑开始时记下的
     * 原文」在最新全文里找，同样文本有多张时取行号离原位最近的那张；
     * 一张都找不到说明这张卡已被外部改掉 / 删除，标记 detached，提交时
     * 改成追加新卡片，绝不按序号盲写。
     */
    private remapEditingIndex(text: string): void {
        const session = this.editing;
        if (!session || session.draft) return;
        const cards = parseQuickCards(text);
        const previous = this.cards[session.index];
        let best = -1;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let i = 0; i < cards.length; i += 1) {
            if (cards[i]!.text !== session.original) continue;
            const distance = Math.abs(
                (previous?.fromLine ?? 0) - cards[i]!.fromLine
            );
            if (distance < bestDistance) {
                best = i;
                bestDistance = distance;
            }
        }
        if (best >= 0) {
            // 这张卡如果同时被固定，序号也要跟着挪，否则提交后更新锚点会
            // 查错卡片（pinned 记的是序号）
            if (best !== session.index && this.pinned.has(session.index)) {
                this.pinned.delete(session.index);
                this.pinned.add(best);
            }
            session.index = best;
            session.detached = false;
        } else {
            session.detached = true;
        }
    }

    /**
     * 把固定的卡片按内容锚点重新定位到最新解析结果上。
     *
     * 锚点 = 卡片原文 + 原行号。原文相同（重复卡片）时取行号最近的，
     * 并且一张卡片只能被一个锚点占用。找不到说明卡片被删/被外部改掉，
     * 固定状态随之失效。
     */
    private remapPinned(cards: QuickCard[]): void {
        if (this.pinnedAnchors.length === 0) {
            this.pinned.clear();
            return;
        }
        const used = new Set<number>();
        const next = new Set<number>();
        const anchors: Array<{ text: string; fromLine: number }> = [];
        for (const anchor of this.pinnedAnchors) {
            let best = -1;
            let bestDistance = Number.POSITIVE_INFINITY;
            for (let i = 0; i < cards.length; i += 1) {
                if (used.has(i)) continue;
                const card = cards[i]!;
                if (card.text !== anchor.text) continue;
                const distance = Math.abs(card.fromLine - anchor.fromLine);
                if (distance < bestDistance) {
                    best = i;
                    bestDistance = distance;
                }
            }
            if (best < 0) continue;
            used.add(best);
            next.add(best);
            anchors.push({
                text: cards[best]!.text,
                fromLine: cards[best]!.fromLine,
            });
        }
        this.pinned = next;
        this.pinnedAnchors = anchors;
    }

    /** 切换固定状态（右键菜单）。 */
    private togglePin(index: number): void {
        const card = this.cards[index];
        if (!card) return;
        if (this.pinned.has(index)) {
            this.pinned.delete(index);
            this.pinnedAnchors = this.pinnedAnchors.filter(
                (anchor) =>
                    !(anchor.text === card.text && anchor.fromLine === card.fromLine)
            );
        } else {
            this.pinned.add(index);
            this.pinnedAnchors.push({ text: card.text, fromLine: card.fromLine });
        }
        this.updateCardStates();
    }

    /**
     * 本栏自己改了卡片内容（编辑提交 / 表格 widget 回写）时，先更新锚点。
     *
     * 否则 commit → refresh 会拿旧锚点去匹配不上新文本，固定状态被误清。
     * 传空数组表示这张卡被删掉，固定一并清掉。
     */
    private updatePinnedAnchor(index: number, cards: QuickCard[]): void {
        if (!this.pinned.has(index)) return;
        const current = this.cards[index];
        if (current) {
            this.pinnedAnchors = this.pinnedAnchors.filter(
                (anchor) =>
                    !(
                        anchor.text === current.text &&
                        anchor.fromLine === current.fromLine
                    )
            );
        }
        const updated = cards[index];
        if (updated) {
            this.pinnedAnchors.push({
                text: updated.text,
                fromLine: updated.fromLine,
            });
        } else {
            this.pinned.delete(index);
        }
    }

    /** 设置变化后重设开关与全局宽度（幂等，可反复调用）。 */
    public applySettings(): void {
        const settings = this.options.getSettings();
        const wasEnabled = this.enabled;
        // 编辑中被关掉：先把这次编辑落掉，别把内容留在 DOM 里
        if (!settings.enabled && this.editing) this.finishEdit();
        this.enabled = settings.enabled;
        this.host.style.display = settings.enabled ? '' : 'none';
        // 关掉卡片栏时工具条一起藏（它挂在容器上，不在 host 里）
        if (!settings.enabled) this.toolbarEl.style.display = 'none';
        // 宽度全局一个值：拖动左边界改的就是它。拖动中别被设置回写打断。
        if (!this.resize) {
            this.currentWidth = this.clampWidth(settings.width);
            this.host.style.setProperty('--lwm-qcard-width', `${this.currentWidth}px`);
        }
        // 从关到开：关闭期间 refresh 只解析、没建 mini-CM，这里补建
        if (settings.enabled && !wasEnabled) this.refresh(undefined, true);
    }

    /**
     * 夹住宽度：只有下限 160，没有上限（用户要拖多宽就多宽）。
     *
     * 非有限值（配置被写坏）时退回默认 280。
     */
    private clampWidth(width: number): number {
        const value = Number.isFinite(width) ? width : 280;
        return Math.round(Math.max(value, MIN_CARD_WIDTH));
    }

    /**
     * 清掉选中态（换文档时调用）。
     *
     * 选中记的是序号，换了一份文档后同一个序号对应的是另一张卡片，
     * 不清就会出现「随机一张卡片自己展开 + 工具条飘着」。不动编辑态：
     * 文档是外部同步过来的，不该打断正在输入的卡片。
     */
    public clearSelection(): void {
        this.closeMenu();
        // clearActive → updateCardStates → positionToolbar 会把工具条收掉
        this.clearActive();
    }

    /**
     * 立即提交正在编辑的卡片。
     *
     * 卡片编辑不是导图的 editSession：Ctrl+S 的 forceWrite 只认 editSession，
     * 不先调这里的话保存下去的是卡片改动之前的全文。
     */
    public flushEdit(): void {
        if (this.destroyed) return;
        this.finishEdit();
    }

    /**
     * 卡片快捷键入口（由导图的 window keydown 在分流前调用）。
     *
     * 侧边卡片选中时：
     * - Delete / Backspace 删除这张卡片（与导图节点同一键位）；
     * - Ctrl/Cmd+C/X/V 作用于卡片而不是导图树 —— 复制 / 剪切卡片内容，
     *   粘贴则在当前卡片下面新建一张卡片。
     *
     * @returns true = 已处理，调用方不要再当导图快捷键处理
     */
    public handleKey(event: KeyboardEvent): boolean {
        if (this.destroyed) return false;
        // 卡片栏被关掉 / 卡片内编辑中：都不抢快捷键
        if (this.host.style.display === 'none') return false;
        const index = this.activeIndex;
        if (index === null || this.editing) return false;
        const target = event.target instanceof Element ? event.target : null;
        // 真的落在输入框里（如卡内编辑）时也让编辑器自己处理
        if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return false;
        // Delete / Backspace：删除选中的卡片（与导图节点同一个键位）。
        // 这条不带修饰键，必须放在下面的 Ctrl/Cmd 判断之前。
        if (
            (event.key === 'Delete' || event.key === 'Backspace') &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey
        ) {
            event.preventDefault();
            event.stopPropagation();
            this.removeCard(index);
            return true;
        }
        if (!(event.ctrlKey || event.metaKey)) return false;
        // 带 Shift 的 C/X/V 也必须由卡片栏吃掉：放行的话会落到导图的
        // 子树剪贴板（Ctrl+Shift+V 会把剪贴板子树插进画布，直接改文档）。
        // 行为上不区分 Shift：复制 / 剪切 / 粘贴这张卡片。
        if (event.altKey) return false;
        const key = event.key.toLowerCase();
        if (key !== 'c' && key !== 'x' && key !== 'v') return false;
        event.preventDefault();
        event.stopPropagation();
        if (key === 'c') this.copyActiveCard();
        else if (key === 'x') this.cutActiveCard();
        else void this.pasteBelowActiveCard();
        return true;
    }

    /** 复制选中卡片的内容（不带 <<< / >>> 围栏，粘到别处就是普通 Markdown）。 */
    private copyActiveCard(): void {
        const index = this.activeIndex;
        const card = index === null ? null : this.cards[index];
        if (!card || !card.text.trim()) return;
        void this.options.copyText?.(card.text);
    }

    /** 剪切选中卡片：先复制内容，再把卡片块从文档里删掉（一步撤销）。 */
    private cutActiveCard(): void {
        const index = this.activeIndex;
        if (index === null) return;
        const card = this.cards[index];
        if (!card) return;
        if (card.text.trim()) void this.options.copyText?.(card.text);
        const before = this.options.getMarkdown();
        const next = deleteQuickCard(before, index);
        this.activeIndex = null;
        this.selectOnlyIndex = null;
        if (next !== before) this.options.commit(next);
        this.updateCardStates();
    }

    /**
     * 粘贴到选中卡片的下面（新建一张卡片）。
     *
     * 剪贴板里如果本身就是卡片块（复制出来的原始文本），取里面的内容；
     * 普通 Markdown 原样包成一张新卡片。
     */
    private async pasteBelowActiveCard(): Promise<void> {
        const index = this.activeIndex;
        if (index === null) return;
        const clip = (await this.options.readText?.()) ?? '';
        if (!clip.trim()) return;
        // 读剪贴板是异步的：期间面板可能已经销毁 / 选中变了，都不往旧位置塞
        if (this.destroyed || this.activeIndex !== index) return;
        const blocks = parseQuickCards(clip);
        const content = blocks.length > 0 ? blocks.map((b) => b.text).join('\n\n') : clip;
        const before = this.options.getMarkdown();
        // 在「自己」后面插入：序号 + 1
        const next = insertQuickCard(before, index + 1, content);
        if (next === before) return;
        this.options.commit(next);
        this.activeIndex = index + 1;
        this.updateCardStates();
    }

    /** 切回文本模式时调用：提交编辑、收起卡片栏。 */
    public deactivate(): void {
        this.finishEdit();
        this.closeMenu();
        this.activeIndex = null;
        this.resetDisplaySelections();
        this.updateCardStates();
    }

    /** 调试 / 探针用：当前卡片数与状态。 */
    public debugState(): {
        count: number;
        activeIndex: number | null;
        editing: boolean;
    } {
        return {
            count: this.cards.length,
            activeIndex: this.activeIndex,
            editing: !!this.editing,
        };
    }

    /** 销毁：摘掉所有全局监听并移除 DOM。 */
    public destroy(): void {
        this.destroyed = true;
        this.finishEdit();
        this.closeMenu();
        document.removeEventListener('pointerdown', this.onDocPointerDown, true);
        document.removeEventListener('keydown', this.onDocKeyDown, true);
        window.removeEventListener('blur', this.onWindowBlur);
        this.minimapObserver?.disconnect();
        this.minimapObserver = null;
        if (this.relayoutRaf) {
            cancelAnimationFrame(this.relayoutRaf);
            this.relayoutRaf = 0;
        }
        this.host.removeEventListener('wheel', this.onHostWheel);
        window.removeEventListener('pointermove', this.onCardPointerMove, true);
        window.removeEventListener('pointerup', this.onCardPointerUp, true);
        window.removeEventListener('pointercancel', this.onCardPointerUp, true);
        // 销毁时可能正拖着卡片：把画布上的落点高亮撤干净
        this.options.onCardDragPreview?.(null);
        this.cardDrag = null;
        this.destroyDisplays();
        this.host.remove();
        this.toolbarEl.remove();
        // 右下角的小浮条挂在 body 上，别留给下一份实例
        window.clearTimeout(this.toastTimer);
        this.toastEl?.remove();
        this.toastEl = null;
    }

    // ==================================================================
    // 渲染
    // ==================================================================

    /**
     * 按当前 cards 重建卡片堆叠区。
     *
     * @param reuse 上一轮的「卡片文本 + display」，文本没变的卡片直接复用，
     *        不再新建 mini-CM（换主题传 null，必须整批重建）。文本没变
     *        但序号变了（上方插了一张）也不复用：display 的 onDisplayChange
     *        闭包和 dataset.index 都是按序号绑的，换序号就得重建。
     */
    private render(
        reuse: { cards: QuickCard[]; displays: Map<number, NodeDisplay> } | null = null
    ): void {
        const oldDisplays = reuse?.displays ?? this.displays;
        const reused = new Set<NodeDisplay>();
        const nextDisplays = new Map<number, NodeDisplay>();
        this.stack.textContent = '';
        if (this.activeIndex !== null && this.activeIndex >= this.cards.length) {
            this.activeIndex = null;
        }
        this.cards.forEach((card, index) => {
            const old = reuse?.displays.get(index);
            const keep = old && reuse?.cards[index]?.text === card.text ? old : undefined;
            if (keep) reused.add(keep);
            this.stack.appendChild(this.buildCard(card, index, keep, nextDisplays));
        });
        // 没被复用的旧 display（删掉的卡片 / 内容变了的卡片）统一销毁
        for (const display of oldDisplays.values()) {
            if (!reused.has(display)) display.destroy();
        }
        this.displays = nextDisplays;
        // 加号永远排在最后：它也是一张卡片（收起 / 悬浮展开一致）
        this.stack.appendChild(this.addButton);
        this.applySettings();
        this.updateCardStates();
        this.layoutStack();
        // 图片 / 表格 / mermaid 等 widget 可能晚一帧才定高，补一次摆放。
        // 普通纯文本卡片（占绝大多数）不需要，免掉每轮两次强制布局。
        const asyncContent = this.cards.some((card) =>
            /(^|\n)\s*(\||`{3,}|~{3,}|!\[|mermaid)/.test(card.text)
        );
        if (!asyncContent) return;
        requestAnimationFrame(() => {
            if (!this.destroyed) this.layoutStack();
        });
    }

    /**
     * 侧边摆放区域：视口顶部 → 右下角缩略图（缩放概览）顶部。
     *
     * 缩略图是画布上的浮层，卡片栏不能压在它上面；缩略图藏起来时
     * 整列到底。
     */
    private layoutRange(): { top: number; bottom: number } {
        const rect = this.container.getBoundingClientRect();
        const minimap = this.container.querySelector<HTMLElement>(
            ':scope > .lwm-minimap'
        );
        // 用 CSS 里的 bottom + height 算占位，而不是 getBoundingClientRect：
        // 缩略图一开始是 display:none（首帧才出现），rect 会是 0，
        // 那样第一次摆放会算成整列高度、之后又不会重排。
        // 但 display:none 时 computed height 仍有值（120px），所以必须
        // 先看 display：缩略图没显示时不能白留一块。
        let reserved = 0;
        if (minimap) {
            const style = getComputedStyle(minimap);
            if (style.display !== 'none') {
                const bottom = parseFloat(style.bottom) || 0;
                const height = parseFloat(style.height) || 0;
                reserved = bottom + height;
            }
        }
        return { top: rect.top, bottom: rect.bottom - reserved };
    }

    /**
     * 侧边摆放：放得下就平铺，放不下就按「封顶高度」重叠。
     *
     * 放不下时求一个封顶高度 cap，使
     *   Σ 每张卡片 visibleHeight(高度, cap) + 加号高度 = 摆放区高度
     * 也就是：比 cap 矮的卡片完整显示，比 cap 高的卡片收起后只露
     * `cap + 半行`（见 visibleHeight），其余部分**自己裁掉**（CSS 用
     * `--lwm-qcard-visible` 写 clip-path）。不能只靠下一张盖住：下一张
     * 可能比这一张矮很多（末尾的加号只有一行高），长卡片的下半截边框
     * 会从下面露出来，看起来就像「根本没压缩、全部显示」。
     *
     * 多露的半行像「半截字」一样，一眼能看出这张卡是被截断的。
     *
     * z-index 严格按顺序递增（下面的卡片盖住上面的卡片）。展开的卡片**不提
     * 层级**，所以：
     * - 它下面的卡片收起后仍然画在它右边缘之上（下面节点优先）；
     * - 它上面的卡片收起后那条边框被展开卡片的底色盖住（上面节点不显示）。
     *
     * 接缝不漏白底（见 CARD_RADIUS / SEAM_PAD 的注释）：被压缩的卡片向下
     * 多画 SEAM_PAD，垫在下一张的左上圆角底下；下一张的实心底色把这段的
     * 其余部分盖住，圆角缺口里透出的是上一张的色而不是画布。没被压缩的
     * 短卡片画不到自己的底边以下，这种情况保持圆角原样，不做压平。
     */
    private layoutStack(): void {
        const items = Array.from(this.stack.children).filter(
            (el): el is HTMLElement => el instanceof HTMLElement
        );
        if (items.length === 0) return;
        const range = this.layoutRange();
        const available = Math.floor(range.bottom - range.top);
        if (!(available > 0)) return;
        // 宿主高度就是摆放区高度：堆叠区在其中垂直居中，放不下时它的
        // 自身高度刚好等于摆放区高度，居中 = 从顶部开始
        this.host.style.height = `${available}px`;
        // 先量自然高度（读 offsetHeight 会触发一次布局，正好拿到干净值）。
        // 这里不能给卡片加 max-height 去裁收起态：offsetHeight 会跟着被裁，
        // 下一轮就量不到自然高度，摆放会在「按完整高度算」和「按裁后算」
        // 之间来回跳。可见高度只由下面写下的 top / clip 决定。
        // 但 hover / 选中态的 CSS 确实会给展开卡片加 max-height，测量时
        // 用一个临时类把它取消掉，否则鼠标停在长卡上时量到的是被截断的高度。
        this.host.classList.add('lwm-qcards-measuring');
        const heights = items.map((el) => el.offsetHeight);
        this.host.classList.remove('lwm-qcards-measuring');
        const total = heights.reduce((sum, h) => sum + h, 0);
        // 半行取卡片正文的真实行高：字体 / 字号跟着设置走，不能写死
        const halfLine = this.halfLineHeight();

        // 极端情况：卡片多到连「最小可见高度 + 加号」都放不下，再二分也没解。
        // 这时不再硬叠（否则末尾几张和加号会被裁出可视区、永远点不到），
        // 改成宿主内部滚动，所有卡片按自然高度排开。
        const plusH = heights[heights.length - 1] ?? 0;
        const cardHeights = heights.slice(0, -1);
        const minimumTotal =
            cardHeights.reduce(
                (sum, h) => sum + Math.min(h, MIN_PEEK + halfLine),
                0
            ) + plusH;
        const scrollable = cardHeights.length > 0 && minimumTotal > available;

        // 每张卡片收起后占的高度（used）：
        // 放得下 → 自然高度；放不下 → min(高度, cap + 半行)。
        // 放得下与否要看**含间距**的总高，否则刚好放得下时整组会比区高
        // 出一截，末尾加号被宿主裁掉。
        const withGaps = total + STACK_GAP * Math.max(0, items.length - 1);
        const overflow = !scrollable && withGaps > available;
        const used: number[] = heights.slice();
        if (overflow) {
            const cap = this.computePeekHeight(heights, available, halfLine);
            for (let i = 0; i < items.length; i++) {
                used[i] = this.visibleHeight(heights[i]!, cap, halfLine);
            }
        }
        // 卡片全部绝对定位：top 一次算好，展开 / 收起高度变化不会把别的
        // 卡片顶动（flex 流式排列时鼠标一移过去侧边就整体重排）。
        // 放得下时整组垂直居中，放不下时从顶部开始；滚动兜底态从顶部
        // 按自然高度依次排开、不重叠。
        const stackHeight = scrollable
            ? total
            : overflow
              ? used.reduce((sum, h) => sum + h, 0)
              : withGaps;
        const start = scrollable
            ? 0
            : Math.max(0, (available - stackHeight) / 2);
        const spacing = scrollable || overflow ? 0 : STACK_GAP;
        if (scrollable) {
            this.host.dataset.scrollable = 'true';
            this.host.style.overflowY = 'auto';
            this.stack.style.height = `${stackHeight}px`;
        } else {
            delete this.host.dataset.scrollable;
            this.host.style.overflowY = '';
            this.stack.style.height = '';
        }
        const tops: number[] = [];
        let top = start;
        items.forEach((_el, i) => {
            tops.push(top);
            top += (overflow ? used[i]! : heights[i]!) + (i < items.length - 1 ? spacing : 0);
        });
        // 圆角半径以实际 CSS 为准（canvasCss 里是 8px），避免两处硬编码漂移
        const seamPad = this.cardRadius() + 2;
        items.forEach((el, i) => {
            el.style.zIndex = String(i + 1);
            el.style.top = `${Math.round(tops[i]!)}px`;
            if (scrollable) {
                // 滚动兜底态：卡片完整显示，展开也不再有高度上限
                el.style.setProperty('--lwm-qcard-max-h', 'none');
                delete el.dataset.clipped;
                return;
            }
            // 展开态的高度上限：从槽位顶部往下最多长到摆放区底部（缩略图
            // 顶部），越过去时卡片内部滚动。放得下时 max-height 大于自然
            // 高度、不生效。卡片本身上下各 1px 描边，减掉才正好落在底部。
            el.style.setProperty(
                '--lwm-qcard-max-h',
                `${Math.max(0, Math.floor(available - tops[i]! - 2))}px`
            );
            // 只给真正被压缩的卡片挂裁剪（CSS 的 clip-path 会连投影一起裁掉，
            // 放得下 / 本来就不高的卡片不该丢阴影）。裁掉的那段正好由下一张
            // 卡片的顶边接上：下一张的 z-index 更高，边框和底色都盖在上面。
            // 有下一张时多画 SEAM_PAD：这段垫在下一张的左上圆角底下，
            // 圆角缺口里透出的是上一张的颜色而不是画布底色；下一张的
            // 不透明底色 / 边框会把其余部分盖住。
            const clipped = overflow && used[i]! < heights[i]! - 0.5;
            if (clipped) {
                const extra = i < items.length - 1 ? seamPad : 0;
                el.dataset.clipped = 'true';
                el.style.setProperty(
                    '--lwm-qcard-visible',
                    `${used[i]! + extra}px`
                );
            } else {
                delete el.dataset.clipped;
            }
        });
        // 卡片位置变了：选中卡片的工具条跟着挪
        this.positionToolbar();
    }

    /**
     * 一张卡片收起后实际露出的高度。
     *
     * 不超过封顶高度 → 整张可见；超高 → 只露「封顶 + 半行」。
     * （cap + halfLine 恒不小于 cap，所以统一写 min 就同时覆盖两种情况。）
     */
    private visibleHeight(height: number, cap: number, halfLine: number): number {
        return Math.min(height, cap + halfLine);
    }

    /** 卡片圆角半径：以 CSS 实际值为准，读不到时退回常量。 */
    private cardRadius(): number {
        const card = this.stack.querySelector<HTMLElement>('.lwm-qcard');
        if (!card) return CARD_RADIUS;
        const radius = parseFloat(getComputedStyle(card).borderTopLeftRadius);
        return Number.isFinite(radius) && radius > 0 ? radius : CARD_RADIUS;
    }

    /** 卡片正文一行高度的一半（量不到时用兜底值）。 */
    private halfLineHeight(): number {
        // 卡片挂在 #mindmap 上，不在画布的缩放层里：屏幕像素 = 卡片像素。
        // 优先用计算值的 line-height（跟随设置里的字体 / 倍行距），
        // 它是 "normal" 时再退回第一行的实际排版高度
        const body = this.stack.querySelector<HTMLElement>('.lwm-qcard .lwm-qcard-body');
        if (body) {
            const lineHeight = parseFloat(getComputedStyle(body).lineHeight);
            if (Number.isFinite(lineHeight) && lineHeight > 0) {
                return Math.round(lineHeight / 2);
            }
        }
        const line = this.stack.querySelector<HTMLElement>('.lwm-qcard .cm-line');
        const height = line?.getBoundingClientRect().height ?? 0;
        return height > 0 ? Math.round(height / 2) : FALLBACK_HALF_LINE;
    }

    /**
     * 求重叠摆放时每张卡片保留的最小高度 cap。
     *
     * 约束：所有卡片的 visibleHeight(h, cap) 之和 + 加号高度 = 摆放区高度。
     * 加号不参与封顶（它本来就很矮，而且必须完整露出）。
     * 卡片高度之和 ≤ 预算时返回最大高度（即根本不需要重叠）。
     */
    private computePeekHeight(heights: number[], available: number, halfLine: number): number {
        // 最后一项是加号卡片
        const plusH = heights[heights.length - 1] ?? 0;
        const cards = heights.slice(0, -1);
        if (cards.length === 0) return Math.max(available - plusH, MIN_PEEK);
        const budget = Math.max(0, available - plusH);
        const sumAt = (cap: number): number =>
            cards.reduce((sum, h) => sum + this.visibleHeight(h, cap, halfLine), 0);
        const maxH = Math.max(...cards, MIN_PEEK);
        if (sumAt(maxH) <= budget) return maxH;
        let lo = MIN_PEEK;
        let hi = maxH;
        // 24 次二分足够精确到亚像素，别为这点小事写公式
        for (let i = 0; i < 24; i++) {
            const mid = (lo + hi) / 2;
            if (sumAt(mid) <= budget) lo = mid;
            else hi = mid;
        }
        return Math.max(lo, MIN_PEEK);
    }

    /**
     * 选中卡片时出现的浮动工具条（复用节点的 .lwm-toolbar）。
     *
     * 卡片不是树节点，所以没有「＋子节点 / ＋兄弟」，换成卡片自己的
     * 三个动作：编辑 / 新建卡片 / 删除。
     */
    private buildToolbar(): HTMLDivElement {
        const bar = document.createElement('div');
        bar.className = 'lwm-toolbar lwm-qcards-toolbar';
        bar.style.display = 'none';
        // 按钮文字已经说明了一切，不要再挂 title（悬浮说明框会挡住卡片）
        const items: Array<{ act: string; label: string }> = [
            { act: 'edit', label: '编辑' },
            { act: 'new', label: '新建卡片' },
            // 固定：与右键菜单同一份状态，标签在 positionToolbar 里同步
            { act: 'pin', label: '固定' },
            { act: 'delete', label: '删除' },
        ];
        for (const item of items) {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.act = item.act;
            button.textContent = item.label;
            bar.appendChild(button);
        }
        // 与节点工具条一致：按下不抢焦点（编辑中失焦会立刻提交会话），
        // 也不让事件漏给画布触发平移 / 取消选中
        bar.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
            event.preventDefault();
        });
        bar.addEventListener('click', (event) => {
            event.stopPropagation();
            const target = event.target instanceof Element ? event.target : null;
            const button = target?.closest<HTMLElement>('button[data-act]');
            const index = this.activeIndex;
            if (!button || index === null) return;
            const act = button.dataset.act;
            if (act === 'edit') this.startEdit(index);
            else if (act === 'new') this.startNewCard();
            else if (act === 'pin') this.togglePin(index);
            else if (act === 'delete') this.removeCard(index);
        });
        return bar;
    }

    /** 把工具条摆到选中卡片上方（放不下就放下面），并夹在画布内。 */
    private positionToolbar(): void {
        const index = this.activeIndex;
        if (index === null) {
            this.toolbarEl.style.display = 'none';
            return;
        }
        const cardEl = this.stack.querySelector<HTMLElement>(
            `.lwm-qcard[data-index="${index}"]`
        );
        if (!cardEl) {
            this.toolbarEl.style.display = 'none';
            return;
        }
        const bar = this.toolbarEl;
        bar.style.display = '';
        // 固定按钮的文案跟着当前卡片状态走。必须在测量 barRect 之前改：
        // 「取消固定」比「固定」宽，改完宽度才能被正确居中。
        const pinButton = bar.querySelector<HTMLElement>('button[data-act="pin"]');
        if (pinButton) {
            pinButton.textContent = this.pinned.has(index) ? '取消固定' : '固定';
        }
        const containerRect = this.container.getBoundingClientRect();
        // 横向用宿主矩形：选中卡片一定处于展开终态（transform 归零），
        // 左边 = 宿主左边、宽度 = 宿主宽度。直接读卡片 rect 会拿到
        // translateX 过渡起点（卡片还在画布外），工具条被夹到最右边且
        // 过渡结束后不会再摆一次。纵向只用 rect.top —— translateX 不影响 y。
        const hostRect = this.host.getBoundingClientRect();
        const rect = cardEl.getBoundingClientRect();
        const barRect = bar.getBoundingClientRect();
        let left =
            hostRect.left - containerRect.left + hostRect.width / 2 - barRect.width / 2;
        let top = rect.top - containerRect.top - barRect.height - 6;
        // 上方贴到画布外就翻到卡片下面
        if (top < 4) top = rect.bottom - containerRect.top + 6;
        left = Math.max(
            4,
            Math.min(left, containerRect.width - barRect.width - 4)
        );
        bar.style.left = `${Math.round(left)}px`;
        bar.style.top = `${Math.round(top)}px`;
    }

    /** 第 index 张卡片该用色板里的哪一个色（按 CARD_TINT_ORDER 轮换）。 */
    private tintIndexOf(index: number): number {
        return CARD_TINT_ORDER[index % CARD_TINT_ORDER.length]!;
    }

    /**
     * 生成一张卡片（左侧色边 + 只读 mini-CM 正文）。
     *
     * @param reuse   文本没变的旧 display（直接搬进新卡片，省掉建 CM 的 10~20ms）
     * @param displays 本轮的新 index→display 表（由调用方统一替换）
     */
    private buildCard(
        card: QuickCard,
        index: number,
        reuse: NodeDisplay | undefined,
        displays: Map<number, NodeDisplay>
    ): HTMLElement {
        const el = document.createElement('div');
        el.className = 'lwm-qcard';
        el.dataset.index = String(index);
        // 卡片可以 Tab 到；焦点进来就选中（不直接进编辑，与鼠标单击一致）
        el.tabIndex = 0;
        el.addEventListener('focus', () => {
            if (!this.destroyed && !this.editing) this.activate(index);
        });
        // 底色 / 描边取标题色板轮换（按冷暖交替的顺序，相邻两张色差最大）
        const tintIndex = this.tintIndexOf(index);
        el.style.setProperty(
            '--lwm-node-tint',
            `var(--livewritemd-h${tintIndex + 1}-color, ${HEADING_TINT_FALLBACKS[tintIndex]})`
        );
        const body = document.createElement('div');
        body.className = 'lwm-qcard-body';
        const display =
            reuse ??
            createNodeDisplay({
                doc: card.text,
                // 哨兵行：卡片正文里如果只有一个块（代码 / 表格），
                // 选区停在块外，块装饰才会按渲染态显示
                sentinel: true,
                theme: this.options.getTheme(),
                codeLanguages: this.options.codeLanguages,
                // 显示态 widget（表格加行列、mermaid 宽度）改了本地文档 → 回写卡片
                onDisplayChange: (text) => this.onCardDisplayChange(index, text),
            });
        displays.set(index, display);
        body.appendChild(display.container);
        el.appendChild(body);
        el.appendChild(this.buildResizeHandle());
        return el;
    }

    /**
     * 卡片左边界上的宽度拖手。
     *
     * 只改全局宽度（所有卡片一起变宽变窄），拖动中只写 CSS 变量，
     * 松手才回调宿主落盘。拖动超过 3px 才算数，避免误碰左边界就吞掉点击。
     */
    private buildResizeHandle(): HTMLElement {
        const handle = document.createElement('div');
        handle.className = 'lwm-qcard-resize';
        // 不挂 title：卡片很窄，悬浮说明框会盖住正文

        handle.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            // 注意：这里**不能** preventDefault —— 取消 pointerdown 会连带
            // 取消兼容鼠标事件，收起态下对着色带的一次普通点击就选不中卡片了。
            // 拖动时的文字选择由 pointermove 分支负责阻止。
            event.stopPropagation();
            this.resize = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startWidth: this.currentWidth,
                moved: false,
                handle,
            };
            // 拖手不是 mini-CM 内容，捕获指针不会影响选字；
            // 合成事件的 pointerId 不是活跃指针，捕获会抛错，忽略即可
            try {
                handle.setPointerCapture(event.pointerId);
            } catch {
                /* 合成事件 / 指针已失效 */
            }
        });

        handle.addEventListener('pointermove', (event) => {
            const drag = this.resize;
            if (!drag || drag.pointerId !== event.pointerId) return;
            const dx = event.clientX - drag.startX;
            if (!drag.moved && Math.abs(dx) < 3) return;
            drag.moved = true;
            // 真开始拖了再吞默认行为（防止拖出文字选区）
            event.preventDefault();
            // 左边界往左拖（dx < 0）= 卡片变宽
            this.currentWidth = this.clampWidth(drag.startWidth - dx);
            this.host.style.setProperty('--lwm-qcard-width', `${this.currentWidth}px`);
        });

        const finish = (event: PointerEvent): void => this.endResize(event);
        handle.addEventListener('pointerup', finish);
        handle.addEventListener('pointercancel', finish);
        return handle;
    }

    /**
     * 结束宽度拖动。
     *
     * 除了拖手的 pointerup / pointercancel，窗口失焦（Alt-Tab、指针在窗口外
     * 松开导致收不到 pointerup）也必须走这里收尾：否则 this.resize 永远
     * 非 null，applySettings 会一直跳过宽度写入，设置面板改宽度直接失效，
     * 而且这次的宽度也不会落盘。
     *
     * @param event 有事件时校验 pointerId 并吞掉浏览器补发的 click；
     *              失焦收尾没有事件，直接把已拖出的宽度落盘
     */
    private endResize(event?: PointerEvent): void {
        const drag = this.resize;
        if (!drag) return;
        if (event && drag.pointerId !== event.pointerId) return;
        this.resize = null;
        try {
            if (drag.handle.hasPointerCapture?.(drag.pointerId)) {
                drag.handle.releasePointerCapture(drag.pointerId);
            }
        } catch {
            /* 指针已经失效 */
        }
        if (!drag.moved) return;
        if (event) {
            // pointerup 之后浏览器还会补一个 click：别把它当成选中 / 编辑
            this.suppressNextClick(event.clientX, event.clientY);
        }
        // 宽度变了 → 卡片高度可能跟着变，重新摆放
        this.layoutStack();
        this.options.onResize?.(this.currentWidth);
    }

    /** 加号图标：16×16 视野里一个圆头十字，显示尺寸交给 CSS。 */
    private buildPlusIcon(): SVGSVGElement {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 16 16');
        // 纯装饰：无障碍名称挂在按钮上
        svg.setAttribute('aria-hidden', 'true');
        svg.classList.add('lwm-qcards-add-icon');
        const path = document.createElementNS(ns, 'path');
        // 横竖各留 3.8 的边距，圆头收尾：视觉上是一个完整的「＋」，
        // 而不是两条顶到边的线
        path.setAttribute('d', 'M8 4.2v7.6M4.2 8h7.6');
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'currentColor');
        path.setAttribute('stroke-width', '1.7');
        path.setAttribute('stroke-linecap', 'round');
        svg.appendChild(path);
        return svg;
    }

    /** 显示态 widget 改了卡片内容：写回文档（index 以当前解析为准）。 */
    private onCardDisplayChange(index: number, text: string): void {
        if (this.editing) return;
        const markdown = this.options.getMarkdown();
        const next = updateQuickCard(markdown, index, text);
        if (next === markdown) return;
        // 固定卡片的原文变了：先更新锚点，避免 remap 把固定状态弄丢
        if (this.pinned.has(index)) {
            this.updatePinnedAnchor(index, parseQuickCards(next));
        }
        this.options.commit(next);
    }

    /** 销毁所有卡片显示实例（重建 / 关闭时调用）。 */
    private destroyDisplays(): void {
        for (const display of this.displays.values()) display.destroy();
        this.displays.clear();
        this.draftDisplay?.destroy();
        this.draftDisplay = null;
    }

    /** 同步选中态 / 编辑态到 DOM（选中直接复用节点的 .lwm-node-selected）。 */
    private updateCardStates(): void {
        this.stack.querySelectorAll<HTMLElement>('.lwm-qcard').forEach((el) => {
            // 草稿卡片没有 index（还不在文档里），状态在创建时写死，别覆盖
            if (el.dataset.draft === 'true') return;
            const index = Number(el.dataset.index);
            const active = index === this.activeIndex;
            el.classList.toggle('lwm-node-selected', active);
            // 固定态：CSS 靠它保持展开，不受 hover / 选中影响
            if (this.pinned.has(index)) el.dataset.pinned = 'true';
            else delete el.dataset.pinned;
            if (this.editing && Number(el.dataset.index) === this.editing.index) {
                el.dataset.editing = 'true';
            } else {
                delete el.dataset.editing;
            }
        });
        // 单击选中就出工具条（与普通节点一致）
        this.positionToolbar();
    }

    // ==================================================================
    // 选中（交互与普通节点一致：单击选中、双击编辑）
    // ==================================================================

    /**
     * 把卡片显示实例的选区复位到文末。
     *
     * mini-CM 的「聚焦行显示源码」规则会让点过的那一行一直露着 `**` / `#`
     * 之类的标记，节点那边靠 resetSelection 在取消选中时收回去；卡片同理。
     * resetSelection 对「已经停在文末」的实例直接返回，批量调用很便宜。
     */
    private resetDisplaySelections(): void {
        for (const display of this.displays.values()) {
            // 正在编辑的那张不能复位：resetSelection 会把光标拽到文末，
            // 外部文档更新正好落在输入中间时表现为「打字打一半跳走了」
            if (this.editing?.display === display) continue;
            display.resetSelection();
        }
    }

    /** 选中一张卡片（视觉就是节点的 .lwm-node-selected 描边）。 */
    private activate(index: number): void {
        // 卡片不是导图节点：点它时画布收不到事件，节点选中会一直留着。
        // 每次激活都通知宿主清掉节点选中（幂等，已清也只是一次空调用）。
        this.options.onActivate?.();
        if (this.activeIndex === index) return;
        if (this.editing && this.editing.index !== index) this.finishEdit();
        this.activeIndex = index;
        this.updateCardStates();
    }

    /** 取消选中并把卡内选区复位。 */
    private clearActive(): void {
        if (this.activeIndex === null) return;
        this.activeIndex = null;
        this.resetDisplaySelections();
        this.updateCardStates();
    }

    private readonly onClick = (event: MouseEvent): void => {
        let target = event.target instanceof Element ? event.target : null;
        // 点另一张卡时，blur 会先同步提交编辑并重建整列 DOM；等这次
        // click 跑到时 target 已经脱离文档，host.contains 为 false。
        // 按坐标重新解析一次落点，否则「编辑 A 时点 B」第一下会被吞。
        if (!target || !this.host.contains(target)) {
            const under = document.elementFromPoint(event.clientX, event.clientY);
            target =
                under instanceof Element && this.host.contains(under)
                    ? under
                    : null;
        }
        if (!target) return;
        // 卡片栏内部的点击不要传给画布 / 全局点击处理
        event.stopPropagation();

        if (target.closest('.lwm-qcards-add')) {
            this.startNewCard();
            return;
        }
        // pointerup 已经处理过的那一次点击（同位置、极短时间）不再算一次
        if (this.isSuppressedClick(event)) return;
        const cardEl = target.closest<HTMLElement>('.lwm-qcard');
        if (!cardEl) return;
        const index = Number(cardEl.dataset.index);
        if (!Number.isFinite(index)) return;
        // 编辑中的点击交给 mini-CM 自己（定位光标 / 选中文字）
        if (this.editing?.display.container.contains(target)) return;
        this.handleCardTap(index, event.clientX, event.clientY);
    };

    /** pointerup 里已经手动处理过点击：记下位置，吞掉浏览器补发的那个 click。 */
    private suppressNextClick(x: number, y: number): void {
        this.suppressClick = {
            x,
            y,
            until: performance.now() + SUPPRESS_CLICK_MS,
        };
    }

    /**
     * 这次 click 是不是上一步 suppressNextClick 记下的那个。
     *
     * 只吞「同位置 + 极短时间」：用户紧接着点另一张卡（哪怕只隔几十毫秒）
     * 不会被误吞——这正是原来「时间窗内全部吞掉」的毛病。
     */
    private isSuppressedClick(event: MouseEvent): boolean {
        const suppressed = this.suppressClick;
        if (!suppressed) return false;
        this.suppressClick = null;
        if (performance.now() > suppressed.until) return false;
        return (
            Math.hypot(
                event.clientX - suppressed.x,
                event.clientY - suppressed.y
            ) <= 6
        );
    }

    /**
     * 一次「点击卡片」的判定（与节点的 handleNodeClick 完全一致）。
     *
     * 第一下 = 选中；点已经选中的卡片 = 进入编辑；双击未选中的卡片
     * 只停在选中态（第二下带进来的编辑由 onDblClick 撤回）。
     *
     * 单独抽出来是因为选中后的按下会被 pointerdown 抢走默认行为
     * （挡掉拖选文字），click 不一定还会派发，pointerup 里要直接复用。
     */
    private handleCardTap(index: number, clientX: number, clientY: number): void {
        const wasSelected = this.activeIndex === index;
        this.activate(index);
        if (wasSelected) {
            const rapid =
                this.selectOnlyIndex === index &&
                performance.now() - this.selectOnlyAt <= DOUBLE_CLICK_WINDOW_MS;
            // 隔得久了的残留标记不算「同一轮手势」
            if (!rapid) this.selectOnlyIndex = null;
            // 与节点一致：光标落在点击的位置，而不是文末
            this.startEdit(index, clientX, clientY);
            return;
        }
        this.selectOnlyIndex = index;
        this.selectOnlyAt = performance.now();
    }

    private readonly onDblClick = (event: MouseEvent): void => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target || target.closest('.lwm-qcards-add')) return;
        const cardEl = target.closest<HTMLElement>('.lwm-qcard');
        if (!cardEl) return;
        const index = Number(cardEl.dataset.index);
        if (!Number.isFinite(index)) return;
        // 只处理「双击一张刚选中的卡片」：第二下 click 已经把它带进编辑，
        // 这里撤回，让双击未选中的卡片只停留在选中态（与节点同一套）。
        if (this.selectOnlyIndex !== index) return;
        if (performance.now() - this.selectOnlyAt > DOUBLE_CLICK_WINDOW_MS) {
            this.selectOnlyIndex = null;
            return;
        }
        this.selectOnlyIndex = null;
        if (this.editing?.index === index) this.finishEdit();
        event.stopPropagation();
        event.preventDefault();
    };

    // ==================================================================
    // 选中后拖动（把卡片拖进画布变成节点）
    // ==================================================================

    /**
     * 按下卡片：先记录起点，超过阈值才真正进入拖动。
     *
     * 与节点一致 —— 只有「已经选中」的卡片才能拖；单击（没移动）
     * 仍然走 click，也就是「再点一下进入编辑」。
     */
    private readonly onCardPointerDown = (event: PointerEvent): void => {
        if (event.button !== 0) return;
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        const cardEl = target.closest<HTMLElement>('.lwm-qcard');
        if (!cardEl || cardEl === this.addButton) return;
        if (cardEl.dataset.draft === 'true') return;
        // 左边界拖手自己处理
        if (target.closest('.lwm-qcard-resize')) return;
        // 编辑中：选字 / 定位光标交给 mini-CM
        if (this.editing) return;
        const index = Number(cardEl.dataset.index);
        if (!Number.isFinite(index)) return;
        if (this.activeIndex !== index) return;
        this.cardDrag = {
            index,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
            el: cardEl,
        };
        // 已选中的卡片按下即可拖：必须先取消默认行为，否则浏览器会按
        // pointerdown 的落点派发 mousedown，mini-CM 顺手建一个拖选选区
        // （改 pointer-events 没用：mousedown 的目标在 pointerdown 时
        // 就已经定好了）。取消后 click 可能不再派发，所以 pointerup 里
        // 会自己补一次「点击」判定（见 handleCardTap）。
        event.preventDefault();
        window.addEventListener('pointermove', this.onCardPointerMove, true);
        window.addEventListener('pointerup', this.onCardPointerUp, true);
        window.addEventListener('pointercancel', this.onCardPointerUp, true);
    };

    private readonly onCardPointerMove = (event: PointerEvent): void => {
        const drag = this.cardDrag;
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (!drag.moved) {
            const moved =
                Math.abs(event.clientX - drag.startX) +
                    Math.abs(event.clientY - drag.startY) >=
                CARD_DRAG_THRESHOLD;
            if (!moved) return;
            drag.moved = true;
            this.closeMenu();
            this.toolbarEl.style.display = 'none';
            drag.el.classList.add('lwm-qcard-dragging');
            try {
                drag.el.setPointerCapture(event.pointerId);
            } catch {
                /* 合成事件 / 指针已失效 */
            }
        }
        const over = this.isOverHost(event.clientX, event.clientY);
        // 还在侧边栏里：显示「会插到第几张」的指示线；
        // 拖进画布：把坐标交给宿主，让画布高亮会落进去的节点
        // （和拖普通节点同一套 .lwm-node-drop-target，不是自造的样式）
        this.setDropIndex(over ? this.indexAt(event.clientY, drag.index) : null);
        this.options.onCardDragPreview?.(
            over ? null : { clientX: event.clientX, clientY: event.clientY }
        );
    };

    private readonly onCardPointerUp = (event: PointerEvent): void => {
        const drag = this.cardDrag;
        if (!drag || drag.pointerId !== event.pointerId) return;
        this.cardDrag = null;
        window.removeEventListener('pointermove', this.onCardPointerMove, true);
        window.removeEventListener('pointerup', this.onCardPointerUp, true);
        window.removeEventListener('pointercancel', this.onCardPointerUp, true);
        // 松手前先撤掉画布上的落点高亮：真正插不进去时不能留着这个提示
        this.options.onCardDragPreview?.(null);
        this.setDropIndex(null);
        drag.el.classList.remove('lwm-qcard-dragging');
        // 手取消了（系统手势 / 指针失效）：不算点击也不算投放
        if (event.type === 'pointercancel') return;
        // 松手后浏览器还会补一个 click（也可能因为 pointerdown 被取消
        // 而根本没有 click）：统一在这里把这次「点击」处理掉。
        // 只吞同位置的补发 click，不设「300ms 内一律吞」的时间窗。
        this.suppressNextClick(event.clientX, event.clientY);
        if (!drag.moved) {
            // 没移动 = 普通点击：再点已选中的卡片 → 从点击处进编辑
            this.handleCardTap(drag.index, event.clientX, event.clientY);
            return;
        }
        if (this.isOverHost(event.clientX, event.clientY)) {
            // 还在侧边栏里：调整卡片顺序（下面的卡片序号比上面大）
            const raw = this.indexAt(event.clientY, drag.index);
            this.moveCard(drag.index, raw > drag.index ? raw - 1 : raw);
            return;
        }
        // 空卡片拖到画布没有任何内容可插：别走投放流程（那会删卡）
        if (!this.cards[drag.index]?.text.trim()) return;
        // 缩略图 / 工具条 / 菜单也是浮层：落在上面不能当成「点到了画布」，
        // 否则会往浮层背后那个看不见的节点上插内容
        const under = document.elementFromPoint(event.clientX, event.clientY);
        if (
            under &&
            under.closest(
                '.lwm-minimap, .lwm-toolbar, .lwm-context-menu, .lwm-qcards'
            )
        ) {
            return;
        }
        // 落在侧边栏之外（画布上）→ 交给宿主插进导图。
        // 先清选中：投放会删卡并重画，留着旧序号会让下一张自动被选中 + 弹工具条。
        const index = drag.index;
        this.activeIndex = null;
        this.selectOnlyIndex = null;
        // 这张卡要被删掉：固定状态一起清（否则锚点可能漂到同文本的另一张）
        this.updatePinnedAnchor(index, []);
        this.options.onCardDropOnMap?.(index, event.clientX, event.clientY);
        this.updateCardStates();
    };

    /** 拖动卡片调整顺序（finalIndex = 移动完成后的序号）。 */
    private moveCard(from: number, finalIndex: number): void {
        if (from === finalIndex) return;
        const before = this.options.getMarkdown();
        const next = moveQuickCard(before, from, finalIndex);
        if (next === before) return;
        this.options.commit(next);
        // commit 会重画卡片：选中跟到移动后的位置
        this.activeIndex = finalIndex;
        this.selectOnlyIndex = null;
        this.updateCardStates();
    }

    /** 屏幕点是否落在侧边栏这一列里。 */
    private isOverHost(clientX: number, clientY: number): boolean {
        const rect = this.host.getBoundingClientRect();
        return (
            rect.width > 0 &&
            rect.height > 0 &&
            clientX >= rect.left &&
            clientX <= rect.right &&
            clientY >= rect.top &&
            clientY <= rect.bottom
        );
    }

    // ==================================================================
    // 供宿主 / 画布调用：投放区判定与高亮
    // ==================================================================

    /** 节点拖动中：这个屏幕点是不是落在侧边投放区（整列）。 */
    public hitTest(clientX: number, clientY: number): boolean {
        if (this.destroyed) return false;
        if (this.host.style.display === 'none') return false;
        return this.isOverHost(clientX, clientY);
    }

    /** 节点拖到侧边上时的高亮（由宿主在拖动过程中调用）。 */
    public setDropActive(active: boolean): void {
        // 拖动中每帧都会调，值没变就别写 DOM（写 dataset 会触发样式失效）
        const current = this.host.dataset.drop === 'true';
        if (active === current) return;
        if (active) this.host.dataset.drop = 'true';
        else delete this.host.dataset.drop;
    }

    /**
     * 这个纵坐标对应插到第几张卡片（0 = 第一张之前，
     * cards.length = 最后一张之后）。
     *
     * 按**可见部分**的垂直中线判定：点在上半 → 插到它前面，下半 → 继续往下找。
     * 被压缩的卡片自然高度可能有好几百 px，用自然中线会让它把下面几张
     * 全“覆盖”掉——指针明明在 B 的色条上，却返回上面那张 A 的序号。
     * 直接用 offsetTop / --lwm-qcard-visible，全程不读 getBoundingClientRect。
     *
     * @param excludeIndex 拖动中的卡片序号：算插入位置时跳过它自己
     */
    public indexAt(clientY: number, excludeIndex?: number): number {
        const hostRect = this.host.getBoundingClientRect();
        // 转成堆叠区内容坐标（滚动兜底态下要加回 scrollTop）
        const y = clientY - hostRect.top + this.host.scrollTop;
        for (const el of this.cardEls()) {
            if (Number(el.dataset.index) === excludeIndex) continue;
            const visible =
                parseFloat(el.style.getPropertyValue('--lwm-qcard-visible')) ||
                el.offsetHeight;
            if (y < el.offsetTop + visible / 2) {
                return Number(el.dataset.index);
            }
        }
        return this.cards.length;
    }

    /** 显示 / 隐藏拖拽插入位置指示线（null = 隐藏）。 */
    public setDropIndex(index: number | null): void {
        if (index === this.dropShown) return;
        this.dropShown = index;
        if (index === null) {
            this.dropMark.style.display = 'none';
            return;
        }
        const els = this.cardEls();
        // 插入点在目标卡片的上沿；插到末尾时贴在加号的上沿。
        // 别用最后一张卡片的下沿：超高卡片被折叠时它的实际 bottom 在
        // 可见区域之外，指示线会画到看不见的地方。
        // 用 offsetTop（内容坐标）而不是 rect：滚动兜底态下 rect 会随
        // scrollTop 偏移，而 dropMark 是宿主的绝对定位子元素，跟着一起滚。
        const anchor = (
            index < els.length ? els[index]! : this.addButton
        ).offsetTop;
        this.dropMark.style.display = 'block';
        this.dropMark.style.top = `${Math.round(anchor - 1)}px`;
    }

    /** 按文档顺序列出卡片元素（不包含加号 / 草稿）。 */
    private cardEls(): HTMLElement[] {
        return Array.from(
            this.stack.querySelectorAll<HTMLElement>('.lwm-qcard[data-index]')
        ).sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index));
    }

    /** 容器尺寸变化后重新摆放（重叠 / 平铺）。 */
    public relayout(): void {
        this.layoutStack();
    }

    /** 合并同一帧里的多次重排（缩略图 class 会连续变两次）。 */
    private scheduleRelayout(): void {
        if (this.relayoutRaf) return;
        this.relayoutRaf = requestAnimationFrame(() => {
            this.relayoutRaf = 0;
            if (!this.destroyed) this.layoutStack();
        });
    }

    /**
     * 滚动兜底态的滚轮。
     *
     * 宿主是 pointer-events:none（不能挡住画布），滚轮实际落在卡片上再
     * 冒泡到这里；只有真的溢出时才接管，否则完全放行给 mini-CM / 画布。
     */
    private readonly onHostWheel = (event: WheelEvent): void => {
        if (this.host.dataset.scrollable !== 'true') return;
        const max = this.host.scrollHeight - this.host.clientHeight;
        if (max <= 0) return;
        event.preventDefault();
        this.host.scrollTop = Math.max(
            0,
            Math.min(max, this.host.scrollTop + event.deltaY)
        );
    };

    private readonly onDocPointerDown = (event: PointerEvent): void => {
        const target = event.target instanceof Node ? event.target : null;
        // 菜单项自己处理点击：在 pointerdown 阶段删菜单会让 click 落空
        if (this.menuEl) {
            if (target && this.menuEl.contains(target)) return;
            this.closeMenu();
        }
        // 工具条挂在容器上（不在 host 里）。点它不能被当成「点了别处」：
        // 这里一清选中，按钮的 click 里 activeIndex 已经是 null，删除 /
        // 编辑 / 新建全部变成空操作。
        if (target && this.toolbarEl.contains(target)) return;
        if (!target || this.host.contains(target)) return;
        if (this.activeIndex === null && !this.editing) return;
        this.finishEdit();
        this.clearActive();
    };

    private readonly onDocKeyDown = (event: KeyboardEvent): void => {
        // 焦点在卡片栏里时（导图的 window 处理器看到 .lwm-qcards 就放行），
        // 剪贴板快捷键由这里补上；焦点在别处时走导图分流的 handleKey
        const targetEl = event.target instanceof Node ? event.target : null;
        if (targetEl && this.host.contains(targetEl)) {
            if (this.handleKey(event)) return;
            if (this.handleNavKey(event)) return;
        }
        if (event.key !== 'Escape') return;
        if (this.menuEl) {
            this.closeMenu();
            return;
        }
        // 编辑中的 Esc 由 mini-CM 的会话键位处理（提交），这里不重复处理。
        // target 可能是 document（脚本派发的事件），不能直接当 Element 用
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('.lwm-node-editing')) return;
        this.clearActive();
    };

    /**
     * 卡片栏的键盘导航（最小可用集）：卡片本身 tabindex=0，Tab 进来即选中；
     * 上下键换一张，Enter / F2 进编辑。只在焦点停在卡片外框本身时生效——
     * 焦点在 mini-CM 正文里时，方向键应该归编辑器移动光标。
     */
    private handleNavKey(event: KeyboardEvent): boolean {
        if (this.editing) return false;
        const target = event.target instanceof Element ? event.target : null;
        const cardEl = target?.closest<HTMLElement>('.lwm-qcard');
        if (!cardEl || target !== cardEl) return false;
        const index = Number(cardEl.dataset.index);
        if (event.key === 'Enter' || event.key === 'F2') {
            event.preventDefault();
            event.stopPropagation();
            if (Number.isFinite(index)) this.startEdit(index);
            return true;
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false;
        event.preventDefault();
        event.stopPropagation();
        if (this.cards.length === 0) return true;
        const base = Number.isFinite(index)
            ? index
            : this.activeIndex ?? 0;
        const next =
            event.key === 'ArrowDown'
                ? Math.min(this.cards.length - 1, base + 1)
                : Math.max(0, base - 1);
        this.activate(next);
        const nextEl = this.stack.querySelector<HTMLElement>(
            `.lwm-qcard[data-index="${next}"]`
        );
        nextEl?.focus();
        return true;
    }

    private readonly onWindowBlur = (): void => {
        // 失焦可能收不到 pointerup：把「按下即拖」留下的临时状态清掉，
        // 否则卡片会一直停在半透明 / 拖动样式里，指示线也收不回去
        if (this.cardDrag) {
            this.cardDrag.el.classList.remove('lwm-qcard-dragging');
            this.setDropIndex(null);
            window.removeEventListener('pointermove', this.onCardPointerMove, true);
            window.removeEventListener('pointerup', this.onCardPointerUp, true);
            window.removeEventListener('pointercancel', this.onCardPointerUp, true);
            // 画布上的落点高亮也要一起撤
            this.options.onCardDragPreview?.(null);
            this.cardDrag = null;
        }
        // 宽度拖动同理：指针很可能在窗口外松开，收不到 pointerup。
        // 不收尾的话 resize 状态永远留着，之后设置里的宽度改不动。
        this.endResize();
        // 编辑中窗口失焦：把内容落掉，避免停在半路
        this.finishEdit();
        this.closeMenu();
    };

    // ==================================================================
    // 编辑（更新已有卡片 / 新建草稿）
    // ==================================================================

    /**
     * 编辑第 index 张卡片（mini-CM 原地翻转，与节点编辑同一套）。
     *
     * @param clickX / clickY 进入编辑那一下的屏幕坐标：有坐标时光标落在
     *        点击位置（普通节点就是「再点一下直接从点击处出光标」），
     *        没有坐标（工具条 / F2 式入口）落在文末。
     */
    private startEdit(index: number, clickX?: number, clickY?: number): void {
        if (this.editing) return;
        const display = this.displays.get(index);
        const card = this.cards[index];
        if (!display || !card) return;
        const cardEl = this.stack.querySelector<HTMLElement>(
            `.lwm-qcard[data-index="${index}"]`
        );
        if (!cardEl) return;
        this.activeIndex = index;
        this.editing = {
            index,
            display,
            original: card.text,
            draft: false,
            cardEl,
            clickX,
            clickY,
        };
        this.updateCardStates();
        display.enterEdit({
            kind: 'para',
            onCommit: () => this.finishEdit(),
        });
        // 编辑态的焦点/光标必须排一帧：enterEdit 内部还要先换成可编辑实例
        requestAnimationFrame(() => {
            if (this.editing?.display !== display) return;
            display.focusAt(clickX, clickY);
        });
    }

    /** 新建一张草稿卡片（内容非空才真正写进文档）。 */
    private startNewCard(): void {
        this.finishEdit();
        // 新建草稿也算「进入卡片栏」：先清掉画布上残留的节点选中
        this.options.onActivate?.();
        const display = createNodeDisplay({
            doc: '',
            sentinel: true,
            theme: this.options.getTheme(),
            codeLanguages: this.options.codeLanguages,
        });
        this.draftDisplay = display;
        const cardEl = document.createElement('div');
        cardEl.className = 'lwm-qcard lwm-qcard-draft';
        const tintIndex = this.tintIndexOf(this.cards.length);
        cardEl.style.setProperty(
            '--lwm-node-tint',
            `var(--livewritemd-h${tintIndex + 1}-color, ${HEADING_TINT_FALLBACKS[tintIndex]})`
        );
        // 草稿卡片：永远展开（否则空内容被裁成 4px 色条，看不出在新建）
        cardEl.dataset.draft = 'true';
        cardEl.dataset.editing = 'true';
        const body = document.createElement('div');
        body.className = 'lwm-qcard-body';
        body.appendChild(display.container);
        cardEl.appendChild(body);
        // 插在加号前面：加号必须永远是堆叠区的最后一项（摆放算法按顺序
        // 依次吃掉高度、并把加号当作不封顶的那一项）
        this.stack.insertBefore(cardEl, this.addButton);
        this.editing = {
            index: -1,
            display,
            original: '',
            draft: true,
            cardEl,
        };
        this.activeIndex = null;
        this.updateCardStates();
        this.layoutStack();
        display.enterEdit({
            kind: 'para',
            onCommit: () => this.finishEdit(),
        });
        requestAnimationFrame(() => {
            if (this.editing?.display === display) display.focusAt();
        });
    }

    /**
     * 结束当前编辑：把 mini-CM 里的文本写回卡片。
     *
     * 与节点编辑一致：失焦 / Esc 都提交（Esc 不丢弃输入）。
     */
    private finishEdit(): void {
        const session = this.editing;
        if (!session) return;
        // 先清状态：后面的 refresh / commit 会重建卡片 DOM
        this.editing = null;
        const value = session.display.getText();
        session.display.exitEdit();
        session.cardEl.removeAttribute('data-editing');

        if (session.draft) {
            session.cardEl.remove();
            this.draftDisplay?.destroy();
            this.draftDisplay = null;
            this.activeIndex = null;
            if (value.trim()) {
                this.options.commit(
                    appendQuickCard(this.options.getMarkdown(), value)
                );
            } else {
                // 空草稿只是 DOM 里的一张临时卡片，文档没变 → refresh 会
                // 因为「内容没变」直接返回，不重建 DOM。但其它卡片的 top
                // 还是按草稿在场时算的（加号被顶下去了），不移除就会在
                // 侧边栏中间空出一块。所以这里必须重新摆放一次。
                this.flushPendingRefresh();
                this.layoutStack();
            }
            return;
        }

        const markdown = this.options.getMarkdown();
        // 编辑期间外部把这张卡改没了：序号指向的是别人，绝不能按序号写。
        // 先按最新全文刷新（pending 里就是它），内容有改动就追加成新卡片，
        // 宁可多一张也不能覆盖别人的内容或静默丢输入。
        if (session.detached) {
            this.flushPendingRefresh();
            if (value.trim() && value !== session.original) {
                this.options.commit(
                    appendQuickCard(this.options.getMarkdown(), value)
                );
                this.showToast('原卡片已被外部修改，内容已作为新卡片保留');
            }
            return;
        }
        if (value === session.original) {
            this.flushPendingRefresh();
            return;
        }
        if (!value.trim()) {
            // 内容被清空：删掉这张卡片。
            // 必须先清选中再 commit：commit 会同步触发 refresh → render，
            // 此时 activeIndex 还指向旧序号的话，下一张会被标成选中并弹
            // 工具条；之后再置 null 就已经没有 DOM 更新了（幽灵选中）。
            this.activeIndex = null;
            this.selectOnlyIndex = null;
            // 这张卡要被删掉：固定状态一起清，别让锚点漂到同文本的另一张上
            this.updatePinnedAnchor(session.index, []);
            const next = deleteQuickCard(markdown, session.index);
            if (next !== markdown) this.options.commit(next);
            else this.flushPendingRefresh();
            this.updateCardStates();
            return;
        }
        const next = updateQuickCard(markdown, session.index, value);
        if (next === markdown) {
            // 序号在最后一步又失效了（remap 没赶上的极端情况）：
            // 追加保内容，不能原地返回把用户输入吞掉
            this.updatePinnedAnchor(session.index, []);
            this.options.commit(appendQuickCard(markdown, value));
            this.showToast('原卡片已失效，内容已作为新卡片保留');
            return;
        }
        // 固定卡片的原文变了：先更新锚点，否则 commit 后的 remap 会失配
        if (this.pinned.has(session.index)) {
            this.updatePinnedAnchor(session.index, parseQuickCards(next));
        }
        this.options.commit(next);
    }

    /** 编辑期间被延后的文档更新：现在补一次刷新（内容没变就不重建）。 */
    private flushPendingRefresh(): void {
        const pending = this.pendingMarkdown;
        const force = this.pendingForce;
        this.pendingMarkdown = null;
        this.pendingForce = false;
        this.refresh(pending ?? undefined, force);
    }

    // ==================================================================
    // 右键菜单（复用导图右键菜单的样式）
    // ==================================================================

    private readonly onContextMenu = (event: MouseEvent): void => {
        let target = event.target instanceof Element ? event.target : null;
        // 与 click 同理：blur 提交可能已经重建了 DOM，target 脱离文档时
        // 按坐标重新解析，否则右键会读到旧序号。
        if (!target || !this.host.contains(target)) {
            const under = document.elementFromPoint(event.clientX, event.clientY);
            target =
                under instanceof Element && this.host.contains(under)
                    ? under
                    : null;
        }
        // 右键同样不要冒泡到容器（否则会弹出画布的「适应画布 / 全部展开」菜单）
        event.preventDefault();
        event.stopPropagation();
        // 右键加号：复制「到文末回答」的提示词（粘贴到任意文本框，
        // 也可以直接拖加号过去）
        if (target?.closest('.lwm-qcards-add')) {
            void this.copyPrompt();
            return;
        }
        const cardEl = target?.closest<HTMLElement>('.lwm-qcard');
        if (!cardEl) return;
        const index = Number(cardEl.dataset.index);
        if (!Number.isFinite(index)) return;
        this.activate(index);
        this.openMenu(event.clientX, event.clientY, index);
    };

    /** 卡片菜单：固定 / 收起 / 删除。 */
    private openMenu(x: number, y: number, index: number): void {
        this.closeMenu();
        const menu = document.createElement('div');
        menu.className = 'lwm-context-menu lwm-qcards-menu';
        const pinned = this.pinned.has(index);
        const items: Array<{ label: string; action: () => void }> = [
            {
                // 固定：取消选中 / 鼠标移开也保持展开，方便对照着操作画布
                label: pinned ? '取消固定' : '固定',
                action: () => this.togglePin(index),
            },
            {
                // 收起 = 真要把它合起来：固定态先解除，否则点了不会有反应
                label: '收起',
                action: () => {
                    if (this.pinned.has(index)) this.togglePin(index);
                    this.clearActive();
                },
            },
            { label: '删除', action: () => this.removeCard(index) },
        ];
        for (const item of items) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = item.label;
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                this.closeMenu();
                item.action();
            });
            menu.appendChild(button);
        }
        document.body.appendChild(menu);
        const rect = menu.getBoundingClientRect();
        let left = x;
        let top = y;
        if (left + rect.width > window.innerWidth - 4) {
            left = window.innerWidth - rect.width - 4;
        }
        if (top + rect.height > window.innerHeight - 4) {
            top = window.innerHeight - rect.height - 4;
        }
        menu.style.left = `${Math.max(4, left)}px`;
        menu.style.top = `${Math.max(4, top)}px`;
        this.menuEl = menu;
    }

    private closeMenu(): void {
        this.menuEl?.remove();
        this.menuEl = null;
    }

    // ==================================================================
    // 加号：复制 / 拖动「到文末回答」提示词
    // ==================================================================

    /**
     * 提示词正文：告诉 AI 把答案以快速卡片格式写到当前文件末尾。
     *
     * 卡片在文档里的格式就是独立的 `<<<` / `>>>` 行，这里把规则原样说清楚，
     * 复制/拖到任何对话框里都能直接让 AI 产出可解析的内容。
     */
    private promptText(): string {
        const name = this.options.getFileName?.() || '当前文件';
        return (
            `请在文件《${name}》的末尾回答，不要改动其它内容。` +
            `格式：第一行单独写 <<<，中间填充回答内容，最后一行单独写 >>>。`
        );
    }

    /** 复制提示词到剪贴板（右键加号触发），并给一条轻提示。 */
    private async copyPrompt(): Promise<void> {
        const text = this.promptText();
        try {
            let ok: boolean;
            if (this.options.copyText) {
                ok = await this.options.copyText(text);
            } else {
                await navigator.clipboard.writeText(text);
                ok = true;
            }
            if (!ok) throw new Error('clipboard rejected');
            if (this.destroyed) return;
            this.showToast('提示词已复制，粘贴到任意文本框即可');
        } catch {
            // 剪贴板被权限挡住：拖动加号同样能带出提示词
            this.showToast('复制失败，请直接把加号拖到目标文本框');
        }
    }

    /** 底部小浮条：复制成功 / 失败提示，1.6s 后淡出（同一份 DOM 复用）。 */
    private showToast(message: string): void {
        // 异步剪贴板回调可能晚于 destroy：别在 body 上再挂一个孤儿浮条
        if (this.destroyed) return;
        if (!this.toastEl) {
            this.toastEl = document.createElement('div');
            this.toastEl.className = 'lwm-qcards-toast';
            document.body.appendChild(this.toastEl);
        }
        this.toastEl.textContent = message;
        this.toastEl.dataset.show = 'true';
        window.clearTimeout(this.toastTimer);
        this.toastTimer = window.setTimeout(() => {
            if (this.toastEl) this.toastEl.dataset.show = 'false';
        }, 1600);
    }

    /** 删除一张卡片（若它正在编辑，先把编辑会话静默收掉）。 */
    private removeCard(index: number): void {
        if (this.editing && this.editing.index === index) {
            const session = this.editing;
            this.editing = null;
            session.display.exitEdit();
            session.cardEl.remove();
        }
        this.activeIndex = null;
        this.selectOnlyIndex = null;
        const markdown = this.options.getMarkdown();
        const next = deleteQuickCard(markdown, index);
        if (next !== markdown) {
            this.updatePinnedAnchor(index, []);
            this.options.commit(next);
        } else {
            // 删除失败 = 序号在外部更新后已经漂移。刚才可能已经把卡片的
            // DOM 摘掉了，而普通 refresh 会走「内容没变」快路径直接返回，
            // 界面就会少一张卡、displays 里还留着脱离文档的实例。
            // 强制重建一次恢复现场（失败路径不常见，重建成本可接受）。
            this.refresh(undefined, true);
        }
        this.updateCardStates();
    }
}
