# sing-box for HarmonyOS

非官方鸿蒙移植，供个人学习与技术研究，与 SagerNet 无官方关联。如有权利或授权问题，请在仓库 Issues 联系维护者处理。许可证和第三方版权声明见 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

当前分支为稳定版 **1.30（1000164）**，包名为 `com.harmonynet.assistant`，内核为 sing-box `1.14.4` 的鸿蒙适配版，使用 gVisor TUN 栈。Beta 源码见 [beta](https://github.com/being123321/sing-box-for-harmonyos/tree/beta)。

- 正在使用的配置可热加载，更新时保留 VPN 隧道。
- 从最近任务划掉应用会停止核心和 VPN，重新打开后需手动连接。
- 后台通知显示配置名称和实时流量。

构建方法见 [BUILD-1.30.md](BUILD-1.30.md)，校验值见 [BUILD-MANIFEST.json](BUILD-MANIFEST.json)。发布附件是原包名未签名 HAP，覆盖安装须使用原应用的签名。
