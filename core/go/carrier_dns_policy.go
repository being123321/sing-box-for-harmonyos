package main

import (
	"errors"
	"net/netip"
	"sync/atomic"
)

type carrierDNSConfig struct {
	enabled bool
	servers []string
}

var carrierDNS atomic.Pointer[carrierDNSConfig]

func setCarrierDNS(enabled bool, values []string) error {
	if len(values) > 8 {
		return errors.New("too many network DNS addresses")
	}
	servers := make([]string, 0, len(values))
	for _, value := range values {
		ip, err := netip.ParseAddr(value)
		if err != nil || ip.IsUnspecified() || ip.IsLoopback() || ip.IsMulticast() || ip.WithZone("").Unmap().String() == "172.19.0.2" || ip.WithZone("").String() == "fdfe:dcba:9876::2" {
			return errors.New("invalid physical network DNS address")
		}
		address := ip.String()
		exists := false
		for _, old := range servers {
			if old == address {
				exists = true
				break
			}
		}
		if !exists {
			servers = append(servers, address)
		}
	}
	carrierDNS.Store(&carrierDNSConfig{enabled: enabled, servers: servers})
	return nil
}
