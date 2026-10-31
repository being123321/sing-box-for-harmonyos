package main

/*
#include <stdint.h>
#include <stdlib.h>
*/
import "C"

import (
	"encoding/json"
	"fmt"
	"os"

	"sync"
	"sync/atomic"
	"time"

	"github.com/sagernet/sing-box/experimental/libbox"
)

// ─────────────────────────────────────────────────────────────────────────────
// JSON types for Tailscale status serialisation
// ─────────────────────────────────────────────────────────────────────────────

type tailscalePeerJSON struct {
	StableID        string   `json:"stableID"`
	HostName        string   `json:"hostName"`
	DNSName         string   `json:"dnsName"`
	OS              string   `json:"os"`
	TailscaleIPs    []string `json:"tailscaleIPs"`
	SSHHostKeys     []string `json:"sshHostKeys"`
	Online          bool     `json:"online"`
	ExitNode        bool     `json:"exitNode"`
	ExitNodeOption  bool     `json:"exitNodeOption"`
	ShareeNode      bool     `json:"shareeNode"`
	Expired         bool     `json:"expired"`
	Active          bool     `json:"active"`
	CanReceiveFiles bool     `json:"canReceiveFiles"`
	RxBytes         int64    `json:"rxBytes"`
	TxBytes         int64    `json:"txBytes"`
	KeyExpiry       int64    `json:"keyExpiry"`
	LastSeen        int64    `json:"lastSeen"`
}

type tailscaleUserGroupJSON struct {
	UserID        int64               `json:"userID"`
	LoginName     string              `json:"loginName"`
	DisplayName   string              `json:"displayName"`
	ProfilePicURL string              `json:"profilePicURL"`
	Peers         []tailscalePeerJSON `json:"peers"`
}

type tailscaleEndpointStatusJSON struct {
	EndpointTag        string                   `json:"endpointTag"`
	BackendState       string                   `json:"backendState"`
	StateText          string                   `json:"stateText"`
	AuthURL            string                   `json:"authURL"`
	NetworkName        string                   `json:"networkName"`
	MagicDNSSuffix     string                   `json:"magicDNSSuffix"`
	Self               *tailscalePeerJSON       `json:"self"`
	ExitNode           *tailscalePeerJSON       `json:"exitNode"`
	KeyAuth            bool                     `json:"keyAuth"`
	CanShareFiles      bool                     `json:"canShareFiles"`
	WaitingFileCount   int32                    `json:"waitingFileCount"`
	ReceivingFileCount int32                    `json:"receivingFileCount"`
	UnreadFileCount    int32                    `json:"unreadFileCount"`
	UserGroups         []tailscaleUserGroupJSON `json:"userGroups"`
}

