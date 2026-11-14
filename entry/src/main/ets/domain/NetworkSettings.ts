import type {
  CoreLogLevel,
  NodeSelectionMode,
  RoutingRule,
  RuleKind,
  RuleTarget,
  RunMode
} from './Models.ts'

export type DnsPresetId = 'cloudflare' | 'alidns' | 'quad9' | 'custom'
export type VpnApplicationMode = 'all' | 'allowlist' | 'blocklist'

export interface VpnApplicationScope {
  mode: VpnApplicationMode
  trustedApplications: string[]
}

export interface DnsPreset {
  id: DnsPresetId
  name: string
  endpoint: string
  description: string
}

export interface NetworkSettings {
  schemaVersion: number
  runMode: RunMode
  nodeSelectionMode: NodeSelectionMode
  logLevel: CoreLogLevel
  ipv6Enabled: boolean
  dnsPresetId: DnsPresetId
  customDns: string
  localRules: RoutingRule[]
  applicationMode: VpnApplicationMode
  trustedApplications: string[]
}

export const NETWORK_SETTINGS_SCHEMA: number = 5
export const MAX_LOCAL_ROUTING_RULES: number = 100
export const MAX_LOCAL_RULE_VALUE_LENGTH: number = 253
export const MAX_TRUSTED_APPLICATIONS: number = 256
export const HARMONY_NET_BUNDLE_NAME: string = 'com.harmonynet.assistant.beta'

// Node/server hostnames must be resolvable before a proxied DNS transport can
// start. Keep this bootstrap endpoint IPv4-literal, encrypted and independent
// from the user's remote-DNS choice so selecting an overseas resolver does not
// make VPN startup depend on reaching it directly from the current network.
export const DNS_BOOTSTRAP_ENDPOINT: string = 'https://223.5.5.5/dns-query'

export const DNS_PRESETS: DnsPreset[] = [
  {
    id: 'cloudflare',
    name: 'Cloudflare DoH',
    endpoint: 'https://1.1.1.1/dns-query',
    description: '远端加密上游 · 通过当前路由模式连接'
  },
  {
    id: 'alidns',
    name: 'AliDNS DoH',
    endpoint: DNS_BOOTSTRAP_ENDPOINT,
    description: '远端加密上游 · 中国大陆通常延迟较低'
  },
  {
    id: 'quad9',
    name: 'Quad9 DoH',
    endpoint: 'https://9.9.9.9/dns-query',
    description: '远端加密上游 · 安全过滤上游'
  },
  {
    id: 'custom',
    name: '自定义',
    endpoint: '',
    description: '远端加密上游 · 仅接受 HTTPS DoH 或 TLS DoT 地址'
  }
]

export function defaultNetworkSettings(): NetworkSettings {
  return {
    schemaVersion: NETWORK_SETTINGS_SCHEMA,
    // Global is the reliable first-run baseline. Imported Clash/Mihomo rules
    // can reference providers or policy groups that this client deliberately
    // refuses until their semantics are fully represented.
    runMode: 'global',
    nodeSelectionMode: 'manual',
    logLevel: 'info',
    ipv6Enabled: true,
    dnsPresetId: 'cloudflare',
    customDns: '',
    localRules: [],
    applicationMode: 'all',
    trustedApplications: []
  }
}

/**
 * Validates and upgrades settings loaded from disk. Existing schema 1/2 data
 * predates the IPv6 switch, so it preserves the old dual-stack behaviour.
 */
