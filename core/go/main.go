package main

/*
#include <stdint.h>
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"encoding/json"
	"errors"
	boxlog "github.com/sagernet/sing-box/log"
	"google.golang.org/protobuf/types/known/emptypb"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing-box/common/urltest"
	"github.com/sagernet/sing-box/daemon"
	"github.com/sagernet/sing-box/experimental/libbox"
	"github.com/sagernet/sing-box/protocol/group"
)

const (
	coreOK              = int32(0)
	coreUnavailable     = int32(1)
	coreInvalidArgument = int32(2)
	coreInvalidConfig   = int32(3)
	coreAlreadyRunning  = int32(4)
	coreNotRunning      = int32(5)
	coreInternalError   = int32(6)
)

var (
	coreMu      sync.Mutex
	coreServer  *libbox.CommandServer
	coreRunning bool
	coreLastErr string
	coreErrorMu sync.Mutex
	// Once libbox reports a close/rollback failure, this process can no longer
	// prove that every core-owned descriptor and goroutine was released. Keep a
	// sticky failure until the VPN Extension process exits; otherwise a second
	// stop would see "not running" and could forge a successful cleanup ack.
	coreCleanupErr error
	platformTun    atomic.Int32
)

type emptyStringIterator struct{}

func (*emptyStringIterator) Len() int32    { return 0 }
func (*emptyStringIterator) HasNext() bool { return false }
func (*emptyStringIterator) Next() string  { return "" }

type emptyNetworkIterator struct{}

func (*emptyNetworkIterator) HasNext() bool                  { return false }
func (*emptyNetworkIterator) Next() *libbox.NetworkInterface { return nil }

type harmonyPlatform struct{}

func (*harmonyPlatform) LocalDNSTransport() libbox.LocalDNSTransport { return nil }
func (*harmonyPlatform) UsePlatformAutoDetectInterfaceControl() bool { return true }

// protectProcessNet() covers HarmonyOS libc-created sockets. Go bypasses that
// hook, so sing-box invokes this callback for every outbound descriptor.
func (*harmonyPlatform) AutoDetectInterfaceControl(fd int32) error {
	return protectSocketFromVPN(fd)
}

func (*harmonyPlatform) OpenTun(options libbox.TunOptions) (int32, error) {
	fd := platformTun.Load()
	if fd < 0 {
		return -1, errors.New("HarmonyOS VPN TUN descriptor is unavailable")
	}
	return fd, nil
}

func (*harmonyPlatform) UseProcFS() bool { return false }

func (*harmonyPlatform) FindConnectionOwner(
	ipProtocol int32,
	sourceAddress string,
	sourcePort int32,
	destinationAddress string,
	destinationPort int32,
) (*libbox.ConnectionOwner, error) {
	return nil, errors.New("connection owner lookup is unavailable on HarmonyOS")
}

func (*harmonyPlatform) StartDefaultInterfaceMonitor(listener libbox.InterfaceUpdateListener) error {
	return nil
}

func (*harmonyPlatform) CloseDefaultInterfaceMonitor(listener libbox.InterfaceUpdateListener) error {
	return nil
}

func (*harmonyPlatform) GetInterfaces() (libbox.NetworkInterfaceIterator, error) {
	return &emptyNetworkIterator{}, nil
}

func (*harmonyPlatform) UnderNetworkExtension() bool      { return true }
func (*harmonyPlatform) IncludeAllNetworks() bool         { return false }
func (*harmonyPlatform) ReadWIFIState() *libbox.WIFIState { return nil }
func (*harmonyPlatform) SystemCertificates() libbox.StringIterator {
	return &emptyStringIterator{}
}
func (*harmonyPlatform) ClearDNSCache()                                           {}
func (*harmonyPlatform) SendNotification(notification *libbox.Notification) error { return nil }

type harmonyHandler struct{}

type coreRuntimeStatus struct {
	running           bool
	uploadBytes       int64
	downloadBytes     int64
	activeConnections int32
}

func (*harmonyHandler) ServiceStop() error   { return nil }
func (*harmonyHandler) ServiceReload() error { return nil }
func (*harmonyHandler) GetSystemProxyStatus() (*libbox.SystemProxyStatus, error) {
	return &libbox.SystemProxyStatus{}, nil
}
func (*harmonyHandler) SetSystemProxyEnabled(enabled bool) error {
	return errors.New("system proxy is unavailable to consumer HarmonyOS applications")
}
func (*harmonyHandler) WriteDebugMessage(message string) {}

func setLastError(err error) {
	coreErrorMu.Lock()
	defer coreErrorMu.Unlock()
	if err == nil {
		coreLastErr = ""
	} else {
		coreLastErr = err.Error()
	}
}

func cleanupHealthErrorLocked() error {
	if coreCleanupErr == nil {
		return nil
	}
	return errors.New("previous core cleanup remains unconfirmed: " + coreCleanupErr.Error())
}

func runtimeStatusFromDaemon(running bool, status *daemon.Status) (coreRuntimeStatus, error) {
	result := coreRuntimeStatus{running: running}
	if !running {
		return result, nil
	}
	if status == nil || !status.TrafficAvailable {
		return coreRuntimeStatus{}, errors.New("sing-box traffic tracker is unavailable")
	}
	if status.UplinkTotal < 0 || status.DownlinkTotal < 0 || status.ConnectionsIn < 0 {
		return coreRuntimeStatus{}, errors.New("sing-box traffic tracker returned invalid counters")
	}
	result.uploadBytes = status.UplinkTotal
	result.downloadBytes = status.DownlinkTotal
	result.activeConnections = status.ConnectionsIn
	return result, nil
}

func readRuntimeStatusLocked() (coreRuntimeStatus, error) {
	if !coreRunning {
		return runtimeStatusFromDaemon(false, nil)
	}
	if coreServer == nil {
		return coreRuntimeStatus{}, errors.New("core is running without a command server")
	}
	// libbox always supplies a PlatformLogWriter for an embedded service, which
	// enables sing-box's in-process ClashAPI traffic manager. An empty
	// external_controller means this tracker does not listen on any TCP port.
	return runtimeStatusFromDaemon(true, coreServer.StatusSnapshot())
}

//export HnaCoreInitialize
func HnaCoreInitialize(workingDirectory *C.char, temporaryDirectory *C.char) C.int32_t {
	if workingDirectory == nil || temporaryDirectory == nil {
		return C.int32_t(coreInvalidArgument)
	}
	coreMu.Lock()
	defer coreMu.Unlock()
	if err := cleanupHealthErrorLocked(); err != nil {
		setLastError(err)
		return C.int32_t(coreInternalError)
	}
	if coreServer != nil {
		return C.int32_t(coreOK)
	}
	workingPath := C.GoString(workingDirectory)
	temporaryPath := C.GoString(temporaryDirectory)
	if workingPath == "" || temporaryPath == "" {
		return C.int32_t(coreInvalidArgument)
	}
	if err := libbox.Setup(&libbox.SetupOptions{
		BasePath:    workingPath,
		WorkingPath: workingPath,
		TempPath:    temporaryPath,
		LogMaxLines: 200,
		Debug:       false,
	}); err != nil {
		setLastError(err)
		return C.int32_t(coreInternalError)
	}
	server, err := libbox.NewCommandServer(&harmonyHandler{}, &harmonyPlatform{})
	if err != nil {
		setLastError(err)
		return C.int32_t(coreInternalError)
	}
	platformTun.Store(-1)
	// Set Tailscale debug log path
	tailscaleDebugLogMu.Lock()
	tailscaleDebugLogPath = filepath.Join(workingPath, "tailscale-debug.log")
	tailscaleDebugLogMu.Unlock()
	// Keep the service in-process. CommandServer.Start binds command.sock,
	// which is denied in the HarmonyOS VPN extension sandbox. Tailscale
	// creates a private memory-only client after this service starts.
	coreServer = server
	setLastError(nil)
	return C.int32_t(coreOK)
}

//export HnaCoreValidateConfig
func HnaCoreValidateConfig(configJSON *C.char) C.int32_t {
	if configJSON == nil {
		return C.int32_t(coreInvalidArgument)
	}
	coreMu.Lock()
	defer coreMu.Unlock()
	if coreServer == nil {
		setLastError(errors.New("core is not initialized"))
		return C.int32_t(coreUnavailable)
	}
	if err := coreServer.CheckConfig(context.Background(), C.GoString(configJSON)); err != nil {
		setLastError(err)
		return C.int32_t(coreInvalidConfig)
	}
	setLastError(nil)
	return C.int32_t(coreOK)
}

//export HnaCoreStart
func HnaCoreStart(tunFD C.int32_t, configJSON *C.char) C.int32_t {
	if tunFD < 0 || configJSON == nil {
		return C.int32_t(coreInvalidArgument)
	}
	coreMu.Lock()
	defer coreMu.Unlock()
	if err := cleanupHealthErrorLocked(); err != nil {
		setLastError(err)
		return C.int32_t(coreInternalError)
	}
	if coreServer == nil {
		setLastError(errors.New("core is not initialized"))
		return C.int32_t(coreUnavailable)
	}
	if coreRunning {
		return C.int32_t(coreAlreadyRunning)
	}
	platformTun.Store(int32(tunFD))
	if err := coreServer.StartOrReloadService(C.GoString(configJSON), &libbox.OverrideOptions{}); err != nil {
		// StartOrReloadService closes its partially-started instance. Closing the
		// FATAL service state here also returns it to IDLE for an immediate retry.
		err = rollbackFailedCoreService(err)
		setLastError(err)
		return C.int32_t(coreInternalError)
	}
	coreRunning = true
	// Start Tailscale infrastructure now that the core service is running.
	// SubscribeTailscaleStatus requires the service to be STARTED.
	startTailscaleInfrastructure()
	setLastError(nil)
	return C.int32_t(coreOK)
}

//export HnaCoreReload
func HnaCoreReload(configJSON *C.char) C.int32_t {
	if configJSON == nil {
		return C.int32_t(coreInvalidArgument)
	}
	coreMu.Lock()
	defer coreMu.Unlock()
	if err := cleanupHealthErrorLocked(); err != nil {
		setLastError(err)
		return C.int32_t(coreInternalError)
	}
	if coreServer == nil {
		return C.int32_t(coreNotRunning)
	}
	// A failed Instance.Start() can leave a FATAL instance even though the
	// public running flag was never set. CloseService must still be allowed to
	// release that instance and its duplicated TUN descriptor.
	if !coreRunning && coreServer.Instance() == nil {
		return C.int32_t(coreNotRunning)
	}
	if err := coreServer.StartOrReloadService(C.GoString(configJSON), &libbox.OverrideOptions{}); err != nil {
		err = rollbackFailedCoreService(err)
		setLastError(err)
		return C.int32_t(coreInternalError)
	}
	// Re-subscribe to Tailscale status after reload (instance may have changed)
	restartTailscaleSubscription()
	setLastError(nil)
	return C.int32_t(coreOK)
}

//export HnaCoreStop
func HnaCoreStop() C.int32_t {
	activeURLTest.interrupt()
	coreMu.Lock()
	defer coreMu.Unlock()
	if err := cleanupHealthErrorLocked(); err != nil {
		setLastError(err)
		return C.int32_t(coreInternalError)
	}
	if coreServer == nil || (!coreRunning && coreServer.Instance() == nil) {
		return C.int32_t(coreNotRunning)
	}
	err := coreServer.CloseService()
	// The extension owns the original descriptor and will destroy the system
	// TUN after this call. Never report a stale running state, even when libbox
	// returns an error while closing one of its internal resources.
	coreRunning = false
	platformTun.Store(-1)
	stopTailscaleInfrastructure()
	if err != nil {
		coreCleanupErr = err
		setLastError(cleanupHealthErrorLocked())
		return C.int32_t(coreInternalError)
	}
	setLastError(nil)
	return C.int32_t(coreOK)
}

// rollbackFailedCoreService is called with coreMu held. It preserves the
// original startup/reload failure while also reporting a rollback failure, and
// it always clears public running/TUN state so a stale status can never be
// exposed after a failed transition.
func rollbackFailedCoreService(operationErr error) error {
	stopTailscaleInfrastructure()
	cleanupErr := coreServer.CloseService()
	coreRunning = false
	platformTun.Store(-1)
	if cleanupErr != nil {
		coreCleanupErr = cleanupErr
		return errors.Join(operationErr, errors.New(
			"failed core service rollback: "+cleanupHealthErrorLocked().Error()))
	}
	return operationErr
}

//export HnaCoreURLTest
func HnaCoreURLTest(outboundTag *C.char) C.int32_t {
	if outboundTag == nil {
		return -1
	}
	tag := C.GoString(outboundTag)
	if tag == "" {
		return -1
	}

	// Keep stop/reload serialized with the test so the selected outbound cannot
	// disappear while sing-box is performing its real proxy handshake.
	coreMu.Lock()
	defer coreMu.Unlock()
	if coreServer == nil || !coreRunning || coreServer.Instance() == nil || coreServer.Instance().Box() == nil {
		setLastError(errors.New("core is not running"))
		return -1
	}
	outbound, loaded := coreServer.Instance().Box().Outbound().Outbound(tag)
	if !loaded {
		setLastError(errors.New("selected outbound is unavailable"))
		return -1
	}
	// Match sing-box's own daemon URLTest path: the live Instance context owns
	// DNS, routing, network and certificate services required by the outbound.
	// A standalone context with only RootCAs can make otherwise valid hostname
	// nodes fail before their proxy handshake.
	ctx, cancel := activeURLTest.begin(coreServer.Instance().Context())
	defer cancel()
	delay, err := urltest.URLTest(ctx, "", outbound)
	if err != nil {
		setLastError(err)
		return -1
	}
	setLastError(nil)
	return C.int32_t(delay)
}

//export HnaCoreTestConfig
func HnaCoreTestConfig(configJSON *C.char, outboundTag *C.char) C.int32_t {
	if configJSON == nil || outboundTag == nil {
		return -1
	}
	text, tag := C.GoString(configJSON), C.GoString(outboundTag)
	return C.int32_t(testNodeProbe(text, tag))
}

func testNodeProbe(text, tag string) int32 {
	coreMu.Lock()
	defer coreMu.Unlock()
	if err := validateNodeProbeConfig(text, tag); err != nil {
		setLastError(errors.Join(errors.New("probe-init:"), err))
		return -1
	}
	if err := cleanupHealthErrorLocked(); err != nil {
		setLastError(err)
		return -1
	}
	// This instance has no TUN, listeners, cache DB or running URLTest groups.
	// Do not replace coreServer/platformTun: the VPN lifecycle is independent.
	server, err := libbox.NewCommandServer(&harmonyHandler{}, &harmonyPlatform{})
	if err != nil {
		setLastError(errors.Join(errors.New("probe-init:"), err))
		return -1
	}
	defer server.Close()
	if err = server.StartOrReloadService(text, &libbox.OverrideOptions{}); err != nil {
		if closeErr := server.CloseService(); closeErr != nil {
			coreCleanupErr = closeErr
		}
		setLastError(errors.Join(errors.New("probe-start:"), err))
		return -1
	}
	instance := server.Instance()
	outbound, ok := instance.Box().Outbound().Outbound(tag)
	var delay uint16
	if !ok {
		err = errors.New("probe outbound unavailable")
	} else {
		ctx, cancel := activeURLTest.begin(instance.Context())
		delay, err = urltest.URLTest(ctx, "", outbound)
		cancel()
	}
	if closeErr := server.CloseService(); closeErr != nil {
		coreCleanupErr = closeErr
		err = errors.Join(errors.New("probe-cleanup:"), err, closeErr)
	}
	setLastError(err)
	if err != nil {
		return -1
	}
	return int32(delay)
}

// selectProxyOutboundLocked changes the active member of the running proxy
// selector in place. The caller must hold coreMu so stop/reload cannot replace
// the Box while the selector is being resolved and changed.
func selectProxyOutboundLocked(outboundTag string) error {
	if coreServer == nil || !coreRunning || coreServer.Instance() == nil || coreServer.Instance().Box() == nil {
		return errors.New("core is not running")
	}
	proxyOutbound, loaded := coreServer.Instance().Box().Outbound().Outbound("proxy")
	if !loaded {
		return errors.New("proxy selector is unavailable")
	}
	selector, isSelector := proxyOutbound.(*group.Selector)
	if !isSelector {
		return errors.New("proxy outbound is not a selector")
	}
	if !selector.SelectOutbound(outboundTag) {
		return errors.New("outbound is not a member of the proxy selector")
	}
	return nil
}

//export HnaCoreSelectOutbound
func HnaCoreSelectOutbound(outboundTag *C.char) C.int32_t {
	if outboundTag == nil {
		return C.int32_t(coreInvalidArgument)
	}
	tag := C.GoString(outboundTag)
	if tag == "" {
		return C.int32_t(coreInvalidArgument)
	}

	// Serialize with stop/reload, but do not restart the service or touch the
	// platform TUN descriptor. Selector.SelectOutbound atomically swaps the
	// member and applies interrupt_exist_connections itself.
	coreMu.Lock()
	defer coreMu.Unlock()
	if coreServer == nil || !coreRunning || coreServer.Instance() == nil || coreServer.Instance().Box() == nil {
		setLastError(errors.New("core is not running"))
		return C.int32_t(coreNotRunning)
	}
	if err := selectProxyOutboundLocked(tag); err != nil {
		setLastError(err)
		return C.int32_t(coreInternalError)
	}
	setLastError(nil)
	return C.int32_t(coreOK)
}

//export HnaCoreIsRunning
func HnaCoreIsRunning() C.int32_t {
	coreMu.Lock()
	defer coreMu.Unlock()
	if coreRunning {
		return 1
	}
	return 0
}

//export HnaCoreGetStatus
func HnaCoreGetStatus(
	running *C.int32_t,
	uploadBytes *C.int64_t,
	downloadBytes *C.int64_t,
	activeConnections *C.int32_t,
) C.int32_t {
	if running == nil || uploadBytes == nil || downloadBytes == nil || activeConnections == nil {
		return C.int32_t(coreInvalidArgument)
	}
	coreMu.Lock()
	defer coreMu.Unlock()
	status, err := readRuntimeStatusLocked()
	if err != nil {
		setLastError(err)
		return C.int32_t(coreInternalError)
	}
	if status.running {
		*running = 1
	} else {
		*running = 0
	}
	*uploadBytes = C.int64_t(status.uploadBytes)
	*downloadBytes = C.int64_t(status.downloadBytes)
	*activeConnections = C.int32_t(status.activeConnections)
	return C.int32_t(coreOK)
}

//export HnaCoreSelectedOutboundTag
func HnaCoreSelectedOutboundTag(groupTag *C.char) *C.char {
	if groupTag == nil {
		return C.CString("")
	}
	coreMu.Lock()
	defer coreMu.Unlock()
	if coreServer == nil || !coreRunning {
		return C.CString("")
	}
	instance := coreServer.Instance()
	if instance == nil || instance.Box() == nil {
		return C.CString("")
	}
	outbound, loaded := instance.Box().Outbound().Outbound(C.GoString(groupTag))
	if !loaded {
		return C.CString("")
	}
	groupOutbound, isGroup := outbound.(adapter.OutboundGroup)
	if !isGroup {
		return C.CString("")
	}
	selected := groupOutbound.Selected("tcp")
	if selected == nil {
		return C.CString("")
	}
	return C.CString(selected.Tag())
}

//export HnaCoreVersion
func HnaCoreVersion() *C.char {
	return C.CString(libbox.Version())
}

//export HnaCoreLastError
func HnaCoreLastError() *C.char {
	coreMu.Lock()
	defer coreMu.Unlock()
	coreErrorMu.Lock()
	defer coreErrorMu.Unlock()
	return C.CString(coreLastErr)
}

//export HnaCoreFreeCString
func HnaCoreFreeCString(value *C.char) {
	C.free(unsafe.Pointer(value))
}

func main() {}

// Optional desktop integration is unavailable inside a consumer HarmonyOS VPN.
func (*harmonyHandler) ConnectSSHAgent() (int32, error) {
	return -1, errors.New("SSH agent is unavailable on HarmonyOS")
}
func (*harmonyHandler) TriggerNativeCrash() error {
	return errors.New("native crash trigger is unavailable")
}
func (*harmonyPlatform) CancelNotification(identifier string, typeID int32) error { return nil }
func (*harmonyPlatform) StartNeighborMonitor(listener libbox.NeighborUpdateListener) error {
	return nil
}
func (*harmonyPlatform) CloseNeighborMonitor(listener libbox.NeighborUpdateListener) error {
	return nil
}
func (*harmonyPlatform) RegisterMyInterface(name string) {}
func (*harmonyPlatform) UsePlatformShell() bool          { return false }
func (*harmonyPlatform) CheckPlatformShell() error {
	return errors.New("platform shell is unavailable on HarmonyOS")
}
func (*harmonyPlatform) OpenShellSession(user *libbox.PlatformUser, command string, environ libbox.StringIterator, term string, rows int32, cols int32) (libbox.ShellSession, error) {
	return nil, errors.New("platform shell is unavailable on HarmonyOS")
}
func (*harmonyPlatform) LookupUser(username string) (*libbox.PlatformUser, error) {
	return nil, errors.New("platform user lookup is unavailable on HarmonyOS")
}
func (*harmonyPlatform) LookupSFTPServer() (string, error) {
	return "", errors.New("SFTP server is unavailable on HarmonyOS")
}
func (*harmonyPlatform) ReadSystemSSHHostKey() (string, error) {
	return "", errors.New("system SSH host key is unavailable on HarmonyOS")
}
func (*harmonyPlatform) TailscaleHostname() string { return "HarmonyOS" }
func (*harmonyPlatform) UsePlatformBridge() bool   { return false }
func (*harmonyPlatform) CreateBridge(options *libbox.BridgeOptions) (libbox.BridgeSession, error) {
	return nil, errors.New("platform bridge is unavailable on HarmonyOS")
}

type harmonyControl struct {
	Action   string `json:"action"`
	Group    string `json:"group"`
	Outbound string `json:"outbound"`
	Mode     string `json:"mode"`
	ID       string `json:"id"`
}

//export HnaCoreRuntimeSnapshot
func HnaCoreRuntimeSnapshot() *C.char {
	coreMu.Lock()
	defer coreMu.Unlock()
	result := harmonySnapshot{Logs: []string{}, Modes: []string{}}
	if coreServer != nil && coreRunning {
		result.Status = coreServer.StatusSnapshot()
		result.SampledAt = time.Now().UnixMilli()
		result.Groups = coreServer.GroupsSnapshot()
		result.Connections = coreServer.ConnectionsSnapshot()
		for _, line := range coreServer.SavedLog() {
			message := line.Message
			if len(message) > 2048 {
				message = message[:2048]
			}
			result.Logs = append(result.Logs, boxlog.FormatLevel(line.Level)+" "+message)
		}
		if mode, err := coreServer.GetClashModeStatus(context.Background(), &emptypb.Empty{}); err == nil {
			result.Modes = mode.ModeList
			result.Mode = mode.CurrentMode
		}
	}
	return C.CString(encodeHarmonySnapshot(result))
}

//export HnaCoreControl
func HnaCoreControl(payload *C.char) C.int32_t {
	if payload == nil {
		return C.int32_t(coreInvalidArgument)
	}
	var command harmonyControl
	parseErr := json.Unmarshal([]byte(C.GoString(payload)), &command)
	if parseErr == nil && command.Action == "cancel-url-test" {
		activeURLTest.interrupt()
		return C.int32_t(coreOK)
	}
	coreMu.Lock()
	defer coreMu.Unlock()
	if parseErr != nil {
		setLastError(parseErr)
		return C.int32_t(coreInvalidArgument)
	}
	if coreServer == nil || !coreRunning {
		setLastError(errors.New("core is not running"))
		return C.int32_t(coreNotRunning)
	}
	var err error
	switch command.Action {
	case "network-change":
		// Drop sockets tied to the former physical network. Every new socket
		// is protected and rebound using a fresh validated underlay snapshot.
		coreServer.ResetNetwork()
	case "close-connection":
		_, err = coreServer.CloseConnection(context.Background(), &daemon.CloseConnectionRequest{Id: command.ID})
	case "urltest":
		_, err = coreServer.URLTest(context.Background(), &daemon.URLTestRequest{OutboundTag: command.Group})
	case "select":
		_, err = coreServer.SelectOutbound(context.Background(), &daemon.SelectOutboundRequest{GroupTag: command.Group, OutboundTag: command.Outbound})
	case "mode":
		var modes *daemon.ClashModeStatus
		modes, err = coreServer.GetClashModeStatus(context.Background(), &emptypb.Empty{})
		if err == nil {
			found := false
			for _, mode := range modes.ModeList {
				if mode == command.Mode {
					found = true
				}
			}
			if !found {
				err = errors.New("unknown clash mode")
			} else {
				_, err = coreServer.SetClashMode(context.Background(), &daemon.ClashMode{Mode: command.Mode})
			}
		}
	case "clear-logs":
		_, err = coreServer.ClearLogs(context.Background(), &emptypb.Empty{})
	default:
		err = errors.New("unknown control action")
	}
	if err != nil {
		setLastError(err)
		return C.int32_t(coreInternalError)
	}
	setLastError(nil)
	return C.int32_t(coreOK)
}
