# VPN 退出监控与 TunBox 后台实现核对

## 本次现场与目标

0.83.12 和 0.83.17 Beta 真机现场均观察到：界面进程仍在，但扩展进程与 vpn-tun 不存在；打开界面后自动恢复。0.83.17 当时保存的 SSID 规则为零，不能用按需挂起来解释。既有系统日志未给出确定退出原因。

监控用于保留证据，不宣称解决进程退出或提供系统级守护。

## TunBox 研究

2026-11-03 阅读公开 main 中的以下文件（只作实现对照，未复制代码）：

- [UiGuardian.ets](https://github.com/xiaoli8571/TunBox/blob/main/TunBox_HarmonyOS/entry/src/main/ets/commons/services/UiGuardian.ets)：实际申请顺序为 dataTransfer 优先，失败回退 taskKeeping。注释中还保留“taskKeeping 优先”的旧描述，判断采用函数实现而不是这段注释。
- [BackgroundTaskWatch.ets](https://github.com/xiaoli8571/TunBox/blob/main/TunBox_HarmonyOS/entry/src/main/ets/commons/services/BackgroundTaskWatch.ets)：按实际任务 ID 过滤事件，区分取消、暂停、恢复；用户取消和类型不匹配的取消不立即重挂，存在有界预算、退避及会话代次检查。
- [module.json5](https://github.com/xiaoli8571/TunBox/blob/main/TunBox_HarmonyOS/entry/src/main/module.json5)：申请 KEEP_BACKGROUND_RUNNING，UIAbility 声明 dataTransfer/taskKeeping。
- [音频保活评审](https://github.com/xiaoli8571/TunBox/blob/main/docs/AUDIO_KEEPALIVE_REVIEW_20261022.md)：描述可选低音量 PCM/AVSession 与后台任务核对，也明确记录进程内定时器不是系统唤醒任务；该评审的长期真机验收仍待执行。公开 main 的 UiGuardian 实际顺序应单独核实，不能把评审描述直接视为当前代码。
- [前台会话评审](https://github.com/xiaoli8571/TunBox/blob/main/docs/FOREGROUND_SESSION_REVIEW_20261022.md)：旧心跳不能单独作为销毁现有隧道的依据，优先核对实际存活证据。

本地 API 26 SDK 的 backgroundTaskManager 声明明确：手机 taskKeeping 需要 KEEP_BACKGROUND_RUNNING_SYSTEM ACL；DATA_TRANSFER 有低速取消／暂停原因。本工程没有该 ACL，不新增受限权限，也不引入音频播放或伪造数据传输进度。

## 新监控

- 入口：设置 → VPN 运行监控，刷新／复制诊断。
- 扩展侧记录创建、运行阶段、有效停止命令、网卡观察变化；正常状态最多每 30 秒更新一次文件，连续心跳合并，不不断挤掉历史阶段。
- onDestroy 尝试同步写入独立的小标记，不与异步日志文件竞争。系统突然终止时该回调可能完全不执行；没有标记不能直接认定系统杀进程。
- 界面每 30 秒、恢复检查之前，只读采集旧会话的心跳时间和系统 VPN bearer 存在／不存在／未知。证据读取不启动或停止 VPN；原有恢复流程保持原用途。
- UI 进程订阅 HiAppEvent 的 APP_KILLED、APP_CRASH、APP_FREEZE、RESOURCE_OVERLIMIT。保存系统事件发生时间和收到时间、可用的 PID／运行 ID 与格式受限的原因码。APP_FREEZE 是系统无响应事件，不等同于省电调度挂起。
- APP_KILLED 是应用级事件，有时没有 PID，不保证能定位 VPN 扩展；系统可能下一次启动才交付，未交付不证明没有异常。
- UIAbility 的 lastExitReason 只记为界面进程的上次退出码，不冒充 VPN 退出原因。
- [华为官方终止事件订阅文档](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/hiappevent-watcher-app-killed-events-arkts)支持上述事件方式；仍需本机实际授权、系统交付与覆盖安装后的真机验收。

## 数据和资源

`filesDir/vpn-monitor-extension.json` 与 `vpn-monitor-ui.json` 分开写；进程内同一路径共享写队列，原子替换、每份最多 128 条且不超过约 60 KB。扩展销毁标记为独立 `.destroy` 小文件。

仅保存固定诊断字段；不保存订阅、原始配置、节点名称或凭据、IP、SSID、异常堆栈、系统 external_log 路径；不上传。不会创建新的后台定时器或访问外网，磁盘失败不能阻断 VPN 启停。UI 本身被挂起时也不保证继续采样，依赖扩展自己的既有心跳与系统事件补证。

## 验证边界

测试执行实际监控模块，并替换文件系统／系统事件边界，覆盖序列化、节流、容量、损坏文件恢复、磁盘失败、敏感字段丢弃、重复系统事件及恢复前证据保存。不能替代真机事件交付或长期锁屏测试。
