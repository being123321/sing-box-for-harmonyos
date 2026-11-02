import test from 'node:test'
import assert from 'node:assert/strict'
import { subscriptionInfoFromJson, subscriptionInfoFromNames } from '../../entry/src/main/ets/domain/SubscriptionInfo.ts'

test('provider metadata in selector members matches screenshot, without changing JSON', () => {
  const text = JSON.stringify({ outbounds: [{ type: 'selector', tag: '流媒体', outbounds: ['PROXY', '剩余流量: 741.57 GB', '套餐到期: 长期有效', '日本-优化'] }] })
  assert.deepEqual(subscriptionInfoFromJson(text), { remaining: '剩余流量：741.57 GB', expiry: '套餐到期：长期有效' })
  assert.equal(JSON.parse(text).outbounds[0].outbounds[1], '剩余流量: 741.57 GB')
})
test('outbound tags support emoji, Chinese punctuation, zero balance and binary units', () => {
  assert.deepEqual(subscriptionInfoFromJson(JSON.stringify({ outbounds: [{ tag: '📊 剩余流量：0 GiB' }, { tag: '套餐到期：2027-01-01' }] })),
    { remaining: '剩余流量：0 GiB', expiry: '套餐到期：2027-01-01' })
})
test('invalid or absent metadata never invents traffic totals or account details', () => {
  for (const text of ['{bad', 'null', '[]', '{}', '{"outbounds":[null,1,{"tag":"普通节点"}]}']) {
    assert.deepEqual(subscriptionInfoFromJson(text), { remaining: '', expiry: '' })
  }
  assert.equal(subscriptionInfoFromNames(['剩余流量：password', '日本-优化 100GB']).remaining, '')
})
test('new subscription content immediately provides new balance and expiry', () => {
  const json = (tag: string) => JSON.stringify({ outbounds: [{ tag }] })
  assert.equal(subscriptionInfoFromJson(json('剩余流量：12 GB')).remaining, '剩余流量：12 GB')
  assert.equal(subscriptionInfoFromJson(json('剩余流量：10 GB')).remaining, '剩余流量：10 GB')
})