type tailscaleStatusUpdateJSON struct {
	Endpoints []tailscaleEndpointStatusJSON `json:"endpoints"`
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON types for Taildrop inbox serialisation
// ─────────────────────────────────────────────────────────────────────────────

type taildropFileJSON struct {
	Name       string `json:"name"`
	Size       int64  `json:"size"`
	SenderName string `json:"senderName"`
	ModifiedAt int64  `json:"modifiedAt"`
}

type taildropReceivingFileJSON struct {
	Name          string `json:"name"`
	Size          int64  `json:"size"`
	ReceivedBytes int64  `json:"receivedBytes"`
	SenderID      string `json:"senderID"`
	SenderName    string `json:"senderName"`
}

type taildropInboxJSON struct {
	EndpointTag string                      `json:"endpointTag"`
	Files       []taildropFileJSON          `json:"files"`
	Receiving   []taildropReceivingFileJSON `json:"receiving"`
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON types for Tailscale ping result
// ─────────────────────────────────────────────────────────────────────────────

type tailscalePingResultJSON struct {
	LatencyMs      float64 `json:"latencyMs"`
	IsDirect       bool    `json:"isDirect"`
	Endpoint       string  `json:"endpoint"`
	PeerRelay      string  `json:"peerRelay"`
	DERPRegionID   int32   `json:"derpRegionID"`
	DERPRegionCode string  `json:"derpRegionCode"`
	Error          string  `json:"error"`
}

// ─────────────────────────────────────────────────────────────────────────────
// Debug logging — writes to a file since stdout is /dev/null in VPN extension
// ─────────────────────────────────────────────────────────────────────────────

var tailscaleDebugLogMu sync.Mutex
var tailscaleDebugLogPath string

// tailscaleDebugLogMaxBytes bounds the on-device debug log. The VPN extension
// has no stdout, so a file is the only place to inspect lifecycle problems, but
// it must never grow without limit in a long-running release build.
const tailscaleDebugLogMaxBytes = 1 << 20 // 1 MiB

func tailscaleDebugLog(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	tailscaleDebugLogMu.Lock()
	defer tailscaleDebugLogMu.Unlock()
	if tailscaleDebugLogPath == "" {
		return
	}
	f, err := os.OpenFile(tailscaleDebugLogPath,
		os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return
	}
	defer f.Close()
	if info, err := f.Stat(); err == nil && info.Size() > tailscaleDebugLogMaxBytes {
		// O_APPEND keeps subsequent writes at the (new) end of the file.
		_ = f.Truncate(0)
	}
	fmt.Fprintf(f, "[%s] %s\n", time.Now().Format("15:04:05.000"), msg)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tailscale state cache — thread-safe storage for subscription snapshots
// ─────────────────────────────────────────────────────────────────────────────────────

type tailscaleStateCache struct {
	mu         sync.RWMutex
	statusJSON string
	inboxes    map[string]string // keyed by endpoint tag
}

func newTailscaleStateCache() *tailscaleStateCache {
	return &tailscaleStateCache{
		inboxes: make(map[string]string),
	}
}

func (c *tailscaleStateCache) setStatus(json string) {
	c.mu.Lock()
	c.statusJSON = json
	c.mu.Unlock()
}

func (c *tailscaleStateCache) getStatus() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.statusJSON
}

func (c *tailscaleStateCache) setInbox(endpointTag, json string) {
	c.mu.Lock()
	c.inboxes[endpointTag] = json
	c.mu.Unlock()
}

func (c *tailscaleStateCache) getInbox(endpointTag string) string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.inboxes[endpointTag]
}

func (c *tailscaleStateCache) clear() {
	c.mu.Lock()
	c.statusJSON = ""
	c.inboxes = make(map[string]string)
	c.mu.Unlock()
}

// ─────────────────────────────────────────────────────────────────────────────
// Tailscale status handler — receives streaming updates from CommandClient
// ─────────────────────────────────────────────────────────────────────────────

type tailscaleStatusHandler struct {
	cache  *tailscaleStateCache
	mu     sync.Mutex
	states map[string]string // endpoint tag → last logged backend state
}

func newTailscaleStatusHandler(cache *tailscaleStateCache) *tailscaleStatusHandler {
	return &tailscaleStatusHandler{
		cache:  cache,
		states: make(map[string]string),
	}
}

// logStateTransition records only real backend-state changes. Status updates
// arrive at heartbeat frequency (one entry per peer group), so logging every
// update would grow the file quickly and write peer/auth details that must not
// be persisted.
func (h *tailscaleStatusHandler) logStateTransition(endpointTag string, backendState string) {
	h.mu.Lock()
	previous, seen := h.states[endpointTag]
	if seen && previous == backendState {
		h.mu.Unlock()
		return
	}
	h.states[endpointTag] = backendState
	h.mu.Unlock()
	tailscaleDebugLog("endpoint=%s state=%s", endpointTag, backendState)
}

func (h *tailscaleStatusHandler) OnStatusUpdate(status *libbox.TailscaleStatusUpdate) {
	jsonData := tailscaleStatusUpdateToJSON(status)
	encoded, err := json.Marshal(jsonData)
	if err != nil {
		return
	}
	h.cache.setStatus(string(encoded))
	for _, ep := range jsonData.Endpoints {
		h.logStateTransition(ep.EndpointTag, ep.BackendState)
	}
}

func (h *tailscaleStatusHandler) OnError(message string) {
	tailscaleDebugLog("OnError: %s", message)
	// Store error as a minimal status JSON so the UI can display it
	errorStatus := tailscaleStatusUpdateJSON{
		Endpoints: []tailscaleEndpointStatusJSON{
			{BackendState: "Error", StateText: message},
		},
	}
	if encoded, err := json.Marshal(errorStatus); err == nil {
		h.cache.setStatus(string(encoded))
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Taildrop inbox handler — receives streaming inbox updates from CommandClient
// ─────────────────────────────────────────────────────────────────────────────

type taildropInboxHandler struct {
	cache       *tailscaleStateCache
	endpointTag string
}

func (h *taildropInboxHandler) OnInboxUpdate(inbox *libbox.TaildropInbox) {
	jsonData := taildropInboxToJSON(inbox)
	if encoded, err := json.Marshal(jsonData); err == nil {
		h.cache.setInbox(h.endpointTag, string(encoded))
	}
}

func (h *taildropInboxHandler) OnError(message string) {
	errorInbox := taildropInboxJSON{
		EndpointTag: h.endpointTag,
	}
	if encoded, err := json.Marshal(errorInbox); err == nil {
		h.cache.setInbox(h.endpointTag, string(encoded))
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Tailscale ping handler — collects ping results for a bounded duration
// ─────────────────────────────────────────────────────────────────────────────

type tailscalePingHandler struct {
	mu      sync.Mutex
	results []tailscalePingResultJSON
	done    chan struct{}
	once    sync.Once
}

func newTailscalePingHandler() *tailscalePingHandler {
	return &tailscalePingHandler{
		done: make(chan struct{}),
	}
}

// finish unblocks HnaCoreTailscalePing as soon as the stream ends, so a broken
// subscription fails fast instead of waiting for the full collection window.
func (h *tailscalePingHandler) finish() {
	h.once.Do(func() {
		close(h.done)
	})
}

func (h *tailscalePingHandler) OnPingResult(result *libbox.TailscalePingResult) {
	h.mu.Lock()
	h.results = append(h.results, tailscalePingResultJSON{
		LatencyMs:      result.LatencyMs,
		IsDirect:       result.IsDirect,
		Endpoint:       result.Endpoint,
		PeerRelay:      result.PeerRelay,
		DERPRegionID:   result.DERPRegionID,
		DERPRegionCode: result.DERPRegionCode,
		Error:          result.Error,
	})
	h.mu.Unlock()
}

func (h *tailscalePingHandler) OnError(message string) {
	h.mu.Lock()
	h.results = append(h.results, tailscalePingResultJSON{Error: message})
	h.mu.Unlock()
	h.finish()
}

func (h *tailscalePingHandler) getResults() []tailscalePingResultJSON {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.results
}

// ─────────────────────────────────────────────────────────────────────────────
// Taildrop download handler — tracks download progress
// ─────────────────────────────────────────────────────────────────────────────

type tailscaleDownloadHandler struct {
	done chan struct{}
	err  string
}

func newTailscaleDownloadHandler() *tailscaleDownloadHandler {
	return &tailscaleDownloadHandler{done: make(chan struct{})}
}

func (h *tailscaleDownloadHandler) OnProgress(downloaded int64, total int64) {
	// Progress is not exposed through the C API; the download is a blocking
	// operation that completes when OnFinish is called.
}

func (h *tailscaleDownloadHandler) OnFinish(errorMessage string) {
	h.err = errorMessage
	close(h.done)
}

// ─────────────────────────────────────────────────────────────────────────────
// Harmony command client handler — empty implementation for Tailscale-only use
// ─────────────────────────────────────────────────────────────────────────────

type harmonyCommandHandler struct{}

func (*harmonyCommandHandler) Connected()                                {}
func (*harmonyCommandHandler) Disconnected(message string)               {}
func (*harmonyCommandHandler) SetDefaultLogLevel(level int32)            {}
func (*harmonyCommandHandler) ClearLogs()                                {}
func (*harmonyCommandHandler) WriteLogs(messageList libbox.LogIterator)  {}
func (*harmonyCommandHandler) WriteStatus(message *libbox.StatusMessage) {}
func (*harmonyCommandHandler) WriteGroups(message libbox.OutboundGroupIterator) {
}
func (*harmonyCommandHandler) WriteOutbounds(message libbox.OutboundGroupItemIterator) {
}
func (*harmonyCommandHandler) InitializeClashMode(modeList libbox.StringIterator, currentMode string) {
}
func (*harmonyCommandHandler) UpdateClashMode(newMode string) {}
func (*harmonyCommandHandler) WriteConnectionEvents(events *libbox.ConnectionEvents) {
}

// ─────────────────────────────────────────────────────────────────────────────
// Global state for Tailscale operations
// ─────────────────────────────────────────────────────────────────────────────

var (
	coreCommandClient  atomic.Pointer[libbox.CommandClient]
	tailscaleCache     atomic.Pointer[tailscaleStateCache]
	tailscaleStatusSub *libbox.TailscaleStatusSubscription
	taildropSubsMu     sync.Mutex
	taildropSubs       = make(map[string]*libbox.TaildropInboxSubscription)
)

// ─────────────────────────────────────────────────────────────────────────────
// Conversion helpers — libbox iterator types → JSON structs
// ─────────────────────────────────────────────────────────────────────────────

func iteratorToSlice[T any](iter interface {
	HasNext() bool
	Next() T
}) []T {
	var result []T
	for iter.HasNext() {
		result = append(result, iter.Next())
	}
	return result
}

func stringIteratorToSlice(iter libbox.StringIterator) []string {
	if iter == nil {
		return nil
	}
	var result []string
	for iter.HasNext() {
		result = append(result, iter.Next())
	}
	return result
}

func tailscalePeerToJSON(peer *libbox.TailscalePeer) tailscalePeerJSON {
	if peer == nil {
		return tailscalePeerJSON{}
	}
	return tailscalePeerJSON{
		StableID:        peer.StableID,
		HostName:        peer.HostName,
		DNSName:         peer.DNSName,
		OS:              peer.OS,
		TailscaleIPs:    stringIteratorToSlice(peer.TailscaleIPs()),
		SSHHostKeys:     stringIteratorToSlice(peer.SSHHostKeys()),
		Online:          peer.Online,
		ExitNode:        peer.ExitNode,
		ExitNodeOption:  peer.ExitNodeOption,
		ShareeNode:      peer.ShareeNode,
		Expired:         peer.Expired,
		Active:          peer.Active,
		CanReceiveFiles: peer.CanReceiveFiles,
		RxBytes:         peer.RxBytes,
		TxBytes:         peer.TxBytes,
		KeyExpiry:       peer.KeyExpiry,
		LastSeen:        peer.LastSeen,
	}
}

func tailscaleUserGroupToJSON(group *libbox.TailscaleUserGroup) tailscaleUserGroupJSON {
	if group == nil {
		return tailscaleUserGroupJSON{}
	}
	peerIter := group.Peers()
	var peers []tailscalePeerJSON
	for peerIter.HasNext() {
		peers = append(peers, tailscalePeerToJSON(peerIter.Next()))
	}
	return tailscaleUserGroupJSON{
		UserID:        group.UserID,
		LoginName:     group.LoginName,
		DisplayName:   group.DisplayName,
		ProfilePicURL: group.ProfilePicURL,
		Peers:         peers,
	}
}

func tailscaleEndpointStatusToJSON(status *libbox.TailscaleEndpointStatus) tailscaleEndpointStatusJSON {
	if status == nil {
		return tailscaleEndpointStatusJSON{}
	}
	groupIter := status.UserGroups()
	var groups []tailscaleUserGroupJSON
	for groupIter.HasNext() {
		groups = append(groups, tailscaleUserGroupToJSON(groupIter.Next()))
	}
	result := tailscaleEndpointStatusJSON{
		EndpointTag:        status.EndpointTag,
		BackendState:       status.BackendState,
		StateText:          status.StateText,
		AuthURL:            status.AuthURL,
		NetworkName:        status.NetworkName,
		MagicDNSSuffix:     status.MagicDNSSuffix,
		KeyAuth:            status.KeyAuth,
		CanShareFiles:      status.CanShareFiles,
		WaitingFileCount:   status.WaitingFileCount,
		ReceivingFileCount: status.ReceivingFileCount,
		UnreadFileCount:    status.UnreadFileCount,
		UserGroups:         groups,
	}
	if status.Self != nil {
		result.Self = &tailscalePeerJSON{}
		*result.Self = tailscalePeerToJSON(status.Self)
	}
	if status.ExitNode != nil {
		result.ExitNode = &tailscalePeerJSON{}
		*result.ExitNode = tailscalePeerToJSON(status.ExitNode)
	}
	return result
}

func tailscaleStatusUpdateToJSON(update *libbox.TailscaleStatusUpdate) tailscaleStatusUpdateJSON {
	if update == nil {
		return tailscaleStatusUpdateJSON{}
	}
	endpointIter := update.Endpoints()
	var endpoints []tailscaleEndpointStatusJSON
	for endpointIter.HasNext() {
		endpoints = append(endpoints, tailscaleEndpointStatusToJSON(endpointIter.Next()))
	}
	return tailscaleStatusUpdateJSON{Endpoints: endpoints}
}

func taildropInboxToJSON(inbox *libbox.TaildropInbox) taildropInboxJSON {
	if inbox == nil {
		return taildropInboxJSON{}
	}
	result := taildropInboxJSON{EndpointTag: inbox.EndpointTag}
	fileIter := inbox.Files()
	for fileIter.HasNext() {
		f := fileIter.Next()
		result.Files = append(result.Files, taildropFileJSON{
			Name:       f.Name,
			Size:       f.Size,
			SenderName: f.SenderName,
			ModifiedAt: f.ModifiedAt,
		})
	}
	recvIter := inbox.Receiving()
	for recvIter.HasNext() {
		r := recvIter.Next()
		result.Receiving = append(result.Receiving, taildropReceivingFileJSON{
			Name:          r.Name,
			Size:          r.Size,
			ReceivedBytes: r.ReceivedBytes,
			SenderID:      r.SenderID,
			SenderName:    r.SenderName,
		})
	}
	return result
}

// ─────────────────────────────────────────────────────────────────────────────
// C export functions for Tailscale operations
// ─────────────────────────────────────────────────────────────────────────────

//export HnaCoreTailscaleStatus
func HnaCoreTailscaleStatus() *C.char {
	cache := tailscaleCache.Load()
	if cache == nil {
		tailscaleDebugLog("HnaCoreTailscaleStatus: cache is nil")
		return C.CString(`{"endpoints":[]}`)
	}
	status := cache.getStatus()
	if status == "" {
		tailscaleDebugLog("HnaCoreTailscaleStatus: cache is empty")
		return C.CString(`{"endpoints":[]}`)
	}
	return C.CString(status)
}

//export HnaCoreTailscaleSetExitNode
func HnaCoreTailscaleSetExitNode(endpointTag *C.char, stableID *C.char) C.int32_t {
	client := coreCommandClient.Load()
	if endpointTag == nil || stableID == nil {
		return C.int32_t(coreInvalidArgument)
	}
	if client == nil {
		setLastError(errCommandClientNotReady)
		return C.int32_t(coreUnavailable)
	}
	err := client.SetTailscaleExitNode(C.GoString(endpointTag), C.GoString(stableID))
	if err != nil {
		setLastError(err)
		return C.int32_t(coreInternalError)
	}
	setLastError(nil)
	return C.int32_t(coreOK)
}

//export HnaCoreTailscaleLogout
func HnaCoreTailscaleLogout(endpointTag *C.char) C.int32_t {
	client := coreCommandClient.Load()
	if endpointTag == nil {
		return C.int32_t(coreInvalidArgument)
	}
	if client == nil {
		setLastError(errCommandClientNotReady)
		return C.int32_t(coreUnavailable)
	}
	err := client.TailscaleLogout(C.GoString(endpointTag))
	if err != nil {
		setLastError(err)
		return C.int32_t(coreInternalError)
	}
	setLastError(nil)
	return C.int32_t(coreOK)
}

//export HnaCoreTailscalePing
func HnaCoreTailscalePing(endpointTag *C.char, peerIP *C.char) *C.char {
	client := coreCommandClient.Load()
	if endpointTag == nil || peerIP == nil {
		return C.CString(`[{"error":"invalid argument"}]`)
	}
	if client == nil {
		return C.CString(`[{"error":"command client not ready"}]`)
	}
	handler := newTailscalePingHandler()
	session, err := client.StartTailscalePing(C.GoString(endpointTag), C.GoString(peerIP), handler)
	if err != nil {
		encoded, _ := json.Marshal([]tailscalePingResultJSON{{Error: err.Error()}})
		return C.CString(string(encoded))
	}
	// Collect results for up to 5 seconds, then stop the session
	select {
	case <-time.After(5 * time.Second):
	case <-handler.done:
	}
	session.Close()
	results := handler.getResults()
	if len(results) == 0 {
		return C.CString(`[]`)
	}
	encoded, err := json.Marshal(results)
	if err != nil {
		return C.CString(`[{"error":"json encode failed"}]`)
	}
	return C.CString(string(encoded))
}

//export HnaCoreTaildropSubscribe
func HnaCoreTaildropSubscribe(endpointTag *C.char) C.int32_t {
	taildropSubsMu.Lock()
	defer taildropSubsMu.Unlock()
	client := coreCommandClient.Load()
	cache := tailscaleCache.Load()
	if endpointTag == nil {
		return C.int32_t(coreInvalidArgument)
	}
	if client == nil {
		setLastError(errCommandClientNotReady)
		return C.int32_t(coreUnavailable)
	}
	tag := C.GoString(endpointTag)
	// Already subscribed to this endpoint
	if _, exists := taildropSubs[tag]; exists {
		return C.int32_t(coreOK)
	}
	handler := &taildropInboxHandler{
		cache:       cache,
		endpointTag: tag,
	}
	sub, err := client.SubscribeTaildropInbox(tag, handler)
	if err != nil {
		setLastError(err)
		return C.int32_t(coreInternalError)
	}
	taildropSubs[tag] = sub
	setLastError(nil)
	return C.int32_t(coreOK)
}

//export HnaCoreTaildropInbox
func HnaCoreTaildropInbox(endpointTag *C.char) *C.char {
	cache := tailscaleCache.Load()
	if endpointTag == nil {
		return C.CString(`{"files":[],"receiving":[]}`)
	}
	if cache == nil {
		return C.CString(`{"files":[],"receiving":[]}`)
	}
	tag := C.GoString(endpointTag)
	inboxJSON := cache.getInbox(tag)
	if inboxJSON == "" {
		encoded, _ := json.Marshal(taildropInboxJSON{EndpointTag: tag, Files: []taildropFileJSON{}, Receiving: []taildropReceivingFileJSON{}})
		return C.CString(string(encoded))
	}
	return C.CString(inboxJSON)
}

//export HnaCoreTaildropDownload
func HnaCoreTaildropDownload(endpointTag *C.char, name *C.char, destPath *C.char) C.int32_t {
	client := coreCommandClient.Load()
	if endpointTag == nil || name == nil || destPath == nil {
		return C.int32_t(coreInvalidArgument)
	}
	if client == nil {
		setLastError(errCommandClientNotReady)
		return C.int32_t(coreUnavailable)
	}
	handler := newTailscaleDownloadHandler()
	session, err := client.DownloadTaildropFile(
		C.GoString(endpointTag),
		C.GoString(name),
		C.GoString(destPath),
		handler,
	)
	if err != nil {
		setLastError(err)
		return C.int32_t(coreInternalError)
	}
	defer session.Close()
	// Block until download completes or times out
	select {
	case <-handler.done:
	case <-time.After(60 * time.Second):
		session.Close()
		setLastError(errDownloadTimeout)
		return C.int32_t(coreInternalError)
	}
	if handler.err != "" {
		setLastError(errDownloadFailed)
		return C.int32_t(coreInternalError)
	}
	setLastError(nil)
	return C.int32_t(coreOK)
}

//export HnaCoreTaildropDelete
func HnaCoreTaildropDelete(endpointTag *C.char, name *C.char) C.int32_t {
	client := coreCommandClient.Load()
	if endpointTag == nil || name == nil {
		return C.int32_t(coreInvalidArgument)
	}
	if client == nil {
		setLastError(errCommandClientNotReady)
		return C.int32_t(coreUnavailable)
	}
	err := client.DeleteTaildropFile(C.GoString(endpointTag), C.GoString(name))
	if err != nil {
		setLastError(err)
		return C.int32_t(coreInternalError)
	}
	setLastError(nil)
	return C.int32_t(coreOK)
}

//export HnaCoreTaildropMarkRead
func HnaCoreTaildropMarkRead(endpointTag *C.char) C.int32_t {
	client := coreCommandClient.Load()
	if endpointTag == nil {
		return C.int32_t(coreInvalidArgument)
	}
	if client == nil {
		setLastError(errCommandClientNotReady)
		return C.int32_t(coreUnavailable)
	}
	err := client.MarkTaildropInboxRead(C.GoString(endpointTag))
	if err != nil {
		setLastError(err)
		return C.int32_t(coreInternalError)
	}
	setLastError(nil)
	return C.int32_t(coreOK)
}

//export HnaCoreTaildropCancelReceive
func HnaCoreTaildropCancelReceive(endpointTag *C.char, senderID *C.char, name *C.char) C.int32_t {
	client := coreCommandClient.Load()
	if endpointTag == nil || senderID == nil || name == nil {
		return C.int32_t(coreInvalidArgument)
	}
	if client == nil {
		setLastError(errCommandClientNotReady)
		return C.int32_t(coreUnavailable)
	}
	err := client.CancelTaildropReceiving(
		C.GoString(endpointTag),
		C.GoString(senderID),
		C.GoString(name),
	)
	if err != nil {
		setLastError(err)
		return C.int32_t(coreInternalError)
	}
	setLastError(nil)
	return C.int32_t(coreOK)
}

// ─────────────────────────────────────────────────────────────────────────────
// Error constants for Tailscale operations
// ─────────────────────────────────────────────────────────────────────────────

var (
	errCommandClientNotReady = errString("command client is not ready")
	errDownloadTimeout       = errString("taildrop download timed out")
	errDownloadFailed        = errString("taildrop download failed")
)

type errString string

func (e errString) Error() string { return string(e) }

// ─────────────────────────────────────────────────────────────────────────────
// Tailscale lifecycle management — called from main.go
// ─────────────────────────────────────────────────────────────────────────────

// startTailscaleInfrastructure starts the gRPC server, creates a CommandClient,
// and subscribes to Tailscale status updates. Called from HnaCoreInitialize
// after the CommandServer is created.
// startTailscaleInfrastructure creates a CommandClient, connects it to the
// gRPC server, and subscribes to Tailscale status updates. Called from
// HnaCoreStart after the core service is running.
func startTailscaleInfrastructure() {
	tailscaleDebugLog("startTailscaleInfrastructure: creating CommandClient")
	// Create a handler-bound CommandClient with a persistent connection
	client := libbox.NewCommandClient(
		&harmonyCommandHandler{},
		&libbox.CommandClientOptions{},
	)
	if err := client.Connect(); err != nil {
		tailscaleDebugLog("startTailscaleInfrastructure: CommandClient.Connect failed: %v", err)
		// Connection failure is non-fatal: Tailscale operations will return
		// "command client not ready" until a successful connection is made.
		_ = client.Disconnect()
		return
	}
	tailscaleDebugLog("startTailscaleInfrastructure: CommandClient connected")

	// Initialize the Tailscale state cache
	cache := newTailscaleStateCache()
	tailscaleCache.Store(cache)
	coreCommandClient.Store(client)

	// Subscribe to Tailscale status updates — the subscription automatically
	// follows instance lifecycle (start/stop/reload) via followInstance
	sub, err := client.SubscribeTailscaleStatus(
		newTailscaleStatusHandler(cache),
	)
	if err != nil {
		tailscaleDebugLog("startTailscaleInfrastructure: SubscribeTailscaleStatus failed: %v", err)
		// Subscription failure is non-fatal: status will be empty until
		// a successful subscription is established on the next reload.
		return
	}
	tailscaleStatusSub = sub
	tailscaleDebugLog("startTailscaleInfrastructure: SubscribeTailscaleStatus succeeded")
}

// restartTailscaleSubscription closes the existing subscription and creates
// a new one. Called from HnaCoreReload after the service instance changes.
func restartTailscaleSubscription() {
	if tailscaleStatusSub != nil {
		tailscaleStatusSub.Close()
		tailscaleStatusSub = nil
	}
	client := coreCommandClient.Load()
	if client == nil {
		startTailscaleInfrastructure()
		return
	}
	cache := tailscaleCache.Load()
	if cache == nil {
		cache = newTailscaleStateCache()
		tailscaleCache.Store(cache)
	}
	sub, err := client.SubscribeTailscaleStatus(newTailscaleStatusHandler(cache))
	if err == nil {
		tailscaleStatusSub = sub
	}
}

// stopTailscaleInfrastructure closes all Tailscale subscriptions and the
// CommandClient. Called when the core is being destroyed (not on stop/reload).
func stopTailscaleInfrastructure() {
	if client := coreCommandClient.Swap(nil); client != nil {
		_ = client.Disconnect()
	}
	if tailscaleStatusSub != nil {
		tailscaleStatusSub.Close()
		tailscaleStatusSub = nil
	}
	taildropSubsMu.Lock()
	for tag, sub := range taildropSubs {
		sub.Close()
		delete(taildropSubs, tag)
	}
	taildropSubsMu.Unlock()

	// Drop the cached snapshot; a stopped core must not keep reporting the
	// previous "Running" state to the UI.
	if cache := tailscaleCache.Swap(nil); cache != nil {
		cache.clear()
	}
}
