package main

import (
	"encoding/json"
	"github.com/sagernet/sing-box/daemon"
)

type harmonySnapshot struct {
 Memory *coreMemorySnapshot `json:"goMemory,omitempty"`
	Groups    *daemon.Groups `json:"groups"`
	Logs      []string       `json:"logs"`
	Modes     []string       `json:"modes"`
	Mode      string         `json:"mode"`
	Status    *daemon.Status `json:"status,omitempty"`
	SampledAt int64          `json:"sampledAt"`
	Connections []*daemon.Connection `json:"connections"`
}

func encodeHarmonySnapshot(result harmonySnapshot) string {
	encoded, err := json.Marshal(result)
	if err != nil {
		return "{}"
	}
	// Large logs must never blank traffic counters or node latency snapshots.
	for len(encoded) > 200000 && len(result.Logs) > 0 {
		result.Logs = result.Logs[len(result.Logs)/2+1:]
		encoded, err = json.Marshal(result)
		if err != nil {
			return "{}"
		}
	}
	if len(encoded) > 200000 {
		result.Connections = nil
		encoded, err = json.Marshal(result)
		if err != nil { return "{}" }
	}
	if len(encoded) > 200000 {
		result.Groups = nil
		encoded, err = json.Marshal(result)
		if err != nil {
			return "{}"
		}
	}
	return string(encoded)
}
