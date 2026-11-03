import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeRetainedProfileNodes, parseSfaCatalog, type SfaProfile } from '../../entry/src/main/ets/domain/SfaProfiles.ts'

const original = JSON.stringify({outbounds:[
  {type:'socks',tag:'added',server:'local.invalid',server_port:1080,detour:'helper',custom_option:true},
  {type:'socks',tag:'helper',server:'helper.invalid',server_port:1080},
  {type:'socks',tag:'remote',server:'old.invalid',server_port:1080}
]})
const downloaded = JSON.stringify({outbounds:[
  {type:'socks',tag:'remote',server:'new.invalid',server_port:1080},
  {type:'selector',tag:'proxy',outbounds:['remote'],default:'remote'}
],route:{final:'proxy'}})
const profile: SfaProfile = {id:'r',name:'test',kind:'remote',url:'https://example.invalid/config',content:original,updatedAt:1}

test('subscription refresh preserves opted-in nodes and dependencies while updating remote nodes',()=>{
  const protectedProfile={...profile,retainedNodeTags:['added']}
  const result=JSON.parse(mergeRetainedProfileNodes(protectedProfile,downloaded))
  assert.equal(result.outbounds.find((n:any)=>n.tag==='added').custom_option,true)
  assert.ok(result.outbounds.some((n:any)=>n.tag===result.outbounds.find((n:any)=>n.tag==='added').detour))
  assert.equal(result.outbounds.find((n:any)=>n.tag==='remote').server,'new.invalid')
  assert.equal(result.outbounds.find((n:any)=>n.tag==='proxy').default,'remote')
  assert.ok(result.outbounds.find((n:any)=>n.tag==='proxy').outbounds.includes('added'))
  assert.equal(mergeRetainedProfileNodes(profile,downloaded),downloaded)
  assert.equal(profile.content,original)
})

test('protected same-name node wins over remote replacement across repeated updates',()=>{
  const p={...profile,retainedNodeTags:['remote']}
  const once=mergeRetainedProfileNodes(p,downloaded)
  const twice=mergeRetainedProfileNodes({...p,content:once},downloaded)
  const result=JSON.parse(twice)
  assert.equal(result.outbounds.filter((n:any)=>n.tag==='remote').length,1)
  assert.equal(result.outbounds.find((n:any)=>n.tag==='remote').server,'old.invalid')
})

test('retention survives catalog round trip and legacy catalogs remain compatible',()=>{
  const catalog={version:1,selectedId:'r',profiles:[{...profile,retainedNodeTags:['added']}]}
  assert.deepEqual(parseSfaCatalog(JSON.stringify(catalog)).profiles[0].retainedNodeTags,['added'])
  assert.equal(parseSfaCatalog(JSON.stringify({...catalog,profiles:[profile]})).profiles[0].retainedNodeTags,undefined)
  assert.throws(()=>parseSfaCatalog(JSON.stringify({...catalog,profiles:[{...profile,retainedNodeTags:[3]}]})))
  assert.equal(mergeRetainedProfileNodes({...profile,content:'{}'},'{}'),'{}')
})
