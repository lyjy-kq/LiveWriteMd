/**
 * 搜索/替换历史控制器测试。
 *
 * 这些测试覆盖 datalist 挂载、输入框绑定和历史回传行为，
 * 用于保证 Webview 侧搜索面板接线不回归。
 */

/* @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest';
import type { EditorView } from '@codemirror/view';
import { createEmptySearchHistory } from '../../../shared/searchHistory.js';
import { createSearchHistoryController } from './searchHistory.js';

/**
 * 创建一个用于测试的伪 EditorView。
 *
 * @returns 只包含 `dom` 与 `contentDOM` 的测试视图对象。
 */
function createFakeView(): EditorView {
    const dom = document.createElement('div');
    const contentDOM = document.createElement('div');
    dom.append(contentDOM);
    return {
        dom,
        contentDOM,
    } as unknown as EditorView;
}

describe('createSearchHistoryController', () => {
    it('binds datalist ids to search and replace inputs', () => {
        const view = createFakeView();
        view.dom.insertAdjacentHTML(
            'beforeend',
            '<div class="cm-search"><input name="search" /><input name="replace" /></div>'
        );
        const onChange = vi.fn();

        createSearchHistoryController(view, createEmptySearchHistory(), onChange);

        const searchInput = view.dom.querySelector<HTMLInputElement>('input[name="search"]');
        const replaceInput = view.dom.querySelector<HTMLInputElement>('input[name="replace"]');

        expect(searchInput?.getAttribute('list')).toContain('livewritemd-search-history-search-');
        expect(replaceInput?.getAttribute('list')).toContain('livewritemd-search-history-replace-');
        expect(view.dom.querySelectorAll('datalist')).toHaveLength(2);
        expect(onChange).not.toHaveBeenCalled();
    });

    it('records committed search values and refreshes the option list', () => {
        const view = createFakeView();
        view.dom.insertAdjacentHTML(
            'beforeend',
            '<div class="cm-search"><input name="search" /><input name="replace" /></div>'
        );
        const onChange = vi.fn();
        createSearchHistoryController(view, createEmptySearchHistory(), onChange);

        const searchInput = view.dom.querySelector<HTMLInputElement>('input[name="search"]');
        expect(searchInput).not.toBeNull();
        if (!searchInput) {
            throw new Error('search input missing');
        }

        searchInput.value = 'alpha';
        searchInput.dispatchEvent(new Event('change', { bubbles: true }));

        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange.mock.calls[0]?.[0]).toMatchObject({
            search: ['alpha'],
            replace: [],
        });

        const optionValues = Array.from(view.dom.querySelectorAll('datalist option')).map(
            (option) => (option as HTMLOptionElement).value
        );
        expect(optionValues).toContain('alpha');
    });
});
