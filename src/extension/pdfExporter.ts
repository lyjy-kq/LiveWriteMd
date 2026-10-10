/**
 * LiveWriteMD PDF 导出器
 *
 * 思路是复用 HTML 导出的渲染结果：先把 Markdown 渲染成独立的 HTML 文档，
 * 再交给本机已安装的 Chromium 系浏览器（Edge / Chrome）用无头模式打印成 PDF。
 * 这样数学公式、代码高亮、Mermaid 图的排版和 HTML 导出保持完全一致，
 * 也不需要往扩展里塞一个几十 MB 的排版引擎。
 *
 * @module extension/pdfExporter
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { renderMarkdownFile, resolveMarkdownTargetUri } from './htmlExporter.js';
import { Logger } from './logger.js';

// =============================================================================
// 常量
// =============================================================================

/**
 * 无头浏览器打印 PDF 的最长等待时间。
 *
 * Mermaid 和 highlight.js 都要从 CDN 加载，网络慢时耗时会明显拉长，
 * 所以这里给一个相对宽松的上限，超时后再提示用户。
 */
const PRINT_TIMEOUT_MS = 90000;

/**
 * 允许脚本（Mermaid 渲染）执行多久后再落盘成 PDF。
 *
 * 这个值同时决定了 PDF 生成前的等待时间：给得太短会出现图形未渲染的空框图。
 */
const VIRTUAL_TIME_BUDGET_MS = 15_000;

/**
 * 各平台上 Chromium 系浏览器的常见安装路径。
 *
 * 只做候选探测，找不到时再让用户用 liveWriteMd.pdfBrowserPath 手动指定。
 */
