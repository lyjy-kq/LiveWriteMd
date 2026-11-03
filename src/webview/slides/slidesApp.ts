/**
 * 幻灯片模式控制器。
 *
 * 职责：
 * - 在 #slides 里搭工具栏 / 16:9 画布 / 缩略图栏；
 * - 文档 → 块 → 逻辑页 → 物理页（模型与分页在 slidesModel / slidesPaginate）；
 * - 测量块高度（带缓存，只重测改过的块）；
 * - 当前页由块级 mini-CM 组成，点击原地编辑，提交后最小改动回写全文；
 * - 翻页 / 键盘 / 主题 / 目录跳转 / 生命周期。
 *
 * 设计取舍：
 * - 块级 mini-CM 直接复用导图节点的 createNodeDisplay（显示态 = live 本尊）；
 * - 页面按「页码锚点」缓存，当前页前后各预加载 5 页，加载过的页面不再
 *   销毁（翻页只是切 visibility，不再重建 mini-CM，所以翻页是瞬时的）；
 * - 高度缓存按「块 id（含源码哈希）+ 字号」，源码一改自然失效；
 * - 表格列宽测量需要「当前块自己的字体环境」，创建表格块后把测量根切到
 *   它的 .cm-content 并触发一次表格重排（见 textMeasure.setMeasureRootOverride）。
 *
 * @module webview/slides/slidesApp
 */

import type { LanguageDescription } from '@codemirror/language';
import {
    createNodeDisplay,
    type NodeDisplay,
} from '../mindmap/miniCm.js';
import {
    maskQuickCardLines,
    parseQuickCards,
} from '../mindmap/edit/staging.js';
import { setMeasureRootOverride } from '../codemirror/extensions/livePreview/measure/textMeasure.js';
import { measureWhitespacePx } from '../codemirror/extensions/livePreview/measure/listIndent.js';
import { tableRemeasureEffect } from '../codemirror/extensions/livePreview/state.js';
import { settingsState } from '../settings/settingsState.js';
import { sendLog } from '../host/logForward.js';
import type { ThemeType } from '../../shared/types.js';
import { ensureSlidesCss } from './slidesStyles.js';
import {
    bodyFontSize,
    findLogicalSlideByLine,
    findNearestLogicalSlideByLine,
    flattenItems,
    parseDeck,
    plainHeading,
    setSlideBodyFontPx,
    titleFontSize,
    type Deck,
    type LogicalSlide,
    type SlideBlock,
    type SlidePage,
} from './slidesModel.js';
import {
    BLOCK_GAP,
    COLUMN_W,
    CONTENT_H,
    CONTENT_W,
    isSlideMeasured,
    paginateDeck,
    type MeasureResult,
} from './slidesPaginate.js';

/** 嵌套节点每深一级的视觉缩进：源码已去缩进，用内边距补回层级。 */
const NODE_INDENT_PX = 20;

/** 幻灯片配色主题设置。 */
export type SlidesThemeSetting = 'auto' | 'paper' | 'ink' | 'indigo';
/** 实际生效的 deck 主题（auto 会解析成纸或墨）。 */
export type SlidesDeckTheme = 'paper' | 'ink' | 'indigo';
/** 标题分页级别设置。 */
export type SlidesHeadingSetting = 'auto' | 1 | 2 | 3;
/** 页面四周的装饰：无 / 内嵌发丝线 / 四角标记。 */
export type SlidesFrameSetting = 'none' | 'rule' | 'corners';

export interface SlidesRuntimeSettings {
    theme: SlidesThemeSetting;
    headingLevel: SlidesHeadingSetting;
    frame: SlidesFrameSetting;
}

export interface SlidesAppOptions {
    /** 编辑提交后的新全文；上层写回隐藏主 CM。 */
    onEdit: (fullText: string) => void;
    /** Ctrl+S：先提交当前编辑，再落盘。 */
    onSave: (fullText: string) => void;
    /** 持久化单条设置（主题按钮）。 */
    onPersistSetting: (key: string, value: string) => void;
    /** mini-CM 代码块高亮语言表（与主编辑器同款）。 */
    codeLanguages: readonly LanguageDescription[];
    /** 分页结果变化：上层刷新大纲里的页码标注。 */
    onPagesChange?: () => void;
    /** 当前页第一行（0-based）变化：上层同步大纲高亮。 */
    onActiveLineChange?: (line0: number | null) => void;
    /**
     * 请求扩展侧切换 VS Code 窗口全屏（F11）。
     *
     * VS Code 的 webview 是沙箱 iframe，没有 allowfullscreen，
     * requestFullscreen 多半会被拒；那种情况下只能靠扩展宿主执行
     * workbench.action.toggleFullScreen，放映才能铺满物理屏幕。
     */
    onWindowFullscreen?: (on: boolean) => void;
    /** 撤销 / 重做（页面浏览态，编辑中由 mini-CM 自己的历史处理）。 */
    onUndo?: () => void;
    onRedo?: () => void;
}

const THEME_ORDER: SlidesThemeSetting[] = ['auto', 'paper', 'ink', 'indigo'];
const FRAME_ORDER: SlidesFrameSetting[] = ['none', 'rule', 'corners'];
const FRAME_LABEL: Record<SlidesFrameSetting, string> = {
    none: '无',
    rule: '细线框',
    corners: '四角标记',
};
const THEME_LABEL: Record<SlidesThemeSetting, string> = {
    auto: '自动',
    paper: '纸',
    ink: '墨',
    indigo: '靛',
};
const DECK_LABEL: Record<SlidesDeckTheme, string> = {
    paper: '纸',
    ink: '墨',
    indigo: '靛',
};

const PAGE_W = 1280;
const PAGE_H = 720;

/** 读取设置面板里的幻灯片选项。 */
export function readSlidesSettings(): SlidesRuntimeSettings {
    const rawTheme = settingsState.getString('slidesTheme') || 'auto';
    const theme: SlidesThemeSetting = (
        ['auto', 'paper', 'ink', 'indigo'] as const
    ).includes(rawTheme as SlidesThemeSetting)
        ? (rawTheme as SlidesThemeSetting)
        : 'auto';

    const rawLevel = settingsState.getString('slidesHeadingLevel') || 'auto';
    const headingLevel: SlidesHeadingSetting =
        rawLevel === '1'
            ? 1
            : rawLevel === '2'
              ? 2
              : rawLevel === '3'
                ? 3
                : 'auto';

    const rawFrame = settingsState.getString('slidesFrame') || 'none';
    const frame: SlidesFrameSetting = (
        ['none', 'rule', 'corners'] as const
    ).includes(rawFrame as SlidesFrameSetting)
        ? (rawFrame as SlidesFrameSetting)
        : 'none';
    return { theme, headingLevel, frame };
}

/** 待测量的块；只记「测什么」，等真正测量时再建 mini-CM。 */
interface MeasureRequest {
    block: SlideBlock;
    font: number;
    /** 测量宽度：整页宽（单栏）或半页宽（双栏候选）。 */
    width: number;
    /** 高度缓存键：id + 字号 + 宽度。 */
    key: string;
    isTitle: boolean;
}

/** 正在测量的块：mini-CM 已经建好并挂在测量宿主里。 */
interface MeasureEntry extends MeasureRequest {
    wrap: HTMLElement;
    display: NodeDisplay;
}

/**
 * 一屏最多同时挂多少个测量块。
 *
 * 所有测量块同处一个宿主里时，每新建一个 CM 都会让它测量自己的 DOM，
 * 而浏览器要为**整个宿主**重排一次 —— 块越多每次越慢，整体是 O(N²)。
 * 40 个小节（约 200 块）实测能到 68 秒。分块后每次只让浏览器排 3 块，
 * 成本回到线性，并且块之间能让出主线程 —— 单次同步任务控制在
 * 100~200ms，翻页 / 补测时不会出现半秒级的掉帧。
 */
const MEASURE_CHUNK = 3;

/**
 * 页面预加载半径：当前页前后各 5 页。
 *
 * 预加载只建 DOM / mini-CM，不做测量；已经建过的页面永远保留（用户明确
 * 要求「加载过的不卸载」），翻页时只切 visibility，所以来回翻页没有
 * 重建成本。首次打开仍只渲染当前页，其余页在空闲帧里逐页补上。
 */
const PRELOAD_RADIUS = 5;

/** 高度会异步变化（渲染/解码/重排发生在后续帧）的块类型。 */
const ASYNC_BLOCK_KINDS = new Set(['image', 'mermaid', 'math', 'table']);

/** 用户正在操作的信号；后台补测看到这些事件后先让路。 */
const INTERACTION_EVENTS = [
    'wheel',
    'pointerdown',
    'touchstart',
    'keydown',
] as const;

interface RenderedEntry {
    wrap: HTMLElement;
    display: NodeDisplay;
}

export class SlidesApp {
    private readonly host: HTMLElement;
    private readonly options: SlidesAppOptions;

    private readonly toolbar: HTMLElement;
    private readonly pageInfoEl: HTMLElement;
    private readonly layoutEl: HTMLElement;
    private readonly themeButton: HTMLElement;
    /** 主题下拉菜单（点按钮展开，选完收起）。 */
    private readonly themePopover: HTMLElement;
    /** 边框装饰按钮 / 下拉（和主题并排，同样点开选）。 */
    private readonly frameButton: HTMLElement;
    private readonly framePopover: HTMLElement;
    private readonly fullscreenButton: HTMLElement;
    private readonly statusEl: HTMLElement;
    private readonly stageWrap: HTMLElement;
    private readonly stageBox: HTMLElement;
    private readonly stage: HTMLElement;
    private readonly measureHost: HTMLElement;

    private fullText = '';
    private title = '';
    private deck: Deck | null = null;
    private pages: SlidePage[] = [];
    private pageIndex = 0;

    private settings: SlidesRuntimeSettings = {
        theme: 'auto',
        headingLevel: 'auto',
        frame: 'none',
    };
    private editorTheme: ThemeType = 'dark';
    private effectiveTheme: SlidesDeckTheme = 'ink';
    private fontSignature = '';

    /** 大纲页码标注：标题行（1-based）→ "P8" / "P8,9"；空串回退行号。 */
    private pageLabels = new Map<number, string>();

    /** 放映态：铺满 webview（或浏览器全屏），隐藏画布外的一切。 */
    private presenting = false;
    /** requestFullscreen 被沙箱拒绝时改用 CSS 铺满的兜底放映。 */
    private fallbackPresenting = false;
    /** 已经请求扩展侧切窗口全屏吗（扩展侧按这个状态避免重复 toggle）。 */
    private windowFullscreenRequested = false;

    /**
     * 一次滚轮手势是否已经翻过页。
     *
     * 语义是「滑动一开始就翻」，不是「滑完再翻」：第一次滚轮立刻切页，
     * 同一次手势里的后续惯性事件全部吃掉；只有连续 200ms 没有滚轮事件，
     * 才认为手势结束、解锁下一次翻页。
     */
    private wheelFlipLocked = false;
    private wheelUnlockTimer: number | null = null;

    private active = false;
    private dirty = true;
    private rebuilding = false;
    private rebuildToken = 0;
    private rebuildTimer: number | null = null;
    private pendingAnchorLine: number | null = null;
    private pendingText: string | null = null;
    /** 上一次使用的 live 正文基准字号（px），用于检测字号/缩放变化。 */
    private liveBodyFontPx = 0;

    /**
     * 已渲染的页面：key = pageAnchorId（逻辑页 + 段 + 首个块 id）。
     *
     * 用锚点而不是页码做 key：后台补测导致页码整体后移时，页面内容没变，
     * 已经建好的 DOM / mini-CM 继续复用。内容真改了 → 块 id 里的源码
     * 哈希变化 → 锚点变化 → 自然重建那一页。
     */
    private readonly pageEls = new Map<
        string,
        { el: HTMLElement; entries: RenderedEntry[] }
    >();
    /** 当前可见的页面元素（其余缓存页 visibility:hidden，布局照常参与测量）。 */
    private currentPageEl: HTMLElement | null = null;
    /** 正在构建的页面把块显示登记到这里，构建结束写进 pageEls。 */
    private buildingEntries: RenderedEntry[] | null = null;
    /** 预加载调度句柄（idle callback / timeout）。 */
    private preloadCancel: (() => void) | null = null;

    private activeDisplay: NodeDisplay | null = null;
    private measureOverrideOwner: NodeDisplay | null = null;

    /** 高度缓存：key = 块 id + 字号。源码改过 id 就变，自动失效。 */
    private readonly heightCache = new Map<string, number>();
    private readonly titleHeightCache = new Map<string, number>();
    private lastMeasure: MeasureResult = {
        body: new Map(),
        bodyColumn: new Map(),
        titles: new Map(),
        cmCount: 0,
        ms: 0,
    };

    /**
     * 测量串行队列。
     *
     * 测量宿主是共用的：翻页 / 大纲跳转的按需补测和后台补测如果同时
     * 跑，后一个会把前一个刚挂上的块清掉，两边读到的都是 0 高度。
     * 所有测量都排队执行，天然互斥。
     */
    private measureChain: Promise<unknown> = Promise.resolve();
    /** 后台补测的下一次调度；rebuild / 离开模式时取消。 */
    private pumpCancel: (() => void) | null = null;
    /** 最近一次用户交互（滚轮/按键/点击）的时间，补测期间让路用。 */
    private lastInteraction = 0;
    /** 距上次重分页又补测了几页（重分页要重建缩略图，太频繁会闪）。 */
    private pumpSincePaginate = 0;

    private readyResolve: (() => void) | null = null;
    private readyPromise: Promise<void> = Promise.resolve();

    private readonly resizeObserver: ResizeObserver;
    private readonly onInteractionBound: () => void;
    private readonly onKeyDownBound: (event: KeyboardEvent) => void;
    private readonly onToolbarClickBound: (event: MouseEvent) => void;
    private readonly onWheelBound: (event: WheelEvent) => void;
    private readonly onFullscreenChangeBound: () => void;
    private readonly onDocumentPointerDownBound: (event: PointerEvent) => void;

