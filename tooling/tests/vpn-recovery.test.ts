import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { nextRecoveryAttempt } from '../../entry/src/main/ets/domain/VpnRecoveryPolicy.ts'
import { applyChoices, emptyChoices, resolveClashModeSpelling } from '../../entry/src/main/ets/domain/RuntimeChoices.ts'
import { telemetryInterval } from '../../entry/src/main/ets/domain/RuntimeActivity.ts'

function fixture(now: () => number = () => Date.now()) {
 let channel = 'owned'
 let nativeRunning = true
 let excluded: boolean | null = false
 let underlay = 'stable'
 const calls: string[] = []
 let started = ''
 const source = readFileSync(new URL('../../entry/src/main/ets/vpnextension/NetworkVpnExtAbility.ets', import.meta.url),'utf8')
  .replace(/import[\s\S]*?from '[^']+'\r?\n/g,'').replace('export default class NetworkVpnExtAbility','class NetworkVpnExtAbility')
 const context = vm.createContext({ CoreGateway: class {}, VpnExtensionAbility: class { context = { filesDir: '/private', cacheDir: '/cache' } },
  VPN_RUNTIME_PROTOCOL_CURRENT: 'v3', Date: class extends Date { static now() { return now() } }, JSON, setTimeout, clearTimeout, setInterval, clearInterval, nextRecoveryAttempt, applyChoices, resolveClashModeSpelling, telemetryInterval,
  probeVpnChannel: async () => ({ state: channel, netId: channel === 'owned' ? 17 : -1 }), physicalNetworkSignature: async () => underlay,
  vpnExtension: { createVpnConnection: () => { calls.push('new-vpn'); return { protectProcessNet: async () => calls.push('protect'),
   create: async () => { calls.push('create'); channel='owned'; return 42 }, destroy: async () => calls.push('destroy') } } },
  hilog: { warn() {}, error() {}, info() {} }
 })
 const Ext = vm.runInContext(stripTypeScriptTypes(source)+'\nNetworkVpnExtAbility',context)
 const ext = new Ext()
 const status = () => ({ running: nativeRunning, version: '1.14.4', uploadBytes: 10, downloadBytes: 20, activeConnections: 0, selectedOutboundTag: 'proxy', snapshotJson: '{"mode":"global"}' })
 ext.core = { getStatus: async () => status(), getStatusLite: async () => status(),
  stop: async () => { calls.push('stop'); nativeRunning=false }, initialize: async () => ({available:true,version:'1.14.4'}), validateConfig: async () => ({valid:true}),
  start: async (_fd: number, config: string) => { calls.push('start'); started=config; nativeRunning=true }, control: async () => calls.push('control') }
 ext.runtimeState='running'; ext.sessionId='session'; ext.coreStarted=true; ext.coreInitialized=true; ext.tunFd=41
 ext.vpnConnection={destroy: async () => calls.push('destroy')}
 ext.runtimeBridge={publishStatus: async () => {}}
 ext.resumeConfig='{"outbounds":[{"type":"selector","tag":"proxy","outbounds":["slow","fast"],"default":"slow"}]}'
 ext.profileId='profile'; ext.choicesStore={load:async () => ({profileId:'profile',mode:'global',groups:[{group:'proxy',outbound:'fast'}]})}
 ext.requestedSsidSuspension=async () => excluded
 ext.readIpv6Enabled=() => true; ext.uiActive=() => false; ext.lastVpnProbeAt=0
 return {ext,calls,started:() => started,setChannel:(s: string)=>{channel=s},setCore:(value: boolean)=>{nativeRunning=value},exclude:(value: boolean|null)=>{excluded=value},underlay:(value: string)=>{underlay=value}}
}

test('validation gap keeps the previous bearer and rebuilds when cellular returns', async () => {
 const {ext,calls,underlay}=fixture()
 const old=JSON.stringify({kind:'wifi',interface:'vendor0',id:10})
 ext.lastNetworkSignature=old;ext.networkChangePending=true
 underlay('none');await ext.checkCoreHealth()
 assert.equal(ext.lastNetworkSignature,old);assert.equal(ext.networkChangePending,true)
 underlay(JSON.stringify({kind:'cellular',interface:'vendor1',id:11}))
 await ext.checkCoreHealth()
 assert.ok(calls.includes('start'));assert.equal(ext.networkRecoveryBudget.attempts,0)
 assert.equal(ext.recoveryBudget.attempts,0);assert.equal(ext.suspended,false)
})

