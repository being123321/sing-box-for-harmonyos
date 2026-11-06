import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {stripTypeScriptTypes} from 'node:module'
import vm from 'node:vm'

function fixture() {
 const source=readFileSync(new URL('../../entry/src/main/ets/vpnextension/NetworkVpnExtAbility.ets',import.meta.url),'utf8')
  .replace(/import[\s\S]*?from '[^']+'\r?\n/g,'').replace('export default class NetworkVpnExtAbility','class NetworkVpnExtAbility')
 let foreground=false, samples=0, writes=0
 const C=vm.runInNewContext(stripTypeScriptTypes(source)+'\nNetworkVpnExtAbility',{
  CoreGateway:class{},VpnExtensionAbility:class{},Date,Map,
  nativeCore:{tailscaleStatus:async()=>{samples++;return '{"endpoints":[]}'}},hilog:{error(){}}
 })
 const ext=new C()
 Object.assign(ext,{sessionId:'session',tailscaleBridge:{writeStatus:async()=>{writes++}},uiActive:()=>foreground})
 return {ext,show:()=>{foreground=true},hide:()=>{foreground=false},counts:()=>({samples,writes})}
}

test('background UI snapshots cause no Tailscale native calls or writes; foreground resumes',async()=>{
 const f=fixture()
 await f.ext.publishTailscaleStatus();await f.ext.publishTailscaleStatus()
 assert.deepEqual(f.counts(),{samples:0,writes:0})
 f.show();await f.ext.publishTailscaleStatus()
 assert.deepEqual(f.counts(),{samples:1,writes:1})
 f.hide();await f.ext.publishTailscaleStatus()
 assert.deepEqual(f.counts(),{samples:1,writes:1})
})

test('stopped extension and in-flight snapshot never start another native status request',async()=>{
 const f=fixture();f.show();f.ext.tailscaleStatusBusy=true
 await f.ext.publishTailscaleStatus();assert.equal(f.counts().samples,0)
 f.ext.tailscaleStatusBusy=false;f.ext.stopRequested=true
 await f.ext.publishTailscaleStatus();assert.equal(f.counts().samples,0)
})
