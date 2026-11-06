# sing-box for HarmonyOS

非官方鸿蒙原生移植，界面参考 sing-box for Android。与 SagerNet 无官方关联。

- 稳定渠道：应用 **0.90.14**，上游正式内核 **1.14.4**。
- Beta 渠道：应用 **0.90.14-beta**，上游预发布内核 **1.15.0-alpha.13**。
- 渠道按上游内核区分，不能代表所有真机测试已经完成。
- 目标设备：Pura X / HarmonyOS 7.0.0.109；SDK API26，最低兼容 API22。
- 下载：[GitHub Releases](https://github.com/being123321/sing-box-for-harmonyos/releases)。HAP 未签名，需沿用原签名覆盖安装；不要卸载或清除数据。稳定版与 Beta 包名不同，分别保存数据。

## 本次更新

本次只发布最新 0.90.14，不补建中间版本，也不删除历史公开版本。以下汇总自 0.90.13 公开版本以来的最终改动。

- **减少切网重建的重复工作**：IPv6 跨网络完整重建直接进入安全停止/重建路径，不再先对即将关闭的旧服务执行 ResetNetwork，减少一次无效连接和协程变更。IPv6 捕获与泄漏保护保留。
- **配置校验复用**：同一 VPN 扩展生命周期内复用精确配置字符串的成功校验结果，恢复时不再重复创建临时校验实例。配置改变必须重新校验；失败、取消不缓存；扩展重建和最终清理时清空。真实内核启动仍验证、加载当前配置和资源。
- **系统低内存异步回收**：VPN 进程订阅系统环境内存通知，只在 LOW、CRITICAL、BACKGROUND_LOW、BACKGROUND_CRITICAL 时请求异步 Go 空闲页回收；UI_HIDDEN 和 MODERATE 不触发，不添加周期 GC。观察器合并压力通知，原生处理在 `coreMu` 下执行，全进程最多每 30 秒一次，服务重建不重置节流。
- **内存边界**：仍使用 512 MiB Go 软目标，不限制整个进程 RSS，不修改系统回收评分或后台回收策略。停止及扩展销毁会取消未执行/迟到通知并注销订阅，不影响 TUN 和内核清理。
- **构建依赖**：CMake 显式依赖新 Go 核心产物，避免缓存构建漏拷贝新内核。已逐段比对构建核心、CMake 拷贝及打包前 strip 产物，HAP 内核哈希与对应 strip 产物一致。

保留 0.90.13 的即时模式/Clash 节点高亮、异步命令合并、失败回退、导航立即切页和底部滚动避让，也保留 0.90.11 的 VPN 前台恢复。

## 网络恢复与内存压力

跨网络 IPv6 重建如果继续使用旧服务，ResetNetwork 只会增加一次即将作废的连接和协程变更；本版在识别完整重建时直接走安全停止/重建。该路径不改变 IPv6 路由保护，也不以移除防泄漏换取表面不断线。

系统内存通知只触发 Go 侧空闲页回收，不执行周期 GC，也不依据单次 RSS 采样宣称具体优化幅度。回调可能晚于系统终止，不能阻止系统强制结束扩展进程。Beta 真机已接受低内存测试通知，并在切网及约一分钟后台观察中保持相同扩展 PID/TUN 和收发；这是短时验证，不是长期后台稳定性保证。

## 构建与内核对应

- 稳定版 0.90.14 使用 sing-box 1.14.4，未更新上游版本或依赖。
- Beta 版 0.90.14-beta 使用 sing-box 1.15.0-alpha.13，未更新上游版本或依赖。
- 两渠道 OHOS arm64 原生核心均重新交叉编译，tags 包含 `with_tailscale`；CMake 通过 `LINK_DEPENDS` 依赖新的 `libharmonycore.so`。
- HAP 内 strip 核心 SHA256：稳定 `9917db14d288eef0790c9c6e2c4e30e8a1829f62d229ef724e5628ca9cacd153`，Beta `3965ea161d7a55159086d2f86d0af146eddf07e2fbbcee2af7fea9a2e60db7d6`。未 strip 核心哈希见 BUILD-MANIFEST.json。

## 验证与安装

87 项相关 ArkTS/TypeScript 回归和 4 项 Go 内存策略测试通过。两个 HAP 构建成功，versionCode 1000123；原生库内部 Deflate 压缩校验通过，约 25.5 / 26.2 MiB。手机已签名覆盖安装 0.90.14 Beta，系统低内存通知、Wi-Fi 到蜂窝切网和约 71 秒后台观察未复现退出；通知后的单次 RSS 采样不能证明具体优化幅度。

新版切换流畅度、长期后台稳定性仍未完成真机验证；系统终止整个扩展时扩展内定时器无法自行运行，不宣称彻底解决 VPN 掉线、所有切网或 IPv6/WebRTC 泄漏。HAP 未签名，需用原签名覆盖安装，勿卸载或清除数据；稳定版与 Beta 包名不同。

后续所有 HAP 均保留 `entry/src/main/module.json5` 的 `compressNativeLibs: true`。构建后必须运行 `node scripts/verify-hap-compression.mjs <HAP路径>`，校验实际 ZIP 条目的原生库采用 Deflate 压缩；Windows 可使用 `scripts/build-compressed-hap.ps1` 同时构建与校验。压缩发生在签名前，不能重新打包已签名 HAP。

## 使用

工具／设置 → 基础配置 → 节点选择，可通过链接、二维码、订阅、手动表单和 sing-box JSON 导入节点；模式选择支持 GFW 与大陆以外分流。也可直接导入自己的完整 sing-box JSON。策略组选择与仪表盘直连／规则／全局模式会持久化。

按需连接命中排除 SSID 时停止代理内核并释放 TUN，优先于分应用代理；手动测速不自动恢复 VPN。完整应用列表依赖获批的 GET_BUNDLE_INFO_PRIVILEGED 签名授权，普通签名不保证枚举全部应用。

WebRTC 禁用 STUN 在规则／全局模式拦截可识别的 UDP STUN；直连模式、SSID 挂起及排除应用保留直连语义。浏览器本地候选和系统 IPv6 接管需另外验证。

## 构建与许可证

每个渠道的完整对应源码 ZIP 包含修改后的 sing-box、gVisor、OHOS Go 和 SFA 参考源码，来源及二进制哈希见 BUILD-MANIFEST.json。需要 DevEco SDK API26 和修改后的 OHOS Go 工具链；普通上游 Go 无法直接替代。core/go/go.mod 使用 third_party 相对路径。根据 BUILD-THIS-VERSION.md 配置工具路径，在 DevEco 安装依赖后构建 entry Release HAP。

GPL-3.0-or-later，第三方声明见 THIRD_PARTY_NOTICES.md。个人签名材料、订阅和设备报告不得提交。
