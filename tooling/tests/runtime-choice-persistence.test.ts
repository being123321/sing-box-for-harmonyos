import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { applyChoices, emptyChoices, parseChoices, recordChoice } from '../../entry/src/main/ets/domain/RuntimeChoices.ts'
import { defaultSavedUiSettings, parseSavedUiSettings } from '../../entry/src/main/ets/domain/SavedUiSettings.ts'

const config = JSON.stringify({ outbounds: [
  { type: 'selector', tag: 'proxy', outbounds: ['slow', 'fast'], default: 'slow' },
  { type: 'selector', tag: 'video', outbounds: ['slow', 'fast'], default: 'fast' },
  { type: 'direct', tag: 'direct' }
], experimental: { clash_api: { default_mode: 'rule', external_controller: '127.0.0.1:9090' } } })

function storeFixture() {
  const disk = new Map<string, string>()
  const source = readFileSync(new URL('../../entry/src/main/ets/services/RuntimeChoicesStore.ts', import.meta.url), 'utf8')
    .replace(/import[^\n]+\r?\n/g, '').replace('export class RuntimeChoicesStore', 'class RuntimeChoicesStore')
  const context = vm.createContext({
    emptyChoices, parseChoices, recordChoice,
    SecureFileStore: class {
      path: string
      constructor(path: string) { this.path = path }
      async load() { return disk.get(this.path) ?? null }
      async save(value: string) { disk.set(this.path, value) }
    }
  })
  const Store = vm.runInContext(stripTypeScriptTypes(source) + '\nRuntimeChoicesStore', context)
  return { Store, disk }
}

test('recreated persistent store restores each profile and group without resetting imported defaults', async () => {
  const { Store } = storeFixture()
  const original = new Store('/private')
  await original.record('profile-A', { action: 'select', group: 'proxy', outbound: 'fast' })
  await original.record('profile-A', { action: 'select', group: 'video', outbound: 'slow' })
  await original.record('profile-A', { action: 'mode', mode: 'global' })
  await original.record('profile-B', { action: 'select', group: 'proxy', outbound: 'slow' })
  const restarted = new Store('/private')
  const a = JSON.parse(applyChoices(config, await restarted.load('profile-A')))
  const b = JSON.parse(applyChoices(config, await restarted.load('profile-B')))
  assert.equal(a.outbounds[0].default, 'fast')
  assert.equal(a.outbounds[1].default, 'slow')
  // The remembered mode is restored via core.control after start, never by
  // rewriting clash_api.default_mode (which would drop modes from the list).
  assert.equal(a.experimental.clash_api.default_mode, 'rule')
  assert.equal(a.experimental.clash_api.external_controller, '127.0.0.1:9090')
  assert.equal(b.outbounds[0].default, 'slow')
  assert.equal(b.outbounds[1].default, 'fast')
  assert.equal(JSON.parse(config).outbounds[0].default, 'slow', 'source profile is never rewritten')
})

test('repeated relaunch adaptation retains saved choice and mode', () => {
  let choice = emptyChoices('same-profile')
  choice = recordChoice(choice, { action: 'select', group: 'proxy', outbound: 'fast' })
  choice = recordChoice(choice, { action: 'mode', mode: 'direct' })
  let launch = config
  for (let i = 0; i < 5; i++) {
    launch = applyChoices(launch, choice)
    assert.equal(JSON.parse(launch).outbounds[0].default, 'fast')
    assert.equal(JSON.parse(launch).experimental.clash_api.default_mode, 'rule', 'default_mode stays the imported value')
  }
})

test('damaged persistent choices fail without replacing the original file', async () => {
  const { Store, disk } = storeFixture()
  disk.set('/private/sfa-choices.secure.json', '{invalid')
  await assert.rejects(new Store('/private').record('A', { action: 'mode', mode: 'rule' }))
  assert.equal(disk.get('/private/sfa-choices.secure.json'), '{invalid')
})

test('saved UI settings preserve hidden cards, collapsed groups and filters across reload', () => {
  const ui = defaultSavedUiSettings()
  ui.visibleCards = []; ui.expandedGroups = []; ui.logLevel = 'warn'; ui.showSystemApplications = false
  const loaded = parseSavedUiSettings(JSON.stringify(ui))
  assert.deepEqual(loaded.visibleCards, [])
  assert.deepEqual(loaded.expandedGroups, [])
  assert.equal(loaded.logLevel, 'warn')
  assert.equal(loaded.showSystemApplications, false)
  assert.equal(parseSavedUiSettings('').visibleCards.length, 5, 'defaults only apply when no saved settings exist')
})
