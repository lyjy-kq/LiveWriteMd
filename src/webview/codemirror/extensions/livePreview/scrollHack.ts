import { EditorView, PluginValue, ViewPlugin, ViewUpdate } from '@codemirror/view';

/**
 * 魔改造 Scroll Preserver v6 — Full Custom Scrollbar
 *
 * Root cause: CM6's scrollHeight is permanently underestimated by its internal
 * HeightMap (virtual rendering). The native scrollbar's max scrollTop is
 * scrollHeight-clientHeight, so it can never reach the true end of a document
 * with tall code blocks.
 *
 * Solution: Replace the native vertical scrollbar entirely.
 *   1. Hide native scrollbar (scrollbar-width: none + webkit pseudo-element)
 *   2. Inject a custom track + thumb positioned on the right edge of .cm-editor
 *   3. Thumb position = currentLine / totalLines  (line-ratio, not pixel-ratio)
 *   4. Dragging thumb → ratio → scrollIntoView(targetLine)
 *   5. CM6 scroll events → updateThumb (suppressed during drag to avoid jitter)
 *
 * This completely bypasses the HeightMap underestimation problem.
 *
 * 关键：拖动、摆 thumb、滚轮之后的回显必须用**同一套行口径比例**。
 * 以前拖动走「行比例」，而 updateThumb 却用 scrollTop/scrollHeight 的像素比例，
 * 两个比例在代码块/表格多的文档里能差出几十个百分点 —— 松手或滚轮时 thumb
 * 会突然弹回/跳到别的位置（表现为「拖到 B，一滚滚轮又跳回 A」）。
 * 现在统一成 (顶部行号 - 1) / (总行数 - 可见行数)，与 jumpToRatio 严格互逆。
 *
 * 另外，自定义轨道挂在 .cm-editor 下、并不是 .cm-scroller 的子元素，浏览器
 * 找不到可滚动祖先 —— 鼠标停在滚动条上滚轮会直接失灵。所以轨道自己接 wheel
 * 事件，把位移转给 scrollDOM（修好「拖完滚动条鼠标还在条上，滚轮没反应」）。
 */

const SCROLLBAR_WIDTH = 14; // px — custom scrollbar width
const THUMB_MIN_HEIGHT = 28; // px

class CustomScrollbarPlugin implements PluginValue {
    private view: EditorView;
    private track!: HTMLElement;
    private thumb!: HTMLElement;
    private styleEl!: HTMLStyleElement;

    // Drag state
    private isDragging = false;
    private dragStartY = 0;
    private dragStartRatio = 0;
    private rafPending = false;
    private pendingRatio = 0;

    // Definite assignment (!): the constructor early-returns when the editor
    // element is missing, matching the track!/thumb!/styleEl! fields above.
    private readonly onPointermove!: (e: PointerEvent) => void;
    private readonly onPointerup!: (e: PointerEvent) => void;
    private readonly onScroll!: () => void;
    private readonly onWheel!: (e: WheelEvent) => void;

