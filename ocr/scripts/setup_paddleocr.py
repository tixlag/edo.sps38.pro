#!/usr/bin/env python3
"""Fetch the pinned PaddleOCR checkout and apply the recorded compatibility patch."""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
COMMIT = '0141f249fd0ea7609c16f1f4f851f0fa18125f06'
DEST = ROOT / 'vendor/PaddleOCR'
PATCH = ROOT / 'patches/paddleocr-use-gcu.patch'


def git(*args, check=True):
    return subprocess.run(['git', '-C', str(DEST), *args], check=check, capture_output=True, text=True)


def main():
    if not DEST.exists():
        DEST.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['git', 'clone', '--no-checkout', 'https://github.com/PaddlePaddle/PaddleOCR.git', str(DEST)], check=True)
        git('checkout', '--detach', COMMIT)
    if git('rev-parse', 'HEAD').stdout.strip() != COMMIT:
        raise RuntimeError('Existing PaddleOCR checkout has a different commit; use a fresh vendor directory')
    current_patch = git('diff', '--', 'tools/infer/utility.py').stdout
    if current_patch:
        if current_patch != PATCH.read_text():
            raise RuntimeError('PaddleOCR has unexpected local changes; refusing to overwrite them')
    else:
        git('apply', str(PATCH))
    print(f'PaddleOCR ready: {COMMIT} + use-gcu patch')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
