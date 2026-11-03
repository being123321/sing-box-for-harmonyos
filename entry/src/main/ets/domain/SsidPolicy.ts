export interface SsidAction { ssid: string; action: string }
export interface SsidPolicy { enabled: boolean; direct: string[]; proxy: string[]; fallback: string; excluded?: string[]; excludedAction?: string; actions?: SsidAction[] }
export function normalizeSsidPolicy(value: SsidPolicy): SsidPolicy {
  if (!value || typeof value.enabled !== 'boolean' || !Array.isArray(value.direct) || !Array.isArray(value.proxy) || !['keep', 'rule', 'direct', 'global'].includes(value.fallback)) throw new Error('SSID 规则无效')
  const direct: string[] = value.direct.map((name: string) => name.trim()).filter((name: string) => name.length > 0)
  const proxy: string[] = value.proxy.map((name: string) => name.trim()).filter((name: string) => name.length > 0)
  if (direct.length + proxy.length > 100 || [...direct, ...proxy].some((name: string) => name.length > 128)) throw new Error('SSID 规则过多或名称过长')
  if (direct.some((name: string) => proxy.includes(name))) throw new Error('同一 SSID 不能同时配置直连和代理')
  const excluded: string[] = value.excluded === undefined ? direct : value.excluded
  if (!Array.isArray(excluded) || excluded.length > 100 || excluded.some((name: string) => typeof name !== 'string' || name.length === 0 || encodeURIComponent(name).replace(/%[A-F0-9]{2}/gi, 'x').length > 32)) throw new Error('SSID 不能为空且不能超过 32 字节')
  if (value.excludedAction !== undefined && !['suspend', 'direct'].includes(value.excludedAction)) throw new Error('SSID 行为无效')
  const names: string[] = Array.from(new Set(excluded))
  const actions: SsidAction[] = value.actions || []
  if (!Array.isArray(actions) || actions.length > 100 || actions.some((item: SsidAction) => !item || !names.includes(item.ssid) || !['suspend', 'direct'].includes(item.action)) || new Set(actions.map((item: SsidAction) => item.ssid)).size !== actions.length) throw new Error('SSID 独立行为无效')
  return { enabled: value.enabled, direct: direct, proxy: proxy, fallback: value.fallback, excluded: names, excludedAction: value.excludedAction || 'suspend',
    actions: names.map((ssid: string) => ({ ssid: ssid, action: actions.find((item: SsidAction) => item.ssid === ssid)?.action || value.excludedAction || 'suspend' })) }
}
export function ssidMode(policy: SsidPolicy, ssid: string): string {
  if (!policy.enabled) return 'keep'
  if (ssid.length > 0 && policy.direct.includes(ssid)) return 'direct'
  if (ssid.length > 0 && policy.proxy.includes(ssid)) return 'global'
  return policy.fallback
}

export function shouldSuspendSsid(policy: SsidPolicy, ssid: string): boolean {
  return ssidAction(policy, ssid) === 'suspend'
}

export function ssidAction(policy: SsidPolicy, ssid: string): string {
  if (!policy.enabled || !ssid || !(policy.excluded || policy.direct).includes(ssid)) return 'keep'
  return policy.actions?.find((item: SsidAction) => item.ssid === ssid)?.action || policy.excludedAction || 'suspend'
}

export function withSsidRule(policy: SsidPolicy, previousSsid: string, ssid: string, action: string): SsidPolicy {
  const names: string[] = policy.excluded || []
  if (names.includes(ssid) && ssid !== previousSsid) throw new Error('该 SSID 已存在，请编辑已有规则')
  if (previousSsid && !names.includes(previousSsid)) throw new Error('原 SSID 规则已不存在')
  const updated: string[] = previousSsid ? names.map((name: string) => name === previousSsid ? ssid : name) : [...names, ssid]
  const actions: SsidAction[] = updated.map((name: string) => ({ssid: name, action: name === ssid ? action : ssidAction({...policy, enabled: true}, name)}))
  return normalizeSsidPolicy({...policy, excluded: updated, actions: actions})
}
