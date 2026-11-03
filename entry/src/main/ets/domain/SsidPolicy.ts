export interface SsidPolicy { enabled: boolean; direct: string[]; proxy: string[]; fallback: string; excluded?: string[]; excludedAction?: string }
export function normalizeSsidPolicy(value: SsidPolicy): SsidPolicy {
  if (!value || typeof value.enabled !== 'boolean' || !Array.isArray(value.direct) || !Array.isArray(value.proxy) || !['keep', 'rule', 'direct', 'global'].includes(value.fallback)) throw new Error('SSID 规则无效')
  const direct: string[] = value.direct.map((name: string) => name.trim()).filter((name: string) => name.length > 0)
  const proxy: string[] = value.proxy.map((name: string) => name.trim()).filter((name: string) => name.length > 0)
  if (direct.length + proxy.length > 100 || [...direct, ...proxy].some((name: string) => name.length > 128)) throw new Error('SSID 规则过多或名称过长')
  if (direct.some((name: string) => proxy.includes(name))) throw new Error('同一 SSID 不能同时配置直连和代理')
  const excluded: string[] = value.excluded === undefined ? direct : value.excluded
  if (!Array.isArray(excluded) || excluded.length > 100 || excluded.some((name: string) => typeof name !== 'string' || name.length === 0 || encodeURIComponent(name).replace(/%[A-F0-9]{2}/gi, 'x').length > 32)) throw new Error('SSID 不能为空且不能超过 32 字节')
  if (value.excludedAction !== undefined && !['suspend', 'direct'].includes(value.excludedAction)) throw new Error('SSID 行为无效')
  return { enabled: value.enabled, direct: direct, proxy: proxy, fallback: value.fallback, excluded: Array.from(new Set(excluded)), excludedAction: value.excludedAction || 'suspend' }
}
export function ssidMode(policy: SsidPolicy, ssid: string): string {
  if (!policy.enabled) return 'keep'
  if (ssid.length > 0 && policy.direct.includes(ssid)) return 'direct'
  if (ssid.length > 0 && policy.proxy.includes(ssid)) return 'global'
  return policy.fallback
}

export function shouldSuspendSsid(policy: SsidPolicy, ssid: string): boolean {
  return policy.excludedAction !== 'direct' && policy.enabled && ssid.length > 0 && (policy.excluded || policy.direct).includes(ssid)
}
