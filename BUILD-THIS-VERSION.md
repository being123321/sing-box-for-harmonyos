# 构建 0.80 对应源码

解压后工程根目录为 HarmonyNet。BUILD-MANIFEST.json 标明本包应用及内核渠道，core/go/go.mod 已将 sing-box 和 gVisor 指向 third_party 相对目录。

1. 准备 DevEco Studio、HarmonyOS SDK API26 和 API22 兼容环境。安装工程 oh-package.json5 声明的依赖。
2. 使用 third_party/ohos-go 所含修订源码构建 OHOS Go 工具链（与清单中的 go_port_commit 及本地运行时修订对应），或使用同一工具链。普通 Go 不支持该目标。
3. 在 core/go 下配置 GOROOT、GOOS=openharmony、GOARCH=arm64、CGO_ENABLED=1，以及 SDK native LLVM 的 CC/CXX，target=aarch64-linux-ohos，sysroot 指向 SDK native/sysroot，定义 __MUSL__。
4. 构建命令：go build -p=2 -mod=readonly -buildmode=c-shared -buildvcs=false -trimpath -tags with_gvisor,with_quic,with_utls,with_clash_api,with_tailscale,badlinkname,tfogo_checklinkname0 -ldflags "-X github.com/sagernet/sing-box/constant.Version=CORE_VERSION -s -w -buildid= -checklinkname=0" -o out/libharmonycore.so .
5. CORE_VERSION 从 BUILD-MANIFEST.json 的 sing_box_version 读取：稳定包1.14.4，Beta包1.15.0-alpha.13；不能互换。网络 Go 模块仍需下载或预缓存。
6. 在 DevEco 打开 HarmonyNet，使用 build-profile.example.json5（复制为 build-profile.json5）构建 entry Release HAP。entry 的 CMake 自动拾取 core/go/out 中的 so 和头文件。
7. 可参考根目录 build-core.ps1 / build-hap.ps1 的当前环境命令，但必须调整工具路径和 Push-Location 到本工程根目录；它们不是自动发现环境的安装器。
8. 使用自己的签名身份。升级保留应用数据和原签名，稳定与Beta是不同包名。不要提交签名材料或个人节点配置。

未签名HAP的构建检查和真机验证范围见 docs/releases/0.80.md；完整工具链锁测试存在历史失败，不声称可重复构建得到逐字节相同签名包。
