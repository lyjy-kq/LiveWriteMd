/**
 * LiveWriteMD 鍙充晶澶х翰闈㈡澘鎺у埗鍣ㄣ€? *
 * 杩欎釜妯″潡璐熻矗鍦?Webview 閲屾覆鏌?Markdown 鏍囬鏍戯紝
 * 澶勭悊鎶樺彔灞曞紑銆佹爣棰樿烦杞€佸搴︽嫋鎷姐€佸簳閮ㄦ搷浣滄爮鍜屾偓娴彁绀恒€? */

/**
 * 澶х翰鑺傜偣鏁版嵁缁撴瀯銆? */
import {
    buildHeadingNumberingEdits,
    buildHeadingUnnumberEdits,
} from './headingNumbering.js';
import type { HeadingEdit } from './headingNumbering.js';
import { settingsState } from './settingsState.js';

interface OutlineNode {
    /** 鑺傜偣鍞竴鏍囪瘑锛岀敤浜庣ǔ瀹氫繚瀛樻姌鍙犵姸鎬併€?*/
    id: string;
    /** 鏍囬灞傜骇锛岃寖鍥翠负 1 鍒?6銆?*/
    level: number;
    /** 鏍囬鏂囨湰銆?*/
    text: string;
    /** 鏍囬鎵€鍦ㄨ鍙凤紝浠?1 寮€濮嬨€?*/
    line: number;
    /** 瀛愭爣棰樿妭鐐瑰垪琛ㄣ€?*/
    children: OutlineNode[];
}

/**
 * 鍙充晶澶х翰闈㈡澘鍒濆鍖栧弬鏁般€? */
export interface OutlinePanelOptions {
    /** 鍒濆瀹藉害锛屽崟浣嶅儚绱犮€?*/
    initialWidth: number;
    /** 瀹藉害鍙樺寲鍚庣殑鍥炶皟锛岀敤浜庢墿灞曠鎸佷箙鍖栥€?*/
    onWidthChange: (width: number) => void;
    /** 鐐瑰嚮鏍囬鍚庣殑璺宠浆鍥炶皟銆?*/
    onNavigateToLine: (lineNumber: number) => void;
    /** 判断编辑器当前是否可编辑：只读模式下编号/取消编号按钮不可用。 */
    isEditable: () => boolean;
    /**
     * 获取编辑器实时全文。
     *
     * 面板自己的内容缓存有 250ms 防抖，用户刚打完字就点按钮时可能是旧的，
     * 编号前一律以这里取到的实时文档为准。
     */
    getDocument: () => string;
    /** 把一批标题文本修改写回编辑器（具体怎么 dispatch 由 main.ts 决定）。 */
    onApplyHeadingEdits: (edits: HeadingEdit[]) => void;
}

/**
 * LiveWriteMD 鍙充晶澶х翰闈㈡澘鎺у埗鍣ㄣ€? */
export class OutlinePanel {
    /** 澶х翰澶栧眰瀹瑰櫒銆?*/
    private readonly panelEl: HTMLElement;

    /** 澶х翰鍐呭婊氬姩瀹瑰櫒銆?*/
    private readonly contentEl: HTMLElement;

    /** 鍙嫋鎷藉垎闅旀潯銆?*/
    private readonly resizerEl: HTMLElement;

    /** 搴曢儴鎿嶄綔鏍忋€?*/
    private readonly actionBarEl: HTMLElement;

    /** 鈥滃睍寮€鍏ㄩ儴鈥濇寜閽€?*/
    private readonly expandAllButtonEl: HTMLButtonElement;

    /** 鈥滄姌鍙犲叏閮ㄢ€濇寜閽€?*/
    private readonly collapseAllButtonEl: HTMLButtonElement;

    /** 「标题编号」按钮。 */
    private readonly addNumberingButtonEl: HTMLButtonElement;

    /** 「取消编号」按钮。 */
    private readonly removeNumberingButtonEl: HTMLButtonElement;

    /** 鎮诞鎻愮ず瀹瑰櫒銆?*/
    private readonly tooltipEl: HTMLDivElement;

    /** 瀹藉害鍙樺寲鍥炶皟銆?*/
    private readonly onWidthChange: (width: number) => void;

    /** 鏍囬璺宠浆鍥炶皟銆?*/
    private readonly onNavigateToLine: (lineNumber: number) => void;

    /** 编辑器是否可编辑（只读模式下编号按钮禁用）。 */
    private readonly isEditable: () => boolean;

    /** 取编辑器实时全文（编号前以实时文档为准，不用面板缓存）。 */
    private readonly getDocument: () => string;

    /** 把标题修改写回编辑器的回调。 */
    private readonly onApplyHeadingEdits: (edits: HeadingEdit[]) => void;

    /** 褰撳墠澶х翰瀹藉害銆?*/
    private width: number;

    /** 当前大纲是否可见。 */
    private outlineVisible = true;

    /** 大纲收起时右下角用于重新展开的浮动按钮。 */
    private readonly reopenButtonEl: HTMLButtonElement;

    /** 褰撳墠 Markdown 鏍囬鏍戙€?*/
    private nodes: OutlineNode[] = [];

    /** 褰撳墠婵€娲荤殑鏍囬鑺傜偣 ID銆?*/
    private activeNodeId: string | null = null;

    /** 鎶樺彔鑺傜偣 ID 闆嗗悎銆?*/
    private readonly collapsedNodeIds = new Set<string>();

    /** 褰撳墠楂樹寒琛屽彿銆?*/
    private activeLine = 1;

    /** 鏄惁姝ｅ湪鎷栨嫿鍒嗛殧鏉°€?*/
    private dragging = false;

    /** 鎷栨嫿璧峰 X 鍧愭爣銆?*/
    private dragStartX = 0;

