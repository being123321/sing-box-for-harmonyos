package main

import "testing"

func TestCarrierDNSImmutableDeduplicatedSnapshot(t *testing.T) {
	input := []string{"10.0.0.1", "240e:0:0::53", "10.0.0.1"}
	if err := setCarrierDNS(true, input); err != nil {
		t.Fatal(err)
	}
	snapshot := carrierDNS.Load()
	input[0] = "8.8.8.8"
	if !snapshot.enabled || len(snapshot.servers) != 2 || snapshot.servers[0] != "10.0.0.1" || snapshot.servers[1] != "240e::53" {
		t.Fatal("mutable or noncanonical DNS snapshot")
	}
}
func TestCarrierDNSRejectsUnsafeAddressesWithoutReplacingCurrent(t *testing.T) {
	for _, bad := range []string{"dns.example.test", "", "0.0.0.0", "::", "127.0.0.1", "::1", "224.0.0.1", "172.19.0.2", "fdfe:dcba:9876::2"} {
		if err := setCarrierDNS(true, []string{"10.0.0.1"}); err != nil {
			t.Fatal(err)
		}
		before := carrierDNS.Load()
		if err := setCarrierDNS(true, []string{bad}); err == nil {
			t.Fatalf("accepted %q", bad)
		}
		if carrierDNS.Load() != before {
			t.Fatal("invalid DNS replaced active servers")
		}
	}
}
func TestCarrierDNSDisableAndUnavailableAreExplicit(t *testing.T) {
	if err := setCarrierDNS(false, nil); err != nil {
		t.Fatal(err)
	}
	if carrierDNS.Load().enabled || len(carrierDNS.Load().servers) != 0 {
		t.Fatal("disable failed")
	}
	if err := setCarrierDNS(true, nil); err != nil {
		t.Fatal(err)
	}
	if !carrierDNS.Load().enabled || len(carrierDNS.Load().servers) != 0 {
		t.Fatal("unavailable DNS was invented")
	}
	if err := setCarrierDNS(true, make([]string, 9)); err == nil {
		t.Fatal("unbounded server list")
	}
}
