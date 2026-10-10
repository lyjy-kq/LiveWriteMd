/**
 * LiveWriteMD 搜索/替换历史的扩展侧存储封装。
 *
 * 这个模块只负责从 VS Code 的 workspaceState 读取和写入历史状态，
 * 不包含任何 Webview DOM 逻辑。
 *
 * @module extension/searchHistoryStore
 */

import * as vscode from 'vscode';
import {
    createEmptySearchHistory,
    normalizeSearchHistoryState,
    type SearchHistoryState,
} from '../shared/searchHistory.js';

/**
 * 搜索/替换历史在 workspaceState 中使用的存储键。
 */
const SEARCH_HISTORY_STORAGE_KEY = 'liveWriteMd.searchHistory';

/**
 * 从 workspaceState 读取当前工作区的搜索/替换历史。
 *
 * @param context - 扩展上下文，用于访问 workspaceState。
 * @returns 归一化后的搜索/替换历史状态。
 */
export function getSavedSearchHistory(context: vscode.ExtensionContext): SearchHistoryState {
    const raw = context.workspaceState.get<unknown>(SEARCH_HISTORY_STORAGE_KEY);
    if (typeof raw === 'undefined') {
        return createEmptySearchHistory();
    }

    return normalizeSearchHistoryState(raw);
}

/**
 * 将最新的搜索/替换历史写入 workspaceState。
 *
 * @param context - 扩展上下文，用于访问 workspaceState。
 * @param history - 需要持久化的搜索/替换历史状态。
 * @returns 保存操作对应的 Promise。
 */
export function saveSearchHistory(
    context: vscode.ExtensionContext,
    history: SearchHistoryState
): Thenable<void> {
    return context.workspaceState.update(
        SEARCH_HISTORY_STORAGE_KEY,
        normalizeSearchHistoryState(history)
    );
}
