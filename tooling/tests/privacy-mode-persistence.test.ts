import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareLocalConfig } from '../../entry/src/main/ets/domain/LocalConfig.ts'
import { applyChoices, recordChoice, emptyChoices } from '../../entry/src/main/ets/domain/RuntimeChoices.ts'
const source=JSON.stringify({inbounds:[{type:'tun',tag:'tun'}],outbounds:[{type:'socks',tag:'proxy',server:'127.0.0.1',server_port:1080},{type:'direct',tag:'direct'}],experimental:{clash_api:{default_mode:'Rule'}},route:{final:'proxy',rules:[{type:'logical',mode:'or',rules:[{clash_mode:'Global'}],outbound:'proxy'},{clash_mode:'Direct',outbound:'direct'}]}})
for(const [saved,expected] of [['rule','Rule'],['global','Global'],['direct','Direct']])test('saved '+saved+' keeps imported mode spelling '+expected,()=>{
 const runtime=prepareLocalConfig(source,{ipv6Enabled:true,protectWebRtc:true,strictWebRtc:true})
 const restored=JSON.parse(applyChoices(runtime,{profileId:'custom',mode:saved,groups:[]}))
 assert.equal(restored.experimental.clash_api.default_mode,expected)
 if(saved!=='direct')assert.ok(restored.route.rules.some((r:any)=>r.protocol==='stun'&&r.action==='reject'&&r.clash_mode===expected),'restored mode must match privacy rule')
 assert.equal(JSON.parse(source).experimental.clash_api.default_mode,'Rule')
})
test('mode values returned by capitalized profiles persist canonically and restore to their actual rule',()=>{
 for(const selected of ['Rule','Global','Direct']){
  const saved=recordChoice(emptyChoices('custom'),{action:'mode',mode:selected})
  assert.equal(saved.mode,selected.toLowerCase())
  const runtime=prepareLocalConfig(source,{ipv6Enabled:true,protectWebRtc:true,strictWebRtc:true})
  const restored=JSON.parse(applyChoices(runtime,saved))
  assert.equal(restored.experimental.clash_api.default_mode,selected)
 }
})
