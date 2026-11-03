export interface DrawerMenu { key: string; title: string; detail: string }
export function drawerRoot(page: string): string {
  if (['configuration','profiles','presets','nodes','import','node-editor','editor','json-editor','profile-node-editor','add-profile','url-import'].includes(page)) return 'configuration'
  return page
}
export function drawerParent(page: string): string {
  if (page === 'json-editor') return 'editor'
  if (page === 'editor' || page === 'profile-node-editor' || page === 'add-profile') return 'profiles'
  if (page === 'node-editor' || page === 'import' || page === 'url-import') return 'nodes'
  if (['nodes','profiles','presets'].includes(page)) return 'configuration'
  return ''
}
export function drawerMenus(tab: string, page: string): DrawerMenu[] {
  let entries: DrawerMenu[] = []
  if (tab === 'tools') entries = [
    {key:'configuration',title:'配置',detail:'基础配置 / 自定义配置'},
    {key:'webrtc',title:'WebRTC 网络检测',detail:'候选类型与 STUN 出口'},
    {key:'tailscale',title:'Tailscale',detail:'端点、登录与 Taildrop'},
    {key:'dns-query',title:'DNS 查询',detail:'查询域名解析结果'}]
  else if (tab === 'settings') entries = [
    {key:'appearance',title:'应用设置',detail:'主题、透明效果'},
    {key:'privacy',title:'WebRTC 防护',detail:'STUN 与 IPv6'},
    {key:'configuration',title:'配置',detail:'基础配置 / 自定义配置'},
    {key:'ssid',title:'按需连接',detail:'按 Wi-Fi 分别挂起或直连'},
    {key:'applications',title:'分应用代理',detail:'启用、绕行模式'},
    {key:'cards',title:'仪表盘项目',detail:'显示或隐藏卡片'},
    {key:'vpn-monitor',title:'VPN 运行监控',detail:'心跳与系统退出事件'},
    {key:'sources',title:'开源项目与源码地址',detail:'来源、版本与许可证'},
    {key:'about',title:'关于与更新',detail:'版本与 GitHub 更新'}]
  const root: string = drawerRoot(page)
  if (root && !entries.some((entry: DrawerMenu) => entry.key === root)) entries.push({key:root,title:root === 'configuration' ? '配置' : root === 'groups' ? '策略组' : root === 'connections' ? '连接' : '菜单',detail:''})
  return entries
}
