import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareLocalConfig } from '../../entry/src/main/ets/domain/LocalConfig.ts'
import { applyChoices, recordChoice, emptyChoices, resolveClashModeSpelling } from '../../entry/src/main/ets/domain/RuntimeChoices.ts'
const source=JSON.stringify({inbounds:[{type:'tun',tag:'tun'}],outbounds:[{type:'socks',tag:'proxy',server:'127.0.0.1',server_port:1080},{type:'direct',tag:'direct'}],experimental:{clash_api:{default_mode:'Rule'}},route:{final:'proxy',rules:[{type:'logical',mode:'or',rules:[{clash_mode:'Global'}],outbound:'proxy'},{clash_mode:'Direct',outbound:'direct'}]}})
for(const saved of ['rule','global','direct'])test('saved '+saved+' never rewrites the imported default_mode',()=>{
  const runtime=prepareLocalConfig(source,{ipv6Enabled:true,protectWebRtc:true,strictWebRtc:true})
  const restored=JSON.parse(applyChoices(runtime,{profileId:'custom',mode:saved,groups:[]}))
  // The core derives its mode list from routing/DNS clash_mode values plus
  // default_mode. Overwriting default_mode with a remembered "direct"/"global"
  // dropped the original "Rule" entry after a restart (the Rule button
  // disappeared). applyChoices must leave the imported default_mode alone; the
  // Extension restores the remembered mode via core.control after start.
  assert.equal(restored.experimental.clash_api.default_mode,'Rule')
  assert.equal(resolveClashModeSpelling(runtime,saved) !== '' ,true,'remembered mode still resolves against the imported rules')
  assert.equal(JSON.parse(source).experimental.clash_api.default_mode,'Rule')
})
test('mode values returned by capitalized profiles persist canonically and resolve to their actual rule',()=>{
  for(const selected of ['Rule','Global','Direct']){
    const saved=recordChoice(emptyChoices('custom'),{action:'mode',mode:selected})
    assert.equal(saved.mode,selected.toLowerCase())
    const runtime=prepareLocalConfig(source,{ipv6Enabled:true,protectWebRtc:true,strictWebRtc:true})
    const restored=JSON.parse(applyChoices(runtime,saved))
    assert.equal(restored.experimental.clash_api.default_mode,'Rule','imported default_mode is preserved')
    assert.equal(resolveClashModeSpelling(runtime,saved.mode),selected,'runtime control restores the saved spelling')
  }
})
