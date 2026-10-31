# HarmonyOS 网络助手：当前实现与开发验收方案

> 方案版本：0.4
> 状态日期：2026-08-12
> 编译/目标平台：HarmonyOS 26.0.0 SDK（API 26）；单包最低兼容：HarmonyOS 6.0.2（API 22）
> 首版设备：ARM64 手机  
> 核心：sing-box `v1.13.18`  
> 当前结论：当前平台无关自动测试通过；历史 debug HAP 有构建记录，但当前源码仍须重新构建、安装并完成整轮真机验收

## 1. 先给结论

当前项目已经不是纯 UI 原型：多订阅、节点解析、配置生成、API 22+ 兼容 VPN Extension、双栈 TUN、按应用白名单、N-API、OpenHarmony ARM64 sing-box 核心、跨进程状态/URLTest 桥和签名 debug HAP 构建链都已经落到代码中。

但“代码存在”和“真机可用”是两个不同的里程碑。截至本方案冻结时：

- 截至 2026-08-12，本轮 `./scripts/run_domain_tests.sh` 全量通过；测试数量由测试运行器输出，不再在方案中维护易过期的固定数字。
- ARM64 核心和开发签名 debug HAP 均有历史成功构建记录，但任何源码修改都会使该产物失去“对应当前源码”的资格，必须在源码冻结后重新构建并记录哈希。
- HUKS 安全存储和进程内实时流量 tracker 已落到代码与自动测试；这只证明实现边界，不等于最新版 HAP 已在真机完成运行验证。
- 当前最终版本仍未完成安装、系统 VPN 授权、TUN fd、真实 IPv4/IPv6 TCP/UDP/DNS 转发、出口 IP、DNS 泄漏、流量统计和网络切换的整轮闭环。

只有完成第 11 节的真机清单后，才可以把版本状态从“构建可验收”改成“真机可用”。HAP 能安装、页面显示“已连接”、native 返回 running 或拿到 TUN fd，单独都不算流量通过。

## 2. 技术基线

当前实际基线如下：

| 项目 | 当前值 |
|---|---|
| DevEco Studio | 26.0.0.621 |
| SDK | 26.0.0.32 Beta2 / API 26 |
| `compileSdkVersion` | 26.0.0 |
| `targetSdkVersion` | 26.0.0 |
| `compatibleSdkVersion` | 6.0.2(22) |
| 运行系统 | HarmonyOS |
| 设备类型 | phone |
| CPU | ARM64 |
| sing-box | v1.13.18，commit `45ca32dcb966f07f97fc888fe8586e359dbe8405` |
| Go | 项目内 OpenHarmony Go 1.24.13 工具链 |
| HAP | 开发签名 debug 包；尚非正式发布包 |

本项目采用 API 26 SDK 编译并目标化，单一应用包的最低兼容版本为 `6.0.2(22)`。源码门禁禁止 API 23/26 才提供的 `maxRedirects`、`reuseConnections`、HUKS key-security-level 标签以及 `uiMaterial/systemMaterial`进入运行路径；每次 SDK 升级仍需同步验证 ArkTS API、N-API、OHOS Clang、Go ABI 和签名链。API 20/21 不在本单包范围。

## 3. 当前架构

```text
ArkUI / EntryAbility（UI 进程）
    ├─ SubscriptionRepository：多订阅原子持久化
    ├─ NetworkSettingsRepository：模式与 DNS 设置
    ├─ SubscriptionParser：订阅识别、校验、归一化
    ├─ SingBoxConfigBuilder：生成运行配置
    └─ ConnectionCoordinator
             ↓ 应用私有 filesDir/runtime
       AtomicFile status / command / response
             ↓
NetworkVpnExtAbility（VPN Extension 进程）
    ├─ protectProcessNet()
    ├─ VpnConnection.create()：IPv4 + IPv6 TUN
    ├─ CheckConfig / start / URLTest / stop
    └─ 心跳与真实停止确认
             ↓
C++ N-API 异步桥
             ↓
libharmonycore.so（OpenHarmony ARM64）
    ├─ OH_NetConn_GetAllNets / GetNetCapabilities
    ├─ OH_NetConn_BindSocket（每个 Go 出站 fd）
             ↓
sing-box v1.13.18
```

