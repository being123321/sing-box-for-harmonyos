import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { buildNodeTestConfig, emptyQuickCatalog, importQuickNodes } from '../../entry/src/main/ets/domain/QuickStart.ts'
import { encodeBase64Text } from '../../entry/src/main/ets/domain/TextCodec.ts'

import { nodeProbeErrorLabel, nodeProbeErrorCode } from '../../entry/src/main/ets/domain/NodeProbeDiagnostic.ts'

const uuid='11111111-2222-3333-4444-555555555555'
export const probeLinks = [
 `vless://${uuid}@example.com:443?security=tls&sni=example.com#Test`,
 'vmess://'+encodeBase64Text(JSON.stringify({add:'example.com',port:'443',id:uuid,scy:'auto',net:'tcp',ps:'Test'})),
 'ss://'+encodeBase64Text('aes-128-gcm:secret')+'@example.com:8388#Test',
 'trojan://secret@example.com:443?sni=example.com#Test','hy2://secret@example.com:443?sni=example.com#Test',
 'socks://user:secret@example.com:1080#Test','http://user:secret@example.com:8080#Test',
 'anytls://secret@example.com:443?sni=example.com#Test',`tuic://${uuid}:secret:with-colon@example.com:443?sni=example.com#Test`,
 'ssh://user:secret@example.com:22#Test','hysteria://example.com:443?auth=secret&peer=example.com#Test',
 'shadowtls://secret@example.com:443?sni=example.com#Test','snell://secret@example.com:443#Test'
]
for(const uri of probeLinks) test('standalone probe retains '+uri.split(':')[0]+' parameters without VPN or rule files',()=>{
 const catalog=importQuickNodes(emptyQuickCatalog(),uri)
 const original=structuredClone(catalog)
 const config=JSON.parse(buildNodeTestConfig(catalog.nodes[0]))
 assert.equal(config.outbounds.length, 1)
 assert.equal(config.outbounds[0].tag, 'node-test')
 assert.equal(config.outbounds[0].server, 'example.com')
 for(const field of ['inbounds','endpoints','services','experimental']) assert.equal(config[field],undefined)
 assert.equal(config.route.rule_set,undefined)
 assert.equal(config.route.final,'node-test')
 assert.equal(config.route.auto_detect_interface,false,'OHOS sockets use the public descriptor binding path')
 assert.deepEqual(catalog,original)
})

function fixture() {
 const threads:any[]=[]
 class Thread {
  messages:any[]=[]; onmessage:any; onerror:any
  constructor(_path:string){threads.push(this)}
  postMessage(message:any){this.messages.push(message)}
 }
 const source=readFileSync(new URL('../../entry/src/main/ets/services/NodeProbeService.ts',import.meta.url),'utf8')
  .replace(/import[^\n]+\n/g,'').replace('export class','class')
 const C=vm.runInNewContext(stripTypeScriptTypes(source)+'\nNodeProbeService',{worker:{ThreadWorker:Thread},nodeProbeErrorLabel})
 return {service:new C(),threads}
}
test('probe is lazy and correlates replies; stale replies cannot complete another node',async()=>{
 const {service,threads}=fixture();assert.equal(threads.length,0)
 const first=service.test('{}');assert.equal(threads.length,1)
 const thread=threads[0];thread.onmessage({data:{id:0,delay:99,error:''}})
 thread.onmessage({data:{id:1,delay:123,error:''}});assert.equal(await first,123)
 const next=service.test('{}');thread.onmessage({data:{id:1,delay:456,error:''}})
 thread.onmessage({data:{id:2,delay:234,error:''}});assert.equal(await next,234)
 service.close();assert.equal(thread.messages.at(-1).type,'close')
})
test('closing rejects active work and asks worker to cancel and clean up',async()=>{
 const {service,threads}=fixture();const pending=service.test('{}')
 service.close();await assert.rejects(pending,/取消/)
 assert.equal(threads[0].messages.at(-1).type,'close')
 await assert.rejects(service.test('{}'),/取消/)
})
test('one worker request at a time and native failures remain failures',async()=>{
 const {service,threads}=fixture();const pending=service.test('{}')
 await assert.rejects(service.test('{}'),/进行/)
 threads[0].onmessage({data:{id:1,delay:-1,error:''}})
 await assert.rejects(pending,/失败/);service.close()
})

