param(
    [string]$XiaozhiServerDir = "",
    [string]$PluginDirName = "agy-xiaozhi-notifier"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$srcRoot = $PSScriptRoot
$dstRoot = Join-Path (Join-Path (Join-Path $env:USERPROFILE ".gemini") "config\plugins") $PluginDirName

Write-Host "[install] Target plugin dir: $dstRoot" -ForegroundColor Cyan
New-Item -ItemType Directory -Path $dstRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $dstRoot "assets") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $dstRoot "hooks") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $dstRoot "tests") -Force | Out-Null

$copyFiles = @(
    "plugin.json",
    "hooks.json",
    "config.example.json",
    "README.md",
    "LICENSE",
    "assets\logo.svg",
    "hooks\on-stop.mjs",
    "hooks\speak-worker.mjs",
    "tests\test-notifier.mjs"
)

foreach ($rel in $copyFiles) {
    $src = Join-Path $srcRoot $rel
    $dst = Join-Path $dstRoot $rel
    if (Test-Path $src) {
        Copy-Item -Path $src -Destination $dst -Force
    }
}

$cfgPath = Join-Path $dstRoot "config.json"
if (-not (Test-Path $cfgPath)) {
    $cfgObj = Get-Content -Path (Join-Path $dstRoot "config.example.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($XiaozhiServerDir) {
        $cfgObj.xiaozhiServerDir = $XiaozhiServerDir.Replace("\", "/")
    }
    $jsonOut = $cfgObj | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($cfgPath, $jsonOut + "`r`n", [System.Text.UTF8Encoding]::new($false))
    Write-Host "[install] Created initial config.json (xiaozhiServerDir=$($cfgObj.xiaozhiServerDir))" -ForegroundColor Green
} else {
    Write-Host "[install] Preserved existing config.json and cache/" -ForegroundColor DarkGreen
}

Write-Host "[install] Running plugin unit tests..." -ForegroundColor Cyan
& node --no-warnings --test (Join-Path $dstRoot "tests\test-notifier.mjs")
if ($LASTEXITCODE -ne 0) {
    throw "Unit tests failed after install!"
}

Write-Host "[install] Done! Restart or open Antigravity Customizations to manage '$PluginDirName'." -ForegroundColor Green