test('IPv6 bearer handoff directly rebuilds instead of resetting a service about to close', async () => {
 const {ext,calls,underlay}=fixture()
 ext.lastNetworkSignature=JSON.stringify({kind:'wifi',interface:'vendor0',id:10});ext.networkChangePending=true
 underlay(JSON.stringify({kind:'cellular',interface:'vendor1',id:11}))
 const controls:string[]=[]
 ext.core.control=async(payload:string)=>{controls.push(JSON.parse(payload).action)}
 await ext.checkCoreHealth()
 assert.ok(calls.includes('stop'));assert.ok(calls.includes('start'))
 assert.ok(!controls.includes('network-change'));assert.equal(ext.suspended,false)
})

test('same-bearer and IPv4 handoffs retain the lightweight network reset', async () => {
 for (const ipv6 of [true,false]) {
  const {ext,calls,underlay}=fixture()
  ext.readIpv6Enabled=()=>ipv6
  ext.lastNetworkSignature=JSON.stringify({kind:'wifi',interface:'vendor0',id:10});ext.networkChangePending=true
  underlay(JSON.stringify({kind:ipv6?'wifi':'cellular',interface:'vendor1',id:11}))
  const controls:string[]=[];ext.core.control=async(payload:string)=>{controls.push(JSON.parse(payload).action)}
  await ext.checkCoreHealth()
  assert.deepEqual(controls,['network-change']);assert.ok(!calls.includes('stop'));assert.ok(!calls.includes('start'))
 }
})

test('unchanged recovery config reuses validation; changed launch config is checked again', async () => {
 const {ext,calls}=fixture();let validations=0
 ext.core.validateConfig=async()=>{validations++;return{valid:true}}
 await ext.recoverRuntime('network');await ext.recoverRuntime('network')
 assert.equal(validations,1);assert.equal(calls.filter(c=>c==='start').length,2)
 const config=JSON.parse(ext.resumeConfig);config.log={level:'warn'};ext.resumeConfig=JSON.stringify(config)
 await ext.recoverRuntime('network');assert.equal(validations,2)
})

test('rejected or cancelled validation never populates the success cache', async () => {
 const {ext}=fixture();let validations=0
 ext.core.validateConfig=async()=>{validations++;return{valid:false}}
 await assert.rejects(ext.validateRuntimeConfig('bad'),/configuration rejected/)
 await assert.rejects(ext.validateRuntimeConfig('bad'),/configuration rejected/)
 assert.equal(validations,2);assert.equal(ext.validatedConfig,'')
 ext.core.validateConfig=async()=>{ext.stopRequested=true;return{valid:true}}
 await assert.rejects(ext.validateRuntimeConfig('cancelled'),/cancelled/)
 assert.equal(ext.validatedConfig,'')
})

test('final lifecycle cleanup releases cached validation while SSID teardown keeps it reusable', async () => {
 const {ext}=fixture();ext.validatedConfig='checked'
 await ext.closeSsidResources();assert.equal(ext.validatedConfig,'checked')
 ext.stopBackgroundTasks=()=>{}
 await ext.cleanupResources(true);assert.equal(ext.validatedConfig,'')
})

test('successful network switches do not exhaust the crash recovery budget', async () => {
 const {ext,calls}=fixture()
 ext.recoveryBudget={windowAt:Date.now(),attempts:3,retryAt:Date.now()+60000}
 for(let i=0;i<5;i++) await ext.recoverRuntime('network')
 assert.equal(calls.filter(x=>x==='start').length,5)
 assert.equal(ext.recoveryBudget.attempts,3)
 assert.equal(ext.networkRecoveryBudget.attempts,0)
})

test('failed network rebuilds remain bounded independently of crashes', async () => {
 const {ext,calls}=fixture()
 ext.networkRecoveryBudget={windowAt:Date.now(),attempts:3,retryAt:0}
 await ext.recoverRuntime('network')
 assert.equal(ext.stage,'recovery-cooldown');assert.equal(ext.runtimeState,'running');assert.ok(!calls.includes('new-vpn'))
})

