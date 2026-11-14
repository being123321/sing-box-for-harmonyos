# VPN 保活与恢复四问审查（2026-11-15）

审查基线：`3597fb56a7d0aab1e97a33746abeb2e421240b24`（0.90.26 保活改造前快照，worktree `tmp/wt-baseline-3597`）。
范围：保活（后台存活）、切网（网络切换）、核心存活、掉线重启（意外中断恢复）四问结论；本轮五项修复（Part A/B/C/E + 测试基建）；与 sing-box 官方（libbox / SFA）偏差清单；手动测试清单（未执行）。

## 一、四问结论

### 1. 保活（后台存活）架构
- UIAbility 申请 `dataTransfer` 类型长时任务（`KEEP_BACKGROUND_RUNNING`），承载通知栏 LIVE_VIEW（真实累计字节，每分钟最多一次，无流量不伪造进度）。
- Go 核心运行在独立 VPN Extension 进程，与 UIAbility 进程分离；Extension 进程存活由系统 VPN 连接保证，长时任务本身不直接保护 Extension 进程（与 `KEEPALIVE-CHANGES.md` 记录的限制一致）。
- 长时任务随停止/挂起/状态过期/UIAbility 销毁释放，失败不循环重申请。

### 2. 切网（网络切换）
- TUN interface 在启动时一次创建，物理网络切换不重建 TUN、不重建 VPN 连接（`buildVpnConfig` 仅含 TUN 地址/路由，与物理网无关）。
- 切网仅触发 `network-change` / `dns-change` 控制命令：更新路由与运营商城（`automaticLocalDnsConfig`/`networkDnsAddresses`），自动 DNS 跟随物理 DNS 变化且不重启 TUN（见 `vpn-recovery.test.ts:570` 规格）。
- `classifyUnderlayTransition` 处理 Wi-Fi/蜂窝底网迁移，`probeVpnChannel` 验证 VPN 归属（owned/foreign/absent/unknown）。

### 3. 核心存活
- sing-box 核心（`libharmonycore.so`）与 VPN Extension 同进程加载，Extension 被杀即核心死，无跨进程核心。
- 健康监督（`checkCoreHealth`）区分：瞬态读取失败（`runtime-health-retry`，不重启）；确认性 TUN/核心丢失（进入恢复）；确认性排除（SSID 挂起）；用户策略停止。
- 心跳与状态经 runtimeBridge（publishStatus/心跳通道）同步到 UIAbility。

### 4. 掉线重启（意外中断恢复）—— 三层
1. **Extension 内有界自动重试**（Part A 恢复）：`recoverRuntime` 恢复完整门控（owner-wait / foreign VPN / 用户策略 / 底网）+ `RecoveryBudget`（120s 窗口最多 3 次，退避 5s/15s/60s）+ 冷却。确认性故障（foreign VPN、用户停止、策略排除）立即停止，不重试。可执行规格：`tooling/tests/vpn-recovery.test.ts`（52/52 绿）。
2. **UI 一键恢复**（Part B 新增）：`applyStatus` 检测 `vpnInterrupted`（`vpn-active` 意图为开 + 运行态非 running + 非挂起），状态页显示中断横幅，一键调用 `reestablishVpn()`（disconnect → 重连当前选中配置）。
3. **升级重启**：`handleUpgradeRestart`（升级杀死 Extension 后重建会话）现复用同一 `reestablishVpn()`。

竞态与语义保证：`commandEpoch` CAS 防并发命令；用户主动停止先 `setVpnIntent(false)` 清除 `vpn-active` 意图，不会误判为意外中断；`probeVpnChannel` 防止认领 foreign VPN。

## 二、本轮修复明细

| Part | 文件 | 内容 |
|---|---|---|
| A 恢复引擎 | `NetworkVpnExtAbility.ets` | 恢复 3597fb56 的完整 `recoverRuntime` 体 + `nextRecoveryAttempt` import；`validatedConfig` 缓存生命周期修正（`publishSsidSuspension` 清除——挂起边界必须重验证；`closeSsidResources` 保留——恢复内重用；`cleanupResources` 释放；onCreate/onDestroy 清） |
| B 一键恢复 | `SfaIndex.ets` | 提取 `reestablishVpn()`；`@State vpnInterrupted` 中断检测（applyStatus 末尾）；中断横幅 + 一键恢复按钮 |
| C 扫码对齐 | `SfaProfiles.ts` / `SfaIndex.ets` | 新增 `resolveProfileSaveTarget`（同 URL 覆盖去重）；`saveEditor` 接入去重 + `scanSave` 语义（远程空内容保存=扫码/导入链接保存：强制重新下载、跳过覆盖/另存弹窗、不计为本地修改）+ 保存后自动选中（`switchSelection` 从 `selectProfile` 提取；非运行态直接切换；运行态弹窗确认后 `reloadProfile` 热切换；另存路径不切换；已 restart 路径跳过） |
| E 规则选项消失 | `RuntimeChoices.ts` | `applyChoices` 删除 `clash_api.default_mode` 写入；remembered 模式由 Extension 启动后既有 `core.control({action:'mode'})`（`resolveClashModeSpelling` 从实际规则解析拼写）恢复 |
| 测试基建 | 多个测试 | 见下"基线分类" |