    /** 鎷栨嫿璧峰瀹藉害銆?*/
    private dragStartWidth = 0;

    /** 鎮诞鎻愮ず瀹氭椂鍣ㄣ€?*/
    private hoverTimer: number | null = null;

    /** 褰撳墠鎮诞鐨勬爣棰樿銆?*/
    private hoveredRowEl: HTMLElement | null = null;

    /** 褰撳墠鎮诞鏍囬鐨勫畬鏁存枃鏈€?*/
    private hoveredTitle = '';

    /** 当前悬浮提示的鼠标 X 坐标。 */
    private hoveredClientX = 0;

    /** 当前悬浮提示的鼠标 Y 坐标。 */
    private hoveredClientY = 0;

    /** 鍏佽鐨勬渶灏忓搴︺€?*/
    /** 收起后右下角“展开大纲”浮动按钮的元素 ID。 */
    private static readonly REOPEN_BUTTON_ID = 'livewritemd-outline-reopen';

    /** 浮动按钮样式表的元素 ID，用于避免重复注入。 */
    private static readonly REOPEN_BUTTON_STYLE_ID = 'livewritemd-outline-reopen-style';

    private static readonly MIN_WIDTH = 220;

    /** 鍏佽鐨勬渶澶у搴︺€?*/
    private static readonly MAX_WIDTH = 520;

    /** 鎮诞鎻愮ず寤惰繜鏃堕棿銆?*/
    private static readonly TOOLTIP_DELAY_MS = 500;

    /** 涓€绾у埌鍏骇鏍囬鐨勯厤鑹叉睜锛岀敤浜庝弗鏍兼寜灞傜骇寰幆銆?*/
    private static readonly LEVEL_ACCENT_PALETTE = [
        'rgba(235, 131, 131, 0.5)',
        'rgba(174, 154, 203, 0.5)',
        'rgba(125, 181, 205, 0.5)',
        'rgba(113, 167, 150, 0.5)',
        'rgba(220, 191, 97, 0.5)',
        'rgba(221, 163, 106, 0.5)',
    ];

    /**
     * 鍒涘缓鍙充晶澶х翰闈㈡澘鎺у埗鍣ㄣ€?     *
     * @param panelEl - 澶х翰澶栧眰瀹瑰櫒
     * @param contentEl - 澶х翰鍐呭婊氬姩瀹瑰櫒
     * @param resizerEl - 鍙嫋鎷藉垎闅旀潯
     * @param options - 闈㈡澘閰嶇疆椤?     * @returns void
     */
    constructor(
        panelEl: HTMLElement,
        contentEl: HTMLElement,
        resizerEl: HTMLElement,
        options: OutlinePanelOptions
    ) {
        this.panelEl = panelEl;
        this.contentEl = contentEl;
        this.resizerEl = resizerEl;
        this.onWidthChange = options.onWidthChange;
        this.onNavigateToLine = options.onNavigateToLine;
        this.isEditable = options.isEditable;
        this.getDocument = options.getDocument;
        this.onApplyHeadingEdits = options.onApplyHeadingEdits;
        this.width = this.clampWidth(options.initialWidth);

        this.actionBarEl = this.resolveActionBarElement();
        this.expandAllButtonEl = this.resolveActionButton('expand-all', '\u5c55\u5f00\u5168\u90e8');
        this.collapseAllButtonEl = this.resolveActionButton('collapse-all', '\u6536\u8d77\u5168\u90e8');
        // 关闭按钮固定放在操作栏最右侧，用户不用再翻右键菜单才能收起大纲。
        this.addNumberingButtonEl = this.resolveActionButton('add-numbering', '标题编号');
        this.removeNumberingButtonEl = this.resolveActionButton('remove-numbering', '取消编号');
        this.resolveActionButton('close-outline', '关闭大纲');
        this.reopenButtonEl = this.resolveReopenButton();
        this.tooltipEl = this.resolveTooltipElement();

        this.applyWidth(this.width);
        this.bindEvents();
        this.updateActionBarState();
    }

    /**
     * 闄愬埗瀹藉害鍒板厑璁稿尯闂淬€?     *
     * @param width - 鍘熷瀹藉害
     * @returns 褰掍竴鍖栧悗鐨勫搴?     */
    private clampWidth(width: number): number {
        if (!Number.isFinite(width)) {
            return OutlinePanel.MIN_WIDTH;
        }
        return Math.min(OutlinePanel.MAX_WIDTH, Math.max(OutlinePanel.MIN_WIDTH, Math.round(width)));
    }

    /**
     * 灏嗗搴﹀悓姝ュ埌 CSS 鍙橀噺鍜岄潰鏉挎牱寮忋€?     *
     * @param width - 鐩爣瀹藉害
     * @returns void
     */
    private applyWidth(width: number): void {
        this.width = this.clampWidth(width);
        document.documentElement.style.setProperty('--livewritemd-outline-width', `${this.width}px`);
        this.panelEl.style.width = `${this.width}px`;
        this.panelEl.style.flexBasis = `${this.width}px`;
    }

    /**
     * 缁戝畾鎷栨嫿銆佹姌鍙犮€佸睍寮€銆佽烦杞拰鎮诞鎻愮ず鐩稿叧浜嬩欢銆?     *
     * @returns void
     */
    private bindEvents(): void {
        this.resizerEl.addEventListener('pointerdown', this.handleResizerPointerDown);
        this.contentEl.addEventListener('click', this.handleContentClick);
        this.contentEl.addEventListener('keydown', this.handleContentKeyDown);
        this.contentEl.addEventListener('pointerover', this.handleContentPointerOver);
        this.contentEl.addEventListener('pointerout', this.handleContentPointerOut);
        this.contentEl.addEventListener('scroll', this.handleContentScroll, { passive: true });
        this.actionBarEl.addEventListener('click', this.handleActionBarClick);
    }

