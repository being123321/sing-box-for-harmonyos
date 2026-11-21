//go:build !openharmony

package fdbased

func allowKnownTUNFstatRestriction(err error) bool {
	return false
}
