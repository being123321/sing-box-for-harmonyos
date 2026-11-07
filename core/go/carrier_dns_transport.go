package main

import (
	"context"
	"errors"
	mDNS "github.com/miekg/dns"
	"github.com/sagernet/sing-box/experimental/libbox"
	"net"
	"syscall"
	"time"
)

type carrierDNSTransport struct{}

func (*carrierDNSTransport) Raw() bool { return true }
func (*carrierDNSTransport) Lookup(*libbox.ExchangeContext, string, string) error {
	return errors.New("raw network DNS exchange required")
}
func (*carrierDNSTransport) Exchange(exchange *libbox.ExchangeContext, wire []byte) error {
	snapshot := carrierDNS.Load()
	if snapshot == nil || !snapshot.enabled || len(snapshot.servers) == 0 {
		return errors.New("physical network DNS unavailable")
	}
	var request mDNS.Msg
	if err := request.Unpack(wire); err != nil {
		return err
	}
	if len(request.Question) != 1 {
		return errors.New("invalid network DNS question")
	}
	// No persistent polling or sockets. The bridge does not expose the caller's
	// Go context; cap all fallback attempts by one shared five-second deadline.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	dialer := &net.Dialer{Timeout: 2 * time.Second, Control: func(_, _ string, raw syscall.RawConn) error {
		var protected error
		if err := raw.Control(func(fd uintptr) { protected = protectSocketFromVPN(int32(fd)) }); err != nil {
			return err
		}
		return protected
	}}
	var last error
	for _, server := range snapshot.servers {
		client := mDNS.Client{Net: "udp", Timeout: 2 * time.Second, Dialer: dialer}
		reply, _, err := client.ExchangeContext(ctx, &request, net.JoinHostPort(server, "53"))
		if err == nil && reply.Truncated {
			client.Net = "tcp"
			reply, _, err = client.ExchangeContext(ctx, &request, net.JoinHostPort(server, "53"))
		}
		if err != nil {
			last = err
			continue
		}
		if carrierDNS.Load() != snapshot {
			return errors.New("network DNS changed during exchange")
		}
		result, err := reply.Pack()
		if err != nil {
			return err
		}
		exchange.RawSuccess(result)
		return nil
	}
	if last != nil {
		return last
	}
	return errors.New("physical network DNS unavailable")
}
