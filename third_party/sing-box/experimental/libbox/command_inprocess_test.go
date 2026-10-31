package libbox

import (
	"os"
	"path/filepath"
	"testing"
)

type inProcessTestHandler struct{}

func (*inProcessTestHandler) Connected()                                 {}
func (*inProcessTestHandler) Disconnected(string)                        {}
func (*inProcessTestHandler) SetDefaultLogLevel(int32)                   {}
func (*inProcessTestHandler) ClearLogs()                                 {}
func (*inProcessTestHandler) WriteLogs(LogIterator)                      {}
func (*inProcessTestHandler) WriteStatus(*StatusMessage)                 {}
func (*inProcessTestHandler) WriteGroups(OutboundGroupIterator)          {}
func (*inProcessTestHandler) WriteOutbounds(OutboundGroupItemIterator)   {}
func (*inProcessTestHandler) InitializeClashMode(StringIterator, string) {}
func (*inProcessTestHandler) UpdateClashMode(string)                     {}
func (*inProcessTestHandler) WriteConnectionEvents(*ConnectionEvents)    {}

func testInProcessClient(t *testing.T) *CommandClient {
	t.Helper()
	server, err := NewCommandServer(nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Close)
	client, err := NewInProcessCommandClient(&inProcessTestHandler{}, &CommandClientOptions{}, server)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Disconnect() })
	if err = client.Connect(); err != nil {
		t.Fatal(err)
	}
	return client
}

func TestInProcessCommandsWithoutSocketFile(t *testing.T) {
	// An ordinary file is deliberately used as the socket parent. Any accidental
	// OS listen/dial path must fail, while the real in-memory RPC must work.
	oldBase := sBasePath
	sBasePath = filepath.Join(t.TempDir(), "not-a-directory")
	defer func() { sBasePath = oldBase }()
	if err := os.WriteFile(sBasePath, []byte("no socket can be bound here"), 0600); err != nil {
		t.Fatal(err)
	}
	client := testInProcessClient(t)
	if _, err := client.GetStartedAt(); err != nil {
		t.Fatal(err)
	}
	if err := client.Disconnect(); err != nil {
		t.Fatal(err)
	}
	if _, err := client.GetStartedAt(); err == nil {
		t.Fatal("disconnected client unexpectedly reconnected")
	}
}

func TestInProcessClientsHaveIndependentLifetimes(t *testing.T) {
	first, second := testInProcessClient(t), testInProcessClient(t)
	if err := first.Disconnect(); err != nil {
		t.Fatal(err)
	}
	if _, err := second.GetStartedAt(); err != nil {
		t.Fatal(err)
	}
}

func TestInProcessClientRejectsMissingService(t *testing.T) {
	if _, err := NewInProcessCommandClient(&inProcessTestHandler{}, nil, nil); err == nil {
		t.Fatal("accepted missing server")
	}
}
