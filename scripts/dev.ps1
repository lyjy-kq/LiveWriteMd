<#
.SYNOPSIS
    LiveWriteMD 扩展的「构建 / 打包 / 安装 / 调试」一条龙脚本。

.DESCRIPTION
    把平时手动敲的几条命令收在一个脚本里，五种模式：

      build    只构建 dist/（接在 VS Code 的 F5 前面当 preLaunchTask 用）
      package  构建 + 打包出 .vsix（默认）
      install  构建 + 打包 + 覆盖安装到本机 VS Code
      debug    构建 + 用 CLI 起一个独立的扩展开发宿主，并等调试端口就绪（F5 用这个）
      watch    只起增量构建（前台阻塞，改代码自动重编）

    package / install 打包前会自动把 package.json 的补丁版本号 +1
    （语义化版本 x.y.z 的 z，预发布后缀保留），保证每次出包版本号唯一、
    VS Code 能识别为新版本；用 -NoVersionBump 可跳过（打包失败重试时用）。

    脚本本身不重复实现打包逻辑，而是转发到 package.json 里的 npm script，
    保证和 IDE 里点任务、CI 里跑命令的行为完全一致。

.PARAMETER Mode
    build / package（默认）/ install / debug / watch，见上面的说明。

.PARAMETER File
    可选。用扩展开发宿主或已安装的 VS Code 打开某个 Markdown 文件，
    例如 -File .\README.md，省得自己再去点文件。

.PARAMETER Port
    debug 模式下的扩展宿主调试端口（Node inspector），默认 9229。
    脚本会等到端口真正开始监听才返回；之后在 VS Code 里用 F5 的 node attach
    配置（或「Attach to Running Extension Host」）挂上去下断点。

.PARAMETER BreakOnStart
    debug 模式下给扩展宿主加 --inspect-brk-extensions：宿主在激活扩展之前停住，
    等调试器 attach 后才继续。这样 src/extension/index.ts 这类激活阶段代码上的
    断点也能命中。单独手动跑脚本时别加 —— 忘了挂调试器的话窗口会一直卡着。

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

    # debug 模式：让扩展宿主等调试器 attach 后再激活（--inspect-brk-extensions）
    [switch]$BreakOnStart,

    # 强制走 pnpm
    [switch]$UsePnpm,

    # 跳过构建
    [switch]$SkipBuild,

    # 打包时不自动递增补丁版本号（默认 package/install 都会 +1；
    # 打包失败要用同一版本号重试时加这个）
    [switch]$NoVersionBump
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
    探测本机某个 TCP 端口是否已经有人监听（用于等扩展宿主的 inspector 起来）。
.DESCRIPTION
    用短超时的 BeginConnect + WaitOne，避免 Connect 在端口没人监听时卡很久。
    连接成功即说明端口已监听：Node 的 --inspect / --inspect-brk 在开始等待
    调试器时就已经把端口打开了，所以这个判断对两种模式都成立。
#>
function Test-TcpPort {
    param(
        [Parameter(Mandatory)][int]$Port,
        # 单次探测的超时（毫秒）。轮询里给个小的值即可，不影响外层总超时
        [int]$TimeoutMs = 300
    )

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch {
        # 端口没人监听 / 连接被拒都会抛到这里，统一当成「未就绪」
        return $false
    } finally {
        $client.Close()
    }
}

<#
.SYNOPSIS
    读取 package.json 里的版本号，拼出 vsix 文件名。
.DESCRIPTION
    必须和 scripts/package-vsix.mjs 的命名规则保持一致（livewrite-md<版本>.vsix），
    否则脚本会找不到刚打出来的包。
#>
function Get-VsixPath {
    $pkgPath = Join-Path $repoRoot 'package.json'
    $pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    return (Join-Path $repoRoot ("livewrite-md{0}.vsix" -f $pkg.version))
}

<#
.SYNOPSIS
    把 package.json 的补丁版本号 +1（x.y.z -> x.y.(z+1)）并写回。
.DESCRIPTION
    package / install 打包前调用：这样 VSIX 文件名、包内 extension/package.json
    都带新版本，VS Code 才会把它识别为一次更新而不是同版本覆盖。

    只做正则原地替换 version 那一行，不用 ConvertFrom/ConvertTo-Json 重写整个
    文件——后者会重排字段、改缩进、还可能触发 PS 5.1 的序列化深度问题。

    写回必须是「无 BOM 的 UTF-8」：PS 5.1 的 Set-Content -Encoding UTF8 会写 BOM，
    而 Node（vsce / JSON.parse）读到 BOM 会直接解析失败。
.OUTPUTS
    哈希表：Old = 旧版本号，New = 新版本号。
