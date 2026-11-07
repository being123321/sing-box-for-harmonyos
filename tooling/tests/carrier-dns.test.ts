import test from 'node:test'
import assert from 'node:assert/strict'
import {automaticLocalDnsConfig,networkDnsAddresses} from '../../entry/src/main/ets/domain/CarrierDns.ts'

test('automatic DNS changes local/direct transports while preserving proxy DNS and routing',()=>{
 const input={outbounds:[{tag:'DIRECT',type:'direct'},{tag:'proxy',type:'selector'}],dns:{final:'remote',rules:[{domain_suffix:['test'],server:'dns-local'}],servers:[
  {tag:'dns-local',type:'https',server:'223.5.5.5'},
  {tag:'physical',type:'udp',server:'1.1.1.1',detour:'DIRECT'},
  {tag:'remote',type:'https',server:'dns.example.test',detour:'proxy'},
  {tag:'local',type:'https',server:'proxy-dns.example.test',detour:'proxy'},
  {tag:'system',type:'local'},
  {tag:'custom',type:'https',server:'9.9.9.9'}]}}
 const text=JSON.stringify(input);const result=JSON.parse(automaticLocalDnsConfig(text))
 for(const tag of ['dns-local','physical','system'])assert.equal(result.dns.servers.find((s:any)=>s.tag===tag).type,'harmony-network')
 for(const tag of ['remote','local','custom'])assert.deepEqual(result.dns.servers.find((s:any)=>s.tag===tag),input.dns.servers.find(s=>s.tag===tag))
 assert.deepEqual(result.dns.rules,input.dns.rules);assert.equal(result.dns.final,'remote');assert.equal(JSON.stringify(input),text)
})
test('remote-only configuration stays byte-identical; missing physical data never supplies a fallback resolver',()=>{
 const text='{"dns":{"servers":[{"tag":"remote","type":"https","detour":"proxy","server":"dns.example.test"}]}}'
 assert.equal(automaticLocalDnsConfig(text),text)
 assert.deepEqual(networkDnsAddresses('none'),[])
 assert.deepEqual(networkDnsAddresses('{"kind":"vpn","dns":["172.19.0.2"]}'),[])
 assert.deepEqual(networkDnsAddresses('{"kind":"cellular","dns":["10.0.0.1","10.0.0.1","240e::53"]}'),['10.0.0.1','240e::53'])
})
