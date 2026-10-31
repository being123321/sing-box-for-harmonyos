import type { TailscaleEndpointStatus } from './TailscaleTypes'

export function selectedTailscaleEndpoint(endpoints: TailscaleEndpointStatus[] | null | undefined, tag: string): TailscaleEndpointStatus | null {
  if (!endpoints || endpoints.length === 0) return null
  if (tag.length === 0) return endpoints[0]
  return endpoints.find((endpoint: TailscaleEndpointStatus) => endpoint.endpointTag === tag) || null
}

export function tailscaleEmptyHint(): string {
  return '请在配置中添加 Tailscale 端点并启动 VPN，再返回此页。普通代理节点不会自动成为 Tailscale 端点。'
}

export function canOpenTailscaleAuthUrl(value: string): boolean {
  if (value.length === 0 || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) return false
  const match: RegExpMatchArray | null = value.match(/^https?:\/\/([^/?#]+)(?:[/?#]|$)/i)
  return match !== null && !match[1].includes('@')
}

export function tailscaleStateLabel(state: string, fallback: string): string {
  switch (state) {
    case 'Running': return '已连接'
    case 'Starting': return '启动中'
    case 'Stopped': return '已停止'
    case 'NeedsLogin': return '等待登录'
    case 'NeedsMachineAuth': return '等待设备授权'
    case 'NoState': return '尚未就绪'
    default: return fallback || state || '尚未就绪'
  }
}
