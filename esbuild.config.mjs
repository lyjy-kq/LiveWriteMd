/**
 * LiveWriteMD Esbuild Watch Configuration
 *
 * This script drives the extension and webview rebuild loop used by
 * `pnpm run watch`. It supports both one-off builds and long-running watch
 * mode so the VS Code extension can be debugged with fresh bundles.
 */

import * as esbuild from 'esbuild';

/**
 * Build options shared by the extension and webview bundles.
 *
 * @returns {Promise<esbuild.BuildOptions>} Shared build configuration object.
 */
function createCommonOptions() {
    return {
        bundle: true,
        sourcemap: true,
        minify: true,
    };
}

/**
 * Create and optionally watch the extension bundle.
 *
 * @param {boolean} shouldWatch - Whether to keep watching for changes.
 * @returns {Promise<esbuild.BuildContext | esbuild.BuildResult>} The build handle or result.
 */
async function buildExtension(shouldWatch) {
    const options = {
        ...createCommonOptions(),
        entryPoints: ['src/extension/index.ts'],
        outfile: 'dist/extension.js',
        external: ['vscode'],
        format: 'cjs',
        platform: 'node',
    };

    if (shouldWatch) {
        const context = await esbuild.context(options);
        await context.watch();
        return context;
    }

    return esbuild.build(options);
}

/**
 * Create and optionally watch the webview bundle.
 *
 * @param {boolean} shouldWatch - Whether to keep watching for changes.
 * @returns {Promise<esbuild.BuildContext | esbuild.BuildResult>} The build handle or result.
 */
async function buildWebview(shouldWatch) {
    const options = {
        ...createCommonOptions(),
        entryPoints: ['src/webview/main.ts'],
        outfile: 'dist/webview.js',
        format: 'iife',
        platform: 'browser',
        loader: {
            '.css': 'text',
        },
    };

    if (shouldWatch) {
        const context = await esbuild.context(options);
        await context.watch();
        return context;
    }

    return esbuild.build(options);
}

/**
 * Run the build workflow.
 *
 * When `--watch` is passed, both bundles are kept in watch mode and the
 * process stays alive. Otherwise, a one-off build is performed.
 *
 * @returns {Promise<void>} Resolves when non-watch build finishes.
 */
async function main() {
    const shouldWatch = process.argv.includes('--watch');

    await Promise.all([buildExtension(shouldWatch), buildWebview(shouldWatch)]);

    if (!shouldWatch) {
        return;
    }

    // Keep the Node process alive while the esbuild contexts are watching.
    process.stdin.resume();
}

await main();

