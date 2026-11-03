/**
 * 真实鼠标点击探针（CDP Input.dispatchMouseEvent）。
 *
 * headless-probe.mjs 的「合成 MouseEvent」和真实点击有差别：真实点击会先
 * 经过浏览器命中测试、指针捕获、原生选区等一系列步骤。排查「点击落点」
 * 类问题时，只有这个探针能给出可信结论。
 *
 * 用法：
 *   node scripts/headless-click-probe.mjs <url> <等待表达式> <取点表达式> [超时ms] [点击后表达式]
 *
 * - 等待表达式：truthy 即认为页面就绪（和 headless-probe 一致）
 * - 取点表达式：返回 { x, y, ... }，探针会在 (x, y) 派发一次真实左键点击
 * - 点击后表达式：点击完成并等待 400ms 后求值，打印其结果
 *
 * 例：
 *   node scripts/headless-click-probe.mjs "http://127.0.0.1:8740/..." "!!document.querySelector('#x')" "(()=>({x:100,y:200}))"
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const url = process.argv[2];
const waitExpr = process.argv[3] ?? 'document.readyState === "complete"';
const pointExpr = process.argv[4] ?? 'null';
const timeoutMs = Number(process.argv[5] ?? 60000);
const afterExpr = process.argv[6] ?? 'null';

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
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-click-'));
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

    let seq = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
        }
    };
    const send = (method, params = {}, sessionId = undefined) =>
        new Promise((resolve, reject) => {
            const id = ++seq;
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params, sessionId }));
        });

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    await send('Page.enable', {}, sessionId);
    // 复现 Windows 高分屏缩放：DPR 用环境变量覆盖（默认 1）
    await send(
        'Emulation.setDeviceMetricsOverride',
        {
            width: 1400,
            height: 1000,
            deviceScaleFactor: Number(process.env.PROBE_DPR ?? 1),
            mobile: false,
        },
        sessionId
    );
    await send('Page.navigate', { url }, sessionId);

    const evaluate = async (expression) => {
        const res = await send(
            'Runtime.evaluate',
            { expression, returnByValue: true, awaitPromise: true },
            sessionId
        );
        if (res?.exceptionDetails) {
            throw new Error(
                '表达式异常: ' + (res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
            );
        }
        return res?.result?.value;
    };

    // 等页面就绪
    const deadline = Date.now() + timeoutMs;
    let ready = false;
    while (Date.now() < deadline) {
        try { ready = !!(await evaluate(waitExpr)); } catch { ready = false; }
        if (ready) break;
        await new Promise((r) => setTimeout(r, 200));
    }
    if (!ready) throw new Error('等待超时：' + waitExpr);

    // 取点（允许返回 Promise）
    const point = await evaluate(pointExpr);
    if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') {
        throw new Error('取点表达式没有返回 {x, y}: ' + JSON.stringify(point));
    }

    // 真实左键点击：按下 → 松开
    const base = {
        x: point.x,
        y: point.y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
        pointerType: 'mouse',
    };
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 }, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 }, sessionId);
    await new Promise((r) => setTimeout(r, 400));

    const after = await evaluate(afterExpr);
    console.log(JSON.stringify({ point, after }, null, 2));

    kill();
    process.exit(0);
}

main().catch((err) => {
    console.error('headless-click-probe 失败:', err.message);
    process.exit(1);
});
