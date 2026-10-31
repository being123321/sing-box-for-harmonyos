import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { TAILSCALE_COMMAND_TIMEOUT_MS } from '../../entry/src/main/ets/services/VpnRuntimeProtocol.ts'

function fixture() {
 const source = readFileSync(new URL('../../entry/src/main/ets/services/ConnectionCoordinator.ts', import.meta.url), 'utf8')
  .replace(/import[\s\S]*?from '[^']+'\r?\n/g, '').replace(/export /g, '')
 let now = 1000
 const context = vm.createContext({ Date: { now: () => now }, Math, JSON, TAILSCALE_COMMAND_TIMEOUT_MS,
  setTimeout: (callback: () => void) => { callback(); return 1 } })
 const C = vm.runInContext(stripTypeScriptTypes(source) + '\nConnectionCoordinator', context)
 const coordinator = Object.create(C.prototype)
 coordinator.activeSessionId = 'session'
 coordinator.disconnectTask = null
 let release!: () => void
 coordinator.tailscaleCommandQueue = new Promise<void>(resolve => { release = resolve })
 const commands: any[] = []
 coordinator.tailscaleBridge = {
  writeCommand: async (command: any) => { commands.push(command) },
  loadResponse: async () => ({ success: true, payloadJson: '{}' })
 }
 return { coordinator, commands, release, advance: () => { now = 71000 } }
}

test('Tailscale command freshness starts after a queued download, when actually dispatched', async () => {
 const f = fixture()
 const result = f.coordinator.sendTailscaleCommand('tailscale-status', '{}')
 f.advance(); f.release()
 assert.equal(await result, '{}')
 assert.equal(f.commands.length, 1)
 assert.equal(f.commands[0].createdAt, 71000)
})

test('queued Tailscale work never enters a replacement VPN session', async () => {
 const f = fixture()
 const result = f.coordinator.sendTailscaleCommand('tailscale-status', '{}')
 f.coordinator.activeSessionId = 'replacement'; f.release()
 await assert.rejects(result, /会话已改变/)
 assert.equal(f.commands.length, 0)
})

test('a pending safe stop cancels queued Tailscale commands', async () => {
 const f = fixture()
 const result = f.coordinator.sendTailscaleCommand('tailscale-status', '{}')
 f.coordinator.disconnectTask = Promise.resolve(); f.release()
 await assert.rejects(result, /请求已取消/)
 assert.equal(f.commands.length, 0)
})
