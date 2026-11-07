import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import {stripTypeScriptTypes} from 'node:module'
import {profileNodes,reorderProfileNodes,removeProfileNodes,copyProfileNode,sameProfileNode} from '../../entry/src/main/ets/domain/ProfileNodes.ts'
import {quickNode,emptyQuickCatalog,importQuickNodes,withBuiltinProfiles} from '../../entry/src/main/ets/domain/QuickStart.ts'
import {nodeUrisFromSingBox} from '../../entry/src/main/ets/domain/SingBoxImport.ts'
import {saveSfaProfile} from '../../entry/src/main/ets/domain/SfaProfiles.ts'

const node=(tag:string)=>({type:'socks',tag,server:'192.0.2.1',server_port:1080+tag.charCodeAt(0)})
const config=(tags:string[])=>JSON.stringify({dns:{servers:[]},inbounds:[],outbounds:[{type:'direct',tag:'direct'},...tags.map(node),{type:'selector',tag:'proxy',outbounds:tags,default:tags[0]}],route:{final:'proxy'}})
test('node order changes only node slots; tags, groups and credentials remain intact',()=>{
 const before=config(['A','B','C']);const result=reorderProfileNodes(before,'C','A')
 assert.deepEqual(profileNodes(result).map(n=>n.tag),['C','A','B'])
 assert.deepEqual(JSON.parse(result).outbounds.filter((n:any)=>['direct','selector'].includes(n.type)),JSON.parse(before).outbounds.filter((n:any)=>['direct','selector'].includes(n.type)))
 assert.equal(reorderProfileNodes(before,'absent','A'),before)
})
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
function batchFixture(){
 const start=source.indexOf('  private async copyNodeToTarget('),end=source.indexOf('\n  @Builder',start)
 const C=vm.runInNewContext(stripTypeScriptTypes('class UI{'+source.slice(start,end)+'}\nUI'),{profileNodes,copyProfileNode,sameProfileNode,saveSfaProfile,quickNode,importQuickNodes,nodeUrisFromSingBox,Error,JSON,Date})
 const ui=new C();const saved:any[]=[];let prompts=0
 const from={id:'source',kind:'local',name:'Source',url:'',content:config(['A','B']),updatedAt:1}
 const target={id:'target',kind:'remote',name:'Target',url:'https://example.invalid/sub',content:config(['C']),updatedAt:1}
 Object.assign(ui,{busy:false,copyingNodeBatch:false,nodeCopySourceId:'source',nodeCopyTags:['A','B'],copyReplaceExisting:false,copyRetain:true,quick:emptyQuickCatalog(),catalog:{version:1,selectedId:'source',profiles:[from,target]},palette:()=>({}),toast:()=>{},
  updatedNodeProfile:(p:any,content:string,tags:string[])=>({...p,content,retainedNodeTags:tags}),
  listedProfileNodes:(p:any)=>{try{return profileNodes(p.content)}catch{return[]}},nodeLabel:(node:any)=>quickNode(node).name,persistQuick:async(catalog:any)=>{saved.push(catalog);ui.quick=catalog},
  persist:async(catalog:any)=>{saved.push(catalog)},getUIContext:()=>({getPromptAction:()=>({showDialog:async()=>{prompts++;return{index:1}}})})})
 return{ui,from,target,saved,prompts:()=>prompts}
}
test('batch copying two nodes asks once, persists once and applies retention to all',async()=>{
 const f=batchFixture();await f.ui.copyNodeToTarget(f.target)
 assert.equal(f.prompts(),1);assert.equal(f.saved.length,1)
 const target=f.saved[0].profiles.find((p:any)=>p.id==='target')
 assert.deepEqual(profileNodes(target.content).map(n=>n.tag),['C','A','B']);assert.deepEqual(Array.from(target.retainedNodeTags),['A','B'])
 assert.equal(profileNodes(f.from.content).length,2)
})
test('an invalid second node aborts the entire batch before confirming or writing',async()=>{
 const f=batchFixture();const value=JSON.parse(f.from.content);value.outbounds.find((n:any)=>n.tag==='B').detour='missing';f.from.content=JSON.stringify(value)
 await f.ui.copyNodeToTarget(f.target);assert.equal(f.saved.length,0);assert.equal(f.prompts(),0)
})
test('a competing busy operation during confirmation is never unlocked by cancelled copy',async()=>{
 const f=batchFixture();f.ui.getUIContext=()=>({getPromptAction:()=>({showDialog:async()=>{f.ui.busy=true;return{index:1}}})})
 await f.ui.copyNodeToTarget(f.target);assert.equal(f.ui.busy,true);assert.equal(f.saved.length,0)
})

