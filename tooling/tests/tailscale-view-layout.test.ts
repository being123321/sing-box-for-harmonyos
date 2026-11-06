import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import {stripTypeScriptTypes} from 'node:module'

// Execute the actual plain routing block from build(), with view builders
// represented by traces. This checks which scroll viewport receives space.
const source=readFileSync(new URL('../../entry/src/main/ets/pages/TailscaleEndpointPage.ets',import.meta.url),'utf8')
const start=source.indexOf('// 根据视图模式渲染不同页面')
const end=source.indexOf("    }.width('100%').height('100%')",start)
assert.ok(start>=0&&end>start)
const route=vm.runInNewContext('(function(){'+source.slice(start,end)+'\n})',{Blank:()=>({height:()=>{}})})

function displayed(viewMode:string,embedded:boolean):string[]{
 const trace:string[]=[]
 route.call({viewMode,embedded,topClearance:100,endpointView:()=>trace.push('endpoint'),topBar:()=>trace.push('subheader'),
  peerDetailView:()=>trace.push('peerDetail'),exitNodePickerView:()=>trace.push('exitNodePicker'),
  taildropInboxView:()=>trace.push('taildropInbox')})
 return trace
}

test('embedded Tailscale gives the whole content viewport to exactly one current view',()=>{
 assert.deepEqual(displayed('endpoint',true),['endpoint'])
 for(const view of ['peerDetail','exitNodePicker','taildropInbox']) {
  assert.deepEqual(displayed(view,true),['subheader',view])
 }
})

test('standalone Tailscale retains one view without duplicating its outer header',()=>{
 for(const view of ['endpoint','peerDetail','exitNodePicker','taildropInbox']) {
  assert.deepEqual(displayed(view,false),[view])
 }
})

test('embedded scroll tails clear the host dock without adding clearance to standalone pages',()=>{
 const methodStart=source.indexOf('  private scrollBottomPadding(')
 const methodEnd=source.indexOf('\n  build()',methodStart)
 const C=vm.runInNewContext(stripTypeScriptTypes('class Content{'+source.slice(methodStart,methodEnd)+'}\nContent'),{Math})
 const view=new C()
 Object.assign(view,{embedded:false,bottomClearance:200,topClearance:100,tailscaleError:''})
 assert.equal(view.scrollBottomPadding(),32)
 assert.equal(view.scrollBottomPadding(24),24)
 assert.equal(view.scrollTopPadding(),8)
 view.embedded=true
 assert.equal(view.scrollBottomPadding(),200)
 assert.equal(view.scrollTopPadding(),100)
 view.tailscaleError='banner shown'
 assert.equal(view.scrollTopPadding(),8)
 view.bottomClearance=8
 assert.equal(view.scrollBottomPadding(),32)
})
