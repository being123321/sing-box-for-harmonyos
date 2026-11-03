export interface ProfileNode { tag: string; type: string; json: string }
export interface NodeCopyResult { content: string; tag: string }

function config(text: string): Record<string, Object> {
  const value: Record<string, Object> = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, Object>
  if (!value || Array.isArray(value) || !Array.isArray(value.outbounds)) throw new Error('配置缺少 outbounds')
  const seen: string[] = []
  for (const item of value.outbounds as Record<string, Object>[]) {
    if (!item || typeof item.tag !== 'string' || !item.tag || typeof item.type !== 'string' || seen.includes(item.tag)) throw new Error('节点标识为空或重复，无法安全编辑')
    seen.push(item.tag)
  }
  return value
}

export function profileNodes(text: string): ProfileNode[] {
  return (config(text).outbounds as Record<string, Object>[])
    .filter((item: Record<string, Object>) => !['direct','block','dns','selector','urltest'].includes(item.type as string))
    .map((item: Record<string, Object>): ProfileNode => ({tag:item.tag as string,type:item.type as string,json:JSON.stringify(item,null,2)}))
}

export function editProfileNode(text: string, tag: string, json: string): string {
  const value: Record<string, Object> = config(text)
  const outbounds: Record<string, Object>[] = value.outbounds as Record<string, Object>[]
  const index: number = outbounds.findIndex((item: Record<string, Object>) => item.tag === tag)
  if (index < 0) throw new Error('原节点已更新，请重新打开编辑')
  const edited: Record<string, Object> = JSON.parse(json) as Record<string, Object>
  if (!edited || Array.isArray(edited) || edited.tag !== tag || typeof edited.type !== 'string') throw new Error('请保留原节点 tag，避免破坏策略组引用')
  outbounds[index] = edited
  return JSON.stringify(value,null,2)
}

