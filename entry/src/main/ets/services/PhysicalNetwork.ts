import { connection } from '@kit.NetworkKit'

interface PhysicalSignature { id: number; kind: string; interface: string; addresses: string[]; dns: string[] }

// getDefaultNet is the system's activated physical data network, not the VPN
// (NetworkKit API contract). Match the native per-socket binding policy.
// The signature stays private and is never written to logs or runtime IPC.
export async function physicalNetworkSignature(): Promise<string> {
  const selected: connection.NetHandle = await connection.getDefaultNet()
  if (selected.netId <= 0) return 'none'
  const caps: connection.NetCapabilities = await connection.getNetCapabilities(selected)
  if (caps.bearerTypes.includes(connection.NetBearType.BEARER_VPN) ||
    !caps.networkCap?.includes(connection.NetCap.NET_CAPABILITY_INTERNET) ||
    !caps.networkCap?.includes(connection.NetCap.NET_CAPABILITY_NOT_VPN) ||
    !caps.networkCap?.includes(connection.NetCap.NET_CAPABILITY_VALIDATED)) return 'none'
  const wifi: boolean = caps.bearerTypes.includes(connection.NetBearType.BEARER_WIFI)
  if (!wifi && !caps.bearerTypes.includes(connection.NetBearType.BEARER_CELLULAR)) return 'none'
  const properties: connection.ConnectionProperties = await connection.getConnectionProperties(selected)
  // If default data switched SIM while reading properties, this is not a
  // coherent snapshot. Retry later instead of reporting the former network.
  if ((await connection.getDefaultNet()).netId !== selected.netId) throw new Error('默认物理网络正在切换')
  const signature: PhysicalSignature = { id: selected.netId, kind: wifi ? 'wifi' : 'cellular', interface: properties.interfaceName,
    addresses: properties.linkAddresses.map((item: connection.LinkAddress) => item.address.address + '/' + item.prefixLength).sort(),
    dns: properties.dnses.map((item: connection.NetAddress) => item.address).sort() }
  return JSON.stringify(signature)
}

// Bootstrap proxy hostnames against the physical network's DNS, never the
// active custom VPN's resolver (which may supply FakeIP or reject the node).
export async function physicalProbeDns(): Promise<string> {
  const text: string = await physicalNetworkSignature()
  if (text === 'none') throw new Error('网络不可用')
  const snapshot: PhysicalSignature = JSON.parse(text) as PhysicalSignature
  const servers: string[] = snapshot.dns.filter((address: string) => address.length > 0 && !address.includes('%'))
  const selected: string | undefined = servers.find((address: string) => !address.includes(':')) || servers[0]
  if (!selected) throw new Error('DNS 失败')
  return selected
}
