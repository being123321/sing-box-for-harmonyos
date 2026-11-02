import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'
import { saveSfaProfile } from '../../entry/src/main/ets/domain/SfaProfiles.ts'

function fixture() {
  const source = fs.readFileSync(new URL('../../entry/src/main/ets/pages/SfaIndex.ets', import.meta.url), 'utf8')
  const methods = source.slice(source.indexOf('  private async refreshQuickUsage('), source.indexOf('  private subscriptionInformation('))
  let now = 1000000
  const Panel = vm.runInNewContext(stripTypeScriptTypes('class Panel {' + methods + '}\nPanel'), { Date: { now: () => now }, saveSfaProfile })
  const panel = new Panel()
  const profile = { id: 'remote', kind: 'remote', name: '机场', url: 'https://example.org/sub', content: '{"outbounds":[]}', updatedAt: 12 }
  const usage = { uploadBytes: 1, downloadBytes: 2, totalBytes: 100, expireAtSeconds: 0, updatedAt: now }
  Object.assign(panel, { uiForeground: true, pageAlive: true, busy: false, usageRefreshing: false, usageAttemptAt: 0, usageAttemptProfile: '',
    quickUsageAttempts: new Map(), quick: { version: 1, nodes: [{ id: 'original' }], subscriptions: [] },
    catalog: { version: 1, selectedId: profile.id, profiles: [profile] } })
  const calls = { requests: 0, saves: 0, quickSaves: 0 }
  panel.selectedProfile = () => panel.catalog.profiles[0]
  panel.downloadRaw = async (_url: string, validate: boolean, callback: (value: any) => void, head: boolean) => {
    calls.requests++; assert.equal(head, true); assert.equal(validate, false); callback(usage); return ''
  }
  panel.persist = async (next: any) => { calls.saves++; panel.catalog = next }
  panel.quickStore = { save: async () => { calls.quickSaves++ } }
  panel.persistQuick = () => { throw Error('metadata must never regenerate the base config or restart VPN') }
  panel.toast = () => {}
  return { panel, calls, usage, profile, advance: (value: number) => { now += value } }
}

test('five-minute header refresh stores usage without replacing JSON or restarting the selected profile', async () => {
  const { panel, calls, usage, profile, advance } = fixture()
  await panel.refreshSubscriptionUsage()
  assert.equal(calls.saves, 1)
  assert.deepEqual(panel.catalog.profiles[0].usage, usage)
  assert.equal(panel.catalog.profiles[0].content, profile.content)
  assert.equal(panel.catalog.profiles[0].updatedAt, 12)
  assert.equal(panel.catalog.selectedId, profile.id)
  await panel.refreshSubscriptionUsage()
  assert.equal(calls.requests, 1)
  advance(300000)
  await panel.refreshSubscriptionUsage()
  assert.equal(calls.requests, 2)
  panel.uiForeground = false
  await panel.refreshSubscriptionUsage(true)
  assert.equal(calls.requests, 2)
})

test('late metadata for a replaced subscription URL is discarded', async () => {
  const { panel, calls, usage } = fixture()
  panel.downloadRaw = async (_url: string, _validate: boolean, callback: (value: any) => void) => {
    panel.catalog.profiles[0].url = 'https://example.org/new'; callback(usage); return ''
  }
  // Simulate replacing the catalog entry, not mutating the captured request snapshot.
  const oldDownload = panel.downloadRaw
  panel.downloadRaw = async (...args: any[]) => {
    panel.catalog = { ...panel.catalog, profiles: [{ ...panel.catalog.profiles[0] }] }
    return oldDownload(...args)
  }
  await panel.refreshSubscriptionUsage()
  assert.equal(calls.saves, 0)
})

test('base config imports keep node subscriptions separate and refresh only their metadata', async () => {
  const { panel, calls, usage } = fixture()
  panel.catalog.profiles[0].kind = 'builtin'
  panel.quick.subscriptions = [{ id: 'sub', name: '节点订阅', url: 'https://example.org/nodes', updatedAt: 12 }]
  const nodes = panel.quick.nodes
  await panel.refreshSubscriptionUsage()
  assert.equal(calls.quickSaves, 1)
  assert.equal(calls.saves, 0)
  assert.equal(panel.quick.nodes, nodes)
  assert.deepEqual(panel.quick.subscriptions[0].usage, usage)
  assert.equal(panel.quick.subscriptions[0].updatedAt, 12)
})
