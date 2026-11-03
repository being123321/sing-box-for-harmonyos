import type {
  ConfigBuildRequest,
  ConfigBuildResult,
  NodeSelectionMode,
  PolicyGroup,
  ProxyNode,
  RoutingRule,
  RuleTarget,
  TlsOptions,
  TransportOptions
} from './Models.ts'
import { DNS_BOOTSTRAP_ENDPOINT, normalizeLocalRoutingRules } from './NetworkSettings.ts'

interface CoreTls {
  enabled: boolean
  server_name?: string
  insecure?: boolean
  alpn?: string[]
  utls?: CoreUtls
  reality?: CoreReality
}

interface CoreUtls {
  enabled: boolean
  fingerprint?: string
}

interface CoreReality {
  enabled: boolean
  public_key: string
  short_id?: string
}

interface CoreHeaders {
  Host: string
}

interface CoreTransport {
  type: string
  path?: string
  host?: string
  headers?: CoreHeaders
  service_name?: string
}

interface CoreOutbound {
  type: string
  tag: string
  server?: string
  server_port?: number
  username?: string
  password?: string
  uuid?: string
  method?: string
  security?: string
  user?: string
  psk?: string
  version?: number
  auth_str?: string
  up_mbps?: number
  down_mbps?: number
  obfs?: string
  congestion_control?: string
  udp_relay_mode?: string
  alter_id?: number
  flow?: string
  tls?: CoreTls
  transport?: CoreTransport
  outbounds?: string[]
  default?: string
  url?: string
  interval?: string
  tolerance?: number
  idle_timeout?: string
  interrupt_exist_connections?: boolean
}

interface CoreInbound {
  type: string
  tag: string
  address: string[]
  mtu: number
  stack: string
}

interface CoreRouteRule {
  action: string
  outbound?: string
  protocol?: string
  ip_version?: number
  ip_is_private?: boolean
  domain?: string[]
  domain_suffix?: string[]
  domain_keyword?: string[]
  ip_cidr?: string[]
}

interface CoreRoute {
  rules: CoreRouteRule[]
  final: string
  auto_detect_interface: boolean
  default_domain_resolver: string
}

interface CoreDnsServer {
  type: string
  tag: string
  server?: string
  server_port?: number
  path?: string
  tls?: CoreTls
  detour?: string
  domain_resolver?: string
}

interface CoreDns {
  servers: CoreDnsServer[]
  final: string
  strategy: string
}

interface CoreLog {
  level: string
  timestamp: boolean
}

interface CoreCertificate {
  store: string
}

interface HostPort {
  host: string
  port: number
}

interface CoreConfig {
  log: CoreLog
  certificate: CoreCertificate
  dns: CoreDns
  inbounds: CoreInbound[]
  outbounds: CoreOutbound[]
  route: CoreRoute
}

interface RuntimePolicyGroup {
  name: string
  tag: string
  outbound: CoreOutbound
}

function coreTag(node: ProxyNode): string {
  return node.id
}

function orderedCandidates(nodes: ProxyNode[], selectedNodeId: string): ProxyNode[] {
  const ordered: ProxyNode[] = []
  const selected: ProxyNode | undefined = nodes.find((node: ProxyNode) => node.id === selectedNodeId)
  if (selected) ordered.push(selected)
  for (let index: number = 0; index < nodes.length; index++) {
    if (nodes[index].id !== selectedNodeId) ordered.push(nodes[index])
  }
  return ordered
}

function buildTls(source: TlsOptions): CoreTls | undefined {
  if (!source.enabled) return undefined
  const tls: CoreTls = { enabled: true }
  if (source.serverName.length > 0) tls.server_name = source.serverName
  if (source.insecure) tls.insecure = true
  if (source.alpn.length > 0) tls.alpn = source.alpn
  // Persisted schema-v1 subscriptions created before these fields existed do
  // not have nested uTLS/Reality objects. Treat them as disabled instead of
  // breaking an otherwise valid saved subscription after an app update.
  if (source.utls !== undefined && source.utls.enabled) {
    tls.utls = { enabled: true }
    if (source.utls.fingerprint.length > 0) tls.utls.fingerprint = source.utls.fingerprint
  }
  if (source.reality !== undefined && source.reality.enabled) {
    tls.reality = {
      enabled: true,
      public_key: source.reality.publicKey
    }
    if (source.reality.shortId.length > 0) tls.reality.short_id = source.reality.shortId
  }
  return tls
}

