import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'
import { usageLabel } from '../../entry/src/main/ets/domain/SubscriptionUsage.ts'

test('production quota visibility excludes absent and expiry-only metadata but keeps zero valid usage', () => {
  const source = fs.readFileSync(new URL('../../entry/src/main/ets/pages/SfaIndex.ets', import.meta.url), 'utf8')
  const method = source.slice(source.indexOf('  private hasSubscriptionTraffic('), source.indexOf('  @Builder\n  quotaMeter('))
  const View = vm.runInNewContext(stripTypeScriptTypes('class View {' + method + '}\nView'), { usageLabel })
  const view = new View()
  view.subscriptionInformation = (profile: any) => ({ remaining: profile?.remaining || '', expiry: '套餐到期：长期有效' })
  assert.equal(view.hasSubscriptionTraffic(undefined), false)
  assert.equal(view.hasSubscriptionTraffic({}), false)
  assert.equal(view.hasSubscriptionTraffic({ usage: { uploadBytes: -1, downloadBytes: -1, totalBytes: -1, expireAtSeconds: 0 } }), false)
  assert.equal(view.hasSubscriptionTraffic({ usage: { uploadBytes: 0, downloadBytes: 0, totalBytes: 100 } }), true)
  assert.equal(view.hasSubscriptionTraffic({ remaining: '剩余流量：10 GB' }), true)
})
