import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {stripTypeScriptTypes} from 'node:module'
import vm from 'node:vm'
import {emptyVpnJournal, appendMonitorEvent, cleanMonitorEvent, monitorContinuity} from '../../entry/src/main/ets/domain/VpnMonitor.ts'
import type {VpnMonitorEvent} from '../../entry/src/main/ets/domain/VpnMonitor.ts'

function event(at = 1000, stage = 'running'): VpnMonitorEvent {
 return {at,eventAt:at,event:'runtime',state:'running',stage,pid:101,session:'test-123',code:0,reason:'',runId:''}
}

test('heartbeats update latest without evicting transition history; missing data is never called a kill', () => {
 let journal = emptyVpnJournal()
 journal = appendMonitorEvent(journal,event(1000,'start-core'))
 journal = appendMonitorEvent(journal,event(2000))
 journal = appendMonitorEvent(journal,event(32000))
 assert.equal(journal.events.length,2)
 assert.equal(journal.latest!.at,32000)
 assert.match(monitorContinuity(journal.latest,140000),/原因待确认/)
 assert.match(monitorContinuity(null,140000),/尚无/)
 assert.match(monitorContinuity({...event(),stage:'ssid-suspended'},140000),/按需挂起/)
 for (let i=0;i<200;i++) journal = appendMonitorEvent(journal,event(50000+i,'stage-'+i))
 assert.equal(journal.events.length,128)
 assert.equal(journal.events.at(-1)!.stage,'stage-199')
})

test('allowlisted schema drops secrets, paths, exception text and invalid reason values', () => {
 const sample = cleanMonitorEvent({...event(),reason:'https://secret.test/token',session:'secret?password=x',url:'secret'} as any)
 assert.equal(sample.reason,''); assert.equal(sample.session,'')
 assert.equal('url' in sample,false)
 assert.equal(cleanMonitorEvent({...event(),reason:'ResourceLeak(FDLeak)'}).reason,'ResourceLeak(FDLeak)')
})

function storeFixture() {
 const files = new Map<string,string>(); let writes = 0; let fail = false
 const source = readFileSync(new URL('../../entry/src/main/ets/services/VpnMonitorStore.ts',import.meta.url),'utf8')
  .replace(/import[^\n]*\n/g,'').replace('export class VpnMonitorStore','class VpnMonitorStore')
 const context = vm.createContext({Map,JSON,Promise,Date,emptyVpnJournal,appendMonitorEvent,cleanMonitorEvent,
  writeAtomicText: async (path:string,text:string) => { writes++; if(fail)throw new Error('disk'); files.set(path,text) },
  fileIo:{statSync:(path:string)=>{if(!files.has(path))throw new Error('missing');return {size:Buffer.byteLength(files.get(path)!) }},
   readTextSync:(path:string)=>files.get(path),OpenMode:{CREATE:1,READ_WRITE:2,TRUNC:4},
   openSync:(path:string)=>({fd:path}),writeSync:(path:string,text:string)=>files.set(path,text),fsyncSync:()=>{},closeSync:()=>{}}
 })
 const Store = vm.runInContext(stripTypeScriptTypes(source)+'\nVpnMonitorStore',context)
 return {Store,files,writes:()=>writes,fail:(value:boolean)=>{fail=value}}
}

test('store serializes writes, throttles steady heartbeats and retains the previous run at recreation',async()=>{
 const f = storeFixture(); const store = f.Store.get('/private','extension')
 await Promise.all([store.record(event(1000,'start-core')),store.record(event(2000))])
 await store.record(event(3000)); assert.equal(f.writes(),2)
 await store.record(event(33000)); assert.equal(f.writes(),3)
 assert.equal(store.read().events.length,2)
 assert.equal(store.read().latest.at,33000)
 await store.record({...event(40000),event:'extension-create',pid:102,session:''})
 assert.equal(store.read().events.at(-2).pid,101)
 assert.equal(f.Store.get('/private','extension'),store,'all UI writers must share their queue')
 store.recordDestroy({...event(41000),event:'extension-destroy'})
 assert.equal(store.readDestroy().event,'extension-destroy')
 assert.equal(store.read().latest.event,'extension-create','emergency marker must not race queued journal file')
})

