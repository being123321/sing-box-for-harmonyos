package libbox

import (
 "os"
 "github.com/sagernet/sing-box/adapter"
)

// Config validation has no operating-system redirect facility. Match the
// Alpha platform interface without enabling Linux redirect on HarmonyOS.
func (*platformInterfaceStub) UsePlatformAutoRedirect() bool { return false }
func (*platformInterfaceStub) CreateAutoRedirect(adapter.AutoRedirectOptions) (adapter.AutoRedirectSession, error) {
 return nil, os.ErrInvalid
}

var _ adapter.PlatformInterface = (*platformInterfaceStub)(nil)
