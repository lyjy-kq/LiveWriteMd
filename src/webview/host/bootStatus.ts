/**
 * 启动诊断与 READY 握手（从 main.ts 拆出）。
 *
 * 覆盖：boot-status 提示条、全局异常监听、READY 发送与重试、
 * 只执行一次的初始化入口（initialize 由 main.ts 注入，避免反向依赖）。
 *
 * @module webview/host/bootStatus
 */

import { ctx } from './webviewContext.js';
import { sendLog } from './logForward.js';

/**
 * 更新启动状态提示文本。
 *
 * @param detail - 展示给用户的启动阶段说明。
 * @returns void
 */
export function updateBootStatus(detail: string): void {
    const bootStatus = document.getElementById('boot-status');
    if (!bootStatus) {
        return;
    }

    const detailEl = bootStatus.querySelector('.boot-status-detail');
    if (detailEl) {
        detailEl.textContent = detail;
    }
}

/**
 * 隐藏启动状态提示。
 *
 * @returns void
 */
export function hideBootStatus(): void {
    document.getElementById('boot-status')?.setAttribute('hidden', 'true');
}

/**
 * 注册 Webview 全局异常监听。
 *
 * @returns void
 */
export function registerGlobalErrorDiagnostics(): void {
    window.addEventListener('error', (event: ErrorEvent) => {
        const message = event.error instanceof Error ? event.error.message : event.message;
        // ResizeObserver 的「loop completed with undelivered notifications」是
        // 浏览器已知的良性告警（回调里改了布局而已），没有调用栈也没有
        // 可恢复动作；不往扩展主机刷 ERROR，免得掩盖真正的异常。
        if (message.includes('ResizeObserver loop')) return;
        const stack = event.error instanceof Error ? event.error.stack : undefined;
        sendLog(
            'ERROR',
            `Global error captured: message=${message}, source=${event.filename}, line=${event.lineno}, column=${event.colno}`
        );
        ctx.messageSender.sendError(message, stack, 'WEBVIEW_GLOBAL_ERROR');
    });

    window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
        const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
        const stack = event.reason instanceof Error ? event.reason.stack : undefined;
        sendLog('ERROR', `Unhandled promise rejection captured: ${reason}`);
        ctx.messageSender.sendError(reason, stack, 'WEBVIEW_UNHANDLED_REJECTION');
    });
}

/**
 * 发送 READY 并记录来源。
 *
 * @param source - READY 发送来源，区分首次发送与重试。
 * @returns void
 */
export function sendReadyWithDiagnostics(source: string): void {
    sendLog(
        'INFO',
        `Sending READY to extension: source=${source}, ctx.hasReceivedInit=${ctx.hasReceivedInit}`
    );
    ctx.messageSender.sendReady();
}

/**
 * 在未收到 INIT 时安排 READY 重试。
 *
 * @param delayMs - 延迟发送 READY 的毫秒数。
 * @param attempt - 当前重试序号。
 * @returns void
 */
export function scheduleReadyRetry(delayMs: number, attempt: number): void {
    setTimeout(() => {
        if (ctx.hasReceivedInit) {
            sendLog('DEBUG', `READY retry skipped because INIT arrived: attempt=${attempt}`);
            return;
        }

        sendLog(
            'WARN',
            `INIT not received yet, retrying READY: attempt=${attempt}, delayMs=${delayMs}`
        );
        updateBootStatus(`Webview 脚本已运行，但还没有收到 INIT，正在第 ${attempt} 次重发 READY。`);
        sendReadyWithDiagnostics(`retry-${attempt}`);
    }, delayMs);
}

/**
 * 只执行一次 Webview 初始化。
 *
 * @param source - 初始化触发来源，用于区分 DOMContentLoaded 或直接启动。
 * @returns void
 */
export function runInitializeOnce(source: string, initialize: () => void): void {
    if (ctx.hasInitialized) {
        sendLog('DEBUG', `Webview initialize skipped because it already ran: source=${source}`);
        return;
    }

    ctx.hasInitialized = true;
    updateBootStatus(`Webview 脚本已运行，初始化来源：${source}，正在等待扩展侧 INIT。`);
    sendLog('INFO', `Running Webview initialize: source=${source}`);
    initialize();
}
