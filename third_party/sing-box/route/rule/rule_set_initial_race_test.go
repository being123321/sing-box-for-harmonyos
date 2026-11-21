package rule

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/sagernet/sing-box/adapter"
	C "github.com/sagernet/sing-box/constant"
	"github.com/sagernet/sing-box/option"
	"github.com/sagernet/sing/common/logger"
	"github.com/sagernet/sing/service"
	"github.com/stretchr/testify/require"
)

type ruleSetTestTransport struct {
	roundTrip func(*http.Request) (*http.Response, error)
}

func (t ruleSetTestTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return t.roundTrip(req)
}
func (t ruleSetTestTransport) CloseIdleConnections() {}
func (t ruleSetTestTransport) Reset()                {}

type ruleSetTestClients struct {
	adapter.HTTPClientManager
	candidates map[string]adapter.HTTPTransport
}

func (m ruleSetTestClients) RuleSetCandidateTransport(_ context.Context, _ logger.ContextLogger, _ option.HTTPClientOptions, detour string) (adapter.HTTPTransport, error) {
	return m.candidates[detour], nil
}

func TestInitialRuleSetRacesDirectAndNodesUntilValid(t *testing.T) {
	directStarted := make(chan struct{})
	badAttempt := make(chan struct{})
	primaryStarted := make(chan struct{})
	primaryStopped := make(chan struct{})
	primary := ruleSetTestTransport{func(req *http.Request) (*http.Response, error) {
		close(primaryStarted)
		<-req.Context().Done()
		close(primaryStopped)
		return nil, req.Context().Err()
	}}
	direct := ruleSetTestTransport{func(req *http.Request) (*http.Response, error) {
		close(directStarted)
		<-req.Context().Done()
		return nil, req.Context().Err()
	}}
	bad := ruleSetTestTransport{func(*http.Request) (*http.Response, error) {
		close(badAttempt)
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("not a rule set"))}, nil
	}}
	good := ruleSetTestTransport{func(req *http.Request) (*http.Response, error) {
		for _, signal := range []chan struct{}{primaryStarted, directStarted, badAttempt} {
			select {
			case <-signal:
			case <-req.Context().Done():
				return nil, req.Context().Err()
			}
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Etag": {"winner"}},
			Body:       io.NopCloser(strings.NewReader(`{"version":4,"rules":[{"domain":["example.com"]}]}`)),
		}, nil
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ctx = service.ContextWith[adapter.HTTPClientManager](ctx, ruleSetTestClients{candidates: map[string]adapter.HTTPTransport{
		"": direct, "bad": bad, "good": good,
	}})
	set := &RemoteRuleSet{
		ctx:        ctx,
		url:        "https://example.com/rules.json",
		logger:     logger.NOP(),
		options:    option.RuleSet{Format: C.RuleSetFormatSource},
		httpClient: &http.Client{Transport: primary},
	}
	require.NoError(t, set.raceInitialFetch(ctx, option.HTTPClientOptions{}, []string{"", "bad", "good"}))
	require.Equal(t, "winner", set.lastEtag)
	require.True(t, set.Match(&adapter.InboundContext{Domain: "example.com"}))
	select {
	case <-primaryStopped:
	default:
		t.Fatal("the losing primary request was not canceled")
	}
}
