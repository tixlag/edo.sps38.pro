#!/usr/bin/env bash
set -euo pipefail
service="${1:-}"
case "$service" in ru|uz) ;; *) echo 'Usage: scripts/setup_service.sh ru|uz' >&2; exit 2;; esac
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
python_bin="${PYTHON:-python3.12}"
"$python_bin" -c 'import sys; assert sys.version_info[:2] == (3, 12), "Use Python 3.12"'
service_root="$repo_root/services/$service"
"$python_bin" -m venv "$service_root/.venv"
if [[ -n "${WHEELHOUSE:-}" ]]; then
  "$service_root/.venv/bin/python" -m pip install --no-deps --no-index --find-links "$WHEELHOUSE" -r "$service_root/requirements.lock"
else
  case "$service" in uz) paddle_cuda=cu130; paddle_version=3.3.0;; ru) paddle_cuda=cu129; paddle_version=3.2.2;; esac
  "$service_root/.venv/bin/python" -m pip install --no-deps \
    -r "$service_root/requirements.lock" \
    "https://paddle-whl.cdn.bcebos.com/stable/$paddle_cuda/paddlepaddle-gpu/paddlepaddle_gpu-$paddle_version-cp312-cp312-linux_x86_64.whl"
fi
if [[ "$service" == uz ]]; then
  python3 "$repo_root/scripts/setup_paddleocr.py"
fi