function buildTransport(source: TransportOptions): CoreTransport | undefined {
  if (source.type.length === 0 || source.type === 'tcp') return undefined
  const transport: CoreTransport = { type: source.type }
  if (source.path.length > 0) transport.path = source.path
  if (source.host.length > 0) {
    if (source.type === 'http' || source.type === 'httpupgrade') transport.host = source.host
    else transport.headers = { Host: source.host }
  }
  if (source.serviceName.length > 0) transport.service_name = source.serviceName
  return transport
}

function nodeQuery(node: ProxyNode, key: string): string {
  const items = node.query
  for (let index: number = 0; index < items.length; index++) {
    if (items[index].key.toLowerCase() === key) return items[index].value
  }
  return ''
}

function buildNodeOutbound(node: ProxyNode): CoreOutbound {
  const outbound: CoreOutbound = {
    type: node.protocol,
    tag: coreTag(node),
    server: node.server,
    server_port: node.port
  }
  // sing-box renames the credential field for a few outbound types, so map
  // them explicitly instead of emitting both names and failing validation.
  if (node.protocol === 'ssh') outbound.user = node.username.length > 0 ? node.username : 'root'
  else if (node.username.length > 0) outbound.username = node.username
  if (node.protocol === 'snell') {
    outbound.psk = node.password
    outbound.version = Number(nodeQuery(node, 'version')) > 0 ? Number(nodeQuery(node, 'version')) : 4
  } else if (node.protocol === 'hysteria') {
    outbound.auth_str = node.password
    outbound.up_mbps = Number(nodeQuery(node, 'upmbps')) > 0 ? Number(nodeQuery(node, 'upmbps')) : 50
    outbound.down_mbps = Number(nodeQuery(node, 'downmbps')) > 0 ? Number(nodeQuery(node, 'downmbps')) : 100
    if (nodeQuery(node, 'obfs').length > 0) outbound.obfs = nodeQuery(node, 'obfs')
  } else if (node.password.length > 0) {
    outbound.password = node.password
  }
  if (node.uuid.length > 0) outbound.uuid = node.uuid
  if (node.protocol === 'tuic') {
    outbound.congestion_control = nodeQuery(node, 'congestion_control').length > 0 ? nodeQuery(node, 'congestion_control') : 'bbr'
    outbound.udp_relay_mode = nodeQuery(node, 'udp_relay_mode').length > 0 ? nodeQuery(node, 'udp_relay_mode') : 'native'
  }
  if (node.protocol === 'shadowtls') {
    outbound.version = Number(nodeQuery(node, 'version')) > 0 ? Number(nodeQuery(node, 'version')) : 3
  }
  if (node.method.length > 0 && node.protocol === 'vmess') outbound.security = node.method
  if (node.method.length > 0 && node.protocol === 'shadowsocks') outbound.method = node.method
  // Saved subscriptions created before alterId was added do not contain this
  // field. Omit zero/undefined while preserving legacy VMess configurations.
  if (node.protocol === 'vmess' && node.alterId !== undefined && node.alterId > 0) {
    outbound.alter_id = node.alterId
  }
  if (node.flow.length > 0) outbound.flow = node.flow
  const tls: CoreTls | undefined = buildTls(node.tls)
  if (tls) outbound.tls = tls
  const transport: CoreTransport | undefined = buildTransport(node.transport)
  if (transport) outbound.transport = transport
  return outbound
}

function uniqueValidNodeTags(nodeIds: string[], validTags: string[]): string[] {
  const result: string[] = []
  for (let index: number = 0; index < nodeIds.length; index++) {
    const nodeId: string = nodeIds[index]
    if (validTags.includes(nodeId) && !result.includes(nodeId)) result.push(nodeId)
  }
  return result
}

function allocatePolicyGroupTag(groupIndex: number, usedTags: string[]): string {
  const base: string = `policy-group-${groupIndex + 1}`
  let candidate: string = base
  let suffix: number = 2
  while (usedTags.includes(candidate)) {
    candidate = `${base}-${suffix}`
    suffix++
  }
  usedTags.push(candidate)
  return candidate
}

