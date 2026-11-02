import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSubscriptionUsage, usageLabel, usageProgress, usageRemaining, usageExpiry } from '../../entry/src/main/ets/domain/SubscriptionUsage.ts'
import { parseSfaCatalog } from '../../entry/src/main/ets/domain/SfaProfiles.ts'

test('header counters provide screenshot-style used/total and progress without any metadata groups', () => {
  const usage = parseSubscriptionUsage(`upload=0; download=${Math.round(8.42 * 1073741824)}; total=${750 * 1073741824}; expire=0`, 1000)
  assert.equal(usageLabel(usage), '8.42 GiB/750.00 GiB')
  assert.ok(Math.abs(usageProgress(usage) - 8.42 / 750 * 100) < 0.00001)
  assert.equal(usageRemaining(usage), '剩余流量：741.58 GiB')
  assert.equal(usageExpiry(usage), '套餐到期：长期有效')
})
test('missing counters are not mistaken for zero, unlimited quotas have no progress bar', () => {
  assert.equal(usageLabel(parseSubscriptionUsage('total=1000', 1)), '')
  assert.equal(usageProgress(parseSubscriptionUsage('upload=0; download=0; total=0', 1)), -1)
  assert.match(usageLabel(parseSubscriptionUsage('upload=0; download=0; total=0', 1)), /不限量/)
  assert.equal(usageProgress(parseSubscriptionUsage('upload=0; download=0; total=1000', 1)), 0)
})
test('over-quota progress is clamped and malformed or overflowing header values do not produce a meter', () => {
  const usage = parseSubscriptionUsage('upload=50; download=100; total=100', 1)
  assert.equal(usageProgress(usage), 100)
  assert.equal(usageRemaining(usage), '剩余流量：0.00 GiB')
  for (const header of ['upload=-1; download=NaN', 'total=Infinity', 'download=123junk', 'total=9007199254740992', 'unknown=1']) {
    assert.equal(parseSubscriptionUsage(header, 1), undefined)
  }
  assert.equal(parseSubscriptionUsage('upload=9007199254740991; download=1', 1), undefined)
})
test('old catalogs remain readable and new header snapshots survive encrypted-catalog serialization', () => {
  const profile = { id: 'remote', kind: 'remote', name: '机场', url: 'https://example.org/sub', content: '{}', updatedAt: 1 }
  const catalog = { version: 1, selectedId: 'remote', profiles: [profile] }
  assert.equal(parseSfaCatalog(JSON.stringify(catalog)).profiles[0].usage, undefined)
  const usage = parseSubscriptionUsage('upload=1; download=2; total=100; expire=0', 42)
  const updated = { ...catalog, profiles: [{ ...profile, usage }] }
  assert.deepEqual(parseSfaCatalog(JSON.stringify(updated)).profiles[0].usage, usage)
  assert.equal(parseSfaCatalog(JSON.stringify(updated)).profiles[0].content, '{}')
})
