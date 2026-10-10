/**
 * CodeMirror 搜索/替换历史控制器。
 *
 * 这个模块负责把工作区级的搜索历史状态挂到原生搜索面板输入框上，
 * 并在用户完成一次搜索或替换输入后，把最新历史回传给扩展侧持久化。
 *
 * @module webview/codemirror/extensions/searchHistory
 */

import type { EditorView } from '@codemirror/view';
import {
    createEmptySearchHistory,
    normalizeSearchHistoryState,
    type SearchHistoryKind,
    type SearchHistoryState,
    upsertSearchHistoryEntry,
} from '../../../shared/searchHistory.js';

/**
 * 搜索历史控制器对外暴露的最小接口。
 */
export interface SearchHistoryController {
    /**
     * 用新的历史状态刷新下拉选项。
     *
     * @param history - 新的搜索/替换历史状态。
     * @returns void
     */
    setHistory(history: SearchHistoryState): void;

    /**
     * 销毁控制器并清理挂载的 DOM 与监听器。
     *
     * @returns void
     */
    destroy(): void;
}

/**
 * 搜索历史控制器实例编号，用于生成唯一 datalist id。
 */
let nextSearchHistoryControllerId = 0;

/**
 * 搜索/替换历史控制器的具体实现。
 */
class SearchHistoryControllerImpl implements SearchHistoryController {
    /** 绑定的 CodeMirror 编辑器视图。 */
    private readonly view: EditorView;

    /** 当前内存中的搜索/替换历史状态。 */
    private historyState: SearchHistoryState;

    /** 历史变化时通知扩展侧的回调。 */
    private readonly onChange: (history: SearchHistoryState) => void;

    /** 搜索输入框对应的 datalist 元素。 */
    private readonly searchListEl: HTMLDataListElement;

    /** 替换输入框对应的 datalist 元素。 */
    private readonly replaceListEl: HTMLDataListElement;

    /** 搜索 datalist 的唯一 id。 */
    private readonly searchListId: string;

    /** 替换 datalist 的唯一 id。 */
    private readonly replaceListId: string;

    /** 监听输入框事件的回调函数。 */
    private readonly handleRootEvent = (event: Event): void => {
        if (this.destroyed) {
            return;
        }

        const input = event.target instanceof HTMLInputElement ? event.target : null;
        if (!input) {
            return;
        }

        const kind = this.resolveInputKind(input);
        if (!kind) {
            return;
        }

        if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Enter') {
            return;
        }

