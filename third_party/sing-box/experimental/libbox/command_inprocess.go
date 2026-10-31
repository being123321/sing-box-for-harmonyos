package libbox

import (
	"errors"
	"sync"

	"github.com/sagernet/sing-box/daemon"
	"google.golang.org/grpc"
	"google.golang.org/grpc/test/bufconn"
)

// NewInProcessCommandClient exposes only the supplied service instance to this
// client. It creates no OS listener, port or socket file, so it works in a VPN
// extension whose sandbox rejects binding command.sock. Normal external command
// clients retain their existing transport and authentication behavior.
func NewInProcessCommandClient(handler CommandClientHandler, options *CommandClientOptions, server *CommandServer) (*CommandClient, error) {
	if server == nil || handler == nil {
		return nil, errors.New("in-process command client requires a server and handler")
	}
	listener := bufconn.Listen(64 * 1024)
	rpcServer := grpc.NewServer(
		grpc.ChainUnaryInterceptor(unaryAuthInterceptor, daemon.UnaryLocaleInterceptor),
		grpc.ChainStreamInterceptor(streamAuthInterceptor, daemon.StreamLocaleInterceptor),
	)
	daemon.RegisterStartedServiceServer(rpcServer, server.StartedService)
	daemon.RegisterManagedServiceServer(rpcServer, server.managedService)
	client := NewCommandClient(handler, options)
	client.inProcessDialer = listener.DialContext
	var once sync.Once
	client.inProcessClose = func() {
		once.Do(func() {
			rpcServer.Stop()
			_ = listener.Close()
		})
	}
	go func() { _ = rpcServer.Serve(listener) }()
	return client, nil
}