export function normalizeNetworkSettings(decoded: NetworkSettings): NetworkSettings {
  if (!isRunMode(decoded.runMode) || !isDnsPresetId(decoded.dnsPresetId) ||
    typeof decoded.customDns !== 'string') {
    throw new Error('网络设置版本无法识别，已保留原文件')
  }
  if (decoded.schemaVersion === 1) {
    return {
      schemaVersion: NETWORK_SETTINGS_SCHEMA,
      runMode: decoded.runMode,
      nodeSelectionMode: 'manual',
      logLevel: 'info',
      ipv6Enabled: true,
      dnsPresetId: decoded.dnsPresetId,
      customDns: decoded.customDns,
      localRules: [],
      applicationMode: 'all',
      trustedApplications: []
    }
  }
  if (decoded.schemaVersion === 2) {
    if (!isNodeSelectionMode(decoded.nodeSelectionMode as string) ||
      !isCoreLogLevel(decoded.logLevel as string)) {
      throw new Error('网络设置版本无法识别，已保留原文件')
    }
    return {
      schemaVersion: NETWORK_SETTINGS_SCHEMA,
      runMode: decoded.runMode,
      nodeSelectionMode: decoded.nodeSelectionMode,
      logLevel: decoded.logLevel,
      ipv6Enabled: true,
      dnsPresetId: decoded.dnsPresetId,
      customDns: decoded.customDns,
      localRules: [],
      applicationMode: 'all',
      trustedApplications: []
    }
  }
  if (decoded.schemaVersion === 3) {
    if (!isNodeSelectionMode(decoded.nodeSelectionMode as string) ||
      !isCoreLogLevel(decoded.logLevel as string) || typeof decoded.ipv6Enabled !== 'boolean') {
      throw new Error('网络设置版本无法识别，已保留原文件')
    }
    return {
      schemaVersion: NETWORK_SETTINGS_SCHEMA,
      runMode: decoded.runMode,
      nodeSelectionMode: decoded.nodeSelectionMode,
      logLevel: decoded.logLevel,
      ipv6Enabled: decoded.ipv6Enabled,
      dnsPresetId: decoded.dnsPresetId,
      customDns: decoded.customDns,
      localRules: [],
      applicationMode: 'all',
      trustedApplications: []
    }
  }
  if (decoded.schemaVersion === 4) {
    if (!isNodeSelectionMode(decoded.nodeSelectionMode as string) ||
      !isCoreLogLevel(decoded.logLevel as string) || typeof decoded.ipv6Enabled !== 'boolean' ||
      !Array.isArray(decoded.localRules)) {
      throw new Error('网络设置版本无法识别，已保留原文件')
    }
    return {
      schemaVersion: NETWORK_SETTINGS_SCHEMA,
      runMode: decoded.runMode,
      nodeSelectionMode: decoded.nodeSelectionMode,
      logLevel: decoded.logLevel,
      ipv6Enabled: decoded.ipv6Enabled,
      dnsPresetId: decoded.dnsPresetId,
      customDns: decoded.customDns,
      localRules: normalizeLocalRoutingRules(decoded.localRules),
      applicationMode: 'all',
      trustedApplications: []
    }
  }
  if (decoded.schemaVersion !== NETWORK_SETTINGS_SCHEMA ||
    !isNodeSelectionMode(decoded.nodeSelectionMode as string) ||
    !isCoreLogLevel(decoded.logLevel as string) || typeof decoded.ipv6Enabled !== 'boolean' ||
    !Array.isArray(decoded.localRules) || !isVpnApplicationMode(decoded.applicationMode as string) ||
    !Array.isArray(decoded.trustedApplications)) {
    throw new Error('网络设置版本无法识别，已保留原文件')
  }
  const applicationScope: VpnApplicationScope = normalizeVpnApplicationScope({
    mode: decoded.applicationMode,
    trustedApplications: decoded.trustedApplications
  })
  return {
    schemaVersion: NETWORK_SETTINGS_SCHEMA,
    runMode: decoded.runMode,
    nodeSelectionMode: decoded.nodeSelectionMode,
    logLevel: decoded.logLevel,
    ipv6Enabled: decoded.ipv6Enabled,
    dnsPresetId: decoded.dnsPresetId,
    customDns: decoded.customDns,
    localRules: normalizeLocalRoutingRules(decoded.localRules),
    applicationMode: applicationScope.mode,
    trustedApplications: applicationScope.trustedApplications
  }
}

export function decodeNetworkSettings(serialized: string): NetworkSettings {
  return normalizeNetworkSettings(JSON.parse(serialized) as NetworkSettings)
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57
}