VPN Extension 与 UI 不能靠 native Go 全局变量共享状态。当前实现把小型状态、命令和响应写入应用私有目录中的 AtomicFile；完整订阅、节点密钥和运行配置不放入 Want 或运行状态文件。运行配置由独立的私有原子文件交给 Extension 读取。

## 4. 功能真实状态

| 能力 | 当前代码状态 | 仍需证明或补齐 |
|---|---|---|
| 多订阅 | 已实现添加、同 URL 更新、独立记录、删除、切换、持久化 | 真机重启和多次更新回归 |
| 节点列表 | 显示当前订阅全部有效节点，可选择并保留选择 | 大订阅性能和真实节点兼容率 |
| 订阅格式 | sing-box JSON、Base64/URI、Clash/Mihomo 常用 YAML | 完整 YAML、锚点、provider、脚本 |
| 协议 | Shadowsocks、Trojan、VLESS、VMess、Hysteria2 | 各协议至少一个合法真机样本 |
| TLS 扩展 | 常用 TLS、uTLS、Reality、WS/gRPC 字段 | 组合兼容性真机验证 |
| Hysteria2 | 基础 Hysteria2；core 已带 QUIC 构建标签 | obfs 尚未转换，会跳过并警告 |
| 路由模式 | 规则、全局代理、直连 | 真实出口逐模式核对 |
| 远程 rule-set | 能识别引用 | 未下载/编译；规则模式会主动阻止连接 |
| VPN/TUN | API 22+ 兼容生命周期与失败回滚已编码 | API 22 和 API 26 真机授权、fd、转发和重复启停 |
| 按应用接管 | `trustedApplications` 白名单、桌面应用查询与手动包名入口已编码 | API 22/API 26 真机确认所选应用进入 TUN、未选应用走系统网络 |
| IPv6 | TUN 地址、`::/0`、DNS、`isIPv6Accepted=true` 已编码 | IPv6 出口和无泄漏验收 |
| DNS | DoH/DoT、bootstrap、hijack-dns、Mozilla roots | 真机 DNS 结果与泄漏检测 |
| TCP 测速 | 未连接时测试节点服务器 TCP 建连时间 | 它不是代理握手或出口证明 |
| 代理 URLTest | 连接后由 Extension 进程中的 sing-box 执行 | 真机实际时延和超时行为 |
| 实时流量 | 已接入 sing-box 进程内 tracker；跨进程上报累计上下行、即时速率和活动连接数 | 最新 HAP 真机流量增长、重连清零和长时间稳定性 |
| 实际出站 | 当前运行状态携带 sing-box 选中 outbound，UI 可显示并在变化时作废旧路径诊断 | 自动策略切换与手动热切换的真机回读 |
| 活动/规则命中 | 尚未实现逐连接活动与规则命中明细 | 目标、规则、出站、错误的脱敏诊断与留存策略 |
| 系统 HTTP 代理 | 普通消费应用不可设置 | 不作为项目目标 |
| Wi-Fi/蜂窝恢复 | 尚无完整默认网络监控实现 | 切换、锁屏、后台和系统回收测试 |
| 核心热更新 | 不支持，也不应绕过签名实现 | 随 HAP 升级并完整回归 |

## 5. 多订阅与节点模型

### 5.1 已实现的多订阅行为

- 输入只接受 HTTPS 地址；订阅正文限制为 4 MiB，并设置连接和读取超时。
- 地址规范化后，同一 URL 更新原记录；不同 URL 始终保留为不同记录。
- 每条记录独立保存来源、解析结果、当前节点、创建时间和更新时间。
- 添加或切换订阅会改变当前激活记录；删除当前记录时切换到剩余的第一条记录。
- 更新后如果原选中节点仍存在则继续选择，否则回退到新订阅的第一个有效节点。
- 节点 ID 包含名称、协议、地址、端口、凭据、TLS、Reality、uTLS、transport 和排序后的查询参数，避免不同节点错误碰撞。
- 缺少密码、UUID、加密方式、Reality public key 或端口无效的节点会被跳过并产生 warning；只要仍有有效节点，整个订阅可以继续导入。

