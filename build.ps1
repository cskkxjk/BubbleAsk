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

$sources = Get-ChildItem $srcDir -Filter *.cs | ForEach-Object { $_.FullName }
if ($sources.Count -eq 0) {
    throw 'No .cs files in src.'
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
        [string]$ResponseFile
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
    foreach ($source in $sources) {
        $lines.Add("`"$source`"")
    }
    Set-Content -Path $ResponseFile -Value $lines -Encoding Default
    & $csc "@$ResponseFile"
    if ($LASTEXITCODE -ne 0) {
        throw "Build failed for $Target (exit $LASTEXITCODE)"
    }
}

$appOut = Join-Path $distDir 'BubbleAsk.exe'
Write-Host "Building $appOut"
Build-Target -Target 'winexe' -EntryPoint 'BubbleAsk.Program' -Output $appOut -ResponseFile (Join-Path $distDir 'app.rsp')

$testOut = Join-Path $distDir 'BubbleAsk.Tests.exe'
Write-Host "Building $testOut"
Build-Target -Target 'exe' -EntryPoint 'BubbleAsk.TestProgram' -Output $testOut -ResponseFile (Join-Path $distDir 'tests.rsp')

Write-Host "Build OK: $appOut"
if ($Test) {
    Write-Host 'Running self tests...'
    & $testOut (Join-Path $distDir 'selftest')
    exit $LASTEXITCODE
}
