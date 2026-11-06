import test from 'node:test'
import assert from 'node:assert/strict'
import {OptimisticChoices} from '../../entry/src/main/ets/domain/OptimisticChoices.ts'

const tick=()=>new Promise<void>(r=>setTimeout(r,5))

test('latest tap is immediate; queued intermediate choices coalesce without snapshot flicker',async()=>{
 const shown=new Map<string,string>();const calls:string[]=[];const release:Array<()=>void>=[]
 const model=new OptimisticChoices(async(_,v)=>{calls.push(v);await new Promise<void>(r=>release.push(r))},(k,v)=>shown.set(k,v),()=>{})
 model.choose('mode','direct','rule')
 assert.equal(shown.get('mode'),'direct');assert.equal(calls.length,0)
 await tick();model.choose('mode','global','direct');model.choose('mode','rule','global')
 assert.equal(shown.get('mode'),'rule');assert.equal(model.reconcile('mode','direct',Date.now()),'rule')
 release[0]();await tick();assert.deepEqual(calls,['direct','rule'])
 assert.equal(model.reconcile('mode','direct',Date.now()),'rule')
 release[1]();await tick()
 assert.equal(model.reconcile('mode','direct',0),'rule')
 assert.equal(model.reconcile('mode','rule',Date.now()+10),'rule')
})

test('failed newest selection rolls back to the last successful backend choice',async()=>{
 const shown:string[]=[];let failure=''
 const model=new OptimisticChoices(async(_,v)=>{if(v==='bad')throw Error('rejected')},(_,v)=>shown.push(v),m=>{failure=m})
 model.choose('group:p','two','one');await tick()
 model.choose('group:p','bad','two');assert.equal(shown.at(-1),'bad');await tick()
 assert.equal(shown.at(-1),'two');assert.equal(failure,'rejected')
})

test('a failed old request never rolls back or reports failure over a newer tap',async()=>{
 let reject!:(error:Error)=>void;let shown='';let failures=0
 const model=new OptimisticChoices(async(_,v)=>{if(v==='old')await new Promise<void>((_,r)=>{reject=r})},(_,v)=>{shown=v},()=>{failures++})
 model.choose('group:p','old','original');await tick();model.choose('group:p','new','old')
 reject(Error('late'));await tick();assert.equal(shown,'new');assert.equal(failures,0)
})

test('session reset discards a late completion and queued old commands',async()=>{
 let finish!:()=>void;let shown='';const calls:string[]=[]
 const model=new OptimisticChoices(async(_,v)=>{calls.push(v);await new Promise<void>(r=>{finish=r})},(_,v)=>{shown=v},()=>{})
 model.choose('mode','direct','rule');await tick();model.choose('mode','global','direct')
 model.reset();finish();await tick();assert.deepEqual(calls,['direct'])
 assert.equal(model.reconcile('mode','rule',Date.now()),'rule');assert.equal(shown,'global')
})
