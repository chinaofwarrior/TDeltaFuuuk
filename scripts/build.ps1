$ErrorActionPreference="Stop"
$root=Split-Path -Parent $PSScriptRoot
Set-Location $root
node scripts/check.js
if($LASTEXITCODE -ne 0){throw "module check failed"}
node --test
if($LASTEXITCODE -ne 0){throw "tests failed"}
Remove-Item dist -Recurse -Force -ErrorAction SilentlyContinue
New-Item -Type Directory -Force dist,dist/runtime,dist/native | Out-Null
Copy-Item src dist -Recurse
Copy-Item webui dist -Recurse
Copy-Item package.json dist
Copy-Item README.md dist
Copy-Item (Get-Command node.exe).Source dist/runtime/node.exe
Push-Location cmd/launcher
try{
 go build -trimpath -ldflags "-s -w -X main.role=hub" -o ../../dist/TDeltaFuuuk.exe .
 if($LASTEXITCODE -ne 0){throw "Hub EXE failed"}
 go build -trimpath -ldflags "-s -w -X main.role=agent" -o ../../dist/TDeltaAgent.exe .
 if($LASTEXITCODE -ne 0){throw "Agent EXE failed"}
}finally{Pop-Location}
if(Get-Command cl.exe -ErrorAction SilentlyContinue){
 Push-Location native
 try{
 cl /nologo /W4 /EHsc /std:c++17 /Fe:../dist/native/tdf-provider-host.exe provider_host.cpp
 if($LASTEXITCODE -ne 0){throw "Native host failed"}
 cl /nologo /W4 /EHsc /std:c++17 /LD /Fe:../dist/native/example-provider.dll example_provider.cpp
 if($LASTEXITCODE -ne 0){throw "Native sample DLL failed"}
 }finally{Pop-Location}
}
Get-ChildItem dist -Recurse -Include *.exe,*.dll | Get-FileHash -Algorithm SHA256 |
 ForEach-Object { "$($_.Hash) $($_.Path)" } | Set-Content dist/SHA256SUMS.txt
