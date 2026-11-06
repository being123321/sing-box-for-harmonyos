import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { isStaleCurrentRuntimeSession, isRuntimeStatusFresh, isConfirmedRuntimeStop, isSystemLifecycleStopped, VPN_SYSTEM_LIFECYCLE_STOPPED_STAGE } from '../../entry/src/main/ets/services/VpnRuntimeProtocol.ts'

function fixture(){
 let absent=true;let command:any=null;let stopped=0
 const status:any={protocolGeneration:'v3',revision:5,sessionId:'old',state:'running',stage:'running',updatedAt:Date.now()-40000,version:'1.14.4',error:'',uploadBytes:1,downloadBytes:2,activeConnections:0,selectedOutboundTag:'proxy'}
 const source=readFileSync(new URL('../../entry/src/main/ets/services/ConnectionCoordinator.ts',import.meta.url),'utf8').replace(/import[\s\S]*?from '[^']+'\r?\n/g,'').replace(/export /g,'')
 const ctx=vm.createContext({Date,isStaleCurrentRuntimeSession,isRuntimeStatusFresh,isConfirmedRuntimeStop,isSystemLifecycleStopped,VPN_SYSTEM_LIFECYCLE_STOPPED_STAGE,vpnExtension:{stopVpnExtensionAbility:async()=>{throw new Error('already gone')}},bundleManager:{getBundleInfoForSelfSync:()=>({name:'test'}),BundleFlag:{GET_BUNDLE_INFO_DEFAULT:0}},waitForSystemVpnBearerAbsent:async()=>absent})
 const C=vm.runInContext(stripTypeScriptTypes(source)+'\nConnectionCoordinator',ctx)
 const coordinator=Object.create(C.prototype)
 coordinator.disconnectTask=null;coordinator.activeSessionId='old';coordinator.recoverActiveSession=async()=>{}
 coordinator.runtimeBridge={loadStatus:async()=>status,loadLatestStatus:async()=>status,loadCommand:async()=>command,publishStatus:async()=>{}}
 coordinator.configStore={loadProfileId:async()=>'profile'}
 coordinator.disconnect=async()=>{stopped++}
 return{coordinator,status,setPresent:()=>{absent=false},setStop:(automatic=false)=>{command={type:'stop',nodeTag:automatic?'foreground-recovery':''}},stops:()=>stopped}
}

test('foreground recovery requires stale matching session and proved missing VPN',async()=>{
 const{coordinator,stops}=fixture()
 assert.equal(await coordinator.recoverOrphanedSession('profile'),true)
 assert.equal(stops(),1)
})

test('unexpected Extension cleanup remains recoverable after getStatus clears the active session',async()=>{
 const f=fixture();f.status.state='stopped';f.status.stage=VPN_SYSTEM_LIFECYCLE_STOPPED_STAGE
 f.status.updatedAt=Date.now();f.coordinator.activeSessionId=''
 assert.equal(await f.coordinator.recoverOrphanedSession('profile'),true)
 assert.equal(f.stops(),0)
})

test('automatic recovery stop can be retried but a user stop still cannot reconnect',async()=>{
 const f=fixture();f.setStop(true)
 assert.equal(await f.coordinator.recoverOrphanedSession('profile'),true)
 const manual=fixture();manual.setStop()
 assert.equal(await manual.coordinator.recoverOrphanedSession('profile'),false)
})

test('cleanup acknowledgement can finalize an already destroyed Extension only with absent VPN',async()=>{
 const f=fixture();f.status.state='stopped'
 await f.coordinator.finishAcknowledgedDisconnect(f.status)
 assert.equal(f.coordinator.activeSessionId,'')
 const present=fixture();present.status.state='stopped';present.setPresent()
 await assert.rejects(present.coordinator.finishAcknowledgedDisconnect(present.status),/already gone/)
 assert.equal(present.coordinator.activeSessionId,'old')
})

test('background endpoint snapshots never dispatch a command while the VPN is unresponsive',async()=>{
 const f=fixture();let commands=0
 f.coordinator.tailscaleBridge={loadStatus:async()=>({sessionId:'old',statusJson:'{"endpoints":[]}',updatedAt:0})}
 f.coordinator.sendTailscaleCommand=async()=>{commands++;throw new Error('must not wait')}
 assert.equal((await f.coordinator.cachedTailscaleStatus()).endpoints.length,0)
 assert.equal(commands,0)
})

test('live VPN, short heartbeat delays, manual stop and changed profile prevent orphan restart',async()=>{
 const live=fixture();live.setPresent();assert.equal(await live.coordinator.recoverOrphanedSession('profile'),false)
 const delay=fixture();delay.status.updatedAt=Date.now()-12000;assert.equal(await delay.coordinator.recoverOrphanedSession('profile'),false)
 const stop=fixture();stop.setStop();assert.equal(await stop.coordinator.recoverOrphanedSession('profile'),false)
 const profile=fixture();assert.equal(await profile.coordinator.recoverOrphanedSession('different'),false)
 assert.equal(live.stops()+delay.stops()+stop.stops()+profile.stops(),0)
})
