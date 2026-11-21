# 核心低内存策略修改

基于本地 sing-box 1.14.4 源码及其 iOS OOM 策略核对，未复制 Apple 平台的 50 MiB 进程限制。

## 已修改

- core/go/memory_policy.go：默认 Go 软目标从 512 MiB 调为 128 MiB，GCPercent 设置为 50，与本地 iOS 策略使用的 GC 比例一致。128 MiB 是鸿蒙初始调优值，不是实测结论；Go 可以超过它。用户配置中的 debug 设置在服务启动时仍可覆盖这些默认值。
- 保留已有鸿蒙 OS 内存压力通知、30 秒冷却、异步进入核心回收、停机后归还内存。不增加固定周期强制 GC，不关闭正常连接来追求数字。
- third_party/sing-box/protocol/naive/outbound.go：仅在 openharmony、非 QUIC、接收窗口未设置或为零时，设置 4 MiB HTTP/2 默认窗口。显式配置及 QUIC 窗口不变。当前 build-core.ps1 未启用 with_naive_outbound，所以此项仅为后续启用 Naive 做适配，当前构建无此收益。未更改其他协议窗口。
- core/go/memory_snapshot.go：运行快照新增 goMemory，记录 Go runtime 占用（total-released）、堆对象、归还页、堆目标、GC 次数及实际软限制。只在原有状态采样时读取指标，不额外设置采样定时器或触发 GC。
- 更新内存策略测试，覆盖 GC 默认值重新应用及运行时全局参数恢复。

## 验证与限制

仅完成代码与接线静态核对。本机找不到 Go 工具链，构建脚本引用的旧工具链路径也不存在，新增/既有 Go 测试未执行。遵照要求，没有构建 App。未做真机内存、CPU、速度、功耗或稳定性测量，不宣称已降低到某个内存值。

128 MiB 软目标与 GC 50 可能增加 GC 开销，规则集或多连接场景仍可能超出；需与原版对照测量后决定是否保留该默认值。没有加入 with_low_memory 标签，也没有启用基于 Apple 扩展限制的 OOM 杀连接策略。

## 后续真机比较

同配置比较原版与修改版：空闲、测速、多连接和锁屏后台。单独记录 VPN Extension 进程 RSS/峰值，UIAbility 单独记录；goMemory 只反映 Go，不能代替整个进程。比较吞吐、CPU、GC 次数增量、断流与重连情况。无需先构建即可审阅本次源码修改。

参考：
- https://pkg.go.dev/runtime/debug#SetMemoryLimit
- third_party/sing-box/service/oomkiller/policy.go（本地同版本 iOS GCPercent=50）
- third_party/sing-box/docs/configuration/outbound/naive.md（本地版本窗口说明）
