import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareLocalConfig } from '../../entry/src/main/ets/domain/LocalConfig.ts'

test('profile DNS preserves local, routed DoH, rules, and final resolver', () => {
  const profile = {
    outbounds: [{ tag: 'direct', type: 'direct' }, { tag: 'proxy', type: 'socks' }],
    dns: {
      servers: [
        { tag: 'local', type: 'local' },
        { tag: 'bootstrap', type: 'udp', server: '1.1.1.1', detour: 'direct' },
        { tag: 'remote', type: 'https', server: 'dns.example.test', detour: 'proxy' }
      ],
      rules: [{ domain_suffix: ['internal.test'], server: 'local' }, { domain_suffix: ['ads.test'], action: 'reject' }],
      final: 'remote'
    }
  }
  const runtime = JSON.parse(prepareLocalConfig(JSON.stringify(profile), { ipv6Enabled: true, protectWebRtc: true }))
  assert.deepEqual(runtime.dns, profile.dns)
  assert.ok(runtime.route.rules.some((rule: { action: string }) => rule.action === 'hijack-dns'))
  assert.equal(JSON.parse(prepareLocalConfig(JSON.stringify({ outbounds: profile.outbounds }))).dns, undefined)
})
