/**
 * Live Preview Widget（从 widgets.ts 拆出）：Mermaid 图 widget：异步渲染、SVG 缓存、预览浮层接线。
 *
 * @module webview/codemirror/extensions/livePreview/mermaidWidget
 */

import { DEFAULT_MEDIA_WIDTH_PERCENT } from '../mediaWidth.js';
import { renderMermaidSvg } from '../mermaidRender.js';
import { openMermaidPreviewOverlay } from '../overlay/mermaidPreview.js';
import { createPreviewActionGroup } from '../overlay/overlayControls.js';
import { copyMermaidRenderedImageSafely } from '../overlay/overlayShell.js';
import { mermaidHeightCache, mermaidSvgCache, sourceModeEffect } from '../state.js';
import { EditorView, WidgetType } from '@codemirror/view';
import { isMediaResizeEvent, appendMediaResizeGroup } from './mediaWidgets.js';

// =============================================================================
// Mermaid Widget
// =============================================================================

/**
 * Mermaid 预览 Widget。
 *
 * 这个 Widget 负责在正文中渲染 Mermaid 图表，并挂载放大与复制按钮。
 * 复制按钮会复用统一复制入口，把当前渲染出的 SVG 作为纯文本复制。
 */
export class MermaidWidget extends WidgetType {
    /** Mermaid 源文本。 */
    constructor(
        private source: string,
        /** 是否使用深色 Mermaid 主题。 */
        private isDark: boolean,
        /** Mermaid 在源码中的起始位置。 */
        private sourceFrom: number,
        /** Mermaid 在源码中的结束位置。 */
        private sourceTo: number,
        /** Mermaid 标题提交后的回写函数，EditorView 由渲染时注入。 */
        private onTitleCommit: ((view: EditorView, title: string) => void) | null = null,
        /** 图表宽度占正文宽度的百分比。 */
        private widthPercent: number = DEFAULT_MEDIA_WIDTH_PERCENT,
        /** 宽度调整后的回写函数，同样由渲染时注入 EditorView。 */
        private onWidthCommit: ((view: EditorView, percent: number) => void) | null = null
    ) {
        super();
    }

    eq(other: MermaidWidget): boolean {
        // 和 ImageWidget 同理，宽度必须参与比较，否则调整后 DOM 不会重建。
        return (
            this.source === other.source &&
            this.isDark === other.isDark &&
            this.widthPercent === other.widthPercent
        );
    }

    get estimatedHeight(): number {
        return mermaidHeightCache.get(this.source) || 350;
    }

    ignoreEvent(event: Event): boolean {
        // 宽度调整按钮要自己处理 mousedown，不能被编辑器吞掉。
        if (isMediaResizeEvent(event)) return true;
        // 双击自己处理（进源码模式），不能被当成选词。
        // 滚轮不再拦截：图表没有缩放功能，滚轮应该照常滚文档。
        return event.type === 'dblclick';
    }

    /**
     * 创建 Mermaid 预览 DOM。
     *
     * 右下角提供放大与复制按钮，放大后进入独立浮层查看器。
     *
     * @param view - 当前 CodeMirror 视图
     * @returns Mermaid 预览节点
     */
    toDOM(view: EditorView): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'cm-md-mermaid-wrapper';
        // 宽度通过 CSS 变量下发，和图片保持同一套消费方式。
        wrapper.style.setProperty('--cm-md-media-width', `${this.widthPercent}%`);
        const contentHost = document.createElement('div');
        contentHost.className = 'cm-md-mermaid-content';
        wrapper.appendChild(contentHost);

        // 单击不改外观，双击才摊开成 ```mermaid 源码
        wrapper.addEventListener('dblclick', (event: MouseEvent) => {
            // 只读模式（Viewer）只看不改，双击不切源码
            if (!view.state.facet(EditorView.editable)) return;
            event.preventDefault();
            event.stopPropagation();
            view.dispatch({
                selection: { anchor: this.sourceFrom },
                effects: sourceModeEffect.of({ from: this.sourceFrom, to: this.sourceTo }),
            });
        });

        // 浮层的 onTitleCommit 只回传标题文本，这里把渲染时的 view 补进去。
        const commitTitle = this.onTitleCommit;
        const actionGroup = createPreviewActionGroup(
            '放大查看图表',
            '复制 Mermaid 图',
            () => {
                // 正文区间在**打开浮层的这一刻**定位：比 toDOM 那一刻更贴近当前文档，
                // 之后由 commitMermaidSource 每次回写时就地维护终点
                const range = this.contentRangeOf(view);
                openMermaidPreviewOverlay({
                    source: this.source,
                    titleText: null,
                    onTitleCommit: commitTitle
                        ? (title: string) => commitTitle(view, title)
                        : undefined,
                    // 浮层里改完代码，把新源码写回围栏之间（见 commitMermaidSource）
                    onSourceCommit: (next: string) => this.commitMermaidSource(view, next, range),
                    // 挂到 <body>，不要挂 view.dom：导图节点的 mini-CM 位于
                    // 画布的 world(translate)+scaler(scale) 变换层里，浮层又是
                    // position:fixed。fixed 在变换祖先下会相对该祖先定位、还会
                    // 被节点/画布的 overflow 裁掉 —— 放大查看在导图里直接失效。
                    // body 是文档根，无变换、无裁剪，live 与导图共用同一份。
                    // themeScope 负责把 CM 的 `ͼN` 主题类搬进 portal：
                    // 不传的话浮层在 body 下会丢掉全部 baseTheme 样式（无法放大显示）。
                    mountHost: document.body,
                    themeScope: view.dom,
                });
            },
            async () => {
                const success = await copyMermaidRenderedImageSafely(contentHost);
                if (!success) {
                    throw new Error('copy failed');
                }
            }
        );
        appendMediaResizeGroup(actionGroup, this.widthPercent, '图表', this.onWidthCommit, view);
        wrapper.appendChild(actionGroup);

