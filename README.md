# sing-box for HarmonyOS

非官方鸿蒙原生移植，界面参考 sing-box for Android。与 SagerNet 无官方关联。

- 稳定渠道：应用 **1.30**，上游正式内核 **1.14.4**。
- Beta 渠道：应用 **1.30-beta**，上游预发布内核 **1.15.0-alpha.13**。
- 版本代码均为 **1000152**。渠道由包内上游内核决定，不表示已经完成全部真机测试，也不表示本次升级了上游内核版本。
- 目标设备：Pura X / HarmonyOS 7.0.0.109；SDK API26，最低兼容 API22。
- 下载：[GitHub Releases](https://github.com/being123321/sing-box-for-harmonyos/releases)。
- HAP 未签名，升级须沿用原签名覆盖安装，不卸载、不清除数据。稳定版与 Beta 包名不同，分别保存数据。

## 本次更新

只发布最新 1.30 稳定版与 1.30-beta 测试版；1.10、1.20 等中间版本不单独创建 Release。以下为 1.30 的最终状态。

- **VPN 与后台传输分离**：VPN 隧道继续由 `NetworkVpnExtAbility` 持有，后台传输任务移到 `TempAbility`。传输任务不再承担隧道所有权，避免后台任务生命周期与 VPN 连接互相牵连。
- **DNS 策略收敛**：使用配置自身的 DNS 策略，不再自动注入运营商 DNS 或国内 DNS 规则。代理 DNS 和用户保存的原始配置保持不变。
- **移除旧内置配置**：删除旧版内置配置及其生成的本地副本、节点移动，以及工具和设置中的旧 Configuration 入口。配置、节点和模式仍按现有存储保存。
- **保留此前修复**：保留 VPN 有界自动恢复、系统内存压力回收、策略组事件订阅、透明叠放/页眉、日志滚动和底部避让。中间版本的功能已并入 1.30，不再逐个发布。

完整说明见 [1.30 更新说明](docs/releases/1.30.md)。

## 验证范围

98 项相关测试在共享应用源码上通过；双渠道原生库和 HAP 重新构建，实际库哈希和 Deflate 压缩校验通过。本次未完成全量测试，也未做签名真机验证；不能表述为全套测试通过或已完成真机验收。

新版 VPN 隧道归属、后台传输、DNS 行为和移除内置配置后的升级路径仍需原签名覆盖安装后复测。历史全量测试仍有未通过项；不宣称所有 VPN 掉线、低内存、IPv6 或 WebRTC 问题已根治。

## 使用与构建

可导入节点链接、二维码、订阅或完整 sing-box JSON。策略组选择、直连／规则／全局模式和配置数据会持久化。按需规则可分别选择挂起或直连；分应用代理读取完整应用列表仍依赖已获批的 GET_BUNDLE_INFO_PRIVILEGED 签名授权。

构建要求、渠道差异及验证步骤见 [BUILD-THIS-VERSION.md](BUILD-THIS-VERSION.md)，上游来源及本次二进制哈希见 [BUILD-MANIFEST.json](BUILD-MANIFEST.json)。两个渠道必须使用各自的源码和内核，不能互换。

所有 HAP 保留 module.json5 的 `compressNativeLibs=true`。签名前运行 `node scripts/verify-hap-compression.mjs <HAP路径> <本渠道stripped原生库路径>` 校验；压缩发生在签名前，不能重打包已签名 HAP。

GPL-3.0-or-later，第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。个人签名材料、订阅、节点密码及设备私有报告不得提交或发布。
