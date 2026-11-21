import type { SubscriptionUsage } from './SubscriptionUsage.ts'
import { validSubscriptionUsage } from './SubscriptionUsage.ts'
import type { ProxyNode, SubscriptionBundle } from './Models.ts'
import { emptyMetadata } from './Models.ts'
import { SubscriptionParser, isNodeUri, decodeSubscriptionBody } from './SubscriptionParser.ts'
import { SingBoxConfigBuilder } from './SingBoxConfigBuilder.ts'
import { encodeBase64Text } from './TextCodec.ts'

export interface QuickNode { id: string; uri: string; sourceId: string; nameOverride?: string }
export interface QuickSubscription { id: string; name: string; url: string; updatedAt: number; usage?: SubscriptionUsage }
export interface QuickCatalog { version: number; nodes: QuickNode[]; subscriptions: QuickSubscription[] }
export function emptyQuickCatalog(): QuickCatalog { return { version: 1, nodes: [], subscriptions: [] } }
// Probe only this imported node: no TUN, rule files, cache or listeners.
export function buildNodeTestConfig(entry: QuickNode, bootstrapDns: string = ''): string {
  const node: ProxyNode = quickNode(entry)
  node.id = entry.id
  const bundle: SubscriptionBundle = { metadata: emptyMetadata('uri-list'), nodes: [node], policyGroups: [], rules: [],
    dns: { strategy: 'prefer_ipv4', servers: ['https://1.1.1.1/dns-query'] }, warnings: [] }
  const built: Record<string, Object> = JSON.parse(new SingBoxConfigBuilder().build({ bundle: bundle, mode: 'rule', selectedNodeId: node.id }).configJson) as Record<string, Object>
  const outbounds: Record<string, Object>[] = (built.outbounds as Record<string, Object>[]).filter((item: Record<string, Object>) => item.type !== 'selector' && item.type !== 'urltest')
  const target: Record<string, Object> = outbounds.find((item: Record<string, Object>) => item.type !== 'direct' && item.type !== 'block') as Record<string, Object>
  if (!target) throw new Error('没有可测速的代理节点')
  target.tag = 'node-test'
  return JSON.stringify({ log: { disabled: true }, dns: { servers: [bootstrapDns ? { type: 'udp', tag: 'probe-dns', server: bootstrapDns } : { type: 'local', tag: 'probe-dns' }] },
    outbounds: [target], route: { auto_detect_interface: false, default_domain_resolver: 'probe-dns', final: 'node-test' } })
}
export function quickNode(entry: QuickNode): ProxyNode {
  const bundle: SubscriptionBundle = new SubscriptionParser().parse(entry.uri)
  if (bundle.nodes.length !== 1 || bundle.warnings.length > 0) throw new Error('节点链接无效，请检查参数')
  if(entry.nameOverride)bundle.nodes[0].name=entry.nameOverride
  return bundle.nodes[0]
}
export function parseQuickCatalog(text: string): QuickCatalog {
  const catalog: QuickCatalog = JSON.parse(text) as QuickCatalog
  if (catalog.version !== 1 || !Array.isArray(catalog.nodes) || !Array.isArray(catalog.subscriptions) ||
    catalog.nodes.length > 2000 || catalog.subscriptions.length > 100) throw new Error('节点目录无效或过大')
  const ids: string[] = []
  for (const source of catalog.subscriptions) {
    if (!source || typeof source.id !== 'string' || !source.id || ids.includes(source.id) || typeof source.name !== 'string' ||
      typeof source.url !== 'string' || !/^https:\/\/[^\s]+$/i.test(source.url) || !Number.isFinite(source.updatedAt)) throw new Error('节点订阅无效')
    if (source.usage !== undefined && !validSubscriptionUsage(source.usage)) throw new Error('节点订阅流量信息无效')
    ids.push(source.id)
  }
  const nodeIds: string[] = []
  for (const entry of catalog.nodes) {
    if (!entry || typeof entry.uri !== 'string' || entry.uri.length > 16384 || typeof entry.sourceId !== 'string' ||
      (entry.sourceId && !ids.includes(entry.sourceId)) || typeof entry.id !== 'string' || !entry.id || nodeIds.includes(entry.id)) throw new Error('节点条目无效')
    if(entry.nameOverride!==undefined&&(typeof entry.nameOverride!=='string'||!entry.nameOverride.trim()||entry.nameOverride.length>1024))throw new Error('节点显示名称无效')
    quickNode(entry); nodeIds.push(entry.id)
  }
  return catalog
}

