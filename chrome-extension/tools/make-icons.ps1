# 把 SVG 渲染成各尺寸 PNG 图标。
#
#   powershell -ExecutionPolicy Bypass -File .\chrome-extension\tools\make-icons.ps1
#
# 为什么要绕一圈浏览器：.NET 没有 SVG 光栅化能力，引第三方库又不划算。
# 无头 Edge 就是现成的、和用户实际渲染一致的渲染器。流程：
#   whale.svg →(headless Edge 512×512)→ 临时 PNG →(GDI+ 高质量缩放)→ 16/32/48/128
param(
    [string]$Source,
    [string]$SmallSource,
    [string]$OutDir
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$extRoot = Split-Path -Parent $here
if (-not $Source) { $Source = Join-Path $extRoot 'icons\whale.svg' }
if (-not $SmallSource) { $SmallSource = Join-Path $extRoot 'icons\whale-small.svg' }
if (-not $OutDir) { $OutDir = Join-Path $extRoot 'icons' }
if (-not (Test-Path $Source)) { throw "找不到 SVG: $Source" }

$edge = @(
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw '找不到 Edge 或 Chrome，无法渲染 SVG' }

$temp = Join-Path $env:TEMP ('ba-icon-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $temp | Out-Null

# 把一个 SVG 渲染成 512 的 PNG（无头浏览器），返回路径
function Render-Master {
    param([string]$SvgPath, [string]$Tag)

    $svg = Get-Content $SvgPath -Raw
    $html = @"
<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:512px;height:512px;background:transparent;overflow:hidden}
svg{display:block;width:512px;height:512px}
</style></head><body>
$svg
</body></html>
"@
    $htmlPath = Join-Path $temp "$Tag.html"
    Set-Content -Path $htmlPath -Value $html -Encoding UTF8

    $png = Join-Path $temp "$Tag-512.png"
    $fileUrl = 'file:///' + ($htmlPath -replace '\\', '/')
    & $edge --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 `
        --force-device-scale-factor=1 --screenshot="$png" --window-size=512,512 $fileUrl 2>&1 | Out-Null

    for ($i = 0; $i -lt 40 -and -not (Test-Path $png); $i++) { Start-Sleep -Milliseconds 250 }
    if (-not (Test-Path $png)) { throw "无头浏览器没有产出 $Tag 的截图" }
    return $png
}

# 把一张 512 主图缩到指定尺寸
function Export-Sizes {
    param([string]$MasterPng, [int[]]$Sizes)

    $master = [System.Drawing.Image]::FromFile($MasterPng)
    foreach ($size in $Sizes) {
        $bmp = New-Object System.Drawing.Bitmap $size, $size
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.DrawImage($master, 0, 0, $size, $size)
        $g.Dispose()
        $file = Join-Path $OutDir "icon$size.png"
        $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        Write-Host "  $file"
    }
    $master.Dispose()
}

try {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    # 大尺寸用细节版；16px 用专门的简化版（缩小细节必然糊）
    $bigMaster = Render-Master -SvgPath $Source -Tag 'big'
    Export-Sizes -MasterPng $bigMaster -Sizes 32, 48, 128
    if (Test-Path $SmallSource) {
        $smallMaster = Render-Master -SvgPath $SmallSource -Tag 'small'
        Export-Sizes -MasterPng $smallMaster -Sizes 16
    } else {
        Export-Sizes -MasterPng $bigMaster -Sizes 16
    }
}
finally {
    Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "图标已生成到 $OutDir"