#>
function Update-PackagePatchVersion {
    $pkgPath = Join-Path $repoRoot 'package.json'
    $text = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8

    # 捕获：1=前缀引号部分 / 2=major / 3=minor / 4=patch / 5=后缀（含收尾引号）。
    # 后缀覆盖预发布与构建号，如 1.0.8-beta.1+20261010 原样保留。
    $pattern = '("version"\s*:\s*")(\d+)\.(\d+)\.(\d+)((?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?")'
    $m = ([regex]$pattern).Match($text)
    if (-not $m.Success) {
        throw "没能在 package.json 里匹配到 x.y.z 形式的 version 字段，版本号未改动：$pkgPath"
    }

    $g = $m.Groups
    # 后缀组带收尾引号，展示与拼接前先剥掉
    $suffix = $g[5].Value -replace '"$', ''
    $oldStr = '{0}.{1}.{2}{3}' -f $g[2].Value, $g[3].Value, $g[4].Value, $suffix
    $newVersion = '{0}.{1}.{2}{3}' -f $g[2].Value, $g[3].Value, ([int]$g[4].Value + 1), $suffix
    # 整段匹配文本的原样替回串（group1 前缀 + 新版本 + 收尾引号）
    $replacement = $g[1].Value + $newVersion + '"'
    # 直接按匹配区间做字符串切除替换（只此一处），避开正则替换串里 $ 的转义语义
    $newText = $text.Substring(0, $m.Index) + $replacement + $text.Substring($m.Index + $m.Length)

    # 无 BOM UTF-8 写回；换行符原样保留（只替换版本号片段）。
    # 不能用 Set-Content -Encoding UTF8：PS 5.1 会写 BOM，Node（vsce / JSON.parse）
    # 读到 BOM 直接解析失败。
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($pkgPath, $newText, $utf8NoBom)

    return @{ Old = $oldStr; New = $newVersion }
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
Write-Host "LiveWriteMD 开发脚本" -ForegroundColor Green
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
# 打包前：补丁版本号自动 +1（仅 package / install）
# =============================================================================
# 必须放在 npm run package:vsix 之前：VSIX 文件名和包内 extension/package.json
# 都从 package.json 读版本，先改了才能打出新版本号的包。build / debug / watch
# 不出包，不动版本号。
if (($Mode -eq 'package' -or $Mode -eq 'install') -and -not $NoVersionBump) {
    $bump = Update-PackagePatchVersion
    Write-Host ("==> 版本号自增：{0} -> {1}" -f $bump.Old, $bump.New) -ForegroundColor Cyan
} elseif ($NoVersionBump -and ($Mode -eq 'package' -or $Mode -eq 'install')) {
    $keepVer = (Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    Write-Host "==> 按 -NoVersionBump 保留当前版本号：$keepVer" -ForegroundColor Yellow
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

        # 刻意不传 --user-data-dir / --extensions-dir：
        # 传了的话开发宿主会用一份全新的空配置启动，主题、字号、配色全变回默认，
        # 和日常看到的编辑器差别很大，而且每次都要冷启动一个新实例（更慢）。
        # 现在改成复用当前 VS Code 的默认 profile：code 命令把请求转给已运行的实例，
        # 开发宿主窗口直接继承你的 workbench.colorTheme 和其它用户设置。
        # 仍然保留 --disable-extensions：其它插件不在开发宿主里加载，
        # 免得和正在开发的扩展抢同一个自定义编辑器。

        # --inspect-brk-extensions 会在激活扩展前停住，等调试器 attach；
        # 不加则是起好之后再 attach（激活阶段断点会错过）。
        # 两者都会先把 inspector 端口打开，所以下面的端口探测对它们一视同仁。
        $inspectFlag = if ($BreakOnStart) {
            "--inspect-brk-extensions=$Port"
        } else {
            "--inspect-extensions=$Port"
        }

        # 注意：这里不能加 --new-window。带上它的话 VS Code 会先把目标目录开成
        # 一个普通窗口，再把这个窗口 reload 成扩展开发宿主 —— 扩展宿主会起两次，
        # inspector 端口也跟着断一次，F5 的 attach 会挂到那个马上要被换掉的上，
        # 表现成「调试会话刚连上就断开」。不带这个参数时开发宿主窗口直接创建，
        # 扩展宿主只起一次，端口从出现到关闭都是稳定的。
        $devArgs = @(
            "--extensionDevelopmentPath=$repoRoot",
            '--disable-extensions',                              # 只加载开发中的扩展，排除其它插件干扰
            $inspectFlag                                         # 开调试端口，供调试器 attach
        )
        if ($File) {
            $devArgs += (Resolve-Path -LiteralPath $File).Path
        }

        Write-Host "调试端口：$Port" -ForegroundColor Yellow

        # 启动前先记下端口是不是被上一轮的调试宿主占着。
        # 如果已经开着，code 命令会复用那个实例并 reload 开发宿主窗口：
        # 旧监听会先释放，新监听要过一会儿才起来。两种情况分开等，
        # 才不会抢在旧宿主临死前 attach 上去。
        $portWasOpen = Test-TcpPort -Port $Port

        # code 命令本身很快就返回（只是把「开窗口」的请求转给 VS Code 实例），
        # 真正的等待在下面的端口轮询里，所以这里不会阻塞到窗口关闭。
        Invoke-Native -Exe $codeCli -Arguments $devArgs -What '启动扩展开发宿主'

        if ($portWasOpen) {
            # reload 场景：等旧宿主把端口让出来（正常 1~3 秒；最多等 15 秒）
            $freeDeadline = (Get-Date).AddSeconds(15)
            while ((Get-Date) -lt $freeDeadline -and (Test-TcpPort -Port $Port -TimeoutMs 200)) {
                Start-Sleep -Milliseconds 200
            }
        }

        # 等新宿主把 inspector 端口打开。首次启动要建 profile、加载内置扩展，
        # 60 秒上限足够宽裕；超时说明宿主没能起来（或端口被别的进程占了）。
        $readyDeadline = (Get-Date).AddSeconds(60)
        while ((Get-Date) -lt $readyDeadline -and -not (Test-TcpPort -Port $Port -TimeoutMs 200)) {
            Start-Sleep -Milliseconds 250
        }
        if (-not (Test-TcpPort -Port $Port -TimeoutMs 200)) {
            throw "等不到扩展宿主的调试端口 127.0.0.1:$Port。确认没有别的进程占用该端口，再重试。"
        }

        # 这一行是给 F5 的 preLaunchTask 看的：任务进程退出 = 端口已就绪 = 可以 attach。
        Write-Host "dev-host ready（inspector 127.0.0.1:$Port）" -ForegroundColor Green
        Write-Host "挂调试器：VS Code 里按 F5（node attach 配置）。" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "全部完成。" -ForegroundColor Green
