import test from 'node:test'
import assert from 'node:assert/strict'
import { parseProfileQr } from '../../entry/src/main/ets/domain/ProfileQr.ts'
import { resolveProfileSaveTarget } from '../../entry/src/main/ets/domain/SfaProfiles.ts'
import { normalizeSsidPolicy, ssidMode, shouldSuspendSsid, withSsidRule, ssidAction } from '../../entry/src/main/ets/domain/SsidPolicy.ts'

test('repeat scans of the same remote URL overwrite the existing profile instead of duplicating', () => {
  const remote = { id: 'profile-1', name: 'Sub', kind: 'remote', url: 'https://example.com/sub', content: '{}', updatedAt: 1 }
  const other = { id: 'profile-2', name: 'Other', kind: 'remote', url: 'https://example.com/other', content: '{}', updatedAt: 1 }
  const local = { id: 'profile-3', name: 'Local', kind: 'local', url: '', content: '{}', updatedAt: 1 }
  const catalog = { version: 1, selectedId: 'profile-2', profiles: [remote, other, local] }
  assert.deepEqual(resolveProfileSaveTarget({ version: 1, selectedId: '', profiles: [] }, '', 'remote', 'https://example.com/sub'), { mode: 'create', targetId: '' })
  assert.deepEqual(resolveProfileSaveTarget(catalog, '', 'remote', 'https://example.com/sub'), { mode: 'update', targetId: 'profile-1' })
  assert.deepEqual(resolveProfileSaveTarget(catalog, '', 'remote', '  https://example.com/sub  '), { mode: 'update', targetId: 'profile-1' })
  assert.deepEqual(resolveProfileSaveTarget(catalog, 'profile-3', 'remote', 'https://example.com/sub'), { mode: 'update', targetId: 'profile-3' })
  assert.deepEqual(resolveProfileSaveTarget(catalog, '', 'local', ''), { mode: 'create', targetId: '' })
  assert.deepEqual(resolveProfileSaveTarget(catalog, '', 'remote', 'https://example.com/new'), { mode: 'create', targetId: '' })
})

test('SFA remote QR preserves URL credentials/query escaping and fragment name', () => {
 const url = 'https://example.com/config.json?a=1&b=a+b'
 const qr = `sing-box://import-remote-profile?url=${encodeURIComponent(url)}#${encodeURIComponent('家里 + 手机')}`
 assert.deepEqual(parseProfileQr(qr), { name: '家里 + 手机', url, kind: 'remote', content: '' })
})
test('QR imports are data only and malformed/unrelated links do not reach download', () => {
 for (const value of ['https://example.com', 'vless://test', 'sing-box://import-remote-profile?url=javascript%3Aalert(1)', 'sing-box://import-remote-profile?url=%ZZ']) assert.throws(() => parseProfileQr(value))
 assert.equal(parseProfileQr('sing-box://import-remote-profile?url=https%3A%2F%2Fexample.com%2Fp').name,'example.com')
 assert.equal(parseProfileQr('{"outbounds":[]}').kind,'local')
})
test('SSID exact matching, fallback and disabled behavior', () => {
 const p=normalizeSsidPolicy({ enabled:true,direct:[' Home '],proxy:['Office'],fallback:'rule' })
 assert.equal(ssidMode(p,'Home'),'direct'); assert.equal(ssidMode(p,'Office'),'global')
 assert.equal(ssidMode(p,'home'),'rule'); assert.equal(ssidMode(p,''),'rule')
 assert.equal(ssidMode({...p,enabled:false},'Home'),'keep')
})
test('conflicting SSID policies are rejected before persistence', () => {
 assert.throws(() => normalizeSsidPolicy({enabled:true,direct:['Home'],proxy:[' Home '],fallback:'keep'}))
 assert.throws(() => normalizeSsidPolicy({enabled:true,direct:[],proxy:[],fallback:'bad'}))
})

test('excluded SSIDs suspend exactly, roaming resumes and manual disable wins', () => {
 const p=normalizeSsidPolicy({enabled:true,direct:[],proxy:[],fallback:'keep',excluded:['being','家里 WiFi','being']})
 assert.deepEqual(p.excluded,['being','家里 WiFi'])
 assert.equal(shouldSuspendSsid(p,'being'),true)
 assert.equal(shouldSuspendSsid(p,'Being'),false)
 assert.equal(shouldSuspendSsid(p,''),false)
 assert.equal(shouldSuspendSsid(p,'Office'),false)
 assert.equal(shouldSuspendSsid({...p,enabled:false},'being'),false)
 assert.throws(()=>normalizeSsidPolicy({...p,excluded:['家'.repeat(11)]}))
 assert.throws(()=>normalizeSsidPolicy({...p,excluded:['']}))
})

test('previous direct SSIDs migrate into the exclusion list', () => {
 const p=normalizeSsidPolicy({enabled:true,direct:['Home'],proxy:['Office'],fallback:'rule'})
 assert.deepEqual(p.excluded,['Home'])
 assert.equal(shouldSuspendSsid(p,'Home'),true)
 assert.equal(shouldSuspendSsid(p,'Office'),false)
})

test('legacy exclusions keep suspension; direct mode is explicit and invalid actions are rejected', () => {
 const old = normalizeSsidPolicy({enabled:true,direct:[],proxy:[],fallback:'keep',excluded:['Home']})
 assert.equal(old.excludedAction, 'suspend')
 assert.equal(shouldSuspendSsid({...old,actions:undefined,excludedAction:'direct'},'Home'), false)
 assert.throws(() => normalizeSsidPolicy({...old,excludedAction:'invalid'}))
})

test('per-SSID edit and rename preserve other actions, serialize independently, and reject collisions', () => {
 const old = normalizeSsidPolicy({enabled:true,direct:[],proxy:[],fallback:'keep',excluded:['Home','Office'],excludedAction:'direct'})
 assert.deepEqual(old.actions, [{ssid:'Home',action:'direct'},{ssid:'Office',action:'direct'}])
 const changed = withSsidRule(old, 'Office', 'Work', 'suspend')
 const saved = normalizeSsidPolicy(JSON.parse(JSON.stringify(changed)))
 assert.equal(ssidAction(saved,'Home'),'direct')
 assert.equal(ssidAction(saved,'Work'),'suspend')
 assert.equal(ssidAction(saved,'Office'),'keep')
 assert.equal(ssidAction(old,'Office'),'direct', 'editor must not mutate the original policy before save')
 assert.throws(() => withSsidRule(saved,'Work','Home','suspend'), /已存在/)
 const added = withSsidRule(saved,'','Cafe','direct')
 assert.equal(ssidAction(added,'Cafe'),'direct')
 assert.equal(shouldSuspendSsid(added,'Work'),true)
 assert.equal(shouldSuspendSsid(added,'Home'),false)
 assert.equal(ssidAction({...added,enabled:false},'Work'),'keep')
})
