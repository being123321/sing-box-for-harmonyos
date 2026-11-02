import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'
import { subscriptionInfoFromNames } from '../../entry/src/main/ets/domain/SubscriptionInfo.ts'

test('production group refresh updates balance at five minutes and immediately after a profile change', () => {
  const source = readFileSync(new URL('../../entry/src/main/ets/pages/SfaIndex.ets', import.meta.url), 'utf8')
  const method = source.slice(source.indexOf('  private refreshGroupSubscriptionInfo('), source.indexOf('  private subscriptionInformation('))
  const Panel = vm.runInNewContext(stripTypeScriptTypes('class Panel {' + method + '}\nPanel'), { subscriptionInfoFromNames })
  const panel = new Panel()
  Object.assign(panel, { phase: 'running', suspended: false, recovering: false, catalog: { selectedId: 'a' }, groupSubscriptionRefreshedAt: 0,
    runtimeProfileSessions: new Map([['session-a', 'a'], ['session-b', 'b'], ['session-c', 'c']]) })
  const groups = (amount: number) => [{ tag: '代理', items: [{ tag: `剩余流量: ${amount} GB` }, { tag: '套餐到期: 长期有效' }] }]
  panel.refreshGroupSubscriptionInfo(groups(100), 1000, 'session-a')
  assert.equal(panel.groupSubscriptionRemaining, '剩余流量：100 GB')
  panel.refreshGroupSubscriptionInfo(groups(90), 300999, 'session-a')
  assert.equal(panel.groupSubscriptionRemaining, '剩余流量：100 GB')
  panel.refreshGroupSubscriptionInfo(groups(90), 301000, 'session-a')
  assert.equal(panel.groupSubscriptionRemaining, '剩余流量：90 GB')
  panel.suspended = true
  panel.refreshGroupSubscriptionInfo(groups(80), 700000, 'session-a')
  assert.equal(panel.groupSubscriptionRemaining, '剩余流量：90 GB')
  panel.suspended = false
  panel.catalog.selectedId = 'b'
  panel.refreshGroupSubscriptionInfo(groups(100), 301001, 'session-a')
  assert.equal(panel.groupSubscriptionProfile, 'a', 'late session A must never be attributed to selected profile B')
  panel.refreshGroupSubscriptionInfo(groups(5), 301001, 'session-b')
  assert.equal(panel.groupSubscriptionRemaining, '剩余流量：5 GB')
  panel.catalog.selectedId = 'c'
  panel.refreshGroupSubscriptionInfo([], 301002, 'session-c')
  assert.equal(panel.groupSubscriptionRemaining, '', 'another provider must not inherit the old balance')
})