function buildRuntimePolicyGroups(groups: PolicyGroup[], nodeOutbounds: CoreOutbound[]): RuntimePolicyGroup[] {
  const validTags: string[] = nodeOutbounds.map((outbound: CoreOutbound) => outbound.tag)
  const usedTags: string[] = validTags.concat(['proxy', 'direct'])
  const result: RuntimePolicyGroup[] = []
  for (let index: number = 0; index < groups.length; index++) {
    const source: PolicyGroup = groups[index]
    const name: string = source.name.trim()
    const memberTags: string[] = uniqueValidNodeTags(source.nodeIds, validTags)
    if (name.length === 0 || memberTags.length === 0) continue
    const tag: string = allocatePolicyGroupTag(index, usedTags)
    let outbound: CoreOutbound
    if (source.type === 'urltest') {
      outbound = {
        type: 'urltest',
        tag: tag,
        outbounds: memberTags,
        url: 'https://www.gstatic.com/generate_204',
        interval: '3m',
        tolerance: 50,
        idle_timeout: '30m',
        interrupt_exist_connections: true
      }
    } else {
      const selectedTag: string = memberTags.includes(source.selectedNodeId) ? source.selectedNodeId : memberTags[0]
      outbound = {
        type: 'selector',
        tag: tag,
        outbounds: memberTags,
        default: selectedTag,
        interrupt_exist_connections: true
      }
    }
    result.push({ name: name, tag: tag, outbound: outbound })
  }
  return result
}

function routeOutbound(target: RuleTarget, policyGroups: RuntimePolicyGroup[]): string {
  if (target === 'proxy') return 'proxy'
  if (target === 'direct') return 'direct'
  const matches: RuntimePolicyGroup[] = policyGroups.filter((group: RuntimePolicyGroup) => group.name === target)
  if (matches.length === 1) return matches[0].tag
  if (matches.length > 1) throw new Error(`规则模式引用重名策略组：${target}`)
  throw new Error(`规则模式引用尚未接通的策略组：${target}`)
}

function buildRule(source: RoutingRule, warnings: string[], policyGroups: RuntimePolicyGroup[]): CoreRouteRule | null {
  if (source.kind === 'rule_set') {
    warnings.push(`远程规则集 ${source.value} 尚未下载；规则模式会拒绝启动`)
    return null
  }
  if (source.kind === 'unsupported') {
    warnings.push(`规则 ${source.value} 尚未支持，未写入运行配置`)
    return null
  }
  if (source.target === 'reject') {
    const rejected: CoreRouteRule = { action: 'reject' }
    if (source.kind === 'domain') rejected.domain = [source.value]
    if (source.kind === 'domain_suffix') rejected.domain_suffix = [source.value]
    if (source.kind === 'domain_keyword') rejected.domain_keyword = [source.value]
    if (source.kind === 'ip_cidr') rejected.ip_cidr = [source.value]
    return rejected
  }
  const rule: CoreRouteRule = { action: 'route', outbound: routeOutbound(source.target, policyGroups) }
  if (source.kind === 'domain') rule.domain = [source.value]
  if (source.kind === 'domain_suffix') rule.domain_suffix = [source.value]
  if (source.kind === 'domain_keyword') rule.domain_keyword = [source.value]
  if (source.kind === 'ip_cidr') rule.ip_cidr = [source.value]
  return rule
}

function parseHostPort(value: string, defaultPort: number): HostPort {
  if (value.startsWith('[')) {
    const close: number = value.indexOf(']')
    const host: string = close > 0 ? value.slice(1, close) : value
    const suffix: string = close > 0 ? value.slice(close + 1) : ''
    const port: number = suffix.startsWith(':') ? Number(suffix.slice(1)) : defaultPort
    return { host: host, port: port }
  }
  const firstColon: number = value.indexOf(':')
  const lastColon: number = value.lastIndexOf(':')
  if (firstColon > 0 && firstColon === lastColon) {
    return {
      host: value.slice(0, firstColon),
      port: Number(value.slice(firstColon + 1))
    }
  }
  return { host: value, port: defaultPort }
}

