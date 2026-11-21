import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { isStaleCurrentRuntimeSession, isRuntimeStatusFresh, isConfirmedRuntimeStop, isSystemLifecycleStopped, VPN_SYSTEM_LIFECYCLE_STOPPED_STAGE } from '../../entry/src/main/ets/services/VpnRuntimeProtocol.ts'

function fixture(){
 let absent=true
 const status:any={protocolGeneration:'v3',revision:5,sessionId:'old',state:'running',stage:'running',updatedAt:Date.now()-40000,version:'1.14.4',error:'',uploadBytes:1,downloadBytes:2,activeConnections:0,selectedOutboundTag:'proxy'}
 const source=readFileSync(new URL('../../entry/src/main/ets/services/ConnectionCoordinator.ts',import.meta.url),'utf8').replace(/import[\s\S]*?from '[^']+'\r?\n/g,'').replace(/export /g,'')
 const ctx=vm.createContext({Date,isStaleCurrentRuntimeSession,isRuntimeStatusFresh,isConfirmedRuntimeStop,isSystemLifecycleStopped,VPN_SYSTEM_LIFECYCLE_STOPPED_STAGE,vpnExtension:{stopVpnExtensionAbility:async()=>{throw new Error('already gone')}},bundleManager:{getBundleInfoForSelfSync:()=>({name:'test'}),BundleFlag:{GET_BUNDLE_INFO_DEFAULT:0}},waitForSystemVpnBearerAbsent:async()=>absent})
 const C=vm.runInContext(stripTypeScriptTypes(source)+'\nConnectionCoordinator',ctx)
 const coordinator=Object.create(C.prototype)
 coordinator.disconnectTask=null;coordinator.activeSessionId='old';coordinator.recoverActiveSession=async()=>{}
 coordinator.runtimeBridge={loadStatus:async()=>status,loadLatestStatus:async()=>status,publishStatus:async()=>{}}
 return { coordinator, status, setPresent: () => { absent = false } }
}

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