    constructor(host: HTMLElement, options: SlidesAppOptions) {
        this.host = host;
        this.options = options;
        ensureSlidesCss();

        host.innerHTML = '';
        this.toolbar = document.createElement('div');
        this.toolbar.className = 'slides-toolbar';
        this.toolbar.innerHTML = `
            <button type="button" data-action="prev" title="上一页（← / PageUp / 滚轮上滑）">‹ 上一页</button>
            <span class="slides-pageinfo">– / –</span>
            <button type="button" data-action="next" title="下一页（→ / PageDown / 空格 / 滚轮下滑）">下一页 ›</button>
            <span class="slides-layout"></span>
            <span class="slides-spacer"></span>
            <span class="slides-status"></span>
            <span class="slides-menu">
                <button type="button" data-action="theme" aria-haspopup="true" aria-expanded="false" title="选择 deck 主题">主题：自动</button>
                <div class="slides-theme-popover" hidden role="menu">
                    <button type="button" data-theme="auto" role="menuitemradio">自动（跟随明暗）</button>
                    <button type="button" data-theme="paper" role="menuitemradio">纸</button>
                    <button type="button" data-theme="ink" role="menuitemradio">墨</button>
                    <button type="button" data-theme="indigo" role="menuitemradio">靛</button>
                </div>
                <button type="button" data-action="frame" aria-haspopup="true" aria-expanded="false" title="选择页面边框装饰">边框：无</button>
                <div class="slides-theme-popover slides-frame-popover" hidden role="menu">
                    <button type="button" data-frame="none" role="menuitemradio">无</button>
                    <button type="button" data-frame="rule" role="menuitemradio">细线框</button>
                    <button type="button" data-frame="corners" role="menuitemradio">四角标记</button>
                </div>
            </span>
            <button type="button" data-action="fullscreen" title="全屏放映（Esc 退出）">全屏</button>
            <button type="button" data-action="rebuild" title="重新测量与分页">重排</button>
        `;
        this.pageInfoEl = this.toolbar.querySelector(
            '.slides-pageinfo'
        ) as HTMLElement;
        this.layoutEl = this.toolbar.querySelector(
            '.slides-layout'
        ) as HTMLElement;
        this.statusEl = this.toolbar.querySelector(
            '.slides-status'
        ) as HTMLElement;
        this.themeButton = this.toolbar.querySelector(
            '[data-action="theme"]'
        ) as HTMLElement;
        this.themePopover = this.toolbar.querySelector(
            '.slides-theme-popover:not(.slides-frame-popover)'
        ) as HTMLElement;
        this.frameButton = this.toolbar.querySelector(
            '[data-action="frame"]'
        ) as HTMLElement;
        this.framePopover = this.toolbar.querySelector(
            '.slides-frame-popover'
        ) as HTMLElement;
        this.fullscreenButton = this.toolbar.querySelector(
            '[data-action="fullscreen"]'
        ) as HTMLElement;

        this.stageWrap = document.createElement('div');
        this.stageWrap.className = 'slides-stage-wrap';
        this.stageBox = document.createElement('div');
        this.stageBox.className = 'slides-stage-box';
        // stage 是 1280×720 的缩放包装层；真正的页面是它的子元素
        // (.slide-page)。只显示当前页，预加载的页面叠在同一位置但
        // visibility:hidden —— 看得见与否不影响布局，mini-CM 照样能量。
        this.stage = document.createElement('div');
        this.stage.className = 'slides-stage';
        this.stageBox.appendChild(this.stage);
        this.stageWrap.appendChild(this.stageBox);

        this.measureHost = document.createElement('div');
        this.measureHost.className = 'slides-measure deck-paper';
        this.measureHost.setAttribute('aria-hidden', 'true');

        host.append(this.toolbar, this.stageWrap, this.measureHost);

        this.settings = readSlidesSettings();
        this.fontSignature = this.computeFontSignature();
        this.effectiveTheme = this.resolveDeckTheme();

        this.onToolbarClickBound = (event) => this.onToolbarClick(event);
        this.onKeyDownBound = (event) => this.onKeyDown(event);
        this.onWheelBound = (event) => this.onWheel(event);
        this.onFullscreenChangeBound = () => this.onFullscreenChange();
        this.onDocumentPointerDownBound = (event) =>
            this.onDocumentPointerDown(event);
        // 只用来看「用户是不是正忙着」：后台补测只在交互停下来之后做
        this.onInteractionBound = () => {
            this.lastInteraction = performance.now();
        };
        this.toolbar.addEventListener('click', this.onToolbarClickBound);
        // 滚轮翻页必须非 passive（要 preventDefault 掉浏览器的惯性滚动）
        this.stageWrap.addEventListener('wheel', this.onWheelBound, {
            passive: false,
        });
        document.addEventListener('keydown', this.onKeyDownBound);
        document.addEventListener('fullscreenchange', this.onFullscreenChangeBound);
        document.addEventListener(
            'pointerdown',
            this.onDocumentPointerDownBound,
            true
        );
        for (const type of INTERACTION_EVENTS) {
            document.addEventListener(type, this.onInteractionBound, {
                passive: true,
            });
        }

        this.resizeObserver = new ResizeObserver(() => this.fitStage());
        this.resizeObserver.observe(this.stageWrap);

        this.updateChrome();
        // 正文基准字号跟 live 走：构造时就注入，后续每次解析再刷新
        this.syncLiveBodyFont();
    }

    // =================================================================
    // 生命周期 / 文档
    // =================================================================

    /**
     * 设置文档。非激活状态只记下内容，等进入模式再解析/测量，避免在文本
     * 模式里做无谓的后台排版。
     */
    setDocument(text: string, title?: string): void {
        // 解析 / 分页用的是 live 当前字号：每次换文档前同步一次
        this.syncLiveBodyFont();
        if (title) this.title = title;
        if (this.fullText === text) {
            if (!this.deck) this.dirty = true;
            return;
        }
        // 编辑会话中收到外部更新：先记下，提交后再应用，避免把正在输入
        // 的 mini-CM 文档直接换掉。
        if (this.activeDisplay) {
            this.pendingText = text;
            return;
        }
        this.fullText = text;
        this.beginReady();
        if (!this.active) {
            this.dirty = true;
            return;
        }
        const deck = parseDeck(text, this.settings.headingLevel);
        this.deck = deck;
        this.renderCoverPreview(deck);
        // rebuild 是异步的：期间旧页面仍在 DOM 里，必须置位让点击/滚轮/
        // 键盘知道「正在重建」，别让人点进一个马上会被销毁的旧块编辑器。
        this.rebuilding = true;
        void this.rebuild(null);
    }

    /**
     * 卡片栏提交后的轻量同步（从右侧栏改的是卡片内容，不是幻灯片正文）。
     *
     * - 掩码文本没变（只改了卡片正文）：行号/分页完全不变，只更新全文，
     *   不重排、不闪页，也不会在卡片失焦那次点击上吞掉后续的块编辑；
     * - 卡片增删 / 换序导致掩码文本变化：才重新解析重建。
     *
     * 不走 setDocument：那条路径会先 destroyRendered + 播封面占位，卡片
     * 每提交一次就闪一次，还会让紧接着的点击落到被销毁的旧 DOM 上。
     */
    public commitCardText(text: string): void {
        if (this.fullText === text) return;
        // 极端防御：块编辑器还开着时，传入的 text 是基于旧全文算出来的，
        // 按行回写会错位。正常路径在卡片栏 pointerdown 时就把块编辑提交了
        //（见 appState 的 flushBlockEditSync 钩子）。
        if (this.activeDisplay) {
            sendLog(
                'WARN',
                'commitCardText ignored: a slide block edit is still active'
            );
            return;
        }
        const masked = maskQuickCardLines(text);
        if (this.deck && masked === this.deck.parseText) {
            this.fullText = text;
            this.deck.fullText = text;
            return;
        }
        this.applyExternalText(text);
    }

    /**
     * 外部（隐藏 CM 的 undo/redo、卡片结构变化）改全文后的重建。
     *
     * 不走 setDocument：那条路径会先清空舞台播封面占位，撤销一次就闪一下。
     * 这里保留当前页 DOM，直接按新全文重新解析 / 测量 / 分页。
     */
    public applyExternalText(text: string): void {
        if (this.fullText === text) return;
        this.fullText = text;
        this.beginReady();
        if (!this.active) {
            this.dirty = true;
            return;
        }
        // 结构变化：取消块编辑提交排下的那次重建，直接按新全文重建一次
        if (this.rebuildTimer !== null) {
            window.clearTimeout(this.rebuildTimer);
            this.rebuildTimer = null;
        }
        this.pendingAnchorLine = null;
        this.rebuilding = true;
        void this.rebuild(this.getCurrentLine0());
    }

    /**
     * 同步提交正在编辑的幻灯片块（卡片栏在 PPT 里动手之前调用）。
     *
     * mini-CM 的 blur 处理器会同步走 commitBlock → onEdit；卡片栏随后
     * getMarkdown 读到的就是包含这次块编辑的新全文，不会基于旧文本换序 /
     * 删除而把块编辑覆盖掉。
     */
    public flushBlockEditSync(): void {
        if (!this.activeDisplay) return;
        const display = this.activeDisplay;
        this.activeDisplay = null;
        try {
            display.view.contentDOM.blur();
        } catch {
            /* 已销毁 */
        }
    }

    /** 初次渲染（或最近一次 rebuild）完成的 Promise。 */
    whenReady(): Promise<void> {
        return this.readyPromise;
    }

    /** 进入 / 离开幻灯片模式。 */
    setActive(active: boolean, startLine?: number | null): void {
        if (this.active === active) {
            if (active && startLine != null) this.goToLine(startLine);
            return;
        }
        if (!active) {
            // 离开前把编辑会话提交掉（失焦提交），再清掉页面实例
            if (this.activeDisplay) {
                try {
                    this.activeDisplay.view.contentDOM.blur();
                } catch {
                    /* 已销毁 */
                }
            }
            this.active = false;
            this.dirty = true;
            // 离开模式时退出放映，别把全屏 / 铺满状态带到导图或正文
            if (this.presenting) void this.exitPresenting();
            this.toggleThemeMenu(false);
            this.toggleFrameMenu(false);
            // 手势锁是「本次会话」的状态，离开模式必须清掉，
            // 否则下次进来第一次滚轮会被当成续接手势而吞掉
            if (this.wheelUnlockTimer !== null) {
                window.clearTimeout(this.wheelUnlockTimer);
                this.wheelUnlockTimer = null;
            }
            this.wheelFlipLocked = false;
            if (this.rebuildTimer !== null) {
                window.clearTimeout(this.rebuildTimer);
                this.rebuildTimer = null;
            }
            this.cancelPump();
            this.cancelPreload();
            this.rebuilding = false;
            this.destroyRendered();
            this.clearMeasureOverride();
            return;
        }

        this.active = true;
        // 把「当前光标行」直接传给 rebuild：首屏只测这一页，
        // 否则会先量第一页再跳到光标页，白测一次。
        if (this.dirty || !this.deck) {
            this.dirty = false;
            this.beginReady();
            void this.rebuild(startLine ?? null).then(() => {
                if (startLine != null) this.goToLine(startLine);
            });
        } else {
            if (this.pages.length === 0) {
                this.beginReady();
                void this.rebuild(startLine ?? null).then(() => {
                    if (startLine != null) this.goToLine(startLine);
                });
            } else {
                // 回到幻灯片：把大纲的页码标注重新挂上（离开时恢复成了行号）
                this.publishPages();
                this.renderPage();
                if (startLine != null) this.goToLine(startLine);
                // 上次离开时后台补测被取消了，回来继续（没有要补的就直接结束）
                if (this.deck) this.schedulePump(this.deck, this.rebuildToken);
            }
        }
    }

    /** 扩展侧主题变化：deck 主题为 auto 时跟随明暗。 */
    setEditorTheme(theme: ThemeType): void {
        this.editorTheme = theme;
        if (this.settings.theme !== 'auto') return;
        const next = this.resolveDeckTheme();
        if (next === this.effectiveTheme) return;
        this.effectiveTheme = next;
        this.updateChrome();
        if (this.active) {
            // deck 主题与 mini-CM 的明暗都是建页时定下的，换主题只能重建
            this.destroyRendered();
            this.renderPage();
        }
    }

    /** 设置面板变化：主题 / 分页级别 / 字体族 / live 字号缩放。 */
    applySettings(): void {
        const next = readSlidesSettings();
        const nextFontSignature = this.computeFontSignature();
        // live 的正文字号（编辑器字号 × fontScale）也算结构变化：
        // 行高、折行、分页全部要按新字号重算。
        const nextLiveFontPx = this.readLiveBodyFontPx();
        const liveFontChanged =
            Math.abs(nextLiveFontPx - this.liveBodyFontPx) > 0.01;
        this.liveBodyFontPx = nextLiveFontPx;
        setSlideBodyFontPx(nextLiveFontPx);
        const structural =
            next.headingLevel !== this.settings.headingLevel ||
            nextFontSignature !== this.fontSignature ||
            liveFontChanged;
        // 边框装饰只改页面类名，不用重新测量；但缓存页要重建
        const frameChanged = next.frame !== this.settings.frame;

        this.settings = next;
        this.fontSignature = nextFontSignature;
        const themeChanged = this.resolveDeckTheme() !== this.effectiveTheme;
        if (themeChanged) this.effectiveTheme = this.resolveDeckTheme();
        this.updateChrome();

        if (structural) {
            this.clearCaches();
            if (!this.active) {
                this.dirty = true;
                return;
            }
            this.beginReady();
            void this.rebuild(null);
        } else if ((themeChanged || frameChanged) && this.active) {
            // 主题只影响颜色，不需要重新测量；但缓存页的上一套配色要清掉
            this.destroyRendered();
            this.renderPage();
        }
    }

    /** 当前页第一行（0-based），切回文本模式时用它定位。 */
    getCurrentLine0(): number | null {
        const page = this.pages[this.pageIndex];
        if (!page) return null;
        if (page.titleBlock) return page.titleBlock.fromLine;
        return page.blocks[0]?.fromLine ?? null;
    }

    /**
     * 大纲里的页码标注：标题行（1-based）→ "P8" / "P8,9"。
     *
     * 返回空串表示这一行没有对应页码（例如还没分页），大纲会回退显示行号。
     */
    getOutlinePageLabel(line1: number): string {
        return this.pageLabels.get(line1) ?? '';
    }

    /**
     * 分页结果变化后重建「标题行 → 页码」表。
     *
     * 只记标题**第一次出现**的那一页：续页不再追加 `,9`。大纲是用来
     * 跳转的，指向首发页就够了；一长串页码反而看不出重点。
     */
    private rebuildPageLabels(): void {
        const labels = new Map<number, string>();
        this.pages.forEach((page, index) => {
            if (page.logicalIndex < 0) return;
            const headings: SlideBlock[] = [];
            if (page.titleBlock) headings.push(page.titleBlock);
            for (const block of page.blocks) {
                if (block.kind === 'heading') headings.push(block);
            }
            for (const heading of headings) {
                const line1 = heading.fromLine + 1;
                // 同一标题在后续页（续页 / 重复渲染）再次出现时不覆盖
                if (!labels.has(line1)) labels.set(line1, `P${index + 1}`);
            }
        });
        this.pageLabels = labels;
    }

    /** 重建页码表并通知上层刷新大纲。 */
    private publishPages(): void {
        this.rebuildPageLabels();
        this.options.onPagesChange?.();
    }

