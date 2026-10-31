import test from 'node:test'
import assert from 'node:assert/strict'
import { selectedTailscaleEndpoint, tailscaleEmptyHint } from '../../entry/src/main/ets/domain/TailscalePresentation.ts'
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
