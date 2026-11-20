import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyQuickCatalog, importQuickNodes, quickNode } from '../../entry/src/main/ets/domain/QuickStart.ts'
import { prepareLocalConfig } from '../../entry/src/main/ets/domain/LocalConfig.ts'
import { configIpv6Enabled } from '../../entry/src/main/ets/domain/Ipv6Policy.ts'
import { nodeUrisFromSingBox } from '../../entry/src/main/ets/domain/SingBoxImport.ts'

const VLESS = 'vless://11111111-2222-3333-4444-555555555555@example.com:443?security=tls&sni=example.com&type=ws&path=%2Fws&host=example.com#Tokyo'

test('subscription refresh overwrites in-subscription node edits while independent local copies remain',()=>{
 const source={id:'subscription-A',name:'A',url:'https://example.test/nodes',updatedAt:1}
 const catalog=importQuickNodes(emptyQuickCatalog(),VLESS,source)
 const originalId=catalog.nodes[0].id
 const changed=VLESS.replace('example.com:443','different.example:443')
 catalog.nodes[0].uri=changed
 catalog.nodes.push({id:'independent-node',sourceId:'',uri:changed})
 const refreshed=importQuickNodes(catalog,VLESS,{...source,updatedAt:2})
 assert.equal(refreshed.nodes.find((node:any)=>node.id===originalId)!.uri,VLESS)
 assert.equal(refreshed.nodes.find((node:any)=>node.id==='independent-node')!.uri,changed)
})
const SS = 'ss://YWVzLTEyOC1nY206cGFzc3dvcmQ@1.2.3.4:8388#Osaka'

test('a pasted node link becomes a selectable node entry', () => {
 const catalog = importQuickNodes(emptyQuickCatalog(), VLESS)
 assert.equal(catalog.nodes.length, 1)
 assert.equal(quickNode(catalog.nodes[0]).name, 'Tokyo')
})

test('IPv6 follows the profile content instead of a manual switch', () => {
 const base = JSON.stringify({inbounds:[{type:'tun',address:['fdfe:dcba:9876::1/126']}],outbounds:[{type:'direct',tag:'d'}],dns:{servers:[{type:'local',tag:'dns-local'}]}})
 assert.equal(configIpv6Enabled(base), true)
 assert.equal(configIpv6Enabled('{"outbounds":[{"type":"direct","tag":"d"}]}'), false)
 assert.equal(configIpv6Enabled('{"dns":{"servers":[{"type":"udp","tag":"d","server":"2001:db8::53"}]}}'), true)
 assert.equal(configIpv6Enabled('{"outbounds":[{"type":"vless","tag":"v","server":"2001:db8::1"}]}'), true)
 // An IPv6 TUN address means the tunnel takes over IPv6; whether it works is
 // up to the proxy server, but it must never be left to the physical link.
 assert.equal(configIpv6Enabled('{"inbounds":[{"type":"tun","tag":"t","address":["172.19.0.1/30","fdfe:dcba:9876::1/126"]}],"outbounds":[{"type":"vless","tag":"v","server":"word.example","server_port":443}]}'), true)
 const runtime = JSON.parse(prepareLocalConfig(base, { ipv6Enabled: false, protectWebRtc: true }))
 // IPv6 is never rejected on the client: the TUN captures it and the node
 // decides how to reach the destination.
 assert.equal(runtime.route.rules.filter((rule: any) => rule.ip_version === 6).length, 0)
 assert.equal(runtime.dns.strategy, undefined)
})

test('sing-box JSON imports only its proxy outbounds as nodes', () => {
 const payload = JSON.stringify({ outbounds: [
  { type: 'selector', tag: 'proxy', outbounds: ['Word-Vision', 'direct'], default: 'Word-Vision' },
  { type: 'urltest', tag: 'AUTO', outbounds: ['Word-Vision'] },
  { type: 'vless', tag: 'Word-Vision', server: 'word.example', server_port: 24444,
   uuid: '5cd02cdb-5796-42cb-95e0-00701ab3b119', flow: 'xtls-rprx-vision',
   tls: { enabled: true, server_name: 'word.example', utls: { enabled: true, fingerprint: 'chrome' } } },
  { type: 'hysteria2', tag: 'Word-HY2', server: 'word.example', server_port: 24443, password: 'pw',
   tls: { enabled: true, server_name: 'word.example' } },
  { type: 'direct', tag: 'direct' }] })
 const uris = nodeUrisFromSingBox(payload)
 assert.equal(uris.length, 2)
 const catalog = importQuickNodes(emptyQuickCatalog(), uris.join('\n'))
 assert.equal(catalog.nodes.length, 2)
 assert.deepEqual(catalog.nodes.map((n) => quickNode(n).protocol).sort(), ['hysteria2', 'vless'])
})
