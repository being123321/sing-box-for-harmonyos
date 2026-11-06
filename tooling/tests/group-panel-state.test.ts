import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {stripTypeScriptTypes} from 'node:module'
import vm from 'node:vm'
import {OptimisticChoices} from '../../entry/src/main/ets/domain/OptimisticChoices.ts'
import {panelNodeKey,panelGroupKey,panelPresentation,samePanelMap} from '../../entry/src/main/ets/domain/GroupPanelState.ts'

const group={tag:'proxy',type:'selector',selectable:true,selected:'one',items:[{tag:'one',type:'socks',urlTestDelay:10},{tag:'two',type:'socks',urlTestDelay:20}]}

test('selection and ping updates preserve card identity while membership changes invalidate it',()=>{
 const changed={...group,selected:'two',items:group.items.map(n=>({...n,urlTestDelay:100}))}
 assert.equal(panelGroupKey(group),panelGroupKey(changed))
 assert.notEqual(panelGroupKey(group),panelGroupKey({...group,items:group.items.slice(1)}))
 const a=panelPresentation([group]),b=panelPresentation([changed])
 assert.equal(b.selections.get('proxy'),'two');assert.equal(b.delays.get(panelNodeKey('proxy','one')),100)
 assert.equal(samePanelMap(a.selections,b.selections),false)
 assert.equal(samePanelMap(a.delays,panelPresentation([group]).delays),true)
 assert.notEqual(panelNodeKey('a:b','c'),panelNodeKey('a','b:c'))
})

const source=readFileSync(new URL('../../entry/src/main/ets/pages/SfaIndex.ets',import.meta.url),'utf8').replace(/\r\n/g,'\n')
function method(start:string,end:string){return source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)))}
function fixture(fail=false){
 const methods=method('  private async selectGroupNode(','  @Builder\n  groupsPage(')+
  method('  private async control(','  private async testGroupItem(')
 const C=vm.runInNewContext(stripTypeScriptTypes('class Controller{'+methods+'}\nController'),{})
 const ui=new C();let release!:()=>void;const gate=new Promise<void>(r=>{release=r});let calls=0,polls=0
 Object.assign(ui,{phase:'running',busy:false,selectingGroup:'',selectingNode:'',groupInteractionRevision:0,groupSelections:new Map([['proxy','one']]),
  coordinator:{control:async()=>{calls++;await gate;if(fail)throw Error('test failure')}},
  toast:()=>{},poll:async()=>{polls++}})
 ui.choices=new OptimisticChoices(async()=>{calls++;await gate;if(fail)throw Error('test failure')},(key:string,value:string)=>{ui.groupSelections=new Map(ui.groupSelections).set(key.substring(6),value)},()=>{})
 return {ui,release,counts:()=>({calls,polls})}
}

test('node tap selects immediately without a busy lock and suppresses duplicate taps',async()=>{
 const f=fixture();await f.ui.selectGroupNode(group,group.items[0]);assert.equal(f.counts().calls,0)
 const pending=f.ui.selectGroupNode(group,group.items[1])
 assert.equal(f.ui.groupSelections.get('proxy'),'two');assert.equal(f.ui.busy,false)
 await new Promise(r=>setTimeout(r,5))
 await f.ui.selectGroupNode(group,group.items[1]);assert.equal(f.counts().calls,1)
 assert.equal(f.ui.groupSelections.get('proxy'),'two')
 f.release();await pending;await new Promise(r=>setTimeout(r,5))
 assert.equal(f.ui.selectingNode,'');assert.equal(f.ui.busy,false);assert.equal(f.counts().polls,0)
})

test('failed switch clears pending state and keeps the acknowledged selection',async()=>{
 const f=fixture(true);const pending=f.ui.selectGroupNode(group,group.items[1]);f.release();await pending;await new Promise(r=>setTimeout(r,10))
 assert.equal(f.ui.selectingNode,'');assert.equal(f.ui.busy,false)
 assert.equal(f.ui.groupSelections.get('proxy'),'one')
})

test('manual selection interrupts remaining auto-test submissions',async()=>{
 const m=method('  private async refreshGroupDelays(','  private nodeType(')
 const C=vm.runInNewContext(stripTypeScriptTypes('class Controller{'+m+'}\nController'),{Date})
 const ui=new C();let calls=0
 Object.assign(ui,{uiForeground:true,pageAlive:true,suspended:false,phase:'running',busy:false,groupTestBusy:false,groupInteractionRevision:0,
  groups:[group,{...group,tag:'other'}],poll:async()=>{},toast:()=>{},
  coordinator:{control:async()=>{calls++;ui.groupInteractionRevision++}}})
 await ui.refreshGroupDelays();assert.equal(calls,1);assert.equal(ui.groupTestBusy,false)
})
