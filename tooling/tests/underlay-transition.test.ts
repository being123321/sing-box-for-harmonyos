import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyUnderlayTransition as classify } from '../../entry/src/main/ets/domain/UnderlayTransition.ts'

const base={id:10,kind:'cellular',interface:'rmnet0',addresses:['2001:db8::2/64','10.0.0.2/24'],dns:['1.1.1.1']}
const signature=(extra: object={})=>JSON.stringify({...base,...extra})

test('invalid or absent next network waits; a first valid snapshot does not rebuild',()=>{
 for(const invalid of ['none','broken','null','[]',signature({id:0}),signature({kind:'vpn'}),signature({interface:''}),signature({addresses:[1]})]) {
  assert.equal(classify(signature(),invalid,true,false),'wait')
 }
 assert.equal(classify('',signature(),true,false),'unchanged')
 assert.equal(classify('',signature(),true,true),'reset')
})

test('SIM, interface, or address replacement rebuilds IPv6 routes but only resets IPv4',()=>{
 for(const extra of [{id:11},{interface:'rmnet1'},{addresses:['2001:db8:1::2/64']},{kind:'wifi'}]) {
  assert.equal(classify(signature(),signature(extra),true,false),'rebuild')
  assert.equal(classify(signature(),signature(extra),false,false),'reset')
 }
})

test('signal/radio generation and address ordering changes do not churn TUN',()=>{
 const current=signature({addresses:[...base.addresses].reverse(),radio:'5G',signal:-70})
 assert.equal(classify(signature({radio:'4G',signal:-100}),current,true,false),'unchanged')
 assert.equal(classify(signature(),signature({addresses:[...base.addresses,base.addresses[0]]}),true,false),'unchanged')
})

test('a validation interruption or DNS-only change clears stale connections without replacing TUN',()=>{
 assert.equal(classify(signature(),signature(),true,true),'reset')
 assert.equal(classify(signature(),signature({dns:['8.8.8.8']}),true,false),'reset')
})