function parseDnsServer(value: string, detour: string, tag: string, domainResolver: string = ''): CoreDnsServer {
  const trimmed: string = value.trim()
  // sing-box 1.13 treats an explicit detour to an empty `direct` outbound as
  // a startup error (`detour to an empty direct outbound makes no sense`).
  // Omitting detour is the native direct-dial path. On HarmonyOS the Extension
  // protects libc sockets before core startup and the native adapter binds
  // every Go-created socket to a validated NOT_VPN physical underlay.
  const effectiveDetour: string | undefined = detour === 'direct' ? undefined : detour
  if (trimmed.startsWith('https://')) {
    const withoutScheme: string = trimmed.slice('https://'.length)
    const slash: number = withoutScheme.indexOf('/')
    const authority: string = slash >= 0 ? withoutScheme.slice(0, slash) : withoutScheme
    const parsed: HostPort = parseHostPort(authority, 443)
    const path: string = slash >= 0 ? withoutScheme.slice(slash) : '/dns-query'
    return {
      type: 'https',
      tag: tag,
      server: parsed.host,
      server_port: parsed.port,
      path: path,
      tls: { enabled: true, server_name: parsed.host },
      detour: effectiveDetour,
      domain_resolver: domainResolver.length > 0 ? domainResolver : undefined
    }
  }
  if (trimmed.startsWith('tls://')) {
    const parsed: HostPort = parseHostPort(trimmed.slice('tls://'.length), 853)
    return {
      type: 'tls',
      tag: tag,
      server: parsed.host,
      server_port: parsed.port,
      tls: { enabled: true, server_name: parsed.host },
      detour: effectiveDetour,
      domain_resolver: domainResolver.length > 0 ? domainResolver : undefined
    }
  }
  return {
    type: 'udp',
    tag: tag,
    server: trimmed.length > 0 ? trimmed : '1.1.1.1',
    server_port: 53,
    detour: effectiveDetour,
    domain_resolver: domainResolver.length > 0 ? domainResolver : undefined
  }
}

