import { applyChoices, emptyChoices, recordChoice, resolveClashModeSpelling } from '../../entry/src/main/ets/domain/RuntimeChoices.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { normalizeSsidPolicy, shouldSuspendSsid } from '../../entry/src/main/ets/domain/SsidPolicy.ts'

// Execute the production Extension methods against simulated OS/core boundaries.
// This checks sequencing and cancellation, not HarmonyOS process retention.
function fixture() {
  let ssid = 'Home'
  let underlay = 'validated-underlay'
  const calls: string[] = []
  const policy = { enabled: true, direct: [], proxy: [], fallback: 'keep', excluded: ['Home'] }
  const source = readFileSync(new URL('../../entry/src/main/ets/vpnextension/NetworkVpnExtAbility.ets', import.meta.url), 'utf8')
    .replace(/import[\s\S]*?from '[^']+'\r?\n/g, '')
    .replace('export default class NetworkVpnExtAbility', 'class NetworkVpnExtAbility')
  let freshConnection: any
  const context = vm.createContext({
    vpnExtension: { createVpnConnection: () => { calls.push('new-vpn'); return freshConnection } },
    probeVpnChannel: async () => ({state: 'owned', netId: 17}),
    CoreGateway: class {}, applyChoices, resolveClashModeSpelling,
    RuntimeChoicesStore: class { async load(id: string) { return emptyChoices(id) } },
    VpnExtensionAbility: class { context = { filesDir: '/private', cacheDir: '/cache' } },
    normalizeSsidPolicy, shouldSuspendSsid,
    physicalNetworkSignature: async () => underlay,
    fileIo: { access: async () => true, readTextSync: () => JSON.stringify(policy) },
    VpnRuntimeConfigStore: class {
      async loadProfileId() { return 'test-profile' }
      async load() { return '{}' }
      async loadApplicationScope() { return { mode: 'all', trustedApplications: [] } }
    },
    wifiManager: { isWifiActive: () => !!ssid, ConnState: { CONNECTED: 1 }, getLinkedInfo: async () => ({ connState: 1, ssid }) },
    Date, JSON, setInterval, clearInterval,
    hilog: { error() {}, info() {} }
  })
  const Ext = vm.runInContext(stripTypeScriptTypes(source) + '\nNetworkVpnExtAbility', context)
  const ext = new Ext()
  ext.core = { initialize: async () => { calls.push('initialize'); return { available: true, version: '1.14.3' } }, validateConfig: async () => { calls.push('validate'); return { valid: true } }, getStatus: async () => ({ running: true, uploadBytes: 0, downloadBytes: 0, activeConnections: 0, selectedOutboundTag: '', snapshotJson: '{}' }), stop: async () => calls.push('stop-core'), start: async () => calls.push('start-core'), control: async () => calls.push('restore-mode') }
  freshConnection = { destroy: async () => calls.push('destroy-tun'), protectProcessNet: async () => calls.push('protect'), create: async () => { calls.push('create-tun'); return 42 } }
  ext.vpnConnection = freshConnection
  ext.coreStarted = true; ext.coreInitialized = true; ext.tunFd = 41
  ext.runtimeState = 'running'; ext.resumeConfig = JSON.stringify({ route: { rules: [{clash_mode: 'direct'}, {clash_mode: 'global'}] }, experimental: {clash_api: {default_mode: 'rule'}} }); ext.resumeMode = 'rule'; ext.readIpv6Enabled = () => false
  return { ext, calls, policy, freshConnection, underlay: (value: string) => { underlay = value }, roam: (value: string) => { ssid = value; ext.lastSsidCheck = 0 } }
}

test('excluded SSID stops the core before releasing TUN; roaming protects and restores service', async () => {
  const { ext, calls, roam } = fixture()
  await ext.applySsidPolicy('{"mode":"rule"}')
  assert.deepEqual(calls, ['stop-core', 'destroy-tun'])
  assert.equal(ext.suspended, true)
  assert.equal(ext.tunFd, -1)
  assert.equal(JSON.parse(ext.runtimeSnapshotJson).suspended, true)
  roam('Home'); await ext.applySsidPolicy('{}')
  assert.equal(calls.length, 2, 'staying on an excluded SSID must not repeatedly restart')
  roam('Office'); await ext.applySsidPolicy('{}')
  assert.deepEqual(calls.slice(2), ['new-vpn', 'protect', 'create-tun', 'initialize', 'validate', 'start-core', 'restore-mode'])
  assert.equal(ext.suspended, false)
  assert.equal(ext.coreStarted, true)
})

