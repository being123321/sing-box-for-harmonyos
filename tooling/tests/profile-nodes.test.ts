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

// Copy gestures now use the unified batch transaction; see profile-interactions.test.ts.
