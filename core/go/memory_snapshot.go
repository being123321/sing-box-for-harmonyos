package main

import "runtime/metrics"

// Go-only diagnostics. These are not RSS, ArkUI memory or native Cronet memory.
// Compare the VPN extension's OS process metrics separately on the device.
type coreMemorySnapshot struct {
 GoRuntimeBytes uint64 `json:"goRuntimeBytes"`
 HeapObjectsBytes uint64 `json:"heapObjectsBytes"`
 HeapReleasedBytes uint64 `json:"heapReleasedBytes"`
 HeapGoalBytes uint64 `json:"heapGoalBytes"`
 GCCycles uint64 `json:"gcCycles"`
 SoftLimitBytes int64 `json:"softLimitBytes"`
}

func readCoreMemorySnapshot() *coreMemorySnapshot {
 samples := []metrics.Sample{
  {Name:"/memory/classes/total:bytes"},
  {Name:"/memory/classes/heap/released:bytes"},
  {Name:"/memory/classes/heap/objects:bytes"},
  {Name:"/gc/heap/goal:bytes"},
  {Name:"/gc/cycles/total:gc-cycles"},
  {Name:"/gc/gomemlimit:bytes"},
 }
 metrics.Read(samples)
 for _, sample := range samples {
  if sample.Value.Kind() != metrics.KindUint64 { return nil }
 }
 total, released := samples[0].Value.Uint64(), samples[1].Value.Uint64()
 var used uint64
 if total >= released { used = total - released }
 return &coreMemorySnapshot{
  GoRuntimeBytes:used,
  HeapObjectsBytes:samples[2].Value.Uint64(),
  HeapReleasedBytes:released,
  HeapGoalBytes:samples[3].Value.Uint64(),
  GCCycles:samples[4].Value.Uint64(),
  SoftLimitBytes:int64(samples[5].Value.Uint64()),
 }
}