test('identical nodes skip the whole copy without confirmation or writes',async()=>{
 const f=batchFixture();f.target.content=f.from.content;await f.ui.copyNodeToTarget(f.target)
 assert.equal(f.saved.length,0);assert.equal(f.prompts(),0)
})
test('all collisions in a copied batch use the selected suffix policy',async()=>{
 const f=batchFixture();const value=JSON.parse(config(['A']));value.outbounds.find((n:any)=>n.tag==='A').server_port=9999;f.target.content=JSON.stringify(value)
 await f.ui.copyNodeToTarget(f.target);const target=f.saved[0].profiles.find((p:any)=>p.id==='target')
 assert.deepEqual(profileNodes(target.content).map(n=>n.tag),['A','A (复制 2)','B']);assert.equal(f.prompts(),1)
})
test('builtin batch copy saves all nodes once and suffixes local display names without rewriting URIs',async()=>{
 const f=batchFixture();f.target.kind='builtin';f.target.content='{}'
 const old=nodeUrisFromSingBox(JSON.stringify({outbounds:[{...node('A'),server_port:9999}]}))[0]
 f.ui.quick=importQuickNodes(emptyQuickCatalog(),old)
 await f.ui.copyNodeToTarget(f.target)
 assert.equal(f.prompts(),1);assert.equal(f.saved.length,1);assert.equal(f.ui.quick.nodes.length,3)
 const renamed=f.ui.quick.nodes.find((n:any)=>n.nameOverride==='A (复制 2)')
 assert.ok(renamed);assert.equal(quickNode(renamed).name,'A (复制 2)')
 assert.equal(quickNode({...renamed,nameOverride:undefined}).name,'A')
})
test('builtin profile is pinned first and idempotent regeneration keeps object identity',()=>{
 const input={version:1,selectedId:'custom',profiles:[{id:'custom',name:'custom',kind:'local',url:'',content:config(['X']),updatedAt:1}]}
 const result=withBuiltinProfiles(input,emptyQuickCatalog(),'/rules')
 assert.equal(result.profiles[0].id,'builtin-base');assert.equal(result.selectedId,'custom')
 assert.equal(withBuiltinProfiles(result,emptyQuickCatalog(),'/rules'),result)
})
test('synchronised deletion validates every affected profile before the first write',async()=>{
 const start=source.indexOf('  private updatedNodeProfile('),end=source.indexOf('  private editConfigNode(',start)
 const C=vm.runInNewContext(stripTypeScriptTypes('class UI{'+source.slice(start,end)+'}\nUI'),{removeProfileNodes,withBuiltinProfiles,Error,JSON,Date})
 const ui=new C();let writes=0
 const from={id:'source',kind:'local',name:'Source',url:'',content:config(['A','B']),updatedAt:1}
 const target={id:'target',kind:'local',name:'Target',url:'',content:config(['A']),updatedAt:1}
 Object.assign(ui,{deleteOtherNodeNames:true,catalog:{version:1,selectedId:'source',profiles:[from,target]},quick:emptyQuickCatalog(),listedProfileNodes:(p:any)=>profileNodes(p.content),nodeLabel:(n:any)=>quickNode(n).name,persist:async()=>{writes++}})
 await assert.rejects(ui.commitEditedNodes(ui.catalog,'source',['A']),/策略组为空/)
 assert.equal(writes,0);assert.equal(profileNodes(target.content).length,1)
})

test('subscription refresh preserves manually saved node order',()=>{
 const body=nodeUrisFromSingBox(JSON.stringify({outbounds:[node('A'),node('B')]})).join('\n')
 const source={id:'subscription',name:'test',url:'https://example.invalid/sub',updatedAt:1}
 const first=importQuickNodes(emptyQuickCatalog(),body,source)
 const reordered={...first,nodes:first.nodes.slice().reverse()}
 const updated=importQuickNodes(reordered,body,source)
 assert.deepEqual(updated.nodes.map(n=>n.id),reordered.nodes.map(n=>n.id))
})