export class SingBoxConfigBuilder {
  build(request: ConfigBuildRequest, dnsServerOverride: string = ''): ConfigBuildResult {
    if (request.bundle.nodes.length === 0) throw new Error('没有可用于生成配置的节点')
    // Validate at the final trust boundary even though the settings decoder and
    // editor already validate. Tests or future call sites must not be able to
    // inject unsupported local semantics directly into a runtime config.
    const localRules: RoutingRule[] = normalizeLocalRoutingRules(request.localRules || [])
    const selected: ProxyNode | undefined = request.bundle.nodes.find((node: ProxyNode) => node.id === request.selectedNodeId)
    if (!selected) throw new Error('选择的节点已经失效，请重新选择')
    if (request.mode === 'rule') {
      const unresolvedRule: RoutingRule | undefined = request.bundle.rules.find((rule: RoutingRule) =>
        rule.kind === 'rule_set' || rule.kind === 'unsupported')
      if (unresolvedRule) {
        if (unresolvedRule.kind === 'rule_set') {
          throw new Error(`规则模式需要尚未下载的远程规则集：${unresolvedRule.value}`)
        }
        throw new Error(`规则模式包含尚未支持的规则：${unresolvedRule.value}`)
      }
    }

    const warnings: string[] = request.bundle.warnings.slice()
    const ipv6Enabled: boolean = request.ipv6Enabled !== false
    const selectionMode: NodeSelectionMode = request.selectionMode ? request.selectionMode : 'manual'
    // Every proxied selection mode keeps all validated nodes in the running
    // configuration. Manual mode uses a selector whose default is the saved
    // node, which allows a connected client to switch the real outbound
    // without rebuilding the TUN or restarting sing-box. Direct mode does not
    // use the proxy group and therefore keeps only the selected node unloaded
    // from active routing to minimize unnecessary configuration.
    const candidateNodes: ProxyNode[] = request.mode === 'direct' ?
      [selected] : orderedCandidates(request.bundle.nodes, selected.id)
    const nodeOutbounds: CoreOutbound[] = candidateNodes.map((node: ProxyNode) => buildNodeOutbound(node))
    let selector: CoreOutbound
    if (selectionMode === 'auto' && request.mode !== 'direct') {
      selector = {
        type: 'urltest',
        tag: 'proxy',
        outbounds: nodeOutbounds.map((outbound: CoreOutbound) => outbound.tag),
        url: 'https://www.gstatic.com/generate_204',
        interval: '3m',
        tolerance: 50,
        idle_timeout: '30m',
        interrupt_exist_connections: true
      }
      warnings.push('自动优选由 sing-box URLTest 按真实代理延迟选择；50ms 内保持当前候选，避免频繁抖动')
    } else if (selectionMode === 'failover' && request.mode !== 'direct') {
      selector = {
        type: 'urltest',
        tag: 'proxy',
        outbounds: nodeOutbounds.map((outbound: CoreOutbound) => outbound.tag),
        url: 'https://www.gstatic.com/generate_204',
        interval: '30s',
        // URLTest preserves the first healthy candidate while its history is
        // valid. 30 seconds is safely above the 15-second URLTest timeout but
        // avoids uint16 overflow in delay+tolerance inside sing-box.
        tolerance: 30000,
        idle_timeout: '30m',
        interrupt_exist_connections: true
      }
      warnings.push('周期故障转移由 sing-box URLTest 实现首选优先；不是 Mihomo Fallback，失败后通常在 30–45 秒内切换')
    } else {
      selector = {
        type: 'selector',
        tag: 'proxy',
        outbounds: nodeOutbounds.map((outbound: CoreOutbound) => outbound.tag),
        default: coreTag(selected),
        interrupt_exist_connections: true
      }
    }
    const runtimePolicyGroups: RuntimePolicyGroup[] = request.mode === 'rule' ?
      buildRuntimePolicyGroups(request.bundle.policyGroups, nodeOutbounds) : []
    if (request.mode === 'rule') {
      // Resolve every named target before serializing any route. Unknown or
      // duplicate group names are ambiguous and therefore fail closed.
      for (let index: number = 0; index < request.bundle.rules.length; index++) {
        const target: RuleTarget = request.bundle.rules[index].target
        if (target !== 'reject') routeOutbound(target, runtimePolicyGroups)
      }
    }
    const outbounds: CoreOutbound[] = nodeOutbounds.concat([selector])
      .concat(runtimePolicyGroups.map((group: RuntimePolicyGroup) => group.outbound))
      .concat([{ type: 'direct', tag: 'direct' }])

    const routeRules: CoreRouteRule[] = [
      { action: 'sniff' },
      { protocol: 'dns', action: 'hijack-dns' }
    ]
    if (!ipv6Enabled) routeRules.push({ ip_version: 6, action: 'reject' })
    if (request.mode !== 'rule') {
      for (const source of [...localRules, ...request.bundle.rules]) {
        if (source.target !== 'reject' || source.kind === 'final') continue
        const built: CoreRouteRule | null = buildRule(source, warnings, runtimePolicyGroups)
        if (built) routeRules.push(built)
      }
    }
    if (request.mode === 'rule') {
      routeRules.push({ ip_is_private: true, action: 'route', outbound: 'direct' })
      // User-authored rules are intentionally evaluated before imported
      // subscription rules. This makes their priority explicit while keeping
      // the safety-owned private-network bypass above them.
      for (let index: number = 0; index < localRules.length; index++) {
        const built: CoreRouteRule | null = buildRule(localRules[index], warnings, runtimePolicyGroups)
        if (built) routeRules.push(built)
      }
      for (let index: number = 0; index < request.bundle.rules.length; index++) {
        const source: RoutingRule = request.bundle.rules[index]
        if (source.kind === 'final') continue
        const built: CoreRouteRule | null = buildRule(source, warnings, runtimePolicyGroups)
        if (built) routeRules.push(built)
      }
      const rejectedFinal: RoutingRule | undefined = request.bundle.rules.find((rule: RoutingRule) =>
        rule.kind === 'final' && rule.target === 'reject')
      if (rejectedFinal) routeRules.push({ action: 'reject' })
    }

    let finalOutbound: string = 'proxy'
    if (request.mode === 'direct') finalOutbound = 'direct'
    if (request.mode === 'rule') {
      const finalRule: RoutingRule | undefined = request.bundle.rules.find((rule: RoutingRule) => rule.kind === 'final')
      if (finalRule) {
        finalOutbound = finalRule.target === 'reject' ? 'direct' : routeOutbound(finalRule.target, runtimePolicyGroups)
      }
    }
    const dnsDetour: string = request.mode === 'direct' ? 'direct' : 'proxy'
    const dnsSource: string = dnsServerOverride.trim().length > 0 ? dnsServerOverride.trim() :
      (request.bundle.dns.servers.length > 0 ? request.bundle.dns.servers[0] : 'https://1.1.1.1/dns-query')
    const parsedDnsSource: CoreDnsServer = parseDnsServer(dnsSource, dnsDetour, 'remote-dns', 'bootstrap-dns')
    if (!ipv6Enabled && parsedDnsSource.server !== undefined && parsedDnsSource.server.includes(':')) {
      throw new Error('IPv6 已关闭，DNS 上游不能使用 IPv6 地址')
    }
    // The proxy server itself may use a hostname and must be resolved before
    // the proxied remote DNS can start. This direct cycle breaker must never be
    // inherited from the user's remote-DNS choice: Cloudflare/Quad9 may be
    // unreachable before the tunnel is established on mainland networks.
    // AliDNS is encrypted and addressed by an IPv4 literal, so it needs neither
    // another resolver nor IPv6 and remains usable when IPv6 is disabled.
    const bootstrapDnsSource: string = DNS_BOOTSTRAP_ENDPOINT
    const config: CoreConfig = {
      log: {
        level: request.logLevel ? request.logLevel : 'info',
        timestamp: true
      },
      // The OpenHarmony Go port does not expose the system CA directory used
      // by HarmonyOS. sing-box's embedded Mozilla store gives TLS nodes, DoH,
      // DoT and URLTest a deterministic root pool on the device.
      certificate: {
        store: 'mozilla'
      },
      dns: {
        servers: [
          // This encrypted, IP-addressed resolver breaks the dependency cycle
          // when a proxy server or custom DoH/DoT endpoint uses a hostname.
          parseDnsServer(bootstrapDnsSource, 'direct', 'bootstrap-dns'),
          parsedDnsSource
        ],
        final: 'remote-dns',
        strategy: ipv6Enabled ? (request.bundle.dns.strategy || 'prefer_ipv4') : 'ipv4_only'
      },
      inbounds: [
        {
          type: 'tun',
          tag: 'tun-in',
          // Always capture both address families. When IPv6 is disabled the
          // route rule above rejects it inside sing-box, preventing physical
          // IPv6 from bypassing the VPN outside an IPv4-only TUN.
          address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
          mtu: 1400,
          // The HarmonyOS VPN Extension protects the whole core process before
          // sing-box starts. The mixed/system stack creates local kernel-side
          // listeners after that protection and fails on current API 26 devices.
          // gVisor keeps TCP/UDP handling in userspace and consumes the supplied
          // HarmonyOS TUN descriptor directly.
          stack: 'gvisor'
        }
      ],
      outbounds: outbounds,
      route: {
        rules: routeRules,
        final: finalOutbound,
        // HarmonyOS owns the VPN/TUN route. The Extension protects libc-created
        // sockets and the native adapter binds Go-created sockets to a public
        // NetworkKit NOT_VPN underlay. Linux interface discovery is unsafe here.
        auto_detect_interface: false,
        default_domain_resolver: 'bootstrap-dns'
      }
    }

    warnings.push('DNS 请求由 TUN 路由的 hijack-dns 规则交给 sing-box；节点域名由直连 AliDNS 加密 bootstrap 解析，所选 DNS 仍作为远端上游按当前模式连接')
    warnings.push(ipv6Enabled ? 'IPv6 已启用：TUN 与 HarmonyOS VPN 将同时代理 IPv4/IPv6' :
      'IPv6 已关闭：VPN 仍接管 IPv6 并由 sing-box 明确拒绝，防止直连泄漏')
    if (request.mode === 'direct') {
      warnings.push('直连模式不使用代理组，仅保留首选节点作为下次代理连接偏好')
    } else {
      warnings.push(`当前策略装载 ${nodeOutbounds.length} 个已校验候选节点，支持运行中测速${selectionMode === 'manual' ? '与手动热切换' : ''}`)
      if (runtimePolicyGroups.length > 0) {
        warnings.push(`已将 ${runtimePolicyGroups.length} 个 select/URLTest 订阅策略组接入真实 sing-box 出站；规则仅可引用这些已解析组`)
      }
    }
    if (localRules.length > 0) {
      warnings.push(request.mode === 'rule' ?
        `已在订阅规则之前应用 ${localRules.length} 条本地规则` :
        `已保存 ${localRules.length} 条本地规则；阻止规则在全部模式生效，其余分流仅在规则模式下应用`)
    }
    warnings.push('TLS 使用 sing-box 内置 Mozilla 根证书库，避免依赖 HarmonyOS 与 Go 不一致的系统证书路径')
    warnings.push('配置结构按 sing-box 1.14.2 生成；必须经 HarmonyOS core 的 CheckConfig 后才能原子启用')
    return {
      configJson: JSON.stringify(config, null, 2),
      warnings: warnings
    }
  }
}
