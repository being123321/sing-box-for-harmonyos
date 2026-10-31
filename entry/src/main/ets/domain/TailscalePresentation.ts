import type { TailscaleEndpointStatus } from './TailscaleTypes'

export function selectedTailscaleEndpoint(endpoints: TailscaleEndpointStatus[] | null | undefined, tag: string): TailscaleEndpointStatus | null {
  if (!endpoints || endpoints.length === 0) return null
  if (tag.length === 0) return endpoints[0]
  return endpoints.find((endpoint: TailscaleEndpointStatus) => endpoint.endpointTag === tag) || null
}

export function tailscaleEmptyHint(): string {
  return '请在配置中添加 Tailscale 端点并启动 VPN，再返回此页。普通代理节点不会自动成为 Tailscale 端点。'
}
