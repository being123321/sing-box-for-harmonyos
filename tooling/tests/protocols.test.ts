import test from 'node:test'
import assert from 'node:assert/strict'
import { SubscriptionParser } from '../../entry/src/main/ets/domain/SubscriptionParser.ts'
import { SingBoxConfigBuilder } from '../../entry/src/main/ets/domain/SingBoxConfigBuilder.ts'
import { emptyMetadata } from '../../entry/src/main/ets/domain/Models.ts'
import { prepareLocalConfig } from '../../entry/src/main/ets/domain/LocalConfig.ts'
import { nodeShareUri } from '../../entry/src/main/ets/domain/QuickStart.ts'

const LINKS: Record<string, string> = {
 socks: 'socks://dXNlcjpwYXNz@127.0.0.1:1080#Socks',
 http: 'http://user:pass@127.0.0.1:8080#Http',
 snell: 'snell://psk123@127.0.0.1:443?version=4#Snell',
 hysteria: 'hysteria://127.0.0.1:443?auth=x&upmbps=50&downmbps=100&peer=example.com#Hysteria',
 tuic: 'tuic://11111111-2222-3333-4444-555555555555:pass@127.0.0.1:443?congestion_control=bbr&udp_relay_mode=native&sni=example.com&alpn=h3#Tuic',
 anytls: 'anytls://pass@127.0.0.1:443?sni=example.com#AnyTLS',
 shadowtls: 'shadowtls://pass@127.0.0.1:443?version=3&sni=example.com#ShadowTLS',
 ssh: 'ssh://root:pass@127.0.0.1:22#SSH'
}

test('every added protocol parses from its share link', () => {
 const parser = new SubscriptionParser()
 for (const [protocol, link] of Object.entries(LINKS)) {
  const node = parser.parse(link).nodes[0]
  assert.equal(node.protocol, protocol, link)
  assert.equal(node.server, '127.0.0.1')
 }
})

test('outbound fields use the names sing-box expects', () => {
 const parser = new SubscriptionParser()
 const nodes = Object.entries(LINKS).map(([, link]) => parser.parse(link).nodes[0])
 const bundle = { metadata: emptyMetadata('uri-list'), nodes, policyGroups: [], rules: [], dns: { strategy: 'prefer_ipv4', servers: [] }, warnings: [] }
 const runtime = JSON.parse(prepareLocalConfig(new SingBoxConfigBuilder().build({ bundle, mode: 'rule', selectedNodeId: nodes[0].id }).configJson,
  { ipv6Enabled: false, protectWebRtc: true }))
 const byType = (type: string) => runtime.outbounds.find((item: any) => item.type === type)
 assert.equal(byType('socks').username, 'user')
 assert.equal(byType('socks').password, 'pass')
 assert.equal(byType('http').username, 'user')
 assert.equal(byType('snell').psk, 'psk123')
 assert.equal(byType('snell').version, 4)
 assert.equal(byType('snell').password, undefined)
 assert.equal(byType('hysteria').auth_str, 'x')
 assert.equal(byType('hysteria').up_mbps, 50)
 assert.equal(byType('hysteria').down_mbps, 100)
 assert.equal(byType('hysteria').password, undefined)
 assert.equal(byType('tuic').uuid, '11111111-2222-3333-4444-555555555555')
 assert.equal(byType('tuic').password, 'pass')
 assert.equal(byType('tuic').congestion_control, 'bbr')
 assert.equal(byType('tuic').udp_relay_mode, 'native')
 assert.equal(byType('shadowtls').version, 3)
 assert.equal(byType('ssh').user, 'root')
 assert.equal(byType('ssh').username, undefined)
 assert.equal(byType('anytls').password, 'pass')
})

test('share links round-trip through the parser', () => {
 const parser = new SubscriptionParser()
 for (const [protocol, link] of Object.entries(LINKS)) {
  const node = parser.parse(link).nodes[0]
  const again = parser.parse(nodeShareUri(node)).nodes[0]
  assert.equal(again.protocol, protocol)
  assert.equal(again.server, node.server)
  assert.equal(again.port, node.port)
  assert.equal(again.password, node.password, protocol + ' password')
 }
})
