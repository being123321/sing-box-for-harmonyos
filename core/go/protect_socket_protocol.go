package main

import (
	"errors"
	"fmt"
)

var errNoEligibleUnderlay = errors.New(
	"no validated default Wi-Fi or cellular underlay with INTERNET and NOT_VPN capabilities is available",
)

type underlayCandidate struct {
	netID     int32
	isDefault bool

	hasInternet  bool
	hasNotVPN    bool
	hasValidated bool

	hasWiFi     bool
	hasCellular bool
	hasVPN      bool
}

type underlaySnapshotFunc func() ([]underlayCandidate, error)
type underlayBindFunc func(fd int32, netID int32) error

func validateProtectSocketFD(fd int32) error {
	if fd < 0 {
		return errors.New("cannot protect an invalid socket descriptor")
	}
	return nil
}

func isEligibleUnderlay(candidate underlayCandidate) bool {
	return candidate.netID > 0 &&
		candidate.isDefault &&
		candidate.hasInternet &&
		candidate.hasNotVPN &&
		candidate.hasValidated &&
		(candidate.hasWiFi || candidate.hasCellular) &&
		!candidate.hasVPN
}

// Accept only the current system-default physical network from the fresh
// adapter snapshot. A lower netId (often the previous data SIM) or a connected
// Wi-Fi network must not override the network the OS actually activated.
func selectUnderlayNetwork(candidates []underlayCandidate) (int32, error) {
	var selectedID int32
	for _, candidate := range candidates {
		if !candidate.isDefault {
			continue
		}
		if selectedID != 0 || !isEligibleUnderlay(candidate) {
			return 0, errNoEligibleUnderlay
		}
		selectedID = candidate.netID
	}
	if selectedID == 0 {
		return 0, errNoEligibleUnderlay
	}
	return selectedID, nil
}

// bindSocketWithFreshUnderlay performs a new network snapshot for every file
// descriptor. It intentionally holds no shared network handle: concurrent
// dials are independent, and a network-switch race fails the affected bind so
// the next descriptor reads the current default network instead of reusing stale
// state.
func bindSocketWithFreshUnderlay(
	fd int32,
	snapshot underlaySnapshotFunc,
	bind underlayBindFunc,
) error {
	if err := validateProtectSocketFD(fd); err != nil {
		return err
	}
	if snapshot == nil || bind == nil {
		return errors.New("VPN socket protection has no public NetConn adapter")
	}
	candidates, err := snapshot()
	if err != nil {
		return fmt.Errorf("VPN socket protection could not read the default underlay network: %w", err)
	}
	netID, err := selectUnderlayNetwork(candidates)
	if err != nil {
		return fmt.Errorf("VPN socket protection refused an unsafe underlay: %w", err)
	}
	if err = bind(fd, netID); err != nil {
		return fmt.Errorf("VPN socket protection could not bind fd %d to underlay netId %d: %w", fd, netID, err)
	}
	return nil
}
