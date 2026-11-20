# 手机应用列表权限与 HAP 变体

0.2.7 仍不能在普通签名下自动读取完整应用列表。v2rayNG 的 Android QUERY_ALL_PACKAGES 与 PackageManager 不能替代鸿蒙权限。

完整手机列表接入 bundle.getAllApplicationInfo；调用前验证 ohos.permission.GET_BUNDLE_INFO_PRIVILEGED。随包 SDK 将其定义为 system_basic / system_grant、可通过描述文件 provision 授权。此处不使用 API26 getInstalledBundleList：随包定义将对应 enterprise 权限限制为 2in1。

普通 HAP 不申请该高等级权限，可使用原有签名测试界面、SSID优先级和已有名单；没有权限时界面显示“缺少读取应用列表的签名授权”，不会把导入清单显示成扫描成功。

requires-acl HAP 增加 GET_BUNDLE_INFO_PRIVILEGED 权限声明。需要先通过华为开发者平台为该应用申请并获批相应 ACL，取得有效的已签名描述文件，再使用支持该描述文件的签名工具签名。Hokit 能签名、展示 ACL 信息，不代表当前描述文件已获得这一授权。普通 normal、空 allowed-acls 描述文件不满足要求。仅手动修改 JSON、填写权限名称或重新普通签名不能获得系统授权；安装可能被系统拒绝。

构建 ACL 变体：使用此目录 module-acl.json5 替换 entry/src/main/module.json5，再按常规 Release 流程构建。默认清单是不申请高等级权限的普通变体。两种 HAP 的 native core 完全一致，均未签名、未经过获批 ACL 的真机验证。

SSID 优先级高于分应用：启动、设置重启时先检查排除；命中时不创建TUN、不启动代理内核，所有应用均走系统网络。离开排除SSID后恢复，并使用已保存的应用允许／排除范围。
