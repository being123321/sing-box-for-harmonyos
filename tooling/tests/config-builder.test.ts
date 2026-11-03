import test from 'node:test'
import assert from 'node:assert/strict'
import { SingBoxConfigBuilder } from '../../entry/src/main/ets/domain/SingBoxConfigBuilder.ts'
import { SubscriptionParser } from '../../entry/src/main/ets/domain/SubscriptionParser.ts'

const parser = new SubscriptionParser()
const builder = new SingBoxConfigBuilder()

function sampleBundle() {
  return parser.parse([
    'ss://YWVzLTEyOC1nY206cGFzc3dvcmQ@198.51.100.10:443#HK',
    'trojan://fake-password@203.0.113.8:443?security=tls&sni=edge.example.test#JP'
  ].join('\n'))
}

test('builds a sing-box 1.13 style TUN configuration in rule mode', () => {
  const bundle = sampleBundle()
  bundle.rules.push({ kind: 'domain_suffix', value: 'example.cn', target: 'direct', source: 'test' })
  bundle.rules.push({ kind: 'domain', value: 'blocked.example', target: 'reject', source: 'test' })
  const result = builder.build({ bundle, mode: 'rule', selectedNodeId: bundle.nodes[1].id })
  const config = JSON.parse(result.configJson)

  assert.equal(config.inbounds[0].type, 'tun')
  assert.deepEqual(config.inbounds[0].address, ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'])
  assert.equal(config.inbounds[0].stack, 'gvisor')
  assert.deepEqual(config.certificate, { store: 'mozilla' })
  const proxyGroup = config.outbounds.find((outbound: { tag: string }) => outbound.tag === 'proxy')
  assert.equal(proxyGroup.default, bundle.nodes[1].id)
  assert.deepEqual(proxyGroup.outbounds, [bundle.nodes[1].id, bundle.nodes[0].id])
  assert.equal(config.outbounds.filter((outbound: { type: string }) =>
    ['shadowsocks', 'trojan', 'vless', 'vmess', 'hysteria2'].includes(outbound.type)).length, 2)
  assert.equal(config.route.final, 'proxy')
  assert.equal(config.route.auto_detect_interface, false)
  assert.ok(config.route.rules.some((rule: { action: string }) => rule.action === 'hijack-dns'))
  assert.ok(config.route.rules.some((rule: { action: string }) => rule.action === 'reject'))
  assert.equal(config.outbounds.some((outbound: { type: string }) => outbound.type === 'dns'), false)
})

test('applies validated local rules before imported subscription rules in rule mode', () => {
  const bundle = sampleBundle()
  bundle.rules.push({ kind: 'domain_suffix', value: 'example.com', target: 'direct', source: 'subscription' })
  const result = builder.build({
    bundle,
    mode: 'rule',
    selectedNodeId: bundle.nodes[0].id,
    localRules: [
      { kind: 'domain', value: 'blocked.example.com', target: 'reject', source: 'local' },
      { kind: 'ip_cidr', value: '198.51.100.0/24', target: 'proxy', source: 'local' }
    ]
  })
  const config = JSON.parse(result.configJson)
  const privateRuleIndex = config.route.rules.findIndex((rule: { ip_is_private?: boolean }) => rule.ip_is_private)
  const localDomainIndex = config.route.rules.findIndex((rule: { domain?: string[] }) =>
    rule.domain?.includes('blocked.example.com'))
  const localCidrIndex = config.route.rules.findIndex((rule: { ip_cidr?: string[] }) =>
    rule.ip_cidr?.includes('198.51.100.0/24'))
  const subscriptionIndex = config.route.rules.findIndex((rule: { domain_suffix?: string[] }) =>
    rule.domain_suffix?.includes('example.com'))

  assert.ok(privateRuleIndex < localDomainIndex)
  assert.ok(localDomainIndex < localCidrIndex)
  assert.ok(localCidrIndex < subscriptionIndex)
  assert.equal(config.route.rules[localDomainIndex].action, 'reject')
  assert.equal(config.route.rules[localCidrIndex].outbound, 'proxy')
  assert.ok(result.warnings.some((warning: string) => warning.includes('2 条本地规则')))
})

test('keeps local blocking but not local routing overrides outside rule mode', () => {
  const bundle = sampleBundle()
  const localRule = { kind: 'domain', value: 'local.example.com', target: 'reject', source: 'local' } as const
  for (const mode of ['global', 'direct'] as const) {
    const result = builder.build({ bundle, mode, selectedNodeId: bundle.nodes[0].id, localRules: [localRule] })
    const config = JSON.parse(result.configJson)
    assert.equal(config.route.rules.some((rule: { domain?: string[] }) =>
      rule.domain?.includes('local.example.com')), true)
    assert.ok(result.warnings.some((warning: string) => warning.includes('阻止规则在全部模式生效')))
  }
})

test('refuses injected unsupported local rule semantics at the builder boundary', () => {
  const bundle = sampleBundle()
  assert.throws(() => builder.build({
    bundle,
    mode: 'rule',
    selectedNodeId: bundle.nodes[0].id,
    localRules: [{ kind: 'rule_set', value: 'provider', target: 'direct', source: 'local' }]
  }), /本地规则仅支持/)
  assert.throws(() => builder.build({
    bundle,
    mode: 'rule',
    selectedNodeId: bundle.nodes[0].id,
    localRules: [{ kind: 'domain', value: 'example.com', target: 'Streaming', source: 'local' }]
  }), /目标仅支持/)
})

test('disables IPv6 without allowing it to bypass the VPN TUN', () => {
  const bundle = sampleBundle()
  const result = builder.build({
    bundle,
    mode: 'global',
    selectedNodeId: bundle.nodes[0].id,
    ipv6Enabled: false
  })
  const config = JSON.parse(result.configJson)

  assert.deepEqual(config.inbounds[0].address, ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'])
  assert.equal(config.dns.strategy, 'ipv4_only')
  const bootstrapDns = config.dns.servers.find((server: { tag: string }) => server.tag === 'bootstrap-dns')
  assert.equal(bootstrapDns.server, '223.5.5.5')
  assert.equal(bootstrapDns.detour, undefined)
  assert.equal(bootstrapDns.tls.server_name, '223.5.5.5')
  assert.ok(config.route.rules.some((rule: { ip_version?: number, action: string }) =>
    rule.ip_version === 6 && rule.action === 'reject'))
})

test('refuses an IPv6 DNS endpoint while IPv6 is disabled', () => {
  const bundle = sampleBundle()
  assert.throws(() => builder.build({
    bundle,
    mode: 'global',
    selectedNodeId: bundle.nodes[0].id,
    ipv6Enabled: false
  }, 'https://[2606:4700:4700::1111]/dns-query'), /IPv6.*DNS/)
})

test('keeps Cloudflare behind the proxy and uses independent mainland bootstrap DNS', () => {
  const bundle = sampleBundle()
  const result = builder.build(
    { bundle, mode: 'global', selectedNodeId: bundle.nodes[0].id },
    'https://1.1.1.1/dns-query'
  )
  const config = JSON.parse(result.configJson)
  const remoteDns = config.dns.servers.find((server: { tag: string }) => server.tag === 'remote-dns')

  assert.equal(remoteDns.type, 'https')
  assert.equal(remoteDns.server, '1.1.1.1')
  assert.equal(remoteDns.path, '/dns-query')
  assert.equal(remoteDns.detour, 'proxy')
  assert.equal(remoteDns.domain_resolver, 'bootstrap-dns')
  const bootstrapDns = config.dns.servers.find((server: { tag: string }) => server.tag === 'bootstrap-dns')
  assert.equal(bootstrapDns.detour, undefined)
  assert.equal(bootstrapDns.server, '223.5.5.5')
  assert.equal(bootstrapDns.domain_resolver, undefined)
  assert.equal(config.route.default_domain_resolver, 'bootstrap-dns')
  assert.ok(config.route.rules.some((rule: { action: string }) => rule.action === 'hijack-dns'))
})

test('keeps Quad9 as remote DNS instead of using it for direct bootstrap', () => {
  const bundle = sampleBundle()
  const result = builder.build(
    { bundle, mode: 'global', selectedNodeId: bundle.nodes[0].id },
    'https://9.9.9.9/dns-query'
  )
  const config = JSON.parse(result.configJson)
  const bootstrapDns = config.dns.servers.find((server: { tag: string }) => server.tag === 'bootstrap-dns')
  const remoteDns = config.dns.servers.find((server: { tag: string }) => server.tag === 'remote-dns')

  assert.equal(bootstrapDns.server, '223.5.5.5')
  assert.equal(bootstrapDns.detour, undefined)
  assert.equal(remoteDns.server, '9.9.9.9')
  assert.equal(remoteDns.detour, 'proxy')
})

test('hostname custom DNS uses an independent encrypted mainland bootstrap', () => {
  const bundle = sampleBundle()
  const result = builder.build(
    { bundle, mode: 'global', selectedNodeId: bundle.nodes[0].id },
    'https://dns.example.test/dns-query'
  )
  const config = JSON.parse(result.configJson)
  const bootstrapDns = config.dns.servers.find((server: { tag: string }) => server.tag === 'bootstrap-dns')
  const remoteDns = config.dns.servers.find((server: { tag: string }) => server.tag === 'remote-dns')

  assert.equal(bootstrapDns.server, '223.5.5.5')
  assert.equal(bootstrapDns.detour, undefined)
  assert.equal(remoteDns.server, 'dns.example.test')
  assert.equal(remoteDns.detour, 'proxy')
  assert.equal(remoteDns.domain_resolver, 'bootstrap-dns')
})

test('separates a custom DoT host and port for TLS verification', () => {
  const bundle = sampleBundle()
  const result = builder.build(
    { bundle, mode: 'rule', selectedNodeId: bundle.nodes[0].id },
    'tls://dns.example.test:8853'
  )
  const server = JSON.parse(result.configJson).dns.servers.find((item: { tag: string }) => item.tag === 'remote-dns')
  assert.equal(server.server, 'dns.example.test')
  assert.equal(server.server_port, 8853)
  assert.equal(server.tls.server_name, 'dns.example.test')
})

test('direct mode routes both traffic and DNS without a proxy detour', () => {
  const bundle = sampleBundle()
  const result = builder.build({ bundle, mode: 'direct', selectedNodeId: bundle.nodes[0].id })
  const config = JSON.parse(result.configJson)

  assert.equal(config.route.final, 'direct')
  const remoteDns = config.dns.servers.find((server: { tag: string }) => server.tag === 'remote-dns')
  assert.equal(remoteDns.detour, undefined)
})

test('rejects a missing selected node', () => {
  const bundle = sampleBundle()
  assert.throws(() => builder.build({ bundle, mode: 'rule', selectedNodeId: 'missing' }), /重新选择/)
})

test('refuses rule mode when a subscription contains an unsupported rule', () => {
  const bundle = sampleBundle()
  bundle.rules.push({ kind: 'unsupported', value: 'GEOIP,CN,DIRECT', target: 'direct', source: 'test' })

  assert.throws(
    () => builder.build({ bundle, mode: 'rule', selectedNodeId: bundle.nodes[0].id }),
    /尚未支持的规则.*GEOIP/
  )
  assert.doesNotThrow(() => builder.build({ bundle, mode: 'global', selectedNodeId: bundle.nodes[0].id }))
})

test('refuses rule mode when a remote rule set has not been resolved', () => {
  const bundle = sampleBundle()
  bundle.rules.push({ kind: 'rule_set', value: 'provider-cn', target: 'direct', source: 'test' })

  assert.throws(
    () => builder.build({ bundle, mode: 'rule', selectedNodeId: bundle.nodes[0].id }),
    /尚未下载的远程规则集.*provider-cn/
  )
})

test('refuses rule mode when a rule targets an unconnected subscription policy group', () => {
  const bundle = sampleBundle()
  bundle.rules.push({ kind: 'domain_suffix', value: 'stream.example', target: 'Streaming', source: 'test' })

  assert.throws(
    () => builder.build({ bundle, mode: 'rule', selectedNodeId: bundle.nodes[0].id }),
    /尚未接通的策略组.*Streaming/
  )
  assert.doesNotThrow(() => builder.build({ bundle, mode: 'global', selectedNodeId: bundle.nodes[0].id }))
  assert.doesNotThrow(() => builder.build({ bundle, mode: 'direct', selectedNodeId: bundle.nodes[0].id }))
})

test('routes named rules through real selector and URLTest subscription groups', () => {
  const bundle = sampleBundle()
  bundle.policyGroups = [
    {
      name: 'Streaming',
      type: 'select',
      nodeIds: ['missing-node', bundle.nodes[1].id, bundle.nodes[1].id],
      selectedNodeId: 'missing-node'
    },
    {
      name: 'Fastest',
      type: 'urltest',
      nodeIds: [bundle.nodes[0].id, 'missing-node', bundle.nodes[1].id],
      selectedNodeId: bundle.nodes[1].id
    }
  ]
  bundle.rules.push({ kind: 'domain_suffix', value: 'video.example', target: 'Streaming', source: 'test' })
  bundle.rules.push({ kind: 'domain', value: 'fast.example', target: 'Fastest', source: 'test' })
  bundle.rules.push({ kind: 'final', value: '', target: 'Fastest', source: 'test' })

  const result = builder.build({ bundle, mode: 'rule', selectedNodeId: bundle.nodes[0].id })
  const config = JSON.parse(result.configJson)
  const streaming = config.outbounds.find((outbound: { tag: string }) => outbound.tag === 'policy-group-1')
  const fastest = config.outbounds.find((outbound: { tag: string }) => outbound.tag === 'policy-group-2')
  const streamingRule = config.route.rules.find((rule: { domain_suffix?: string[] }) =>
    rule.domain_suffix?.includes('video.example'))
  const fastestRule = config.route.rules.find((rule: { domain?: string[] }) => rule.domain?.includes('fast.example'))

  assert.equal(streaming.type, 'selector')
  assert.deepEqual(streaming.outbounds, [bundle.nodes[1].id])
  assert.equal(streaming.default, bundle.nodes[1].id)
  assert.equal(streamingRule.outbound, streaming.tag)
  assert.equal(fastest.type, 'urltest')
  assert.deepEqual(fastest.outbounds, [bundle.nodes[0].id, bundle.nodes[1].id])
  assert.equal(fastest.url, 'https://www.gstatic.com/generate_204')
  assert.equal(fastest.interval, '3m')
  assert.equal(fastest.tolerance, 50)
  assert.equal(fastest.interrupt_exist_connections, true)
  assert.equal(fastestRule.outbound, fastest.tag)
  assert.equal(config.route.final, fastest.tag)
  assert.ok(result.warnings.some((warning: string) => warning.includes('2 个 select/URLTest')))
})

test('allocates deterministic safe policy tags when a node tag collides', () => {
  const bundle = sampleBundle()
  bundle.nodes[0].id = 'policy-group-1'
  bundle.policyGroups = [{
    name: 'Collision',
    type: 'select',
    nodeIds: [bundle.nodes[0].id],
    selectedNodeId: bundle.nodes[0].id
  }]
  bundle.rules.push({ kind: 'domain', value: 'collision.example', target: 'Collision', source: 'test' })

  const config = JSON.parse(builder.build({
    bundle,
    mode: 'rule',
    selectedNodeId: bundle.nodes[0].id
  }).configJson)
  const group = config.outbounds.find((outbound: { type: string, tag: string }) =>
    outbound.type === 'selector' && outbound.tag !== 'proxy')
  const route = config.route.rules.find((rule: { domain?: string[] }) => rule.domain?.includes('collision.example'))

  assert.equal(group.tag, 'policy-group-1-2')
  assert.equal(route.outbound, group.tag)
  assert.equal(new Set(config.outbounds.map((outbound: { tag: string }) => outbound.tag)).size,
    config.outbounds.length)
})

test('fails closed when a named route target matches duplicate policy group names', () => {
  const bundle = sampleBundle()
  bundle.policyGroups = [
    {
      name: 'Ambiguous',
      type: 'select',
      nodeIds: [bundle.nodes[0].id],
      selectedNodeId: bundle.nodes[0].id
    },
    {
      name: 'Ambiguous',
      type: 'urltest',
      nodeIds: [bundle.nodes[1].id],
      selectedNodeId: bundle.nodes[1].id
    }
  ]
  bundle.rules.push({ kind: 'domain', value: 'ambiguous.example', target: 'Ambiguous', source: 'test' })

  assert.throws(
    () => builder.build({ bundle, mode: 'rule', selectedNodeId: bundle.nodes[0].id }),
    /重名策略组.*Ambiguous/
  )
})

test('emits non-zero VMess alter_id from a VMess JSON share link', () => {
  const payload = Buffer.from(JSON.stringify({
    v: '2',
    ps: 'Legacy-VMess',
    add: '198.51.100.91',
    port: '443',
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    aid: '64',
    scy: 'auto'
  }), 'utf8').toString('base64')
  const bundle = parser.parse(`vmess://${payload}`)
  const config = JSON.parse(builder.build({
    bundle,
    mode: 'global',
    selectedNodeId: bundle.nodes[0].id
  }).configJson)
  const outbound = config.outbounds.find((item: { type: string }) => item.type === 'vmess')

  assert.equal(bundle.nodes[0].alterId, 64)
  assert.equal(outbound.alter_id, 64)
})

test('turns Clash MATCH REJECT into a catch-all reject rule', () => {
  const bundle = parser.parse(`
proxies:
  - { name: HK, type: ss, server: 198.51.100.92, port: 443, cipher: aes-128-gcm, password: fake-password }
rules:
  - MATCH,REJECT
`)
  const config = JSON.parse(builder.build({
    bundle,
    mode: 'rule',
    selectedNodeId: bundle.nodes[0].id
  }).configJson)
  const lastRule = config.route.rules[config.route.rules.length - 1]

  assert.equal(bundle.rules[0].kind, 'final')
  assert.equal(bundle.rules[0].target, 'reject')
  assert.deepEqual(lastRule, { action: 'reject' })
  assert.equal(config.route.final, 'direct')
})

test('emits sing-box Reality and uTLS outbound options', () => {
  const publicKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString('base64url')
  const uri = 'vless://11111111-2222-3333-4444-555555555555@198.51.100.90:443' +
    `?security=reality&sni=reality.example.test&pbk=${publicKey}&sid=a1b2c3d4&fp=chrome#Reality`
  const bundle = parser.parse(uri)
  const config = JSON.parse(builder.build({
    bundle,
    mode: 'global',
    selectedNodeId: bundle.nodes[0].id
  }).configJson)
  const outbound = config.outbounds.find((item: { tag: string }) => item.tag === bundle.nodes[0].id)

  assert.equal(outbound.tls.enabled, true)
  assert.equal(outbound.tls.server_name, 'reality.example.test')
  assert.deepEqual(outbound.tls.utls, { enabled: true, fingerprint: 'chrome' })
  assert.deepEqual(outbound.tls.reality, {
    enabled: true,
    public_key: publicKey,
    short_id: 'a1b2c3d4'
  })
})

test('writes HTTP and HTTPUpgrade transport hosts to the sing-box host field', () => {
  const uuid = '11111111-2222-3333-4444-555555555555'
  const bundle = parser.parse([
    `vless://${uuid}@198.51.100.81:443?type=http&host=h2.example.test&path=%2Fh2#HTTP`,
    `vless://${uuid}@198.51.100.82:443?type=httpupgrade&host=upgrade.example.test&path=%2Fup#Upgrade`
  ].join('\n'))
  const config = JSON.parse(builder.build({
    bundle,
    mode: 'global',
    selectedNodeId: bundle.nodes[0].id
  }).configJson)
  const http = config.outbounds.find((item: { tag: string }) => item.tag === bundle.nodes[0].id)
  const upgrade = config.outbounds.find((item: { tag: string }) => item.tag === bundle.nodes[1].id)

  assert.equal(http.transport.host, 'h2.example.test')
  assert.equal(http.transport.headers, undefined)
  assert.equal(upgrade.transport.host, 'upgrade.example.test')
  assert.equal(upgrade.transport.headers, undefined)
})

test('keeps schema-v1 saved nodes without nested TLS extensions usable', () => {
  const bundle = sampleBundle()
  delete (bundle.nodes[0].tls as { utls?: unknown }).utls
  delete (bundle.nodes[0].tls as { reality?: unknown }).reality
  delete (bundle.nodes[0] as { alterId?: unknown }).alterId

  const config = JSON.parse(builder.build({
    bundle,
    mode: 'global',
    selectedNodeId: bundle.nodes[0].id
  }).configJson)
  assert.equal(config.outbounds[0].tls, undefined)
})

test('builds automatic selection as a sing-box URLTest group with all candidates', () => {
  const bundle = sampleBundle()
  const config = JSON.parse(builder.build({
    bundle,
    mode: 'global',
    selectedNodeId: bundle.nodes[1].id,
    selectionMode: 'auto'
  }).configJson)
  const group = config.outbounds.find((item: { tag: string }) => item.tag === 'proxy')

  assert.equal(group.type, 'urltest')
  assert.equal(group.outbounds[0], bundle.nodes[1].id)
  assert.equal(group.outbounds.length, 2)
  assert.equal(group.interval, '3m')
  assert.equal(group.tolerance, 50)
  assert.equal(group.interrupt_exist_connections, true)
})

test('manual proxy mode loads every validated node for live selector switching', () => {
  const bundle = sampleBundle()
  const config = JSON.parse(builder.build({
    bundle,
    mode: 'global',
    selectedNodeId: bundle.nodes[1].id,
    selectionMode: 'manual'
  }).configJson)
  const group = config.outbounds.find((item: { tag: string }) => item.tag === 'proxy')

  assert.equal(group.type, 'selector')
  assert.equal(group.default, bundle.nodes[1].id)
  assert.deepEqual(group.outbounds, [bundle.nodes[1].id, bundle.nodes[0].id])
  assert.equal(group.interrupt_exist_connections, true)
})

test('never emits duplicate outbound tags after subscription node deduplication', () => {
  const duplicate = 'ss://YWVzLTEyOC1nY206cGFzc3dvcmQ@198.51.100.93:443#Repeated-Builder'
  const bundle = parser.parse([duplicate, duplicate, duplicate].join('\n'))
  const config = JSON.parse(builder.build({
    bundle,
    mode: 'global',
    selectedNodeId: bundle.nodes[0].id,
    selectionMode: 'manual'
  }).configJson)
  const tags = config.outbounds.map((outbound: { tag: string }) => outbound.tag)
  const group = config.outbounds.find((outbound: { tag: string }) => outbound.tag === 'proxy')

  assert.equal(bundle.nodes.length, 1)
  assert.equal(new Set(tags).size, tags.length)
  assert.deepEqual(group.outbounds, [bundle.nodes[0].id])
})

test('builds ordered failover that preserves the preferred node until it fails', () => {
  const bundle = sampleBundle()
  const config = JSON.parse(builder.build({
    bundle,
    mode: 'rule',
    selectedNodeId: bundle.nodes[1].id,
    selectionMode: 'failover'
  }).configJson)
  const group = config.outbounds.find((item: { tag: string }) => item.tag === 'proxy')

  assert.equal(group.type, 'urltest')
  assert.deepEqual(group.outbounds, [bundle.nodes[1].id, bundle.nodes[0].id])
  assert.equal(group.interval, '30s')
  assert.equal(group.tolerance, 30000)
})

test('direct mode does not load unused automatic candidates', () => {
  const bundle = sampleBundle()
  const config = JSON.parse(builder.build({
    bundle,
    mode: 'direct',
    selectedNodeId: bundle.nodes[1].id,
    selectionMode: 'auto'
  }).configJson)

  assert.equal(config.outbounds.filter((item: { type: string }) =>
    ['shadowsocks', 'trojan', 'vless', 'vmess', 'hysteria2'].includes(item.type)).length, 1)
  assert.equal(config.outbounds.find((item: { tag: string }) => item.tag === 'proxy').type, 'selector')
})

test('writes the selected sing-box core log level', () => {
  const bundle = sampleBundle()
  const config = JSON.parse(builder.build({
    bundle,
    mode: 'global',
    selectedNodeId: bundle.nodes[0].id,
    selectionMode: 'manual',
    logLevel: 'debug'
  }).configJson)

  assert.equal(config.log.level, 'debug')
})
