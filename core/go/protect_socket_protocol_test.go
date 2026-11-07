package main

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
)

func eligibleWiFi(netID int32) underlayCandidate {
	return underlayCandidate{
		netID:        netID,
		isDefault:    true,
		hasInternet:  true,
		hasNotVPN:    true,
		hasValidated: true,
		hasWiFi:      true,
		hasCellular:  false,
		hasVPN:       false,
	}
}

func eligibleCellular(netID int32) underlayCandidate {
	candidate := eligibleWiFi(netID)
	candidate.hasWiFi = false
	candidate.hasCellular = true
	return candidate
}

func TestSelectUnderlayNetworkFollowsDefaultDataSIM(t *testing.T) {
	previousSIM := eligibleCellular(10)
	previousSIM.isDefault = false
	connectedWiFi := eligibleWiFi(7)
	connectedWiFi.isDefault = false
	candidates := []underlayCandidate{
		previousSIM,
		eligibleCellular(90),
		connectedWiFi,
	}
	netID, err := selectUnderlayNetwork(candidates)
	if err != nil {
		t.Fatalf("select underlay: %v", err)
	}
	if netID != 90 {
		t.Fatalf("selected netId = %d, want current default SIM netId 90", netID)
	}
}

func TestSelectUnderlayNetworkDoesNotFallBackFromUnvalidatedDefault(t *testing.T) {
	defaultSIM := eligibleCellular(90)
	defaultSIM.hasValidated = false
	previousSIM := eligibleCellular(10)
	previousSIM.isDefault = false
	_, err := selectUnderlayNetwork([]underlayCandidate{defaultSIM, previousSIM})
	if !errors.Is(err, errNoEligibleUnderlay) {
		t.Fatalf("error = %v, want refusal instead of binding the previous SIM", err)
	}
}

func TestSelectUnderlayNetworkRejectsMissingOrAmbiguousDefault(t *testing.T) {
	nonDefault := eligibleWiFi(7)
	nonDefault.isDefault = false
	for _, candidates := range [][]underlayCandidate{
		nil,
		{nonDefault},
		{eligibleWiFi(7), eligibleCellular(90)},
	} {
		if _, err := selectUnderlayNetwork(candidates); !errors.Is(err, errNoEligibleUnderlay) {
			t.Fatalf("candidates=%+v error=%v, want errNoEligibleUnderlay", candidates, err)
		}
	}
}

func TestSelectUnderlayNetworkRejectsIncompleteOrUnsafeNetworks(t *testing.T) {
	tests := []struct {
		name      string
		candidate underlayCandidate
	}{
		{name: "invalid netId", candidate: eligibleWiFi(0)},
		{name: "no internet", candidate: eligibleWiFi(1)},
		{name: "no not-vpn", candidate: eligibleWiFi(2)},
		{name: "not validated", candidate: eligibleWiFi(3)},
		{name: "ethernet only", candidate: eligibleWiFi(4)},
		{name: "explicit vpn bearer", candidate: eligibleWiFi(5)},
	}
	tests[1].candidate.hasInternet = false
	tests[2].candidate.hasNotVPN = false
	tests[3].candidate.hasValidated = false
	tests[4].candidate.hasWiFi = false
	tests[5].candidate.hasVPN = true

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := selectUnderlayNetwork([]underlayCandidate{test.candidate})
			if !errors.Is(err, errNoEligibleUnderlay) {
				t.Fatalf("error = %v, want errNoEligibleUnderlay", err)
			}
		})
	}
}

func TestBindSocketWithFreshUnderlayReadsDefaultAfterSIMSwitch(t *testing.T) {
	var snapshotCalls atomic.Int32
	var boundMu sync.Mutex
	boundIDs := make([]int32, 0, 2)

	snapshot := func() ([]underlayCandidate, error) {
		if snapshotCalls.Add(1) == 1 {
			return []underlayCandidate{eligibleCellular(101)}, nil
		}
		return []underlayCandidate{eligibleCellular(202)}, nil
	}
	bind := func(fd int32, netID int32) error {
		boundMu.Lock()
		defer boundMu.Unlock()
		boundIDs = append(boundIDs, netID)
		return nil
	}

	if err := bindSocketWithFreshUnderlay(7, snapshot, bind); err != nil {
		t.Fatalf("first bind: %v", err)
	}
	if err := bindSocketWithFreshUnderlay(8, snapshot, bind); err != nil {
		t.Fatalf("second bind: %v", err)
	}
	if got := snapshotCalls.Load(); got != 2 {
		t.Fatalf("snapshot calls = %d, want 2", got)
	}
	if len(boundIDs) != 2 || boundIDs[0] != 101 || boundIDs[1] != 202 {
		t.Fatalf("bound netIds = %v, want [101 202]", boundIDs)
	}
}

