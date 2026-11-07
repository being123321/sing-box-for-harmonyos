export interface AutomaticDnsPolicy { enabled: boolean }

// Only runtime copies are adapted. Keep tags, rules, remote DNS and the saved
// subscription JSON unchanged. Explicit proxy detours always take precedence.
export function automaticLocalDnsConfig(text:string):string {
  const value:Record<string,Object>=JSON.parse(text) as Record<string,Object>
  const dns:Record<string,Object>=(value.dns||{}) as Record<string,Object>
  if(!Array.isArray(dns.servers))return text
  const direct:string[]=((value.outbounds||[]) as Record<string,Object>[]).filter((item:Record<string,Object>)=>item.type==='direct').map((item:Record<string,Object>)=>item.tag as string)
  let changed:boolean=false
  dns.servers=(dns.servers as Record<string,Object>[]).map((server:Record<string,Object>):Record<string,Object>=>{
    if(server.detour && !direct.includes(server.detour as string))return server
    const tag:string=String(server.tag||'').toLowerCase()
    const local:boolean=server.type==='local'||server.address==='local'||['local','direct','dns-local','dns-direct'].includes(tag)||direct.includes(server.detour as string)
    if(!local)return server
    changed=true
    return {type:'harmony-network',tag:server.tag}
  })
  if(!changed)return text
  value.dns=dns
  return JSON.stringify(value)
}

export function networkDnsAddresses(signature:string):string[] {
  try {
    const value:Record<string,Object>=JSON.parse(signature) as Record<string,Object>
    if(!['wifi','cellular'].includes(value.kind as string)||!Array.isArray(value.dns))return []
    return Array.from(new Set((value.dns as string[]).filter((ip:string)=>typeof ip==='string'&&ip.length>0))).slice(0,8)
  }catch(_){return []}
}
