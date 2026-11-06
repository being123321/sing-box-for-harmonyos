# 构建 0.90.10 / 0.90.10 Beta 对应源码

解压后工程根目录为 HarmonyNet。BUILD-MANIFEST.json 标明本包应用及内核渠道，core/go/go.mod 已将 sing-box 和 gVisor 指向 third_party 相对目录。稳定包使用 sing-box 1.14.4，Beta 包使用 1.15.0-alpha.13；应用 versionCode 均为 1000119，不能互换内核。

1. 准备 DevEco Studio、HarmonyOS SDK API26 和 API22 兼容环境。安装工程 oh-package.json5 声明的依赖。
2. 使用 third_party/ohos-go 所含修订源码构建 OHOS Go 工具链（与清单中的 go_port_commit 及本地运行时修订对应），或使用同一工具链。普通 Go 不支持该目标。
3. 在 core/go 下配置 GOROOT、GOOS=openharmony、GOARCH=arm64、CGO_ENABLED=1，以及 SDK native LLVM 的 CC/CXX，target=aarch64-linux-ohos，sysroot 指向 SDK native/sysroot，定义 __MUSL__。
4. 构建命令：go build -p=2 -mod=readonly -buildmode=c-shared -buildvcs=false -trimpath -tags with_gvisor,with_quic,with_utls,with_clash_api,with_tailscale,badlinkname,tfogo_checklinkname0 -ldflags "-X github.com/sagernet/sing-box/constant.Version=CORE_VERSION -s -w -buildid= -checklinkname=0" -o out/libharmonycore.so .
5. CORE_VERSION 从 BUILD-MANIFEST.json 的 sing_box_version 读取：稳定包 1.14.4，Beta 包 1.15.0-alpha.13。网络 Go 模块仍需下载或预缓存。
6. 在 DevEco 打开 HarmonyNet，使用 build-profile.example.json5（复制为 build-profile.json5）构建 entry Release HAP。entry 的 CMake 自动拾取 core/go/out 中的 so 和头文件。
7. 可参考根目录 build-core.ps1 / build-hap.ps1 的当前环境命令，但必须调整工具路径和 Push-Location 到本工程根目录；它们不是自动发现环境的安装器。
8. 使用自己的签名身份。升级保留应用数据和原签名，稳定与 Beta 是不同包名。不要提交签名材料或个人节点配置。

9. 保留 module.json5 的 compressNativeLibs=true、extractNativeLibs=true。签名前运行 node scripts/verify-hap-compression.mjs 路径/entry-default-unsigned.hap；未压缩原生库必须阻止发布。Windows 可使用 scripts/build-compressed-hap.ps1 构建并自动校验，不得重打包签名后的 HAP。

0.90.10 两个渠道的完整对应源码 ZIP 分别对应已构建的稳定与 Beta 应用树：稳定 ZIP 来自公开 commit 和 v0.90.10 标签；Beta ZIP 保留 Beta 包名、Beta 模块锁、platform_alpha.go 及 1.15.0-alpha.13 的 libbox 源码。源码 ZIP 不包含签名材料、构建产物、订阅或设备报告。本版应用改动集中在 ArkTS 玻璃材质、布局、后台快照判断和策略组卡片复用；内核二进制与 0.90.5 相同，但必须按各渠道的 sing-box 版本单独编译，不能声称可重复构建得到逐字节相同的签名包。

验证范围见 docs/releases/0.90.10.md：26 项相关测试、两渠道 HAP 编译、身份/版本检查、原生库压缩和 ZIP 完整性通过；完整工具测试仍有历史失败，未做新版本签名装机长期测试。