        const cached = mermaidSvgCache.get(this.source);
        if (cached) {
            contentHost.innerHTML = cached;
            return wrapper;
        }

        const placeholder = document.createElement('div');
        placeholder.className = 'cm-md-mermaid-placeholder';
        placeholder.textContent = 'Rendering diagram...';
        contentHost.appendChild(placeholder);

        this.renderAsync(contentHost, view);
        return wrapper;
    }

    /**
     * 算出文档里「围栏之间的正文」区间。
     *
     * 起点 = 首行围栏的换行之后；终点 = 末行围栏行首的换行之前。空代码块时两者相等，
     * 往这个空区间里插内容正好落在两个围栏中间。
     *
     * 返回的是**可变对象**：浮层里每写回一次，正文长度就变一次，终点由
     * commitMermaidSource 就地改写，不用每次重新扫文档找闭合围栏
     * （那样还可能被正文里恰好出现的一行 ``` 骗到）。
     *
     * @param view - 当前 CodeMirror 视图
     * @returns 正文区间（`from` 固定、`to` 会被回写逻辑改写）
     */
    private contentRangeOf(view: EditorView): { from: number; to: number } {
        const doc = view.state.doc;
        const startLine = doc.lineAt(Math.min(this.sourceFrom, doc.length));
        const endLine = doc.lineAt(Math.min(this.sourceTo, doc.length));
        const from = Math.min(startLine.to + 1, doc.length);
        return { from, to: Math.max(from, endLine.from - 1) };
    }

    /**
     * 把放大浮层里编辑好的源码写回文档：**只换围栏之间的正文**。
     *
     * 围栏本身（```mermaid + 标题 + `{width=50%}`）一个字都不动 ——
     * 那是 info 行的内容，和图表正文是两回事。
     *
     * @param view - 当前 CodeMirror 视图
     * @param next - 浮层右侧编辑框里的最新源码
     * @param range - contentRangeOf 给出的正文区间，会被就地更新
     */
    private commitMermaidSource(
        view: EditorView,
        next: string,
        range: { from: number; to: number }
    ): void {
        const doc = view.state.doc;
        // widget 记的是创建时的位置，万一文档在别处变短了，越界就静静放弃改写
        if (range.from > doc.length) return;
        // 起点前面应该是那个换了行的围栏：对不上号说明位置已经失效，宁可不写
        const fenceLine = doc.lineAt(range.from).number > 1 ? doc.line(doc.lineAt(range.from).number - 1) : null;
        if (!fenceLine || !fenceLine.text.trimStart().startsWith('```')) return;

        const to = Math.min(range.to, doc.length);
        if (doc.sliceString(range.from, to) === next) return; // 内容没变，别白打扰一次编辑器
        view.dispatch({ changes: { from: range.from, to, insert: next } });
        // 终点跟着新内容走：起点不会被自己的改写影响（改的永远是起点之后的部分）
        range.to = range.from + next.length;
    }

    private async renderAsync(container: HTMLElement, view: EditorView): Promise<void> {
        try {
            // 渲染本体已抽去 mermaidRender.ts（导图 mermaid 媒体节点共用）：
            // 动态 import / 初始化 / inflight 去重 / SVG 缓存都在那边
            const svg = await renderMermaidSvg(this.source);
            container.innerHTML = svg;
            container.classList.add('cm-md-mermaid-rendered');

            // Track actual rendered height via ResizeObserver (more reliable than getBoundingClientRect at render time)
            const src = this.source;
            if (typeof ResizeObserver !== 'undefined') {
                const ro = new ResizeObserver((entries) => {
                    for (const entry of entries) {
                        const h =
                            entry.borderBoxSize?.[0]?.blockSize || entry.contentRect.height;
                        if (h > 0) {
                            mermaidHeightCache.set(src, h);
                            ro.disconnect();
                        }
                    }
                    view.requestMeasure();
                });
                requestAnimationFrame(() => {
                    if (container.isConnected) ro.observe(container);
                });
            }
        } catch (error) {
            container.innerHTML = '';
            const errorEl = document.createElement('div');
            errorEl.className = 'cm-md-mermaid-error';
            errorEl.textContent = `Diagram error: ${error instanceof Error ? error.message : String(error)}`;
            container.appendChild(errorEl);
        }
    }
}
