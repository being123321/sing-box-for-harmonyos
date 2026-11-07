import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { nextRecoveryAttempt } from '../../entry/src/main/ets/domain/VpnRecoveryPolicy.ts'
import { applyChoices, emptyChoices, resolveClashModeSpelling } from '../../entry/src/main/ets/domain/RuntimeChoices.ts'
import { telemetryInterval } from '../../entry/src/main/ets/domain/RuntimeActivity.ts'
import { classifyUnderlayTransition } from '../../entry/src/main/ets/domain/UnderlayTransition.ts'
import { normalizeSsidPolicy, shouldSuspendSsid } from '../../entry/src/main/ets/domain/SsidPolicy.ts'

function fixture(now: () => number = () => Date.now()) {
 let channel = 'owned'
 let nativeRunning = true
 let excluded: boolean | null = false
 let underlay = JSON.stringify({id:10,kind:'cellular',interface:'rmnet0',addresses:['2001:db8::2/64'],dns:['1.1.1.1']})
 const calls: string[] = []
 let started = ''
 const networkHandlers = new Map<string, (value: any) => void>()
 const monitor = {on:(type: string, callback: (value: any) => void)=>networkHandlers.set(type, callback),
  register:(callback: (error: null) => void)=>callback(null),unregister:()=>{}}
 const source = readFileSync(new URL('../../entry/src/main/ets/vpnextension/NetworkVpnExtAbility.ets', import.meta.url),'utf8')
  .replace(/import[\s\S]*?from '[^']+'\r?\n/g,'').replace('export default class NetworkVpnExtAbility','class NetworkVpnExtAbility')
 const context = vm.createContext({ CoreGateway: class {}, VpnExtensionAbility: class { context = { filesDir: '/private', cacheDir: '/cache' } },
  VPN_RUNTIME_PROTOCOL_CURRENT: 'v3', Date: class extends Date { static now() { return now() } }, JSON, setTimeout, clearTimeout, setInterval, clearInterval, nextRecoveryAttempt, applyChoices, resolveClashModeSpelling, telemetryInterval, classifyUnderlayTransition, normalizeSsidPolicy, shouldSuspendSsid,
  connection:{createNetConnection:(...args: unknown[])=>{calls.push('observe-default:'+args.length);return monitor}},
  wifiManager:{on(){},off(){}},
  probeVpnChannel: async () => ({ state: channel, netId: channel === 'owned' ? 17 : -1 }), physicalNetworkSignature: async () => underlay,
  vpnExtension: { createVpnConnection: () => { calls.push('new-vpn'); return { protectProcessNet: async () => calls.push('protect'),
   create: async () => { calls.push('create'); channel='owned'; return 42 }, destroy: async () => calls.push('destroy') } } },
  hilog: { warn() {}, error() {}, info() {} }
 })
 const Ext = vm.runInContext(stripTypeScriptTypes(source)+'\nNetworkVpnExtAbility',context)
 const ext = new Ext()
 const readSsid = ext.requestedSsidSuspension.bind(ext)
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
 return {ext,calls,context,readSsid,started:() => started,setChannel:(s: string)=>{channel=s},setCore:(value: boolean)=>{nativeRunning=value},exclude:(value: boolean|null)=>{excluded=value},underlay:(value: string)=>{underlay=value},emit:(type: string,value: unknown)=>networkHandlers.get(type)?.(value)}
}

test('unknown VPN probe never adopts ownership from a cached netId',async()=>{
 const {ext,setChannel,calls}=fixture();setChannel('unknown');ext.ownedVpnId=17
 assert.equal(await ext.superviseVpnChannel(),false)
 assert.equal(ext.ownedVpnId,17);assert.equal(ext.missingVpnSince,0)
 assert.deepEqual(calls,[])
})

test('confirmed excluded SSID closes the service and TUN before publishing suspension',async()=>{
 const {ext,calls,exclude}=fixture();exclude(true)
 const publish=ext.publishSsidSuspension.bind(ext)
 ext.publishSsidSuspension=async()=>{calls.push('publish-suspended');await publish()}
 await ext.checkCoreHealth()
 assert.ok(calls.indexOf('stop')>=0);assert.ok(calls.indexOf('destroy')>calls.indexOf('stop'))
 assert.ok(calls.indexOf('publish-suspended')>calls.indexOf('destroy'))
 assert.equal(ext.suspended,true);assert.equal(ext.tunFd,-1);assert.equal(ext.coreStarted,false)
})

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

