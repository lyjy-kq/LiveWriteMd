/**
 * 系统已安装字体枚举。
 *
 * Webview 里的浏览器出于隐私考虑**不提供**枚举本机字体的接口
 * （`document.fonts` 只能看到网页自己声明/加载的字体），所以设置面板
 * 要列出「系统拥有的字体」，只能由扩展宿主进程（Node 侧）去查，再把
 * 字体家族名数组发给 webview。
 *
 * 各平台做法：
 * - Windows：PowerShell 调 .NET 的 `InstalledFontCollection`，拿到的是
 *   已经归并好的家族名（不会把 Bold / Italic 当成独立字体）。输出强制
 *   UTF-8，避免中文家族名（微软雅黑、宋体…）变成乱码。
 * - Linux：`fc-list : family`，一行可能有多个别名，按逗号拆开。
 * - macOS：`system_profiler SPFontsDataType -json`，递归收集 family /
 *   fullname 字段（命令较慢，所以结果进程内缓存，只跑一次）。
 *
 * 枚举失败时不抛错，返回空数组；设置面板会保留 schema 里那份常用字体
 * 作为兜底选项，功能不会因此不可用。
 *
 * @module extension/systemFonts
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 进程内缓存：同一扩展会话只枚举一次（装新字体后重开窗口才刷新）。 */
let cachedFonts: Promise<string[]> | null = null;

/** 清理单个字体家族名：去空白、丢掉垂直排版字体（Windows 里以 @ 开头）。 */
function normalizeName(raw: string): string {
    const name = raw.replace(/[\u0000-\u001f]/g, '').trim();
    if (!name || name.startsWith('@')) return '';
    return name;
}

/**
 * 去重并排序。Windows 不区分大小写，这里用小写名去重、保留第一次出现的写法。
 *
 * @param names 原始字体名
 * @returns 去重排序后的字体名
 */
function dedupeAndSort(names: string[]): string[] {
    const seen = new Map<string, string>();
    for (const raw of names) {
        const name = normalizeName(raw);
        if (!name) continue;
        const key = name.toLowerCase();
        if (!seen.has(key)) seen.set(key, name);
    }
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b, 'en'));
}

/**
 * Windows：用 PowerShell + System.Drawing 取安装字体家族。
 *
 * 用 -EncodedCommand 传脚本，避免中文/引号在命令行里被二次转义；
 * 输出前把 Console.OutputEncoding 切成 UTF-8，否则 Node 按 UTF-8 解码
 * GBK 输出会把「微软雅黑」这类名字读成乱码。
 */
async function listWindowsFonts(): Promise<string[]> {
    const script = [
        '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
        'Add-Type -AssemblyName System.Drawing',
        '(New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }',
    ].join('; ');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { timeout: 10000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
    );
    return stdout.split(/\r?\n/);
}

/** Linux：fontconfig 的字体家族列表。 */
async function listLinuxFonts(): Promise<string[]> {
    const { stdout } = await execFileAsync('fc-list', [':', 'family'], {
        timeout: 10000,
        maxBuffer: 4 * 1024 * 1024,
    });
    // 每行形如 "Noto Sans CJK SC,思源黑体 CN"，逗号分隔的是同族的不同别名
    return stdout
        .split(/\r?\n/)
        .flatMap((line) => line.split(','))
        .map((name) => name.trim());
}

/**
 * macOS：system_profiler 的 JSON 里字段层级不固定，递归收集 family /
 * fullname / _name 里看起来像家族名的值。
 */
function collectMacFamilies(node: unknown, out: string[]): void {
    if (Array.isArray(node)) {
        for (const item of node) collectMacFamilies(item, out);
        return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (typeof value === 'string') {
            // 只收家族相关字段；_name 常是文件名（Arial.ttf），去掉扩展名
            if (key === 'family' || key === 'fullname') {
                out.push(value);
            } else if (key === '_name' && /\.(ttf|otf|ttc|dfont)$/i.test(value)) {
                out.push(value.replace(/\.[^.]+$/, ''));
            }
        } else {
            collectMacFamilies(value, out);
        }
    }
}

/** macOS：system_profiler 字体信息（较慢，结果会被上层缓存）。 */
async function listMacFonts(): Promise<string[]> {
    const { stdout } = await execFileAsync(
        'system_profiler',
        ['SPFontsDataType', '-json'],
        { timeout: 20000, maxBuffer: 32 * 1024 * 1024 }
    );
    const out: string[] = [];
    collectMacFamilies(JSON.parse(stdout), out);
    return out;
}

/** 按当前平台枚举；未知平台返回空数组。 */
async function enumerateSystemFonts(): Promise<string[]> {
    if (process.platform === 'win32') return listWindowsFonts();
    if (process.platform === 'darwin') return listMacFonts();
    return listLinuxFonts();
}

/**
 * 取本机已安装字体家族名（带缓存）。
 *
 * 任何失败（命令不存在、超时、输出解析失败）都降级为空数组，
 * 由调用方决定怎么兜底，不向用户弹错误。
 *
 * @returns 去重排序后的字体家族名
 */
export function getSystemFonts(): Promise<string[]> {
    if (!cachedFonts) {
        cachedFonts = enumerateSystemFonts()
            .then(dedupeAndSort)
            .catch(() => []);
    }
    return cachedFonts;
}
