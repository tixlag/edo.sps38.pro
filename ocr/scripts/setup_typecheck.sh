#!/usr/bin/env bash
set -euo pipefail
component="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
environment_root="${SERVICE_VENV:-$component/services/typecheck/.venv}"
python_bin="${PYTHON:-python3.12}"
export TMPDIR="${TYPECHECK_BUILD_DIR:-$component/.cache/typecheck-build}"
mkdir -p "$TMPDIR"
"$python_bin" -c 'import sys; assert sys.version_info[:2] == (3, 12), "Use Python 3.12"'
"$python_bin" -m venv "$environment_root"
wheel_args=()
if [[ -n "${TYPECHECK_WHEELHOUSE:-}" ]]; then
  wheel_args=(--no-index --find-links "$TYPECHECK_WHEELHOUSE")
fi
"$environment_root/bin/python" -m pip install --no-cache-dir --no-deps \
  "${wheel_args[@]}" -r "$component/services/typecheck/requirements.lock"
"$environment_root/bin/python" -m pip check
