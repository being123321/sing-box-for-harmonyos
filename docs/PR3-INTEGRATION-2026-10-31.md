# PR #3 integration checks (2026-10-31)

Integrates aixmoyu's Tailscale/Taildrop contribution, preserving its original
commit `33f3fb3a3962a38ad446ffe45f350dfdab60c318` as a merge parent.

Additional fixes made during review:

- A transient VPN health read no longer permanently disables background
  supervision. Successful later reads clear the diagnostic; confirmed tunnel
  loss still uses the existing bounded recovery and saved node/mode choices.
- Restore imported `Rule`/`Global`/`Direct` spelling from the saved mode
  (the local 0.81 fix); preserve profile and node selections.
- Atomically snapshot native Tailscale client/cache pointers during concurrent
  stop/status calls; synchronize last-error writes, and cancel the client before
  teardown without holding a lock across downloads.
- Do not keep a partially started command server after listener startup fails;
  clear subscriptions during failed-service rollback.
- Prevent overlapping status file writes and unbounded endpoint-page refresh
  requests. Timestamp queued commands when dispatched; cancel work queued for
  an old session or after a safe stop request.
- Encode ping errors and endpoint tags through JSON serialization.

Validation:

- 25 targeted background recovery, mode persistence, orphan-session and
  Tailscale command-queue tests pass.
- OHOS arm64 native core cross-build passes with `with_tailscale` and the pinned
  OHOS Go toolchain. Full unsigned release HAP compilation passes.
- A native teardown/status concurrency regression test was added and its OHOS
  test binary compiled. Device execution was denied by device policy; it has
  **not** been recorded as a passing native runtime or race-detector test.
- The full tooling suite before these review fixes had 48 failures; the first
  full run after the fixes had the same failure names. The public checkout
  lacks legacy toolchain lock/replay inputs required by several tests; existing
  UI/source and formal-release evidence checks also remain failing. This is
  **not** an all-green suite or a formal release approval.

Device observations are from the existing 0.81 Beta, not this merged build:
the first process snapshot showed only UI; after manually starting VPN, the
extension process remained present during a short background observation.
Historical logs did not establish why the earlier VPN extension disappeared.
Long-duration background stability and Tailscale login/Taildrop operation still
require signed-package device validation. No release/HAP upload accompanies
this source merge; full WebRTC/IPv6 leakage resolution is not claimed.
