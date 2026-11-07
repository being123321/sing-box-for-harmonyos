# HarmonyOS outbound socket binding

The embedded sing-box core binds every newly created outbound file descriptor
to a physical underlay with public HarmonyOS NetworkKit NDK APIs. It does not
call any private internal socket-marking protocol.

## SDK ABI pinned by the build

The API 26 SDK bundled with DevEco Studio declares these interfaces in
`network/netmanager/net_connection.h` and links them from
`libnet_connection.so`:

- `OH_NetConn_GetDefaultNet(NetConn_NetHandle *)`, introduced in API 11.
- `OH_NetConn_GetNetCapabilities(NetConn_NetHandle *, NetConn_NetCapabilities *)`, introduced in API 11.
- `OH_NetConn_BindSocket(int32_t, NetConn_NetHandle *)`, introduced in API 12.

The C shim contains compile-time checks for those function signatures and for
the capability and bearer enum values it consumes. These APIs are below the
application's API 22 compatibility floor.

## Fail-closed selection

For each descriptor, the core reads the system default activated network,
queries its capabilities, then reads the default again. A changed default
invalidates the snapshot. The default is eligible only when all of these
statements are true:

- its network ID is positive;
- it contains `INTERNET`, `NOT_VPN`, and `VALIDATED` capabilities;
- it has a Wi-Fi or cellular bearer;
- it does not contain a VPN bearer.

Another connected Wi-Fi network or a still-validated previous data SIM never
overrides the system default. Ethernet, Bluetooth, VPN, unvalidated, portal,
capability-incomplete, and malformed defaults are rejected. A default-read,
capability, or bind error fails that connection; there is no fallback to an
arbitrary connected network, an unbound default route, or a private service.

No network handle is cached. Concurrent connection attempts use independent
stack-local snapshots. If a network changes between the final default read and
`BindSocket`, that bind is allowed to fail; the next file descriptor performs a
fresh default read and can select the new underlay. ETS network-change detection
and probe DNS use the same default/capability policy.

## Verification boundary

Host unit tests cover eligibility, default-data SIM changes, fail-closed error
propagation, concurrent calls, and fresh reads after a simulated SIM handoff.
ETS tests also cover a default change during a snapshot. The ARM64 cross-build
proves the NDK headers and dynamic link
contract. Only real-device testing can prove runtime permissions, service
behavior, traffic bypass, Wi-Fi/cellular handover, and absence of VPN routing
loops on a shipping HarmonyOS build.
