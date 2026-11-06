package main

import (
	"runtime/debug"
	"time"
)

// A soft target for Go-managed memory, not an RSS cap or an OOM kill policy.
// Leave generous headroom for rules and live connections; the runtime may
// exceed it when needed. Native/ArkTS memory is outside this accounting.
const coreGoSoftMemoryLimit int64 = 512 << 20

var freeCoreMemory = debug.FreeOSMemory

const coreMemoryPressureCooldown = 30 * time.Second

// Guarded by coreMu, as are the lifecycle reclaim calls below. This is per
// process, so rebuilding a service does not reset the pressure cooldown.
var lastCoreMemoryPressureAt time.Time

func configureCoreMemory() {
	debug.SetMemoryLimit(coreGoSoftMemoryLimit)
}

// Run only at lifecycle boundaries, under coreMu, after successful teardown
// or idle config validation. Never add forced GC to packet/telemetry polling.
func reclaimIdleCoreMemory(running bool, cleanupErr error) {
	if !running && cleanupErr == nil {
		freeCoreMemory()
	}
}

// An explicit system memory-pressure notification may reclaim unused Go pages
// while the service is running. FreeOSMemory performs GC; it must not be tied
// to packet handling, telemetry or a recurring keepalive timer. A burst of
// system callbacks can request at most one collection in this interval.
func reclaimCoreMemoryUnderPressure(now time.Time) bool {
	if !lastCoreMemoryPressureAt.IsZero() && now.Sub(lastCoreMemoryPressureAt) < coreMemoryPressureCooldown {
		return false
	}
	lastCoreMemoryPressureAt = now
	freeCoreMemory()
	return true
}
