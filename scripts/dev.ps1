<#
.SYNOPSIS
    FlowMD 扩展的「构建 / 打包 / 安装 / 调试」一条龙脚本。

.DESCRIPTION
    把平时手动敲的几条命令收在一个脚本里，五种模式：

      build    只构建 dist/（接在 VS Code 的 F5 前面当 preLaunchTask 用）
      package  构建 + 打包出 .vsix（默认）
      install  构建 + 打包 + 覆盖安装到本机 VS Code
      debug    构建 + 用「扩展开发宿主」起一个新的 VS Code 窗口，并开好调试端口
      watch    只起增量构建（前台阻塞，改代码自动重编）

    脚本本身不重复实现打包逻辑，而是转发到 package.json 里的 npm script，
    保证和 IDE 里点任务、CI 里跑命令的行为完全一致。

.PARAMETER Mode
    build / package（默认）/ install / debug / watch，见上面的说明。

.PARAMETER File
    可选。用扩展开发宿主或已安装的 VS Code 打开某个 Markdown 文件，
    例如 -File .\README.md，省得自己再去点文件。

.PARAMETER Port
    debug 模式下的扩展宿主调试端口（Node inspector），默认 9229。
    起好之后在 VS Code 里选「Attach to Running Extension Host」即可下断点。

.PARAMETER UsePnpm
    改用 pnpm 执行构建与打包。默认走 npm：本仓库的 pnpm 环境存在
    「Ignored build scripts: esbuild」未授权问题，会直接 ERR_PNPM_IGNORED_BUILDS 报错，
    需要先执行 pnpm approve-builds 授权；npm 则开箱可用。

.PARAMETER SkipBuild
    跳过构建，直接用现有的 dist/（想省时间、或 dist 刚构建过时用）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\dev.ps1
    默认：构建并打包出 vsix。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\dev.ps1 -Mode install -File .\README.md
    打包、覆盖安装到本机 VS Code，并打开 README.md 验收。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\dev.ps1 -Mode debug
    起扩展开发宿主（带 9229 调试端口），可以挂调试器打断点。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\dev.ps1 -Mode build
    只构建。VS Code 的 F5（.vscode/launch.json）就是拿这个当 preLaunchTask 的。

.NOTES
    如果 PowerShell 提示「禁止运行脚本」，用上面的 -ExecutionPolicy Bypass 方式调用，
    或者先执行：Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
#>

[CmdletBinding()]
param(
    # 运行模式
    [ValidateSet('build', 'package', 'install', 'debug', 'watch')]
    [string]$Mode = 'package',

    # 可选：要一起打开的 Markdown 文件
    [string]$File = '',

    # debug 模式的调试端口
    [int]$Port = 9229,

    # 强制走 pnpm
    [switch]$UsePnpm,

    # 跳过构建
    [switch]$SkipBuild
)

# 出错就停，避免「构建失败还接着打包」这种连锁误操作
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 控制台输出编码。Windows PowerShell 5.1 默认按系统 ANSI 代码页（中文机器是 GBK）
# 往管道里写字节，而 VS Code 的任务面板和 Git Bash 都按 UTF-8 解 —— 于是脚本里所有
# Write-Host 的中文在 F5 的任务输出里全是乱码。显式设成 UTF-8 让两边对齐；
# 这同时也决定 PowerShell 解码原生命令输出时用的编码，所以 npm 的中文提示也跟着正常了
# （Node 往管道里写的本来就是 UTF-8，之前是被按 GBK 解错了）。
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
    # 少数宿主下拿不到 Console（输出被重定向到不支持的流时会抛），失败不影响构建，忽略即可
}

# =============================================================================
# 基础工具
# =============================================================================

# 仓库根目录 = scripts 目录的上一级
$repoRoot = Split-Path -Parent $PSScriptRoot

<#
.SYNOPSIS
    校验刚打出的 VSIX 是否「干净」，可安全上传市场。
.DESCRIPTION
    直接读取 VSIX(ZIP) 内的条目名做两道检查：
      1. 不得混入开发目录：extension/test、extension/scripts、extension/.vscode、src；
      2. 不得含非 ASCII 文件名——中文名会被上传端归并成同一个 '????' key，
         触发 "Item has already been added" 报错。
    任一不通过：删除该坏包并抛错，强制先修 .vscodeignore 再重打，
    避免把坏包传到市场才发现。
.PARAMETER VsixPath
    待校验的 .vsix 绝对路径。
