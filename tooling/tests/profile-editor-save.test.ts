import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'
import { validateSfaContent, saveSfaProfile } from '../../entry/src/main/ets/domain/SfaProfiles.ts'

function fixture() {
  const source = fs.readFileSync(new URL('../../entry/src/main/ets/pages/SfaIndex.ets', import.meta.url), 'utf8')
  const method = source.slice(source.indexOf('  private async saveEditor()'), source.indexOf('  private async importFile()'))
  const update = source.slice(source.indexOf('  private async updateProfile('), source.indexOf('  private removeProfile('))
  const Editor = vm.runInNewContext(stripTypeScriptTypes('class Editor { ' + method + update + '}\nEditor'), { validateSfaContent, saveSfaProfile, Date })
  const editor = new Editor()
  const original = { id: 'remote-1', name: '订阅', kind: 'remote', url: 'https://example.org/config', content: '{"outbounds":[]}', updatedAt: 1 }
  Object.assign(editor, { busy: false, editingId: original.id, draftName: original.name, draftKind: original.kind, draftUrl: original.url,
    draftContent: original.content, phase: 'running', page: 'editor', catalog: { version: 1, profiles: [original], selectedId: original.id } })
  const events = { downloads: 0, writes: 0, prompts: 0, confirm: 2 }
  editor.palette = () => ({ textSecondary: '#666', accent: '#123' })
  editor.getUIContext = () => ({ getPromptAction: () => ({ showDialog: async () => { events.prompts++; return { index: events.confirm } } }) })
  editor.downloadRaw = async () => { events.downloads++; return '{"outbounds":[{"type":"direct","tag":"new"}]}' }
  editor.persist = async (catalog: any) => { events.writes++; editor.catalog = catalog }
  editor.toast = () => {}
  editor.failureText = () => 'invalid'
  return { editor, original, events }
}

test('edited subscription JSON is saved as a local copy after confirmation, retaining original and selection', async () => {
  const { editor, original, events } = fixture()
  editor.draftContent = '{"outbounds":[{"type":"direct","tag":"local"}]}'
  await editor.saveEditor()
  assert.equal(events.prompts, 1)
  assert.equal(events.downloads, 0)
  assert.deepEqual(editor.catalog.profiles[0], original)
  assert.equal(editor.catalog.profiles[1].kind, 'local')
  assert.equal(editor.catalog.profiles[1].url, '')
  assert.equal(editor.catalog.profiles[1].content, editor.draftContent)
  assert.equal(editor.catalog.selectedId, original.id)
})

test('cancel or invalid JSON never writes or downloads over the original', async () => {
  const { editor, events } = fixture()
  editor.draftContent = '{"changed":true}'
  events.confirm = 0
  await editor.saveEditor()
  assert.equal(events.writes, 0)
  assert.equal(editor.busy, false)
  editor.draftContent = '{bad json'
  await editor.saveEditor()
  assert.equal(events.writes, 0)
  assert.equal(events.downloads, 0)
  assert.equal(events.prompts, 1)
})

test('unchanged subscription is not fetched on metadata save; changed URL fetches new JSON', async () => {
  const { editor, events } = fixture()
  editor.phase = 'idle'
  await editor.saveEditor()
  assert.equal(events.downloads, 0)
  assert.equal(events.prompts, 0)
  editor.draftUrl = 'https://example.org/new'
  events.confirm = 1
  await editor.saveEditor()
  assert.equal(events.downloads, 1)
  assert.equal(editor.catalog.profiles[0].url, editor.draftUrl)
})

test('subscription update replaces original content while keeping the edited local copy', async () => {
  const { editor, original, events } = fixture()
  editor.draftContent = '{"local":true}'
  await editor.saveEditor()
  const copy = editor.catalog.profiles[1]
  events.confirm = 1
  await editor.updateProfile(original)
  assert.equal(events.downloads, 1)
  assert.notEqual(editor.catalog.profiles[0].content, original.content)
  assert.deepEqual(editor.catalog.profiles[1], copy)
  assert.equal(editor.catalog.selectedId, original.id)
})

test('explicit overwrite retains remote identity and marks changes for update confirmation',async()=>{
 const {editor,original,events}=fixture();events.confirm=1;editor.phase='idle'
 editor.draftContent='{"outbounds":[{"type":"direct","tag":"edited"}]}'
 await editor.saveEditor()
 assert.equal(editor.catalog.profiles.length,1)
 assert.equal(editor.catalog.profiles[0].id,original.id)
 assert.equal(editor.catalog.profiles[0].url,original.url)
 assert.equal(editor.catalog.profiles[0].localNodeEdits,true)
})

test('update can preserve the previous config in the same atomic catalog save',async()=>{
 const {editor,original,events}=fixture();events.confirm=2
 await editor.updateProfile(original)
 assert.equal(events.writes,1);assert.equal(events.downloads,1)
 assert.equal(editor.catalog.profiles.length,2)
 assert.equal(editor.catalog.profiles[1].kind,'local');assert.equal(editor.catalog.profiles[1].content,original.content)
 assert.equal(editor.catalog.selectedId,original.id)
})