    constructor(view: EditorView) {
        this.view = view;

        const editor = view.scrollDOM.parentElement;
        if (!editor) return;

        // ── 1. Hide native scrollbar ──────────────────────────────────────────
        this.styleEl = document.createElement('style');
        this.styleEl.textContent = [
            '.cm-scroller::-webkit-scrollbar { display: none !important; }',
        ].join('\n');
        document.head.appendChild(this.styleEl);
        view.scrollDOM.style.setProperty('scrollbar-width', 'none');

        // ── 2. Build custom track + thumb ────────────────────────────────────
        this.track = document.createElement('div');
        this.thumb = document.createElement('div');

        Object.assign(this.track.style, {
            position: 'absolute',
            top: '0',
            right: '0',
            bottom: '0',
            width: `${SCROLLBAR_WIDTH}px`,
            zIndex: '100',
            backgroundColor: 'transparent',
            pointerEvents: 'auto',
        } as Partial<CSSStyleDeclaration>);
        this.track.setAttribute('data-livewritemd-scrollbar', 'track');

        Object.assign(this.thumb.style, {
            position: 'absolute',
            left: '2px',
            right: '2px',
            borderRadius: '6px',
            backgroundColor: 'rgba(128,128,128,0.55)',
            cursor: 'grab',
            minHeight: `${THUMB_MIN_HEIGHT}px`,
            boxSizing: 'border-box',
            touchAction: 'none',
        } as Partial<CSSStyleDeclaration>);
        this.track.appendChild(this.thumb);
        editor.appendChild(this.track);

        // Hover highlight
        this.thumb.addEventListener('mouseenter', () => {
            if (!this.isDragging) this.thumb.style.backgroundColor = 'rgba(128,128,128,0.75)';
        });
        this.thumb.addEventListener('mouseleave', () => {
            if (!this.isDragging) this.thumb.style.backgroundColor = 'rgba(128,128,128,0.55)';
        });

        // ── 3. Wire events ────────────────────────────────────────────────────
        // Use PointerEvents + setPointerCapture so drag works even when mouse
        // leaves the VS Code webview iframe (mouseup would be lost otherwise).
        this.onPointermove = this.handlePointermove.bind(this);
        this.onPointerup = this.handlePointerup.bind(this);
        this.onScroll = this.handleScroll.bind(this);
        this.onWheel = this.handleWheel.bind(this);

        this.thumb.addEventListener('pointerdown', this.handleThumbPointerdown.bind(this));
        this.track.addEventListener('click', this.handleTrackClick.bind(this));
        view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
        // 轨道不在 .cm-scroller 里，浏览器默认滚轮滚动找不到它；
        // 自己在轨道上接 wheel，见 handleWheel。passive:false 才能 preventDefault。
        this.track.addEventListener('wheel', this.onWheel, { passive: false });

        this.updateThumb();
    }

    // ── Thumb geometry ────────────────────────────────────────────────────────

    /**
     * 当前视口顶部所在的文档行号（1 起）。
     *
     * 用 `lineBlockAtHeight(scrollTop)` 而不是 `viewport.from`：后者带一些
     * 上下预渲染余量，在代码块 widget 附近会让行号偏移。
     */
    private topLineNumber(): number {
        const scroller = this.view.scrollDOM;
        const block = this.view.lineBlockAtHeight(scroller.scrollTop);
        return this.view.state.doc.lineAt(block.from).number;
    }

    /**
     * 一屏大约能放下多少行（行口径的「可见高度」）。
     *
     * 只作为比例换算的归一化常量用：拿它把「顶部行号」映射到 0~1。
     * 代码块/表格会让真实可见行数变少，这个估算不精确 —— 但拖动和回显
     * 用的是同一套公式，误差不会变成 thumb 的瞬移。
     */
    private visibleLineCount(): number {
        const lineH = Math.max(1, this.view.defaultLineHeight);
        const visible = this.view.scrollDOM.clientHeight / lineH;
        return Math.max(1, Math.min(this.view.state.doc.lines, visible));
    }

    /**
     * 滚动到底时视口顶部最多能到第几行。比例满格 1 就对应这一行。
     */
    private maxTopLineOffset(): number {
        return Math.max(1, this.view.state.doc.lines - this.visibleLineCount());
    }

    /**
     * 当前滚动位置的行口径比例（0 = 顶部，1 = 底部）。
     *
     * 这是全文件唯一的位置比例来源：拖动起点、thumb 位置、拖动结束后的回显
     * 都用它，保证「拖到哪，thumb 就停在哪」。
     * 与 jumpToRatio 的映射严格互逆：lineNum = 1 + round(ratio * maxTopOffset)。
     * 用 maxTopOffset 归一化（而不是 N-1），滚到底时比例正好是 1，
     * thumb 才能贴住轨道底端、拖到底也真的能到文档最后一行。
     */
    private currentRatio(): number {
        const maxTop = this.maxTopLineOffset();
        const ratio = (this.topLineNumber() - 1) / maxTop;
        return Math.max(0, Math.min(1, ratio));
    }

