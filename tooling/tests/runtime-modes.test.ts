import test from 'node:test'
import assert from 'node:assert/strict'
import { dashboardModes } from '../../entry/src/main/ets/domain/RuntimeModes.ts'
import { prepareLocalConfig } from '../../entry/src/main/ets/domain/LocalConfig.ts'
import { SingBoxConfigBuilder } from '../../entry/src/main/ets/domain/SingBoxConfigBuilder.ts'
import { SubscriptionParser } from '../../entry/src/main/ets/domain/SubscriptionParser.ts'

test('dashboard removes case aliases, puts rule in the middle and retains the active core value', () => {
  assert.deepEqual(dashboardModes(['direct', 'global', 'rule', 'Rule', 'Global'], 'Rule'), ['direct', 'Rule', 'global'])
  assert.deepEqual(dashboardModes(['Global', 'Rule', 'Direct'], 'Global'), ['Direct', 'Rule', 'Global'])
  assert.deepEqual(dashboardModes(['custom', 'rule', 'custom'], 'custom'), ['rule', 'custom'])
})

test('direct/global shortcuts retain filtering and sniffing in derived JSON without rewriting source', () => {
  const input = JSON.stringify({outbounds: [{type: 'socks', tag: 'proxy'}, {type: 'direct', tag: 'direct'}],
    route: {rules: [{clash_mode: 'global', outbound: 'proxy'}, {action: 'sniff'},
      {domain_suffix: ['ads.test'], action: 'reject'}]},
    dns: {rules: [{clash_mode: 'global', server: 'remote'}, {domain_suffix: ['ads.test'], action: 'reject'}]}})
  const result = JSON.parse(prepareLocalConfig(input))
  assert.equal(result.route.rules[0].action, 'sniff')
  const rejectAt = result.route.rules.findIndex((r: any) => r.action === 'reject')
  assert.ok(rejectAt > 0)
  assert.ok(result.route.rules.findIndex((r: any) => r.clash_mode === 'global') > rejectAt)
  assert.equal(result.dns.rules[0].action, 'reject')
  assert.deepEqual(JSON.parse(input).route.rules[0], {clash_mode: 'global', outbound: 'proxy'})
  assert.deepEqual(JSON.parse(prepareLocalConfig(JSON.stringify(result))).route.rules, result.route.rules)
})

test('builder keeps explicit blocking in direct and global while changing the default destination', () => {
  const bundle = new SubscriptionParser().parse('ss://YWVzLTEyOC1nY206cGFzc3dvcmQ@198.51.100.10:443#HK')
  bundle.rules.push({kind: 'domain', value: 'ads.test', target: 'reject', source: 'test'})
  for (const mode of ['direct', 'global'] as const) {
    const result = JSON.parse(new SingBoxConfigBuilder().build({bundle, mode, selectedNodeId: bundle.nodes[0].id}).configJson)
    assert.ok(result.route.rules.some((r: any) => r.action === 'reject' && r.domain?.includes('ads.test')))
    assert.equal(result.route.final, mode === 'direct' ? 'direct' : 'proxy')
  }
})

test('privacy keeps imported nested and default mode casing without adding aliases', () => {
  const input = JSON.stringify({ outbounds: [{ type: 'socks', tag: 'proxy', server: '127.0.0.1', server_port: 1080 }],
    experimental: { clash_api: { default_mode: 'Rule' } },
    route: { final: 'proxy', rules: [{ type: 'logical', mode: 'or', rules: [{ clash_mode: 'Global' }], outbound: 'proxy' }] } })
  const output = JSON.parse(prepareLocalConfig(input, { ipv6Enabled: true, protectWebRtc: true }))
  const stun = output.route.rules.filter((r: any) => r.protocol === 'stun')
  assert.deepEqual(stun.map((r: any) => r.clash_mode), ['Global', 'Rule'])
  assert.ok(stun.every((r: any) => r.outbound === 'proxy'))
  assert.equal(output.route.rules.at(-1).rules[0].clash_mode, 'Global')
})
