#!/usr/bin/env bash
set -euo pipefail
service="${1:-}"
case "$service" in ru) port=8001; app=doc_recognizer_universe:app;; uz) port=8000; app=app:app;; *) echo 'Usage: scripts/run_service.sh ru|uz [uvicorn options]' >&2; exit 2;; esac
shift
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
service_root="$repo_root/services/$service"
if [[ -f "$service_root/.env" ]]; then
  set -a
  source "$service_root/.env"
  set +a
fi
python3 "$repo_root/scripts/models.py" verify --models-dir "${MODELS_ROOT:-$repo_root/models}"
python_bin="$service_root/.venv/bin/python"
if [[ ! -x "$python_bin" ]]; then echo "Missing environment: run scripts/setup_service.sh $service" >&2; exit 1; fi
cd "$service_root"
exec "$python_bin" -m uvicorn "$app" --host 0.0.0.0 --port "$port" --workers 1 "$@"