func TestBindSocketWithFreshUnderlayFailsClosed(t *testing.T) {
	bindCalled := false
	err := bindSocketWithFreshUnderlay(
		9,
		func() ([]underlayCandidate, error) {
			return []underlayCandidate{{netID: 90, hasInternet: true, hasWiFi: true}}, nil
		},
		func(fd int32, netID int32) error {
			bindCalled = true
			return nil
		},
	)
	if !errors.Is(err, errNoEligibleUnderlay) {
		t.Fatalf("error = %v, want errNoEligibleUnderlay", err)
	}
	if bindCalled {
		t.Fatal("bind was called without a validated NOT_VPN underlay")
	}

	snapshotErr := errors.New("net manager unavailable")
	err = bindSocketWithFreshUnderlay(
		10,
		func() ([]underlayCandidate, error) { return nil, snapshotErr },
		func(fd int32, netID int32) error { return nil },
	)
	if !errors.Is(err, snapshotErr) {
		t.Fatalf("snapshot error = %v, want wrapped source error", err)
	}

	bindErr := errors.New("stale network handle")
	err = bindSocketWithFreshUnderlay(
		11,
		func() ([]underlayCandidate, error) { return []underlayCandidate{eligibleWiFi(77)}, nil },
		func(fd int32, netID int32) error { return bindErr },
	)
	if !errors.Is(err, bindErr) {
		t.Fatalf("bind error = %v, want wrapped source error", err)
	}
}

func TestBindSocketWithFreshUnderlayRejectsInvalidInputBeforeEnumeration(t *testing.T) {
	snapshotCalled := false
	snapshot := func() ([]underlayCandidate, error) {
		snapshotCalled = true
		return []underlayCandidate{eligibleWiFi(1)}, nil
	}
	bind := func(fd int32, netID int32) error { return nil }

	if err := bindSocketWithFreshUnderlay(-1, snapshot, bind); err == nil {
		t.Fatal("negative descriptor accepted")
	}
	if snapshotCalled {
		t.Fatal("invalid descriptor triggered a network enumeration")
	}
	if err := bindSocketWithFreshUnderlay(1, nil, bind); err == nil {
		t.Fatal("nil snapshot adapter accepted")
	}
	if err := bindSocketWithFreshUnderlay(1, snapshot, nil); err == nil {
		t.Fatal("nil bind adapter accepted")
	}
}

func TestBindSocketWithFreshUnderlayIsConcurrencySafe(t *testing.T) {
	const workers = 64
	var snapshots atomic.Int32
	var binds atomic.Int32
	var wait sync.WaitGroup
	errorsSeen := make(chan error, workers)
	for index := 0; index < workers; index++ {
		wait.Add(1)
		go func(fd int32) {
			defer wait.Done()
			err := bindSocketWithFreshUnderlay(
				fd,
				func() ([]underlayCandidate, error) {
					snapshots.Add(1)
					return []underlayCandidate{eligibleWiFi(55)}, nil
				},
				func(gotFD int32, netID int32) error {
					if gotFD != fd || netID != 55 {
						return fmt.Errorf("unexpected bind fd=%d netId=%d", gotFD, netID)
					}
					binds.Add(1)
					return nil
				},
			)
			if err != nil {
				errorsSeen <- err
			}
		}(int32(index))
	}
	wait.Wait()
	close(errorsSeen)
	for err := range errorsSeen {
		t.Error(err)
	}
	if snapshots.Load() != workers || binds.Load() != workers {
		t.Fatalf("snapshots=%d binds=%d, want %d each", snapshots.Load(), binds.Load(), workers)
	}
}

func TestValidateProtectSocketFD(t *testing.T) {
	if err := validateProtectSocketFD(0); err != nil {
		t.Fatalf("descriptor zero rejected: %v", err)
	}
	if err := validateProtectSocketFD(-1); err == nil {
		t.Fatal("negative descriptor accepted")
	}
}
