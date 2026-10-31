// Run on the final unsigned HAP before signing/uploading. Repacking a signed
// HAP would invalidate its signature; compression belongs in module.json5.
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

export function verifyHapCompression(path) {
 const b = readFileSync(path);
 let end = b.length - 22;
 const lower = Math.max(0, b.length - 65557);
 while (end >= lower && b.readUInt32LE(end) !== 0x06054b50) end--;
 if (end < lower) throw Error('Missing ZIP directory');
 const count = b.readUInt16LE(end + 10);
 let pos = b.readUInt32LE(end + 16);
 const entries = new Map();
 for (let i = 0; i < count; i++) {
  if (b.readUInt32LE(pos) !== 0x02014b50) throw Error('Invalid ZIP directory');
  const method = b.readUInt16LE(pos + 10), compressed = b.readUInt32LE(pos + 20), size = b.readUInt32LE(pos + 24);
  const n = b.readUInt16LE(pos + 28), extra = b.readUInt16LE(pos + 30), comment = b.readUInt16LE(pos + 32);
  const name = b.subarray(pos + 46, pos + 46 + n).toString('utf8');
  if (entries.has(name)) throw Error('Duplicate ZIP entry');
  entries.set(name, { method, compressed, size, offset: b.readUInt32LE(pos + 42) });
  pos += 46 + n + extra + comment;
 }
 const module = entries.get('module.json');
 if (!module) throw Error('Missing module.json');
 const offset = module.offset;
 if (b.readUInt32LE(offset) !== 0x04034b50) throw Error('Invalid module entry');
 const start = offset + 30 + b.readUInt16LE(offset + 26) + b.readUInt16LE(offset + 28);
 const payload = b.subarray(start, start + module.compressed);
 const metadata = JSON.parse((module.method === 8 ? inflateRawSync(payload) : payload).toString('utf8'));
 if (metadata.module.compressNativeLibs !== true || metadata.module.extractNativeLibs === false) throw Error('Native compression/extraction policy missing');
 const libraries = [...entries].filter(([name, e]) => name.startsWith('libs/') && name.endsWith('.so') && e.size > 1024 * 1024);
 if (!entries.has('libs/arm64-v8a/libharmonycore.so') || libraries.length === 0) throw Error('Missing core library');
 for (const [name, e] of libraries) {
  if (e.method !== 8 || e.compressed >= e.size) throw Error('Uncompressed native library: ' + name);
 }
 return { app: metadata.app.versionName, bundle: metadata.app.bundleName, versionCode: metadata.app.versionCode,
  hapBytes: b.length, libraries: libraries.map(([name, e]) => ({name, rawBytes: e.size, compressedBytes: e.compressed, method: 'deflate'})) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 if (!process.argv[2]) throw Error('Usage: node scripts/verify-hap-compression.mjs package.hap');
 console.log(JSON.stringify(verifyHapCompression(process.argv[2]), null, 2));
}