test('busy URLTest receives cancellation before a network transition', async () => {
 const {ext,calls}=fixture()
 const commands: string[]=[]
 ext.core.control=async (payload:string)=>commands.push(JSON.parse(payload).action)
 ext.commandBusy=true;ext.networkChangePending=true
 await ext.checkCoreHealth()
 assert.deepEqual(commands,['cancel-url-test']);assert.deepEqual(calls,[])
})

test('failed file watcher keeps prompt SSID checks even when network events work', async () => {
 const {ext}=fixture()
 ext.networkEventsReady=true;ext.wifiEventsReady=true;ext.policyWatcher=null
 assert.equal(ext.ssidCheckInterval(),1000)
 ext.policyWatcher={};assert.equal(ext.ssidCheckInterval(),30000)
})

test('SSID exclusion interrupts a busy test and wins over recovery backoff', async () => {
 const {ext,calls,exclude}=fixture();exclude(true)
 const commands:string[]=[]
 ext.core.control=async (payload:string)=>commands.push(JSON.parse(payload).action)
 ext.commandBusy=true;await ext.checkCoreHealth()
 assert.deepEqual(commands,['cancel-url-test']);assert.equal(ext.networkChangePending,true)
 ext.commandBusy=false;ext.recoveryReason='network'
 ext.networkRecoveryBudget.retryAt=Date.now()+60000
 await ext.checkCoreHealth()
 assert.equal(ext.suspended,true);assert.deepEqual(calls,['stop','destroy'])
 assert.equal(ext.recoveryReason,'')
})

test('confirmed missing VPN rebuilds TUN and core using saved manual node and mode', async () => {
 const {ext,calls,setChannel,started}=fixture();setChannel('absent')
 await ext.checkCoreHealth(); assert.equal(calls.length,0)
 ext.missingVpnSince=Date.now()-4000;ext.lastVpnProbeAt=0
 await ext.checkCoreHealth()
 assert.deepEqual(calls,['stop','destroy','new-vpn','protect','create','start','control'])
 assert.equal(JSON.parse(started()).outbounds[0].default,'fast')
 assert.equal(ext.recoveryReason,'');assert.equal(ext.suspended,false)
})

test('working VPN/core with a slow or unreachable node does not trigger restart', async () => {
 const {ext,calls}=fixture(); await ext.checkCoreHealth()
 assert.deepEqual(calls,[]);assert.equal(ext.ownedVpnId,17)
})

test('transient background health failure keeps supervision alive and recovers a later lost VPN', async () => {
 const {ext,calls,setChannel}=fixture()
 const sample=ext.core.getStatusLite
 ext.core.getStatusLite=async()=>{throw new Error('temporary read failure')}
 await ext.checkCoreHealth()
 assert.equal(ext.runtimeState,'running')
 assert.equal(ext.stage,'runtime-health-retry')
 assert.equal(ext.lastHealthSampleAt,0)
 ext.core.getStatusLite=sample
 setChannel('absent');ext.lastVpnProbeAt=0
 await ext.checkCoreHealth()
 ext.missingVpnSince=Date.now()-4000;ext.lastVpnProbeAt=0
 await ext.checkCoreHealth()
 assert.ok(calls.includes('start'))
 assert.equal(ext.runtimeState,'running')
 assert.equal(ext.stage,'running')
})

test('a successful sample clears the transient diagnostic without restarting a healthy VPN', async () => {
 const {ext,calls}=fixture()
 const sample=ext.core.getStatusLite
 ext.core.getStatusLite=async()=>{throw new Error('temporary read failure')}
 await ext.checkCoreHealth()
 ext.core.getStatusLite=sample
 await ext.checkCoreHealth()
 assert.equal(ext.stage,'running')
 assert.equal(ext.runtimeError,'')
 assert.deepEqual(calls,[])
})

test('unknown system inventory never proves VPN loss', async () => {
 const {ext,calls,setChannel}=fixture();setChannel('unknown');ext.missingVpnSince=Date.now()-10000
 await ext.checkCoreHealth();assert.deepEqual(calls,[]);assert.equal(ext.missingVpnSince,0)
})

