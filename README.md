# sing-box for HarmonyOS

非官方鸿蒙原生移植，界面参考 sing-box for Android。与 SagerNet 无官方关联。

- 稳定渠道：应用 **0.90.26**，上游正式内核 **1.14.4**。
- Beta 渠道：应用 **0.90.26-beta**，上游预发布内核 **1.15.0-alpha.13**。
- 版本代码均为 **1000135**。渠道由包内上游内核决定，不表示已经完成全部真机测试，也不表示本次更新了上游内核版本。
- 目标设备：Pura X / HarmonyOS 7.0.0.109；SDK API26，最低兼容 API22。
- 下载：[GitHub Releases](https://github.com/being123321/sing-box-for-harmonyos/releases)。
- HAP 未签名，升级须沿用原签名覆盖安装，不卸载、不清除数据。稳定版与 Beta 包名不同，分别保存数据。

## 本次更新

六点拖动显示整行跟随、落点高亮及排序动画；SSID 编辑区移到底部并自动滚动显示。保留上一版自动网络 DNS 和批量编辑。详见 [更新说明](docs/RELEASE-0.90.26.md)。

## 验证范围

双 HAP 构建、Deflate 压缩及实际库校验通过，15 项相关回归通过。本次复用原生内核。新版手势效果尚未签名装机验证，历史全量测试仍有未通过项。

## 使用与构建

可导入节点链接、二维码、订阅或完整 sing-box JSON。策略组选择、直连／规则／全局模式和配置数据会持久化。按需规则可分别选择挂起或直连；分应用代理读取完整应用列表仍依赖已获批的 GET_BUNDLE_INFO_PRIVILEGED 签名授权。

构建要求、渠道差异及验证步骤见 [BUILD-THIS-VERSION.md](BUILD-THIS-VERSION.md)，上游来源及本次二进制哈希见 [BUILD-MANIFEST.json](BUILD-MANIFEST.json)。两个渠道必须使用各自的源码和内核，不能互换。

所有 HAP 保留 module.json5 的 compressNativeLibs=true。签名前运行 `node scripts/verify-hap-compression.mjs <HAP路径> <本渠道stripped原生库路径>` 校验；压缩发生在签名前，不能重打包已签名 HAP。

GPL-3.0-or-later，第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。个人签名材料、订阅、节点密码及设备私有报告不得提交或发布。
