import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { emptyQuickCatalog, importQuickNodes, parseQuickCatalog, quickNode } from '../../entry/src/main/ets/domain/QuickStart.ts'
import { SubscriptionParser } from '../../entry/src/main/ets/domain/SubscriptionParser.ts'
import { encodeBase64Text } from '../../entry/src/main/ets/domain/TextCodec.ts'
import { writeFully } from '../../entry/src/main/ets/domain/CompleteWrite.ts'

const uuid = '11111111-2222-3333-4444-555555555555'
const links: Record<string, string> = {
  vless: `vless://${uuid}@example.com:443?security=tls&sni=example.com#Test`,
  vmess: 'vmess://' + encodeBase64Text(JSON.stringify({add:'example.com',port:'443',id:uuid,scy:'auto',net:'tcp',ps:'Test'})),
  shadowsocks: 'ss://' + encodeBase64Text('aes-128-gcm:secret') + '@example.com:8388#Test',
  trojan: 'trojan://secret@example.com:443?sni=example.com#Test',
  hysteria2: 'hy2://secret@example.com:443?sni=example.com#Test',
  socks: 'socks://user:secret@example.com:1080#Test', http: 'http://user:secret@example.com:8080#Test',
  anytls: 'anytls://secret@example.com:443?sni=example.com#Test',
  tuic: `tuic://${uuid}:secret:with-colon@example.com:443?sni=example.com#Test`,
  ssh: 'ssh://user:secret@example.com:22#Test', hysteria: 'hysteria://example.com:443?auth=secret&peer=example.com#Test',
  shadowtls:'shadowtls://secret@example.com:443?sni=example.com#Test', snell:'snell://secret@example.com:443#Test'
}
for (const [protocol, uri] of Object.entries(links)) {
  test(`node library imports ${protocol} and preserves original share URI`, () => {
    const catalog = importQuickNodes(emptyQuickCatalog(), uri)
    assert.equal(catalog.nodes.length, 1)
    assert.equal(quickNode(catalog.nodes[0]).protocol, protocol)
    assert.equal(catalog.nodes[0].uri, uri)
  })
}
test('mixed and base64 subscriptions preserve new protocol credentials and stable stored IDs', () => {
  const body = [links.anytls, links.vless, links.tuic].join('\n')
  const source = {id:'source',name:'Subscription',url:'https://example.com/sub',updatedAt:1}
  const catalog = importQuickNodes(emptyQuickCatalog(), encodeBase64Text(body), source)
  assert.equal(catalog.nodes.length, 3)
  assert.deepEqual(catalog.nodes.map(entry => entry.uri), body.split('\n'))
  const restored = parseQuickCatalog(JSON.stringify(catalog))
  const refreshed = importQuickNodes(restored, body, {...source, updatedAt:2})
  assert.deepEqual(refreshed.nodes, catalog.nodes)
  const legacy = {...restored, nodes:[{...restored.nodes[0], id:'existing-user-id'}]}
  assert.equal(parseQuickCatalog(JSON.stringify(legacy)).nodes[0].id, 'existing-user-id')
})