test('DNS changes and IPv4 handoffs retain the lightweight network reset', async () => {
 for (const ipv6 of [true,false]) {
  const {ext,calls,underlay}=fixture()
  ext.readIpv6Enabled=()=>ipv6
  ext.lastNetworkSignature=JSON.stringify({kind:'wifi',interface:'vendor0',id:10});ext.networkChangePending=true
  underlay(JSON.stringify(ipv6 ? {kind:'wifi',interface:'vendor0',id:10,dns:['1.1.1.1']} : {kind:'cellular',interface:'vendor1',id:11}))
  const controls:string[]=[];ext.core.control=async(payload:string)=>{controls.push(JSON.parse(payload).action)}
  await ext.checkCoreHealth()
  assert.deepEqual(controls,['network-change']);assert.ok(!calls.includes('stop'));assert.ok(!calls.includes('start'))
 }
})

test('returning to the same cellular identity after a validation gap resets stale sockets once', async () => {
 const {ext,calls,underlay}=fixture()
 const signature=JSON.stringify({kind:'cellular',interface:'rmnet0',id:10,addresses:['2001:db8::2/64']})
 ext.lastNetworkSignature=signature;ext.networkChangePending=true
 underlay('none');await ext.checkCoreHealth()
 assert.equal(ext.underlayGapPending,true);assert.deepEqual(calls,[])
 underlay(signature);await ext.checkCoreHealth()
 assert.deepEqual(calls,['control']);assert.equal(ext.underlayGapPending,false)
 ext.networkChangePending=true;await ext.checkCoreHealth()
 assert.deepEqual(calls,['control']);assert.equal(ext.networkChangePending,false)
})

test('same-kind default SIM replacement rebuilds IPv6 TUN and preserves manual selection', async () => {
 const {ext,calls,underlay,started}=fixture()
 ext.lastNetworkSignature=JSON.stringify({kind:'cellular',interface:'rmnet0',id:10})
 underlay(JSON.stringify({kind:'cellular',interface:'rmnet1',id:11}));ext.networkChangePending=true
 await ext.checkCoreHealth()
 assert.ok(calls.includes('stop'));assert.ok(calls.includes('create'));assert.ok(calls.includes('start'))
 assert.equal(JSON.parse(started()).outbounds[0].default,'fast')
 assert.equal(ext.underlayGapPending,false)
})

test('default-network observer remembers a fast loss before the debounced snapshot', async () => {
 const {ext,calls,underlay,emit}=fixture()
 underlay(JSON.stringify({kind:'cellular',interface:'rmnet0',id:10}))
 await ext.startNetworkObservers()
 assert.deepEqual(calls,['observe-default:0']);calls.length=0
 emit('netLost',{netId:99});assert.equal(ext.underlayGapPending,false)
 emit('netLost',{netId:10});assert.equal(ext.underlayGapPending,true)
 ext.stopNetworkObservers()
 await ext.checkCoreHealth()
 assert.deepEqual(calls,['control']);assert.equal(ext.underlayGapPending,false)
})

test('a newer network callback during socket reset remains pending', async () => {
 const {ext,underlay}=fixture()
 const signature=JSON.stringify({kind:'cellular',interface:'rmnet0',id:10})
 ext.lastNetworkSignature=signature;ext.underlayGapPending=true;ext.networkChangePending=true
 underlay(signature)
 ext.core.control=async()=>{ext.networkRevision++}
 await ext.checkCoreHealth()
 assert.equal(ext.networkChangePending,true)
 assert.equal(ext.underlayGapPending,true)
})

