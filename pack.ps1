# 打包脚本：把三个交付物分别打成独立的 zip。
#
#   powershell -ExecutionPolicy Bypass -File .\pack.ps1
#   powershell -ExecutionPolicy Bypass -File .\pack.ps1 -SkipBuild    # 用已有的 dist
#
# 产物落在 packages\：
#   BubbleAsk-desktop-<ver>.zip        桌面端（BubbleAsk.exe）
#   BubbleAsk-dsh-plugin-<ver>.zip     DSH 插件（可直接作为插件安装来源）
#   BubbleAsk-chrome-extension-<ver>.zip  Chrome/Edge 扩展（解压后「加载已解压的扩展程序」）
param(
    [switch]$SkipBuild,
    [string]$OutDir = 'packages'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$outPath = Join-Path $root $OutDir
$stage = Join-Path $root '.tmp-pack'

# ---------- 版本号：各取各的真实来源，不手写 ----------
function Get-DesktopVersion {
    $file = Join-Path $root 'src\shared\IpcContract.cs'
    $match = Select-String -Path $file -Pattern 'AppVersion\s*=\s*"([^"]+)"'
    if (-not $match) { throw "没能从 IpcContract.cs 读出 AppVersion" }
    return $match.Matches[0].Groups[1].Value
}

function Get-PluginVersion {
    $file = Join-Path $root 'dsh-plugin\package.json'
    return (Get-Content $file -Raw | ConvertFrom-Json).version
}

function Get-ExtensionVersion {
    $file = Join-Path $root 'chrome-extension\manifest.json'
    return (Get-Content $file -Raw | ConvertFrom-Json).version
}

if (-not $SkipBuild) {
    Write-Host '== 构建桌面端 =='
    $shell = Get-Command pwsh -ErrorAction SilentlyContinue
    if ($shell) {
        & $shell.Source -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'build.ps1')
    } else {
        & powershell -ExecutionPolicy Bypass -File (Join-Path $root 'build.ps1')
    }
    if ($LASTEXITCODE -ne 0) { throw "build.ps1 失败（exit $LASTEXITCODE）" }
}

$exe = Join-Path $root 'dist\BubbleAsk.exe'
if (-not (Test-Path $exe)) { throw "找不到 $exe，先跑一次 build.ps1 或去掉 -SkipBuild" }

if (Test-Path $outPath) { Remove-Item $outPath -Recurse -Force }
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $outPath | Out-Null
New-Item -ItemType Directory -Force -Path $stage | Out-Null

function New-Package {
    param([string]$Name, [string]$SourceDir)

    $zip = Join-Path $outPath "$Name.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Compress-Archive -Path (Join-Path $SourceDir '*') -DestinationPath $zip -CompressionLevel Optimal
    $size = [math]::Round((Get-Item $zip).Length / 1KB, 1)
    Write-Host ("  {0,-40} {1,8} KB" -f "$Name.zip", $size)
    return $zip
}

$results = @()

# ---------- 1. 桌面端 ----------
$desktopVer = Get-DesktopVersion
$desktopStage = Join-Path $stage 'desktop'
New-Item -ItemType Directory -Force -Path $desktopStage | Out-Null
Copy-Item $exe $desktopStage
Copy-Item (Join-Path $root 'README.md') $desktopStage
# 单文件交付：--service 是同一个 exe 的参数，不需要第二个文件。
$note = @"
Bubble Ask 桌面端 $desktopVer
================================

双击 BubbleAsk.exe 即托盘常驻；网页版需要本机存在 Chromium 内核浏览器
（Edge / Chrome / Brave / Vivaldi / Opera / Chromium），首次按 Ctrl+Alt+D
打开窗口并登录一次 chat.deepseek.com，之后长期有效。

它同时是 DSH 插件的后台服务：同一个 BubbleAsk.exe 带 --service 参数运行
时会以无界面模式独占浏览器驱动。你不需要手动启动它 —— 托盘或插件需要时
会自动拉起，最后一个使用方退出 8 秒后自行退出。

这个包只有一个可执行文件，不存在「两个 exe 必须放在同一目录」的要求。
"@
Set-Content -Path (Join-Path $desktopStage '用法.txt') -Value $note -Encoding UTF8
$results += New-Package -Name "BubbleAsk-desktop-$desktopVer" -SourceDir $desktopStage

# ---------- 2. DSH 插件 ----------
$pluginVer = Get-PluginVersion
$pluginStage = Join-Path $stage 'dsh-plugin'
New-Item -ItemType Directory -Force -Path $pluginStage | Out-Null
$pluginSrc = Join-Path $root 'dsh-plugin'
Get-ChildItem $pluginSrc -Force | Where-Object { $_.Name -notin @('node_modules', '.git') } | ForEach-Object {
    Copy-Item $_.FullName -Destination $pluginStage -Recurse -Force
}
$results += New-Package -Name "BubbleAsk-dsh-plugin-$pluginVer" -SourceDir $pluginStage

# ---------- 3. Chrome 扩展 ----------
$extVer = Get-ExtensionVersion
$extStage = Join-Path $stage 'chrome-extension'
New-Item -ItemType Directory -Force -Path $extStage | Out-Null
$extSrc = Join-Path $root 'chrome-extension'
Get-ChildItem $extSrc -Force | ForEach-Object {
    Copy-Item $_.FullName -Destination $extStage -Recurse -Force
}
$results += New-Package -Name "BubbleAsk-chrome-extension-$extVer" -SourceDir $extStage

Remove-Item $stage -Recurse -Force

Write-Host ''
Write-Host "打包完成，产物在 $outPath："
Get-ChildItem $outPath | ForEach-Object { Write-Host ("  {0}  ({1:N1} KB)" -f $_.Name, ($_.Length / 1KB)) }