        if (event.type === 'change' || event.type === 'keydown') {
            this.recordHistory(kind, input.value);
        }
    };

    /** 监听搜索面板 DOM 变化的观察器。 */
    private readonly observer: MutationObserver;

    /** 控制器是否已经销毁。 */
    private destroyed = false;

    /**
     * 创建一个新的搜索历史控制器。
     *
     * @param view - 当前 CodeMirror 编辑器视图。
     * @param initialHistory - 初始历史状态。
     * @param onChange - 历史变化时要通知扩展侧的回调。
     */
    constructor(
        view: EditorView,
        initialHistory: SearchHistoryState,
        onChange: (history: SearchHistoryState) => void
    ) {
        this.view = view;
        this.onChange = onChange;
        this.historyState = normalizeSearchHistoryState(initialHistory);

        const controllerId = ++nextSearchHistoryControllerId;
        this.searchListId = `livewritemd-search-history-search-${controllerId}`;
        this.replaceListId = `livewritemd-search-history-replace-${controllerId}`;

        this.searchListEl = document.createElement('datalist');
        this.searchListEl.id = this.searchListId;
        this.searchListEl.hidden = true;

        this.replaceListEl = document.createElement('datalist');
        this.replaceListEl.id = this.replaceListId;
        this.replaceListEl.hidden = true;

        this.mountHistoryLists();
        this.renderHistoryLists();
        this.syncPanelInputs();

        this.view.dom.addEventListener('change', this.handleRootEvent, true);
        this.view.dom.addEventListener('keydown', this.handleRootEvent, true);

        this.observer = new MutationObserver(() => {
            this.syncPanelInputs();
        });
        this.observer.observe(this.view.dom, {
            childList: true,
            subtree: true,
        });
    }

    /**
     * 用新的历史状态刷新下拉选项。
     *
     * @param history - 新的搜索/替换历史状态。
     * @returns void
     */
    public setHistory(history: SearchHistoryState): void {
        if (this.destroyed) {
            return;
        }

        this.historyState = normalizeSearchHistoryState(history);
        this.renderHistoryLists();
        this.syncPanelInputs();
    }

    /**
     * 销毁控制器并清理挂载的 DOM 与监听器。
     *
     * @returns void
     */
    public destroy(): void {
        if (this.destroyed) {
            return;
        }

        this.destroyed = true;
        this.view.dom.removeEventListener('change', this.handleRootEvent, true);
        this.view.dom.removeEventListener('keydown', this.handleRootEvent, true);
        this.observer.disconnect();
        this.searchListEl.remove();
        this.replaceListEl.remove();
    }

    /**
     * 把 datalist 挂到编辑器根节点下，确保输入框可以引用到它们。
     *
     * @returns void
     */
    private mountHistoryLists(): void {
        this.view.dom.append(this.searchListEl, this.replaceListEl);
    }

    /**
     * 将当前历史状态渲染到两个 datalist 中。
     *
     * @returns void
     */
    private renderHistoryLists(): void {
        this.renderList(this.searchListEl, this.historyState.search);
        this.renderList(this.replaceListEl, this.historyState.replace);
    }

    /**
     * 渲染单个 datalist 的 option 节点。
     *
     * @param listEl - 需要刷新的 datalist 元素。
     * @param values - 需要展示的历史项列表。
     * @returns void
     */
    private renderList(listEl: HTMLDataListElement, values: string[]): void {
        listEl.replaceChildren(
            ...values.map((value) => {
                const option = document.createElement('option');
                option.value = value;
                return option;
            })
        );
    }

    /**
     * 根据输入框 name 判断其属于搜索还是替换历史。
     *
     * @param input - 当前触发事件的输入框。
     * @returns 对应的历史类别；若不是搜索面板输入框则返回 null。
     */
    private resolveInputKind(input: HTMLInputElement): SearchHistoryKind | null {
        const name = input.getAttribute('name');
        if (name === 'search') {
            return 'search';
        }

        if (name === 'replace') {
            return 'replace';
        }

        return null;
    }

    /**
     * 将当前输入框内容写入对应历史列表，并通知扩展侧持久化。
     *
     * @param kind - 需要更新的是搜索历史还是替换历史。
     * @param value - 输入框里的当前值。
     * @returns void
     */
    private recordHistory(kind: SearchHistoryKind, value: string): void {
        const nextHistory = upsertSearchHistoryEntry(this.historyState, kind, value);
        if (this.areHistoryStatesEqual(this.historyState, nextHistory)) {
            return;
        }

        this.historyState = nextHistory;
        this.renderHistoryLists();
        this.onChange(this.historyState);
    }

    /**
     * 把 datalist 绑定到当前存在的搜索面板输入框上。
     *
     * 搜索面板可能被 CodeMirror 动态重建，所以每次 DOM 变化都要重新绑定。
     *
     * @returns void
     */
    private syncPanelInputs(): void {
        const searchInput = this.view.dom.querySelector<HTMLInputElement>(
            '.cm-search input[name="search"]'
        );
        if (searchInput) {
            searchInput.setAttribute('list', this.searchListId);
        }

        const replaceInput = this.view.dom.querySelector<HTMLInputElement>(
            '.cm-search input[name="replace"]'
        );
        if (replaceInput) {
            replaceInput.setAttribute('list', this.replaceListId);
        }
    }

    /**
     * 比较两个历史状态是否完全相同。
     *
     * @param left - 左侧历史状态。
     * @param right - 右侧历史状态。
     * @returns 如果两者完全一致则返回 true。
     */
    private areHistoryStatesEqual(left: SearchHistoryState, right: SearchHistoryState): boolean {
        return (
            this.areHistoryListsEqual(left.search, right.search) &&
            this.areHistoryListsEqual(left.replace, right.replace)
        );
    }

    /**
     * 比较两个历史数组是否完全相同。
     *
     * @param left - 左侧历史数组。
     * @param right - 右侧历史数组。
     * @returns 如果两个数组内容与顺序一致则返回 true。
     */
    private areHistoryListsEqual(left: string[], right: string[]): boolean {
        if (left.length !== right.length) {
            return false;
        }

        for (let index = 0; index < left.length; index += 1) {
            if (left[index] !== right[index]) {
                return false;
            }
        }

        return true;
    }
}

/**
 * 创建一个新的搜索历史控制器。
 *
 * @param view - 当前 CodeMirror 编辑器视图。
 * @param initialHistory - 初始的搜索/替换历史状态。
 * @param onChange - 历史变化时要通知扩展侧的回调。
 * @returns 可用于刷新和销毁的搜索历史控制器。
 */
export function createSearchHistoryController(
    view: EditorView,
    initialHistory: SearchHistoryState,
    onChange: (history: SearchHistoryState) => void
): SearchHistoryController {
    const normalizedInitialHistory = initialHistory ?? createEmptySearchHistory();
    return new SearchHistoryControllerImpl(view, normalizedInitialHistory, onChange);
}
