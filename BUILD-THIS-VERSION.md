# 构建 1.30 / 1.30 Beta 对应源码

本次版本代码为 1000152。稳定渠道使用 sing-box 1.14.4、包名 `com.harmonynet.assistant`；Beta 使用 1.15.0-alpha.13、包名 `com.harmonynet.assistant.beta`。渠道由包内上游内核决定，不得互换渠道的内核、依赖锁或适配文件。本次没有将上游内核升级为其他版本。

本次发布对应源码 tag `v1.30` / `v1.30-beta`。BUILD-MANIFEST.json 记录上游来源、精确版本与 commit、本渠道原生库及未签名 HAP 哈希；实际下载与源码提交以 Release 和 tag 为准。

## 构建

1. 准备 DevEco Studio、HarmonyOS SDK API26 和 API22 兼容环境，安装工程 oh-package.json5 声明的依赖。完整对应源码解压后的工程根目录为 HarmonyNet。
2. 使用 third_party/ohos-go 所含修订源码构建 OHOS Go 工具链，或使用与清单 go_port_commit 和本地运行时修订相同的工具链。普通上游 Go 不能直接替代。
3. core/go/go.mod 的 sing-box 和 gVisor 必须指向对应渠道的 third_party 相对目录；其他 Go 模块需下载或预缓存。Beta 保留 platform_alpha.go、Beta 模块锁及相应 libbox 适配。
4. 在 core/go 配置 GOROOT、GOOS=openharmony、GOARCH=arm64、CGO_ENABLED=1，以及 SDK native LLVM 的 CC/CXX。target=aarch64-linux-ohos，sysroot 指向 SDK native/sysroot，并定义 __MUSL__。
5. 从 BUILD-MANIFEST.json 读取 CORE_VERSION 后构建：

   ```text
   go build -p=2 -mod=readonly -buildmode=c-shared -buildvcs=false -trimpath -tags with_gvisor,with_quic,with_utls,with_clash_api,with_tailscale,badlinkname,tfogo_checklinkname0 -ldflags "-X github.com/sagernet/sing-box/constant.Version=CORE_VERSION -s -w -buildid= -checklinkname=0" -o out/libharmonycore.so .
   ```

   请将 CORE_VERSION 替换为本渠道实际版本值，不要按字面保留占位符。
6. 在 DevEco 打开 HarmonyNet；如需使用 build-profile.example.json5，复制为 build-profile.json5 后按本机环境配置，构建 entry Release HAP。CMake 拾取 core/go/out 中的 so 和头文件。确认中间 CMake 对象使用本次生成的完整原生库，避免复用旧库。
7. 可参考 BUILD-1.30.md、build-core.ps1 和 build-hap.ps1 的当前环境命令，但必须按本机路径调整；它们不是自动发现环境的安装器。
8. 使用自己的签名身份。升级保留应用数据和原签名，稳定与 Beta 是不同包名。不要提交签名材料或个人节点配置。
9. 保留 module.json5 的 `compressNativeLibs=true`、`extractNativeLibs=true`。签名前运行 node scripts/verify-hap-compression.mjs 校验实际 ZIP 条目和 stripped 核心哈希；未压缩或哈希不符必须阻止发布。

本版源码 ZIP 分别对应已构建的稳定与 Beta 应用树，包含修改后的 sing-box、gVisor、OHOS Go 和 SFA 源码，不包含签名材料、订阅或设备私有记录。验证范围见 docs/releases/1.30.md：98 项相关测试、双 HAP 构建、身份/版本、包内核心哈希和 Deflate 压缩校验通过；这是相关测试，不是全量测试或真机验收。
