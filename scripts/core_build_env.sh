#!/usr/bin/env bash

# Keep every native-core test and production build on the exact same feature
# graph. A single source prevents a smoke test from silently omitting behavior
# that is compiled into libharmonycore.so.
HNA_CORE_BUILD_TAGS='with_gvisor,with_quic,with_utls,with_clash_api,with_tailscale,badlinkname,tfogo_checklinkname0'
readonly HNA_CORE_BUILD_TAGS