    /** 当前行（0-based）所在页；用于大纲点击。 */
    goToLine(line0: number): boolean {
        if (!this.deck || this.pages.length === 0) return false;
        // 卡片行（已从幻灯片里掩码掉）不属于任何逻辑页：落到上方最近一页，
        // 别让「光标在卡片里进入 PPT / 点卡内标题」回到第 0 页。
        const logicalIndex =
            findLogicalSlideByLine(this.deck, line0) ??
            findNearestLogicalSlideByLine(this.deck, line0);
        if (logicalIndex === null) return false;
        const index = this.findPageIndex(logicalIndex);
        if (index < 0) return false;
        this.pageIndex = index;
        if (this.active) {
            this.renderPage();
            // 这一页可能还没实测：先按估算画出来（不卡住点击），
            // 测完再按新分页重新定位重画。
            void this.ensureSlideMeasured(logicalIndex).then((measured) => {
                if (!measured || !this.active) return;
                const located = this.findPageIndex(logicalIndex);
                if (located >= 0) this.pageIndex = located;
                this.renderPage();
            });
        }
        return true;
    }

    /** 在 pages 里定位某逻辑页的物理页；优先精确到段 / 首个块。 */
    private findPageIndex(
        logicalIndex: number,
        segmentIndex?: number,
        anchor?: string
    ): number {
        if (anchor) {
            const exact = this.pages.findIndex(
                (page) => this.pageAnchorId(page) === anchor
            );
            if (exact >= 0) return exact;
        }
        if (segmentIndex !== undefined) {
            const bySegment = this.pages.findIndex(
                (page) =>
                    page.logicalIndex === logicalIndex &&
                    page.segmentIndex === segmentIndex
            );
            if (bySegment >= 0) return bySegment;
        }
        return this.pages.findIndex((page) => page.logicalIndex === logicalIndex);
    }

    /**
     * 按需补测一张逻辑页（已测过直接返回 false）。
     * 测完立即用新高度重分页；当前页由 repaginate 保持不动。
     */
    private async ensureSlideMeasured(logicalIndex: number): Promise<boolean> {
        const deck = this.deck;
        if (!deck) return false;
        const slide = deck.logical[logicalIndex];
        if (!slide) return false;
        if (isSlideMeasured(slide, this.lastMeasure)) return false;
        const token = this.rebuildToken;
        const measured = await this.measureDeck(
            deck,
            token,
            new Set([logicalIndex])
        );
        if (token !== this.rebuildToken) return false;
        this.lastMeasure = measured;
        this.repaginatePreservingPage();
        return true;
    }

    /** 内存统计用。 */
    debugStats(): {
        pages: number;
        blocks: number;
        logicalSlides: number;
        cmCount: number;
    } {
        return {
            pages: this.pages.length,
            blocks: this.deck?.blocks.length ?? 0,
            logicalSlides: this.deck?.logical.length ?? 0,
            // 预加载会让常驻的 mini-CM 数量随访问过的页数增长，这正是
            // 「不卸载」的代价；内存统计里能直接看到
            cmCount: this.renderedCount(),
        };
    }

    destroy(): void {
        if (this.presenting) void this.exitPresenting();
        document.removeEventListener('keydown', this.onKeyDownBound);
        document.removeEventListener(
            'fullscreenchange',
            this.onFullscreenChangeBound
        );
        document.removeEventListener(
            'pointerdown',
            this.onDocumentPointerDownBound,
            true
        );
        for (const type of INTERACTION_EVENTS) {
            document.removeEventListener(type, this.onInteractionBound);
        }
        this.toolbar.removeEventListener('click', this.onToolbarClickBound);
        this.stageWrap.removeEventListener('wheel', this.onWheelBound);
        this.resizeObserver.disconnect();
        if (this.rebuildTimer !== null) {
            window.clearTimeout(this.rebuildTimer);
            this.rebuildTimer = null;
        }
        if (this.wheelUnlockTimer !== null) {
            window.clearTimeout(this.wheelUnlockTimer);
            this.wheelUnlockTimer = null;
        }
        this.cancelPump();
        this.cancelPreload();
        // 让还在排队的测量立刻作废（宿主马上要被清空，量出来的都是 0）
        this.rebuildToken += 1;
        this.destroyRendered();
        this.clearMeasureOverride();
        this.host.innerHTML = '';
        this.readyResolve?.();
        this.readyResolve = null;
        this.deck = null;
        this.pages = [];
        this.pageLabels = new Map();
        this.fullText = '';
    }

    // =================================================================
    // 解析 → 测量 → 分页
    // =================================================================

    private beginReady(): void {
        // 上一轮等待者（enterSlidesMode 的 await whenReady）不能悬着：
        // setDocument 会替换就绪 Promise，旧的那份必须先放行，否则一次
        // 抢跑的 UPDATE 就能让进入模式的 await 永远不返回、卡片栏漏建。
        this.resolveReady();
        this.readyPromise = new Promise<void>((resolve) => {
            this.readyResolve = resolve;
        });
    }

    private resolveReady(): void {
        this.readyResolve?.();
        this.readyResolve = null;
    }

    private clearCaches(): void {
        this.heightCache.clear();
        this.titleHeightCache.clear();
    }

    private computeFontSignature(): string {
        return [
            settingsState.getString('fontFamilyEnglish') || '',
            settingsState.getString('fontFamilyChinese') || '',
        ].join('|');
    }

    private resolveDeckTheme(): SlidesDeckTheme {
        if (this.settings.theme === 'auto') {
            return this.editorTheme === 'light' ? 'paper' : 'ink';
        }
        return this.settings.theme;
    }

    /**
     * 读 live 编辑器当前的正文基准字号（编辑器字号 × fontScale）。
     *
     * #editor .cm-content 的计算字号就是 live 正文的真实字号，包含用户
     * 字体设置与 Ctrl+滚轮缩放；取不到时退回 14px。
     */
    private readLiveBodyFontPx(): number {
        const content = document.querySelector<HTMLElement>(
            '#editor .cm-content'
        );
        if (content) {
            const px = Number.parseFloat(getComputedStyle(content).fontSize);
            if (Number.isFinite(px) && px > 0) return px;
        }
        return 14;
    }

    /**
     * 把 live 的基准字号同步给纯函数层。
     *
     * bodyFontSize / titleFontSize 是纯函数（解析、分页、测量都会用），
     * 由这里在每次解析前注入；字号跟 live 走之后，三个模式的正文
     * 字号 / 缩进基准就是同一套设置。
     */
    private syncLiveBodyFont(): void {
        this.liveBodyFontPx = this.readLiveBodyFontPx();
        setSlideBodyFontPx(this.liveBodyFontPx);
    }

    /** 解析 → 测当前页 → 分页 → 渲染；其余页在后台补测。 */
    private async rebuild(anchorLine: number | null): Promise<void> {
        // 纯函数分页依赖的基准字号：每次重建前按 live 当前字号刷新
        this.syncLiveBodyFont();
        const token = ++this.rebuildToken;
        this.cancelPump();
        // 重建期间别在空闲帧里建页，等新分页出来再由 renderPage 重新安排
        this.cancelPreload();
        try {
            const deck = parseDeck(this.fullText, this.settings.headingLevel);
            // 只测首屏要显示的那一页。整篇测量是「打开幻灯片要几十秒」的
            // 根因：每块建一个 mini-CM，且所有已挂实例会被反复强制布局，
            // 成本随块数平方增长 —— 与首屏无关，文档越大越慢。
            const targetSlide = this.resolveTargetSlide(deck, anchorLine);
            const measured = await this.measureDeck(
                deck,
                token,
                new Set([targetSlide])
            );
            if (token !== this.rebuildToken) return;
            this.lastMeasure = measured;

            const previousLogical = this.pages[this.pageIndex]?.logicalIndex;
            const pages = paginateDeck(deck, measured);
            this.deck = deck;
            this.pages = pages;
            this.pumpSincePaginate = 0;

            if (anchorLine !== null) {
                const index = pages.findIndex(
                    (page) =>
                        page.blocks.some(
                            (block) =>
                                anchorLine >= block.fromLine &&
                                anchorLine <= block.toLine
                        ) ||
                        (page.titleBlock &&
                            anchorLine >= page.titleBlock.fromLine &&
                            anchorLine <= page.titleBlock.toLine)
                );
                if (index >= 0) this.pageIndex = index;
            } else if (previousLogical !== undefined) {
                // 外部更新后尽量停在原来的逻辑页
                const index = pages.findIndex(
                    (page) => page.logicalIndex === previousLogical
                );
                if (index >= 0) this.pageIndex = index;
            }

            this.pageIndex = Math.max(
                0,
                Math.min(this.pageIndex, Math.max(0, pages.length - 1))
            );

            if (this.active) {
                // 先更新大纲页码，再画页面：大纲刷新和首屏渲染互不阻塞
                this.publishPages();
                this.renderPage();
                // 首屏已经画出来，剩下的页空闲时再量。
                // 补测只影响页码标注，不阻塞打开。
                this.schedulePump(deck, token);
            }
        } catch (error) {
            const message =
                error instanceof Error ? error.stack || error.message : String(error);
            sendLog('ERROR', `Slides rebuild failed: ${message}`);
        } finally {
            if (token === this.rebuildToken) {
                this.rebuilding = false;
                this.resolveReady();
                // 编辑期间收到过外部更新：提交完成后应用它
                if (this.pendingText !== null && !this.activeDisplay) {
                    const pending = this.pendingText;
                    this.pendingText = null;
                    this.setDocument(pending, this.title);
                }
            }
        }
    }

    /** 首屏先测哪一页：锚点行所在的逻辑页 → 最近的上方页 → 上次停留页 → 第一页。 */
    private resolveTargetSlide(deck: Deck, anchorLine: number | null): number {
        if (anchorLine !== null) {
            const byLine =
                findLogicalSlideByLine(deck, anchorLine) ??
                findNearestLogicalSlideByLine(deck, anchorLine);
            if (byLine !== null) return byLine;
        }
        const previous = this.pages[this.pageIndex]?.logicalIndex;
        if (
            previous !== undefined &&
            previous >= 0 &&
            previous < deck.logical.length
        ) {
            return previous;
        }
        return 0;
    }

    /**
     * 测量块高度（缓存命中直接复用）。
     *
     * `onlySlides` 指定只测哪些逻辑页；不传时测全篇。所有调用都串行
     * 排队 —— 测量宿主是共用的，两次测量同时跑会互相清空对方挂上的块。
     */
    private measureDeck(
        deck: Deck,
        token: number,
        onlySlides?: ReadonlySet<number>
    ): Promise<MeasureResult> {
        const job = this.measureChain.then(() =>
            this.measureDeckNow(deck, token, onlySlides)
        );
        // 队列不能因为某一次失败而断掉
        this.measureChain = job.catch(() => undefined);
        return job;
    }

    /** 高度缓存键：节点 id + 字号 + 测量宽度（单栏 / 半栏两套）。 */
    private heightKey(id: string, font: number, width: number): string {
        return `${id}@${font}@${width}`;
    }

    private async measureDeckNow(
        deck: Deck,
        token: number,
        onlySlides?: ReadonlySet<number>
    ): Promise<MeasureResult> {
        const t0 = performance.now();
        // 排队期间可能已经来了新的 rebuild：直接返回缓存里的结果
        if (token !== this.rebuildToken) return this.collectMeasureResult(deck);

        const host = this.measureHost;
        host.className = `slides-measure deck-${this.effectiveTheme}`;
        host.innerHTML = '';

        // 只收集指定逻辑页上的块（标题 + 正文）。其余页先用缓存/默认值
        // 分页，等后台补测 —— 这样打开耗时与文档总长度无关。
        //
        // 注意：测量单位仍是「顶层块」而不是节点。长列表拆成几十个条目
        // 分别建 mini-CM，解析成本会翻十倍；节点高度按源码行数从整块
        // 高度里分摊（见 distributeBlockHeight），渲染层再兜底缩放。
        const wanted = onlySlides
            ? this.collectSlideBlockIds(deck, onlySlides)
            : null;
        const fullRequests: MeasureRequest[] = [];
        const addBlock = (
            block: SlideBlock,
            font: number,
            width: number,
            into: MeasureRequest[]
        ): void => {
            if (wanted && !wanted.has(block.id)) return;
            const key = this.heightKey(block.id, font, width);
            if (this.heightCache.has(key)) return;
            into.push({
                block,
                font,
                width,
                key,
                isTitle: false,
            });
        };

        for (const slide of deck.logical) {
            for (const block of slide.blocks) {
                if (block.kind === 'hr') continue;
                addBlock(
                    block,
                    bodyFontSize(block),
                    CONTENT_W,
                    fullRequests
                );
            }
        }
        for (const slide of deck.logical) {
            if (!slide.heading) continue;
            // 和正文一样只测指定页：否则打开一个文档要把全文标题都建一遍
            if (wanted && !wanted.has(slide.heading.id)) continue;
            const font = titleFontSize(
                slide.heading.level ?? 2,
                deck.slideLevel
            );
            const key = `${slide.heading.id}@${font}`;
            if (this.titleHeightCache.has(key)) continue;
            fullRequests.push({
                block: slide.heading,
                font,
                width: CONTENT_W,
                key,
                isTitle: true,
            });
        }

        let cmCount = 0;
        // 第一遍：整页宽度。短页不需要双栏，也就不必再测半栏宽度。
        cmCount += await this.runMeasurePass(fullRequests, token);

        // 第二遍：只给「内容超过一页、且存在同级兄弟」的页测半栏宽度。
        // 少这一层过滤，每页都要多建一轮 mini-CM，模式进入会明显变慢。
        const columnRequests: MeasureRequest[] = [];
        for (const slide of deck.logical) {
            if (onlySlides && !onlySlides.has(slide.index)) continue;
            if (!this.shouldMeasureColumns(slide)) continue;
            for (const block of slide.blocks) {
                if (block.kind === 'hr') continue;
                addBlock(
                    block,
                    bodyFontSize(block),
                    COLUMN_W,
                    columnRequests
                );
            }
        }
        cmCount += await this.runMeasurePass(columnRequests, token);

        host.innerHTML = '';
        host.style.width = '';
        return this.collectMeasureResult(
            deck,
            cmCount,
            performance.now() - t0
        );
    }

    /** 分批跑一组同宽度的测量请求；每批之间让出一帧。 */
    private async runMeasurePass(
        requests: MeasureRequest[],
        token: number
    ): Promise<number> {
        let count = 0;
        for (let i = 0; i < requests.length; i += MEASURE_CHUNK) {
            if (token !== this.rebuildToken) break;
            const chunk = requests.slice(i, i + MEASURE_CHUNK);
            count += await this.measureChunk(chunk, token);
            // 让出一帧：没有分页标题的大文档（整个逻辑页）也不会
            // 一口气霸占主线程
            if (i + MEASURE_CHUNK < requests.length) await this.nextFrame();
        }
        return count;
    }

