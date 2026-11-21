import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

function fixture() {
 const source=readFileSync(new URL('../../entry/src/main/ets/pages/SfaIndex.ets',import.meta.url),'utf8').replace(/\r\n/g,'\n')
 const methods=source.slice(source.indexOf('  private async dropProfileOrder('),source.indexOf('  private selectAllProfiles('))
 const Controller=vm.runInNewContext(stripTypeScriptTypes('class Controller{'+methods+'}\nController'),{})
 const ui=new Controller()
 Object.assign(ui,{catalog:{version:1,selectedId:'b',profiles:['a','b','c'].map(id=>({id,content:id}))}})
 ui.persist=async(catalog:any)=>{ui.catalog=catalog};ui.toast=()=>{}
 return ui
}

test('profile drag changes order only and keeps running selection and contents',async()=>{
 const ui=fixture();ui.draggedConfigId='a'
 await ui.dropProfileOrder('c')
 assert.deepEqual(Array.from(ui.catalog.profiles,(p:any)=>p.id),['b','c','a'])
 assert.equal(ui.catalog.selectedId,'b');assert.equal(ui.catalog.profiles[2].content,'a')
 ui.draggedConfigId='b';await ui.dropProfileOrder('b')
 assert.deepEqual(Array.from(ui.catalog.profiles,(p:any)=>p.id),['b','c','a'])
})
