package main

import (
 "errors"
 "github.com/sagernet/sing-box/experimental/libbox"
)

// HarmonyOS uses the OS VPN Extension TUN. Linux auto-redirect is unavailable.
func (*harmonyPlatform) UsePlatformAutoRedirect() bool { return false }
func (*harmonyPlatform) CreateAutoRedirect(_ []byte, _ libbox.AutoRedirectHandler) (libbox.AutoRedirectSession, error) {
 return nil, errors.New("platform auto-redirect is unavailable in the HarmonyOS VPN Extension")
}

var _ libbox.PlatformInterface = (*harmonyPlatform)(nil)
