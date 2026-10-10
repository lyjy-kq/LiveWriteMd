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
 * ```
 */
export function debounce<T extends (...args: never[]) => void>(
    func: T,
    wait: number
): (...args: Parameters<T>) => void {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    return (...args: Parameters<T>): void => {
        // Clear any existing timeout to reset the delay
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
        }

        // Set a new timeout
        timeoutId = setTimeout(() => {
            func(...args);
            timeoutId = null;
        }, wait);
    };
}
