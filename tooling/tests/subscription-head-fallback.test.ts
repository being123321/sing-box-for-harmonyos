import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'
import { usageProgress } from '../../entry/src/main/ets/domain/SubscriptionUsage.ts'

test('production metadata request falls back to GET when HEAD omits counters or rejects method', async () => {
  const source = fs.readFileSync(new URL('../../entry/src/main/ets/pages/SfaIndex.ets', import.meta.url), 'utf8')
  const method = source.slice(source.indexOf('  private async downloadUsage('), source.indexOf('  private async refreshQuickUsage('))
  const Client = vm.runInNewContext(stripTypeScriptTypes('class Client {' + method + '}\nClient'), { usageProgress })
  const usage = { uploadBytes: 1, downloadBytes: 2, totalBytes: 100, expireAtSeconds: 0, updatedAt: 1 }
  for (const throwHead of [false, true]) {
    const client = new Client()
    const calls: string[] = []
    client.downloadRaw = async (_url: string, validate: boolean, callback: (value: any) => void, head: boolean) => {
      assert.equal(validate, false)
      calls.push(head ? 'HEAD' : 'GET')
      if (head) { if (throwHead) throw Error('HTTP 405'); callback(undefined) }
      else callback(usage)
      return '{"configuration":"must not be saved"}'
    }
    assert.deepEqual(await client.downloadUsage('https://example.org/sub'), usage)
    assert.deepEqual(calls, ['HEAD', 'GET'])
  }
})