### Part E bug 根因与分析
用户选择直连/全局后 `rememberChoice` 持久化 `ProfileChoices.mode`；下次启动 `applyChoices` 把 remembered 模式写进 `clash_api.default_mode`。Go 端 `NewManager` 以 `defaultMode` 为"初始模式"前插 ModeList，导致 ModeList 缺项（如记住 direct 后列表不含 rule），UI 三按钮消失。修复后 `default_mode` 恒保持配置原值（无则 Go 前插 "Rule"），三模式（规则/直连/全局）始终齐全；启动瞬间按默认模式短暂运行（与 SFA 一致），随后 control 恢复 remembered 模式。核心大小写拼写由 `resolveClashModeSpelling` 从 route/dns 规则 + `experimental.clash_api` 证据解析，证据不足则跳过 control（Go 桥接层 `main.go:740-751` 校验 ModeList，盲发会被拒绝并中断启动流程，故必须证据门控）。

## 三、与 sing-box 官方（libbox / SFA）偏差清单
- **https-only**：`downloadRaw`、`parseSfaCatalog`、`importSmart` 三处强制 https，SFA 允许 http。全应用安全不变量，有意保留。
- **无 QRS 动图二维码**、无 gzip 二进制 `decodeProfileContent`（SFA 特性），已知差距。
- **无远程配置自动更新**（SFA `autoUpdate=true` / `interval=60`），保持手动"更新配置"。
- **扫码直接 https:// URL 走节点订阅导入**（用户确认），SFA 会创建远程配置。
- **已对齐**：`parseProfileQr` 与 libbox `ParseRemoteProfileImportLink` 语义一致（query `+`→空格、fragment 解码、name 空回退 host）；同 URL 去重 + 保存后自动选中对齐 SFA `andSelect=true`。
- 慢速重试语义：恢复重试是有界的（RecoveryBudget 3 次/120s），非无限；瞬态健康失败仅缓存退出慢速重查，不重启隧道。

## 四、测试基线分类（3597fb56 对比）

### KEEPALIVE 改造引入（本轮已全部修复）
- vpn-recovery 18（`recoverRuntime` 被改为全停 + 丢失 import）
- network-settings 1（e40d62fb beta 包名常量，`SELF_BUNDLE_NAMES` 双通道拒绝已补）

### 预存失败（破坏时间线，非 KEEPALIVE 引入）
- ssid-extension 13：3 失败自 877d1529（0.90.14），10 自 a38b5247（0.90.23）——本轮修复（fixture 生产 JSON 哨兵 + vm 全局 + 路径感知 fileIo），14/14 绿
- background-runtime 1：3597fb56 引入 CarrierDns——本轮修复，5/5 绿
- profile-editor-save 5：vm 上下文缺 `mergeRetainedProfileNodes` 等依赖——本轮修复（补 `resolveProfileSaveTarget`/`mergeRetainedProfileNodes`/`commitEditedNodes`/`switchSelection` 桩），6/6 绿
- index-ui-contract 6（regex `this.configurationBusy && !stoppingAllowed` 不再匹配）、subscription-usage 2、profile-nodes 1、api22-compatibility 1：预存断言漂移，未处理
- vpn-recovery test 232 fixture 本轮补真实模式证据（原 fixture 依赖 applyChoices 写 default_mode 的反馈回路）

### 环境性失败（本机无法修复，记录）
- release-* 30：`C:\tmp` 不存在 → mkdtemp ENOENT
- build-toolchain-lock 5 + core-vendor-lock 10：go/python 不在 PATH → spawnSync ENOENT
- navigation-drag 3 / profile-gestures 3 / ssid-editor 2 / subscription-visibility 2：node `stripTypeScriptTypes` 无法解析 ArkUI 尾随闭包语法（vm 加载 SfaIndex.ets 区域）

**最终全量：pass=496 fail=59（556 tests），与基线相比 +5 修复、0 新增失败**（存档 `tooling/full-b.txt`）。

## 五、构建验证
- `arkts_check`：本轮 5 个改动文件（SfaIndex.ets / NetworkVpnExtAbility.ets / RuntimeChoices.ts / SfaProfiles.ts / NetworkSettings.ts）全部通过（仅基线 worktree 旧副本报 2 个无关错误）。
- hvigor：ArkTS 管线全部通过（BuildJS / CompileResource / ProcessRouterMap 等 20 任务）；`build-profile.json5` `compileSdkVersion`/`targetSdkVersion` 26.0.0 → 26.0.1（本机 DevEco Studio 26.0.1 要求匹配）。
- **HAP 组装被环境阻塞**：CMake 需要 `core/go/out/libharmonycore.so`（OHOS arm64 Go 核心），本机无 Go 工具链且全盘无预编译产物。ArkTS 代码正确性已由 hvigor 编译验证；Go 核心构建需在有 Go 环境的机器执行（与 build-toolchain-lock 测试失败同根因）。

## 六、手动测试清单（未执行，需真机）
1. 启动 VPN → 退后台锁屏 10 分钟+ → 长时任务通知仍在、连接存活。
2. 运行中切换 Wi-Fi ↔ 蜂窝 → TUN 不重建、流量不中断、自动 DNS 跟随。
3. `hdc shell aa force-stop`（或系统杀）Extension → 120s 内自动重试 ≤3 次（退避 5/15/60s）；预算耗尽后停止，状态页出现"VPN 连接已中断"横幅 → 一键恢复成功。
4. 用户主动停止 → 无横幅、无自动重连；`vpn-active` 偏好已清除。
5. 规则页三按钮（规则/直连/全局）在任何 remembered 模式重启后始终齐全；重启后 remembered 模式正确恢复。
6. 同一 `sing-box://import-remote-profile` 链接扫两次 → 配置不重复，第二次覆盖更新；保存后自动选中；VPN 运行其它配置时弹窗确认热切换。
7. SSID 排除网络 → 挂起（无横幅）；离开排除网络 → 自动恢复并重验证配置。
8. 应用内升级（覆盖安装）→ 自动重建 VPN 会话。
