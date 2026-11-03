import test from 'node:test'
import assert from 'node:assert/strict'
import {profileNodes,editProfileNode,copyProfileNode,sameProfileNode,standaloneProfileNode} from '../../entry/src/main/ets/domain/ProfileNodes.ts'
import {drawerMenus,drawerRoot,drawerParent} from '../../entry/src/main/ets/domain/DrawerRoutes.ts'
import {downloadPulsePoints} from '../../entry/src/main/ets/domain/DownloadPulse.ts'
import {readFileSync} from 'node:fs'
import {stripTypeScriptTypes} from 'node:module'
import vm from 'node:vm'
import {saveSfaProfile} from '../../entry/src/main/ets/domain/SfaProfiles.ts'
import {emptyQuickCatalog,importQuickNodes} from '../../entry/src/main/ets/domain/QuickStart.ts'
import {nodeUrisFromSingBox} from '../../entry/src/main/ets/domain/SingBoxImport.ts'

const source=JSON.stringify({outbounds:[{type:'socks',tag:'HK',server:'198.51.100.1',server_port:1080,password:'fake',custom_option:{keep:true}}],route:{final:'HK'}})
test('raw editor preserves unknown node parameters and surrounding configuration and requires stable tag',()=>{
 const node=profileNodes(source)[0];const json=JSON.parse(node.json);json.server_port=1081
 const result=JSON.parse(editProfileNode(source,'HK',JSON.stringify(json)))
 assert.equal(result.outbounds[0].custom_option.keep,true);assert.equal(result.outbounds[0].server_port,1081)
 assert.equal(result.route.final,'HK');assert.equal(JSON.parse(source).outbounds[0].server_port,1080)
 assert.throws(()=>editProfileNode(source,'HK',JSON.stringify({...json,tag:'other'})),/保留原/)
})

test('copy suffixes collisions, preserves original and remaps detour/DNS dependencies',()=>{
 const input=JSON.stringify({outbounds:[{type:'socks',tag:'HK',server:'edge.test',server_port:1080,detour:'hop',domain_resolver:'resolver'},
  {type:'direct',tag:'hop'}],dns:{servers:[{type:'udp',tag:'resolver',server:'1.1.1.1'}]}})
 const target=JSON.stringify({outbounds:[{type:'socks',tag:'HK',server:'198.51.100.2',server_port:1080},{type:'direct',tag:'hop'}],dns:{servers:[{type:'local',tag:'resolver'}]},route:{final:'HK'}})
 const result=copyProfileNode(input,'HK',target,false);const output=JSON.parse(result.content)
 const copied=output.outbounds.find((item:any)=>item.tag===result.tag)
 assert.equal(result.tag,'HK (复制 2)');assert.equal(copied.detour,'hop (复制 2)');assert.equal(copied.domain_resolver,'resolver (复制 2)')
 assert.equal(output.outbounds[0].server,'198.51.100.2');assert.equal(output.route.final,'HK')
 assert.equal(JSON.parse(input).outbounds[0].tag,'HK')
 const replaced=JSON.parse(copyProfileNode(input,'HK',target,true).content)
 assert.equal(replaced.outbounds.filter((item:any)=>item.tag==='HK').length,1)
 assert.equal(replaced.outbounds.find((item:any)=>item.tag==='HK').server,'edge.test')
})

test('same-node comparison ignores JSON key order and display tag, and rejects changed dependencies',()=>{
 const renamed=JSON.stringify({outbounds:[{custom_option:{keep:true},password:'fake',server_port:1080,server:'198.51.100.1',tag:'Other',type:'socks'}]})
 assert.equal(sameProfileNode(source,'HK',renamed,'Other'),true)
 assert.equal(sameProfileNode(source,'HK',source),true)
 const node=JSON.parse(source);node.outbounds[0].server='198.51.100.3'
 assert.equal(sameProfileNode(source,'HK',JSON.stringify(node)),false)
 assert.equal(JSON.parse(standaloneProfileNode(source,'HK')).route.final,'HK')
 assert.throws(()=>copyProfileNode(JSON.stringify({outbounds:[{type:'socks',tag:'x',detour:'missing'}]}),'x',source,false),/不存在/)
})

test('all configuration children share the configuration drawer, with explicit return paths',()=>{
 for(const page of ['nodes','profiles','editor','profile-node-editor','json-editor','import'])assert.equal(drawerRoot(page),'configuration')
 assert.equal(drawerParent('json-editor'),'editor');assert.equal(drawerParent('profile-node-editor'),'profiles')
 assert.equal(drawerMenus('tools','nodes')[0].key,'configuration')
 assert.ok(!drawerMenus('tools','nodes').some((menu:any)=>menu.key==='presets'))
})

test('download points move left to right, stay bounded and have no fake jumps at zero traffic',()=>{
 const idle=downloadPulsePoints(300,22,0,1000)
 assert.ok(idle.length>0);assert.ok(idle.every((point:any)=>point.y===11))
 const low=downloadPulsePoints(300,22,1024,1000),high=downloadPulsePoints(300,22,10*1024*1024,1000)
 assert.ok(Math.max(...high.map((point:any)=>Math.abs(point.y-11)))>Math.max(...low.map((point:any)=>Math.abs(point.y-11))))
 for(const point of high)assert.ok(point.x>=0&&point.x<=300&&point.y>=0&&point.y<=22)
 assert.ok(downloadPulsePoints(300,22,0,1200).at(-1)!.x>idle.at(-1)!.x)
 assert.deepEqual(downloadPulsePoints(0,22,1024,1000),[])
})