// Export only the modeled, validated protocol parameters. Imported links remain
// verbatim in the encrypted catalog, so copy/share does not lose extensions.
function nodeQueryValue(node: ProxyNode, key: string): string {
  const items = node.query
  for (let index: number = 0; index < items.length; index++) {
    if (items[index].key.toLowerCase() === key) return items[index].value
  }
  return ''
}

export function nodeShareUri(node: ProxyNode): string {
  const host: string = node.server.includes(':') ? `[${node.server}]` : node.server
  if (node.protocol === 'vmess') return 'vmess://' + encodeBase64Text(JSON.stringify({ v: '2', ps: node.name,
    add: node.server, port: node.port.toString(), id: node.uuid, aid: (node.alterId || 0).toString(), scy: node.method || 'auto',
    net: node.transport.type || 'tcp', host: node.transport.host, path: node.transport.path,
    tls: node.tls.enabled ? 'tls' : '', sni: node.tls.serverName, alpn: node.tls.alpn.join(','), fp: node.tls.utls.fingerprint }))
  if (node.protocol === 'shadowsocks') return 'ss://' + encodeBase64Text(`${node.method}:${node.password}`) + `@${host}:${node.port}#${encodeURIComponent(node.name)}`
  if (node.protocol === 'socks') return 'socks://' + encodeBase64Text(`${node.username}:${node.password}`) + `@${host}:${node.port}#${encodeURIComponent(node.name)}`
  if (node.protocol === 'http') return `http://${encodeURIComponent(node.username)}:${encodeURIComponent(node.password)}@${host}:${node.port}#${encodeURIComponent(node.name)}`
  if (node.protocol === 'ssh') return `ssh://${encodeURIComponent(node.username)}:${encodeURIComponent(node.password)}@${host}:${node.port}#${encodeURIComponent(node.name)}`
  if (node.protocol === 'tuic') {
    const tuicQuery: string[] = []
    if (node.tls.serverName) tuicQuery.push('sni=' + encodeURIComponent(node.tls.serverName))
    if (node.tls.alpn.length) tuicQuery.push('alpn=' + encodeURIComponent(node.tls.alpn.join(',')))
    tuicQuery.push('congestion_control=' + encodeURIComponent(nodeQueryValue(node, 'congestion_control') || 'bbr'))
    tuicQuery.push('udp_relay_mode=' + encodeURIComponent(nodeQueryValue(node, 'udp_relay_mode') || 'native'))
    return `tuic://${encodeURIComponent(node.uuid)}:${encodeURIComponent(node.password)}@${host}:${node.port}?${tuicQuery.join('&')}#${encodeURIComponent(node.name)}`
  }
  if (node.protocol === 'shadowtls') {
    const version: string = nodeQueryValue(node, 'version') || '3'
    return `shadowtls://${encodeURIComponent(node.password)}@${host}:${node.port}?version=${version}${node.tls.serverName ? '&sni=' + encodeURIComponent(node.tls.serverName) : ''}#${encodeURIComponent(node.name)}`
  }
  if (node.protocol === 'snell') {
    const version: string = nodeQueryValue(node, 'version') || '4'
    return `snell://${encodeURIComponent(node.password)}@${host}:${node.port}?version=${version}#${encodeURIComponent(node.name)}`
  }
  if (node.protocol === 'hysteria') {
    const parts: string[] = []
    if (node.password) parts.push('auth=' + encodeURIComponent(node.password))
    parts.push('upmbps=' + (nodeQueryValue(node, 'upmbps') || '50'))
    parts.push('downmbps=' + (nodeQueryValue(node, 'downmbps') || '100'))
    if (node.tls.serverName) parts.push('peer=' + encodeURIComponent(node.tls.serverName))
    if (node.tls.alpn.length) parts.push('alpn=' + encodeURIComponent(node.tls.alpn.join(',')))
    if (node.tls.insecure) parts.push('insecure=1')
    return `hysteria://${host}:${node.port}?${parts.join('&')}#${encodeURIComponent(node.name)}`
  }
  if (node.protocol === 'anytls') {
    const parts: string[] = []
    if (node.tls.serverName) parts.push('sni=' + encodeURIComponent(node.tls.serverName))
    if (node.tls.insecure) parts.push('insecure=1')
    return `anytls://${encodeURIComponent(node.password)}@${host}:${node.port}${parts.length ? '?' + parts.join('&') : ''}#${encodeURIComponent(node.name)}`
  }
  const query: string[] = []
  if (node.tls.enabled) query.push('security=' + (node.tls.reality.enabled ? 'reality' : 'tls'))
  if (node.tls.serverName) query.push('sni=' + encodeURIComponent(node.tls.serverName))
  if (node.tls.insecure) query.push('insecure=1')
  if (node.tls.alpn.length) query.push('alpn=' + encodeURIComponent(node.tls.alpn.join(',')))
  if (node.tls.utls.fingerprint) query.push('fp=' + encodeURIComponent(node.tls.utls.fingerprint))
  if (node.tls.reality.enabled) { query.push('pbk=' + encodeURIComponent(node.tls.reality.publicKey)); query.push('sid=' + encodeURIComponent(node.tls.reality.shortId)) }
  if (node.flow) query.push('flow=' + encodeURIComponent(node.flow))
  if (node.transport.type) query.push('type=' + encodeURIComponent(node.transport.type))
  if (node.transport.path) query.push('path=' + encodeURIComponent(node.transport.path))
  if (node.transport.host) query.push('host=' + encodeURIComponent(node.transport.host))
  if (node.transport.serviceName) query.push('serviceName=' + encodeURIComponent(node.transport.serviceName))
  return `${node.protocol}://${encodeURIComponent(node.protocol === 'vless' ? node.uuid : node.password)}@${host}:${node.port}?${query.join('&')}#${encodeURIComponent(node.name)}`
}