test('SSID read failure preserves suspension; manual stop prevents automatic resume', async () => {
  const { ext, calls, roam } = fixture()
  await ext.applySsidPolicy('{}')
  roam('<unknown ssid>'); await ext.applySsidPolicy('{}')
  assert.equal(ext.suspended, true)
  ext.stopRequested = true
  roam('Office'); await ext.applySsidPolicy('{}')
  assert.deepEqual(calls, ['stop-core', 'destroy-tun'])
})

test('a manual stop arriving during resume prevents creating a new TUN', async () => {
  const { ext, calls, roam, freshConnection } = fixture()
  await ext.applySsidPolicy('{}')
  freshConnection.protectProcessNet = async () => { calls.push('protect'); ext.stopRequested = true }
  roam('Office')
  await assert.rejects(ext.applySsidPolicy('{}'), /cancelled/)
  assert.deepEqual(calls, ['stop-core', 'destroy-tun', 'new-vpn', 'protect'])
})

test('excluded SSID startup never creates TUN, initializes core or applies per-app capture', async () => {
  const { ext, calls } = fixture()
  ext.coreStarted = false; ext.coreInitialized = false; ext.tunFd = -1
  ext.loadRuntimeSession = async () => {}
  await ext.startLifecycle()
  assert.deepEqual(calls, [])
  assert.equal(ext.suspended, true)
  assert.equal(ext.runtimeState, 'running')
  assert.equal(ext.stage, 'ssid-suspended')
  assert.equal(ext.tunFd, -1)
})

test('application allow and bypass capture are mutually exclusive', () => {
  const { ext } = fixture()
  const selected = ['com.example.browser']
  const allow = ext.buildVpnConfig(false, { mode: 'allowlist', trustedApplications: selected })
  assert.deepEqual(Array.from(allow.trustedApplications), selected)
  assert.equal(allow.blockedApplications, undefined)
  const bypass = ext.buildVpnConfig(false, { mode: 'blocklist', trustedApplications: selected })
  assert.deepEqual(Array.from(bypass.blockedApplications), selected)
  assert.equal(bypass.trustedApplications, undefined)
})

test('suspended session waits for validated cellular instead of failing during Wi-Fi handoff', async () => {
  const { ext, calls, roam, underlay } = fixture()
  await ext.applySsidPolicy('{}')
  underlay('none'); roam('')
  await ext.applySsidPolicy('{}')
  assert.equal(ext.suspended, true)
  assert.deepEqual(calls, ['stop-core','destroy-tun'])
  underlay('cellular-ready'); roam('')
  await ext.applySsidPolicy('{}')
  assert.equal(ext.suspended, false)
  assert.deepEqual(calls.slice(2), ['new-vpn','protect','create-tun','initialize','validate','start-core','restore-mode'])
})


test('destroyed connection is discarded and each resume revalidates before starting', async () => {
  const { ext, calls, roam, freshConnection } = fixture()
  await ext.applySsidPolicy('{}')
  assert.equal(ext.vpnConnection, null)
  assert.equal(ext.coreInitialized, false)
  for (let i = 0; i < 3; i++) {
    roam('Office'); await ext.applySsidPolicy('{}')
    assert.equal(ext.vpnConnection, freshConnection)
    assert.equal(ext.coreStarted, true)
    roam('Home'); await ext.applySsidPolicy('{}')
    assert.equal(ext.vpnConnection, null)
    assert.equal(ext.coreStarted, false)
    assert.equal(ext.tunFd, -1)
  }
  assert.equal(calls.filter(x => x === 'new-vpn').length, 3)
  assert.equal(calls.filter(x => x === 'validate').length, 3)
})

test('underlay changing during validation discards prepared TUN and retries while suspended', async () => {
  const { ext, calls, roam, underlay } = fixture()
  await ext.applySsidPolicy('{}')
  ext.core.validateConfig = async () => { underlay('next-network'); return { valid: true } }
  roam('Office'); await ext.applySsidPolicy('{}')
  assert.equal(ext.suspended, true)
  assert.equal(ext.tunFd, -1)
  assert.equal(ext.vpnConnection, null)
  assert.equal(calls.filter(x => x === 'start-core').length, 0)
  ext.core.validateConfig = async () => ({ valid: true })
  roam('Office'); await ext.applySsidPolicy('{}')
  assert.equal(ext.suspended, false)
})

test('underlay changing during native startup stops the newly started service', async () => {
  const { ext, calls, roam, underlay } = fixture()
  await ext.applySsidPolicy('{}')
  ext.core.start = async () => { calls.push('start-core'); underlay('new-cellular') }
  roam('Office'); await ext.applySsidPolicy('{}')
  assert.equal(ext.suspended, true)
  assert.equal(ext.coreStarted, false)
  assert.equal(ext.tunFd, -1)
  assert.ok(calls.includes('start-core'))
  assert.deepEqual(calls.slice(-2), ['stop-core', 'destroy-tun'])
})