    private updateThumb(): void {
        if (!this.track) return;
        const scroller = this.view.scrollDOM;
        const totalLines = this.view.state.doc.lines;
        const trackH = this.track.clientHeight;
        if (trackH === 0 || totalLines === 0) return;

        // thumb 高度按「可见行数 / 总行数」估算（行口径，和位置比例同一套单位）
        const lineH = Math.max(1, this.view.defaultLineHeight);
        const visibleLines = scroller.clientHeight / lineH;
        const thumbFrac = Math.min(1, visibleLines / totalLines);
        const thumbH = Math.max(THUMB_MIN_HEIGHT, Math.floor(thumbFrac * trackH));
        const maxThumbTop = trackH - thumbH;

        // 位置用行比例，而不是 scrollTop/scrollHeight 的像素比例 ——
        // 有代码块/表格的文档里两者差别巨大，混用会让 thumb 在松手后瞬移。
        const ratio = this.currentRatio();
        const thumbTop = Math.floor(ratio * maxThumbTop);

        this.thumb.style.height = `${thumbH}px`;
        this.thumb.style.top = `${thumbTop}px`;
    }

    // ── Drag handling (PointerEvent + capture) ───────────────────────────────
    // setPointerCapture ensures pointermove/pointerup are delivered even when
    // the mouse leaves the VS Code webview iframe — no more "stuck" thumb.

    private handleThumbPointerdown(e: PointerEvent): void {
        e.preventDefault();
        e.stopPropagation();

        this.isDragging = true;
        this.dragStartY = e.clientY;
        // 起点比例必须和 thumb 的绘制口径一致（行比例）。
        // 之前这里用像素比例，pointerdown 后第一次 move 就可能让内容跳到
        // 另一个位置，松手/滚轮时 thumb 再按像素比例回显，看起来像「跳回原位」。
        this.dragStartRatio = this.currentRatio();
        // 清掉上一次拖动残留的目标比例：这次还没 move 时若触发 pointerup，
        // 也应该停在起点，而不是上一次拖动的位置。
        this.pendingRatio = this.dragStartRatio;

        // Capture pointer so move/up events always arrive on this element
        this.thumb.setPointerCapture(e.pointerId);
        this.thumb.addEventListener('pointermove', this.onPointermove);
        // 不用 { once: true }：pointerup / pointercancel 都会走 onPointerup，
        // 两个都挂 once 的话，没触发的那个会一直留在元素上越积越多。
        this.thumb.addEventListener('pointerup', this.onPointerup);
        this.thumb.addEventListener('pointercancel', this.onPointerup);

        this.thumb.style.backgroundColor = 'rgba(128,128,128,0.9)';
        this.thumb.style.cursor = 'grabbing';
    }

    private handlePointermove(e: PointerEvent): void {
        if (!this.isDragging) return;

        const trackH = this.track.clientHeight;
        const thumbH = this.thumb.clientHeight;
        const maxOffset = Math.max(1, trackH - thumbH);

        const deltaY = e.clientY - this.dragStartY;
        const newRatio = Math.max(0, Math.min(1, this.dragStartRatio + deltaY / maxOffset));

        // Move thumb immediately for smooth feel
        this.thumb.style.top = `${Math.floor(newRatio * maxOffset)}px`;

        // Throttle scrollIntoView via RAF
        this.pendingRatio = newRatio;
        if (this.rafPending) return;
        this.rafPending = true;
        requestAnimationFrame(() => {
            this.rafPending = false;
            if (this.isDragging) this.jumpToRatio(this.pendingRatio);
        });
    }

    private handlePointerup(_e: PointerEvent): void {
        if (!this.isDragging) return;
        this.isDragging = false;
        this.rafPending = false;
        this.thumb.removeEventListener('pointermove', this.onPointermove);
        this.thumb.removeEventListener('pointerup', this.onPointerup);
        this.thumb.removeEventListener('pointercancel', this.onPointerup);
        this.thumb.style.backgroundColor = 'rgba(128,128,128,0.55)';
        this.thumb.style.cursor = 'grab';
        // Final jump to exact position（松手这一下必须落到位，不能只靠 RAF 的中间值）
        this.jumpToRatio(this.pendingRatio);
    }