    /**
     * 这一页是否需要半栏高度。
     *
     * 双栏只在「内容一页装不下 + 有同级兄弟」时才有机会成立；短页直接
     * 单列更稳，也省掉一半测量成本。
     */
    private shouldMeasureColumns(slide: LogicalSlide): boolean {
        // 作者明确要求分栏：无条件测
        if (slide.layoutOverride === 'list-columns') return true;
        // 明确要求单列：不测
        if (slide.layoutOverride === 'content') return false;

        const flat = flattenItems(slide.items).filter(
            (item) => item.kind !== 'hr'
        );
        if (flat.length < 2) return false;
        // 最长的一段同级兄弟：四个以上才「值得」分栏（两条短句并排
        // 反而更空）；同时记下是否一页装不下，装不下也值得试双栏。
        let maxRun = 1;
        let run = 1;
        for (let i = 1; i < flat.length; i += 1) {
            if (
                flat[i].parentId === flat[i - 1].parentId &&
                flat[i].depth === flat[i - 1].depth &&
                // 媒体和文字不参与同一段「同级」计数：表格不会和段落并排
                flat[i].media === flat[i - 1].media
            ) {
                run += 1;
                maxRun = Math.max(maxRun, run);
            } else {
                run = 1;
            }
        }

        // 同级兄弟不足 4 个时，只有「内容放不下」才值得试双栏。
        // 如果放不下的是表格 / 图片 / 代码这类媒体，分栏也救不了 ——
        // 测半栏纯属浪费（表格的二次测量尤其贵）。
        if (maxRun < 4) {
            for (const block of slide.blocks) {
                if (
                    block.kind !== 'table' &&
                    block.kind !== 'image' &&
                    block.kind !== 'mermaid' &&
                    block.kind !== 'code' &&
                    block.kind !== 'math' &&
                    block.kind !== 'html'
                ) {
                    continue;
                }
                const height = this.heightCache.get(
                    this.heightKey(block.id, bodyFontSize(block), CONTENT_W)
                );
                if (height !== undefined && height > CONTENT_H * 0.5) {
                    return false;
                }
            }
        }

        // 已经量过的整页高度合计装得下 → 单列即可。
        // 这里用顶层块的高度（测量单位就是块），不是节点分摊后的高度。
        let total = 0;
        let count = 0;
        let measuredAll = true;
        for (const block of slide.blocks) {
            if (block.kind === 'hr') continue;
            const height = this.heightCache.get(
                this.heightKey(block.id, bodyFontSize(block), CONTENT_W)
            );
            if (height === undefined) {
                measuredAll = false;
                break;
            }
            total += height;
            count += 1;
        }
        if (!measuredAll) return maxRun >= 4;
        total += BLOCK_GAP * Math.max(0, count - 1);
        return maxRun >= 4 || total > CONTENT_H - 80;
    }

    /** 建一批 mini-CM、等高度稳定、写缓存，然后立刻销毁释放内存。 */
    private async measureChunk(
        requests: MeasureRequest[],
        token: number
    ): Promise<number> {
        const host = this.measureHost;
        const entries: MeasureEntry[] = [];
        // 同一批请求宽度相同（整批要么单栏、要么半栏）
        const width = requests[0]?.width ?? CONTENT_W;
        try {
            // 测量宿主的宽度决定文字折行；半栏高度必须真的按半栏宽量。
            host.style.width = `${width}px`;
            for (const request of requests) {
                if (token !== this.rebuildToken) break;
                const { wrap, display } = this.createBlockDisplay(
                    request.block,
                    request.font,
                    '',
                    request.width
                );
                host.appendChild(wrap);
                entries.push({ ...request, wrap, display });
            }
            await this.settleEntries(entries, token);
            if (token !== this.rebuildToken) return entries.length;
            for (const entry of entries) {
                const cache = entry.isTitle
                    ? this.titleHeightCache
                    : this.heightCache;
                cache.set(entry.key, entry.display.contentHeight());
            }
            return entries.length;
        } finally {
            for (const entry of entries) {
                this.destroyDisplay(entry.display);
                entry.wrap.remove();
            }
            host.style.width = '';
        }
    }

    /** 指定逻辑页用到的全部块 id（标题 + 正文）。 */
    private collectSlideBlockIds(
        deck: Deck,
        slides: ReadonlySet<number>
    ): Set<string> {
        const ids = new Set<string>();
        for (const index of slides) {
            const slide = deck.logical[index];
            if (!slide) continue;
            if (slide.heading) ids.add(slide.heading.id);
            for (const block of slide.blocks) ids.add(block.id);
        }
        return ids;
    }

    /**
     * 把整块高度按源码行数分摊给它的节点。
     *
     * 分页需要「单个列表条目」的高度，但逐条建 mini-CM 太贵。列表条目
     * 的排版高度和源码行数高度相关，用行数比例分摊既便宜又足够准；
     * 真实渲染仍由 fitPageElement 兜底。
     */
    private distributeBlockHeight(
        slide: LogicalSlide,
        block: SlideBlock,
        height: number,
        target: Map<string, number>
    ): void {
        const tops = slide.items.filter((item) => item.blockId === block.id);
        const flat = flattenItems(tops);
        if (flat.length === 0) return;
        const weights = flat.map((item) =>
            Math.max(1, item.source.split('\n').length)
        );
        const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
        flat.forEach((item, index) => {
            // 下限 12px：空条目不至于把分页算成负数高度
            target.set(
                item.id,
                Math.max(12, (height * weights[index]) / totalWeight)
            );
        });
    }

    /** 从缓存汇总当前拿到的全部高度；还没测的块不放入，分页用默认 90px。 */
    private collectMeasureResult(
        deck: Deck,
        cmCount = 0,
        ms = 0
    ): MeasureResult {
        const body = new Map<string, number>();
        const bodyColumn = new Map<string, number>();
        const titles = new Map<string, number>();
        for (const slide of deck.logical) {
            for (const block of slide.blocks) {
                if (block.kind === 'hr') continue;
                const font = bodyFontSize(block);
                const full = this.heightCache.get(
                    this.heightKey(block.id, font, CONTENT_W)
                );
                if (full !== undefined) {
                    this.distributeBlockHeight(slide, block, full, body);
                }
                const column = this.heightCache.get(
                    this.heightKey(block.id, font, COLUMN_W)
                );
                if (column !== undefined) {
                    this.distributeBlockHeight(
                        slide,
                        block,
                        column,
                        bodyColumn
                    );
                }
            }
            if (!slide.heading) continue;
            const font = titleFontSize(
                slide.heading.level ?? 2,
                deck.slideLevel
            );
            const height = this.titleHeightCache.get(
                `${slide.heading.id}@${font}`
            );
            if (height !== undefined) titles.set(slide.heading.id, height);
        }
        return { body, bodyColumn, titles, cmCount, ms };
    }

    /**
     * 等这一批测量块的高度稳定。
     *
     * 只有段落/列表/代码时，两帧后高度就定了，不用多等；含图片 /
     * Mermaid / 公式 / 表格时它们会在后续帧里改高度，再轮询到两次采样
     * 一致为止（最多约 1.2 秒，之后按当前值排版）。
     */
    private async settleEntries(
        entries: MeasureEntry[],
        token: number
    ): Promise<void> {
        try {
            await document.fonts.ready;
        } catch {
            /* 字体 API 不可用时直接轮询 */
        }
        if (token !== this.rebuildToken) return;
        // 两帧：让 rAF 里排队的表格重排、CM 自身的 measure 跑完
        await this.nextFrame();
        if (token !== this.rebuildToken) return;
        await this.nextFrame();
        if (token !== this.rebuildToken) return;

        const hasAsync = entries.some((entry) =>
            ASYNC_BLOCK_KINDS.has(entry.block.kind)
        );
        if (!hasAsync) return;

        let previous = this.sumHeights(entries);
        for (let i = 0; i < 20; i += 1) {
            if (token !== this.rebuildToken) return;
            await new Promise((resolve) => window.setTimeout(resolve, 60));
            const current = this.sumHeights(entries);
            if (Math.abs(current - previous) < 0.5) return;
            previous = current;
        }
    }

    private sumHeights(entries: MeasureEntry[]): number {
        return entries.reduce(
            (acc, entry) =>
                acc +
                (entry.display.destroyed ? 0 : entry.display.contentHeight()),
            0
        );
    }

    /** 等一帧（测量宿主在可见容器里，rAF 会正常触发）。 */
    private nextFrame(): Promise<void> {
        return new Promise((resolve) => {
            window.requestAnimationFrame(() => resolve());
        });
    }

    // =================================================================
    // 后台补测
    // =================================================================

    /**
     * 逐页补测剩下的逻辑页。
     *
     * 只在空闲时做，编辑/重排期间自动让路；每补几页才重分页一次。
     * 打开文件时不再为「用户可能永远不会看的内容」付测量成本。
     */
    private schedulePump(deck: Deck, token: number): void {
        // 先把首屏让给浏览器绘制，再开始补测
        this.schedulePumpNext(deck, token, 300);
    }

    private cancelPump(): void {
        this.pumpCancel?.();
        this.pumpCancel = null;
    }

    private async pumpStep(deck: Deck, token: number): Promise<void> {
        if (token !== this.rebuildToken || !this.active) return;
        // 编辑 / 重排期间让路：补测只是为了页码更准，不能和用户抢主线程
        if (this.activeDisplay || this.rebuilding) {
            this.schedulePumpNext(deck, token, 400);
            return;
        }
        // 用户刚动过滚轮/键盘/鼠标：先别测。补测一页要几百毫秒，
        // 落在翻页/滚动中间就是明显的掉帧。
        if (performance.now() - this.lastInteraction < 600) {
            this.schedulePumpNext(deck, token, 800);
            return;
        }

        const index = this.nextUnmeasuredSlide(deck);
        if (index < 0) {
            // 全部测完：补一次重分页，让缩略图和页码落到最终结果
            if (this.pumpSincePaginate > 0) {
                this.pumpSincePaginate = 0;
                this.repaginatePreservingPage();
            }
            return;
        }

        const measured = await this.measureDeck(deck, token, new Set([index]));
        if (token !== this.rebuildToken) return;
        this.lastMeasure = measured;
        this.pumpSincePaginate += 1;
        if (this.pumpSincePaginate >= 4) {
            this.pumpSincePaginate = 0;
            this.repaginatePreservingPage();
        }
        this.schedulePumpNext(deck, token, 120);
    }

    /**
     * 安排下一次补测。
     *
     * 优先用 requestIdleCallback：它只在浏览器空闲时执行，用户一旦滚动 /
     * 输入就会先处理交互。补测只影响后续页码，晚一点完成完全没关系。
     * timeout 兜底保证持续交互时最终也能测完。
     */
    private schedulePumpNext(deck: Deck, token: number, delay: number): void {
        this.cancelPump();
        const run = (): void => {
            this.pumpCancel = null;
            void this.pumpStep(deck, token);
        };
        const ric = (
            window as unknown as {
                requestIdleCallback?: (
                    callback: () => void,
                    options?: { timeout: number }
                ) => number;
            }
        ).requestIdleCallback;
        if (typeof ric === 'function') {
            // 必须绑回 window：部分 DOM API 脱离 receiver 调用会抛
            // Illegal invocation
            const id = ric.call(window, run, { timeout: delay + 3000 });
            const cancel = (
                window as unknown as {
                    cancelIdleCallback?: (handle: number) => void;
                }
            ).cancelIdleCallback;
            this.pumpCancel = () => cancel?.call(window, id);
            return;
        }
        const id = window.setTimeout(run, delay);
        this.pumpCancel = () => window.clearTimeout(id);
    }

    /**
     * 下一张要补测的逻辑页：从当前页向两边扩散。
     * 用户最可能翻到相邻页，先测它们，翻页时就不用等测量。
     */
    private nextUnmeasuredSlide(deck: Deck): number {
        const count = deck.logical.length;
        const current = this.pages[this.pageIndex]?.logicalIndex ?? 0;
        if (
            current >= 0 &&
            current < count &&
            !isSlideMeasured(deck.logical[current], this.lastMeasure)
        ) {
            return current;
        }
        for (let distance = 1; distance < count; distance += 1) {
            const after = current + distance;
            if (
                after < count &&
                !isSlideMeasured(deck.logical[after], this.lastMeasure)
            ) {
                return after;
            }
            const before = current - distance;
            if (
                before >= 0 &&
                !isSlideMeasured(deck.logical[before], this.lastMeasure)
            ) {
                return before;
            }
            if (after >= count && before < 0) break;
        }
        return -1;
    }

    /**
     * 用最新高度重新分页，并让当前页保持不动。
     *
     * 补测会让某些逻辑页从「默认 90px」变成真实高度、页数随之后移；
     * 按逻辑页 + 段 + 首个块定位，用户不会看到页码跳走。只有当前页
     * 的内容真的变了才重画，避免无谓地重建 mini-CM。
     */
    private repaginatePreservingPage(): void {
        const deck = this.deck;
        if (!deck) return;
        const previous = this.pages[this.pageIndex];
        const pages = paginateDeck(deck, this.lastMeasure);
        this.pages = pages;
        if (previous) {
            const anchor = this.pageAnchorId(previous);
            const exact = pages.findIndex(
                (page) => this.pageAnchorId(page) === anchor
            );
            const fallback =
                exact >= 0
                    ? exact
                    : pages.findIndex(
                          (page) => page.logicalIndex === previous.logicalIndex
                      );
            if (fallback >= 0) this.pageIndex = fallback;
        }
        this.pageIndex = Math.max(
            0,
            Math.min(this.pageIndex, Math.max(0, pages.length - 1))
        );
        if (!this.active) return;
        // 页码可能整体后移：先清理缓存里已经不存在的页、对齐页脚，
        // 再通知大纲刷新标注，最后决定要不要重画当前页
        this.prunePageCache();
        this.syncPageFooters();
        this.publishPages();
        if (
            !previous ||
            !this.currentPageEl ||
            !this.samePageContent(previous, pages[this.pageIndex])
        ) {
            this.renderPage();
        } else {
            this.options.onActiveLineChange?.(this.getCurrentLine0());
        }
    }

    /** 一页的稳定标识：逻辑页 + 段 + 首个块（续页靠块区分）。 */
    private pageAnchorId(page: SlidePage): string {
        return `${page.logicalIndex}:${page.segmentIndex}:${
            page.blocks[0]?.id ?? page.titleBlock?.id ?? ''
        }`;
    }

    private samePageContent(
        a: SlidePage | undefined,
        b: SlidePage | undefined
    ): boolean {
        if (!a || !b) return a === b;
        if (a.layout !== b.layout || a.titleBlock?.id !== b.titleBlock?.id) {
            return false;
        }
        if (a.blocks.length !== b.blocks.length) return false;
        return a.blocks.every((block, index) => block.id === b.blocks[index].id);
    }

    // =================================================================
    // 块编辑器
    // =================================================================

