package main

import (
	"sync"
	"testing"
)

// Run with -race on a supported host as well as the device test binary. A
// heartbeat can read a cached snapshot while the separate stop channel tears
// down the native service. Neither operation may dereference a cleared global.
func TestTailscaleCachedReadsDuringTeardown(t *testing.T) {
	if coreCommandClient.Load() != nil {
		t.Fatal("test requires an idle core")
	}
	previous := tailscaleCache.Load()
	defer tailscaleCache.Store(previous)
	var readers sync.WaitGroup
	for worker := 0; worker < 4; worker++ {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for i := 0; i < 500; i++ {
				HnaCoreFreeCString(HnaCoreTailscaleStatus())
				HnaCoreFreeCString(HnaCoreTaildropInbox(nil))
			}
		}()
	}
	for i := 0; i < 500; i++ {
		cache := newTailscaleStateCache()
		cache.setStatus(`{"endpoints":[]}`)
		tailscaleCache.Store(cache)
		stopTailscaleInfrastructure()
	}
	readers.Wait()
}