订阅地址、名称、节点密码和 UUID 当前使用应用作用域、不可导出的 HUKS AES-256-GCM 密钥加密后存储在应用私有目录；应用白名单、网络/DNS 设置和静态 sing-box 运行配置使用同一安全边界、不同 AAD 用途加密。每次写入使用随机 nonce 和认证标签。旧版私有明文只有在业务格式校验、候选密文原子写入、HUKS 解密回读和内容比对全部成功后才删除；损坏密文会失败关闭，不回退到旧明文。凭据和应用清单不会写入普通 hilog、Want 或运行状态桥，VPN Extension 只在内存中解密运行配置与接管范围。

### 5.2 格式与协议边界

Base64/URI 列表支持：

- `ss://`
- `trojan://`
- `vless://`
- `vmess://`
- `hysteria2://` / `hy2://`

sing-box JSON 当前提取：

- 上述支持协议的 outbound。
- selector/urltest 的基础分组元数据。
- 常用 TLS、uTLS、Reality、transport。
- 常用域名、CIDR、final 和 rule-set 引用。
- 第一项可用 DNS 和策略字段。

Clash/Mihomo YAML 当前是项目内轻量解析器，覆盖：

- 常见 multiline map 和 `{ ... }` inline map 节点。
- select/url-test 基础分组。
- DOMAIN、DOMAIN-SUFFIX、DOMAIN-KEYWORD、IP-CIDR/IP-CIDR6、RULE-SET、MATCH/FINAL。
- 常见 TLS、client-fingerprint、Reality 和 transport 字段。

它不是完整 YAML 实现。复杂锚点、合并键、provider、脚本以及任意嵌套结构都不应被描述成已支持。Hysteria2 obfs 当前会明确跳过，而不是生成可能连接失败的错误配置。

## 6. 路由、VPN、IPv6 与 DNS

### 6.1 三种模式的准确含义

- **规则**：局域网/私有地址先直连，支持的订阅规则按顺序加入 sing-box，最终规则决定 proxy 或 direct。
- **全局代理**：TUN 内最终流量走当前选中节点。
- **直连**：TUN 仍由系统 VPN 建立，但最终出站为 direct，主要用于诊断。

普通 HarmonyOS 消费应用不能修改系统全局 HTTP 代理。本项目界面中的“全局代理”只描述 sing-box 在当前 VPN/TUN 内的路由行为，不代表系统代理设置被修改。

远程 `rule-set` 当前只会被解析为引用，没有下载、校验和本地编译。为了避免把依赖这些规则的配置静默降级成错误路由，UI 在规则模式检测到 `rule-set` 后会阻止连接；用户可以明确选择全局代理或直连继续，但这两种模式不会执行订阅规则。

### 6.2 双栈 TUN

当前 VPN 配置包含：

- IPv4 TUN：`172.19.0.1/30`，默认路由 `0.0.0.0/0`，DNS `172.19.0.2`。
- IPv6 TUN：`fdfe:dcba:9876::1/126`，默认路由 `::/0`，DNS `fdfe:dcba:9876::2`。
- MTU 1400，`isIPv4Accepted=true`，`isIPv6Accepted=true`。
- sing-box TUN inbound 使用同一组 IPv4/IPv6 地址，stack 为 gVisor；HarmonyOS 的沙箱 TUN fd 使用受限的 Fstat 兼容路径，其他 fd 错误仍保持失败关闭。

这些代码避免了“只代理 IPv4、IPv6 直接泄漏”的明显配置缺口，但不能替代真机 IPv6 验收。设备、运营商、Wi-Fi 和节点都支持 IPv6 时，必须验证真实 IPv6 出口；没有 IPv6 环境时应把该项标记为“环境不可测”，不能标记为通过。

### 6.3 DNS 与证书

DNS 预设包括 Cloudflare、AliDNS、Quad9 DoH；自定义项只接受 `https://` DoH 或 `tls://` DoT。运行配置使用：

- `hijack-dns` 接管通过 TUN 的 DNS 流量。
- IP 地址形式的加密 bootstrap DNS，避免代理服务器或自定义 DNS 主机名形成解析循环。
- 根据模式选择 proxy/direct detour。
- `auto_detect_interface=false`；Extension 的 `protectProcessNet()` 覆盖 libc socket，Go 出站 fd 通过公开 NetworkKit NDK 重新枚举并绑定到带 `INTERNET + VALIDATED + NOT_VPN` 的 Wi-Fi/蜂窝底层网，任何枚举或绑定失败都失败关闭。
- `certificate.store=mozilla`，使用 sing-box 内置 Mozilla 根证书。