    /**
     * 量出片段被 dedent 掉的那段行首空白有多宽（px）。
     *
     * 分页把列表链切开后，续页片段的首个条目仍带原始缩进；渲染前这段
     * 空白被去掉（≥4 格会被当成缩进代码块），要靠左内边距补回来。
     * 写死「每级 20px」在 28/30px 字号下会明显偏窄，同一层级换页后横向
     * 跳；这里用和 live listIndentDecorations 同一套 canvas 口径，按块
     * 的真实字号 / 字体族量。
     *
     * 字体族必须在 .slides-measure 里解析：块 wrap 还没挂进文档时
     * getComputedStyle 拿不到可用的 font-family。
     */
    private measureFragmentIndent(indentText: string, font: number): number {
        if (!indentText) return 0;
        const probe = document.createElement('span');
        probe.style.cssText =
            'position:fixed;left:-30000px;top:0;visibility:hidden;white-space:pre';
        probe.style.fontSize = `${font}px`;
        probe.style.fontFamily =
            'var(--livewritemd-editor-font-family, var(--vscode-editor-font-family, sans-serif))';
        this.measureHost.appendChild(probe);
        const family = getComputedStyle(probe).fontFamily || 'sans-serif';
        probe.remove();
        return measureWhitespacePx(indentText, {
            size: font,
            family,
            weight: '400',
        });
    }

    /**
     * 创建一个块显示。
     *
     * 所有块都带哨兵行：整篇文档只有一个块时，光标永远落在块内会禁用
     * live 的块级装饰；哨兵把选区引到块外，显示态才是完整的渲染态。
     */
    private createBlockDisplay(
        block: SlideBlock,
        font: number,
        extraClass = '',
        /** 这一块的可用排版宽度（设计像素）：整页 1136 / 半栏 552。 */
        width = CONTENT_W
    ): { wrap: HTMLElement; display: NodeDisplay } {
        const wrap = document.createElement('div');
        wrap.className =
            `slide-block kind-${block.kind} ${extraClass}`.trim();
        wrap.style.setProperty(
            '--livewritemd-editor-font-size',
            `${font}px`
        );
        // 嵌套节点（列表项的子内容）渲染时源码已去掉公共缩进，
        // 用左内边距补回层级。按块的真实字体量出 indentText 的像素宽，
        // 不用写死的「每级 20px」：28/30px 字号下会偏窄，换页后横向跳。
        const indentText = block.indent ?? '';
        const measuredIndent = this.measureFragmentIndent(indentText, font);
        const nodeIndent =
            measuredIndent > 0
                ? measuredIndent
                : block.depth && block.depth > 1
                  ? (block.depth - 1) * NODE_INDENT_PX
                  : 0;
        if (nodeIndent > 0) {
            wrap.style.paddingLeft = `${nodeIndent.toFixed(2)}px`;
        }
        // 表格列宽不能去猜 zoom 后的 clientWidth（CSS zoom 下它和排版
        // 宽度不是一回事），直接把这一块的可用宽写进变量，测量与渲染
        // 用同一个数，表格就不会「测量时按宽表算、渲染时按窄表重排」。
        const contentWidth = width - nodeIndent;
        if (contentWidth > 0) {
            wrap.style.setProperty(
                '--lwm-table-max-width',
                `${contentWidth}px`
            );
        }
        // 代码块不再单独压行高：内容排版（行高 / 字重 / 内边距）与 live /
        // map 节点保持同一套，幻灯片只覆盖字号与可用宽。

        const display = createNodeDisplay({
            doc: block.source,
            sentinel: true,
            theme: this.effectiveTheme === 'ink' ? 'dark' : 'light',
            codeLanguages: this.options.codeLanguages,
            // 表格边缘 + 按钮在显示态直接改源码；幻灯片里也要接出去，
            // 否则下一次 setDocument 会把它覆盖掉。
            onDisplayChange: (text) => this.commitBlock(block, text),
        });
        display.container.classList.add('slide-block-cm');
        wrap.appendChild(display.container);

        if (block.kind === 'table') {
            this.scheduleTableMeasure(display);
        }
        return { wrap, display };
    }

    /**
     * 表格列宽用的是 getMeasureContext() 的全局口径；幻灯片段落字号
     * 和主编辑器不同，必须把测量根切到表格自己的 .cm-content 再重排一次。
     */
    private scheduleTableMeasure(display: NodeDisplay): void {
        requestAnimationFrame(() => {
            if (display.destroyed) return;
            setMeasureRootOverride(display.view.contentDOM);
            this.measureOverrideOwner = display;
            display.view.dispatch({
                effects: [tableRemeasureEffect.of(null)],
            });
            // 列宽按幻灯片宽度重算之后，块高度 / 宽度都变了：
            // 下一帧重新做一次自适应，别让首次按「撑宽的表格」算出的
            // 缩放比例（常见 0.6 左右）一直留着，把表缩得很小。
            requestAnimationFrame(() => {
                if (display.destroyed) return;
                const root = display.container.closest(
                    '.slide-page'
                ) as HTMLElement | null;
                if (!root) return;
                this.fitPageElement(root);
                this.checkOverflow(root);
            });
        });
    }

    private clearMeasureOverride(): void {
        this.measureOverrideOwner = null;
        setMeasureRootOverride(null);
    }

    private destroyDisplay(display: NodeDisplay): void {
        if (this.measureOverrideOwner === display) {
            this.clearMeasureOverride();
        }
        try {
            display.destroy();
        } catch (error) {
            console.warn('destroy slide block failed', error);
        }
    }

    /** 已渲染页面里常驻的块编辑器数量（内存统计用）。 */
    private renderedCount(): number {
        let count = 0;
        for (const entry of this.pageEls.values()) {
            count += entry.entries.length;
        }
        return count;
    }

    /** 构建页面期间登记块显示（测量用的临时实例不走这里）。 */
    private trackBlock(wrap: HTMLElement, display: NodeDisplay): void {
        this.buildingEntries?.push({ wrap, display });
    }

    /** 销毁所有已渲染页面（离开模式 / 重建文档 / 换主题时用）。 */
    private destroyRendered(): void {
        for (const entry of this.pageEls.values()) {
            for (const block of entry.entries) {
                this.destroyDisplay(block.display);
            }
        }
        this.pageEls.clear();
        this.currentPageEl = null;
        this.buildingEntries = null;
        this.activeDisplay = null;
        this.stage.innerHTML = '';
    }

    /**
     * 去掉已经不在分页结果里的缓存页（改内容 / 重新分页后）。
     *
     * 只删「这一页在 pages 里已经不存在」的缓存，仍在用的页面一律保留 ——
     * 用户要求加载过的页面不卸载，翻回去也不用重建。
     */
    private prunePageCache(): void {
        if (this.pageEls.size === 0) {
            // 封面预览等临时节点不在缓存里，也要一起清掉
            for (const child of Array.from(this.stage.children)) child.remove();
            return;
        }
        const alive = new Set(
            this.pages.map((page) => this.pageSignature(page))
        );
        const aliveEls = new Set<HTMLElement>();
        for (const [key, entry] of this.pageEls) {
            aliveEls.add(entry.el);
            if (alive.has(key)) continue;
            for (const block of entry.entries) {
                this.destroyDisplay(block.display);
            }
            entry.el.remove();
            this.pageEls.delete(key);
            if (this.currentPageEl === entry.el) this.currentPageEl = null;
        }
        // 预览页等不在 pageEls 里的残留节点
        for (const child of Array.from(this.stage.children)) {
            if (!aliveEls.has(child as HTMLElement)) child.remove();
        }
    }

    // =================================================================
    // 渲染
    // =================================================================

    private deckTitle(): string {
        return this.deck?.meta.title || this.title || '未命名';
    }

    private pageTitle(page: SlidePage): string {
        if (page.layout === 'cover') return this.deck?.meta.title || '封面';
        const slide = this.deck?.logical[page.logicalIndex];
        const text = plainHeading(slide?.heading) || '正文';
        return page.continued ? `${text}（续）` : text;
    }

    /** 测量期间先把封面画出来，避免切模式后短暂白屏。 */
    private renderCoverPreview(deck: Deck): void {
        // 换文档：上一轮的页面与 mini-CM 全部作废
        this.destroyRendered();
        const el = document.createElement('div');
        el.className =
            `slide-page deck-${this.effectiveTheme} layout-cover frame-${this.settings.frame}`;
        if (deck.meta.title || deck.meta.subtitle) {
            this.renderCover(el);
        } else {
            const empty = document.createElement('div');
            empty.className = 'slides-empty';
            empty.textContent = '正在排版…';
            el.appendChild(empty);
        }
        el.style.visibility = 'visible';
        this.stage.appendChild(el);
        this.currentPageEl = el;
        this.fitStage();
    }

    /**
     * 显示当前页。
     *
     * 页面按锚点缓存：已经建好的页只是把 visibility 切回来，不再重建
     * mini-CM；没建过的页现场建一页，并在空闲帧里把前后 5 页补上。
     */
    private renderPage(): void {
        this.prunePageCache();
        this.fitStage();
        const page = this.pages[this.pageIndex];
        if (!page) {
            for (const child of Array.from(this.stage.children)) child.remove();
            const empty = document.createElement('div');
            empty.className = 'slides-empty';
            empty.textContent = '没有可显示的内容。';
            this.stage.appendChild(empty);
            this.currentPageEl = null;
            this.updateChrome();
            return;
        }

        const el = this.ensurePageElement(this.pageIndex);
        this.showPageElement(el);
        // 后台补测可能让页码整体后移，缓存页的页脚跟着更新
        this.syncPageFooters();
        this.updateChrome();
        // 大纲高亮跟着「当前页第一行」走（PPT 里没有正文光标）
        this.options.onActiveLineChange?.(this.getCurrentLine0());
        // 前后 5 页空闲时补建，翻页就不必现场建 mini-CM
        this.schedulePreload();
    }

    /**
     * 页面缓存 key：整页每个块的 id 都算进去。
     *
     * 不能只用 pageAnchorId（首块）—— 用户改的是页内第二块时首块没变，
     * 复用旧 DOM 会显示改前的文字。块 id 自带源码哈希，改过就换 key。
     */
    private pageSignature(page: SlidePage): string {
        return [
            page.logicalIndex,
            page.segmentIndex,
            page.titleBlock?.id ?? '',
            page.blocks.map((block) => block.id).join('|'),
            page.layout,
        ].join('::');
    }

    /** 取（必要时创建）某一页的 DOM。 */
    private ensurePageElement(index: number): HTMLElement {
        const page = this.pages[index];
        const key = this.pageSignature(page);
        const cached = this.pageEls.get(key);
        if (cached) return cached.el;
        const built = this.buildPageElement(page, index);
        this.pageEls.set(key, built);
        return built.el;
    }

    /**
     * 构建一整页（含页脚、自适应、图片回调）。
     *
     * 先设为 visibility:hidden：预加载时不该闪出来；隐藏不影响布局，
     * mini-CM 的高度、表格列宽、getBoundingClientRect 都照常可用。
     */
    private buildPageElement(
        page: SlidePage,
        index: number
    ): { el: HTMLElement; entries: RenderedEntry[] } {
        const el = document.createElement('div');
        el.className =
            `slide-page deck-${this.effectiveTheme} layout-${page.layout} frame-${this.settings.frame}`;
        el.style.visibility = 'hidden';

        const entries: RenderedEntry[] = [];
        this.buildingEntries = entries;
        try {
            if (page.layout === 'cover') {
                this.renderCover(el);
            } else if (page.layout === 'section') {
                this.renderSection(el, page);
            } else if (page.layout === 'statement') {
                this.renderStatement(el, page);
            } else if (page.layout === 'fact') {
                this.renderFact(el, page);
            } else if (page.layout === 'end') {
                this.renderEnd(el, page);
            } else {
                this.renderContent(el, page);
            }

            // 封面 / 章节页 / 结束页不放页码：它们不是内容页，页码反而打断情绪
            const hideFooter =
                page.layout === 'cover' ||
                page.layout === 'section' ||
                page.layout === 'end';
            if (!hideFooter) {
                const footer = document.createElement('div');
                footer.className = 'slide-footer';
                footer.innerHTML =
                    `<span class="slide-footer-title">${this.escapeHtml(this.deckTitle())}</span>` +
                    `<span class="slide-page-no">${index + 1} / ${this.pages.length}</span>`;
                el.appendChild(footer);
            }
        } finally {
            this.buildingEntries = null;
        }

        this.stage.appendChild(el);
        // 建好就做一次自适应（隐藏页也能量），切到这一页时不再跳一下
        requestAnimationFrame(() => {
            if (!el.isConnected) return;
            this.fitPageElement(el);
            this.checkOverflow(el);
            this.bindImageReflow(el);
        });
        return { el, entries };
    }

    /** 把某一页切成可见页；其余缓存页隐藏，但布局与实例都保留。 */
    private showPageElement(el: HTMLElement): void {
        if (this.currentPageEl !== el) {
            if (this.currentPageEl) {
                this.currentPageEl.style.visibility = 'hidden';
            }
            el.style.visibility = 'visible';
            this.currentPageEl = el;
        }
        // 显示后再校一次尺寸：预加载期间 Mermaid / 图片是异步出高度的，
        // 建页时那次自适应可能早于它们完成。这里只量当前页，代价很小。
        requestAnimationFrame(() => {
            if (this.currentPageEl !== el || !el.isConnected) return;
            this.fitPageElement(el);
            this.checkOverflow(el);
        });
    }

    /** 页码可能在后台补测后整体后移：把缓存页的页脚数字对齐到最新分页。 */
    private syncPageFooters(): void {
        if (this.pages.length === 0) return;
        const indexByKey = new Map<string, number>();
        this.pages.forEach((page, index) =>
            indexByKey.set(this.pageSignature(page), index)
        );
        for (const [key, entry] of this.pageEls) {
            const index = indexByKey.get(key);
            if (index === undefined) continue;
            const no = entry.el.querySelector<HTMLElement>('.slide-page-no');
            if (no) no.textContent = `${index + 1} / ${this.pages.length}`;
        }
    }

    // -----------------------------------------------------------------
    // 预加载：当前页前后各 5 页
    // -----------------------------------------------------------------

    /** 安排一次预加载（空闲帧；不支持 requestIdleCallback 时退回 setTimeout）。 */
    private schedulePreload(delay = 60): void {
        if (this.preloadCancel) return;
        if (!this.active || this.pages.length <= 1) return;
        const run = (): void => {
            this.preloadCancel = null;
            this.preloadStep();
        };
        const ric = (
            window as unknown as {
                requestIdleCallback?: (
                    callback: () => void,
                    options?: { timeout: number }
                ) => number;
            }
        ).requestIdleCallback;
        if (typeof ric === 'function') {
            const id = ric.call(window, run, { timeout: delay + 1500 });
            const cancel = (
                window as unknown as {
                    cancelIdleCallback?: (handle: number) => void;
                }
            ).cancelIdleCallback;
            this.preloadCancel = () => cancel?.call(window, id);
            return;
        }
        const id = window.setTimeout(run, delay);
        this.preloadCancel = () => window.clearTimeout(id);
    }

    private cancelPreload(): void {
        this.preloadCancel?.();
        this.preloadCancel = null;
    }

    /** 一次空闲只建一页：每页要同步创建一批 mini-CM，不能一口气全建。 */
    private preloadStep(): void {
        if (!this.active) return;
        // 重建 / 编辑优先；编辑期间不走预加载，免得和输入抢主线程
        if (this.rebuilding || this.activeDisplay) {
            this.schedulePreload(800);
            return;
        }
        // 用户刚翻过页 / 滚过轮：先让交互，等停下来再补
        if (performance.now() - this.lastInteraction < 500) {
            this.schedulePreload(500);
            return;
        }
        const index = this.nextPreloadIndex();
        if (index < 0) return;
        this.ensurePageElement(index);
        this.schedulePreload(40);
    }

