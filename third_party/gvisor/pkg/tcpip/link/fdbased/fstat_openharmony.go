//go:build openharmony

package fdbased

import "golang.org/x/sys/unix"

// HarmonyOS VpnConnection.create() supplies the descriptor and guarantees it
// represents the application's virtual NIC. The application sandbox can deny
// metadata inspection while still permitting non-blocking packet I/O.
func allowKnownTUNFstatRestriction(err error) bool {
	return err == unix.EPERM || err == unix.EACCES
}
