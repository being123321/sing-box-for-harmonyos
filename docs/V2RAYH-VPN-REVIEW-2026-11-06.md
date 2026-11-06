# v2rayH VPN生命周期对照（2026-11-06）

参考项目：[JuckyLee668/v2rayH](https://github.com/JuckyLee668/v2rayH)，本次固定审查提交 `cc6cd53388bf707a980a66f1f4551b37eb487d3e`，未复制其实现代码。

## 能确认的事实

- [VPN扩展源码](https://github.com/JuckyLee668/v2rayH/blob/cc6cd53388bf707a980a66f1f4551b37eb487d3e/entry/src/main/ets/vpnability/MyVpnExtAbility.ets)：onCreate读取配置并创建VPN；onDestroy停止Xray、sing-box并请求destroy。没有扩展内的周期性TUN健康检查、专用后台watchdog或静音音频。
- [EntryAbility](https://github.com/JuckyLee668/v2rayH/blob/cc6cd53388bf707a980a66f1f4551b37eb487d3e/entry/src/main/ets/entryability/EntryAbility.ets)明确允许后台UI被冻结，VPN由扩展持有；不是让整个应用永远不退出。
- [AppState](https://github.com/JuckyLee668/v2rayH/blob/cc6cd53388bf707a980a66f1f4551b37eb487d3e/entry/src/main/ets/common/AppState.ets)的故障转移定时器位于UI侧，不能据此证明UI被冻结时仍能检查或重启系统VPN。
- 它的网络栈／双内核转发架构与本项目不同。源码不能证明其在相同设备、节点和网络条件下更省电、更省内存或更不易被系统销毁。

## 官方约束

[华为VPN开发指南](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-Guides/net-vpnextension/)说明：调用startVpnExtensionAbility的应用进程退出，或VPN服务进程销毁，都可能触发系统主动停止VPN。冻结与退出必须区分；扩展内计时器无法保证在进程已被终止后自行唤醒。

[protectProcessNet参考](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-net-vpnextension/)用于使受保护进程通过物理网络收发，是出站保护，不是保活。v2rayH在保护失败后仍启动内核；本项目不借鉴这个失败后继续的分支。

## 当前项目已有的处理

- 扩展负责读取保存的启动配置、创建TUN、启动/停止内核和销毁系统连接；UI退后台停止界面轮询。
- superviseVpnChannel区分本应用VPN、无VPN、其他VPN、未知；未知不当作掉线，其他VPN不抢占。
- 内核运行状态独立检查；丢失系统VPN时重新建立连接、TUN及内核服务；重复恢复有退避和冷却；手动停止、SSID挂起优先。
- protectProcessNet在内核初始化前完成；Go出站还通过平台socket控制做保护。
- libbox OpenTun对平台fd进行dup后交给TUN实现。核心停止和系统VPN销毁是两段资源清理；失败保留清理状态，不能只根据fd编号变化判断是否泄漏。

## 尚不能保证的部分

- 目前系统VPN探测与核心running检查不等于完整的TUN数据路径健康证明；platformTun>=0只证明保存了编号，不能单独证明当前设备可读写。
- 有效fd及收发计数都需要结合会话和系统接管状态判断。空闲时无流量、节点慢或网络暂不可用都不能单独触发反复销毁VPN。
- 之前SwapFull事件与扩展心跳停止时间相近，支持系统内存压力退出这一方向，但不能证明所有掉线都同源；当时事件没有提供可精确归属的目标PID。
- 用户已要求移除VPN运行监控，本次不恢复诊断页面和持久化事件记录。进程退出原因需要使用系统调试日志，不能靠重开监控或改轮询频率来宣称根治。

## 本次落地的精简

借鉴“扩展只做必要转发工作”的原则，0.90.6在UI活动租约失效/后台时停止周期Tailscale界面状态快照：不额外调用native tailscaleStatus，也不写tailscale-status.json。原先随后台3秒心跳周期触发，理论上最多约1200次每小时；这是调用次数估算，不是实测耗电或内存节省。

VPN心跳、核心健康检查、切网和SSID策略不变，Tailscale实际连接和命令通道不变；前台恢复后重新发布状态，显式命令仍可直接请求状态。它是后台资源优化，不是修复所有VPN丢失的结论。

验证：29项后台、Tailscale命令及VPN恢复相关测试通过；两渠道编译、压缩验证。无新版本真机长时间测试，无内存/耗电对照数据。下一步应做同设备同配置的受控进程/系统VPN/TUN生命周期复现，再决定是否补充会话绑定的数据路径故障检测。
