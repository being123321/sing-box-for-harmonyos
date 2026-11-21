# sing-box for HarmonyOS 1.30

此归档对应 `sing-box-HarmonyOS-1.30-arm64-unsigned.hap`。包名为 `com.harmonynet.assistant`，内部版本号为 `1000152`，内核为 sing-box `1.14.4`。产物未签名。编译、目标和最低兼容 SDK 分别为 26.0.0、26.0.0 和 6.0.2（API 22）。

1. 使用 DevEco Studio 自带的 HarmonyOS SDK 26.0.0.105，以及包含本仓库 `third_party/ohos-go` 对应适配的 Go 1.25.12。Go 模块版本由 `core/go/go.mod` 和 `go.sum` 锁定，sing-box 和 gVisor 使用本归档中的本地源码。
2. 在 `core/go` 下设置 `GOOS=openharmony`、`GOARCH=arm64`、`CGO_ENABLED=1` 和 `GOTOOLCHAIN=local`。令 `CC`/`CXX` 指向 SDK native LLVM 的 clang/clang++，并传入 `--target=aarch64-linux-ohos --sysroot=<SDK native sysroot> -D__MUSL__`。
3. 构建 HAP 使用的 Go 内核。

```text
go build -mod=readonly -buildmode=c-shared -buildvcs=false -trimpath -tags with_gvisor,with_quic,with_utls,with_clash_api,with_tailscale,badlinkname,tfogo_checklinkname0 -ldflags "-X github.com/sagernet/sing-box/constant.Version=1.14.4 -s -w -buildid= -checklinkname=0" -o out/libharmonycore.so .
```

4. 在 DevEco Studio 打开 `HarmonyNet`，使用归档里的 `build-profile.json5` 构建默认产品的 entry Release HAP。Hvigor 参数为 `assembleHap --mode module -p product=default -p module=entry@default -p buildMode=release --no-daemon`。
5. 用 `node scripts/verify-hap-compression.mjs <unsigned.hap> <stripped-libharmonycore.so>` 核对包内内核和压缩。`BUILD-MANIFEST.json` 的哈希记录本次构建产物。重新构建或签名后应按实际文件重新计算哈希。

本次已通过构建和包体核验。尚未在真机上验证。
