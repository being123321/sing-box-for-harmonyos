# v2rayH内核对照（2026-11-06）

审查对象：[JuckyLee668/v2rayH](https://github.com/JuckyLee668/v2rayH)，提交`cc6cd53388bf707a980a66f1f4551b37eb487d3e`。本次重新查询main仍为该提交；未复制对方代码或替换本项目内核。

## 数据路径与实际可比范围

v2rayH将Xray和sing-box通过c-archive合入一个共享Go runtime。Xray的TUN实现承担L3到连接的处理；hy2/TUIC等通过本机SOCKS链式转发到sing-box。本项目已有一个Go runtime，sing-box直接处理TUN、DNS、路由和出站，不能把“静态链接”或“减少runtime数量”作为本项目尚缺的性能优化。

本项目LocalConfig适配器将TUN设为gvisor。v2rayH使用其vendored Xray proxy/tun中的轻量TCP/IP栈。两者支持范围和连接管理不同，不能将tcp_lightweight.go作为sing-box网络栈的即插即用替代，也没有本次同机测速证明哪个更快或更省电。

## 文件句柄和非阻塞处理

- [v2rayH tun_openharmony.go](https://github.com/JuckyLee668/v2rayH/blob/cc6cd53388bf707a980a66f1f4551b37eb487d3e/native/libxray/xray-core/proxy/tun/tun_openharmony.go)：SetNonblock后F_DUPFD_CLOEXEC，原平台句柄保留；Close关闭复制的读取句柄。
- [v2rayH tun_fd.go](https://github.com/JuckyLee668/v2rayH/blob/cc6cd53388bf707a980a66f1f4551b37eb487d3e/native/libxray/xray-core/proxy/tun/tun_fd.go)：os.File及runtime poller读取，写侧RWMutex与关闭状态，关闭时结束文件读取。
- 当前sing-box experimental/libbox/service.go同样dup平台fd；sing-tun的gvisor路径经fdbased.New设置非阻塞，NativeTun.Close及GVisor.Close释放TUN和协议栈。因此不能把“增加dup/非阻塞”作为新收益。
- 当前libbox service_other.go用syscall.Dup；v2rayH的F_DUPFD_CLOEXEC可避免复制句柄被exec子进程继承，是值得单独评估的句柄边界加固，但不等于降低内存或修复系统销毁VPN。需针对平台构建和关闭语义测试后再改，本版未改。
- v2rayH在SetNonblock失败时关闭传入平台句柄，属于其所有权约定；不应直接复制到本项目，否则可能与OS连接所有权发生冲突。

## 缓冲、队列和内存

[stack.go](https://github.com/JuckyLee668/v2rayH/blob/cc6cd53388bf707a980a66f1f4551b37eb487d3e/native/libxray/xray-core/proxy/tun/stack.go)和[tcp_lightweight.go](https://github.com/JuckyLee668/v2rayH/blob/cc6cd53388bf707a980a66f1f4551b37eb487d3e/native/libxray/xray-core/proxy/tun/tcp_lightweight.go)使用缓冲复用、接收窗口和发送队列限制，部分路径保留读取缓冲以减少复制。这是该栈设计的一部分，不能孤立移植参数。

当前sing-tun/gVisor已有向量写入、缓存iovecs和TCP接收缓冲自动调节，具体缓冲范围有平台分支。盲目将所有TCP窗口或MTU调小，可能降低高延迟链路吞吐；本次不改。已有Go512MiB软内存目标只约束Go管理内存，未限制整个进程RSS。

## 建议优先级

1. 受控切网/挂起重建测试中核对系统VPN、当前会话、原平台fd、核心副本及旧读循环退出，关注Close返回与新服务创建的先后；没有持续流量时不能仅凭计数不变判断故障。
2. 扩展意外终止与TUN仍存在/已不存在分开定位。进程已退出时计时器不再工作，不能用轻量栈或更多心跳替代系统生命周期恢复路径。
3. 固定手机、节点、协议、DNS/路由规则、并发数和网络，比较吞吐、CPU、RSS/PSS、Swap、恢复时延及较长周期耗电，再决定是否做移动端缓冲策略或可选网络栈试验。
4. CLOEXEC作为独立资源安全改动评估；不要把fd编号递增当作泄漏证明。

结论：保持sing-box原生TUN架构，本次没有证据支持切换到Xray或承诺性能提升。此前0.90.6已落实后台Tailscale界面快照精简；0.90.9只调整玻璃材质，不修改内核二进制。
