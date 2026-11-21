package rule

import (
	"bytes"
	"context"
	"crypto/sha256"
	"io"
	"net/http"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing-box/common/srs"
	C "github.com/sagernet/sing-box/constant"
	"github.com/sagernet/sing-box/experimental/deprecated"
	"github.com/sagernet/sing-box/option"
	"github.com/sagernet/sing/common"
	E "github.com/sagernet/sing/common/exceptions"
	F "github.com/sagernet/sing/common/format"
	"github.com/sagernet/sing/common/json"
	"github.com/sagernet/sing/common/logger"
	N "github.com/sagernet/sing/common/network"
	"github.com/sagernet/sing/common/x/list"
	"github.com/sagernet/sing/service"
	"github.com/sagernet/sing/service/filemanager"
	"github.com/sagernet/sing/service/pause"

	"go4.org/netipx"
)

var _ adapter.RuleSet = (*RemoteRuleSet)(nil)

type RemoteRuleSet struct {
	ctx            context.Context
	cancel         context.CancelFunc
	logger         logger.ContextLogger
	outbound       adapter.OutboundManager
	tag            string
	url            string
	urlHash        [32]byte
	initialPath    string
	options        option.RuleSet
	updateInterval time.Duration
	httpClient     *http.Client
	access         sync.RWMutex
	rules          []adapter.HeadlessRule
	metadata       adapter.RuleSetMetadata
	lastUpdated    time.Time
	lastEtag       string
	cacheFile      adapter.CacheFile
	pauseManager   pause.Manager
	callbacks      list.List[adapter.RuleSetUpdateCallback]
	refs           atomic.Int32
}

func NewRemoteRuleSet(ctx context.Context, logger logger.ContextLogger, tag string, options option.RuleSet) (*RemoteRuleSet, error) {
	ctx, cancel := context.WithCancel(ctx)
	var updateInterval time.Duration
	if options.RemoteOptions.UpdateInterval > 0 {
		updateInterval = time.Duration(options.RemoteOptions.UpdateInterval)
	} else {
		updateInterval = 24 * time.Hour
	}
	var initialPath string
	if options.RemoteOptions.InitialPath != "" {
		initialPath = filemanager.BasePath(ctx, strings.ReplaceAll(options.RemoteOptions.InitialPath, C.RuleSetTagPlaceholder, tag))
		initialPath, _ = filepath.Abs(initialPath)
	}
	url := strings.ReplaceAll(options.RemoteOptions.URL, C.RuleSetTagPlaceholder, tag)
	return &RemoteRuleSet{
		ctx:            ctx,
		cancel:         cancel,
		outbound:       service.FromContext[adapter.OutboundManager](ctx),
		logger:         logger,
		tag:            tag,
		url:            url,
		urlHash:        sha256.Sum256([]byte(url)),
		initialPath:    initialPath,
		options:        options,
		updateInterval: updateInterval,
		pauseManager:   service.FromContext[pause.Manager](ctx),
	}, nil
}

func (s *RemoteRuleSet) Name() string {
	return s.tag
}

func (s *RemoteRuleSet) String() string {
	return strings.Join(F.MapToString(s.rules), " ")
}