const BROWSER_CANDIDATES: Record<string, string[]> = {
    win32: [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
    darwin: [
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    linux: [
        '/usr/bin/microsoft-edge',
        '/usr/bin/microsoft-edge-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
    ],
};

// =============================================================================
// 浏览器定位
// =============================================================================

/**
 * 查找可用于无头打印的浏览器可执行文件。
 *
 * 查找顺序为：扩展配置 > 环境变量 > 平台常见安装路径。环境变量这一层是为了
 * 兼容已经装过 puppeteer 之类工具、习惯用 CHROME_PATH 指定浏览器的用户。
 *
 * @returns 浏览器可执行文件的绝对路径；都没找到时返回 null
 */
function findBrowserExecutable(): string | null {
    const configured = vscode.workspace
        .getConfiguration('liveWriteMd')
        .get<string>('pdfBrowserPath', '')
        .trim();
    if (configured) {
        if (fs.existsSync(configured)) {
            return configured;
        }
        Logger.warn(`配置的 PDF 浏览器路径不存在，忽略：${configured}`);
    }

    const fromEnv = [process.env.LIVEWRITEMD_BROWSER_PATH, process.env.CHROME_PATH]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.trim());
    for (const candidate of fromEnv) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }

    const platformCandidates = BROWSER_CANDIDATES[process.platform] ?? [];
    return platformCandidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

// =============================================================================
// 无头打印
// =============================================================================

/**
 * 调用浏览器把本地 HTML 打印成 PDF。
 *
 * @param browserPath - 浏览器可执行文件路径
 * @param htmlPath - 待打印的本地 HTML 文件路径
 * @param pdfPath - PDF 输出路径
 * @param headlessFlag - 无头模式参数，新版用 --headless=new，失败时会退回 --headless
 * @returns 打印成功返回 true；进程异常退出或没产出文件时返回 false
 */
async function runBrowserPrint(
    browserPath: string,
    htmlPath: string,
    pdfPath: string,
    headlessFlag: string
): Promise<boolean> {
    // 先清掉上一次的产物，否则本次打印失败时无法区分“新文件”和“旧文件”。
    try {
        fs.rmSync(pdfPath, { force: true });
    } catch {
        // 文件被占用时删不掉，下面的时间戳判断会兜住这种情况。
    }
    const startedAt = Date.now();

    // 独立的用户数据目录：否则用户已经开着浏览器时，命令只会往现有窗口里
    // 新开一个标签页，--print-to-pdf 不会真的执行。
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livewritemd-pdf-'));

    const args = [
        headlessFlag,
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        `--user-data-dir=${userDataDir}`,
        // 让页面上的脚本（Mermaid、highlight.js）跑完再出图。
        `--virtual-time-budget=${VIRTUAL_TIME_BUDGET_MS}`,
        // 两个参数分别对应新旧版本的“不要页眉页脚”，不认识的版本会自动忽略。
        '--no-pdf-header-footer',
        '--print-to-pdf-no-header',
        `--print-to-pdf=${pdfPath}`,
        pathToFileURL(htmlPath).href,
    ];

    try {
        await new Promise<void>((resolve, reject) => {
            execFile(
                browserPath,
                args,
                { timeout: PRINT_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
                (error) => {
                    // 浏览器退出码不为 0 时未必代表失败（常见于首次启动的杂音），
                    // 真正的判定标准是下面有没有产出 PDF 文件。
                    // 只有被超时掐掉的进程才算真正的失败，这里单独判一下 killed。
                    const killed = (error as { killed?: boolean } | null)?.killed;
                    if (killed) {
                        reject(new Error(`打印超时（${PRINT_TIMEOUT_MS / 1000} 秒）`));
                        return;
                    }
                    resolve();
                }
            );
        });
    } catch (error) {
        Logger.warn(
            `无头打印失败(${headlessFlag}): ${error instanceof Error ? error.message : String(error)}`
        );
        return false;
    } finally {
        // 用户数据目录是临时的，无论成功失败都清掉，避免在系统临时目录里堆积。
        try {
            fs.rmSync(userDataDir, { recursive: true, force: true });
        } catch {
            // 清理失败不影响导出结果，忽略即可。
        }
    }

    if (!fs.existsSync(pdfPath)) {
        return false;
    }

    // 必须确认 PDF 是本次运行写出来的：文件系统的时间戳精度有限，
    // 这里放宽 2 秒容差，只用来排除上一次遗留的旧文件。
    try {
        return fs.statSync(pdfPath).mtimeMs >= startedAt - 2000;
    } catch {
        // 查不到时间戳时按成功处理，文件毕竟真实存在。
        return true;
    }
}

// =============================================================================
// 命令处理
// =============================================================================

/**
 * 把 Markdown 文件一键导出为 PDF。
 *
 * 可从资源管理器右键菜单、LiveWriteMD 正文右键菜单或命令面板调用。
 *
 * @param uri - 目标 Markdown 文件 URI；省略时自动取当前活动文件
 * @returns Promise<void>
 */
export async function exportMarkdownAsPdf(uri?: vscode.Uri): Promise<void> {
    let tempHtmlPath: string | null = null;

    try {
        const targetUri = resolveMarkdownTargetUri(uri);
        if (!targetUri) {
            vscode.window.showWarningMessage('LiveWriteMD: 没有找到可导出的 Markdown 文件。');
            return;
        }

        const browserPath = findBrowserExecutable();
        if (!browserPath) {
            const choice = await vscode.window.showErrorMessage(
                'LiveWriteMD: 导出 PDF 需要本机的 Edge 或 Chrome 浏览器，但没有找到。',
                '手动指定路径'
            );
            if (choice === '手动指定路径') {
                await vscode.commands.executeCommand(
                    'workbench.action.openSettings',
                    'liveWriteMd.pdfBrowserPath'
                );
            }
            return;
        }

        Logger.info(`导出 PDF: ${targetUri.fsPath}，浏览器=${browserPath}`);
        const { html, title, basePath } = await renderMarkdownFile(targetUri);
        const pdfPath = `${basePath}.pdf`;

        // 临时 HTML 必须落在 md 文件同级目录，这样正文里的相对图片路径才解析得到。
        const htmlPath = path.join(
            path.dirname(targetUri.fsPath),
            `.${path.basename(basePath)}.livewritemd-export-${Date.now()}.html`
        );
        tempHtmlPath = htmlPath;
        await vscode.workspace.fs.writeFile(vscode.Uri.file(htmlPath), Buffer.from(html, 'utf-8'));

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `LiveWriteMD: 正在导出 ${title}.pdf …`,
            },
            async () => {
                // 新版 Chrome/Edge 用 --headless=new；老版本不认这个参数，退回 --headless 再试一次。
                const printed =
                    (await runBrowserPrint(browserPath, htmlPath, pdfPath, '--headless=new')) ||
                    (await runBrowserPrint(browserPath, htmlPath, pdfPath, '--headless'));

                if (!printed) {
                    throw new Error('浏览器没有生成 PDF 文件');
                }
            }
        );

        Logger.info(`PDF 已导出: ${pdfPath}`);
        const action = await vscode.window.showInformationMessage(
            `LiveWriteMD: 已导出 ${path.basename(pdfPath)}`,
            '打开 PDF'
        );
        if (action === '打开 PDF') {
            await vscode.env.openExternal(vscode.Uri.file(pdfPath));
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        Logger.error(
            `PDF 导出失败: ${errorMessage}`,
            error instanceof Error ? error : undefined
        );
        vscode.window.showErrorMessage(`LiveWriteMD: PDF 导出失败：${errorMessage}`);
    } finally {
        // 临时 HTML 只是打印用的中间产物，不留在用户目录里。
        if (tempHtmlPath) {
            try {
                fs.rmSync(tempHtmlPath, { force: true });
            } catch {
                // 清理失败不影响导出结果，忽略即可。
            }
        }
    }
}
