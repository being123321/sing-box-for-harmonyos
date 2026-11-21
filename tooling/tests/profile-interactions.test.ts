import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import {stripTypeScriptTypes} from 'node:module'
import {profileNodes,removeProfileNodes} from '../../entry/src/main/ets/domain/ProfileNodes.ts'
import {emptyQuickCatalog,importQuickNodes} from '../../entry/src/main/ets/domain/QuickStart.ts'
import {nodeUrisFromSingBox} from '../../entry/src/main/ets/domain/SingBoxImport.ts'
import {removeLegacyBuiltinProfiles, parseSfaCatalog} from '../../entry/src/main/ets/domain/SfaProfiles.ts'

const node=(tag:string)=>({type:'socks',tag,server:'192.0.2.1',server_port:1080+tag.charCodeAt(0)})
const config=(tags:string[])=>JSON.stringify({dns:{servers:[]},inbounds:[],outbounds:[{type:'direct',tag:'direct'},...tags.map(node),{type:'selector',tag:'proxy',outbounds:tags,default:tags[0]}],route:{final:'proxy'}})
test('delete detaches group membership and repairs defaults without mutating original',()=>{
 const before=config(['A','B']);const result=JSON.parse(removeProfileNodes(before,['A']))
 assert.deepEqual(result.outbounds.at(-1).outbounds,['B']);assert.equal(result.outbounds.at(-1).default,'B')
 assert.equal(profileNodes(before).length,2)
})
test('delete fails closed on empty groups, chained outbounds, DNS detours and final routes',()=>{
 assert.throws(()=>removeProfileNodes(config(['A']),['A']),/策略组为空/)
 for(const nested of [{route:{rules:[{outbound:'A'}],final:'proxy'}},{dns:{servers:[{type:'https',tag:'remote',detour:'A'}]}},{outbounds:[node('A'),{...node('B'),detour:'A'}],route:{final:'B'}}]) {
  assert.throws(()=>removeProfileNodes(JSON.stringify({...JSON.parse(config(['A','B'])),...nested}),['A']),/引用/)
 }
 assert.throws(()=>removeProfileNodes(JSON.stringify({outbounds:[node('A'),node('B')],route:{final:'A'}}),['A']),/默认出站/)
})
const source=readFileSync(new URL('../../entry/src/main/ets/pages/SfaIndex.ets',import.meta.url),'utf8')
test('reversing at any depth restores the log title; upward scrolling restores pinned menu',()=>{
 const start=source.indexOf('  private updateLogScroll('),end=source.indexOf('\n  @Builder',start)
 const C=vm.runInNewContext(stripTypeScriptTypes('class UI{'+source.slice(start,end)+'}\nUI'))
 const ui=new C();let y=300
 Object.assign(ui,{logScrolled:false,logReturning:false,logScroller:{currentOffset:()=>({yOffset:y})}})
 ui.updateLogScroll(15);assert.equal(ui.logScrolled,true);assert.equal(ui.logReturning,false)
 ui.updateLogScroll(-15);assert.equal(ui.logReturning,true)
 ui.updateLogScroll(0.3);assert.equal(ui.logReturning,true)
 ui.updateLogScroll(8);assert.equal(ui.logReturning,false)
 y=0;ui.updateLogScroll(-30);assert.equal(ui.logScrolled,false)
})
test('removes old builtin profiles and generated local copies, preserving user profiles', () => {
 const local = {id:'custom', name:'旧版节点配置', kind:'local', url:'', content:config(['X']), updatedAt:1}
 const builtin = {...local, id:'builtin-base', kind:'builtin', content:config(['A','B'])}
 const legacyCopy = {...local, id:'migrated-builtin-base-local', content:builtin.content}
 const catalog = {version:1, selectedId:legacyCopy.id, profiles:[builtin, legacyCopy, local]}
 const cleaned = removeLegacyBuiltinProfiles(catalog)
 assert.deepEqual(cleaned.profiles, [local])
 assert.equal(cleaned.selectedId, local.id)
 assert.deepEqual(parseSfaCatalog(JSON.stringify(cleaned)), cleaned)
 assert.equal(removeLegacyBuiltinProfiles(cleaned), cleaned)
 assert.equal(removeLegacyBuiltinProfiles({...catalog, selectedId:builtin.id, profiles:[builtin]}).selectedId, '')
})

test('subscription refresh preserves manually saved node order',()=>{
 const body=nodeUrisFromSingBox(JSON.stringify({outbounds:[node('A'),node('B')]})).join('\n')
 const source={id:'subscription',name:'test',url:'https://example.invalid/sub',updatedAt:1}
 const first=importQuickNodes(emptyQuickCatalog(),body,source)
 const reordered={...first,nodes:first.nodes.slice().reverse()}
 const updated=importQuickNodes(reordered,body,source)
 assert.deepEqual(updated.nodes.map(n=>n.id),reordered.nodes.map(n=>n.id))
})