OpenHarmony Go 适配层当前没有返回系统证书路径，因此 Mozilla store 是 TLS 节点、DoH、DoT 和 URLTest 的必要兼容措施。它只修复根证书来源，不证明目标节点的 TLS/Reality 握手已在设备上通过。

## 7. 跨进程运行状态与 URLTest

当前桥接协议位于应用私有 `filesDir/runtime`，使用三个 AtomicFile：

- `status.json`：session ID、starting/running/stopped/error、阶段、核心版本、累计上下行字节、活动连接数、当前实际 outbound、脱敏错误和更新时间。
- `command.json`：当前 session 的 URLTest 请求。
- `response.json`：匹配 session/request ID 的结果。

关键约束：

- UI 每次连接创建新的 session ID，旧进程或旧响应不能冒充当前连接。
- 系统授权可能让用户离开应用，未被 Extension 接管的启动票据最长保留 45 秒。
- Extension 运行时每 1.5 秒写一次心跳；UI 把超过 8 秒未更新的 running 状态视为陈旧，不继续显示“已连接”。
- URLTest 请求最长 30 秒有效，真正的测试只在持有 sing-box 实例的 VPN Extension 进程执行。
- Extension 从 sing-box 进程内 Clash traffic manager 读取累计上下行、当前连接数和选中 outbound，不开放外部 Clash API 或控制端口；UI 根据相邻快照计算即时速率，断开或路径变化时清理不再可信的诊断结果。
- 只有 Extension 完成核心停止与 TUN destroy 后才写入 stopped。系统停止调用返回、状态文件不可读或心跳中断都不等于清理完成；若收不到 stopped，UI 保持未知并锁定运行配置，允许用户再次执行安全停止，而不会伪造空闲状态。
- 状态文件不包含订阅 URL、配置 JSON、节点密码或 UUID。

这一实现消除了“UI 进程读取不到 Extension 进程 Go 状态”的结构性问题。tracker 取值、桥协议和 UI 契约已有自动测试，但跨进程文件可见性、真实流量增长、Extension 被系统回收后的恢复和真机 URLTest 仍必须用当前源码构建的包在设备上证明。

## 8. sing-box 核心与更新策略

核心使用 `with_gvisor,with_quic,with_utls,with_clash_api,with_tailscale` 等构建标签，以 OpenHarmony Go 1.24.13 和 DevEco OHOS Clang 构建 ARM64 `libharmonycore.so`。HAP 同时打包 C++ N-API 库和 Go 核心库。

核心更新分为两类：

- **数据更新**：订阅、节点、规则和 DNS 可以由 App 下载、解析和持久化，不必更新 HAP。
- **可执行代码更新**：`libharmonycore.so` 必须在开发机重新编译，随 HAP 一起签名、安装并回归。

不实现“从订阅地址下载新版 `.so` 并直接替换”。这会绕过应用签名边界，带来 ABI、供应链和回滚风险，也无法保证 HarmonyOS 会加载替换后的 native 库。以后如需缩短升级周期，应做正常的 App 版本发布，而不是 native 热替换。

每次 sing-box 升级至少要重新验证：

1. Go/OHOS c-shared 编译和 ELF 架构。
2. N-API 动态依赖与导出符号。
3. `CheckConfig` 对全部受支持协议的结果。
4. API 22+ TUN fd 生命周期、`protectProcessNet()` 与公开 NetworkKit NDK 逐 fd 底层网绑定。
5. IPv4/IPv6 TCP、UDP、DNS、TLS、Reality、Hysteria2 QUIC 和 URLTest。
6. 连接/断开、崩溃回滚、Wi-Fi/蜂窝和锁屏。

## 9. 安全、隐私与分发边界

- 订阅下载只接受 HTTPS；设有超时和 4 MiB 内容上限。
- 订阅 URL、节点密钥和完整运行配置不放入 Want 或跨进程状态文件。
- 普通日志只记录生命周期阶段和脱敏错误，不打印完整配置。
- 订阅目录、网络/DNS 设置和静态运行配置使用应用作用域 HUKS AES-256-GCM 加密；密钥不可导出，nonce、密文和认证标签保存在私有目录，HUKS 不可用或认证失败时不降级为明文。
- 旧版明文迁移采用“校验、候选密文原子写入、HUKS 回读验证、再删除明文”的顺序；仍须在真机验证首次迁移、损坏密文、升级与清除敏感数据路径。
- 不内置机场、节点或远程订阅转换服务。
- debug 签名材料属于本机私有配置，禁止提交或随文档分发。
- sing-box 为 GPL-3.0-or-later；正式分发前必须完成许可证、源码提供方式和 AppGallery 条款审查。

