/**
 * Search Match Counter Extension
 *
 * This module adds a lightweight match counter beside the CodeMirror search
 * panel so the webview search UI feels closer to VS Code's native search.
 *
 * @module webview/codemirror/extensions/searchMatchCount
 */

import { ViewPlugin, type ViewUpdate, type EditorView } from '@codemirror/view';
import { SearchQuery, getSearchQuery, searchPanelOpen } from '@codemirror/search';
import type { Extension } from '@codemirror/state';

/**
 * A small ViewPlugin that renders the current match count in the search panel.
 *
 * It keeps the counter in sync with the active CM6 search query and removes
 * the counter when the search panel closes.
 */
export const searchMatchCount: Extension = ViewPlugin.fromClass(
    class {
        /** 当前挂载到搜索面板中的计数元素。 */
        private countEl: HTMLElement | null = null;

        /**
         * 创建匹配计数器。
         *
         * @param view - 当前 CodeMirror 编辑器视图
         */
        constructor(private view: EditorView) {
            requestAnimationFrame(() => this.updateCount());
        }

        /**
         * 响应编辑器更新并刷新计数显示。
         *
         * @param _update - 本次视图更新
         * @returns void
         */
        update(_update: ViewUpdate): void {
            this.updateCount();
        }

        /**
         * 同步搜索面板中的匹配数量。
         *
         * @returns void
         */
        private updateCount(): void {
            if (!searchPanelOpen(this.view.state)) {
                if (this.countEl) {
                    this.countEl.remove();
                    this.countEl = null;
                }
                return;
            }

            const spec = getSearchQuery(this.view.state);
            const query = new SearchQuery(spec as any);

            if (!query.valid) {
                if (this.countEl) {
                    this.countEl.textContent = '';
                    this.countEl.style.display = 'none';
                }
                return;
            }

            if (!this.countEl || !this.countEl.parentElement) {
                this.countEl = document.createElement('span');
                this.countEl.className = 'cm-search-match-count';
                const searchPanel = this.view.dom.querySelector('.cm-search');
                const searchField = searchPanel?.querySelector('input[name="search"]');
                if (searchField) {
                    searchField.after(this.countEl);
                } else {
                    return;
                }
            }

            this.countEl.style.display = '';

            const cursor = query.getCursor(this.view.state);
            let total = 0;
            let currentIndex = 0;
            const sel = this.view.state.selection.main;

            let result = cursor.next();
            while (!result.done) {
                total++;
                if (result.value.from === sel.from && result.value.to === sel.to) {
                    currentIndex = total;
                }
                result = cursor.next();
            }

            if (total === 0) {
                // 无匹配：红色提示（颜色由主题里的 -none 类提供）
                this.countEl.textContent = '无结果';
                this.countEl.classList.add('cm-search-match-count-none');
            } else {
                this.countEl.classList.remove('cm-search-match-count-none');
                if (currentIndex > 0) {
                    // 光标正好落在某个匹配上：显示「当前/总数」
                    this.countEl.textContent = `${currentIndex}/${total}`;
                } else {
                    // 有匹配但当前选区不在匹配上：只显示总数
                    this.countEl.textContent = `${total} 个结果`;
                }
            }
        }

        /**
         * 清理挂载到 DOM 的计数器节点。
         *
         * @returns void
         */
        destroy(): void {
            if (this.countEl) {
                this.countEl.remove();
                this.countEl = null;
            }
        }
    }
);