export function importQuickNodes(catalog: QuickCatalog, body: string, source?: QuickSubscription): QuickCatalog {
  if (body.length > 4 * 1024 * 1024) throw new Error('导入内容不能超过 4 MiB')
  const bundle: SubscriptionBundle = new SubscriptionParser().parse(body)
  const sourceText: string = decodeSubscriptionBody(body)
  const originalLinks: string[] = sourceText.split(/\r?\n/).map((line: string) => line.trim()).filter((line: string) => isNodeUri(line))
  // Do not silently discard malformed or unsupported nodes.
  if (bundle.warnings.length > 0) throw new Error(bundle.warnings.slice(0, 3).join('\n'))
  const originals: Map<string, string> = new Map()
  for (const link of originalLinks) originals.set(new SubscriptionParser().parse(link).nodes[0].id, link)
  const next: QuickCatalog = { version: 1, subscriptions: catalog.subscriptions.slice(),
    nodes: catalog.nodes.filter((entry: QuickNode) => !source || entry.sourceId !== source.id) }
  if (source) next.subscriptions = [...next.subscriptions.filter((item: QuickSubscription) => item.id !== source.id), source]
  for (const node of bundle.nodes) {
    const original: string | undefined = originals.get(node.id)
    const uri: string = original || nodeShareUri(node)
    const imported: QuickNode = { id: source ? `${source.id}-${node.id}` : node.id, uri: uri, sourceId: source ? source.id : '' }
    const old: QuickNode | undefined = catalog.nodes.find((entry: QuickNode) => entry.id === imported.id)
    if (old && !source) imported.uri = old.uri
    if (!next.nodes.some((entry: QuickNode) => entry.id === imported.id)) next.nodes.push(imported)
  }
  if(source){
    const order:Map<string,number>=new Map()
    catalog.nodes.forEach((entry:QuickNode,index:number)=>{order.set(entry.id,index)})
    next.nodes.sort((left:QuickNode,right:QuickNode)=>(order.get(left.id)??Number.MAX_SAFE_INTEGER)-(order.get(right.id)??Number.MAX_SAFE_INTEGER))
  }
  return parseQuickCatalog(JSON.stringify(next))
}
