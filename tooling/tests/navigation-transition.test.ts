import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

test('navigation selects immediately and defers only data work, ignoring superseded callbacks',()=>{
 const source=readFileSync(new URL('../../entry/src/main/ets/pages/SfaIndex.ets',import.meta.url),'utf8')
 const method=source.slice(source.indexOf('  private selectNavigation('),source.indexOf('  private highlightedNav('))
 const finishes:Array<()=>void>=[];let polls=0
 const C=vm.runInNewContext(stripTypeScriptTypes('class UI {\n'+method+'\n}\nUI'),{setTimeout:(f:()=>void)=>finishes.push(f)})
 const ui=Object.create(C.prototype)
 Object.assign(ui,{navSwitchGeneration:0,navTarget:'',tab:'dashboard',page:'',uiForeground:true,pageAlive:true,
  drawerScroller:{scrollTo:()=>{}},poll:()=>{polls++},
  getUIContext:()=>({animateTo:(options:any,update:()=>void)=>{update();finishes.push(options.onFinish)}})})
 ui.selectNavigation('log')
 assert.equal(ui.tab,'log');assert.equal(ui.navTarget,'');assert.equal(polls,0)
 ui.selectNavigation('settings');finishes[0]()
 assert.equal(ui.tab,'settings');assert.equal(polls,0)
 finishes[1]();assert.equal(ui.tab,'settings');assert.equal(ui.navTarget,'');assert.equal(polls,1)
 ui.selectNavigation('tools');ui.uiForeground=false;finishes[2]()
 assert.equal(ui.tab,'tools');assert.equal(polls,1)
})
