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

        this.thumb.addEventListener('pointerdown', this.handleThumbPointerdown.bind(this));
        this.track.addEventListener('click', this.handleTrackClick.bind(this));
        view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });

        this.updateThumb();
    }

    // ── Thumb geometry ────────────────────────────────────────────────────────

    private updateThumb(): void {
        if (!this.track) return;
        const scroller = this.view.scrollDOM;
        const totalLines = this.view.state.doc.lines;
        const trackH = this.track.clientHeight;
        if (trackH === 0 || totalLines === 0) return;

        // Thumb height proportional to visible lines / total lines
        const lineH = Math.max(1, this.view.defaultLineHeight);
        const visibleLines = scroller.clientHeight / lineH;
        const thumbFrac = Math.min(1, visibleLines / totalLines);
        const thumbH = Math.max(THUMB_MIN_HEIGHT, Math.floor(thumbFrac * trackH));
        const maxThumbTop = trackH - thumbH;

        // Thumb position based on native scrollTop ratio
        const maxScroll = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
        const ratio = scroller.scrollTop / maxScroll;
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

        const scroller = this.view.scrollDOM;
        const maxScroll = Math.max(1, scroller.scrollHeight - scroller.clientHeight);

        this.isDragging = true;
        this.dragStartY = e.clientY;
        this.dragStartRatio = scroller.scrollTop / maxScroll;

        // Capture pointer so move/up events always arrive on this element
        this.thumb.setPointerCapture(e.pointerId);
        this.thumb.addEventListener('pointermove', this.onPointermove);
        this.thumb.addEventListener('pointerup', this.onPointerup, { once: true });
        this.thumb.addEventListener('pointercancel', this.onPointerup, { once: true });

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
        this.thumb.removeEventListener('pointermove', this.onPointermove);
        this.thumb.style.backgroundColor = 'rgba(128,128,128,0.55)';
        this.thumb.style.cursor = 'grab';
        // Final jump to exact position
        this.jumpToRatio(this.pendingRatio);
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
        // When ratio = 1.0, always jump to the very last line
        const lineNum =
            ratio >= 0.999
                ? totalLines
                : Math.max(1, Math.min(totalLines, Math.round(ratio * totalLines)));
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
        this.thumb?.removeEventListener('pointermove', this.onPointermove);
    }
}

export const scrollPreserverExtension = ViewPlugin.fromClass(CustomScrollbarPlugin);
