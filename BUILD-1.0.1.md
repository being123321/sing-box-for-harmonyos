# 1.0.1 双渠道构建

- 稳定版：1.0.1，com.harmonynet.assistant，核心 1.14.4。
- 测试版：1.0.1-beta，com.harmonynet.assistant.beta，核心 1.15.0-alpha.13。
- 内部版本码：1000136。
- 两包均未签名；未额外封装 ZIP；由用户自行签名。
- 两包均启用 compressNativeLibs / extractNativeLibs，并核对包内核心为 Deflate 压缩，字节与本次核心经 llvm-strip --strip-all 后一致。
- 内核分别重新编译，未复用旧 HAP 或旧核心；保留原有渠道包名与存储加密命名空间。
- 两个渠道均通过 Go 核心编译、ArkTS 编译及 HAP 打包；内存策略的独立 Go 单元测试通过。编译存在 API 异常处理与 N-API 声明等警告，未进行完整历史测试和真机验证。
- 为本机 DevEco 26.0.1 使用内置 SDK，移除了固定 compileSdkVersion 配置；目标版本与最低兼容版本保留原设置。
- 修正完整编译暴露的 notificationSlotType 字段和 WatchEvent 导入问题。
- Beta Release 对应源码的配置校验 stub 缺少 Alpha 自动重定向接口，本次补充不支持返回值，未启用 Linux 自动重定向。
- 原仓库稳定与 Beta 标签指向同一稳定源码；Beta 构建使用 Release 附带对应源码及独立模块锁，未仅改名冒充测试内核。

实际保活、后台通知更新、订阅刷新、内存峰值、CPU 与吞吐量仍需用户签名后真机验证。构建成功不代表这些运行时指标已验收。

BUILD-1.0.1.json 记录版本、包名、文件尺寸、原生压缩数据与哈希；SHA256SUMS-1.0.1.txt 可用于下载校验。
