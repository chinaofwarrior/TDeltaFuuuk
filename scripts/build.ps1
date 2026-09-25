# TDeltaFuuuk 构建/打包脚本（Node 零依赖，无编译步骤）
# 用法: .\scripts\build.ps1
# 输出: dist\ 目录（可直接分发给队友）

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist"

Write-Host "==> 校验源模块" -ForegroundColor Cyan
node (Join-Path $root "scripts\check.js")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> 清理 dist" -ForegroundColor Cyan
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Path $dist | Out-Null

Write-Host "==> 复制运行所需文件" -ForegroundColor Cyan
Copy-Item (Join-Path $root "src") $dist -Recurse
Copy-Item (Join-Path $root "webui") $dist -Recurse
Copy-Item (Join-Path $root "package.json") $dist
Copy-Item (Join-Path $root "sdk") $dist -Recurse
Copy-Item (Join-Path $root "README.md") $dist

Write-Host "==> 生成默认配置" -ForegroundColor Cyan
$agentCfg = @{ sharedToken = ""; hubUrl = ""; agentId = ""; providersDir = "src\providers" } | ConvertTo-Json
Set-Content -Path (Join-Path $dist "TDeltaAgent.config.json") -Value $agentCfg -Encoding UTF8

Write-Host ""
Write-Host "构建完成: $dist" -ForegroundColor Green
Write-Host "  Hub:   node `"$dist\src\hub.js`"" -ForegroundColor Green
Write-Host "  Agent: node `"$dist\src\agent.js`"" -ForegroundColor Green
