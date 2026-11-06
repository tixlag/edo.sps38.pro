#!/usr/bin/env bash
set -euo pipefail
component="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$component/services/typecheck/.env" ]]; then
  set -a
  source "$component/services/typecheck/.env"
  set +a
fi
exec "$component/services/typecheck/.venv/bin/python" \
  "$component/services/typecheck/server.py" --models-dir "${MODELS_ROOT:-$component/models}"