function installFixture(existing: Record<string, number[]>) {
  const disk = new Map(Object.entries(existing).map(([key,value])=>['/files/builtin-rules-v1/'+key,new Uint8Array(value)]))
  let resourceReads = 0
  const fileIo = {OpenMode:{CREATE:1,READ_WRITE:2,TRUNC:4},access:async(path:string)=>disk.has(path)||path==='/files/builtin-rules-v1',mkdir:async()=>{},
    open:async(path:string)=>({fd:path}),write:async(path:string,chunk:ArrayBuffer)=>{disk.set(path,new Uint8Array(chunk));return chunk.byteLength},
    fsync:async()=>{},close:async()=>{},rename:async(a:string,b:string)=>{disk.set(b,disk.get(a)!);disk.delete(a)}}
  const source = readFileSync(new URL('../../entry/src/main/ets/services/BuiltinRules.ts',import.meta.url),'utf8').replace(/^import[^\n]+\n/gm,'').replace('export async function','async function')
  const context = vm.createContext({fileIo,writeFully})
  vm.runInContext(stripTypeScriptTypes(source)+'\nthis.run = installBuiltinRules',context)
  return {disk,run:()=>context.run({filesDir:'/files',resourceManager:{getRawFileContent:async()=>{resourceReads++;return new Uint8Array([1,2,3])}}}),reads:()=>resourceReads}
}
test('initialization preserves downloaded rule-sets and seeds only missing files', async () => {
  const fixture = installFixture({'cn.srs':[9,8],'gfw.srs':[7,6]})
  await fixture.run()
  assert.deepEqual([...fixture.disk.get('/files/builtin-rules-v1/cn.srs')!],[9,8])
  assert.deepEqual([...fixture.disk.get('/files/builtin-rules-v1/gfw.srs')!],[7,6])
  assert.deepEqual([...fixture.disk.get('/files/builtin-rules-v1/geoip-cn.srs')!],[1,2,3])
  assert.equal(fixture.reads(),1)
  await fixture.run(); assert.equal(fixture.reads(),1)
})

function updaterFixture(failThird: boolean) {
  const names=['cn.srs','geoip-cn.srs','gfw.srs']
  const directory='/files/builtin-rules-v1'
  const disk=new Map(names.map(name=>[directory+'/'+name,new Uint8Array([9,9,9])]))
  const urls:string[]=[]
  const fileIo={OpenMode:{CREATE:1,READ_WRITE:2,TRUNC:4},access:async(path:string)=>path===directory||disk.has(path),mkdir:async()=>{},
    open:async(path:string)=>({fd:path}),write:async(path:string,chunk:ArrayBuffer)=>{disk.set(path,new Uint8Array(chunk));return chunk.byteLength},
    fsync:async()=>{},close:async()=>{},rename:async(a:string,b:string)=>{disk.set(b,disk.get(a)!);disk.delete(a)},unlink:async(path:string)=>{disk.delete(path)}}
  const http={InterceptorType:{REDIRECTION:1,FINAL_RESPONSE:2},RequestMethod:{GET:'GET'},HttpDataType:{ARRAY_BUFFER:1},
    HttpInterceptorChain:class {addChain(){return true}apply(){return true}},
    createHttp:()=>({destroy:()=>{},request:async(url:string)=>{
      urls.push(url)
      if(failThird && urls.length===3)throw new Error('download failed')
      return {responseCode:200,result:new Uint8Array([0x53,0x52,0x53,4,1,2,3,4]).buffer}
    }})}
  class Guard {rejectedInsecureUrl(){return false}exceededInvocationLimit(){return false}observedUrl(){return true}}
  const source=readFileSync(new URL('../../entry/src/main/ets/services/BuiltinRuleUpdater.ts',import.meta.url),'utf8')
    .replace(/^import[^\n]+\n/gm,'').replace(/^export /gm,'')
  const context=vm.createContext({fileIo,http,HttpsUrlGuard:Guard,writeFully,ArrayBuffer,Uint8Array})
  vm.runInContext(stripTypeScriptTypes(source)+'\nthis.run=updateBuiltinRules',context)
  return {disk,urls,run:()=>context.run({filesDir:'/files'})}
}
test('failed rule download preserves all old files and removes staged candidates',async()=>{
  const fixture=updaterFixture(true)
  await assert.rejects(fixture.run(),/download failed/)
  assert.equal(fixture.disk.size,3)
  for(const bytes of fixture.disk.values())assert.deepEqual([...bytes],[9,9,9])
})
test('manual and automatic rule updates share one in-flight download',async()=>{
  const fixture=updaterFixture(false)
  const [first,second]=await Promise.all([fixture.run(),fixture.run()])
  assert.equal(first.totalBytes,24);assert.equal(second.totalBytes,24)
  assert.equal(fixture.urls.length,3)
  assert.equal(fixture.disk.size,3)
  for(const bytes of fixture.disk.values())assert.equal(bytes[0],0x53)
})