test('only timeouts are labelled timeout; initialization, TLS and DNS stay distinct',()=>{
 for(const [raw,want] of [['context deadline exceeded','超时'],['probe-start: failed','初始化失败'],['lookup host: no such host','DNS 失败'],['x509 certificate unknown authority','TLS 失败'],['connection refused','连接失败'],['OH_NetConn_BindSocket failed','网络不可用']]) assert.equal(nodeProbeErrorLabel(nodeProbeErrorCode(raw)),want)
 assert.equal(nodeProbeErrorLabel('attacker text with credentials'),'测速失败')
})

test('worker sends a safe initialization category instead of hiding native errors',async()=>{
 const source=readFileSync(new URL('../../entry/src/main/ets/workers/NodeProbeWorker.ets',import.meta.url),'utf8').replace(/import[^\n]+\n/g,'')
 const messages:any[]=[]
 const port:any={postMessage:(value:any)=>messages.push(value),close:()=>{}}
 vm.runInNewContext(stripTypeScriptTypes(source),{worker:{workerPort:port},nodeProbeErrorCode,Error,nativeCore:{initialize:async()=>{},testConfig:async()=>{throw Error('probe-start: secret-credential.example')},control:async()=>{}}})
 await port.onmessage({data:{type:'test',id:1,config:'{}',filesDir:'/files',cacheDir:'/cache'}})
 assert.equal(messages[0].error,'init');assert.equal(messages[0].delay,-1)
 assert.ok(!JSON.stringify(messages).includes('secret-credential'))
})

test('manual probe initializes its own native process once before testing', async()=>{
 const source=readFileSync(new URL('../../entry/src/main/ets/workers/NodeProbeWorker.ets',import.meta.url),'utf8').replace(/import[^\n]+\n/g,'')
 const calls:string[]=[];const replies:any[]=[]
 const port:any={postMessage:(v:any)=>replies.push(v),close:()=>{}}
 vm.runInNewContext(stripTypeScriptTypes(source),{worker:{workerPort:port},nodeProbeErrorCode,Error,nativeCore:{initialize:async(a:string,b:string)=>{calls.push(a,b)},testConfig:async()=>{assert.equal(calls.length,2);return 73},control:async()=>{}}})
 for(let id=1;id<=2;id++) await port.onmessage({data:{type:'test',id,config:'{}',filesDir:'/sandbox/files',cacheDir:'/sandbox/cache'}})
 assert.deepEqual(calls,['/sandbox/files/node-probe','/sandbox/cache/node-probe'])
 assert.equal(replies.length,2);assert.ok(replies.every(v=>v.delay===73))
})
test('failed native setup never submits a node test',async()=>{
 const source=readFileSync(new URL('../../entry/src/main/ets/workers/NodeProbeWorker.ets',import.meta.url),'utf8').replace(/import[^\n]+\n/g,'')
 let tested=false;const replies:any[]=[];const port:any={postMessage:(v:any)=>replies.push(v),close:()=>{}}
 vm.runInNewContext(stripTypeScriptTypes(source),{worker:{workerPort:port},nodeProbeErrorCode,Error,nativeCore:{initialize:async()=>{throw Error('private-path')},testConfig:async()=>{tested=true},control:async()=>{}}})
 await port.onmessage({data:{type:'test',id:1,config:'{}',filesDir:'/f',cacheDir:'/c'}})
 assert.equal(tested,false);assert.equal(replies[0].error,'init');assert.ok(!JSON.stringify(replies).includes('private-path'))
})
