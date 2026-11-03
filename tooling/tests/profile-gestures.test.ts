import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

function fixture() {
 const source=readFileSync(new URL('../../entry/src/main/ets/pages/SfaIndex.ets',import.meta.url),'utf8').replace(/\r\n/g,'\n')
 const methods=source.slice(source.indexOf('  private openNodeCopy('),source.indexOf('  private async dropConfigNode('))
 const Controller=vm.runInNewContext(stripTypeScriptTypes('class Controller{'+methods+'}\nController'),{})
 const ui=new Controller()
 Object.assign(ui,{configNodeSelection:[],configNodeSelectionSource:'',busy:false,copyingNodeBatch:false,
  catalog:{version:1,selectedId:'b',profiles:['a','b','c'].map(id=>({id,content:id}))}})
 ui.persist=async(catalog:any)=>{ui.catalog=catalog};ui.toast=()=>{}
 return ui
}

test('stationary node selection toggles multiple nodes and drag carries the selected batch',()=>{
 const ui=fixture()
 ui.toggleConfigNodeSelection('a','one');ui.toggleConfigNodeSelection('a','two')
 ui.openNodeCopy({id:'a'},{tag:'two'})
 assert.deepEqual(Array.from(ui.nodeCopyTags),['one','two']);assert.equal(ui.nodeCopyVisible,true)
 ui.toggleConfigNodeSelection('a','one')
 assert.deepEqual(Array.from(ui.configNodeSelection),['two'])
 ui.toggleConfigNodeSelection('b','three')
 assert.deepEqual(Array.from(ui.configNodeSelection),['three'])
})

test('profile drag changes order only and keeps running selection and contents',async()=>{
 const ui=fixture();ui.draggedConfigId='a'
 await ui.dropProfileOrder('c')
 assert.deepEqual(Array.from(ui.catalog.profiles,(p:any)=>p.id),['b','c','a'])
 assert.equal(ui.catalog.selectedId,'b');assert.equal(ui.catalog.profiles[2].content,'a')
 ui.draggedConfigId='b';await ui.dropProfileOrder('b')
 assert.deepEqual(Array.from(ui.catalog.profiles,(p:any)=>p.id),['b','c','a'])
})

test('batch copying uses the current target after each save and stops on cancellation',async()=>{
 const ui=fixture();ui.nodeCopySourceId='a';ui.nodeCopyTags=['one','two'];const calls:string[]=[]
 ui.dropConfigNode=async(target:any)=>{
  calls.push(target.content+':'+ui.draggedNodeTag)
  ui.catalog.profiles=ui.catalog.profiles.map((p:any)=>p.id===target.id?{...p,content:'updated'}:p)
 }
 await ui.copyNodeToTarget(ui.catalog.profiles[1])
 assert.deepEqual(calls,['b:one','updated:two']);assert.equal(ui.catalog.profiles[0].content,'a')
 calls.length=0;ui.dropConfigNode=async()=>{calls.push('cancel');ui.nodeCopyCancelled=true}
 await ui.copyNodeToTarget(ui.catalog.profiles[1]);assert.deepEqual(calls,['cancel'])
 assert.equal(ui.copyingNodeBatch,false);assert.equal(ui.draggedProfileId,'')
})
