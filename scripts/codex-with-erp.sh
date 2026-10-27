#!/usr/bin/env bash
set -euo pipefail

edo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
erp_root="$(cd -- "$edo_root/.." && pwd)/1c-erp"

if ! git -C "$erp_root" rev-parse --show-toplevel >/dev/null 2>&1; then
  printf '1C ERP checkout is missing: %s\n' "$erp_root" >&2
  printf 'Clone https://glab.sps38.pro/1cdevs/1c-erp.git into that directory first.\n' >&2
  exit 1
fi

exec codex --cd "$edo_root" --add-dir "$erp_root" "$@"
