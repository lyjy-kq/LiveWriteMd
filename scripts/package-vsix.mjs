#!/usr/bin/env node
/**
 * 文件用途：读取仓库版本号并按固定规则生成 VSIX 打包文件名。
 * 功能说明：该脚本由 `pnpm run package:vsix` 调用，最终输出 `livewrite-md<版本号>.vsix`。
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 读取并校验仓库根目录下的 `package.json` 版本号。
 * @param {string} packageJsonPath - `package.json` 文件的绝对路径。
 * @returns {string} 返回用于拼接 VSIX 文件名的版本号字符串。
 */
function readVersion(packageJsonPath) {
    // 读取 package.json 原文，确保版本号来源与项目配置一致。
    const packageJsonText = readFileSync(packageJsonPath, 'utf8');
    // 解析 package.json 并提取 version 字段。
    const packageJson = JSON.parse(packageJsonText);
    // 校验 version 字段，避免输出一个空文件名后缀。
    if (typeof packageJson.version !== 'string' || packageJson.version.trim() === '') {
        throw new Error(`package.json 中缺少有效的 version 字段：${packageJsonPath}`);
    }
    // 返回可直接拼接到文件名中的版本号。
    return packageJson.version.trim();
}

/**
 * 调用 VSCE 执行 VSIX 打包，并将输出文件写入指定路径。
 * @param {string} outputPath - 最终 VSIX 文件的完整输出路径。
 * @param {string} projectRoot - 仓库根目录路径。
 * @returns {void} 无返回值；失败时抛出异常。
 */
function packageVsix(outputPath, projectRoot) {
    // 根据当前平台选择可执行的打包入口，Windows 下通过 cmd.exe 间接调用 npx。
    const isWindows = process.platform === 'win32';
    const command = isWindows ? 'cmd.exe' : 'npx';
    // 使用本地或可用的 npx 执行 vsce，保持与现有打包方式一致。
    const spawnArgs = isWindows
        ? [
              '/d',
              '/s',
              '/c',
              'npx',
              '@vscode/vsce',
              'package',
              '--no-dependencies',
              '--skip-license',
              '-o',
              outputPath
          ]
        : ['@vscode/vsce', 'package', '--no-dependencies', '--skip-license', '-o', outputPath];
    // 设置子进程执行参数，确保工作目录和输出都固定在仓库内。
    const spawnOptions = {
        // 当前工作目录指向仓库根目录。
        cwd: projectRoot,
        // 子进程输出直接透传到终端。
        stdio: 'inherit',
        // 直接执行进程，避免 shell 带来的转义差异。
        shell: false
    };
    const result = spawnSync(command, spawnArgs, spawnOptions);

    // 检查打包结果，确保命令失败时把错误透出给调用方。
    if (result.status !== 0) {
        // 优先输出底层错误对象，方便排查可执行文件解析失败或权限问题。
        if (result.error instanceof Error) {
            throw result.error;
        }
        throw new Error(`VSIX 打包失败，退出码：${result.status ?? 'unknown'}`);
    }
}

/**
 * 脚本入口：计算仓库根目录、读取版本号并执行 VSIX 打包。
 * @returns {void} 无返回值；异常会导致进程退出失败。
 */
function main() {
    // 通过脚本位置反推出仓库根目录，确保命令在任意工作目录下都能运行。
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    // 仓库根目录位于 scripts 目录的上一级。
    const projectRoot = join(scriptDir, '..');
    // package.json 位于仓库根目录，用于读取版本号。
    const packageJsonPath = join(projectRoot, 'package.json');
    // 按目标规则拼出最终 VSIX 文件名。
    const version = readVersion(packageJsonPath);
    const outputPath = join(projectRoot, `livewrite-md${version}.vsix`);
    // 执行实际打包流程。
    packageVsix(outputPath, projectRoot);
}

// 作为独立脚本执行时，直接进入主流程。
main();