export function validateApplicationBundleName(value: string): string {
  const normalized: string = value.trim()
  if (normalized.length < 7 || normalized.length > 128) {
    throw new Error('应用包名长度必须在 7 到 128 个字符之间')
  }
  const labels: string[] = normalized.split('.')
  if (labels.length < 2) throw new Error('应用包名必须是至少两段的反向域名')
  for (let labelIndex: number = 0; labelIndex < labels.length; labelIndex++) {
    const label: string = labels[labelIndex]
    if (label.length === 0) throw new Error('应用包名不能包含空段')
    const firstCode: number = label.charCodeAt(0)
    if (labelIndex === 0 && !isAsciiLetter(firstCode)) {
      throw new Error('应用包名第一段必须以字母开头')
    }
    if (labelIndex > 0 && !isAsciiLetter(firstCode) && !isAsciiDigit(firstCode)) {
      throw new Error('应用包名后续分段必须以字母或数字开头')
    }
    const lastCode: number = label.charCodeAt(label.length - 1)
    if (!isAsciiLetter(lastCode) && !isAsciiDigit(lastCode)) {
      throw new Error('应用包名分段必须以字母或数字结尾')
    }
    for (let index: number = 0; index < label.length; index++) {
      const code: number = label.charCodeAt(index)
      if (!isAsciiLetter(code) && !isAsciiDigit(code) && code !== 95) {
        throw new Error('应用包名只能包含字母、数字、下划线和点')
      }
    }
  }
  if (normalized === HARMONY_NET_BUNDLE_NAME) {
    throw new Error('网络助手自身不能加入应用白名单')
  }
  return normalized
}

function isVpnApplicationMode(value: string): boolean {
  return value === 'all' || value === 'allowlist' || value === 'blocklist'
}

export function normalizeTrustedApplications(bundleNames: string[]): string[] {
  if (bundleNames.length > MAX_TRUSTED_APPLICATIONS) {
    throw new Error(`应用白名单最多 ${MAX_TRUSTED_APPLICATIONS} 个`)
  }
  const normalized: string[] = []
  for (let index: number = 0; index < bundleNames.length; index++) {
    if (typeof bundleNames[index] !== 'string') throw new Error('应用白名单数据不完整')
    const bundleName: string = validateApplicationBundleName(bundleNames[index])
    if (normalized.includes(bundleName)) throw new Error('同一应用只能加入白名单一次')
    normalized.push(bundleName)
  }
  return normalized
}

export function normalizeVpnApplicationScope(scope: VpnApplicationScope): VpnApplicationScope {
  if (!scope || !isVpnApplicationMode(scope.mode) || !Array.isArray(scope.trustedApplications)) {
    throw new Error('应用接管范围数据不完整')
  }
  const trustedApplications: string[] = normalizeTrustedApplications(scope.trustedApplications)
  if (scope.mode === 'allowlist' && trustedApplications.length === 0) {
    throw new Error('仅所选应用模式至少需要加入一个应用')
  }
  return {
    mode: scope.mode,
    trustedApplications: trustedApplications
  }
}

export function vpnApplicationScope(settings: NetworkSettings): VpnApplicationScope {
  return normalizeVpnApplicationScope({
    mode: settings.applicationMode,
    trustedApplications: settings.trustedApplications
  })
}

function isDigits(value: string): boolean {
  if (value.length === 0) return false
  for (let index: number = 0; index < value.length; index++) {
    const code: number = value.charCodeAt(index)
    if (code < 48 || code > 57) return false
  }
  return true
}

function isValidIpv4(value: string): boolean {
  const parts: string[] = value.split('.')
  if (parts.length !== 4) return false
  for (let index: number = 0; index < parts.length; index++) {
    const part: string = parts[index]
    if (!isDigits(part) || part.length > 3 || (part.length > 1 && part.startsWith('0'))) return false
    const numberValue: number = Number(part)
    if (numberValue < 0 || numberValue > 255) return false
  }
  return true
}

function isValidHostname(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false
  if (isValidIpv4(value)) return true
  const labels: string[] = value.split('.')
  if (labels.length < 2) return false
  for (let labelIndex: number = 0; labelIndex < labels.length; labelIndex++) {
    const label: string = labels[labelIndex]
    if (label.length === 0 || label.length > 63 || label.startsWith('-') || label.endsWith('-')) return false
    for (let index: number = 0; index < label.length; index++) {
      const code: number = label.toLowerCase().charCodeAt(index)
      const letter: boolean = code >= 97 && code <= 122
      const digit: boolean = code >= 48 && code <= 57
      if (!letter && !digit && code !== 45) return false
    }
  }
  return true
}

function isHexDigit(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102)
}

