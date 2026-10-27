/**
 * Live Preview Widget（从 widgets.ts 拆出）：Frontmatter 属性面板 widget（含模块级 frontmatterCollapsed 单例状态）。
 *
 * @module webview/codemirror/extensions/livePreview/frontmatterWidget
 */

import { rememberWidgetHeight, widgetHeightCache } from './state.js';
import { EditorView, WidgetType } from '@codemirror/view';

// =============================================================================
// Frontmatter Widget
// =============================================================================

/** 元数据卡片的折叠状态（模块级：一篇文档只有一处 front matter）。 */
let frontmatterCollapsed = false;

/**
 * 渲染 YAML frontmatter 的元数据卡片（折叠条 + 键值表）。
 *
 * 关键设计——**展开态高度 = 源码行数 × 行高**：卡片用 min-height 占住与
 * 源码 YAML（含两行 `---`）完全相等的高度，于是点击卡片进入源码态时
 * 是等高替换：元素开头不动、后面的文字位置不动、不额外占行；失焦后
 * 卡片恢复。键值少时卡片下方留白，键值多时网格内部滚动。
 */
export class FrontmatterWidget extends WidgetType {
    private cacheKey: string;
    constructor(
        private properties: FrontmatterProperty[],
        /** front matter 整块（含两行 ---）占的源码行数，用于等高 */
        private sourceLineCount: number,
        /** front matter 起点（点击卡片时光标落这里，从而显出源码） */
        private sourceFrom: number
    ) {
        super();
        this.cacheKey = 'fm-' + sourceLineCount + '-' + JSON.stringify(properties);
    }
    get estimatedHeight(): number {
        return widgetHeightCache.get(this.cacheKey) || 100;
    }

    eq(other: FrontmatterWidget): boolean {
        if (this.sourceLineCount !== other.sourceLineCount) return false;
        if (this.properties.length !== other.properties.length) return false;
        return this.properties.every(
            (p, i) => p.key === other.properties[i].key && p.value === other.properties[i].value
        );
    }

    ignoreEvent(): boolean {
        return false;
    }

    /** 展开态的等高 min-height（折叠时撤掉，只留一条标题栏）。 */
    private expandedMinHeight(): string {
        return `calc(${this.sourceLineCount} * var(--livewritemd-line-height, 1.7em))`;
    }

    toDOM(view: EditorView): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'cm-md-frontmatter';
        wrapper.title = '点击进入源码';
        if (!frontmatterCollapsed) {
            wrapper.style.minHeight = this.expandedMinHeight();
        } else {
            wrapper.classList.add('cm-md-frontmatter-collapsed');
        }

        // Header
        const header = document.createElement('div');
        header.className = 'cm-md-frontmatter-header';
        const headerIcon = document.createElement('span');
        headerIcon.className = 'cm-md-frontmatter-header-icon';
        headerIcon.textContent = '\u{1F4C4}'; // 📄
        header.appendChild(headerIcon);
        const headerText = document.createElement('span');
        headerText.className = 'cm-md-frontmatter-header-text';
        headerText.textContent = `\u5143\u6570\u636E \u00B7 ${this.properties.length} \u9879`;
        header.appendChild(headerText);
        // \u6298\u53E0\u7BAD\u5934\uFF1A\u53EA\u6536\u8D77\u952E\u503C\u8868\uFF08\u5361\u7247\u9AD8\u5EA6\u968F\u4E4B\u53D8\u4E3A\u4E00\u6761\u6807\u9898\u680F\uFF09\uFF0C
        // \u4E0E\u300C\u70B9\u8FDB\u6E90\u7801\u300D\u662F\u4E24\u56DE\u4E8B\uFF0C\u6240\u4EE5\u963B\u6B62\u5192\u6CE1\u3002
        const toggle = document.createElement('span');
        toggle.className = 'cm-md-frontmatter-toggle';
        toggle.textContent = frontmatterCollapsed ? '\u25B8' : '\u25BE';
        toggle.title = frontmatterCollapsed ? '\u5C55\u5F00\u5143\u6570\u636E' : '\u6536\u8D77\u5143\u6570\u636E';
        toggle.addEventListener('click', (event) => {
            event.stopPropagation();
            frontmatterCollapsed = !frontmatterCollapsed;
            wrapper.classList.toggle('cm-md-frontmatter-collapsed', frontmatterCollapsed);
            wrapper.style.minHeight = frontmatterCollapsed ? '' : this.expandedMinHeight();
            toggle.textContent = frontmatterCollapsed ? '\u25B8' : '\u25BE';
            toggle.title = frontmatterCollapsed ? '\u5C55\u5F00\u5143\u6570\u636E' : '\u6536\u8D77\u5143\u6570\u636E';
        });
        header.appendChild(toggle); // プロパティ
        header.appendChild(headerText);
        wrapper.appendChild(header);

        // Properties grid
        const grid = document.createElement('div');
        grid.className = 'cm-md-frontmatter-grid';

        for (const prop of this.properties) {
            // Icon cell
            const icon = document.createElement('div');
            icon.className = 'cm-md-frontmatter-icon';
            icon.textContent = '\u2261'; // ≡
            grid.appendChild(icon);

            // Key cell
            const key = document.createElement('div');
            key.className = 'cm-md-frontmatter-key';
            key.textContent = prop.key;
            grid.appendChild(key);

            // Value cell
            const value = document.createElement('div');
            value.className = 'cm-md-frontmatter-value';
            value.textContent = prop.value;
            grid.appendChild(value);
        }

        wrapper.appendChild(grid);

        // 点击卡片任意处（除折叠箭头）→ 光标落进 front matter 区间，
        // 聚焦区间与之相交后本 widget 不再挂载，源码 YAML 原样显出——
        // 等高替换，不位移。失焦（光标移走）后自动恢复卡片。
        wrapper.addEventListener('mousedown', (event) => {
            event.preventDefault();
            view.dispatch({ selection: { anchor: this.sourceFrom } });
            view.focus();
        });

        // Measure height after mount and notify CM6 to update line height map
        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver((entries) => {
                for (let entry of entries) {
                    const h = entry.borderBoxSize?.[0]?.blockSize || entry.contentRect.height;
                    if (h > 0) rememberWidgetHeight(this.cacheKey, h);
                }
                view.requestMeasure();
            });
            requestAnimationFrame(() => {
                if (wrapper.isConnected) ro.observe(wrapper);
            });
        }
        return wrapper;
    }
}