// Copy exact outbound JSON with its outbound/DNS dependency closure. Colliding
// dependency tags are renamed and references remapped; original stays intact.
export function copyProfileNode(sourceText: string, root: string, targetText: string, replace: boolean): NodeCopyResult {
  const source: Record<string, Object> = config(sourceText)
  const target: Record<string, Object> = config(targetText)
  const sourceOut: Record<string, Object>[] = source.outbounds as Record<string, Object>[]
  const targetOut: Record<string, Object>[] = target.outbounds as Record<string, Object>[]
  if (!profileNodes(sourceText).some((item: ProfileNode) => item.tag === root)) throw new Error('请选择真实节点')
  const sourceDns: Record<string, Object> = (source.dns || {}) as Record<string, Object>
  const targetDns: Record<string, Object> = (target.dns || {}) as Record<string, Object>
  const dnsServers: Record<string, Object>[] = (sourceDns.servers || []) as Record<string, Object>[]
  const destDns: Record<string, Object>[] = (targetDns.servers || []) as Record<string, Object>[]
  const copying: Record<string, Object>[] = []
  const copyingDns: Record<string, Object>[] = []
  const visited: string[] = []; const visiting: string[] = []
  function collect(tag: string, dns: boolean): void {
    const key: string = (dns ? 'dns:' : 'out:') + tag
    if (visited.includes(key)) return
    if (visiting.includes(key)) throw new Error('节点依赖存在循环，未复制')
    const item: Record<string, Object> | undefined = (dns ? dnsServers : sourceOut).find((entry: Record<string, Object>) => entry.tag === tag)
    if (!item) throw new Error('节点依赖不存在：' + tag)
    visiting.push(key)
    if (typeof item.detour === 'string' && item.detour) collect(item.detour, false)
    if (Array.isArray(item.outbounds)) for (const child of item.outbounds as string[]) collect(child, false)
    const resolver: Object = item.domain_resolver
    if (typeof resolver === 'string' && resolver) collect(resolver, true)
    else if (resolver && typeof (resolver as Record<string, Object>).server === 'string') collect((resolver as Record<string, Object>).server as string, true)
    // A server without a resolver can depend on the profile-wide resolver.
    const sourceRoute: Record<string, Object> = (source.route || {}) as Record<string, Object>
    if (!dns && !resolver && typeof item.server === 'string' && !/^[\d.:]+$/.test(item.server as string) && typeof sourceRoute.default_domain_resolver === 'string') {
      item.domain_resolver = sourceRoute.default_domain_resolver
      collect(sourceRoute.default_domain_resolver as string, true)
    }
    visiting.pop(); visited.push(key)
    if (dns) copyingDns.push(item); else copying.push(item)
  }
  collect(root,false)
  const outMap: Map<string,string> = new Map(); const dnsMap: Map<string,string> = new Map()
  const existing: Record<string, Object> | undefined = targetOut.find((item: Record<string, Object>) => item.tag === root)
  if (replace && existing && !profileNodes(targetText).some((item: ProfileNode) => item.tag === root)) throw new Error('同名对象是策略组或系统出站，不能替换')
  function names(items: Record<string, Object>[], destination: Record<string, Object>[], mapping: Map<string,string>, outbound: boolean): void {
    const used: string[] = destination.map((item: Record<string, Object>) => item.tag as string)
    for (const item of items) {
      const old: string = item.tag as string
      let next: string = old
      if (!(outbound && old === root && replace)) { let suffix: number = 2; while (used.includes(next)) next = old + ' (复制 ' + suffix++ + ')' }
      used.push(next); mapping.set(old,next)
    }
  }
  names(copying,targetOut,outMap,true); names(copyingDns,destDns,dnsMap,false)
  function remap(item: Record<string, Object>, mapping: Map<string,string>): Record<string, Object> {
    const cloned: Record<string, Object> = JSON.parse(JSON.stringify(item)) as Record<string, Object>
    cloned.tag = mapping.get(item.tag as string) || item.tag
    if (typeof item.detour === 'string') cloned.detour = outMap.get(item.detour) || item.detour
    if (Array.isArray(item.outbounds)) cloned.outbounds = (item.outbounds as string[]).map((tag: string) => outMap.get(tag) || tag)
    if (typeof item.default === 'string') cloned.default = outMap.get(item.default) || item.default
    if (typeof item.domain_resolver === 'string') cloned.domain_resolver = dnsMap.get(item.domain_resolver) || item.domain_resolver
    else if (item.domain_resolver && typeof (item.domain_resolver as Record<string, Object>).server === 'string') {
      const resolver: Record<string, Object> = cloned.domain_resolver as Record<string, Object>
      resolver.server = dnsMap.get(resolver.server as string) || resolver.server
    }
    return cloned
  }
  target.outbounds = [...targetOut.filter((item: Record<string, Object>) => !(replace && item.tag === root)), ...copying.map((item: Record<string, Object>) => remap(item,outMap))]
  const finalTag:Object=((target.route || {}) as Record<string,Object>).final
  const primary:Record<string,Object>|undefined=targetOut.find((item:Record<string,Object>)=>item.type==='selector'&&item.tag===finalTag)||
    targetOut.find((item:Record<string,Object>)=>item.type==='selector'&&String(item.tag).toLowerCase()==='proxy')||
    targetOut.find((item:Record<string,Object>)=>item.type==='selector')
  const inserted:string=outMap.get(root)||root
  if(primary&&Array.isArray(primary.outbounds)&&!(primary.outbounds as string[]).includes(inserted))primary.outbounds=[...primary.outbounds as string[],inserted]
  if (copyingDns.length > 0) { targetDns.servers = [...destDns,...copyingDns.map((item: Record<string, Object>) => remap(item,dnsMap))]; target.dns = targetDns }
  return {content:JSON.stringify(target,null,2),tag:outMap.get(root) || root}
}

export function standaloneProfileNode(source: string, tag: string): string {
  const result: NodeCopyResult = copyProfileNode(source,tag,'{"outbounds":[]}',false)
  const value: Record<string,Object> = JSON.parse(result.content) as Record<string,Object>
  value.route = {final:result.tag}
  const original:Record<string,Object>=config(source)
  if(original.certificate)value.certificate=original.certificate
  return JSON.stringify(value,null,2)
}

function canonical(value: Object): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + (value as Object[]).map((item: Object) => canonical(item)).join(',') + ']'
  const record: Record<string,Object> = value as Record<string,Object>
  return '{' + Object.keys(record).sort().map((key: string) => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}'
}

export function sameProfileNode(source: string, tag: string, target: string, targetTag: string = tag): boolean {
  try {
    const left:Record<string,Object>=JSON.parse(standaloneProfileNode(source,tag)) as Record<string,Object>
    const right:Record<string,Object>=JSON.parse(standaloneProfileNode(target,targetTag)) as Record<string,Object>
    for(const item of left.outbounds as Record<string,Object>[])if(item.tag===tag)item.tag='comparison-root'
    for(const item of right.outbounds as Record<string,Object>[])if(item.tag===targetTag)item.tag='comparison-root'
    left.route={final:'comparison-root'};right.route={final:'comparison-root'}
    return canonical(left)===canonical(right)
  }
  catch (_) { return false }
}
