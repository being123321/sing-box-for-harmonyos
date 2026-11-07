//go:build openharmony

package main

/*
#cgo LDFLAGS: -lnet_connection

#include <stdint.h>
#include <string.h>
#include <network/netmanager/net_connection.h>
#include <network/netmanager/net_connection_type.h>

// Keep the Go boundary independent of the SDK structure layout. This shim is
// compiled against the installed HarmonyOS NDK headers and exposes only fixed
// width scalars to cgo.
enum {
    HNA_NET_FLAG_INTERNET = 1u << 0,
    HNA_NET_FLAG_NOT_VPN = 1u << 1,
    HNA_NET_FLAG_VALIDATED = 1u << 2,
    HNA_BEARER_FLAG_CELLULAR = 1u << 0,
    HNA_BEARER_FLAG_WIFI = 1u << 1,
    HNA_BEARER_FLAG_VPN = 1u << 2,
    HNA_NETCONN_INVALID_NET_LIST = -1001,
    HNA_NETCONN_INVALID_CAPABILITIES = -1002,
    HNA_NETCONN_INVALID_CANDIDATE_INDEX = -1003,
    HNA_NETCONN_NO_DEFAULT = -1004,
    HNA_NETCONN_DEFAULT_CHANGED = -1005,
};

typedef struct HnaNetCandidate {
    int32_t netId;
    uint32_t capabilityFlags;
    uint32_t bearerFlags;
} HnaNetCandidate;

typedef struct HnaNetSnapshot {
    int32_t size;
    HnaNetCandidate candidates[NETCONN_MAX_NET_SIZE];
} HnaNetSnapshot;

// Compile-time ABI sentinels for the API 26 SDK. GetDefaultNet and
// GetNetCapabilities were introduced in API 11; BindSocket in API 12, all
// below the application's API 22 compatibility floor.
_Static_assert(NETCONN_MAX_NET_SIZE == 32, "unexpected NetConn network-list ABI");
_Static_assert(NETCONN_MAX_CAP_SIZE == 32, "unexpected NetConn capability-list ABI");
_Static_assert(NETCONN_MAX_BEARER_TYPE_SIZE == 32, "unexpected NetConn bearer-list ABI");
_Static_assert(NETCONN_NET_CAPABILITY_INTERNET == 12, "unexpected INTERNET capability value");
_Static_assert(NETCONN_NET_CAPABILITY_NOT_VPN == 15, "unexpected NOT_VPN capability value");
_Static_assert(NETCONN_NET_CAPABILITY_VALIDATED == 16, "unexpected VALIDATED capability value");
_Static_assert(NETCONN_BEARER_CELLULAR == 0, "unexpected cellular bearer value");
_Static_assert(NETCONN_BEARER_WIFI == 1, "unexpected Wi-Fi bearer value");
_Static_assert(NETCONN_BEARER_VPN == 4, "unexpected VPN bearer value");
_Static_assert(
    __builtin_types_compatible_p(
        __typeof__(&OH_NetConn_GetDefaultNet),
        int32_t (*)(NetConn_NetHandle *)
    ),
    "OH_NetConn_GetDefaultNet signature changed"
);
_Static_assert(
    __builtin_types_compatible_p(
        __typeof__(&OH_NetConn_GetNetCapabilities),
        int32_t (*)(NetConn_NetHandle *, NetConn_NetCapabilities *)
    ),
    "OH_NetConn_GetNetCapabilities signature changed"
);
_Static_assert(
    __builtin_types_compatible_p(
        __typeof__(&OH_NetConn_BindSocket),
        int32_t (*)(int32_t, NetConn_NetHandle *)
    ),
    "OH_NetConn_BindSocket signature changed"
);

static int32_t hna_netconn_snapshot(HnaNetSnapshot *snapshot) {
    if (snapshot == NULL) {
        return HNA_NETCONN_INVALID_NET_LIST;
    }
    memset(snapshot, 0, sizeof(*snapshot));

    NetConn_NetHandle before;
    memset(&before, 0, sizeof(before));
    int32_t result = OH_NetConn_GetDefaultNet(&before);
    if (result != 0) {
        return result;
    }
    if (before.netId <= 0) {
        return HNA_NETCONN_NO_DEFAULT;
    }

    snapshot->size = 1;
    for (int32_t index = 0; index < snapshot->size; index++) {
        NetConn_NetCapabilities capabilities;
        memset(&capabilities, 0, sizeof(capabilities));
        result = OH_NetConn_GetNetCapabilities(&before, &capabilities);
        if (result != 0) {
            // A disappearing default network invalidates this snapshot.
            // Do not fall back to another still-connected data SIM.
            return result;
        }
        if (capabilities.netCapsSize < 0 || capabilities.netCapsSize > NETCONN_MAX_CAP_SIZE ||
            capabilities.bearerTypesSize < 0 ||
            capabilities.bearerTypesSize > NETCONN_MAX_BEARER_TYPE_SIZE) {
            return HNA_NETCONN_INVALID_CAPABILITIES;
        }

        HnaNetCandidate *candidate = &snapshot->candidates[index];
        candidate->netId = before.netId;
        for (int32_t capIndex = 0; capIndex < capabilities.netCapsSize; capIndex++) {
            switch (capabilities.netCaps[capIndex]) {
                case NETCONN_NET_CAPABILITY_INTERNET:
                    candidate->capabilityFlags |= HNA_NET_FLAG_INTERNET;
                    break;
                case NETCONN_NET_CAPABILITY_NOT_VPN:
                    candidate->capabilityFlags |= HNA_NET_FLAG_NOT_VPN;
                    break;
                case NETCONN_NET_CAPABILITY_VALIDATED:
                    candidate->capabilityFlags |= HNA_NET_FLAG_VALIDATED;
                    break;
                default:
                    break;
            }
        }
        for (int32_t bearerIndex = 0; bearerIndex < capabilities.bearerTypesSize; bearerIndex++) {
            switch (capabilities.bearerTypes[bearerIndex]) {
                case NETCONN_BEARER_CELLULAR:
                    candidate->bearerFlags |= HNA_BEARER_FLAG_CELLULAR;
                    break;
                case NETCONN_BEARER_WIFI:
                    candidate->bearerFlags |= HNA_BEARER_FLAG_WIFI;
                    break;
                case NETCONN_BEARER_VPN:
                    candidate->bearerFlags |= HNA_BEARER_FLAG_VPN;
                    break;
                default:
                    break;
            }
        }
    }
    // A default-data handoff during this read invalidates the snapshot. Never
    // bind a new socket to the old SIM merely because it is still validated.
    NetConn_NetHandle after;
    memset(&after, 0, sizeof(after));
    result = OH_NetConn_GetDefaultNet(&after);
    if (result != 0) return result;
    if (after.netId != before.netId) return HNA_NETCONN_DEFAULT_CHANGED;
    return 0;
}

static int32_t hna_netconn_snapshot_size(const HnaNetSnapshot *snapshot) {
    return snapshot == NULL ? HNA_NETCONN_INVALID_NET_LIST : snapshot->size;
}

static int32_t hna_netconn_snapshot_candidate(
    const HnaNetSnapshot *snapshot,
    int32_t index,
    int32_t *netId,
    uint32_t *capabilityFlags,
    uint32_t *bearerFlags
) {
    if (snapshot == NULL || netId == NULL || capabilityFlags == NULL || bearerFlags == NULL ||
        index < 0 || index >= snapshot->size || index >= NETCONN_MAX_NET_SIZE) {
        return HNA_NETCONN_INVALID_CANDIDATE_INDEX;
    }
    const HnaNetCandidate *candidate = &snapshot->candidates[index];
    *netId = candidate->netId;
    *capabilityFlags = candidate->capabilityFlags;
    *bearerFlags = candidate->bearerFlags;
    return 0;
}

static int32_t hna_netconn_bind_socket(int32_t fd, int32_t netId) {
    NetConn_NetHandle handle;
    memset(&handle, 0, sizeof(handle));
    handle.netId = netId;
    return OH_NetConn_BindSocket(fd, &handle);
}
*/
import "C"

