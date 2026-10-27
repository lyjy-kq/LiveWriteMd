/**
 * Webview 控制台日志转发（从 main.ts 拆出）。
 *
 * 两件事：
 * 1. sendLog —— 业务代码主动上报（只把 ERROR/WARN 桥给扩展侧）；
 * 2. console.* 包装 —— 镜像开关打开时把控制台输出同步给扩展侧。
 *
 * @module webview/host/logForward
 */

import { ctx } from './webviewContext.js';

/**
 * Webview 控制台镜像开关。
 *
 * 当前为黑屏问题排查阶段，保持开启以便把启动链路写入 LiveWriteMD 输出。
 * 待启动问题完全稳定后，可再按发布策略评估是否恢复关闭。
 */
const SHOULD_MIRROR_WEBVIEW_CONSOLE = false;

/**
 * 将 Webview 侧日志转成可发送到扩展侧的消息。
 *
 * 当控制台镜像开关关闭时，只保留错误和告警的消息桥接，
 * 避免正式包把 INFO / DEBUG 级别日志带到输出面板。
 *
 * @param level - 日志级别
 * @param args - 控制台原始参数
 * @returns void
 */
function forwardLog(level: 'DEBUG' | 'ERROR' | 'WARN' | 'INFO', args: unknown[]): void {
    if (!SHOULD_MIRROR_WEBVIEW_CONSOLE && level !== 'ERROR' && level !== 'WARN') {
        return;
    }

    const msg = args
        .map((a) => (typeof a === 'object' ? JSON.stringify(a, null, 0) : String(a)))
        .join(' ');
    if (msg.includes('[LiveWriteMD]')) {
        ctx.vscode.postMessage({ type: 'webviewLog', level, msg });
    }
}

const _origDebug = console.debug;
const _origLog = console.log;
const _origError = console.error;
const _origWarn = console.warn;

console.debug = (...args: unknown[]) => {
    if (SHOULD_MIRROR_WEBVIEW_CONSOLE) {
        _origDebug.apply(console, args);
        forwardLog('DEBUG', args);
    }
};
console.log = (...args: unknown[]) => {
    if (SHOULD_MIRROR_WEBVIEW_CONSOLE) {
        _origLog.apply(console, args);
        forwardLog('INFO', args);
    }
};
console.error = (...args: unknown[]) => {
    _origError.apply(console, args);
    if (SHOULD_MIRROR_WEBVIEW_CONSOLE) {
        forwardLog('ERROR', args);
    }
};
console.warn = (...args: unknown[]) => {
    if (SHOULD_MIRROR_WEBVIEW_CONSOLE) {
        _origWarn.apply(console, args);
        forwardLog('WARN', args);
    }
};

/**
 * 向扩展侧发送 Webview 日志。
 *
 * @param level - 日志级别。
 * @param msg - 日志内容。
 * @returns void
 */
export function sendLog(level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', msg: string): void {
    if (level === 'ERROR' || level === 'WARN') {
        ctx.vscode.postMessage({ type: 'webviewLog', level, msg });
    }

    // 正式包默认不把普通信息回写到 Webview 控制台，只保留错误和必要告警。
    if (level === 'ERROR') {
        console.error(`[LiveWriteMD Webview] ${msg}`);
    } else if (level === 'WARN' && SHOULD_MIRROR_WEBVIEW_CONSOLE) {
        console.warn(`[LiveWriteMD Webview] ${msg}`);
    } else if (SHOULD_MIRROR_WEBVIEW_CONSOLE) {
        console.log(`[LiveWriteMD Webview] ${msg}`);
    }
}
