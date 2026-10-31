import test from 'node:test'
import assert from 'node:assert/strict'
import { selectedTailscaleEndpoint, tailscaleEmptyHint, canOpenTailscaleAuthUrl, tailscaleStateLabel } from '../../entry/src/main/ets/domain/TailscalePresentation.ts'
import type { TailscaleEndpointStatus } from '../../entry/src/main/ets/domain/TailscaleTypes.ts'

test('unstarted or ordinary profiles show a real empty state for null or missing endpoint lists', () => {
 for (const endpoints of [null, undefined, []]) assert.equal(selectedTailscaleEndpoint(endpoints,''),null)
 assert.match(tailscaleEmptyHint(), /添加 Tailscale 端点/)
 assert.match(tailscaleEmptyHint(), /启动 VPN/)
})
test('the always-visible tools entry opens the first available endpoint without a supplied tag', () => {
 const first={endpointTag:'first'} as TailscaleEndpointStatus
 const second={endpointTag:'second'} as TailscaleEndpointStatus
 assert.equal(selectedTailscaleEndpoint([first,second],''),first)
 assert.equal(selectedTailscaleEndpoint([first,second],'second'),second)
})
test('removed endpoints clear the details instead of retaining a previous session', () => {
 const next={endpointTag:'replacement'} as TailscaleEndpointStatus
 assert.equal(selectedTailscaleEndpoint([next],'removed'),null)
})

test('authentication actions allow web links and reject executable, credentialed or malformed values', () => {
 for (const value of ['https://login.tailscale.com/a/test','http://control.example/auth?state=test']) assert.equal(canOpenTailscaleAuthUrl(value),true)
 for (const value of ['', 'javascript:alert(1)', 'file:///private', 'https://user:pass@example.com/auth', 'https://example.com/\n', 'https://'+ 'x'.repeat(4100)]) assert.equal(canOpenTailscaleAuthUrl(value),false)
})

test('native backend states use Chinese captions without changing control values', () => {
 assert.equal(tailscaleStateLabel('NeedsLogin','Needs login'),'等待登录')
 assert.equal(tailscaleStateLabel('Running','Running'),'已连接')
 assert.equal(tailscaleStateLabel('FutureState','服务端状态'),'服务端状态')
})