function isValidIpv6(value: string): boolean {
  if (value.length < 2 || value.length > 45 || !value.includes(':')) return false
  // A single boundary colon is never valid. A boundary is allowed only when
  // it is the RFC 4291 compression token "::".
  if ((value.startsWith(':') && !value.startsWith('::')) ||
    (value.endsWith(':') && !value.endsWith('::'))) return false
  const compressionIndex: number = value.indexOf('::')
  if (compressionIndex !== value.lastIndexOf('::')) return false
  const compressed: boolean = compressionIndex >= 0
  const parts: string[] = value.split(':')
  let groupCount: number = 0
  for (let partIndex: number = 0; partIndex < parts.length; partIndex++) {
    const part: string = parts[partIndex]
    if (part.length === 0) continue
    // RFC 4291 permits an IPv4 dotted-quad only in the final 32 bits. Count it
    // as two hexadecimal groups while retaining the strict IPv4 parser above.
    if (part.includes('.')) {
      if (partIndex !== parts.length - 1 || !isValidIpv4(part)) return false
      groupCount += 2
      continue
    }
    if (part.length > 4) return false
    for (let index: number = 0; index < part.length; index++) {
      if (!isHexDigit(part.charCodeAt(index))) return false
    }
    groupCount++
  }
  if (compressed) return groupCount < 8
  return groupCount === 8 && !value.startsWith(':') && !value.endsWith(':')
}

function isLocalRuleKind(value: string): boolean {
  return value === 'domain' || value === 'domain_suffix' || value === 'ip_cidr'
}

function isLocalRuleTarget(value: string): boolean {
  return value === 'proxy' || value === 'direct' || value === 'reject'
}

function validateLocalDomain(value: string): string {
  const normalized: string = value.trim().toLowerCase()
  if (normalized.length === 0) throw new Error('请输入域名')
  if (normalized.length > MAX_LOCAL_RULE_VALUE_LENGTH) throw new Error('域名规则过长')
  if (normalized.includes('://') || normalized.includes('/') || normalized.includes('*') ||
    normalized.includes(' ') || normalized.startsWith('.') || normalized.endsWith('.')) {
    throw new Error('域名规则只能填写完整域名，不支持网址、路径或通配符')
  }
  if (!isValidHostname(normalized) || isValidIpv4(normalized)) {
    throw new Error('域名格式不正确')
  }
  return normalized
}

function validateLocalCidr(value: string): string {
  const normalized: string = value.trim().toLowerCase()
  if (normalized.length === 0) throw new Error('请输入 CIDR 网段')
  if (normalized.length > 64 || normalized.includes(' ') || normalized.includes('\n') ||
    normalized.includes('\r')) throw new Error('CIDR 网段格式不正确')
  const parts: string[] = normalized.split('/')
  if (parts.length !== 2 || !isDigits(parts[1])) throw new Error('CIDR 必须包含有效前缀长度')
  if (parts[1].length > 1 && parts[1].startsWith('0')) throw new Error('CIDR 前缀不能包含前导零')
  const prefix: number = Number(parts[1])
  if (isValidIpv4(parts[0])) {
    if (prefix < 0 || prefix > 32) throw new Error('IPv4 CIDR 前缀必须在 0 到 32 之间')
    return normalized
  }
  if (isValidIpv6(parts[0])) {
    if (prefix < 0 || prefix > 128) throw new Error('IPv6 CIDR 前缀必须在 0 到 128 之间')
    return normalized
  }
  throw new Error('CIDR IP 地址格式不正确')
}

/**
 * Validates one user-authored route. No process, GeoIP, provider, keyword or
 * named-policy-group semantics are accepted until they have real runtime
 * implementations.
 */
export function validateLocalRoutingRule(kind: RuleKind, value: string, target: RuleTarget): RoutingRule {
  if (!isLocalRuleKind(kind)) throw new Error('本地规则仅支持完整域名、域名后缀和 CIDR')
  if (!isLocalRuleTarget(target)) throw new Error('本地规则目标仅支持代理、直连或拒绝')
  return {
    kind: kind,
    value: kind === 'ip_cidr' ? validateLocalCidr(value) : validateLocalDomain(value),
    target: target,
    source: 'local'
  }
}

