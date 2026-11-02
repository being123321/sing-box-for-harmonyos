import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { responseHeaderValue } from '../../entry/src/main/ets/domain/SubscriptionHeaders.ts'
import { parseSubscriptionUsage } from '../../entry/src/main/ets/domain/SubscriptionUsage.ts'
import { validateSfaContent } from '../../entry/src/main/ets/domain/SfaProfiles.ts'

test('production HEAD request captures mixed-case response header without requiring JSON body, and releases request', async () => {
  const source = readFileSync(new URL('../../entry/src/main/ets/pages/SfaIndex.ets', import.meta.url), 'utf8')
  const method = source.slice(source.indexOf('  private async downloadRaw('), source.indexOf('  private async saveEditor('))
  const state = { method: '', destroyed: 0 }
  const Client = vm.runInNewContext(stripTypeScriptTypes('class Client {' + method + '}\nClient'), {
    responseHeaderValue, parseSubscriptionUsage, validateSfaContent, Date,
    HttpsUrlGuard: class { rejectedInsecureUrl() { return false } exceededInvocationLimit() { return false } observedUrl() { return true } },
    http: { InterceptorType: {}, HttpDataType: {}, RequestMethod: { HEAD: 'HEAD', GET: 'GET' },
      HttpInterceptorChain: class { addChain() { return true } apply() { return true } },
      createHttp: () => ({ request: async (_url: string, options: any) => { state.method = options.method; return { responseCode: 200, result: undefined,
        header: { 'Subscription-Userinfo': ['upload=1; download=2; total=100'] } } }, destroy: () => { state.destroyed++ } }) }
  })
  const client = new Client()
  let usage: any
  assert.equal(await client.downloadRaw('https://example.org/sub', false, (value: any) => { usage = value }, true), '')
  assert.equal(state.method, 'HEAD')
  assert.equal(usage.totalBytes, 100)
  assert.equal(state.destroyed, 1)
  await assert.rejects(client.downloadRaw('http://example.org/sub', false), /HTTPS/)
})