func (s *RemoteRuleSet) StartContext(ctx context.Context, startContext *adapter.HTTPStartContext) error {
	s.cacheFile = service.FromContext[adapter.CacheFile](s.ctx)
	transport, err := s.resolveTransport()
	if err != nil {
		return E.Cause(err, "create rule-set http client")
	}
	startContext.Register(transport)
	s.httpClient = &http.Client{Transport: transport}
	if s.cacheFile != nil {
		savedSet := s.cacheFile.LoadRuleSet(s.tag)
		if savedSet != nil {
			if len(savedSet.URLHash) > 0 && !bytes.Equal(savedSet.URLHash, s.urlHash[:]) {
				s.logger.Info("cached rule-set was downloaded from another URL, will refetch")
			} else {
				err = s.loadBytes(savedSet.Content)
				if err != nil {
					s.logger.Warn(E.Cause(err, "restore cached rule-set, will refetch"))
				} else {
					s.lastUpdated = savedSet.LastUpdated
					s.lastEtag = savedSet.LastEtag
				}
			}
		}
	}
	var loadedFromInitialPath bool
	if s.lastUpdated.IsZero() && s.initialPath != "" {
		var content []byte
		content, err = filemanager.ReadFile(s.ctx, s.initialPath)
		if err == nil {
			err = s.loadBytes(content)
		}
		if err != nil {
			s.logger.Warn(E.Cause(err, "load initial rule-set from ", s.initialPath))
		} else {
			loadedFromInitialPath = true
		}
	}
	if s.lastUpdated.IsZero() && !loadedFromInitialPath {
		err = s.fetchInitial(ctx)
		if err != nil {
			return E.Cause(err, "initial rule-set: ", s.tag)
		}
	}
	return nil
}

func (s *RemoteRuleSet) Metadata() adapter.RuleSetMetadata {
	s.access.RLock()
	defer s.access.RUnlock()
	return s.metadata
}

func (s *RemoteRuleSet) ExtractIPSet() []*netipx.IPSet {
	s.access.RLock()
	defer s.access.RUnlock()
	return common.FlatMap(s.rules, extractIPSetFromRule)
}

func (s *RemoteRuleSet) IncRef() {
	s.refs.Add(1)
}

func (s *RemoteRuleSet) DecRef() {
	if s.refs.Add(-1) < 0 {
		panic("rule-set: negative refs")
	}
}

func (s *RemoteRuleSet) Cleanup() {
	if s.refs.Load() == 0 {
		s.rules = nil
	}
}

func (s *RemoteRuleSet) RegisterCallback(callback adapter.RuleSetUpdateCallback) *list.Element[adapter.RuleSetUpdateCallback] {
	s.access.Lock()
	defer s.access.Unlock()
	return s.callbacks.PushBack(callback)
}

func (s *RemoteRuleSet) UnregisterCallback(element *list.Element[adapter.RuleSetUpdateCallback]) {
	s.access.Lock()
	defer s.access.Unlock()
	s.callbacks.Remove(element)
}

func (s *RemoteRuleSet) loadBytes(content []byte) error {
	var (
		ruleSet option.PlainRuleSetCompat
		err     error
	)
	switch s.options.Format {
	case C.RuleSetFormatSource:
		ruleSet, err = json.UnmarshalExtended[option.PlainRuleSetCompat](content)
		if err != nil {
			return err
		}
	case C.RuleSetFormatBinary:
		ruleSet, err = srs.Read(bytes.NewReader(content), false)
		if err != nil {
			return err
		}
	default:
		return E.New("unknown rule-set format: ", s.options.Format)
	}
	plainRuleSet, err := mmapRuleSet(s.ctx, s.logger, s.tag, ruleSet).Upgrade()
	if err != nil {
		return err
	}
	rules := make([]adapter.HeadlessRule, len(plainRuleSet.Rules))
	for i, ruleOptions := range plainRuleSet.Rules {
		rules[i], err = NewHeadlessRule(s.ctx, ruleOptions)
		if err != nil {
			return E.Cause(err, "parse rule_set.rules.[", i, "]")
		}
	}
	metadata := buildRuleSetMetadata(plainRuleSet.Rules)
	err = validateRuleSetMetadataUpdate(s.ctx, s.tag, metadata)
	if err != nil {
		return err
	}
	s.access.Lock()
	s.metadata = metadata
	s.rules = rules
	callbacks := s.callbacks.Array()
	s.access.Unlock()
	for _, callback := range callbacks {
		callback(s)
	}
	return nil
}

