# sing-box for HarmonyOS

非官方鸿蒙移植，供个人学习与技术研究，与 SagerNet 无官方关联。如有权利或授权问题，请在仓库 Issues 联系维护者处理。许可证和第三方版权声明见 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

当前分支为 **1.30-beta（1000165）**，包名为 `com.harmonynet.assistant.beta`，内核为 sing-box `1.15.0-alpha.13` 的鸿蒙适配版。稳定版源码见 [main](https://github.com/being123321/sing-box-for-harmonyos/tree/main)。

- 使用 sing-tun 默认 Go TCP/IP 栈。
- 正在运行的配置可热加载，更新时保留 VPN 隧道。
- 远程规则集首次下载可并发尝试配置指定路径、直连和可用代理出站。
- 从最近任务划掉应用会停止核心和 VPN，重新打开应用后需手动连接。

构建方法见 [BUILD-1.30.md](BUILD-1.30.md)，包体和内核校验值见 [BUILD-MANIFEST.json](BUILD-MANIFEST.json)。发布产物为未签名 HAP，覆盖安装时需使用原应用的签名。