test('another VPN is not taken over by automatic recovery', async () => {
 const {ext,calls,setChannel}=fixture();setChannel('foreign')
 await ext.checkCoreHealth();assert.deepEqual(calls,['stop']);assert.equal(ext.stage,'foreign-vpn');assert.equal(ext.runtimeState,'error')
})

test('actual stopped core can be restarted while preserving the saved selector', async () => {
 const {ext,calls,setCore,started}=fixture();setCore(false)
 await ext.checkCoreHealth();assert.ok(calls.includes('start'));assert.equal(JSON.parse(started()).outbounds[0].default,'fast')
})

test('manual stop during recovery wins before creating a new TUN', async () => {
 const {ext,calls,setChannel}=fixture();setChannel('absent');ext.stopRequested=true
 await ext.recoverRuntime('vpn');assert.deepEqual(calls,[])
})

test('SSID exclusion prevents repair from creating any proxy resources', async () => {
 const {ext,calls,exclude}=fixture();exclude(true)
 await ext.recoverRuntime('vpn');assert.deepEqual(calls,['stop','destroy']);assert.equal(ext.suspended,true)
})

test('automatic recovery has bounded retries and backoff instead of a restart loop', async () => {
 const {ext,calls}=fixture();ext.recoveryBudget={windowAt:Date.now(),attempts:3,retryAt:0}
 await ext.recoverRuntime('core');assert.equal(ext.stage,'recovery-cooldown');assert.ok(!calls.includes('new-vpn'))
 const first=nextRecoveryAttempt({windowAt:0,attempts:0,retryAt:0},1000)!
 assert.equal(first.retryAt,6000)
 assert.equal(nextRecoveryAttempt(first,2000),null)
 const second=nextRecoveryAttempt(first,6000)!
 assert.equal(second.retryAt,21000)
})

test('exhausted recovery stays supervised and retries after cooldown without opening UI', async () => {
 let now=200000
 const {ext,calls,setChannel,started}=fixture(()=>now);setChannel('absent')
 ext.recoveryBudget={windowAt:now,attempts:3,retryAt:0}
 await ext.recoverRuntime('vpn')
 assert.equal(ext.runtimeState,'running');assert.equal(ext.stage,'recovery-cooldown')
 assert.equal(ext.recoveryReason,'vpn');assert.equal(ext.recoveryBudget.retryAt,320000)
 assert.deepEqual(calls,[])
 now=319999;await ext.checkCoreHealth();assert.deepEqual(calls,[])
 now=320000;await ext.checkCoreHealth()
 assert.ok(calls.includes('start'));assert.equal(ext.stage,'running')
 assert.equal(ext.recoveryReason,'');assert.equal(JSON.parse(started()).outbounds[0].default,'fast')
})

test('no validated underlay consumes no recovery attempts or core allocations, then resumes', async () => {
 let now=200000
 const {ext,calls,underlay}=fixture(()=>now);underlay('none')
 await ext.recoverRuntime('network')
 assert.equal(ext.stage,'recovery-network-wait');assert.equal(ext.runtimeState,'running')
 assert.equal(ext.networkRecoveryBudget.attempts,0);assert.deepEqual(calls,[])
 now+=5000;underlay('stable');await ext.checkCoreHealth()
 assert.ok(calls.includes('start'));assert.equal(ext.stage,'running')
})

test('manual stop and excluded SSID still win during cooldown; foreign VPN stays untouched', async () => {
 let now=200000
 const f=fixture(()=>now)
 f.ext.networkRecoveryBudget={windowAt:now,attempts:3,retryAt:0}
 await f.ext.recoverRuntime('network');f.exclude(true)
 await f.ext.checkCoreHealth();assert.equal(f.ext.stage,'ssid-suspended')
 assert.ok(!f.calls.includes('start'))
 const stopped=fixture(()=>now);stopped.ext.recoveryReason='vpn';stopped.ext.stopRequested=true
 now+=180000;await stopped.ext.checkCoreHealth();assert.deepEqual(stopped.calls,[])
 const foreign=fixture(()=>now);foreign.setChannel('foreign');foreign.ext.recoveryReason='vpn'
 await foreign.ext.checkCoreHealth();assert.equal(foreign.ext.stage,'foreign-vpn')
 assert.ok(!foreign.calls.includes('new-vpn'))
})