## 10. 自动化验证与构建

标准命令：

```bash
./scripts/check_toolchain.sh
./scripts/build_core.sh
./scripts/run_domain_tests.sh
./scripts/build_hap.sh
```

当前平台无关测试覆盖：

- 多订阅增删改切换与选择保持。
- sing-box JSON、URI/Base64、Clash 常见结构。
- 坏节点跳过、节点 ID、Reality/uTLS、Hysteria2 obfs 边界。
- 规则与配置生成、Mozilla certificate store、IPv4/IPv6 TUN 地址。
- DNS 设置校验。
- VPN runtime session、心跳、授权启动票据和 URLTest 命令时效。
- sing-box 进程内累计流量/活动连接 tracker、跨进程统计快照与 UI 速率契约。
- HUKS AES-256-GCM 参数、随机 nonce、认证标签、分段 IPC、跨进程文件锁、原子迁移和失败关闭。
- 正式发布内容、包结构、工具链、SBOM/安全报告和外部批准材料的失败关闭门禁。

截至 2026-08-12，`./scripts/run_domain_tests.sh` 在当前工作树全量通过。文档不再复制测试运行器的用例总数；新增或合并测试后，以命令末尾的 `tests/pass/fail` 汇总作为唯一事实来源。

HAP 构建产物为：

```text
artifacts/debug/entry-default-signed.hap
```

每次交付必须在源码冻结后重新运行构建并记录新哈希：

```bash
shasum -a 256 artifacts/debug/entry-default-signed.hap
```

测试和构建可以发现大量回归，但不能模拟 HarmonyOS 的 VPN 授权、Extension 进程模型、真实 TUN fd、设备网络栈或蜂窝网络。

## 11. 真机验收清单

### 11.1 设备与安装

- [ ] `./scripts/device_gate.sh` 显示目标手机，而不是 `[Empty]`。
- [ ] 手机已开启开发者模式、USB 调试并接受电脑授权。
- [ ] 安装本次源码对应的 signed HAP，确认不是旧包。
- [ ] 冷启动、退出、重启应用均无崩溃。
- [ ] 记录设备型号、HarmonyOS 版本、API、HAP SHA-256 和测试时间。

### 11.2 订阅与节点

- [ ] 添加订阅 A，可看到有效节点列表和兼容性提示。
- [ ] 添加订阅 B，A 不被覆盖。
- [ ] 切换 A/B 和各自节点，重启 App 后选择仍正确。
- [ ] 更新 A 后 B 完全不变；A 原节点仍存在时保持选择。
- [ ] 坏节点只被跳过，不影响同订阅中的有效节点。
- [ ] 订阅包含 rule-set 时，规则模式确实阻止连接并给出可理解提示。

### 11.3 VPN 与真实流量

- [ ] 首次连接出现系统 VPN 授权；拒绝授权不会显示已连接。
- [ ] 授权后系统 VPN 标识出现，UI 只在 Extension 心跳正常时显示连接。
- [ ] 使用受控测试节点验证 IPv4 HTTPS 出口。
- [ ] 验证 TCP 与 UDP 流量均走预期出口。
- [ ] 在可用环境验证 IPv6 出口；检查无 IPv6 旁路。
- [ ] 检查 DNS 结果来自预期路径，不发生本地 DNS 泄漏。
- [ ] 规则、全局代理、直连三种模式的出口与规则行为符合预期。
- [ ] 连接后的代理 URLTest 返回合理值；无效节点和断网时明确失败。
- [ ] 断开后系统 VPN 标识消失，普通网络立即恢复。

### 11.4 生命周期与稳定性

- [ ] 连续启停至少 100 次，无卡死、重复 VPN、fd/线程/goroutine 单向增长。
- [ ] 连续连接至少 30 分钟，UI、系统 VPN 状态和实际出口保持一致。
- [ ] 前后台、锁屏 10 分钟后状态与真实网络一致。
- [ ] Wi-Fi ↔ 蜂窝切换后能恢复，或进入明确可恢复错误态；不得假显示已连接。
- [ ] 核心启动失败、配置错误和 Extension 停止时，TUN 都被清理。
- [ ] 日志和诊断材料中没有订阅 URL、token、密码、UUID 或签名秘密。

