/**
 * 通用无头 Chrome 探针（CDP 驱动，Node >= 21 内置 WebSocket）。
 *
 * 背景：--dump-dom 在 load 事件就输出，等不到动态 import 后的异步渲染；
 * --virtual-time-budget 在本项目的页面上会挂起（实测）。所以走 CDP：
 * 拉起无头 Chrome → 打开目标页 → 轮询页面表达式 → 拿到结果后杀掉 Chrome。
 *
 * 用法：
 *   node scripts/headless-probe.mjs <url> [等待完成的JS表达式] [超时ms] [结果JS表达式]
 *
 * 默认等待 `#diag` 元素出现（本项目复现页的约定：结果写进 #diag <pre>），
 * 完成后把 #diag 文本打到 stdout；超时则打印当前 #hint 与页面上的错误块。
 * 给了「结果JS表达式」时，完成条件满足后改为评估并打印该表达式的值
 * （returnByValue），用于抓取任意页面状态而不是 #diag。
 *
 * 例：
 *   node scripts/headless-probe.mjs "http://127.0.0.1:8740/test/repro/spikeMinicm.html?mode=cm"
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const url = process.argv[2];
/** 轮询的完成条件表达式（truthy 即完成），默认等 #diag */
const doneExpr =
    process.argv[3] ??
    "document.readyState === 'complete' && !!document.getElementById('diag')";
const timeoutMs = Number(process.argv[4] ?? 45000);
/** 完成后抓取的自定义结果表达式（可选，优先级高于 #diag 文本） */
const resultExpr = process.argv[5] ?? null;

if (!url) {
    console.error('用法: node scripts/headless-probe.mjs <url> [doneExpr] [timeoutMs]');
    process.exit(2);
}

/** 每轮评估的提取表达式：完成时抓 #diag，未完成抓 hint + 错误块。 */
const EXTRACT_EXPR = `(() => {
    const diag = document.getElementById('diag');
    if (diag) return { done: true, text: diag.textContent };
    const hint = (document.getElementById('hint') || {}).textContent || '';
    const errs = Array.from(document.querySelectorAll('pre'))
        .map((p) => p.textContent)
        .filter((t) => t.startsWith('ERROR') || t.startsWith('REJECTION'));
    return { done: (${doneExpr}), text: '', hint, errs };
})()`;

/** 解析 Chrome stderr 里的 DevTools ws 地址。 */
function waitDevToolsLine(proc) {
    return new Promise((resolve, reject) => {
        let buf = '';
        const onData = (chunk) => {
            buf += chunk.toString();
            const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
            if (m) {
                proc.stderr.off('data', onData);
                resolve(m[1]);
            }
        };
        proc.stderr.on('data', onData);
        proc.on('exit', () => reject(new Error('chrome 提前退出: ' + buf.slice(-500))));
        setTimeout(() => reject(new Error('等不到 DevTools listening 行')), 15000);
    });
}

async function main() {
    // 独立临时 profile，避免与日常 Chrome 互斥
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-probe-'));
    const chrome = spawn(CHROME, [
        '--headless=new',
        '--disable-gpu',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        'about:blank',
    ]);
    const kill = () => {
        try { chrome.kill('SIGKILL'); } catch { /* 已退出 */ }
    };
    process.on('exit', kill);
    process.on('SIGINT', () => { kill(); process.exit(130); });

    const browserWs = await waitDevToolsLine(chrome);
    const ws = new WebSocket(browserWs);
    await new Promise((res, rej) => {
        ws.onopen = res;
        ws.onerror = () => rej(new Error('ws 连接失败'));
    });

    // —— 极简 CDP 客户端：自增 id，按 id 配对响应 ——
    let seq = 0;
    const pending = new Map();
    /** 页面运行时异常（exceptionThrown 事件），超时时一并打印 */
    const pageExceptions = [];
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
        } else if (msg.method === 'Runtime.exceptionThrown') {
            const d = msg.params?.exceptionDetails;
            pageExceptions.push(
                (d?.exception?.description ?? d?.text ?? '(unknown)').split('\n').slice(0, 6).join('\n')
            );
        }
    };
    const send = (method, params = {}, sessionId = undefined) =>
        new Promise((resolve, reject) => {
            const id = ++seq;
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params, sessionId }));
        });

    // 开新标签页并附着（flatten 模式拿到 sessionId）
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    await send('Page.enable', {}, sessionId);
    await send('Page.navigate', { url }, sessionId);

    // 轮询完成条件
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        const result = await send(
            'Runtime.evaluate',
            { expression: EXTRACT_EXPR, returnByValue: true },
            sessionId
        );
        last = result?.result?.value ?? null;
        if (last?.done) break;
        await new Promise((r) => setTimeout(r, 500));
    }

    if (last?.done && resultExpr) {
        // 自定义结果表达式：完成后评估并打印（对象转 JSON）。
        // awaitPromise 让表达式可以返回 Promise —— 计时类探针要等
        // setTimeout / 换真泵跑完再取状态，否则量到的只是同步段。
        const result = await send(
            'Runtime.evaluate',
            { expression: resultExpr, returnByValue: true, awaitPromise: true },
            sessionId
        );
        // 表达式抛异常时 result 里没有 value，别静默打印 undefined
        if (result?.exceptionDetails) {
            console.log('结果表达式抛异常:', result.exceptionDetails.text);
            console.log(result.exceptionDetails.exception?.description ?? '');
            process.exitCode = 1;
        }
        const value = result?.result?.value;
        console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    } else if (last?.done && last.text) {
        console.log(last.text);
    } else {
        console.log('== 探针超时（未完成）==');
        console.log('hint:', last?.hint ?? '(无)');
        for (const e of last?.errs ?? []) console.log(e);
        for (const e of pageExceptions) console.log('页面异常:', e);
        process.exitCode = 1;
    }
    kill();
    process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
    console.error('headless-probe 失败:', err.message);
    process.exit(1);
});