    /** 从近到远向两边找第一个还没建过的页：+1、-1、+2、-2…… */
    private nextPreloadIndex(): number {
        for (let distance = 1; distance <= PRELOAD_RADIUS; distance += 1) {
            const after = this.pageIndex + distance;
            if (after < this.pages.length && !this.isPageBuilt(after)) {
                return after;
            }
            const before = this.pageIndex - distance;
            if (before >= 0 && !this.isPageBuilt(before)) return before;
        }
        return -1;
    }

    private isPageBuilt(index: number): boolean {
        const page = this.pages[index];
        if (!page) return false;
        return this.pageEls.has(this.pageSignature(page));
    }

    /**
     * 图片解码后才能拿到真实高度：每张图加载完补做一次自适应。
     *
     * 用 once + 容器存活判断：页面可能已经被 prunePageCache 移除，旧图片
     * 的 load 回调落到不存在的节点上时直接忽略。
     */
    private bindImageReflow(root: HTMLElement): void {
        for (const img of Array.from(root.querySelectorAll('img'))) {
            if (img.complete) continue;
            img.addEventListener(
                'load',
                () => {
                    if (!root.isConnected) return;
                    this.fitPageElement(root);
                    this.checkOverflow(root);
                },
                { once: true }
            );
        }
    }

    private renderCover(stage: HTMLElement): void {
        const meta = this.deck?.meta ?? {};
        const inner = document.createElement('div');
        inner.className = 'cover-inner';
        inner.innerHTML = `
            <div class="cover-title">${this.escapeHtml(meta.title || 'Markdown 幻灯片')}</div>
            <div class="cover-rule"></div>
            ${meta.subtitle ? `<div class="cover-subtitle">${this.escapeHtml(meta.subtitle)}</div>` : ''}
            <div class="cover-meta">
                ${meta.author ? `<span>${this.escapeHtml(meta.author)}</span>` : ''}
                ${meta.date ? `<span>${this.escapeHtml(meta.date)}</span>` : ''}
            </div>
        `;
        stage.appendChild(inner);
    }

    private renderSection(stage: HTMLElement, page: SlidePage): void {
        const inner = document.createElement('div');
        inner.className = 'section-inner';
        const kicker = document.createElement('div');
        kicker.className = 'section-kicker';
        kicker.textContent = 'SECTION';
        inner.appendChild(kicker);
        if (page.titleBlock) {
            const { wrap, display } = this.createBlockDisplay(
                page.titleBlock,
                page.titleFont,
                'slide-title-block'
            );
            this.attachEdit(wrap, display, page.titleBlock);
            this.trackBlock(wrap, display);
            inner.appendChild(wrap);
        }
        stage.appendChild(inner);
    }

    /** 金句页：标题只当 kicker，正文整段 64px 居中。 */
    private renderStatement(stage: HTMLElement, page: SlidePage): void {
        const inner = document.createElement('div');
        inner.className = 'statement-inner';
        if (page.titleBlock) {
            const kicker = document.createElement('div');
            kicker.className = 'statement-kicker';
            kicker.textContent = plainHeading(page.titleBlock);
            inner.appendChild(kicker);
        }
        const para = page.blocks.find((block) => block.kind === 'para') ?? page.blocks[0];
        if (para) {
            const { wrap, display } = this.createBlockDisplay(para, 64);
            this.attachEdit(wrap, display, para);
            this.trackBlock(wrap, display);
            inner.appendChild(wrap);
        }
        stage.appendChild(inner);
    }

    /**
     * 大数字页：整段按 96px 渲染。
     * 故意不把「数字」和「说明」拆成两个块——拆分会让编辑语义分裂，
     * 用户改一半还要猜另一半在哪里。
     */
    private renderFact(stage: HTMLElement, page: SlidePage): void {
        const inner = document.createElement('div');
        inner.className = 'fact-inner';
        const para = page.blocks.find((block) => block.kind === 'para') ?? page.blocks[0];
        if (para) {
            const { wrap, display } = this.createBlockDisplay(para, 96);
            this.attachEdit(wrap, display, para);
            this.trackBlock(wrap, display);
            inner.appendChild(wrap);
        }
        stage.appendChild(inner);
    }

    /** 结束页：优先用作者写的结束标题，没有才回退到 deck 标题。 */
    private renderEnd(stage: HTMLElement, page: SlidePage): void {
        const inner = document.createElement('div');
        inner.className = 'end-inner';
        const title =
            plainHeading(page.titleBlock) ||
            this.deck?.meta.title ||
            '谢谢';
        inner.innerHTML =
            `<div class="end-title">${this.escapeHtml(title)}</div>` +
            `<div class="end-sub">LIVEWRITEMD</div>`;
        stage.appendChild(inner);
    }