    /**
     * 澶勭悊鍒嗛殧鏉℃寜涓嬩簨浠跺苟鍚姩鎷栨嫿銆?     *
     * @param event - 鎸囬拡鎸変笅浜嬩欢
     * @returns void
     */
    private readonly handleResizerPointerDown = (event: PointerEvent): void => {
        if (event.button !== 0) {
            return;
        }

        event.preventDefault();
        this.dragging = true;
        this.dragStartX = event.clientX;
        this.dragStartWidth = this.width;
        this.resizerEl.dataset.dragging = 'true';
        document.body.classList.add('livewritemd-outline-resizing');

        const onMove = (moveEvent: PointerEvent): void => {
            if (!this.dragging) {
                return;
            }

            const delta = moveEvent.clientX - this.dragStartX;
            // 右侧面板宽度越大，分割线越靠左，所以拖拽方向需要反向计算。
            this.applyWidth(this.dragStartWidth - delta);
        };

        const onUp = (upEvent: PointerEvent): void => {
            if (!this.dragging) {
                return;
            }

            this.dragging = false;
            this.resizerEl.dataset.dragging = 'false';
            document.body.classList.remove('livewritemd-outline-resizing');
            this.resizerEl.releasePointerCapture(upEvent.pointerId);
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            this.onWidthChange(this.width);
        };

        this.resizerEl.setPointerCapture(event.pointerId);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    };

    /**
     * 澶勭悊鍐呭鍖虹偣鍑讳簨浠讹紝鏀寔璺宠浆涓庤妭鐐规姌鍙犮€?     *
     * @param event - 榧犳爣鐐瑰嚮浜嬩欢
     * @returns void
     */
    private readonly handleContentClick = (event: MouseEvent): void => {
        const target = event.target as HTMLElement | null;
        if (!target) {
            return;
        }

        const toggleEl = target.closest<HTMLElement>('[data-outline-action="toggle"]');
        if (toggleEl) {
            event.preventDefault();
            event.stopPropagation();
            const nodeId = toggleEl.getAttribute('data-node-id');
            if (nodeId) {
                if (this.collapsedNodeIds.has(nodeId)) {
                    this.collapsedNodeIds.delete(nodeId);
                } else {
                    this.collapsedNodeIds.add(nodeId);
                }
                this.render();
            }
            return;
        }

        const rowEl = target.closest<HTMLElement>('[data-outline-action="jump"]');
        if (!rowEl) {
            return;
        }

        const lineValue = rowEl.getAttribute('data-line');
        const lineNumber = Number.parseInt(lineValue ?? '', 10);
        if (Number.isFinite(lineNumber)) {
            this.onNavigateToLine(lineNumber);
        }
    };

    /**
     * 澶勭悊鍐呭鍖洪敭鐩樹簨浠讹紝鏀寔鍥炶溅鍜岀┖鏍艰烦杞€?     *
     * @param event - 閿洏浜嬩欢
     * @returns void
     */
    private readonly handleContentKeyDown = (event: KeyboardEvent): void => {
        const target = event.target as HTMLElement | null;
        if (!target) {
            return;
        }

        const rowEl = target.closest<HTMLElement>('[data-outline-action="jump"]');
        if (!rowEl) {
            return;
        }

        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }

        event.preventDefault();
        const lineValue = rowEl.getAttribute('data-line');
        const lineNumber = Number.parseInt(lineValue ?? '', 10);
        if (Number.isFinite(lineNumber)) {
            this.onNavigateToLine(lineNumber);
        }
    };

    /**
     * 澶勭悊鍐呭鍖烘偓娴繘鍏ヤ簨浠跺苟鍚姩 1 绉掓彁绀哄欢杩熴€?     *
     * @param event - 鎸囬拡鎮诞浜嬩欢
     * @returns void
     */
    private readonly handleContentPointerOver = (event: PointerEvent): void => {
        const target = event.target as HTMLElement | null;
        if (!target) {
            return;
        }

        const rowEl = target.closest<HTMLElement>('[data-outline-action="jump"]');
        if (!rowEl || rowEl === this.hoveredRowEl) {
            return;
        }

        this.hoveredClientX = event.clientX;
        this.hoveredClientY = event.clientY;
        this.scheduleTooltip(rowEl, event.clientX, event.clientY);
    };

    /**
     * 澶勭悊鍐呭鍖烘偓娴寮€浜嬩欢锛岀寮€鍚庣珛鍗抽殣钘忔彁绀恒€?     *
     * @param event - 鎸囬拡绂诲紑浜嬩欢
     * @returns void
     */
    private readonly handleContentPointerOut = (event: PointerEvent): void => {
        const target = event.target as HTMLElement | null;
        if (!target) {
            return;
        }

        const rowEl = target.closest<HTMLElement>('[data-outline-action="jump"]');
        const relatedTarget = event.relatedTarget as Node | null;
        if (rowEl && relatedTarget && rowEl.contains(relatedTarget)) {
            return;
        }

        if (rowEl && rowEl === this.hoveredRowEl) {
            this.hideTooltip();
        }
    };

    /**
     * 澶勭悊鍐呭鍖烘粴鍔ㄤ簨浠讹紝閬垮厤鎻愮ず璺熺潃鏃т綅缃仠鐣欍€?     *
     * @returns void
     */
    private readonly handleContentScroll = (): void => {
        if (this.hoveredRowEl) {
            this.hideTooltip();
        }
    };

    /**
     * 澶勭悊搴曢儴鎿嶄綔鏍忕偣鍑讳簨浠躲€?     *
     * @param event - 榧犳爣鐐瑰嚮浜嬩欢
     * @returns void
     */
    private readonly handleActionBarClick = (event: MouseEvent): void => {
        const target = event.target as HTMLElement | null;
        if (!target) {
            return;
        }

        const actionButton = target.closest<HTMLButtonElement>('[data-outline-action]');
        if (!actionButton) {
            return;
        }

        const action = actionButton.getAttribute('data-outline-action');

        // 标题编号 / 取消编号：取编辑器实时全文算修改，再交 main.ts 写回。
        // 必须用实时文档：面板缓存有 250ms 防抖，用户刚打完字就点会错位。
        if (action === 'add-numbering' || action === 'remove-numbering') {
            // 按钮 disabled 之外再兜底一次：只读模式直接不处理
            if (!this.isEditable()) return;
            const doc = this.getDocument();
            const edits =
                action === 'add-numbering'
                    ? buildHeadingNumberingEdits(doc)
                    : buildHeadingUnnumberEdits(doc);
            if (edits.length > 0) {
                this.onApplyHeadingEdits(edits);
            }
            return;
        }
        if (action === 'expand-all') {
            this.expandAll();
        } else if (action === 'collapse-all') {
            this.collapseAll();
        } else if (action === 'close-outline') {
            // 收起大纲面板，重新打开可以走编辑器标题栏按钮或正文右键菜单。
            this.setVisible(false);
        }
    };

    /**
     * 璁剧疆鏈€鏂扮殑 Markdown 鍐呭锛屽苟瑙﹀彂澶х翰鍒锋柊銆?     *
     * @param content - 褰撳墠 Markdown 鏂囨湰
     * @param activeLine - 鍙€夌殑楂樹寒琛屽彿
     * @returns void
     */
    public setContent(content: string, activeLine?: number): void {
        if (Number.isFinite(activeLine ?? NaN)) {
            this.activeLine = Math.floor(activeLine as number);
        }

        this.nodes = this.parseHeadings(content);
        this.render();
    }

    /**
     * 鍏煎鏃у懡鍚嶇殑鍐呭鏇存柊鏂规硶銆?     *
     * @param content - 褰撳墠 Markdown 鏂囨湰
     * @param activeLine - 鍙€夌殑楂樹寒琛屽彿
     * @returns void
     */
    public updateContent(content: string, activeLine?: number): void {
        this.setContent(content, activeLine);
    }

    /**
     * 鐩存帴璁剧疆澶х翰瀹藉害銆?     *
     * @param width - 鏂板搴︼紝鍗曚綅鍍忕礌
     * @returns void
     */
    public setWidth(width: number): void {
        this.applyWidth(width);
    }

    /**
     * 设置大纲面板的显示状态。
     *
     * @param visible - 是否显示大纲面板
     * @returns void
     */
    public setVisible(visible: boolean): void {
        const nextVisible = Boolean(visible);
        if (this.outlineVisible === nextVisible) {
            return;
        }

        this.outlineVisible = nextVisible;
        // 收起时把重新展开的入口留在右下角，展开时再把它藏起来。
        this.reopenButtonEl.hidden = nextVisible;

        if (nextVisible) {
            this.panelEl.hidden = false;
            this.panelEl.style.display = '';
            this.panelEl.style.visibility = '';
            this.panelEl.style.width = '';
            this.panelEl.style.flexBasis = '';
            this.panelEl.setAttribute('aria-hidden', 'false');

            this.resizerEl.hidden = false;
            this.resizerEl.style.display = '';
            this.resizerEl.style.visibility = '';
            this.resizerEl.setAttribute('aria-hidden', 'false');

            this.applyWidth(this.width);
            return;
        }

        this.panelEl.hidden = true;
        this.panelEl.setAttribute('aria-hidden', 'true');
        this.panelEl.style.display = 'none';
        this.panelEl.style.visibility = 'hidden';
        this.panelEl.style.width = '0';
        this.panelEl.style.flexBasis = '0';

        this.resizerEl.hidden = true;
        this.resizerEl.setAttribute('aria-hidden', 'true');
        this.resizerEl.style.display = 'none';
        this.resizerEl.style.visibility = 'hidden';
    }

    /**
     * 反转大纲面板的显示状态。
     *
     * @returns void
     */
    public toggleVisible(): void {
        this.setVisible(!this.outlineVisible);
    }

    /**
     * 璁剧疆褰撳墠楂樹寒琛屻€?     *
     * @param lineNumber - 褰撳墠琛屽彿
     * @returns void
     */
    public setActiveLine(lineNumber: number): void {
        if (!Number.isFinite(lineNumber) || lineNumber < 1) {
            return;
        }

        this.activeLine = Math.floor(lineNumber);
        this.syncActiveState();
    }

    /**
     * 鑾峰彇褰撳墠澶х翰瀹藉害銆?     *
     * @returns 褰撳墠瀹藉害锛屽崟浣嶅儚绱?     */
    public getWidth(): number {
        return this.width;
    }

    /**
     * 获取当前大纲是否可见。
     *
     * @returns 当前可见状态
     */
    public isOutlineVisible(): boolean {
        return this.outlineVisible;
    }

    /**
     * 灞曞紑鎵€鏈夋爣棰樿妭鐐广€?     *
     * @returns void
     */
    public expandAll(): void {
        if (this.collapsedNodeIds.size === 0) {
            return;
        }

        this.collapsedNodeIds.clear();
        this.render();
    }

    /**
     * 鎶樺彔鎵€鏈夋嫢鏈夊瓙鑺傜偣鐨勬爣棰樸€?     *
     * @returns void
     */
    public collapseAll(): void {
        const nextCollapsedIds = new Set<string>();
        const collect = (items: OutlineNode[]): void => {
            for (const node of items) {
                if (node.children.length > 0) {
                    nextCollapsedIds.add(node.id);
                    collect(node.children);
                }
            }
        };

        collect(this.nodes);
        this.collapsedNodeIds.clear();
        for (const nodeId of nextCollapsedIds) {
            this.collapsedNodeIds.add(nodeId);
        }
        this.render();
    }

    /**
     * 瑙ｆ瀽 Markdown 鏍囬骞舵瀯寤烘爲褰㈢粨鏋勩€?     *
     * @param content - Markdown 婧愭枃鏈?     * @returns 鏍戝舰鏍囬鑺傜偣
     */
    private parseHeadings(content: string): OutlineNode[] {
        const lines = content.split(/\r?\n/);
        const rootNodes: OutlineNode[] = [];
        const stack: OutlineNode[] = [];
        const siblingCounts = new Map<string, number>();
        let inFence = false;
        let fenceMarker = '';
        let fenceLength = 0;

        for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
            const currentLine = lines[lineNumber];
            const fenceMatch = currentLine.match(/^\s{0,3}(```+|~~~+)/);
            if (fenceMatch) {
                const marker = fenceMatch[1][0];
                const length = fenceMatch[1].length;
                if (!inFence) {
                    inFence = true;
                    fenceMarker = marker;
                    fenceLength = length;
                } else if (marker === fenceMarker && length >= fenceLength) {
                    inFence = false;
                    fenceMarker = '';
                    fenceLength = 0;
                }
                continue;
            }

            if (inFence) {
                continue;
            }

            const atxMatch = currentLine.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
            if (atxMatch) {
                this.pushHeadingNode(
                    rootNodes,
                    stack,
                    siblingCounts,
                    atxMatch[1].length,
                    this.normalizeHeadingText(atxMatch[2]),
                    lineNumber + 1
                );
                continue;
            }

            const nextLine = lines[lineNumber + 1];
            const setextLevel =
                nextLine && /^\s*=+\s*$/.test(nextLine)
                    ? 1
                    : nextLine && /^\s*-+\s*$/.test(nextLine)
                      ? 2
                      : 0;
            if (setextLevel > 0) {
                const text = this.normalizeHeadingText(currentLine);
                if (text) {
                    this.pushHeadingNode(rootNodes, stack, siblingCounts, setextLevel, text, lineNumber + 1);
                }
                lineNumber += 1;
            }
        }

        return rootNodes;
    }

    /**
     * 灏嗗崟涓爣棰樿妭鐐瑰姞鍏ユ爲缁撴瀯銆?     *
     * @param rootNodes - 鏍硅妭鐐瑰垪琛?     * @param stack - 褰撳墠瑙ｆ瀽鏍?     * @param siblingCounts - 鍚屽眰绾ц鏁板櫒
     * @param level - 鏍囬灞傜骇
     * @param text - 鏍囬鏂囨湰
     * @param line - 鏍囬鎵€鍦ㄨ鍙?     * @returns void
     */
    private pushHeadingNode(
        rootNodes: OutlineNode[],
        stack: OutlineNode[],
        siblingCounts: Map<string, number>,
        level: number,
        text: string,
        line: number
    ): void {
        if (!text) {
            return;
        }

        while (stack.length > 0 && stack[stack.length - 1].level >= level) {
            stack.pop();
        }

        const parentPath = stack.map((node) => node.id).join('/');
        const siblingKey = `${parentPath}|${level}`;
        const siblingIndex = (siblingCounts.get(siblingKey) ?? 0) + 1;
        siblingCounts.set(siblingKey, siblingIndex);

        const node: OutlineNode = {
            id: `${siblingKey}|${siblingIndex}|${line}`,
            level,
            text,
            line,
            children: [],
        };

        if (stack.length === 0) {
            rootNodes.push(node);
        } else {
            stack[stack.length - 1].children.push(node);
        }

        stack.push(node);
    }

    /**
     * 清理标题文本，去掉尾部标记、内联 HTML 标签和多余空白。
     *
     * @param text - 原始标题文本。
     * @returns 清理后的标题文本。
     */
    private normalizeHeadingText(text: string): string {
        return text
            .replace(/<\/?[a-zA-Z][^>]*>/g, '')
            .replace(/\s+#+\s*$/, '')
            .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
            .replace(/[`*_~]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * 娓叉煋澶х翰瑙嗗浘銆?     *
     * @returns void
     */
    private render(): void {
        const previousScrollTop = this.contentEl.scrollTop;
        const previousScrollLeft = this.contentEl.scrollLeft;
        this.hideTooltip();
        this.activeNodeId = this.findActiveNodeId(this.nodes, this.activeLine);

        if (this.nodes.length === 0) {
            // 空状态提示：旧文案是被错误转码的乱码，这里换回正常中文。
            this.contentEl.innerHTML =
                '<div class="outline-empty">标题大纲</div>';
            this.panelEl.classList.add('is-empty');
            this.updateActionBarState();
            this.restoreScrollPosition(previousScrollTop, previousScrollLeft);
            return;
        }

        this.panelEl.classList.remove('is-empty');
        const activeNodeId = this.findActiveNodeId(this.nodes, this.activeLine);
        const html = this.renderNodes(this.nodes, activeNodeId);
        this.contentEl.innerHTML = `<div class="outline-tree" role="tree">${html}</div>`;
        this.updateActionBarState();
        this.restoreScrollPosition(previousScrollTop, previousScrollLeft);
    }

    /**
     * 閫掑綊娓叉煋鏍囬鑺傜偣銆?     *
     * @param nodes - 褰撳墠灞傜骇鑺傜偣
     * @param activeNodeId - 褰撳墠楂樹寒鑺傜偣 ID
     * @returns HTML 瀛楃涓?     */
    private renderNodes(nodes: OutlineNode[], activeNodeId: string | null): string {
        return nodes
            .map((node) => {
                const accentIndex = (node.level - 1) % OutlinePanel.LEVEL_ACCENT_PALETTE.length;
                const accent = OutlinePanel.LEVEL_ACCENT_PALETTE[accentIndex];
                const isCollapsed = this.collapsedNodeIds.has(node.id);
                const hasChildren = node.children.length > 0;
                const isActive = node.id === activeNodeId;
                const toggleIcon = hasChildren ? this.buildToggleIcon(isCollapsed) : '';
                const indentGuides = this.buildIndentGuides(node.level);
                const childrenHtml =
                    hasChildren && !isCollapsed
                        ? `<div class="outline-children">${this.renderNodes(
                              node.children,
                              activeNodeId
                          )}</div>`
                        : '';

                return `
                    <div
                        class="outline-item"
                        data-node-id="${this.escapeHtml(node.id)}"
                        data-level="${node.level}"
                        style="--outline-accent: ${accent}; --outline-indent: ${(Math.max(0, node.level - 1) * 8)}px;"
                    >
                        <div
                            class="outline-row"
                            data-outline-action="jump"
                            data-level="${node.level}"
                            data-line="${node.line}"
                            data-outline-title="${this.escapeHtml(node.text)}"
                            data-active="${isActive ? 'true' : 'false'}"
                            role="button"
                            tabindex="0"
                            aria-label="跳转到第 ${node.line} 行：${this.escapeHtml(node.text)}"
                        >
                            <span
                                class="outline-toggle${hasChildren ? '' : ' outline-toggle-spacer'}"
                                data-outline-action="toggle"
                                data-node-id="${node.id}"
                                data-collapsed="${isCollapsed ? 'true' : 'false'}"
                                aria-hidden="true"
                            >${toggleIcon}</span>
                            ${indentGuides}
                            <span class="outline-label">${this.escapeHtml(node.text)}</span>
                            <span class="outline-meta">${node.line}</span>
                        </div>
                        ${childrenHtml}
                    </div>
                `;
            })
            .join('');
    }

    /**
     * 鏌ユ壘褰撳墠楂樹寒琛屽搴旂殑鏈€杩戞爣棰樿妭鐐广€?     *
     * @param nodes - 鏍囬鑺傜偣鍒楄〃
     * @param lineNumber - 褰撳墠琛屽彿
     * @returns 鑺傜偣 ID锛屾病鏈夊垯杩斿洖 null
     */
    private findActiveNodeId(nodes: OutlineNode[], lineNumber: number): string | null {
        let lastMatch: OutlineNode | null = null;

        const walk = (items: OutlineNode[]): void => {
            for (const node of items) {
                if (node.line <= lineNumber) {
                    lastMatch = node;
                }
                if (node.children.length > 0 && node.line <= lineNumber) {
                    walk(node.children);
                }
            }
        };

        walk(nodes);
        return lastMatch?.id ?? null;
    }
    /**
     * 同步当前激活行对应的大纲高亮状态。
     *
     * @returns void
     */
    private syncActiveState(): void {
        const nextActiveNodeId = this.findActiveNodeId(this.nodes, this.activeLine);
        if (this.activeNodeId === nextActiveNodeId) {
            return;
        }

        if (this.activeNodeId) {
            const previous = this.contentEl.querySelector<HTMLElement>(
                `[data-node-id="${CSS.escape(this.activeNodeId)}"] > .outline-row`
            );
            previous?.setAttribute('data-active', 'false');
        }

        this.activeNodeId = nextActiveNodeId;
        if (!this.activeNodeId) {
            return;
        }

        const current = this.contentEl.querySelector<HTMLElement>(
            `[data-node-id="${CSS.escape(this.activeNodeId)}"] > .outline-row`
        );
        current?.setAttribute('data-active', 'true');
        current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    /**
     * 生成折叠与展开图标。
     *
     * @param collapsed - 是否处于折叠状态
     * @returns SVG 图标字符串
     */
    private buildToggleIcon(collapsed: boolean): string {
        const rotate = collapsed ? '0deg' : '90deg';
        return `
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" style="transform: rotate(${rotate}); transform-origin: 50% 50%;">
                <path d="M5.5 3.5L10 8l-4.5 4.5-.7-.7L8.6 8 4.8 4.2z"></path>
            </svg>
        `;
    }

    /**
     * 生成缩进引导线，用于表现树状层级结构。
     *
     * @param level - 标题层级
     * @returns HTML 字符串
     */
    private buildIndentGuides(level: number): string {
        // 设置项 outlineGuides 关闭时不渲染缩进引导线
        if (!settingsState.getBoolean('outlineGuides')) return '';
        const guideCount = Math.max(0, level - 1);
        if (guideCount === 0) {
            return '';
        }

        return `
            <span class="outline-guides" aria-hidden="true">
                ${Array.from({ length: guideCount }, (_, index) => {
                    const isLast = index === guideCount - 1;
                    return `<span class="outline-guide${isLast ? ' is-last' : ''}"></span>`;
                }).join('')}
            </span>
        `;
    }

    /**
     * 瑙ｆ瀽鎴栧垱寤哄簳閮ㄦ搷浣滄爮瀹瑰櫒銆?     *
     * @returns 搴曢儴鎿嶄綔鏍忓厓绱?     */
    private resolveActionBarElement(): HTMLElement {
        const existing = this.panelEl.querySelector<HTMLElement>('#outline-actions');
        if (existing) {
            return existing;
        }

        const actionBar = document.createElement('div');
        actionBar.id = 'outline-actions';
        actionBar.className = 'outline-actions';
        this.panelEl.appendChild(actionBar);
        return actionBar;
    }

    /**
     * 瑙ｆ瀽鎴栧垱寤烘搷浣滄寜閽€?     *
     * @param action - 鎸夐挳鍔ㄤ綔鏍囪瘑
     * @param label - 鎸夐挳鏂囨湰
     * @returns 鎿嶄綔鎸夐挳鍏冪礌
     */
    private resolveActionButton(action: string, label: string): HTMLButtonElement {
        const existing = this.panelEl.querySelector<HTMLButtonElement>(`button[data-outline-action="${action}"]`);
        if (existing) {
            return existing;
        }

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'outline-action-btn';
        button.setAttribute('data-outline-action', action);
        button.setAttribute('aria-label', label);
        button.setAttribute('title', label);
        button.innerHTML = `<span class="outline-action-icon" aria-hidden="true">${this.buildActionGlyph(action)}</span>`;
        this.actionBarEl.appendChild(button);
        return button;
    }

    /**
     * 解析或创建大纲收起后右下角的“展开大纲”浮动按钮。
     *
     * 按钮固定挂在 body 上而不是面板内部，因为面板收起时整体 display:none，
     * 挂在里面就跟着一起消失了。
     *
     * @returns 浮动按钮元素
     */
    private resolveReopenButton(): HTMLButtonElement {
        this.ensureReopenButtonStyles();

        const existing = document.getElementById(OutlinePanel.REOPEN_BUTTON_ID);
        if (existing instanceof HTMLButtonElement) {
            return existing;
        }

        const button = document.createElement('button');
        button.type = 'button';
        button.id = OutlinePanel.REOPEN_BUTTON_ID;
        button.className = 'outline-reopen-btn';
        button.title = '展开大纲';
        button.setAttribute('aria-label', '展开大纲');
        // 默认大纲是展开的，所以初始状态先藏起来，由 setVisible 接管。
        button.hidden = true;
        button.innerHTML = `
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M1.8 3h1.7v1.7H1.8zM5.3 3.25h8.9v1.2H5.3zM1.8 7.15h1.7v1.7H1.8zM5.3 7.4h8.9v1.2H5.3zM1.8 11.3h1.7v1.7H1.8zM5.3 11.55h8.9v1.2H5.3z"></path>
            </svg>
        `;
        button.addEventListener('click', () => this.setVisible(true));

        document.body.appendChild(button);
        return button;
    }

    /**
     * 注入“展开大纲”浮动按钮的样式。
     *
     * 样式放在这个模块里而不是 webviewContent 的内联 CSS 里，是为了让它和创建按钮的
     * 代码始终在同一个 bundle 中。两处分属扩展进程和 webview 脚本，一旦扩展宿主没
     * 重启而 webview 脚本更新了，就会出现“按钮建出来了但没有定位样式”的情况——
     * 按钮会被 body 的 overflow:hidden 挤到视口外，看起来像功能没生效。
     *
     * @returns void
     */
    private ensureReopenButtonStyles(): void {
        if (document.getElementById(OutlinePanel.REOPEN_BUTTON_STYLE_ID)) {
            return;
        }

        const style = document.createElement('style');
        style.id = OutlinePanel.REOPEN_BUTTON_STYLE_ID;
        style.textContent = `
.outline-reopen-btn {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 100;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 1px solid rgba(127, 127, 127, 0.28);
    border-radius: 6px;
    background: var(--vscode-editor-background, #272b33);
    color: var(--vscode-editor-foreground, #d4d4d4);
    cursor: pointer;
    opacity: 0.5;
    transition: opacity 0.15s ease, background-color 0.15s ease;
}

.outline-reopen-btn[hidden] {
    display: none !important;
}

.outline-reopen-btn:hover {
    opacity: 1;
    background: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.16));
}

.outline-reopen-btn:focus-visible {
    opacity: 1;
    outline: 1px solid var(--vscode-focusBorder, #007acc);
    outline-offset: 1px;
}

.outline-reopen-btn svg {
    width: 16px;
    height: 16px;
    fill: currentColor;
    display: block;
    pointer-events: none;
}
        `;
        document.head.appendChild(style);
    }

    /**
     * 生成底部操作按钮所使用的 SVG 图标。
     *
     * @param action - 按钮动作标识
     * @returns 可直接显示的 SVG 图标字符串
     */
    private buildActionGlyph(action: string): string {
        // 标题编号 / 取消编号：画成「编号列表」的样子（1/2/3 + 三条横线），
        // 取消编号再压一道斜杠，两个按钮互相对应、也好和加减号区分。
        if (action === 'add-numbering' || action === 'remove-numbering') {
            const slash =
                action === 'remove-numbering'
                    ? '<path d="M2.2 14L13.8 2" stroke-width="1.5"></path>'
                    : '';
            return `
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
                        <path d="M6 4h7.5M6 8h7.5M6 12h7.5"></path>
                        ${slash}
                    </g>
                    <g fill="currentColor" font-family="var(--vscode-editor-font-family, monospace)" font-size="4.6">
                        <text x="1.1" y="5.7">1</text>
                        <text x="1.1" y="9.7">2</text>
                        <text x="1.1" y="13.7">3</text>
                    </g>
                </svg>
            `;
        }

        // 关闭按钮用叉号，展开/收起用加减号，保证三个按钮一眼可区分。
        const glyphPaths: Record<string, string> = {
            'collapse-all': 'M3.5 8h9',
            'expand-all': 'M3.5 8h9M8 3.5v9',
            'close-outline': 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6',
        };
        const path = glyphPaths[action] ?? glyphPaths['expand-all'];
        return `
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="${path}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>
            </svg>
        `;
    }

    /**
     * 瑙ｆ瀽鎴栧垱寤?tooltip 瀹瑰櫒銆?     *
     * @returns tooltip 鍏冪礌
     */
    private resolveTooltipElement(): HTMLDivElement {
        const existing = this.panelEl.querySelector<HTMLDivElement>('#outline-tooltip');
        if (existing) {
            return existing;
        }

        const tooltip = document.createElement('div');
        tooltip.id = 'outline-tooltip';
        tooltip.className = 'outline-tooltip';
        tooltip.setAttribute('role', 'tooltip');
        tooltip.setAttribute('aria-hidden', 'true');
        this.panelEl.appendChild(tooltip);
        return tooltip;
    }

    /**
     * 璁″垝鏄剧ず鎮诞鎻愮ず銆?     *
     * @param rowEl - 闇€瑕佹樉绀烘彁绀虹殑琛屽厓绱?     * @returns void
     */
    private scheduleTooltip(rowEl: HTMLElement, clientX: number, clientY: number): void {
        const title = rowEl.getAttribute('data-outline-title')?.trim() ?? '';
        if (!title) {
            return;
        }

        this.cancelTooltipTimer();
        this.hoveredRowEl = rowEl;
        this.hoveredTitle = title;
        this.hoveredClientX = clientX;
        this.hoveredClientY = clientY;
        this.hoverTimer = window.setTimeout(() => {
            if (this.hoveredRowEl !== rowEl) {
                return;
            }
            this.showTooltip(rowEl, title, clientX, clientY);
        }, OutlinePanel.TOOLTIP_DELAY_MS);
    }

    /**
     * 鍙栨秷鎮诞鎻愮ず瀹氭椂鍣ㄣ€?     *
     * @returns void
     */
    private cancelTooltipTimer(): void {
        if (this.hoverTimer !== null) {
            window.clearTimeout(this.hoverTimer);
            this.hoverTimer = null;
        }
    }

    /**
     * 鏄剧ず鎮诞鎻愮ず锛屽苟鏍规嵁褰撳墠琛屼綅缃畾浣嶃€?     *
     * @param rowEl - 鐩爣琛屽厓绱?     * @param title - 瀹屾暣鏍囬鏂囨湰
     * @returns void
     */
    private showTooltip(rowEl: HTMLElement, title: string, clientX: number, clientY: number): void {
        this.tooltipEl.textContent = title;
        this.tooltipEl.dataset.visible = 'true';
        this.tooltipEl.setAttribute('aria-hidden', 'false');
        this.tooltipEl.style.visibility = 'hidden';

        window.requestAnimationFrame(() => {
            if (this.hoveredRowEl !== rowEl || this.hoveredTitle !== title) {
                return;
            }

            this.positionTooltip(clientX, clientY);
            this.tooltipEl.style.visibility = 'visible';
        });
    }

    /**
     * 璁＄畻骞舵洿鏂版偓娴彁绀轰綅缃€?     *
     * @param rowEl - 鐩爣琛屽厓绱?     * @returns void
     */
    private positionTooltip(clientX: number, clientY: number): void {
        const panelRect = this.panelEl.getBoundingClientRect();
        const tooltipRect = this.tooltipEl.getBoundingClientRect();
        const mouseX = clientX - panelRect.left;
        const mouseY = clientY - panelRect.top;
        const gap = 8;
        const padding = 8;

        let left = mouseX - tooltipRect.width - gap;
        let top = mouseY + gap;

        left = Math.max(padding, Math.min(left, panelRect.width - tooltipRect.width - padding));
        top = Math.max(padding, Math.min(top, panelRect.height - tooltipRect.height - padding));

        this.tooltipEl.style.left = `${left}px`;
        this.tooltipEl.style.top = `${top}px`;
        this.tooltipEl.dataset.placement = 'cursor';
    }

    /**
     * 闅愯棌鎮诞鎻愮ず銆?     *
     * @returns void
     */
    private hideTooltip(): void {
        this.cancelTooltipTimer();
        this.hoveredRowEl = null;
        this.hoveredTitle = '';
        this.tooltipEl.dataset.visible = 'false';
        this.tooltipEl.setAttribute('aria-hidden', 'true');
    }

    /**
     * 鎭㈠鍐呭鍖烘粴鍔ㄤ綅缃紝閬垮厤閲嶆覆鏌撳甫鏉ョ殑瑙嗚璺冲姩銆?     *
     * @param scrollTop - 涔嬪墠鐨勫瀭鐩存粴鍔ㄤ綅缃?     * @param scrollLeft - 涔嬪墠鐨勬按骞虫粴鍔ㄤ綅缃?     * @returns void
     */
    private restoreScrollPosition(scrollTop: number, scrollLeft: number): void {
        // 先同步恢复滚动位置，避免下一帧才回填造成的可见跳动。
        this.contentEl.scrollTop = scrollTop;
        this.contentEl.scrollLeft = scrollLeft;

        // 再用下一帧做一次兜底，防止布局重算后被浏览器重新夹紧。
        window.requestAnimationFrame(() => {
            if (this.contentEl.scrollTop !== scrollTop) {
                this.contentEl.scrollTop = scrollTop;
            }
            if (this.contentEl.scrollLeft !== scrollLeft) {
                this.contentEl.scrollLeft = scrollLeft;
            }
        });
    }

    /**
     * 鏇存柊搴曢儴鎸夐挳鐘舵€併€?     *
     * @returns void
     */
    private updateActionBarState(): void {
        const hasNodes = this.nodes.length > 0;
        this.expandAllButtonEl.disabled = !hasNodes;
        this.collapseAllButtonEl.disabled = !hasNodes;
        // 编号按钮：没有标题或只读模式都不可用
        const numberingDisabled = !hasNodes || !this.isEditable();
        this.addNumberingButtonEl.disabled = numberingDisabled;
        this.removeNumberingButtonEl.disabled = numberingDisabled;
    }

    /**
     * 杞箟 HTML 鏂囨湰锛岄伩鍏嶆爣棰樺唴瀹圭牬鍧忕粨鏋勩€?     *
     * @param value - 鍘熷鏂囨湰
     * @returns 瀹夊叏鐨?HTML 鏂囨湰
     */
    private escapeHtml(value: string): string {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
}