func (s *RemoteRuleSet) updateOnce() {
	err := s.fetch(s.ctx, false)
	if err != nil {
		s.logger.Error("fetch rule-set ", s.tag, ": ", err)
	} else if s.refs.Load() == 0 {
		s.rules = nil
	}
}

func (s *RemoteRuleSet) fetch(ctx context.Context, isStart bool) error {
	s.logger.Debug("updating rule-set ", s.tag, " from URL: ", s.url)
	request, err := http.NewRequest("GET", s.url, nil)
	if err != nil {
		return err
	}
	if s.lastEtag != "" {
		request.Header.Set("If-None-Match", s.lastEtag)
	}
	if !isStart {
		defer s.httpClient.CloseIdleConnections()
	}
	response, err := s.httpClient.Do(request.WithContext(ctx))
	if err != nil {
		return err
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusOK:
	case http.StatusNotModified:
		s.lastUpdated = time.Now()
		if s.cacheFile != nil {
			savedRuleSet := s.cacheFile.LoadRuleSet(s.tag)
			if savedRuleSet != nil {
				savedRuleSet.LastUpdated = s.lastUpdated
				savedRuleSet.URLHash = s.urlHash[:]
				err = s.cacheFile.SaveRuleSet(s.tag, savedRuleSet)
				if err != nil {
					s.logger.Error("save rule-set updated time: ", err)
					return nil
				}
			}
		}
		s.logger.Info("update rule-set ", s.tag, ": not modified")
		return nil
	default:
		return E.New("unexpected status: ", response.Status)
	}
	content, err := io.ReadAll(response.Body)
	if err != nil {
		return err
	}
	err = s.loadBytes(content)
	if err != nil {
		return err
	}
	eTagHeader := response.Header.Get("Etag")
	return s.saveFetchedRuleSet(content, eTagHeader)
}

func (s *RemoteRuleSet) saveFetchedRuleSet(content []byte, eTagHeader string) error {
	if eTagHeader != "" {
		s.lastEtag = eTagHeader
	}
	s.lastUpdated = time.Now()
	if s.cacheFile != nil {
		err := s.cacheFile.SaveRuleSet(s.tag, &adapter.SavedBinary{
			LastUpdated: s.lastUpdated,
			Content:     content,
			LastEtag:    s.lastEtag,
			URLHash:     s.urlHash[:],
		})
		if err != nil {
			s.logger.Error("save rule-set cache: ", err)
		}
	}
	s.logger.Info("updated rule-set ", s.tag)
	return nil
}

// Initial startup cannot rely on the VPN route that this rule-set is needed to build.
func (s *RemoteRuleSet) fetchInitial(ctx context.Context) error {
	if runtime.GOOS != "openharmony" || s.outbound == nil {
		return s.fetch(ctx, true)
	}
	var baseOptions option.HTTPClientOptions
	if configured := s.options.RemoteOptions.HTTPClient; configured != nil {
		baseOptions = *configured
	}
	tags := []string{""} // Empty here is the platform direct dialer.
	configuredTag := s.options.RemoteOptions.DownloadDetour
	if baseOptions.Detour != "" {
		configuredTag = baseOptions.Detour
	}
	for _, outbound := range s.outbound.Outbounds() {
		if outbound.Tag() == "" || outbound.Tag() == configuredTag {
			continue
		}
		switch outbound.Type() {
		case C.TypeDirect, C.TypeBlock, C.TypeDNS, C.TypeSelector, C.TypeURLTest:
			continue
		}
		if common.Contains(outbound.Network(), N.NetworkTCP) {
			tags = append(tags, outbound.Tag())
		}
	}
	if len(tags) == 1 && configuredTag == "" && baseOptions.Tag == "" {
		return s.fetch(ctx, true)
	}
	return s.raceInitialFetch(ctx, baseOptions, tags)
}

