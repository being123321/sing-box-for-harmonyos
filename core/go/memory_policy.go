package main

import "runtime/debug"

// A soft target for Go-managed memory, not an RSS cap or an OOM kill policy.
// Leave generous headroom for rules and live connections; the runtime may
// exceed it when needed. Native/ArkTS memory is outside this accounting.
const coreGoSoftMemoryLimit int64 = 512 << 20

var freeCoreMemory = debug.FreeOSMemory

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
