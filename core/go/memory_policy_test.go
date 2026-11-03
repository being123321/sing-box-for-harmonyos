package main

import (
	"errors"
	"runtime/debug"
	"testing"
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

func TestCoreMemoryPolicyUsesSoftRuntimeTarget(t *testing.T) {
	old := debug.SetMemoryLimit(-1)
	defer debug.SetMemoryLimit(old)
	configureCoreMemory()
	if got := debug.SetMemoryLimit(-1); got != coreGoSoftMemoryLimit {
		t.Fatalf("unexpected soft memory target: %d", got)
	}
}