test('disk failure never escapes into VPN lifecycle and does not poison later writes',async()=>{
 const f = storeFixture(); const store = f.Store.get('/private','extension')
 f.fail(true); await store.record(event()); assert.equal(store.read().latest,null)
 f.fail(false); await store.record(event(2000)); assert.equal(store.read().latest.at,2000)
 f.files.set('/private/vpn-monitor-extension.json','broken')
 await store.record(event(40000)); assert.equal(store.read().latest.at,40000)
})

test('system observer subscribes once, retains delayed event time, and excludes raw system logs',()=>{
 let watcher: any; let subscriptions=0; let removed=0
 const saved: VpnMonitorEvent[]=[]
 const source=readFileSync(new URL('../../entry/src/main/ets/services/VpnSystemEvents.ts',import.meta.url),'utf8')
  .replace(/import[^\n]*\n/g,'').replace('export class VpnSystemEvents','class VpnSystemEvents')
 const SystemEvents=vm.runInNewContext(stripTypeScriptTypes(source)+'\nVpnSystemEvents',{
  Date,String,process:{pid:7},VpnMonitorStore:{get:()=>({record:(sample:VpnMonitorEvent)=>{saved.push(cleanMonitorEvent(sample))}})},
  hiAppEvent:{domain:{OS:'OS'},event:{APP_KILLED:'APP_KILLED',APP_CRASH:'APP_CRASH',APP_FREEZE:'APP_FREEZE',RESOURCE_OVERLIMIT:'RESOURCE_OVERLIMIT'},
   addWatcher:(value:any)=>{subscriptions++;watcher=value;return {}},removeWatcher:()=>{removed++}}
 })
 SystemEvents.start('/private',0);SystemEvents.start('/private',0)
 assert.equal(subscriptions,1)
 watcher.onReceive('OS',[{appEventInfos:[{name:'APP_KILLED',params:{time:123,pid:8,reason:'RssThresholdKiller',app_running_unique_id:'999',external_log:['/secret'],config:'secret'}}]}])
 const entry=saved.at(-1)!
 assert.equal(entry.event,'APP_KILLED');assert.equal(entry.eventAt,123);assert.equal(entry.pid,8)
 assert.equal(entry.reason,'RssThresholdKiller');assert.equal(entry.runId,'999')
 assert.ok(!JSON.stringify(entry).includes('secret'))
 let journal=appendMonitorEvent(emptyVpnJournal(),entry)
 journal=appendMonitorEvent(journal,event(50000))
 journal=appendMonitorEvent(journal,{...entry,at:60000})
 assert.equal(journal.events.length,2,'replayed system events must not evict lifecycle evidence')
 SystemEvents.stop();assert.equal(removed,1)
})

test('pre-recovery observation preserves old heartbeat and unknown inventory without starting or stopping anything',async()=>{
 const saved:VpnMonitorEvent[]=[]
 const source=readFileSync(new URL('../../entry/src/main/ets/services/VpnMonitorObservation.ts',import.meta.url),'utf8')
  .replace(/import[^\n]*\n/g,'').replace('export async function','async function')
 const capture=vm.runInNewContext(stripTypeScriptTypes(source)+'\ncaptureVpnMonitor',{
  Date,process:{pid:7},VpnRuntimeBridgeStore:class {async loadLatestStatus(){return {state:'running',stage:'running',updatedAt:123,sessionId:'old-session',snapshotJson:'secret'}}},
  readSystemVpnBearerState:async()=> 'unknown',VpnMonitorStore:{get:()=>({record:async (sample:VpnMonitorEvent)=>{saved.push(sample)}})}
 })
 await capture('/private')
 assert.equal(saved[0].eventAt,123);assert.equal(saved[0].session,'old-session')
 assert.equal(saved[0].code,-1,'unknown inventory must not become absent')
 assert.ok(!JSON.stringify(saved).includes('secret'))
})
