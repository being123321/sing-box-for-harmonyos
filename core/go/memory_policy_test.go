package main

import (
	"errors"
	"runtime/debug"
	"testing"
	"time"
)

func TestIdleMemoryReclaimDoesNotTouchRunningOrFailedCleanup(t *testing.T) {
	original := freeCoreMemory
	defer func() { freeCoreMemory = original }()
	calls := 0
	freeCoreMemory = func() { calls++ }
	reclaimIdleCoreMemory(true, nil)
	reclaimIdleCoreMemory(false, errors.New("cleanup not confirmed"))
	if calls != 0 {
		t.Fatal("reclaim must wait for confirmed idle state")
	}
	reclaimIdleCoreMemory(false, nil)
	if calls != 1 {
		t.Fatal("confirmed idle transition must reclaim once")
	}
}

func TestMemoryPressureReclaimIsExplicitAndThrottledAcrossServiceRebuilds(t *testing.T) {
	originalFree, originalLast := freeCoreMemory, lastCoreMemoryPressureAt
	defer func() { freeCoreMemory, lastCoreMemoryPressureAt = originalFree, originalLast }()
	lastCoreMemoryPressureAt = time.Time{}
	calls := 0
	freeCoreMemory = func() { calls++ }
	now := time.Unix(1000, 0)
	if !reclaimCoreMemoryUnderPressure(now) || calls != 1 {
		t.Fatal("first explicit pressure callback must reclaim once")
	}
	if reclaimCoreMemoryUnderPressure(now.Add(29*time.Second)) || calls != 1 {
		t.Fatal("repeated pressure callbacks must respect the cooldown")
	}
	// Reapplying the runtime target during initialization must not turn a
	// network rebuild into a way to bypass the per-process cooldown.
	oldLimit := debug.SetMemoryLimit(-1)
	defer debug.SetMemoryLimit(oldLimit)
	configureCoreMemory()
	if reclaimCoreMemoryUnderPressure(now.Add(time.Second)) || calls != 1 {
		t.Fatal("service initialization must preserve the pressure cooldown")
	}
	if !reclaimCoreMemoryUnderPressure(now.Add(30*time.Second)) || calls != 2 {
		t.Fatal("a later explicit pressure callback may reclaim again")
	}
}

func TestMemoryPressureReclaimDoesNotLoopWhenClockMovesBackward(t *testing.T) {
	originalFree, originalLast := freeCoreMemory, lastCoreMemoryPressureAt
	defer func() { freeCoreMemory, lastCoreMemoryPressureAt = originalFree, originalLast }()
	now := time.Unix(1000, 0)
	lastCoreMemoryPressureAt = now
	calls := 0
	freeCoreMemory = func() { calls++ }
	if reclaimCoreMemoryUnderPressure(now.Add(-time.Second)) || calls != 0 {
		t.Fatal("a backward clock must not cause repeated collections")
	}
}

func TestCoreMemoryPolicyUsesSoftRuntimeTarget(t *testing.T) {
	old := debug.SetMemoryLimit(-1)
	defer debug.SetMemoryLimit(old)
	configureCoreMemory()
	if got := debug.SetMemoryLimit(-1); got != coreGoSoftMemoryLimit {
		t.Fatalf("unexpected soft memory target: %d", got)
	}
}
