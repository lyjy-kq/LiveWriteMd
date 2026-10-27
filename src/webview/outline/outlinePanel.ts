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
import { settingsState } from '../settings/settingsState.js';
import { parseHeadings, pushHeadingNode, normalizeHeadingText } from './outlineHeadingParse.js';
import { render, renderNodes, findActiveNodeId, syncActiveState, buildToggleIcon, buildIndentGuides } from './outlineRender.js';
import {
    resolveActionBarElement, resolveActionButton, buildActionGlyph,
    resolveTooltipElement, scheduleTooltip, cancelTooltipTimer,
    showTooltip, positionTooltip, hideTooltip,
    restoreScrollPosition, updateActionBarState, escapeHtml,
} from './outlineActionBar.js';
import { bindEvents } from './outlineEvents.js';

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
    public width: number;

    /** 当前大纲是否可见。 */
    public outlineVisible = true;

    /** 褰撳墠 Markdown 鏍囬鏍戙€?*/
    public nodes: OutlineNode[] = [];

    /** 褰撳墠婵€娲荤殑鏍囬鑺傜偣 ID銆?*/
    public activeNodeId: string | null = null;

    /** 鎶樺彔鑺傜偣 ID 闆嗗悎銆?*/
    private readonly collapsedNodeIds = new Set<string>();

    /** 褰撳墠楂樹寒琛屽彿銆?*/
    public activeLine = 1;

    /** 鏄惁姝ｅ湪鎷栨嫿鍒嗛殧鏉°€?*/
    public dragging = false;

    /** 鎷栨嫿璧峰 X 鍧愭爣銆?*/
    public dragStartX = 0;

    /** 鎷栨嫿璧峰瀹藉害銆?*/
    public dragStartWidth = 0;

    /** 鎮诞鎻愮ず瀹氭椂鍣ㄣ€?*/
    public hoverTimer: number | null = null;

    /** 褰撳墠鎮诞鐨勬爣棰樿銆?*/
    public hoveredRowEl: HTMLElement | null = null;

    /** 褰撳墠鎮诞鏍囬鐨勫畬鏁存枃鏈€?*/
    public hoveredTitle = '';

    /** 当前悬浮提示的鼠标 X 坐标。 */
    public hoveredClientX = 0;

    /** 当前悬浮提示的鼠标 Y 坐标。 */
    public hoveredClientY = 0;

    /** 鍏佽鐨勬渶灏忓搴︺€?*/
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
        // 操作栏只保留大纲自身相关的按钮；「关闭大纲」与「设置」入口统一收编到
        // VSCode 编辑器标题栏（toggleOutline / openSettings），这里不再重复提供。
        this.addNumberingButtonEl = this.resolveActionButton('add-numbering', '标题编号');
        this.removeNumberingButtonEl = this.resolveActionButton('remove-numbering', '取消编号');
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
        }
    };

    // ---- 薄包装：实现已拆到同目录 outlineXxx.ts，签名不变 ----
    private parseHeadings(content: string) : OutlineNode[] {
        return parseHeadings(content);
    }
    private pushHeadingNode(rootNodes: OutlineNode[], stack: OutlineNode[], siblingCounts: Map<string, number>, level: number, text: string, line: number) : void {
        return pushHeadingNode(rootNodes, stack, siblingCounts, level, text, line);
    }
    private normalizeHeadingText(text: string) : string {
        return normalizeHeadingText(text);
    }
    private render() : void {
        return render(this);
    }
    private renderNodes(nodes: OutlineNode[], activeNodeId: string | null) : string {
        return renderNodes(this, nodes, activeNodeId);
    }
    private findActiveNodeId(nodes: OutlineNode[], lineNumber: number) : string | null {
        return findActiveNodeId(this, nodes, lineNumber);
    }
    private syncActiveState() : void {
        return syncActiveState(this);
    }
    private buildToggleIcon(collapsed: boolean) : string {
        return buildToggleIcon(this, collapsed);
    }
    private buildIndentGuides(level: number) : string {
        return buildIndentGuides(this, level);
    }
    private resolveActionBarElement() : HTMLElement {
        return resolveActionBarElement(this);
    }
    private resolveActionButton(action: string, label: string) : HTMLButtonElement {
        return resolveActionButton(this, action, label);
    }
    private buildActionGlyph(action: string) : string {
        return buildActionGlyph(this, action);
    }
    private resolveTooltipElement() : HTMLDivElement {
        return resolveTooltipElement(this);
    }
    private scheduleTooltip(rowEl: HTMLElement, clientX: number, clientY: number) : void {
        return scheduleTooltip(this, rowEl, clientX, clientY);
    }
    private cancelTooltipTimer() : void {
        return cancelTooltipTimer(this);
    }
    private showTooltip(rowEl: HTMLElement, title: string, clientX: number, clientY: number) : void {
        return showTooltip(this, rowEl, title, clientX, clientY);
    }
    private positionTooltip(clientX: number, clientY: number) : void {
        return positionTooltip(this, clientX, clientY);
    }
    private hideTooltip() : void {
        return hideTooltip(this);
    }
    private restoreScrollPosition(scrollTop: number, scrollLeft: number) : void {
        return restoreScrollPosition(this, scrollTop, scrollLeft);
    }
    private updateActionBarState() : void {
        return updateActionBarState(this);
    }
    private escapeHtml(value: string) : string {
        return escapeHtml(this, value);
    }
    private bindEvents() : void {
        return bindEvents(this);
    }

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
}