export function normalizeLocalRoutingRules(rules: RoutingRule[]): RoutingRule[] {
  if (rules.length > MAX_LOCAL_ROUTING_RULES) throw new Error(`本地规则最多 ${MAX_LOCAL_ROUTING_RULES} 条`)
  const normalized: RoutingRule[] = []
  const seen: string[] = []
  for (let index: number = 0; index < rules.length; index++) {
    const source: RoutingRule = rules[index]
    if (!source || source.source !== 'local' || typeof source.kind !== 'string' ||
      typeof source.value !== 'string' || typeof source.target !== 'string') {
      throw new Error('本地规则数据不完整')
    }
    const rule: RoutingRule = validateLocalRoutingRule(source.kind, source.value, source.target)
    const identity: string = `${rule.kind}\n${rule.value}`
    if (seen.includes(identity)) throw new Error('同一匹配条件只能配置一次')
    seen.push(identity)
    normalized.push(rule)
  }
  return normalized
}

function validateAuthority(authority: string): void {
  if (authority.length === 0 || authority.includes('@')) throw new Error('DNS 地址缺少有效主机名')
  let host: string = authority
  let portText: string = ''
  if (authority.startsWith('[')) {
    const close: number = authority.indexOf(']')
    if (close <= 1) throw new Error('DNS IPv6 地址格式不正确')
    host = authority.slice(1, close)
    const suffix: string = authority.slice(close + 1)
    if (suffix.length > 0) {
      if (!suffix.startsWith(':')) throw new Error('DNS 地址端口格式不正确')
      portText = suffix.slice(1)
    }
    if (!host.includes(':')) throw new Error('DNS IPv6 地址格式不正确')
  } else {
    const firstColon: number = authority.indexOf(':')
    const lastColon: number = authority.lastIndexOf(':')
    if (firstColon >= 0) {
      if (firstColon !== lastColon) throw new Error('IPv6 DNS 地址需要使用方括号')
      host = authority.slice(0, firstColon)
      portText = authority.slice(firstColon + 1)
    }
    if (!isValidHostname(host)) throw new Error('DNS 主机名或 IP 地址不正确')
  }
  if (portText.length > 0) {
    if (!isDigits(portText)) throw new Error('DNS 端口必须是数字')
    const port: number = Number(portText)
    if (port < 1 || port > 65535) throw new Error('DNS 端口必须在 1 到 65535 之间')
  }
}

/**
 * Returns the normalized encrypted DNS endpoint or throws a user-facing error.
 * Plain UDP DNS is intentionally not accepted for custom profiles.
 */
export function validateDnsEndpoint(value: string): string {
  const endpoint: string = value.trim()
  if (endpoint.length === 0) throw new Error('请输入自定义 DNS 地址')
  if (endpoint.length > 512) throw new Error('DNS 地址过长')
  if (endpoint.includes(' ') || endpoint.includes('\n') || endpoint.includes('\r') || endpoint.includes('#')) {
    throw new Error('DNS 地址包含不允许的字符')
  }
  let remainder: string = ''
  if (endpoint.startsWith('https://')) {
    remainder = endpoint.slice('https://'.length)
  } else if (endpoint.startsWith('tls://')) {
    remainder = endpoint.slice('tls://'.length)
  } else {
    throw new Error('自定义 DNS 仅支持 https:// DoH 或 tls:// DoT')
  }
  const slash: number = remainder.indexOf('/')
  if (endpoint.startsWith('tls://') && slash >= 0) {
    throw new Error('DoT 地址不能包含路径')
  }
  const authority: string = slash >= 0 ? remainder.slice(0, slash) : remainder
  validateAuthority(authority)
  if (endpoint.startsWith('https://') && slash < 0) {
    return `${endpoint}/dns-query`
  }
  return endpoint
}

export function findDnsPreset(id: DnsPresetId): DnsPreset {
  const found: DnsPreset | undefined = DNS_PRESETS.find((preset: DnsPreset) => preset.id === id)
  return found ? found : DNS_PRESETS[0]
}

export function resolveDnsEndpoint(settings: NetworkSettings): string {
  if (settings.dnsPresetId === 'custom') return validateDnsEndpoint(settings.customDns)
  return findDnsPreset(settings.dnsPresetId).endpoint
}

export function isDnsPresetId(value: string): value is DnsPresetId {
  return DNS_PRESETS.some((preset: DnsPreset) => preset.id === value)
}

export function isRunMode(value: string): value is RunMode {
  return value === 'rule' || value === 'global' || value === 'direct'
}

export function isNodeSelectionMode(value: string): value is NodeSelectionMode {
  return value === 'manual' || value === 'auto' || value === 'failover'
}

export function isCoreLogLevel(value: string): value is CoreLogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
}
