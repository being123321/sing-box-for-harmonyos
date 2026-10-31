#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"

python3 "$project_root/scripts/core_vendor.py" verify-local
