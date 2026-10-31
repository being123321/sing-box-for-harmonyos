$ErrorActionPreference = 'Stop'
$toolsRoot = 'C:\Users\Administrator\Documents\Codex\2026-10-04\new-chat\work'
$goRoot = "$toolsRoot\ohos-go1.25\yourblacksky-ohos_golang_go-e746337"
$ndkRoot = "$toolsRoot\deveco-portable\sdk\default\openharmony\native"
$env:GOROOT = $goRoot
$env:GOTOOLCHAIN = 'local'
$env:GOPATH = "$toolsRoot\go-path"
$env:GOCACHE = "$toolsRoot\go-build-cache"
$env:GOOS = 'openharmony'
$env:GOARCH = 'arm64'
$env:CGO_ENABLED = '1'
$env:GOTMPDIR = "$PSScriptRoot\go-tmp"
New-Item -ItemType Directory -Force $env:GOTMPDIR | Out-Null
$env:TEMP = $env:GOTMPDIR
$env:TMP = $env:GOTMPDIR
$env:CC = "$ndkRoot\llvm\bin\clang.exe --target=aarch64-linux-ohos --sysroot=$ndkRoot\sysroot -D__MUSL__"
$env:CXX = "$ndkRoot\llvm\bin\clang++.exe --target=aarch64-linux-ohos --sysroot=$ndkRoot\sysroot -D__MUSL__"
Push-Location "$PSScriptRoot\HarmonyNet\core\go"
try {
  & "$goRoot\bin\go.exe" build -p=2 -mod=readonly -buildmode=c-shared -buildvcs=false -trimpath -tags 'with_gvisor,with_quic,with_utls,with_clash_api,with_tailscale,badlinkname,tfogo_checklinkname0' -ldflags '-X github.com/sagernet/sing-box/constant.Version=1.14.4 -s -w -buildid= -checklinkname=0' -o out/libharmonycore.so .
  if ($LASTEXITCODE -ne 0) { throw "Core build failed: $LASTEXITCODE" }
  Get-FileHash out/libharmonycore.so -Algorithm SHA256
} finally { Pop-Location }
