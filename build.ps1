param(
    [switch]$Test,
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcDir = Join-Path $root 'src'
$distDir = Join-Path $root 'dist'
$manifest = Join-Path $srcDir 'app.manifest'
# 服务方数据的唯一真源：编译时内嵌进 exe，运行时用 System.Web.Extensions 解析。
$providerData = Join-Path $root 'shared\providers.json'
if (-not (Test-Path $providerData)) {
    throw "Missing provider source: $providerData"
}

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

# 源码按职责分组。
#   shared  纯工具：配置、日志、JSON、浏览器探测、提示词拼装、IPC 契约与客户端
#   engine  CDP 与浏览器窗口：ChatDriver / EdgeHost / CdpClient
#   service 后台服务宿主：ServiceProgram / PipeHost / PipeServer
#   ui      托盘界面、设置、气泡、热键、截图
#   tests   无界面自测入口
#
# 部署形态（一个可执行文件，两种身份）：
#   BubbleAsk.exe          不带参数 → 托盘界面；带 --service → 无界面后台服务
#   BubbleAsk.Tests.exe    无界面自测
#
# 服务与界面是同一个 exe 的两种模式，所以不存在「两个文件必须放同一目录」的部署要求。
# 代价是引擎与界面同处一个编译单元，靠下面的 Lint 拦住界面直接 new ChatDriver。
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

$appSources = @($sharedSources) + @($engineSources) + @($serviceSources) + @($uiSources)
$testAllSources = @($sharedSources) + @($engineSources) + @($uiSources) + @($serviceSources) + @($testSources)

if ($appSources.Count -eq 0) {
    throw 'No .cs files found under src/shared, src/engine, src/service and src/ui.'
}
if ($testAllSources.Count -eq 0) {
    throw 'No .cs files found for the test target.'
}

# 界面组不得直接触达引擎：引擎只该由 --service 模式里的 PipeHost 持有。
# 一个 exe 两种身份意味着编译期不再隔离，所以用这条 Lint 顶上。
$engineLeaks = Select-String -Path (Join-Path $srcDir 'ui\*.cs') -Pattern '\b(ChatDriver|CdpClient|EdgeHost)\b'
if ($engineLeaks) {
    $detail = ($engineLeaks | ForEach-Object { "$($_.Filename):$($_.LineNumber)" }) -join ', '
    throw "src/ui 直接引用了 engine 类型（应由服务持有）: $detail"
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
    # 内嵌真源：保持单 exe，运行时从 ManifestResourceStream 读，不额外落文件
    $lines.Add("/resource:`"$providerData`",BubbleAsk.providers.json")
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
