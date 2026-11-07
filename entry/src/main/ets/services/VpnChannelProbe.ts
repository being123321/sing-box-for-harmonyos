import { connection } from '@kit.NetworkKit'
export type VpnChannelState = 'owned' | 'absent' | 'foreign' | 'unknown'
export interface VpnChannelSample { state: VpnChannelState; netId: number }

// A failed inventory is unknown, never evidence that a VPN disappeared.
// Discovery is allowed only while this Extension owns a successfully created TUN.
export async function probeVpnChannel(ownedId: number): Promise<VpnChannelSample> {
  try {
    let vpnCount: number = 0
    let matched: number = -1
    let ambiguous: boolean = false
    for (const handle of await connection.getAllNets()) {
      const caps: connection.NetCapabilities = await connection.getNetCapabilities(handle)
      if (!caps.bearerTypes.includes(connection.NetBearType.BEARER_VPN)) continue
      vpnCount++
      const properties: connection.ConnectionProperties = await connection.getConnectionProperties(handle)
      const addresses: string[] = properties.linkAddresses.map((item: connection.LinkAddress) => item.address.address)
        .filter((address: string) => address.length > 0 && address !== '0.0.0.0' && address !== '::')
      // Link properties can lag a newly published network handle. Missing or
      // unspecified addresses do not establish that a different VPN owns it.
      if (addresses.length === 0) { ambiguous = true; continue }
      const ours: boolean = addresses.includes('172.19.0.1') || addresses.includes('fdfe:dcba:9876::1')
      if (ours) {
        if (ownedId === -1 || ownedId === handle.netId) matched = handle.netId
        // A changed netId, or the -2 recovery quarantine, cannot be adopted
        // from a shared address fingerprint. It is not proof of foreignness
        // either: keep supervision alive while ownership remains unresolved.
        else ambiguous = true
      }
    }
    if (vpnCount === 0) return { state: 'absent', netId: -1 }
    if (ambiguous) return { state: 'unknown', netId: -1 }
    if (matched >= 0) return vpnCount === 1 ? { state: 'owned', netId: matched } : { state: 'unknown', netId: -1 }
    return { state: 'foreign', netId: -1 }
  } catch (_) { return { state: 'unknown', netId: -1 } }
}