    // ── Wheel over the custom scrollbar ──────────────────────────────────────

    /**
     * 轨道 / thumb 上的滚轮。
     *
     * 自定义轨道是 .cm-editor 的直接子元素，和 .cm-scroller 是兄弟关系：
     * 浏览器按「事件目标最近的可滚动祖先」找滚轮落点，找不到 .cm-scroller，
     * 结果就是鼠标停在滚动条上滚轮完全没反应（拖完滚动条后最常见的姿势）。
     * 这里手动把位移加回 scrollDOM。
     *
     * Ctrl/Cmd/Alt 组合键不拦截：Ctrl+滚轮调字号、Alt+滚轮加速滚动都是
     * 编辑器自己的逻辑，事件继续冒泡到 .cm-editor 让它们处理。
     */
    private handleWheel(e: WheelEvent): void {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const scroller = this.view.scrollDOM;
        // deltaMode 1 = 按行（Firefox 常见），2 = 按页
        const lineH = Math.max(1, this.view.defaultLineHeight);
        const delta =
            e.deltaMode === 1
                ? e.deltaY * lineH
                : e.deltaMode === 2
                  ? e.deltaY * scroller.clientHeight
                  : e.deltaY;
        if (!delta) return;
        e.preventDefault();
        scroller.scrollTop += delta;
    }

    private handleTrackClick(e: MouseEvent): void {
        // Click on track (not on thumb) — page up/down
        if ((e.target as HTMLElement) === this.thumb) return;
        const rect = this.track.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
        this.jumpToRatio(ratio);
    }

    // ── Line-based navigation ─────────────────────────────────────────────────

    private jumpToRatio(ratio: number): void {
        const state = this.view.state;
        const totalLines = state.doc.lines;
        const maxTop = this.maxTopLineOffset();
        // 与 currentRatio() 严格互逆：ratio = (lineNum - 1) / maxTop。
        // 这样「拖到某个比例」和「这个比例对应的 thumb 位置」永远一致，
        // 松手后 updateThumb 不会把 thumb 换算到别处去。
        // 拖到轨道最底端（ratio ≥ 0.999）直接落到最后一行。
        const lineNum =
            ratio >= 0.999
                ? totalLines
                : Math.max(1, Math.min(totalLines, 1 + Math.round(ratio * maxTop)));
        const pos = state.doc.line(lineNum).from;

        this.view.dispatch({
            effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 0 }),
        });
    }

    // ── Scroll event (from wheel / keyboard / scrollIntoView) ─────────────────

    private handleScroll(): void {
        // During drag, thumb position is driven by mousemove — skip to avoid jitter
        if (this.isDragging) return;
        this.updateThumb();
    }

    // ── CM6 update hook ───────────────────────────────────────────────────────

    update(update: ViewUpdate): void {
        // 拖动期间 thumb 由指针驱动，别让异步 widget 的几何变化把它抢走
        if (this.isDragging) return;
        if (update.geometryChanged || update.docChanged) {
            this.updateThumb();
        }
    }

    // ── Cleanup ───────────────────────────────────────────────────────────────

    destroy(): void {
        if (this.track) this.track.remove();
        if (this.styleEl) this.styleEl.remove();
        this.view.scrollDOM.style.removeProperty('scrollbar-width');
        this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
        this.track?.removeEventListener('wheel', this.onWheel);
        this.thumb?.removeEventListener('pointermove', this.onPointermove);
        this.thumb?.removeEventListener('pointerup', this.onPointerup);
        this.thumb?.removeEventListener('pointercancel', this.onPointerup);
    }
}

export const scrollPreserverExtension = ViewPlugin.fromClass(CustomScrollbarPlugin);