test('background suspension obtains mode once and restores it after a fresh start', async () => {
  const { ext, calls, roam } = fixture()
  ext.core.getStatus = async () => ({ running: true, uploadBytes: 12, downloadBytes: 34, snapshotJson: '{"mode":"global"}' })
  let restored = ''
  ext.core.control = async (text: string) => { restored = JSON.parse(text).mode }
  await ext.applySsidPolicy('{}')
  assert.equal(ext.runtimeDownloadBytes, 34)
  roam('Office'); await ext.applySsidPolicy('{}')
  assert.equal(restored, 'global')
  assert.ok(calls.indexOf('validate') < calls.indexOf('start-core'))
})

test('failure to stop core still attempts to release system VPN and does not report clean suspension', async () => {
  const { ext, calls } = fixture()
  ext.core.stop = async () => { calls.push('failed-stop'); throw new Error('failed') }
  await assert.rejects(ext.applySsidPolicy('{}'), /cleanup failed/)
  assert.ok(calls.includes('destroy-tun'))
  assert.equal(ext.suspended, false)
  assert.equal(ext.tunFd, -1)
})


test('manual node choice survives closing VPN and starting a fresh service after suspension', async () => {
  const { ext, calls, roam } = fixture()
  let saved = emptyChoices('profile-A')
  ext.profileId = 'profile-A'
  ext.resumeConfig = JSON.stringify({ outbounds: [{ type: 'selector', tag: 'proxy', outbounds: ['slow', 'fast'], default: 'slow' }] })
  ext.choicesStore = {
    load: async () => saved,
    record: async (_id: string, command: any) => { saved = recordChoice(saved, command); return saved }
  }
  await ext.rememberChoice({ action: 'select', group: 'proxy', outbound: 'fast' })
  await ext.applySsidPolicy('{}')
  assert.equal(ext.suspended, true)
  let startedWith = ''
  ext.core.start = async (_fd: number, text: string) => { calls.push('start-core'); startedWith = JSON.parse(text).outbounds[0].default }
  roam('Office'); await ext.applySsidPolicy('{}')
  assert.equal(ext.suspended, false)
  assert.equal(startedWith, 'fast', 'fresh service must not use the slower imported default')
})

test('SSID direct retains TUN and core, restores original mode and never records temporary choice', async () => {
  const { ext, calls, policy, roam } = fixture()
  ;(policy as any).excludedAction = 'direct'
  let mode = 'global'
  ext.core.getStatus = async () => ({snapshotJson: JSON.stringify({mode})})
  ext.core.control = async (text: string) => { mode = JSON.parse(text).mode; calls.push(mode) }
  await ext.applySsidPolicy('{}')
  assert.equal(mode, 'direct')
  assert.equal(ext.suspended, false)
  assert.equal(ext.tunFd, 41)
  assert.equal(ext.resumeMode, 'global')
  roam('Home'); await ext.applySsidPolicy('{}')
  assert.deepEqual(calls, ['direct'])
  roam('Office'); await ext.applySsidPolicy('{}')
  assert.equal(mode, 'global')
  assert.deepEqual(calls, ['direct', 'global'])
})

test('roaming between individual direct and suspend SSIDs preserves the original mode for departure', async () => {
  const { ext, calls, policy, roam } = fixture()
  policy.excluded = ['Home','Cafe']
  ;(policy as any).actions = [{ssid:'Home',action:'direct'},{ssid:'Cafe',action:'suspend'}]
  let mode = 'global'
  ext.core.getStatus = async () => ({running:true, snapshotJson:JSON.stringify({mode})})
  ext.core.control = async (text: string) => { mode = JSON.parse(text).mode }
  await ext.applySsidPolicy('{}')
  assert.equal(mode,'direct'); assert.equal(ext.tunFd,41)
  roam('Cafe'); await ext.applySsidPolicy(JSON.stringify({mode}))
  assert.equal(ext.suspended,true); assert.equal(ext.tunFd,-1)
  assert.equal(ext.resumeMode,'global')
  roam('Home'); await ext.applySsidPolicy('{}')
  assert.equal(ext.suspended,false); assert.equal(mode,'direct')
  roam('Office'); await ext.applySsidPolicy('{}')
  assert.equal(mode,'global')
  assert.equal(calls.filter((call: string) => call === 'start-core').length,1)
})