#>
function Test-VsixReleaseReady {
    param([Parameter(Mandatory)][string]$VsixPath)

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($VsixPath)
    $bad = @()
    try {
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName
            # 只看包内 extension/ 下的实际文件
            if ($name -match '^extension/(test|scripts|\.vscode|src)/') {
                $bad += "混入开发文件：$name"
            }
            # 非 ASCII 字符（中文名等）
            if ($name -match '[^\x00-\x7F]') {
                $bad += "含非 ASCII 文件名：$name"
            }
        }
    } finally {
        $zip.Dispose()
    }

    if ($bad.Count -gt 0) {
        Remove-Item -LiteralPath $VsixPath -Force
        throw ("VSIX 不可发布，已删除坏包。请先在 .vscodeignore 排除对应内容后重打：`n  " +
            ($bad -join "`n  "))
    }
}

<#
.SYNOPSIS
    执行外部命令并在失败时抛错。
.DESCRIPTION
    PowerShell 不会因为原生命令返回非 0 就中断（$ErrorActionPreference 管不到），
    所以这里手动检查 $LASTEXITCODE，保证失败能及时暴露。
#>
function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$Exe,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$What
    )

    Write-Host "==> $What" -ForegroundColor Cyan
    Write-Host "    $Exe $($Arguments -join ' ')" -ForegroundColor DarkGray

    # PowerShell 5.1 的坑：$ErrorActionPreference = 'Stop' 时，原生命令往 stderr 写任何东西
    # 都会被当成异常抛出。而 npm / vsce 的进度信息恰好走 stderr（比如 vsce 打包完的
    # "Files included in the VSIX"），会让脚本在打包成功后直接中断。
    # 这里临时放宽成 Continue，成败一律以退出码为准。
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Exe @Arguments
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }

    if ($exitCode -ne 0) {
        throw "$What 失败（退出码 $exitCode）"
    }
}

<#
.SYNOPSIS
    找 VS Code 的命令行入口 code(.cmd)。
.DESCRIPTION
    先看 PATH，再退回到几个常见安装位置；都找不到返回 $null，
    由调用方决定是报错还是只给提示。
#>
function Find-CodeCli {
    $onPath = Get-Command code -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'),
        (Join-Path $env:ProgramFiles 'Microsoft VS Code\bin\code.cmd'),
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft VS Code\bin\code.cmd')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }
    return $null
}

<#
.SYNOPSIS
    读取 package.json 里的版本号，拼出 vsix 文件名。
.DESCRIPTION
    必须和 scripts/package-vsix.mjs 的命名规则保持一致（lyjy-obsidianlike-md<版本>.vsix），
    否则脚本会找不到刚打出来的包。
#>
function Get-VsixPath {
    $pkgPath = Join-Path $repoRoot 'package.json'
    $pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    return (Join-Path $repoRoot ("lyjy-obsidianlike-md{0}.vsix" -f $pkg.version))
}

# =============================================================================
# 环境探测
# =============================================================================

if (-not (Test-Path (Join-Path $repoRoot 'package.json'))) {
    throw "没找到 package.json，请把脚本放在仓库的 scripts/ 目录下：$repoRoot"
}
if (-not (Test-Path (Join-Path $repoRoot 'node_modules'))) {
    throw "还没装依赖。先在仓库根目录执行：npm install（或 pnpm install）"
}

# 包管理器：默认 npm。虽然仓库里有 pnpm-lock.yaml，但本机 pnpm 没授权 esbuild 的
# 构建脚本（ERR_PNPM_IGNORED_BUILDS），拿它跑构建会直接失败；要改用 pnpm 就显式加 -UsePnpm。
if ($UsePnpm -and -not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw "指定了 -UsePnpm，但本机没装 pnpm。"
}
$pm = if ($UsePnpm) { 'pnpm' } else { 'npm' }

Write-Host ""
Write-Host "FlowMD 开发脚本" -ForegroundColor Green
Write-Host "  仓库：$repoRoot"
Write-Host "  模式：$Mode"
Write-Host "  包管理器：$pm"
Write-Host ""

# =============================================================================
# 构建（除 watch 外的模式都会先构建，保证 dist 是最新的）
# =============================================================================

if (-not $SkipBuild -and $Mode -ne 'watch') {
    Invoke-Native -Exe $pm -Arguments @('run', 'build') -What '构建 dist/（extension + webview）'
} elseif ($SkipBuild) {
    Write-Host "==> 按 -SkipBuild 跳过构建，直接使用现有 dist/" -ForegroundColor Yellow
}

# =============================================================================
# 各模式的具体动作
# =============================================================================

