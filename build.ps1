param(
    [switch]$Test,
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcDir = Join-Path $root 'src'
$distDir = Join-Path $root 'dist'
$manifest = Join-Path $srcDir 'app.manifest'

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path $csc)) {
    throw 'Cannot find csc.exe from .NET Framework.'
}

if ($Clean -and (Test-Path $distDir)) {
    Remove-Item $distDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $distDir | Out-Null

# 源码按职责分组。分组只影响构建与阅读，不改任何运行期行为。
#   shared  纯工具：配置、日志、JSON、浏览器探测、提示词拼装（界面与引擎都要）
#   engine  CDP 与浏览器窗口：ChatDriver / EdgeHost / CdpClient（唯一持有者，见下）
#   service 后台服务的对外入口：PipeServer
#   ui      托盘界面、设置、气泡、热键、截图（不直接碰 CDP）
#   tests   无界面自测入口
#
# 阶段 1（当前）：四组仍全部编进同一个 BubbleAsk.exe，部署形态与之前完全一致。
# 阶段 2：service 单独成 BubbleAsk.Service.exe 并独占 engine；托盘改为管道客户端，
#         届时 $appSources 去掉 engine 与 service 两组。
function Get-GroupSources {
    param([string[]]$Groups)

    $files = New-Object System.Collections.Generic.List[string]
    foreach ($group in $Groups) {
        $dir = Join-Path $srcDir $group
        if (-not (Test-Path $dir)) {
            continue
        }
        Get-ChildItem $dir -Filter *.cs -File | Sort-Object Name | ForEach-Object { $files.Add($_.FullName) }
    }
    return $files
}

$sharedSources = Get-GroupSources @('shared')
$engineSources = Get-GroupSources @('engine')
$uiSources = Get-GroupSources @('ui')
$serviceSources = Get-GroupSources @('service')
$testSources = Get-GroupSources @('tests')

$appSources = @($sharedSources) + @($engineSources) + @($uiSources) + @($serviceSources)
$testAllSources = $appSources + @($testSources)

if ($appSources.Count -eq 0) {
    throw 'No .cs files found under src/<group>.'
}
if ($testAllSources.Count -eq 0) {
    throw 'No .cs files found for the test target.'
}

$references = @(
    'System.dll',
    'System.Core.dll',
    'System.Drawing.dll',
    'System.Windows.Forms.dll',
    'System.Web.Extensions.dll',
    'System.Management.dll',
    'System.Net.Http.dll'
)

function Build-Target {
    param(
        [string]$Target,
        [string]$EntryPoint,
        [string]$Output,
        [string]$ResponseFile,
        [string[]]$Sources
    )
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('/nologo')
    $lines.Add('/langversion:5')
    $lines.Add('/warn:4')
    $lines.Add('/codepage:65001')
    $lines.Add("/target:$Target")
    $lines.Add("/main:$EntryPoint")
    $lines.Add("/out:`"$Output`"")
    $lines.Add("/win32manifest:`"$manifest`"")
    foreach ($reference in $references) {
        $lines.Add("/r:$reference")
    }
    foreach ($source in $Sources) {
        $lines.Add("`"$source`"")
    }
    Set-Content -Path $ResponseFile -Value $lines -Encoding Default
    & $csc "@$ResponseFile"
    if ($LASTEXITCODE -ne 0) {
        throw "Build failed for $Target (exit $LASTEXITCODE)"
    }
}

$appOut = Join-Path $distDir 'BubbleAsk.exe'
Write-Host "Building $appOut ($($appSources.Count) sources)"
Build-Target -Target 'winexe' -EntryPoint 'BubbleAsk.Program' -Output $appOut -ResponseFile (Join-Path $distDir 'app.rsp') -Sources $appSources

$testOut = Join-Path $distDir 'BubbleAsk.Tests.exe'
Write-Host "Building $testOut ($($testAllSources.Count) sources)"
Build-Target -Target 'exe' -EntryPoint 'BubbleAsk.TestProgram' -Output $testOut -ResponseFile (Join-Path $distDir 'tests.rsp') -Sources $testAllSources

Write-Host "Build OK: $appOut"
if ($Test) {
    Write-Host 'Running self tests...'
    & $testOut (Join-Path $distDir 'selftest')
    exit $LASTEXITCODE
}