import "fmt"

const (
	netFlagInternet  = uint32(C.HNA_NET_FLAG_INTERNET)
	netFlagNotVPN    = uint32(C.HNA_NET_FLAG_NOT_VPN)
	netFlagValidated = uint32(C.HNA_NET_FLAG_VALIDATED)

	bearerFlagCellular = uint32(C.HNA_BEARER_FLAG_CELLULAR)
	bearerFlagWiFi     = uint32(C.HNA_BEARER_FLAG_WIFI)
	bearerFlagVPN      = uint32(C.HNA_BEARER_FLAG_VPN)
)

func netConnError(operation string, result C.int32_t) error {
	return fmt.Errorf("%s failed with NetConn result %d", operation, int32(result))
}

func snapshotPublicUnderlayNetworks() ([]underlayCandidate, error) {
	var snapshot C.HnaNetSnapshot
	if result := C.hna_netconn_snapshot(&snapshot); result != 0 {
		return nil, netConnError("OH_NetConn_GetDefaultNet/GetNetCapabilities", result)
	}
	size := int32(C.hna_netconn_snapshot_size(&snapshot))
	if size < 0 || size > int32(C.NETCONN_MAX_NET_SIZE) {
		return nil, fmt.Errorf("NetConn returned invalid underlay snapshot size %d", size)
	}
	candidates := make([]underlayCandidate, 0, size)
	for index := int32(0); index < size; index++ {
		var netID C.int32_t
		var capabilityFlags C.uint32_t
		var bearerFlags C.uint32_t
		if result := C.hna_netconn_snapshot_candidate(
			&snapshot,
			C.int32_t(index),
			&netID,
			&capabilityFlags,
			&bearerFlags,
		); result != 0 {
			return nil, netConnError("read NetConn underlay candidate", result)
		}
		caps := uint32(capabilityFlags)
		bearers := uint32(bearerFlags)
		candidates = append(candidates, underlayCandidate{
			netID:        int32(netID),
			isDefault:    true,
			hasInternet:  caps&netFlagInternet != 0,
			hasNotVPN:    caps&netFlagNotVPN != 0,
			hasValidated: caps&netFlagValidated != 0,
			hasWiFi:      bearers&bearerFlagWiFi != 0,
			hasCellular:  bearers&bearerFlagCellular != 0,
			hasVPN:       bearers&bearerFlagVPN != 0,
		})
	}
	return candidates, nil
}

func bindSocketToPublicUnderlay(fd int32, netID int32) error {
	if result := C.hna_netconn_bind_socket(C.int32_t(fd), C.int32_t(netID)); result != 0 {
		return netConnError("OH_NetConn_BindSocket", result)
	}
	return nil
}

// protectProcessNet() only affects HarmonyOS libc-created sockets. Go creates
// descriptors directly, so sing-box invokes this callback before every
// outbound connection. Public NetworkKit APIs bind each descriptor to a fresh,
// validated physical underlay snapshot; there is no private fwmark protocol or
// cached network handle fallback.
func protectSocketFromVPN(fd int32) error {
	return bindSocketWithFreshUnderlay(
		fd,
		snapshotPublicUnderlayNetworks,
		bindSocketToPublicUnderlay,
	)
}
