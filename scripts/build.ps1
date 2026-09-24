$ErrorActionPreference = 'Stop'
$Root = Split-Parent $PSScriptRoot
Set-Location $Root
New-Item -ItemType Directory -Force -Path dist | Out-Null
$env:CGO_ENABLED='0'
$env:GOOS='windows'
$env:GOARCH='amd64'
$sha = (git rev-parse --short HEAD 2>$null)
if (-not $sha) { $sha = 'local' }
go test ./...
go build -trimpath -ldflags "-s -w -X main.version=$sha" -o dist/TDeltaFuuuk.exe ./cmd/hub
go build -trimpath -ldflags "-s -w -X main.version=$sha" -o dist/TDeltaAgent.exe ./cmd/agent
Write-Host "Built: dist/TDeltaFuuuk.exe"
Write-Host "Built: dist/TDeltaAgent.exe"