function dropFixture(targetContent:string,confirm:number){
 const text=readFileSync(new URL('../../entry/src/main/ets/pages/SfaIndex.ets',import.meta.url),'utf8').replace(/\r\n/g,'\n')
 const method=text.slice(text.indexOf('  private async dropConfigNode('),text.indexOf('  @Builder\n  configNodeEditor('))
 const Controller=vm.runInNewContext(stripTypeScriptTypes('class Controller{'+method+'}\nController'),{Date,setTimeout:()=>0,copyProfileNode,sameProfileNode,saveSfaProfile,nodeUrisFromSingBox,importQuickNodes})
 const ui=new Controller();const from={id:'from',name:'source',kind:'local',url:'',content:source,updatedAt:1}
 const target={id:'to',name:'target',kind:'remote',url:'https://example.test/profile',content:targetContent,updatedAt:1}
 Object.assign(ui,{draggedProfileId:'from',draggedNodeTag:'HK',catalog:{version:1,selectedId:'from',profiles:[from,target]},busy:false})
 let writes=0,prompts=0
 ui.listedProfileNodes=(profile:any)=>{try{return profileNodes(profile.content)}catch{return []}}
 ui.palette=()=>({});ui.toast=()=>{}
 ui.getUIContext=()=>({getPromptAction:()=>({showDialog:async()=>{prompts++;return {index:confirm}}})})
 ui.persist=async (catalog:any)=>{writes++;ui.catalog=catalog}
 ui.persistQuick=async (catalog:any)=>{writes++;ui.quick=catalog}
 return {ui,target,writes:()=>writes,prompts:()=>prompts}
}

test('actual drop handler gives same-node feedback without a write; cancel keeps both configs intact',async()=>{
 const same=dropFixture(source,1);await same.ui.dropConfigNode(same.target)
 assert.equal(same.ui.nodeEnteredTarget,'to');assert.equal(same.writes(),0);assert.equal(same.prompts(),0)
 const changed=JSON.parse(source);changed.outbounds[0].server='198.51.100.2'
 const cancelled=dropFixture(JSON.stringify(changed),0);await cancelled.ui.dropConfigNode(cancelled.target)
 assert.equal(cancelled.writes(),0);assert.equal(cancelled.ui.catalog.profiles[0].content,source)
})

test('actual drop handler keeps both on suffix choice and marks remote edits as replaceable by updates',async()=>{
 const changed=JSON.parse(source);changed.outbounds[0].server='198.51.100.2'
 const f=dropFixture(JSON.stringify(changed),2);await f.ui.dropConfigNode(f.target)
 assert.equal(f.writes(),1);assert.equal(f.ui.busy,false)
 assert.equal(f.ui.catalog.selectedId,'from');assert.equal(f.ui.catalog.profiles[0].content,source)
 assert.equal(f.ui.catalog.profiles[1].localNodeEdits,true)
 const output=JSON.parse(f.ui.catalog.profiles[1].content)
 assert.equal(output.outbounds.length,2);assert.ok(output.outbounds.some((item:any)=>item.tag==='HK (复制 2)'))
})

test('actual drop handler accepts the first representable node into an empty builtin config',async()=>{
 const f=dropFixture('{}',1)
 f.target.kind='builtin';f.target.id='builtin-base'
 f.ui.catalog.profiles[1]=f.target;f.ui.quick=emptyQuickCatalog()
 f.ui.catalog.profiles[0].content=JSON.stringify({outbounds:[{type:'socks',tag:'HK',server:'198.51.100.1',server_port:1080}]})
 await f.ui.dropConfigNode(f.target)
 assert.equal(f.writes(),1);assert.equal(f.ui.quick.nodes.length,1);assert.equal(f.ui.quick.nodes[0].sourceId,'')
})

test('actual copy asks before saving and lets subscription additions survive updates',async()=>{
 const f=dropFixture('{"outbounds":[]}',1)
 const choices=[1,2]; let dialogs=0
 f.ui.getUIContext=()=>({getPromptAction:()=>({showDialog:async()=>({index:choices[dialogs++]})})})
 await f.ui.dropConfigNode(f.target)
 assert.equal(dialogs,2);assert.equal(f.writes(),1)
 assert.deepEqual(Array.from(f.ui.catalog.profiles[1].retainedNodeTags),['HK'])
 const cancelled=dropFixture('{"outbounds":[]}',1)
 const answers=[1,0];let index=0
 cancelled.ui.getUIContext=()=>({getPromptAction:()=>({showDialog:async()=>({index:answers[index++]})})})
 await cancelled.ui.dropConfigNode(cancelled.target)
 assert.equal(cancelled.writes(),0);assert.equal(cancelled.ui.nodeCopyCancelled,true)
})
