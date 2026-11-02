import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { isUiActive, telemetryInterval, heartbeatInterval } from '../../entry/src/main/ets/domain/RuntimeActivity.ts'
import { normalizeSsidPolicy, shouldSuspendSsid } from '../../entry/src/main/ets/domain/SsidPolicy.ts'

test('UI lease expires after crashes and background heartbeat retains stale-session margin', () => {
  assert.equal(isUiActive({ foreground: true, updatedAt: 1000 }, 15000), true)
  assert.equal(isUiActive({ foreground: true, updatedAt: 1000 }, 17000), false)
  assert.equal(isUiActive({ foreground: false, updatedAt: 1000 }, 1000), false)
  assert.equal(isUiActive({ foreground: true, updatedAt: 5000 }, 1000), false)
  assert.equal(heartbeatInterval(false), 3000)
  assert.equal(telemetryInterval(false), 15000)
  assert.equal(telemetryInterval(true), 1000)
})

function fixture() {
  const lease = { foreground: false, updatedAt: Date.now() }
  const counts = { full: 0, lite: 0, stop: 0, destroy: 0, reset: 0 }
  let physical = 'wifi-A'
  const source = readFileSync(new URL('../../entry/src/main/ets/vpnextension/NetworkVpnExtAbility.ets', import.meta.url), 'utf8')
    .replace(/import[\s\S]*?from '[^']+'\r?\n/g, '').replace('export default class NetworkVpnExtAbility', 'class NetworkVpnExtAbility')
  const context = vm.createContext({
    probeVpnChannel: async () => ({state: 'owned', netId: 17}),
    hilog: { info() {}, warn() {}, error() {} },
    CoreGateway: class {}, VpnExtensionAbility: class { context = { filesDir: '/private' } },
    isUiActive, telemetryInterval, heartbeatInterval, normalizeSsidPolicy, shouldSuspendSsid,
    physicalNetworkSignature: async () => physical,
    fileIo: { access: async () => true, readTextSync: (path: string) => JSON.stringify(path.endsWith('ui-activity.json') ? lease : { enabled: true, direct: [], proxy: [], fallback: 'keep', excluded: [] }) },
    Date, JSON, setTimeout, clearTimeout, setInterval, clearInterval
  })
  const Ext = vm.runInContext(stripTypeScriptTypes(source) + '\nNetworkVpnExtAbility', context)
  const ext = new Ext()
  const status = { running: true, version: '1.14.3', uploadBytes: 100, downloadBytes: 200, activeConnections: 2, selectedOutboundTag: 'proxy', snapshotJson: '{}' }
  ext.core = { getStatus: async () => { counts.full++; return status }, getStatusLite: async () => { counts.lite++; return status },
    stop: async () => { counts.stop++ }, control: async (text: string) => { if (JSON.parse(text).action === 'network-change') counts.reset++ } }
  ext.vpnConnection = { destroy: async () => { counts.destroy++ } }
  ext.runtimeState = 'running'; ext.coreStarted = true; ext.coreInitialized = true; ext.tunFd = 42
  return { ext, lease, counts, change: (value: string) => { physical = value; ext.networkChangePending = true; ext.networkRevision++ } }
}

test('background core health never requests logs/groups/connections snapshots', async () => {
  const { ext, counts, lease } = fixture()
  await ext.checkCoreHealth(); await ext.checkCoreHealth()
  assert.equal(counts.full, 0)
  assert.equal(counts.lite, 1, 'background checks are rate limited')
  lease.foreground = true; lease.updatedAt = Date.now(); ext.lastHealthSampleAt = 0
  await ext.checkCoreHealth()
  assert.equal(counts.full, 1, 'foreground immediately restores rich telemetry')
})

test('actual underlay changes reset sockets without recreating TUN; duplicate events do not', async () => {
  const { ext, counts, change } = fixture()
  ext.lastNetworkSignature = 'wifi-A'
  change('cellular-B'); await ext.checkCoreHealth()
  assert.equal(counts.reset, 1)
  assert.equal(counts.destroy, 0)
  change('cellular-B'); await ext.checkCoreHealth()
  assert.equal(counts.reset, 1)
  ext.stopRequested = true
  change('wifi-C'); await ext.checkCoreHealth()
  assert.equal(counts.reset, 1)
})

test('SSID exclusion suspends before any network reset or per-app activity', async () => {
  const { ext, counts, change } = fixture()
  ext.requestedSsidSuspension = async () => true
  change('excluded-WiFi'); await ext.checkCoreHealth()
  assert.equal(ext.suspended, true)
  assert.equal(counts.stop, 1)
  assert.equal(counts.destroy, 1)
  assert.equal(counts.reset, 0)
  assert.equal(counts.full, 1, 'one transition snapshot preserves mode even in background')
  assert.equal(counts.lite, 0)
})

test('failed SSID resume keeps supervisor running and retries without reopening UI', async () => {
  const { ext } = fixture()
  ext.suspended = true
  ext.activateSavedService = async () => { throw new Error('underlay not ready') }
  let cleanup = 0
  ext.cleanupResources = async () => { cleanup++; return true }
  await ext.checkCoreHealth()
  assert.equal(ext.runtimeState, 'running')
  assert.equal(ext.stage, 'recovery-wait')
  assert.equal(ext.recoveryReason, 'network')
  assert.equal(ext.healthCheckBusy, false)
  assert.equal(cleanup, 0, 'must not tear down the heartbeat after a transient resume failure')
  const retries: string[] = []
  ext.recoverRuntime = async (reason: string) => { retries.push(reason) }
  await ext.checkCoreHealth()
  assert.deepEqual(retries, ['network'])
  ext.stopRequested = true
  await ext.checkCoreHealth()
  assert.equal(retries.length, 1, 'manual stop must suppress retries')
})
