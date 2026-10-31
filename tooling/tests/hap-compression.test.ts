import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { verifyHapCompression } from '../../scripts/verify-hap-compression.mjs'

function fixture(compress: boolean, policy: boolean) {
 const files = [
  ['module.json', Buffer.from(JSON.stringify({app:{versionName:'test'},module:{compressNativeLibs:policy,extractNativeLibs:true}}))],
  ['libs/arm64-v8a/libharmonycore.so', Buffer.alloc(2 * 1024 * 1024, 42)]
 ] as const
 const locals: Buffer[] = [], central: Buffer[] = []
 let offset = 0
 for (const [name, data] of files) {
  const n = Buffer.from(name), packed = compress ? deflateRawSync(data) : data, method = compress ? 8 : 0
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50); header.writeUInt16LE(method,8)
  header.writeUInt32LE(packed.length,18); header.writeUInt32LE(data.length,22); header.writeUInt16LE(n.length,26)
  const entry = Buffer.alloc(46)
  entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(method,10)
  entry.writeUInt32LE(packed.length,20); entry.writeUInt32LE(data.length,24)
  entry.writeUInt16LE(n.length,28); entry.writeUInt32LE(offset,42)
  locals.push(header,n,packed); central.push(entry,n)
  offset += header.length + n.length + packed.length
 }
 const directory=Buffer.concat(central), end=Buffer.alloc(22)
 end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length,8); end.writeUInt16LE(files.length,10)
 end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16)
 return Buffer.concat([...locals,directory,end])
}

for (const [name, compressed, policy, accept] of [
 ['accepts actual deflated core',true,true,true],
 ['rejects stored core even with enabled config',false,true,false],
 ['rejects missing compression policy',true,false,false]
] as const) test(name, t => {
 const dir=mkdtempSync(join(tmpdir(),'hap-compression-')), path=join(dir,'test.hap')
 t.after(()=>{unlinkSync(path);rmdirSync(dir)})
 writeFileSync(path,fixture(compressed,policy))
 if(accept) assert.equal(verifyHapCompression(path).libraries[0].method,'deflate')
 else assert.throws(()=>verifyHapCompression(path))
})

test('all channel builds inherit native compression and extraction in the module', () => {
 const module=JSON.parse(readFileSync(new URL('../../entry/src/main/module.json5', import.meta.url),'utf8')).module
 assert.equal(module.compressNativeLibs,true)
 assert.equal(module.extractNativeLibs,true)
})
