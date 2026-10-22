/**
 * 无头 Chrome 截图（CDP 驱动，Node >= 21 内置 WebSocket）。
 *
 * 与 headless-probe.mjs 同一套启动/CDP 骨架，区别是：
 * - 先设置视口尺寸与 deviceScaleFactor（截图清晰度）；
 * - 轮询页面的 `window.__shotReady`，就绪后再等一小段时间取帧；
 * - 用 Page.captureScreenshot 把 PNG 写到指定路径。
 *
 * 用法：
 *   node scripts/headless-shot.mjs <url> <out.png> [width] [height] [scale] [timeoutMs]
 *
 * 例：
 *   node scripts/headless-shot.mjs "http://127.0.0.1:8740/test/repro/shotFrame.html?shot=live" assets/screenshot-live-dark.png 1440 900 2
 *   node scripts/headless-shot.mjs "http://127.0.0.1:8740/assets/posters/poster-01.html" assets/posters/poster-01.png 794 1123 3
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const url = process.argv[2];
const outPath = process.argv[3];
const width = Number(process.argv[4] ?? 1440);
const height = Number(process.argv[5] ?? 900);
const scale = Number(process.argv[6] ?? 2);
const timeoutMs = Number(process.argv[7] ?? 60000);

if (!url || !outPath) {
    console.error(
        '用法: node scripts/headless-shot.mjs <url> <out.png> [width] [height] [scale] [timeoutMs]'
    );
    process.exit(2);
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    // 独立临时 profile，避免与日常 Chrome 互斥
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-shot-'));
    const chrome = spawn(CHROME, [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        'about:blank',
    ]);
    const kill = () => {
        try {
            chrome.kill('SIGKILL');
        } catch {
            /* 已退出 */
        }
    };
    process.on('exit', kill);
    process.on('SIGINT', () => {
        kill();
        process.exit(130);
    });

    const browserWs = await waitDevToolsLine(chrome);
    const ws = new WebSocket(browserWs);
    await new Promise((res, rej) => {
        ws.onopen = res;
        ws.onerror = () => rej(new Error('ws 连接失败'));
    });

    // —— 极简 CDP 客户端 ——
    let seq = 0;
    const pending = new Map();
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
                (d?.exception?.description ?? d?.text ?? '(unknown)')
                    .split('\n')
                    .slice(0, 6)
                    .join('\n')
            );
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
    // 固定视口 + 像素倍率：截图清晰度就靠它（A4 海报用 3 倍 ≈ 300dpi）
    await send(
        'Emulation.setDeviceMetricsOverride',
        { width, height, deviceScaleFactor: scale, mobile: false },
        sessionId
    );
    // 静态截图不需要动画（海报里的渐入动画会截到中间帧）
    await send(
        'Emulation.setEmulatedMedia',
        { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] },
        sessionId
    );

    await send('Page.navigate', { url }, sessionId);

    // 轮询就绪标志
    const deadline = Date.now() + timeoutMs;
    let ready = false;
    let shotError = null;
    while (Date.now() < deadline) {
        const result = await send(
            'Runtime.evaluate',
            {
                expression:
                    "({ready: window.__shotReady === true, error: window.__shotError || null})",
                returnByValue: true,
            },
            sessionId
        );
        const value = result?.result?.value ?? null;
        if (value?.ready) {
            ready = true;
            shotError = value.error;
            break;
        }
        await sleep(250);
    }

    if (!ready) {
        console.error('截图超时：页面没有在限定时间内设置 window.__shotReady');
        for (const e of pageExceptions) console.error('页面异常:', e);
        kill();
        process.exit(1);
    }
    if (shotError) {
        console.error('页面报告错误:', shotError);
        for (const e of pageExceptions) console.error('页面异常:', e);
        kill();
        process.exit(1);
    }

    // 就绪后再等一帧，让字体 / 动态 import / 布局全部稳定
    await sleep(500);

    const { data } = await send(
        'Page.captureScreenshot',
        { format: 'png', fromSurface: true, captureBeyondViewport: false },
        sessionId
    );
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
    console.log(`已截图: ${outPath} (${width}x${height} @${scale}x)`);
    for (const e of pageExceptions) console.error('页面异常:', e);

    kill();
    process.exit(0);
}

main().catch((err) => {
    console.error('headless-shot 失败:', err.message);
    process.exit(1);
});
