# 保活策略修改说明

修改基于下载的 3597fb56a7d0aab1e97a33746abeb2e421240b24 源码快照。

- ~~删除故障自动重建 VPN 的实现，故障时清理核心和 TUN，需用户手动启动。~~ **2026-11-15 更新**：已恢复有界自动重试（`recoverRuntime` + `RecoveryBudget`：120s 窗口最多 3 次，退避 5s/15s/60s；确认性故障立即停止），规格见 `tooling/tests/vpn-recovery.test.ts`，详见 `docs/VPN-KEEPALIVE-RECOVERY-REVIEW-2026-11-15.md`。UI 另提供中断横幅一键恢复（`reestablishVpn`）。
- 保留状态同步、真实流量采样、命令通道及 SSID 策略；这些是功能依赖，不作为系统保活保证。
- UIAbility 申请 dataTransfer 长时任务，声明 KEEP_BACKGROUND_RUNNING 权限及后台模式。
- 使用系统返回的通知 ID 更新 LIVE_VIEW，最多每分钟更新一次真实累计上传和下载字节；无流量时不伪造进度。
- 停止、挂起、状态过期或 UIAbility 销毁时释放任务；失败不循环重申请，同一会话需手动重启。
- 截图中的 updateProcess 不存在于已核对的后台任务 API 中，未加入该调用。

限制：长时任务属于 UIAbility，不能据此断言独立 VPN Extension 进程不会被回收。VPN 传输没有已知总大小，通知展示累计字节，不虚构百分比；系统是否认可该通知为持续传输进度需真机验证，空闲期间可能被取消。尚未做 ArkTS 完整类型检查、App 构建或真机测试。

后续真机验收：确认长时任务申请及通知更新成功；退后台与锁屏超过十分钟；观察真实传输与空闲状态；手动停止并确认任务通知消失；断开 VPN 或终止核心后确认按预算有界重试并在预算耗尽后停止（UI 横幅一键恢复可用）；验证网络切换与 SSID 挂起恢复。

参考：https://developer.huawei.com/consumer/en/doc/doccenter-references/api/js-apis-resourceschedule-backgroundtaskmanager/
