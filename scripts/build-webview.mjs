/**
 * Webview 双入口构建脚本。
 *
 * - src/webview/main.ts        -> dist/webview.js      （customEditor 主编辑器）
 * - src/webview/mindmapPanel.ts -> dist/mindmapPanel.js（独立导图面板，§3.2）
 *
 * format=esm + splitting 让两个入口共享的 marked / KaTeX 等依赖
 * 自动拆到 dist/chunks，首屏只加载各自需要的 chunk。
 *
 * 用法：
 *   node scripts/build-webview.mjs          一次性构建（先清空 dist/chunks）
 *   node scripts/build-webview.mjs --watch  持续监听
 */

import { pathToFileURL } from 'node:url';
import { rmSync } from 'node:fs';
import * as esbuild from 'esbuild';

/**
 * 返回两个 webview 入口共用的 esbuild 配置。
 *
 * @returns {esbuild.BuildOptions} esbuild 构建配置
 */
export function createWebviewOptions() {
    return {
        entryPoints: {
            webview: 'src/webview/main.ts',
            mindmapPanel: 'src/webview/mindmapPanel.ts',
        },
        outdir: 'dist',
        entryNames: '[name]',
        chunkNames: 'chunks/[name]-[hash]',
        bundle: true,
        format: 'esm',
        splitting: true,
        platform: 'browser',
        sourcemap: true,
        minify: true,
        pure: ['console.debug'],
        loader: {
            '.css': 'text',
        },
        logLevel: 'info',
    };
}

/**
 * 一次性构建或进入 watch。
 *
 * @param {boolean} shouldWatch 是否持续监听
 * @returns {Promise<esbuild.BuildContext | esbuild.BuildResult>} esbuild 句柄
 */
export async function runWebviewBuild(shouldWatch) {
    const options = createWebviewOptions();
    if (shouldWatch) {
        const context = await esbuild.context(options);
        await context.watch();
        return context;
    }
    rmSync('dist/chunks', { recursive: true, force: true });
    return esbuild.build(options);
}

// 作为脚本直接执行时启动构建；被 esbuild.config.mjs import 时不自动执行。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const shouldWatch = process.argv.includes('--watch');
    await runWebviewBuild(shouldWatch);
    if (shouldWatch) {
        process.stdin.resume();
    }
}