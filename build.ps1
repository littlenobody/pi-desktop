# 重新打包 Pi Desktop（Windows / PowerShell）
#
# 用法（在本目录下执行）:
#   powershell -ExecutionPolicy Bypass -File .\build.ps1
#   powershell -ExecutionPolicy Bypass -File .\build.ps1 -Clean        # 同时删除 resources\app\node_modules 后重装
#   powershell -ExecutionPolicy Bypass -File .\build.ps1 -OutDir D:\PiDesktop
#
# 过程: 安装前端依赖 -> 下载 Electron 运行时 -> 复制 app 资源 -> 重命名并写入图标/版本信息。
param(
  [string]$OutDir = $PSScriptRoot,
  [string]$ElectronVersion = "41.10.7",
  [string]$Mirror = "https://cdn.npmmirror.com/binaries/electron",
  [string]$NpmRegistry = "https://registry.npmmirror.com",
  [switch]$Clean
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$appDir = Join-Path $root "resources\app"
$cache = Join-Path $root ".build"
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Force -Path $cache | Out-Null
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Host "==> 1/5 检查 Node.js" -ForegroundColor Cyan
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { throw "未找到 node，请先安装 Node.js 22 LTS: https://nodejs.org/" }
$nodeVersion = (& node -v).TrimStart("v")
Write-Host "    node $nodeVersion"

Write-Host "==> 2/5 安装/校验前端依赖 (resources/app)" -ForegroundColor Cyan
if ($Clean) { Remove-Item -Recurse -Force (Join-Path $appDir "node_modules") -ErrorAction SilentlyContinue }
if (-not (Test-Path (Join-Path $appDir "node_modules\monaco-editor"))) {
  Push-Location $appDir
  try {
    & npm install --omit=dev --ignore-scripts --no-audit --no-fund --registry=$NpmRegistry
    if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }
  } finally { Pop-Location }
}
Write-Host "==> 3/5 准备 Electron $ElectronVersion" -ForegroundColor Cyan
$zip = Join-Path $cache "electron-v$ElectronVersion-win32-x64.zip"
if (-not (Test-Path $zip)) {
  $url = "$Mirror/$ElectronVersion/electron-v$ElectronVersion-win32-x64.zip"
  Write-Host "    下载 $url"
  & curl.exe -L --fail -o $zip $url
  if ($LASTEXITCODE -ne 0) { throw "下载 Electron 失败，可手动下载后放到 $zip" }
}
$extract = Join-Path $cache "electron-win32-x64"
if (-not (Test-Path $extract)) {
  New-Item -ItemType Directory -Force -Path $extract | Out-Null
  Expand-Archive -Path $zip -DestinationPath $extract -Force
}

Write-Host "==> 4/5 组装到 $OutDir" -ForegroundColor Cyan
Copy-Item -Path (Join-Path $extract "*") -Destination $OutDir -Recurse -Force
$exe = Join-Path $OutDir "electron.exe"
if (Test-Path $exe) { Move-Item -Force $exe (Join-Path $OutDir "Pi Desktop.exe") }
Remove-Item -Force (Join-Path $OutDir "resources\default_app.asar") -ErrorAction SilentlyContinue
$targetApp = Join-Path $OutDir "resources\app"
if ($targetApp -ne $appDir) {
  Remove-Item -Recurse -Force $targetApp -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path (Split-Path $targetApp) | Out-Null
  Copy-Item -Path $appDir -Destination $targetApp -Recurse -Force
}
# 只清理输出副本: node-pty 的 tarball 带全平台预编译产物，仅保留 win32-x64
$pty = Join-Path $targetApp "node_modules\node-pty"
if (Test-Path $pty) {
  Get-ChildItem (Join-Path $pty "prebuilds") -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne "win32-x64" } | Remove-Item -Recurse -Force
  Get-ChildItem $pty -Recurse -Include *.pdb, *.map, *.test.js -File -ErrorAction SilentlyContinue | Remove-Item -Force
}
Get-ChildItem (Join-Path $targetApp "node_modules") -Recurse -Include *.map -File -ErrorAction SilentlyContinue | Remove-Item -Force

Write-Host "==> 5/5 写入图标与版本信息" -ForegroundColor Cyan
Push-Location $root
try {
  if (-not (Test-Path (Join-Path $root "node_modules\resedit"))) {
    & npm install --no-save --no-audit --no-fund --registry=$NpmRegistry resedit
  }
  & node (Join-Path $root "scripts\brand.js") (Join-Path $OutDir "Pi Desktop.exe")
} finally { Pop-Location }

Write-Host ""
Write-Host "完成! 双击运行: $(Join-Path $OutDir 'Pi Desktop.exe')" -ForegroundColor Green
Write-Host "（首次运行前请确认已安装 pi: npm install -g @earendil-works/pi-coding-agent）"
