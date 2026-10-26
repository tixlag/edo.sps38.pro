#!/usr/bin/env bash
set -euo pipefail
component="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test_key="$(sha256sum "$component/requirements-test.txt" | cut -c1-24)"
test_env="$HOME/.cache/edo-ocr/test-environments/$test_key"
mkdir -p "$(dirname "$test_env")"
exec 9>"$test_env.lock"
flock 9
if [[ ! -f "$test_env/.ready" ]]; then
  python3.12 -m venv "$test_env"
  if [[ -n "${OCR_WHEELHOUSE:-}" ]]; then
    "$test_env/bin/python" -m pip install --no-index --find-links "$OCR_WHEELHOUSE" -r "$component/requirements-test.txt"
  else
    "$test_env/bin/python" -m pip install -r "$component/requirements-test.txt"
  fi
  touch "$test_env/.ready"
fi
flock -u 9
"$test_env/bin/python" -m unittest discover -s "$component/tests" -v
python3 "$component/scripts/check_repository.py"
