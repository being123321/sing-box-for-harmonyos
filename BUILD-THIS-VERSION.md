# 构建 0.90.23 / 0.90.23 Beta 对应源码

本次版本代码为 1000132。稳定渠道使用 sing-box 1.14.4、包名 com.harmonynet.assistant；Beta 使用 1.15.0-alpha.13、包名 com.harmonynet.assistant.beta。渠道由包内上游内核决定，不得互换渠道的内核、依赖锁或适配文件。本次没有将上游内核升级为其他版本。

本次发布对应源码 tag `v0.90.23` / `v0.90.23-beta`。BUILD-MANIFEST.json 记录上游来源、精确版本与 commit、本渠道原生库及未签名 HAP 哈希；实际下载与源码提交以 Release 和 tag 为准。

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
7. 如参考 build-core.ps1、build-hap.ps1 或 scripts/build-compressed-hap.ps1，先调整本机工具路径和工程根目录；这些脚本不是自动发现环境的安装器。
8. 保留 module.json5 的 compressNativeLibs=true、extractNativeLibs=true。签名前运行 `node scripts/verify-hap-compression.mjs <HAP路径> <本渠道stripped原生库路径>`，确认实际 ZIP 条目使用 Deflate 且包内库与本次 stripped 库相同。不得重打包已签名 HAP。
9. 使用原签名身份覆盖升级以保留应用数据，不卸载、不清数据。稳定与 Beta 是两个包名。签名会改变 HAP 文件哈希；清单中的 HAP 哈希对应本次未签名产物，不保证不同环境或签名后逐字节相同。

## 本次构建与发布边界

本次两个渠道的原生库均已重新编译，移除了临时 VPN 诊断记录器；不得复用含旧记录器的旧库。正常内存压力响应、VPN 健康检查、后台恢复、测速和 WebRTC 检测仍保留。日志页使用单个原生 List 和吸顶级别菜单；筛选卡片键及无匹配提示已修正。切网恢复改动继承 0.90.22。

64 项相关 ETS、19 项原生 Go 顶层测试、10 项相关 UI 测试通过；双渠道 HAP 编译及版本、链接内核、包内原生库与 Deflate 压缩校验通过。完整旧测试并非全部通过，导航拖动 fixture 的两项历史失败在改动前也可复现。具体说明见 docs/RELEASE-0.90.23.md。

当前手机仍为 0.90.21 Beta；新 0.90.23 尚未签名装机，不能把旧版 HTTPS 请求成功作为新版安装或长期稳定性验证。SIM/4G/5G 切换、实际日志滚动和长时后台运行待真机复测。HTTP 204 空白响应不是失败证据；旧版一次实际 HTTPS 页面加载成功也不能证明间歇性 Wi-Fi 故障已根治。

本次交由维护者发布最新版本；不需为中间本地诊断构建补建 Release。上传时提供匹配的稳定/Beta HAP、对应源码与哈希，不能附带个人签名、订阅或设备私有报告。源码 ZIP 应包含实际使用的 sing-box、gVisor、OHOS Go 和参考源码及各自许可证；普通 GitHub 自动源码包不一定包含所有外部依赖。
