import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {stripTypeScriptTypes} from 'node:module'
import vm from 'node:vm'
import {normalizeSsidPolicy, withSsidRule} from '../../entry/src/main/ets/domain/SsidPolicy.ts'

function fixture() {
  const source = readFileSync(new URL('../../entry/src/main/ets/pages/SfaIndex.ets',import.meta.url),'utf8')
  const methods = source.slice(source.indexOf('  private openSsidEditor('),source.indexOf('  private toggleSsidSelection(')) +
    source.slice(source.indexOf('  private async addExcludedSsid('),source.indexOf('  @Builder\n  ssidEditor('))
  const Editor = vm.runInNewContext(stripTypeScriptTypes('class Editor {'+methods+'}\nEditor'), {normalizeSsidPolicy,withSsidRule})
  const editor = new Editor()
  Object.assign(editor,{excludedSsids:['Home','Work'],ssidActions:[{ssid:'Home',action:'direct'},{ssid:'Work',action:'suspend'}]})
  editor.toast = () => {}
  editor.saveSsidPolicy = async () => {}
  return editor
}

test('editing one SSID initializes its own action and preserves all other rules when saved', async () => {
  const editor = fixture()
  editor.openSsidEditor('Work')
  assert.equal(editor.draftSsidAction,'suspend')
  editor.draftSsid = 'Office'; editor.draftSsidAction = 'direct'
  await editor.addExcludedSsid()
  assert.equal(editor.ssidRuleAction('Home'),'direct')
  assert.equal(editor.ssidRuleAction('Office'),'direct')
  assert.deepEqual(Array.from(editor.excludedSsids),['Home','Office'])
  assert.equal(editor.showSsidEditor,false)
})

test('save failure restores the original SSID and action and leaves the editor open', async () => {
  const editor = fixture()
  editor.openSsidEditor('Home')
  assert.equal(editor.draftSsidAction,'direct')
  editor.draftSsid = 'Other'; editor.draftSsidAction = 'suspend'
  editor.saveSsidPolicy = async () => { throw new Error('disk failure') }
  await editor.addExcludedSsid()
  assert.deepEqual(Array.from(editor.excludedSsids),['Home','Work'])
  assert.equal(editor.ssidRuleAction('Home'),'direct')
  assert.equal(editor.ssidRuleAction('Work'),'suspend')
  assert.equal(editor.showSsidEditor,true)
})
