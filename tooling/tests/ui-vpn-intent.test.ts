import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

function fixture() {
 const source=readFileSync(new URL('../../entry/src/main/ets/pages/SfaIndex.ets',import.meta.url),'utf8')
 function method(name:string,next:string){return source.slice(source.indexOf('  private '+name),source.indexOf('  private '+next))}
 const methods=method('setVpnIntent(', 'applyStatus(')+method('applyStatus(', 'openGroups(')+method('async toggleService(', 'async connectProfile(')
 const C=vm.runInNewContext(stripTypeScriptTypes('class UI {\n'+methods+'\n}\nUI'),{Date,Map})
 const ui=Object.create(C.prototype);const writes:boolean[]=[]
 Object.assign(ui,{choices:{reset:()=>{}},choiceSession:'',vpnIntent:true,ready:true,busy:false,phase:'running',commandEpoch:0,startedAt:1,
  prefs:{putSync:(_:string,value:boolean)=>writes.push(value),flush:async()=>{}},
  coordinator:{disconnect:async()=>{throw new Error('stop pending')}},toast:()=>{}})
 return{ui,writes}
}

test('unexpected stopped runtime retains connection intent across process recreation',()=>{
 const{ui,writes}=fixture()
 ui.applyStatus({running:false,uploadBytes:0,downloadBytes:0,activeConnections:0,lastError:''})
 assert.equal(ui.vpnIntent,true);assert.equal(writes.length,0);assert.equal(ui.phase,'stopped')
})

test('explicit stop persists user intent before a failed asynchronous disconnect',async()=>{
 const{ui,writes}=fixture();await ui.toggleService()
 assert.equal(ui.vpnIntent,false);assert.deepEqual(writes,[false]);assert.equal(ui.phase,'error')
})
