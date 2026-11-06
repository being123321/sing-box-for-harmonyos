import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {stripTypeScriptTypes} from 'node:module'
import vm from 'node:vm'

function fixture() {
 let now=100000;let calls=0;let callback:any;let removed=0;const errors:string[]=[]
 const source=readFileSync(new URL('../../entry/src/main/ets/services/VpnMemoryPressureObserver.ts',import.meta.url),'utf8')
  .replace(/import[^\n]+\n/g,'').replace('export class','class')
 const C=vm.runInNewContext(stripTypeScriptTypes(source)+'\nVpnMemoryPressureObserver',{
  Date:{now:()=>now},Promise,AbilityConstant:{MemoryLevel:{MEMORY_LEVEL_LOW:1,MEMORY_LEVEL_CRITICAL:2,MEMORY_LEVEL_BACKGROUND_LOW:5,MEMORY_LEVEL_BACKGROUND_CRITICAL:6}}})
 const observer=new C(async()=>{calls++},(message:string)=>errors.push(message))
 const context={on:(_:string,c:any)=>{callback=c;return 0},off:async()=>{removed++}}
 observer.start(context)
 return{observer,context,level:(n:number)=>callback.onMemoryLevel(n),callback:()=>callback,calls:()=>calls,removed:()=>removed,errors,
  advance:()=>{now+=31000},flush:async()=>{await new Promise(r=>setTimeout(r,0))}}
}

test('only real low/critical memory triggers async reclaim; UI hiding and moderate levels do not',async()=>{
 const f=fixture();for(const level of [0,3,4])f.level(level)
 await f.flush();assert.equal(f.calls(),0)
 f.level(1);assert.equal(f.calls(),0);await f.flush();assert.equal(f.calls(),1)
 for(const level of [2,5,6]){f.advance();f.level(level);await f.flush()}
 assert.equal(f.calls(),4)
})

test('pressure bursts coalesce with no recurring work or heartbeat GC',async()=>{
 const f=fixture();f.level(1);f.level(2);await f.flush();f.level(6);await f.flush()
 assert.equal(f.calls(),1);f.advance();await f.flush();assert.equal(f.calls(),1)
 f.level(5);await f.flush();assert.equal(f.calls(),2)
})

test('stop removes subscription and cancels queued and late callback work',async()=>{
 const f=fixture();const old=f.callback();f.level(1);f.observer.stop();await f.flush()
 assert.equal(f.calls(),0);assert.equal(f.removed(),1)
 f.advance();old.onMemoryLevel(2);await f.flush();assert.equal(f.calls(),0)
 f.observer.start(f.context);old.onMemoryLevel(2);await f.flush();assert.equal(f.calls(),0)
 f.level(2);await f.flush();assert.equal(f.calls(),1)
})

test('subscription failures and synchronous unsubscribe errors never break VPN lifecycle cleanup',()=>{
 const f=fixture();f.observer.stop()
 assert.doesNotThrow(()=>f.observer.start({on:()=>{throw Error('not supported')}}))
 assert.equal(f.errors.length,1)
 f.observer.start({on:()=>3,off:()=>{throw Error('already dead')}})
 assert.doesNotThrow(()=>f.observer.stop())
})