switch ($Mode) {
    'build' {
        # 什么都不用做：上面那段已经构建完了。
        # 保留这个分支是为了让「构建」本身成为一个合法的模式
        # （F5 的 preLaunchTask 要的就是「只构建、不起窗口、不出包」）。
    }

    'watch' {
        # 前台阻塞：Ctrl+C 结束
        Invoke-Native -Exe $pm -Arguments @('run', 'watch') -What '增量构建（Ctrl+C 退出）'
    }

    'package' {
        Invoke-Native -Exe $pm -Arguments @('run', 'package:vsix') -What '打包 VSIX'

        $vsix = Get-VsixPath
        if (-not (Test-Path $vsix)) {
            throw "打包命令跑完了，但没找到产物：$vsix"
        }
        # 发布前守卫：包内不得含开发目录 / 非 ASCII 文件名，否则删除坏包并报错
        Test-VsixReleaseReady -VsixPath $vsix
        $info = Get-Item -LiteralPath $vsix
        Write-Host ""
        Write-Host "打包完成：" -ForegroundColor Green
        Write-Host ("  {0}" -f $info.FullName)
        Write-Host ("  {0:N2} MB   {1}" -f ($info.Length / 1MB), $info.LastWriteTime)
        Write-Host ""
        Write-Host "安装到本机 VS Code：" -ForegroundColor Yellow
        Write-Host "  code --install-extension `"$($info.FullName)`" --force"
        Write-Host "或者直接跑：.\scripts\dev.ps1 -Mode install"
    }

    'install' {
        $codeCli = Find-CodeCli
        if (-not $codeCli) {
            throw "没找到 VS Code 的 code 命令。可以在 VS Code 里按 Ctrl+Shift+P 执行「Shell Command: Install 'code' command in PATH」后重试。"
        }

        Invoke-Native -Exe $pm -Arguments @('run', 'package:vsix') -What '打包 VSIX'

        $vsix = Get-VsixPath
        if (-not (Test-Path $vsix)) {
            throw "打包命令跑完了，但没找到产物：$vsix"
        }
        # 同样做发布前守卫，保证安装/上传的都是干净包
        Test-VsixReleaseReady -VsixPath $vsix

        # --force：已装同版本时直接覆盖，不用先卸载
        Invoke-Native -Exe $codeCli -Arguments @('--install-extension', $vsix, '--force') -What '安装到本机 VS Code'

        Write-Host ""
        Write-Host "安装完成。已打开的窗口需要重新加载才生效：" -ForegroundColor Green
        Write-Host "  Ctrl+Shift+P → Developer: Reload Window"

        if ($File) {
            $target = (Resolve-Path -LiteralPath $File).Path
            Invoke-Native -Exe $codeCli -Arguments @($target) -What "打开 $target"
        }
    }

    'debug' {
        $codeCli = Find-CodeCli
        if (-not $codeCli) {
            throw "没找到 VS Code 的 code 命令，无法启动扩展开发宿主。"
        }

        # 用和 .vscode/launch.json 完全相同的独立 user-data / extensions 目录，
        # 这样命令行起的调试宿主和按 F5 起的宿主是同一套环境，互不污染正式环境。
        $userDataDir = Join-Path $repoRoot '.vscode\.flowmd-dev-userdata'
        $extensionsDir = Join-Path $repoRoot '.vscode\.flowmd-dev-extensions'

        $devArgs = @(
            "--extensionDevelopmentPath=$repoRoot",
            '--disable-extensions',                              # 只加载开发中的扩展，排除其它插件干扰
            "--user-data-dir=$userDataDir",
            "--extensions-dir=$extensionsDir",
            "--inspect-extensions=$Port",                        # 开调试端口，供「Attach」挂接
            '--new-window'
        )
        if ($File) {
            $devArgs += (Resolve-Path -LiteralPath $File).Path
        }

        Write-Host "调试端口：$Port" -ForegroundColor Yellow
        Write-Host "挂调试器：VS Code 里选「Attach to Running Extension Host」运行配置。" -ForegroundColor Yellow
        Write-Host "注意：如果同目录已经开着一个开发宿主窗口，先全部关掉再跑，" -ForegroundColor Yellow
        Write-Host "      否则新窗口会复用旧进程，--inspect-extensions 不生效。" -ForegroundColor Yellow
        Write-Host ""

        # 这个命令会阻塞到宿主窗口关闭为止
        Invoke-Native -Exe $codeCli -Arguments $devArgs -What '启动扩展开发宿主'
    }
}

Write-Host ""
Write-Host "全部完成。" -ForegroundColor Green