test('manual stop during the real underlay read prevents the pending network action',async()=>{
 for(const ipv6 of [true,false]) {
  const {ext,calls,context}=fixture()
  ext.readIpv6Enabled=()=>ipv6
  ext.lastNetworkSignature=JSON.stringify({kind:'cellular',interface:'rmnet0',id:10})
  ext.networkChangePending=true
  context.physicalNetworkSignature=async()=>{ext.stopRequested=true;return JSON.stringify({kind:'cellular',interface:'rmnet1',id:11})}
  await ext.checkCoreHealth()
  assert.deepEqual(calls,[])
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
 now+=5000;underlay(JSON.stringify({id:10,kind:'cellular',interface:'rmnet0'}));await ext.checkCoreHealth()
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

test('DNS settling before or after start keeps the new tunnel and saved node',async()=>{
 const base={id:10,kind:'cellular',interface:'rmnet0',addresses:['2001:db8::2/64'],dns:['1.1.1.1']}
 for(const afterStart of [false,true]) {
  const {ext,calls,context,started,setCore}=fixture()
  const first=JSON.stringify(base),second=JSON.stringify({...base,dns:['8.8.8.8']})
  const signatures=afterStart?[first,first,second]:[first,second,second]
  context.physicalNetworkSignature=async()=>signatures.shift()||second
  ext.suspended=true;ext.coreStarted=false;ext.tunFd=-1;ext.vpnConnection=null;setCore(false)
  const actions:string[]=[];ext.core.control=async(payload:string)=>{actions.push(JSON.parse(payload).action)}
  await ext.activateSavedService()
  assert.ok(calls.includes('start'));assert.ok(!calls.includes('stop'));assert.ok(!calls.includes('destroy'))
  assert.equal(ext.stage,'running');assert.equal(ext.suspended,false);assert.equal(ext.lastNetworkSignature,second)
  assert.equal(JSON.parse(started()).outbounds[0].default,'fast')
  assert.equal(actions.includes('network-change'),afterStart)
 }
})

test('real identity change during startup waits safely without being labelled SSID suspension',async()=>{
 const {ext,calls,context}=fixture()
 const first=JSON.stringify({id:10,kind:'cellular',interface:'rmnet0',addresses:['2001:db8::2/64']})
 const second=JSON.stringify({id:11,kind:'cellular',interface:'rmnet1',addresses:['2001:db8:1::2/64']})
 const signatures=[first,second]
 context.physicalNetworkSignature=async()=>signatures.shift()||second
 ext.suspended=true;ext.coreStarted=false;ext.tunFd=-1;ext.vpnConnection=null
 await ext.activateSavedService()
 assert.ok(!calls.includes('start'));assert.ok(calls.includes('destroy'));assert.equal(ext.tunFd,-1)
 assert.equal(ext.stage,'recovery-network-wait');assert.equal(ext.recoveryReason,'network')
 assert.equal(JSON.parse(ext.runtimeSnapshotJson).suspended,false)
})

test('repeated normal network deferrals never exhaust native failure budget',async()=>{
 let now=200000,reads=0
 const {ext,context,calls,setChannel}=fixture(()=>now)
 context.physicalNetworkSignature=async()=>JSON.stringify({id:10+Math.floor(++reads/3),kind:'cellular',interface:'rmnet0'})
 for(let index=0;index<6;index++) {
  setChannel('absent');await ext.recoverRuntime('network')
  assert.equal(ext.networkRecoveryBudget.attempts,0);assert.equal(ext.stage,'recovery-network-wait')
  assert.equal(ext.recoveryReason,'network');now+=1001
 }
 assert.ok(!calls.includes('start'));assert.equal(calls.filter(value=>value==='new-vpn').length,6)
})

test('actual native startup failures still back off and stop after three attempts',async()=>{
 let now=200000
 const {ext,setChannel,calls}=fixture(()=>now)
 ext.core.start=async()=>{calls.push('failed-start');throw new Error('native start failed')}
 for(let attempt=1;attempt<=3;attempt++) {
  setChannel('absent');await ext.recoverRuntime('network')
  assert.equal(ext.networkRecoveryBudget.attempts,attempt);assert.equal(ext.stage,'recovery-wait')
  now=ext.networkRecoveryBudget.retryAt
 }
 await ext.recoverRuntime('network')
 assert.equal(ext.stage,'recovery-cooldown');assert.equal(calls.filter(value=>value==='failed-start').length,3)
})

test('unknown policy before teardown preserves existing VPN and spends no failure attempts',async()=>{
 let now=200000
 const {ext,calls,exclude}=fixture(()=>now);exclude(null)
 await ext.recoverRuntime('network')
 assert.deepEqual(calls,[]);assert.equal(ext.coreStarted,true);assert.equal(ext.tunFd,41)
 assert.equal(ext.stage,'recovery-policy-wait');assert.equal(ext.networkRecoveryBudget.attempts,0)
 now+=1001;exclude(false);await ext.checkCoreHealth()
 assert.ok(calls.includes('start'));assert.equal(ext.stage,'running')
})

test('policy becoming unknown inside activation is a recovery wait, not an SSID hit',async()=>{
 const {ext,exclude}=fixture();exclude(null)
 assert.equal(await ext.holdIfPolicyChanged(),true)
 assert.equal(ext.stage,'recovery-policy-wait');assert.equal(ext.recoveryReason,'network')
 assert.equal(JSON.parse(ext.runtimeSnapshotJson).suspended,false)
})

test('a network event wakes normal waiting promptly but never removes real failure backoff',()=>{
 const {ext}=fixture()
 ext.recoveryReason='network';ext.stage='recovery-network-wait'
 ext.networkRecoveryBudget={windowAt:0,attempts:0,retryAt:Date.now()+60000}
 ext.queueNetworkChange();ext.stopNetworkObservers()
 assert.ok(ext.networkRecoveryBudget.retryAt<=Date.now()+200)
 const backoff=Date.now()+60000
 ext.stage='recovery-wait';ext.networkRecoveryBudget={windowAt:Date.now(),attempts:2,retryAt:backoff}
 ext.queueNetworkChange();ext.stopNetworkObservers();assert.equal(ext.networkRecoveryBudget.retryAt,backoff)
})

test('missed default-network events are detected by bounded underlay polling',async()=>{
 const {ext,underlay,calls}=fixture()
 ext.lastNetworkSignature=JSON.stringify({id:10,kind:'cellular',interface:'rmnet0'})
 underlay(JSON.stringify({id:11,kind:'cellular',interface:'rmnet1'}))
 ext.lastUnderlayCheckAt=0;ext.networkEventsReady=false;ext.networkChangePending=false
 await ext.checkCoreHealth()
 assert.ok(calls.includes('start'));assert.equal(ext.stage,'running')
})

test('a suspended SSID session also observes default-network fallback and resumes',async()=>{
 const {ext,underlay,calls}=fixture()
 ext.suspended=true;ext.coreStarted=false;ext.tunFd=-1;ext.vpnConnection=null
 ext.lastNetworkSignature=JSON.stringify({id:10,kind:'wifi',interface:'wlan0'})
 ext.networkChangePending=true;ext.lastUnderlayCheckAt=0;ext.lastSsidCheck=Date.now()
 ext.networkEventsReady=true;ext.wifiEventsReady=true;ext.policyWatcher={}
 underlay(JSON.stringify({id:11,kind:'cellular',interface:'rmnet0'}))
 await ext.checkCoreHealth()
 assert.ok(calls.includes('start'));assert.equal(ext.suspended,false)
})

test('SSID policy follows active data bearer and rejects a stale Wi-Fi association',async()=>{
 const {ext,context,readSsid,underlay}=fixture()
 context.fileIo={access:async()=>true,readTextSync:()=>JSON.stringify({enabled:true,excluded:['Excluded WiFi'],direct:[],proxy:[],fallback:'keep'})}
 let active=false
 context.wifiManager={isWifiActive:()=>active,getLinkedInfo:async()=>({connState:1,ssid:'Excluded WiFi'}),ConnState:{CONNECTED:1}}
 ext.ssidDirectRequested=true
 assert.equal(await readSsid(),false);assert.equal(ext.ssidDirectRequested,false)
 active=true;underlay(JSON.stringify({id:10,kind:'cellular',interface:'rmnet0'}))
 assert.equal(await readSsid(),false)
 underlay(JSON.stringify({id:11,kind:'wifi',interface:'wlan0'}));assert.equal(await readSsid(),true)
 context.wifiManager.getLinkedInfo=async()=>{underlay(JSON.stringify({id:10,kind:'cellular',interface:'rmnet0'}));return{connState:1,ssid:'Excluded WiFi'}}
 assert.equal(await readSsid(),false)
})

test('disabled Wi-Fi bypasses irrelevant unreadable or legacy SSID policy data',async()=>{
 const {context,readSsid}=fixture()
 context.wifiManager={isWifiActive:()=>false}
 context.fileIo={access:async()=>{throw new Error('policy read failed')}}
 assert.equal(await readSsid(),false)
 context.fileIo={access:async()=>true,readTextSync:()=>'{"enabled":true}'}
 assert.equal(await readSsid(),false)
})

test('manual stop during ownership or policy reads cannot publish running recovery again',async()=>{
 for(const kind of ['owner','policy']) {
  const {ext,context}=fixture()
  const stopped=()=>{ext.stopRequested=true;ext.runtimeState='stopped'}
  if(kind==='owner')context.probeVpnChannel=async()=>{stopped();return{state:'unknown',netId:-1}}
  else ext.requestedSsidSuspension=async()=>{stopped();return null}
  await assert.rejects(ext.recoverRuntime('network'),/cancelled/)
  assert.equal(ext.runtimeState,'stopped')
 }
})

test('cold startup with unknown policy waits without TUN, then recovers without reopening UI',async()=>{
 let now=200000
 const {ext,calls,context,exclude,setChannel,setCore}=fixture(()=>now)
 const config=ext.resumeConfig
 context.VpnRuntimeConfigStore=class {loadProfileId=async()=> 'profile';load=async()=>config;loadApplicationScope=async()=>({mode:'all',trustedApplications:[]})}
 context.RuntimeChoicesStore=class {load=async()=>({profileId:'profile',mode:'global',groups:[{group:'proxy',outbound:'fast'}]})}
 ext.loadRuntimeSession=async()=>{ext.runtimeState='starting'}
 ext.coreStarted=false;ext.coreInitialized=false;ext.tunFd=-1;setCore(false);setChannel('absent');exclude(null)
 await ext.startLifecycle()
 assert.equal(ext.stage,'recovery-policy-wait');assert.equal(ext.runtimeState,'running');assert.equal(ext.tunFd,-1)
 assert.deepEqual(calls,[]);assert.equal(ext.recoveryReason,'network')
 now+=1001;exclude(false);await ext.checkCoreHealth()
 assert.ok(calls.includes('start'));assert.equal(ext.stage,'running');assert.equal(ext.suspended,false)
})