真机测试出现任何 P0 问题时，应保留失败截图、脱敏日志、设备版本和复现步骤，修复后重新构建 HAP，从清单开头重测；不能只在旧包上局部验证。

## 12. 后续开发优先级

### P0：形成可用闭环

1. 恢复 HDC 设备连接并完成第 11 节。
2. 修复真机发现的 ABI、TUN、socket 回环、DNS、IPv6 或生命周期问题。
3. 补充默认网络监控和 Wi-Fi/蜂窝恢复策略。
4. 至少完成一个 Shadowsocks/Trojan 与一个 VLESS Reality 或 Hysteria2 的真机样本。

### P1：补齐用户已明确要求的功能

1. 远程 rule-set/provider 下载、校验、缓存、更新和失败回滚。
2. 用最新版真机包验证 tracker 的真实流量增长、重连清零、长时间计数与 UI 速率刷新。
3. 补充逐连接活动、规则命中和脱敏错误记录；当前实际 outbound 只用于运行状态与路径一致性。
4. 完整策略组选择、URLTest 组和批量代理测速体验。
5. 完成 HUKS 首次迁移、损坏密文、升级和清除敏感数据的真机回归；不把已有代码测试误写成设备验收。
6. 更完整的 Clash/Mihomo YAML 解析器和兼容 fixtures。

### P2：封闭测试与发布准备

1. 2 小时、8 小时、24 小时稳定性测试。
2. 隐私说明、开源许可证、源码获取与诊断导出。
3. release 签名、升级/回滚和可复现构建。
4. API 26 正式 SDK 升级回归及更多 ARM64 机型覆盖。

## 13. 第一版明确不做

- 不内置机场、售卖节点或推荐订阅。
- 不调用第三方订阅转换网站。
- 不做 HTTPS MITM、证书安装、脚本、重写或请求正文抓取。
- 不绕过 HarmonyOS 签名热更新 native 核心。
- 不伪造系统 HTTP 代理开关。
- 不用假流量、假规则命中或假“已连接”填充尚未接入的能力。

## 14. 当前代码状态与待验收边界

当前并发修复已按以下边界冻结：

- [x] 多订阅、节点解析和节点 ID 修复已合并。
- [x] Clash 常见 inline/multiline 字段、Reality/uTLS 和坏节点校验已合并。
- [x] Mozilla 根证书、IPv4/IPv6 双栈配置已合并。
- [x] UI ↔ VPN Extension 跨进程状态和 URLTest 桥已合并。
- [x] HUKS AES-256-GCM 安全文件存储、事务化旧明文迁移和敏感数据清理已落到代码与自动测试。
- [x] sing-box 进程内流量 tracker、跨进程统计快照、即时速率与当前 outbound 展示已落到代码与自动测试。
- [x] 当前工作树的平台无关测试通过。
- [ ] 源码冻结后重新构建当前版本的 debug HAP 并记录 SHA-256；历史成功包不能代替当前产物。
- [ ] HDC 设备可见。
- [ ] 最终 HAP 真机安装与真实流量闭环。

任何后续源码修改都会使“测试通过/HAP 构建通过”快照失效，必须重新运行第 10 节；任何设备、系统或网络环境变化都应重新执行相关真机项。

## 15. 主要依据

- [OpenHarmony VPN Extension 开发说明](https://gitee.com/openharmony/docs/blob/08986484ea997e1da01ac9221d20dbb0a54b4922/en/application-dev/network/net-vpnExtension.md)
- [OpenHarmony 多 HAP 进程模型](https://gitee.com/openharmony/docs/blob/e99082d84adcc46cde561d79b04fbf2fad68a723/en/application-dev/quick-start/multi-hap-principles.md)
- [sing-box v1.13.18](https://github.com/SagerNet/sing-box/releases/tag/v1.13.18)
- [sing-box libbox PlatformInterface](https://github.com/SagerNet/sing-box/blob/v1.13.18/experimental/libbox/platform.go)
- [sing-box GPLv3 许可证](https://github.com/SagerNet/sing-box/blob/v1.13.18/LICENSE)