    private renderContent(stage: HTMLElement, page: SlidePage): void {
        // 半幅图把标题塞进文字列，页面本身没有内边距，不能再走顶部 header
        const split = page.layout === 'image-split';
        const header = document.createElement('div');
        header.className = 'slide-header';
        if (!split && page.titleBlock) {
            const { wrap, display } = this.createBlockDisplay(
                page.titleBlock,
                page.titleFont,
                'slide-title-block'
            );
            this.attachEdit(wrap, display, page.titleBlock);
            this.trackBlock(wrap, display);
            header.appendChild(wrap);
            const rule = document.createElement('div');
            rule.className = 'title-rule';
            header.appendChild(rule);
        } else if (!split && page.continued) {
            header.innerHTML = `<div class="slide-cont-title">${this.escapeHtml(
                this.pageTitle(page).replace(/（续）$/, '')
            )}<span>（续）</span></div>`;
        }
        if (header.childNodes.length > 0) stage.appendChild(header);

        // 列表分栏：分页器已经按节点算好左右两列（page.columns）。
        // 拆出来的两半仍是同一条 Markdown 列表，编辑任一半只回写对应行。
        const body = document.createElement('div');
        body.className = page.columns
            ? 'slide-two-col slide-list-col'
            : page.layout === 'two-column' || split
              ? 'slide-two-col'
              : 'slide-body';

        const addBlock = (block: SlideBlock, column?: HTMLElement): void => {
            // 半栏页的块按半栏宽分表格列；整页按内容宽
            const blockWidth = column ? COLUMN_W : CONTENT_W;
            const { wrap, display } = this.createBlockDisplay(
                block,
                bodyFontSize(block),
                '',
                blockWidth
            );
            // 分栏用的合成块带 #L / #R 后缀，缩放比例记在原块 id 上
            const fit =
                page.fitScales.get(block.id) ??
                page.fitScales.get(block.id.replace(/#[LR]$/, ''));
            if (fit && fit < 1) {
                wrap.style.zoom = String(fit);
                wrap.dataset.fit = String(fit);
            }
            this.attachEdit(wrap, display, block);
            this.trackBlock(wrap, display);
            (column ?? body).appendChild(wrap);
        };

        if (page.columns) {
            // 分页器已经保证两列都从同级节点开始；这里只负责摆放。
            const [leftColumn, rightColumn] = page.columns;
            const left = document.createElement('div');
            left.className = 'col';
            const right = document.createElement('div');
            right.className = 'col';
            for (const block of leftColumn) addBlock(block, left);
            for (const block of rightColumn) addBlock(block, right);
            body.appendChild(left);
            body.appendChild(right);
        } else if (page.layout === 'two-column' || split) {
            const left = document.createElement('div');
            left.className = split ? 'col col-text' : 'col';
            const right = document.createElement('div');
            right.className = split ? 'col col-media' : 'col';

            // 半幅图：标题作为文字列的第一个块（页面 padding 为 0，
            // 不能再用顶部 header，否则标题会顶到页面边缘）。
            if (split && page.titleBlock) {
                const { wrap, display } = this.createBlockDisplay(
                    page.titleBlock,
                    page.titleFont,
                    'slide-title-block',
                    COLUMN_W
                );
                this.attachEdit(wrap, display, page.titleBlock);
                this.trackBlock(wrap, display);
                left.appendChild(wrap);
            }

            const media = page.blocks.filter(
                (block) =>
                    block.kind === 'image' ||
                    block.kind === 'mermaid' ||
                    block.kind === 'table'
            );
            const text = page.blocks.filter((block) => !media.includes(block));
            // 有媒体时：文字全进左列、媒体全进右列（哪怕某一边为空）。
            // 没有媒体时才按数量对半切——不能把媒体块同时塞进两列，
            // 否则同一个块会被创建两次编辑器。
            const leftBlocks =
                media.length > 0
                    ? text
                    : page.blocks.slice(0, Math.ceil(page.blocks.length / 2));
            const rightBlocks =
                media.length > 0
                    ? media
                    : page.blocks.slice(leftBlocks.length);
            for (const block of leftBlocks) addBlock(block, left);
            for (const block of rightBlocks) addBlock(block, right);
            body.appendChild(left);
            body.appendChild(right);
        } else {
            for (const block of page.blocks) addBlock(block);
        }
        stage.appendChild(body);

        if (page.overflow) {
            const badge = document.createElement('div');
            badge.className = 'overflow-badge';
            badge.textContent = '内容超出页面';
            stage.appendChild(badge);
        }
    }

    /**
     * 渲染后在真实 DOM 上做一次等比缩放。
     *
     * 分页测量是按「整页宽度、顺序堆叠」估的，双栏 / 列表分栏 / 超宽
     * 表格和长代码行的真实尺寸量不出来。这里按容器量一次，统一缩所有
     * 子块，既避免一块大一块小，也保证不会超出页面。
     *
     * 关键：测量前把 zoom 归一到 1。CSS zoom 不改变 offsetHeight（仍是
     * 未缩放的布局高度），却会让 scrollWidth 按反比放大 —— 在已有缩放
     * 上再量一次会把比例算重，代码块会越补测越小。
     *
     * 最低压到 0.4：再小就看不清了，让它继续标「内容超出页面」提示作者
     * 精简，而不是缩成一团糊字。
     */
    /**
     * 页面自适应的缩放下限。
     *
     * 普通正文 / 代码保持 0.4：再小就影响阅读，留给作者精简内容。
     * 但表格 / 公式 / mermaid / 图片是「整块媒体」——它们本来就可以
     * 等比缩小，单独占一页时即使缩到很小也比直接打「内容超出页面」
     * 更有用，所以下限放到 0.05。多块混排页仍按 0.4，避免把同页
     * 正文一起缩得看不清。
     */
    private fitFloor(container: HTMLElement): number {
        const children = Array.from(container.children).filter(
            (child): child is HTMLElement => child instanceof HTMLElement
        );
        if (children.length !== 1) return 0.4;
        return /(?:^|\s)kind-(?:table|math|mermaid|image)(?:\s|$)/.test(
            children[0].className
        )
            ? 0.05
            : 0.4;
    }

    private fitPageElement(root: HTMLElement): void {
        const containers = Array.from(
            root.querySelectorAll<HTMLElement>(
                '.slide-body, .slide-two-col > .col'
            )
        );
        for (const container of containers) {
            const children = Array.from(container.children).filter(
                (child): child is HTMLElement => child instanceof HTMLElement
            );
            if (children.length === 0) continue;
            const floor = this.fitFloor(container);
            // 按未缩放尺寸量（分页阶段的等比缩放也先撤掉，最后统一重算）
            for (const child of children) child.style.zoom = '1';
            const gap =
                Number.parseFloat(getComputedStyle(container).rowGap) || 0;
            let totalH = gap * Math.max(0, children.length - 1);
            let maxW = 0;
            for (const child of children) {
                totalH += child.offsetHeight;
                // 代码块的长行由块内横向滚动接管（见 slidesStyles 的
                // `.slide-block.kind-code .cm-scroller`）。把 scrollWidth
                // 算进整页缩放，会让一两行超长代码把整页压到 0.4 —
                // 代码字号小到看不清，下半页还空着。宽度只按块本身的
                // 盒子算，长行自己滚。
                maxW = Math.max(
                    maxW,
                    child.classList.contains('kind-code')
                        ? child.clientWidth
                        : child.scrollWidth
                );
            }
            // 双栏的每一列高度会跟着内容一起长（grid 行 auto），
            // 拿它自己的 clientHeight 永远等于内容高、永远判不出溢出；
            // 可用高度要取外层网格（它被 flex 限制在页面剩余空间里）。
            const parent = container.parentElement;
            const heightOwner =
                parent?.classList.contains('slide-two-col') === true
                    ? parent
                    : container;
            const availH = heightOwner.clientHeight;
            const availW = container.clientWidth;
            if (availH <= 0 || availW <= 0) continue;
            const scale = Math.min(
                1,
                availH / Math.max(1, totalH),
                availW / Math.max(1, maxW)
            );
            const clamped = Math.max(0.4, scale);
            if (clamped >= 0.995) continue;
            for (const child of children) {
                child.style.zoom = String(
                    Math.round(clamped * 1000) / 1000
                );
            }
        }

        // 同一双栏页的左右两列必须用同一个缩放比例：只缩溢出的一列会让
        // 两边字号一大一小。取两列里较小的那个比例统一应用。
        for (const grid of Array.from(
            root.querySelectorAll<HTMLElement>('.slide-two-col')
        )) {
            const cols = Array.from(grid.children).filter(
                (child): child is HTMLElement => child instanceof HTMLElement
            );
            if (cols.length !== 2) continue;
            const scales = cols.map((col) => {
                const first = col.firstElementChild as HTMLElement | null;
                return first ? Number.parseFloat(first.style.zoom) || 1 : 1;
            });
            const uniform = Math.min(...scales);
            for (const col of cols) {
                for (const child of Array.from(col.children)) {
                    if (child instanceof HTMLElement) {
                        child.style.zoom = String(uniform);
                    }
                }
            }
        }
    }

    /**
     * 渲染 + 自适应之后再判一次是否真的溢出。
     *
     * 分页阶段的 overflow 是「按估算高度 + 最小缩放」得出的预判；
     * 真实 DOM 上缩放之后可能已经放得下，所以这里既补标记，也**撤掉**
     * 已经不需要的标记（否则代码块明明缩进去了还挂着提示）。
     */
    private checkOverflow(root: HTMLElement): void {
        let overflow = this.measureOverflow(root);
        if (overflow) {
            // 表格列宽、图片解码、字体加载都是异步的，可能在首次自适应
            // 之后才把块撑高（表格尤其常见：末行尺寸晚一帧才定）。先按
            // 最新尺寸再缩一次；offsetHeight 对「缩放中重排的表格」会
            // 量出偏小的值，所以再按真实 rects 补一次几何缩放，缩完还超
            // 才真的提示作者。
            this.fitPageElement(root);
            if (this.measureOverflow(root)) this.shrinkToFit(root);
            overflow = this.measureOverflow(root);
        }
        const badge = root.querySelector('.overflow-badge');
        if (!overflow) {
            badge?.remove();
            return;
        }
        if (badge) return;
        const next = document.createElement('div');
        next.className = 'overflow-badge';
        next.textContent = '内容超出页面';
        root.appendChild(next);
    }

    /**
     * 按真实 rects 再压一次子块。
     *
     * 与 fitPageElement 的区别：这里用 getBoundingClientRect 的**比值**
     * 直接求「还需要缩多少」，不依赖 offsetHeight。对异步重排的表格 /
     * 图片，offsetHeight 与最终渲染尺寸会差一截，这一步兜住那部分。
     * 仍然以 0.4 为下限：再小就是看不清，留给「内容超出页面」提示。
     */
    private shrinkToFit(root: HTMLElement): void {
        const body =
            (root.querySelector('.slide-body') as HTMLElement | null) ??
            (root.querySelector('.slide-two-col') as HTMLElement | null);
        if (!body) return;
        const children = Array.from(body.children).filter(
            (child): child is HTMLElement => child instanceof HTMLElement
        );
        if (children.length === 0) return;
        const bodyRect = body.getBoundingClientRect();
        if (bodyRect.height <= 0 || bodyRect.width <= 0) return;

        const contentBottom = Math.max(
            ...children.map((child) => child.getBoundingClientRect().bottom)
        );
        const contentRight = Math.max(
            ...children.map((child) => child.getBoundingClientRect().right)
        );
        const extraH =
            contentBottom > bodyRect.bottom
                ? bodyRect.height / Math.max(1, contentBottom - bodyRect.top)
                : 1;
        const extraW =
            contentRight > bodyRect.right
                ? bodyRect.width / Math.max(1, contentRight - bodyRect.left)
                : 1;
        const extra = Math.min(extraH, extraW);
        if (extra >= 0.999) return;

        // 单块媒体页允许缩到更小（见 fitFloor）：宁可小一点，也不打溢出提示
        const floor = this.fitFloor(body);
        for (const child of children) {
            const current = Number.parseFloat(child.style.zoom) || 1;
            child.style.zoom = String(
                Math.max(floor, Math.round(current * extra * 1000) / 1000)
            );
        }
    }

    /** 当前页里的块是否越出内容区（只量，不改）。 */
    private measureOverflow(root: HTMLElement): boolean {
        const body =
            (root.querySelector('.slide-body') as HTMLElement | null) ??
            (root.querySelector('.slide-two-col') as HTMLElement | null);
        if (!body) return false;
        const bodyRect = body.getBoundingClientRect();
        const blocks = Array.from(
            root.querySelectorAll<HTMLElement>(
                '.slide-body > .slide-block, .slide-two-col .slide-block'
            )
        );
        for (const block of blocks) {
            const rect = block.getBoundingClientRect();
            if (
                rect.bottom > bodyRect.bottom + 2 ||
                rect.right > bodyRect.right + 2
            ) {
                return true;
            }
        }
        return false;
    }

    private attachEdit(
        wrap: HTMLElement,
        display: NodeDisplay,
        block: SlideBlock
    ): void {
        // 合成片段（超高块按行拆出来的）：段落/引用/列表/表格只读，
        // 提交半块会把原文结构打散；代码块例外 —— 片段带的是原样代码行 +
        // 合成围栏，提交时只替换对应的源码行区间，可以安全编辑。
        if (block.synthetic && block.kind !== 'code') {
            wrap.classList.add('slide-block-static');
            return;
        }
        // 片段与快速卡片行相交（松散列表 / HTML block 可以跨过卡片区）：
        // 渲染源码来自掩码副本，卡片位置是空行；这种片段也必须只读 ——
        // 一旦进入编辑，commitBlock 会按整段行区间替换原文，把卡片块删掉。
        if (this.blockOverlapsQuickCards(block)) {
            wrap.classList.add('slide-block-static');
            return;
        }
        wrap.addEventListener('click', (event) => {
            if (
                !this.active ||
                display.destroyed ||
                display.editing ||
                this.rebuilding
            ) {
                return;
            }
            // 和主编辑器的 lineForce 同一条规则：自带点击语义的 widget
            // （代码复制、图片缩放、复选框、折叠箭头）不打断它们；
            // 点这些按钮不应该顺手把整块切进编辑态。
            const target = event.target as Element | null;
            if (
                target?.closest?.(
                    '.cm-md-codeblock-copy, .cm-md-preview-actions, ' +
                        '.cm-md-checkbox, .cm-md-fold-arrow, ' +
                        '.cm-md-footnote-ref'
                )
            ) {
                return;
            }
            // 光标位置必须在 enterEdit **之前**算：翻转后显示态 DOM 会被
            // 替换，按坐标命中的节点就失效了。而且不能交给 CM 的
            // posAtCoords —— 页面自适应用的是 CSS zoom，缩放后它会把
            // 客户端坐标当成未缩放坐标换算，落点偏出固定 x/y 倍率
            // （就是「点这里却选中那里」的那个 bug）。浏览器原生命中测试
            // 跑在真实布局上，再把命中的 DOM 节点交给 posAtDOM 即可。
            const caretPos = this.caretPosFromPoint(
                display,
                event.clientX,
                event.clientY
            );
            // 代码 / mermaid 在渲染态是整体 widget，native 命中往往只给出
            // 「块起点」；先按点击到的 .cm-line 记一个行首位置，进编辑后
            // 用它把光标放到真正点到的那一行（围栏行不可见，不能用）。
            const isCodeLike =
                block.kind === 'code' || block.kind === 'mermaid';
            const lineCaretPos = isCodeLike
                ? this.caretLineFromPoint(display, event.clientX, event.clientY)
                : null;
            const codeBodyStart = isCodeLike ? block.source.indexOf('\n') : -1;
            this.activeDisplay = display;
            display.enterEdit({
                kind: this.editableKind(block),
                onCommit: (text) => {
                    if (this.activeDisplay === display) this.activeDisplay = null;
                    // mini-CM 的 Esc / 失焦只负责回调，不会自己收回编辑态；
                    // 不 exitEdit 的话 blur 监听还挂着，稍后销毁视图时会
                    // 再提交一次（同内容，但白跑一轮 onEdit）。
                    display.exitEdit();
                    this.commitBlock(block, text);
                },
            });
            let caretTarget = caretPos;
            if (isCodeLike) {
                // 第一条代码行的位置：块源码第一行是围栏，+1 即正文首行
                const firstCodePos =
                    codeBodyStart >= 0 ? codeBodyStart + 1 : 0;
                const bodyTarget =
                    caretTarget !== null && caretTarget > codeBodyStart
                        ? caretTarget
                        : lineCaretPos !== null && lineCaretPos > codeBodyStart
                          ? lineCaretPos
                          : null;
                caretTarget = bodyTarget ?? firstCodePos;
            }
            if (caretTarget !== null) display.focusAtPos(caretTarget);
            else display.focusAt(event.clientX, event.clientY);
        });
    }

    /**
     * 把一次点击的客户端坐标换算成块内文档偏移。
     *
     * 优先用 caretPositionFromPoint（标准）/ caretRangeFromPoint（WebKit），
     * 两者都返回「真实布局下的文本节点 + 偏移」，不受 CSS zoom 影响。
     * 命中的不是本块编辑器时返回 null，调用方退回旧的坐标路径。
     */
    private caretPosFromPoint(
        display: NodeDisplay,
        x: number,
        y: number
    ): number | null {
        const doc = document as Document & {
            caretPositionFromPoint?: (
                x: number,
                y: number
            ) => { offsetNode: Node; offset: number } | null;
            caretRangeFromPoint?: (x: number, y: number) => Range | null;
        };
        let node: Node | null = null;
        let offset = 0;
        const caret = doc.caretPositionFromPoint?.(x, y);
        if (caret) {
            node = caret.offsetNode;
            offset = caret.offset;
        } else {
            const range = doc.caretRangeFromPoint?.(x, y);
            if (range) {
                node = range.startContainer;
                offset = range.startOffset;
            }
        }
        // 点页面空白 / 块边框时可能命中的是外层节点，那种情况不猜位置
        if (!node || !display.view.dom.contains(node)) return null;
        try {
            return display.view.posAtDOM(node, offset);
        } catch {
            // widget 节点（图片 / 公式 / Mermaid）没有可对应的文档位置
            return null;
        }
    }

    /**
     * 渲染态点击命中的那一行的行首位置（代码 / mermaid 用）。
     *
     * 代码块在渲染态是一个整体 widget，caretPositionFromPoint 拿到的
     * offsetNode 属于 widget 内部，posAtDOM 只能退回块起点；但
     * elementFromPoint 能找到真正的 .cm-line，用它的行首位置就能把
     * 光标放到点到的源码行，而不是压在看不见的围栏行上。
     */
    private caretLineFromPoint(
        display: NodeDisplay,
        x: number,
        y: number
    ): number | null {
        const hit = document.elementFromPoint(x, y);
        const line = hit instanceof Element ? hit.closest('.cm-line') : null;
        if (!line || !display.view.dom.contains(line)) return null;
        try {
            return display.view.posAtDOM(line, 0);
        } catch {
            return null;
        }
    }

    private editableKind(block: SlideBlock): string {
        switch (block.kind) {
            case 'heading':
                return 'heading';
            case 'para':
                return 'para';
            case 'list':
                return 'list';
            case 'quote':
                return 'quote';
            case 'image':
                return 'image';
            case 'code':
            case 'mermaid':
                return 'code';
            case 'table':
                return 'table';
            case 'math':
                return 'math';
            default:
                return 'para';
        }
    }

    /**
     * 片段行区间是否与任一快速卡片相交。
     *
     * 相交片段的源码来自掩码副本（卡片行是空行），任何按行整段回写都会
     * 把卡片内容抹掉。点击编辑（attachEdit）与显示态 widget 回写
     *（onDisplayChange → commitBlock）都必须走这一道检查。
     */
    private blockOverlapsQuickCards(block: SlideBlock): boolean {
        if (!this.fullText.includes('<<<')) return false;
        return parseQuickCards(this.fullText).some(
            (card) =>
                block.fromLine <= card.toLine && block.toLine >= card.fromLine
        );
    }

    /**
     * 把被编辑块的源码写回全文：只替换块占用的行区间，其他行原样保留。
     */
    private commitBlock(block: SlideBlock, newSource: string): void {
        const normalized = newSource.replace(/\r\n?/g, '\n');
        if (normalized === block.source) return;
        // 显示态 widget（复选框 / 表格加减行 / 媒体宽度）也会走到这里。
        // 与卡片相交的片段源码是掩码后的空行，整段替换会删掉卡片。
        if (this.blockOverlapsQuickCards(block)) {
            this.setStatus('该块与快速卡片相交，请在文本模式中编辑');
            return;
        }
        // 分页切出来的代码片段：只替换原代码块对应的源码行
        if (block.synthetic && block.kind === 'code') {
            this.commitSyntheticCode(block, normalized);
            return;
        }
        const lines = this.fullText.split('\n');
        // 片段源码在渲染时被去掉了公共缩进（否则嵌套列表会被当成代码块），
        // 回写时逐行补回，源码的层级才不会在编辑一次之后塌掉。
        const indent = block.indent ?? '';
        const replacement =
            normalized.length > 0
                ? normalized
                      .split('\n')
                      .map((line) => (line.length > 0 ? indent + line : line))
                : [];
        lines.splice(
            block.fromLine,
            block.toLine - block.fromLine + 1,
            ...replacement
        );
        this.fullText = lines.join('\n');
        this.options.onEdit(this.fullText);
        this.setStatus(`已回写 · 第 ${block.fromLine + 1} 行`);
        this.scheduleRebuild(block.fromLine);
    }

    /**
     * 提交分页代码片段的编辑。
     *
     * 片段源码 = 合成开始围栏 + 本页代码行 + 合成结束围栏；原文档里的
     * 围栏不会重复出现，所以剥掉首尾围栏、按 block.indent 补回缩进后，
     * 只 splice 到原代码块对应的行区间 [fromLine, toLine - 2]。
     * （fromLine 是片段第一行代码在原文档里的行号；toLine 多算了
     *   两个合成围栏行，减 2 才是本页最后一行代码。）
     */
    private commitSyntheticCode(block: SlideBlock, normalized: string): void {
        let edited = normalized.split('\n');
        const openFence = /^\s*(?:`{3,}|~{3,})/;
        const closeFence = /^\s*(?:`{3,}|~{3,})\s*$/;
        if (
            edited.length >= 2 &&
            openFence.test(edited[0] ?? '') &&
            closeFence.test(edited[edited.length - 1] ?? '')
        ) {
            edited = edited.slice(1, -1);
        }
        const indent = block.indent ?? '';
        const replacement = edited.map((line) =>
            line.length > 0 ? indent + line : line
        );
        const lines = this.fullText.split('\n');
        const start = block.fromLine;
        const end = Math.max(start, block.toLine - 2);
        lines.splice(start, end - start + 1, ...replacement);
        this.fullText = lines.join('\n');
        this.options.onEdit(this.fullText);
        this.setStatus(`已回写 · 第 ${block.fromLine + 1} 行`);
        this.scheduleRebuild(block.fromLine);
    }

    private scheduleRebuild(anchorLine: number | null): void {
        this.pendingAnchorLine = anchorLine;
        if (this.rebuildTimer !== null) window.clearTimeout(this.rebuildTimer);
        if (!this.active) {
            this.dirty = true;
            return;
        }
        this.rebuilding = true;
        this.rebuildTimer = window.setTimeout(() => {
            this.rebuildTimer = null;
            const anchor = this.pendingAnchorLine;
            this.pendingAnchorLine = null;
            void this.rebuild(anchor);
        }, 140);
    }

    // =================================================================
    // 导航
    // =================================================================

    private async flushEdit(): Promise<void> {
        if (!this.activeDisplay) return;
        const display = this.activeDisplay;
        this.activeDisplay = null;
        try {
            display.view.contentDOM.blur();
        } catch {
            /* 已销毁 */
        }
        await this.waitForRebuild();
    }

    private async waitForRebuild(): Promise<void> {
        for (let i = 0; i < 80; i += 1) {
            if (!this.rebuilding && this.rebuildTimer === null) return;
            await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
    }

    private async go(delta: number): Promise<void> {
        await this.goTo(this.pageIndex + delta);
    }

    private async goTo(index: number): Promise<void> {
        if (!this.active) return;
        await this.flushEdit();
        await this.waitForRebuild();
        const clamped = Math.max(
            0,
            Math.min(index, Math.max(0, this.pages.length - 1))
        );
        const target = this.pages[clamped];
        const logicalIndex = target?.logicalIndex ?? -1;

        // 目标页还没实测：先补测再定位。否则按默认高度切出来的页边界
        // 可能是错的（点「下一页」却看到半页内容）。
        if (logicalIndex >= 0) {
            const measured = await this.ensureSlideMeasured(logicalIndex);
            if (!this.active) return;
            if (measured) {
                const located = this.findPageIndex(
                    logicalIndex,
                    target?.segmentIndex,
                    target ? this.pageAnchorId(target) : undefined
                );
                this.pageIndex = located >= 0 ? located : clamped;
                this.renderPage();
                return;
            }
        }

        this.pageIndex = clamped;
        this.renderPage();
    }

    private async save(): Promise<void> {
        await this.flushEdit();
        this.options.onSave(this.fullText);
    }

    private onToolbarClick(event: MouseEvent): void {
        const target = event.target as HTMLElement;
        // 主题下拉的选项没有 data-action，先按 data-theme 处理。
        // 必须限定在浮层里：webview 的 body/root 上也挂着 data-theme
        // （明暗主题），不加作用域会让工具栏的每次点击都变成改主题。
        const themeOption = target.closest(
            '.slides-theme-popover:not(.slides-frame-popover) [data-theme]'
        ) as HTMLElement | null;
        if (themeOption) {
            const theme = themeOption.dataset.theme as
                | SlidesThemeSetting
                | undefined;
            if (theme) this.chooseTheme(theme);
            return;
        }
        // 边框装饰下拉：同样限定在浮层里，避免和页面上的 data-* 撞车
        const frameOption = target.closest(
            '.slides-frame-popover [data-frame]'
        ) as HTMLElement | null;
        if (frameOption) {
            const frame = frameOption.dataset.frame as
                | SlidesFrameSetting
                | undefined;
            if (frame) this.chooseFrame(frame);
            return;
        }
        const button = target.closest(
            'button[data-action]'
        ) as HTMLButtonElement | null;
        if (!button) return;
        const action = button.dataset.action;
        if (action === 'prev') void this.go(-1);
        else if (action === 'next') void this.go(1);
        else if (action === 'theme') this.toggleThemeMenu();
        else if (action === 'frame') this.toggleFrameMenu();
        else if (action === 'fullscreen') void this.toggleFullscreen();
        else if (action === 'rebuild') {
            this.rebuilding = true;
            void this.rebuild(null);
        }
    }

    // =================================================================
    // 主题下拉 / 全屏
    // =================================================================

    /** 展开或收起主题菜单（force 明确指定目标状态）。 */
    private toggleThemeMenu(force?: boolean): void {
        const open = force ?? this.themePopover.hidden;
        this.themePopover.hidden = !open;
        this.themeButton.setAttribute('aria-expanded', String(open));
        // 两个下拉同处一个 .slides-menu，同时展开会叠在一起
        if (open) {
            this.framePopover.hidden = true;
            this.frameButton.setAttribute('aria-expanded', 'false');
            this.updateThemeMenu();
        }
    }

    /** 展开或收起边框装饰菜单。 */
    private toggleFrameMenu(force?: boolean): void {
        const open = force ?? this.framePopover.hidden;
        this.framePopover.hidden = !open;
        this.frameButton.setAttribute('aria-expanded', String(open));
        if (open) {
            this.themePopover.hidden = true;
            this.themeButton.setAttribute('aria-expanded', 'false');
            this.updateFrameMenu();
        }
    }

    /** 点击菜单外面收起下拉。 */
    private onDocumentPointerDown(event: PointerEvent): void {
        if (this.themePopover.hidden && this.framePopover.hidden) return;
        const target = event.target as Element | null;
        if (target?.closest?.('.slides-menu')) return;
        this.toggleThemeMenu(false);
        this.toggleFrameMenu(false);
    }

    /** 把当前边框装饰在菜单里标成选中。 */
    private updateFrameMenu(): void {
        this.framePopover
            .querySelectorAll<HTMLElement>('[data-frame]')
            .forEach((option) => {
                const active = option.dataset.frame === this.settings.frame;
                option.classList.toggle('active', active);
                option.setAttribute('aria-checked', String(active));
            });
    }

    /** 选中一种页面装饰（只影响渲染，不改文档）。 */
    private chooseFrame(next: SlidesFrameSetting): void {
        this.toggleFrameMenu(false);
        if (this.settings.frame === next) return;
        this.settings.frame = next;
        settingsState.set('slidesFrame', next);
        this.options.onPersistSetting('slidesFrame', next);
        this.updateChrome();
        if (this.active) {
            // 装饰挂在页面的类名上，缓存页得重建才能换掉
            this.destroyRendered();
            this.renderPage();
        }
    }

    /** 把当前主题在菜单里标成选中。 */
    private updateThemeMenu(): void {
        this.themePopover
            .querySelectorAll<HTMLElement>('[data-theme]')
            .forEach((option) => {
                const active = option.dataset.theme === this.settings.theme;
                option.classList.toggle('active', active);
                option.setAttribute('aria-checked', String(active));
            });
    }

    /** 选中一个 deck 主题（按钮不再轮换，直接挑）。 */
    private chooseTheme(next: SlidesThemeSetting): void {
        this.toggleThemeMenu(false);
        if (this.settings.theme === next) return;
        this.settings.theme = next;
        settingsState.set('slidesTheme', next);
        this.options.onPersistSetting('slidesTheme', next);
        this.effectiveTheme = this.resolveDeckTheme();
        this.updateChrome();
        if (this.active) {
            // 和 setEditorTheme 同理：颜色类名与 mini-CM 主题都换一套
            this.destroyRendered();
            this.renderPage();
        }
    }

    /**
     * 全屏放映（物理屏幕）。
     *
     * 浏览器全屏的 API 是真正的物理全屏；VS Code 的 webview 是沙箱
     * iframe，没有 allowfullscreen 时会被拒。被拒就请扩展宿主执行
     * workbench.action.toggleFullScreen（等于按 F11），窗口铺满物理屏幕，
     * 同时画布自己也铺满 webview。
     */
    private async toggleFullscreen(): Promise<void> {
        if (this.presenting) {
            await this.exitPresenting();
            return;
        }
        const element = this.host as HTMLElement & {
            webkitRequestFullscreen?: () => Promise<void>;
        };
        const request =
            element.requestFullscreen?.bind(element) ??
            element.webkitRequestFullscreen?.bind(element);
        if (request) {
            try {
                await request();
                // 真正进了浏览器全屏：状态交给 fullscreenchange 统一处理
                return;
            } catch {
                /* 被沙箱策略拒绝（或没有用户手势），走窗口全屏兜底 */
            }
        }
        this.fallbackPresenting = true;
        this.applyPresenting(true);
        this.requestWindowFullscreen(true);
    }

    /** 让扩展宿主切 VS Code 窗口全屏（F11 同款，铺满物理屏幕）。 */
    private requestWindowFullscreen(on: boolean): void {
        if (this.windowFullscreenRequested === on) return;
        this.windowFullscreenRequested = on;
        this.options.onWindowFullscreen?.(on);
    }

    private async exitPresenting(): Promise<void> {
        // 窗口全屏是放映请求的，退出时无论走的哪条路径都要还回去；
        // 扩展侧自己记状态，重复发不会真的多 toggle 一次
        this.requestWindowFullscreen(false);
        if (this.fallbackPresenting) {
            this.fallbackPresenting = false;
            this.applyPresenting(false);
            return;
        }
        const doc = document as Document & {
            webkitExitFullscreen?: () => Promise<void>;
        };
        try {
            await (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
        } catch {
            /* 已经不在全屏 */
        }
        this.applyPresenting(false);
    }

    private onFullscreenChange(): void {
        if (document.fullscreenElement) {
            this.fallbackPresenting = false;
            this.applyPresenting(true);
        } else if (!this.fallbackPresenting) {
            this.applyPresenting(false);
            // 用户可能用浏览器自己的方式退出全屏，窗口全屏也一并收掉
            this.requestWindowFullscreen(false);
        }
    }

    /** 切换放映样式：铺满、隐藏页脚外的界面、重新适配画布尺寸。 */
    private applyPresenting(on: boolean): void {
        if (this.presenting === on) return;
        this.presenting = on;
        this.host.classList.toggle('slides-presenting', on);
        this.fullscreenButton.textContent = on ? '退出全屏' : '全屏';
        requestAnimationFrame(() => this.fitStage());
    }

    // =================================================================
    // 滚轮翻页
    // =================================================================

    /**
     * 滚轮翻页：手势一开始就翻。
     *
     * 旧做法要累计 60px 再翻，触控板手感是「滑完了才动」，而且第一个
     * 小增量会被吞。现在第一个有效滚轮事件就切页，随后同一次手势里的
     * 所有事件（触控板惯性 / 快速滚轮连发）都只 preventDefault，不翻页；
     * 200ms 内没有新的滚轮事件才解锁。编辑中的块不接管滚轮；横向滚动
     * 不翻页。
     */
    private onWheel(event: WheelEvent): void {
        if (!this.active || this.rebuilding) return;
        // 右侧快速卡片栏有自己的滚动（长卡片 / 固定卡片）：滚轮落在卡片上
        // 不翻页，否则卡片内容还没滚完就先换了下一页。
        const wheelTarget = event.target as Element | null;
        if (wheelTarget?.closest?.('.lwm-qcards')) return;
        // 触控板横向双指：让浏览器自己处理，不翻页
        if (Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.2) return;

        let delta = event.deltaY;
        // deltaMode：1 = 行，2 = 页；统一换算成像素
        if (event.deltaMode === 1) delta *= 16;
        else if (event.deltaMode === 2) delta *= 400;
        if (Math.abs(delta) < 1) return;

        // 吃掉滚动，避免外层 webview / 页面跟着动
        event.preventDefault();

        if (this.wheelFlipLocked) {
            // 同一次手势的后续事件：只续期，不再翻页
            this.armWheelUnlock();
            return;
        }
        this.wheelFlipLocked = true;
        this.armWheelUnlock();

        // 编辑中滚轮：先提交当前块（失焦提交 → 写回文档），再按原方向换页。
        // flushEdit 会等提交引发的重建结束，避免翻页时旧页面还在半边。
        if (this.activeDisplay) {
            const dir = delta > 0 ? 1 : -1;
            void this.flushEdit().then(() => {
                if (this.active && !this.activeDisplay) void this.go(dir);
            });
            return;
        }
        void this.go(delta > 0 ? 1 : -1);
    }

    /** 每次滚轮事件都把「手势结束」的计时往后推。 */
    private armWheelUnlock(): void {
        if (this.wheelUnlockTimer !== null) {
            window.clearTimeout(this.wheelUnlockTimer);
        }
        this.wheelUnlockTimer = window.setTimeout(() => {
            this.wheelUnlockTimer = null;
            this.wheelFlipLocked = false;
        }, 200);
    }

    private onKeyDown(event: KeyboardEvent): void {
        if (!this.active) return;

        // Esc 的第一优先级是收下拉菜单，其次是退出放映
        if (
            event.key === 'Escape' &&
            (!this.themePopover.hidden || !this.framePopover.hidden)
        ) {
            event.preventDefault();
            this.toggleThemeMenu(false);
            this.toggleFrameMenu(false);
            return;
        }
        if (event.key === 'Escape' && this.presenting) {
            event.preventDefault();
            void this.exitPresenting();
            return;
        }

        const isSave =
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === 's';
        if (isSave) {
            event.preventDefault();
            void this.save();
            return;
        }

        // F5：放映 / 退出放映（PowerPoint 同款，Esc 仍可退出）。
        // 编辑中先提交当前块，避免带着未落盘的编辑进入放映。
        if (event.key === 'F5') {
            event.preventDefault();
            void this.flushEdit().then(() => this.toggleFullscreen());
            return;
        }

        const target = event.target as HTMLElement | null;
        if (target?.closest?.('.cm-editor')) {
            if (event.key === 'Escape') {
                // CM 的 Esc 只提交、不 blur；下一帧主动失焦回到显示态
                window.setTimeout(() => {
                    (document.activeElement as HTMLElement | null)?.blur();
                }, 0);
            }
            return;
        }

        // 页面浏览态：Ctrl/Cmd+Z 撤销、Shift+Z / Y 重做。
        // 编辑中的目标在上面已返回，走 mini-CM 自己的历史（含 Ctrl+B/I/G）。
        if ((event.ctrlKey || event.metaKey) && !event.altKey) {
            const key = event.key.toLowerCase();
            if (key === 'z') {
                event.preventDefault();
                if (event.shiftKey) this.options.onRedo?.();
                else this.options.onUndo?.();
                return;
            }
            if (key === 'y' && !event.shiftKey) {
                event.preventDefault();
                this.options.onRedo?.();
                return;
            }
        }

        if (
            event.key === 'ArrowRight' ||
            event.key === 'PageDown' ||
            event.key === ' '
        ) {
            event.preventDefault();
            void this.go(1);
        } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
            event.preventDefault();
            void this.go(-1);
        } else if (event.key === 'Home') {
            event.preventDefault();
            void this.goTo(0);
        } else if (event.key === 'End') {
            event.preventDefault();
            void this.goTo(this.pages.length - 1);
        } else if (event.key === 't' || event.key === 'T') {
            this.cycleThemeSetting();
        }
    }

    /** 键盘 T：不打开菜单，直接按固定顺序轮换（给熟练用户留的快捷方式）。 */
    private cycleThemeSetting(): void {
        const next =
            THEME_ORDER[
                (THEME_ORDER.indexOf(this.settings.theme) + 1) %
                    THEME_ORDER.length
            ];
        this.chooseTheme(next);
    }

    // =================================================================
    // 工具栏 / 缩略图 / 缩放
    // =================================================================

    private updateChrome(): void {
        this.pageInfoEl.textContent = `${this.pageIndex + 1} / ${Math.max(1, this.pages.length)}`;
        this.layoutEl.textContent =
            this.pages[this.pageIndex]?.layout ?? '';
        this.themeButton.textContent =
            this.settings.theme === 'auto'
                ? `主题：自动（${DECK_LABEL[this.effectiveTheme]}）`
                : `主题：${THEME_LABEL[this.settings.theme]}`;
        this.themeButton.setAttribute(
            'aria-expanded',
            String(!this.themePopover.hidden)
        );
        this.frameButton.textContent = `边框：${FRAME_LABEL[this.settings.frame]}`;
        this.frameButton.setAttribute(
            'aria-expanded',
            String(!this.framePopover.hidden)
        );
        this.updateThemeMenu();
        this.updateFrameMenu();
    }

    private fitStage(): void {
        // 放映态不留给画布留白，让 16:9 尽量铺满
        const pad = this.presenting ? 0 : 28;
        const availW = Math.max(100, this.stageWrap.clientWidth - pad);
        const availH = Math.max(100, this.stageWrap.clientHeight - pad);
        const scale = Math.max(
            0.08,
            Math.min(availW / PAGE_W, availH / PAGE_H)
        );
        this.stage.style.transform = `scale(${scale})`;
        this.stageBox.style.width = `${PAGE_W * scale}px`;
        this.stageBox.style.height = `${PAGE_H * scale}px`;
    }

    private setStatus(text: string): void {
        this.statusEl.textContent = text;
        window.setTimeout(() => {
            if (this.statusEl.textContent === text) {
                this.statusEl.textContent = '';
            }
        }, 1600);
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
}
