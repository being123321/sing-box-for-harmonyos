import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

function fixture() {
 let nets: number[] = [17]
 let fail = false
 let ownAddress = true
 const addresses = new Map<number,string[]>()
 const source = readFileSync(new URL('../../entry/src/main/ets/services/VpnChannelProbe.ts',import.meta.url),'utf8')
  .replace(/import[^\n]+\r?\n/g,'').replace(/export /g,'')
 const ctx = vm.createContext({connection:{NetBearType:{BEARER_VPN:4},getAllNets:async()=>nets.map(netId=>({netId})),
  getNetCapabilities:async()=>{if(fail)throw new Error('inventory failed');return{bearerTypes:[4]}},
  getConnectionProperties:async(handle:{netId:number})=>({linkAddresses:(addresses.get(handle.netId) ?? [ownAddress?'172.19.0.1':'10.8.0.1']).map(address=>({address:{address}}))})}})
 const probe = vm.runInContext(stripTypeScriptTypes(source)+'\nprobeVpnChannel',ctx)
 return{probe,setNets:(value:number[])=>{nets=value},setFail:()=>{fail=true},foreign:()=>{ownAddress=false},setAddresses:(netId:number,value:string[])=>addresses.set(netId,value)}
}

test('known netId and address establish ownership; another ID or quarantine stays unresolved',async()=>{
 const{probe}=fixture()
 assert.equal((await probe(17)).state,'owned')
 assert.equal((await probe(18)).state,'unknown')
 assert.equal((await probe(-2)).state,'unknown','recovery gap must not rediscover or reject a tunnel from its shared address')
 assert.equal((await probe(-1)).state,'owned','explicit discovery remains limited to the caller after successful TUN creation')
})

test('a changed handle cannot be adopted, then absence or the old handle can be confirmed',async()=>{
 const{probe,setNets}=fixture();setNets([18])
 const changed=await probe(17)
 assert.equal(changed.state,'unknown');assert.equal(changed.netId,-1,'do not publish the unverified new ID')
 setNets([]);assert.equal((await probe(17)).state,'absent')
 setNets([17]);assert.equal((await probe(17)).state,'owned')
})

test('empty or not-yet-assigned link addresses remain unknown until ready',async()=>{
 const{probe,setAddresses}=fixture()
 for(const values of [[],[''],['0.0.0.0','::']]) {
  setAddresses(17,values)
  assert.equal((await probe(17)).state,'unknown')
  assert.equal((await probe(-2)).state,'unknown')
 }
 setAddresses(17,['fdfe:dcba:9876::1']);assert.equal((await probe(17)).state,'owned')
})

test('incomplete inventory and simultaneous VPNs are unknown rather than proof of loss',async()=>{
 const{probe,setNets,setFail}=fixture();setNets([17,18])
 assert.equal((await probe(17)).state,'unknown')
 setFail();assert.equal((await probe(17)).state,'unknown')
})

test('mixed simultaneous VPNs do not authorize takeover or prove a foreign-only inventory',async()=>{
 const{probe,setNets,setAddresses}=fixture();setNets([17,18]);setAddresses(18,['10.8.0.1'])
 assert.equal((await probe(17)).state,'unknown')
 assert.equal((await probe(-2)).state,'unknown')
 setAddresses(17,[]);assert.equal((await probe(17)).state,'unknown')
})

test('complete empty inventory proves absence; foreign address cannot be adopted',async()=>{
 const{probe,setNets,foreign}=fixture();setNets([])
 assert.equal((await probe(17)).state,'absent')
 setNets([17]);foreign()
 for(const ownedId of [17,-1,-2]) assert.equal((await probe(ownedId)).state,'foreign')
 setNets([17,18]);assert.equal((await probe(17)).state,'foreign','multiple definitely foreign addresses remain foreign')
})
