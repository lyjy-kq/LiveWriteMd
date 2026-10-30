/**
 * LiveWriteMD Shared Utility Functions
 *
 * This module provides common utility functions shared between
 * the Extension and Webview.
 *
 * @module shared/utils
 *
 * Design References:
 * - DES-API-006: Debounce processing implementation
 * - DES-F-004: Shared code file responsibilities
 *
 * Requirements:
 * - REQ-F-004: Milkdown edit content file save
 * - REQ-NF-001: Performance requirements
 */

/**
 * 防抖函数（带手动冲刷能力）。
 *
 * `flush()` 立刻执行挂起的那一次调用 —— 导图编辑提交、Ctrl+S 这类
 * 「离散操作」不能等 300ms 的防抖窗口：窗口内 webview 被关闭/切走，
 * 改动就永远送不到扩展侧了。
 */
export interface Debounced<T extends (...args: never[]) => void> {
    (...args: Parameters<T>): void;
    /** 立即执行挂起的调用（没有挂起时什么都不做）。 */
    flush: () => void;
    /** 丢弃挂起的调用。 */
    cancel: () => void;
}

/**
 * Creates a debounced version of a function that delays execution
 * until after the specified wait time has elapsed since the last call.
 *
 * This is primarily used for content synchronization between the Webview
 * and Extension to avoid excessive updates during rapid typing.
 *
 * @template T - The type of the function to debounce
 * @param func - The function to debounce
 * @param wait - The number of milliseconds to delay (default: 300ms per DES-D-005)
 * @returns A debounced version of the function
 *
 * @example
 * ```typescript
 * // Create a debounced content change handler
 * const debouncedSendChange = debounce(
 *     (content: string) => sendContentChange(content),
 *     300
 * );
 *
 * // Multiple rapid calls will only trigger one execution
 * editor.on('change', (content) => {
 *     debouncedSendChange(content);
 * });
 *
 * // 关键操作前不等防抖窗口，直接送出最新一次
 * debouncedSendChange.flush();
 * ```
 */
export function debounce<T extends (...args: never[]) => void>(
    func: T,
    wait: number
): Debounced<T> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    // 记住最近一次参数：flush 时用它补发
    let lastArgs: Parameters<T> | null = null;

    const debounced = ((...args: Parameters<T>): void => {
        lastArgs = args;
        // Clear any existing timeout to reset the delay
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
        }

        // Set a new timeout
        timeoutId = setTimeout(() => {
            timeoutId = null;
            const pending = lastArgs;
            lastArgs = null;
            if (pending) func(...pending);
        }, wait);
    }) as Debounced<T>;

    debounced.flush = (): void => {
        if (timeoutId === null) return;
        clearTimeout(timeoutId);
        timeoutId = null;
        const pending = lastArgs;
        lastArgs = null;
        if (pending) func(...pending);
    };

    debounced.cancel = (): void => {
        if (timeoutId !== null) clearTimeout(timeoutId);
        timeoutId = null;
        lastArgs = null;
    };

    return debounced;
}
