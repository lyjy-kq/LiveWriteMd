/**
 * 浏览器调试的开发服务器（供 F5 → Chrome 调试使用）：
 *
 * 1. 用 esbuild 把 test/repro/browser.ts 打包成 browser.js，
 *    并开 **watch**：之后改 src/ 或 browser.ts，保存即自动重新打包，
 *    浏览器里刷新页面就是最新代码；
 * 2. 起一个只服务本机的静态服务器（仓库根为根），
 *    browser.html / browser.js / test 下的 md 文档都由它提供。
 *
 * 之所以必须走静态服务器而不是 file:// 直接打开：ES module 在
 * file:// 协议下会被 CORS 策略挡掉，页面白屏（实测）。
 *
 * 启动完成时打印 `dev-server ready` —— .vscode/tasks.json 靠这行
 * 判断后台任务已就绪、随后 F5 才会拉起 Chrome。
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { context } from 'esbuild';

/** 调试服务器端口（改了要同步改 .vscode/launch.json 里的 url） */
const PORT = 8740;

// 启动标记：tasks.json 的 background beginsPattern 靠它识别任务已开始，
// 必须在任何异步操作之前、且早于结尾的 "dev-server ready"
console.log('dev-server starting');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'test/repro/browser.ts');
const outfile = path.join(root, 'test/repro/browser.js');

// 端口占用检测：停止调试时本脚本（preLaunchTask 起的后台进程）不会被
// 自动终止，反复 F5 会再起一个实例，EADDRINUSE 报错且永远等不到
// "dev-server ready"、F5 卡死。检测到旧实例还活着就直接复用退出：
// 旧实例的 esbuild watch 与静态服务器都还在正常工作。
const portInUse = await new Promise((resolve) => {
    const tester = net.connect(PORT, '127.0.0.1');
    // 连上 = 已有服务器
    tester.on('connect', () => {
        tester.destroy();
        resolve(true);
    });
    // 连接失败 = 端口空闲
    tester.on('error', () => resolve(false));
});
if (portInUse) {
    console.log('dev-server ready (复用已有服务器)');
    process.exit(0);
}

// —— esbuild：先建 context，rebuild 出首版 bundle，再开 watch ——
const ctx = await context({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    // sourcemap 单独输出，Chrome DevTools 的 Sources 里能直接看到
    // test/repro/browser.ts 与 src/ 下的 TypeScript 源码并打断点
    sourcemap: true,
    loader: { '.css': 'text' },
});
ctx.watch();
await ctx.rebuild(); // 保证服务器开始接请求时 bundle 已存在

// —— 静态文件服务 ——
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    // 根路径 → 302 跳到调试页。必须跳转而不是直接吐内容：
    // 页面里 <script src="./browser.js"> 是相对**文档 URL**解析的，
    // 文档停在 `/` 时会解析成 `/browser.js`（404）；跳转后 URL 变成
    // /test/repro/browser.html，相对路径才正确
    if (urlPath === '/') {
        res.writeHead(302, { Location: '/test/repro/browser.html' });
        res.end();
        return;
    }
    const resolvedPath = urlPath;
    const filePath = path.join(root, resolvedPath);

    // 防路径穿越（filePath 必须仍在仓库根内）
    if (!filePath.startsWith(root)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('not found: ' + resolvedPath);
            return;
        }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
            'Cache-Control': 'no-store',
        });
        res.end(data);
    });
}).listen(PORT, '127.0.0.1', () => {
    // 这一行是 tasks.json background endsPattern 的就绪信号
    console.log(`dev-server ready at http://127.0.0.1:${PORT}/`);
});
