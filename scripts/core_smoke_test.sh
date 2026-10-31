#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
source "$project_root/scripts/core_build_env.sh"
deveco_app="${HNA_DEVECO_HOME:-/Applications/DevEco-Studio.app}"
deveco_contents="$deveco_app/Contents"
ohos_go="$project_root/third_party/ohos-golang-go-1.24/bin/go"
ohos_clang="$deveco_contents/sdk/default/openharmony/native/llvm/bin/aarch64-unknown-linux-ohos-clang"
core_dir="$project_root/core/go"

"$project_root/scripts/verify_core_vendor.sh"
python3 "$project_root/scripts/verify_build_toolchain.py" deveco \
  --contents "$deveco_contents"

for required in "$ohos_go" "$ohos_clang"; do
  if [[ ! -x "$required" ]]; then
    echo "BLOCKED: missing executable: $required"
    exit 1
  fi
done

echo "SMOKE   host core and platform-adapter tests"
(
  cd "$core_dir"
  GOTOOLCHAIN=local GOFLAGS=-mod=readonly CGO_ENABLED=1 \
    "$ohos_go" test -ldflags "-checklinkname=0" -tags "$HNA_CORE_BUILD_TAGS" ./...
)

echo "SMOKE   vendored sing-box HarmonyOS adapter tests"
(
  cd "$project_root/third_party/sing-box"
  GOTOOLCHAIN=local GOFLAGS=-mod=readonly CGO_ENABLED=1 \
    "$ohos_go" test -ldflags "-checklinkname=0" -tags "$HNA_CORE_BUILD_TAGS" ./common/dialer ./protocol/group
)

echo "SMOKE   OpenHarmony build-tag compilation"
(
  cd "$project_root/third_party/sing-box"
  GOTOOLCHAIN=local \
  GOOS=openharmony \
  GOARCH=arm64 \
  CGO_ENABLED=1 \
  GOFLAGS=-mod=readonly \
  CC="$ohos_clang" \
  "$ohos_go" test -ldflags "-checklinkname=0" -tags "$HNA_CORE_BUILD_TAGS" -run '^$' -exec=true ./common/dialer ./experimental/libbox
)

echo "SMOKE   gVisor fail-closed platform selection"
(
  cd "$project_root/third_party/gvisor"
  GOTOOLCHAIN=local \
  GOOS=openharmony \
  GOARCH=arm64 \
  CGO_ENABLED=1 \
  GOFLAGS=-mod=readonly \
  CC="$ohos_clang" \
  "$ohos_go" test -ldflags "-checklinkname=0" -tags "$HNA_CORE_BUILD_TAGS" -run '^$' -exec=true ./pkg/tcpip/link/fdbased
)

echo "RESULT  CORE SMOKE TESTS PASSED"