func (s *RemoteRuleSet) raceInitialFetch(ctx context.Context, options option.HTTPClientOptions, tags []string) error {
	manager := service.FromContext[adapter.HTTPClientManager](s.ctx)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	type result struct {
		content []byte
		etag    string
		err     error
	}
	attempts := make(chan int, len(tags)+1)
	for i := -1; i < len(tags); i++ {
		attempts <- i
	}
	close(attempts)
	results := make(chan result)
	var workers sync.WaitGroup
	for i := 0; i < min(4, len(tags)+1); i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for index := range attempts {
				if ctx.Err() != nil {
					return
				}
				client := s.httpClient
				if index >= 0 {
					transport, err := manager.RuleSetCandidateTransport(s.ctx, s.logger, options, tags[index])
					if err != nil {
						select {
						case results <- result{err: err}:
						case <-ctx.Done():
						}
						continue
					}
					client = &http.Client{Transport: transport}
				}
				attemptCtx, stop := context.WithTimeout(ctx, 5*time.Second)
				content, etag, err := readInitialRuleSet(attemptCtx, client, s.url)
				stop()
				if index >= 0 {
					client.CloseIdleConnections()
				}
				select {
				case results <- result{content, etag, err}:
				case <-ctx.Done():
					return
				}
			}
		}()
	}
	go func() {
		workers.Wait()
		close(results)
	}()
	var lastErr error
	for attempt := range results {
		if attempt.err != nil {
			lastErr = attempt.err
			continue
		}
		if err := s.loadBytes(attempt.content); err != nil {
			lastErr = err
			continue
		}
		cancel()
		workers.Wait()
		return s.saveFetchedRuleSet(attempt.content, attempt.etag)
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return E.Cause(lastErr, "all rule-set download paths failed")
}

func readInitialRuleSet(ctx context.Context, client *http.Client, url string) ([]byte, string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, "", err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, "", E.New("unexpected status: ", response.Status)
	}
	const maxRuleSetSize = 32 << 20
	content, err := io.ReadAll(io.LimitReader(response.Body, maxRuleSetSize+1))
	if err != nil {
		return nil, "", err
	}
	if len(content) > maxRuleSetSize {
		return nil, "", E.New("remote rule-set exceeds download size limit")
	}
	return content, response.Header.Get("ETag"), nil
}

func (s *RemoteRuleSet) resolveTransport() (adapter.HTTPTransport, error) {
	httpClientManager := service.FromContext[adapter.HTTPClientManager](s.ctx)
	if s.options.RemoteOptions.HTTPClient != nil && !s.options.RemoteOptions.HTTPClient.IsEmpty() {
		if s.options.RemoteOptions.DownloadDetour != "" { //nolint:staticcheck
			return nil, E.New("http_client is conflict with deprecated download_detour field")
		}
		return httpClientManager.ResolveTransport(s.ctx, s.logger, *s.options.RemoteOptions.HTTPClient)
	}
	if s.options.RemoteOptions.DownloadDetour != "" { //nolint:staticcheck
		deprecated.Report(s.ctx, deprecated.OptionLegacyRuleSetDownloadDetour)
		return httpClientManager.ResolveTransport(s.ctx, s.logger, option.HTTPClientOptions{
			DialerOptions: option.DialerOptions{
				Detour: s.options.RemoteOptions.DownloadDetour, //nolint:staticcheck
			},
			DisableEmptyDirectCheck: true,
		})
	}
	defaultTransport := httpClientManager.DefaultTransport()
	if defaultTransport == nil {
		return nil, E.New("default http client transport is not initialized")
	}
	return defaultTransport, nil
}

func (s *RemoteRuleSet) Close() error {
	s.rules = nil
	s.cancel()
	return nil
}

func (s *RemoteRuleSet) Match(metadata *adapter.InboundContext) bool {
	return matchAnyHeadlessRule(s.rules, metadata)
}

func (s *RemoteRuleSet) mergeableRule() *DefaultHeadlessRule {
	return mergeableRuleIn(s.rules)
}
