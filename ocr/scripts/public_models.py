#!/usr/bin/env python3
"""Install the pinned public document classifier before stopping OCR services.

Only model/config data is downloaded. Existing private bundles are never changed.
No dependencies beyond the Python standard library; downloads are bounded and
verified before an entire revision directory is promoted.
"""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
import urllib.request

from models import digest, load_manifest, target, verify

ROOT = Path(__file__).resolve().parents[1]


def download(url, output, item, opener=urllib.request.urlopen, deadline=None):
    """Use a new partial file per attempt, never append to an unchecked download."""
    for attempt in range(3):
        try:
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError('Public asset download deadline exceeded')
            with opener(url, timeout=30) as response, output.open('wb') as stream:
                length = 0
                while True:
                    if deadline is not None and time.monotonic() >= deadline:
                        raise TimeoutError('Public asset download deadline exceeded')
                    chunk = response.read(min(1024 * 1024, item['size'] - length + 1))
                    if not chunk:
                        break
                    length += len(chunk)
                    if length > item['size']:
                        raise ValueError('Public asset exceeds pinned size')
                    stream.write(chunk)
            if length != item['size'] or digest(output) != item['sha256']:
                raise ValueError('Public asset checksum/size mismatch')
            return
        except (OSError, ValueError):
            output.unlink(missing_ok=True)
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def install(manifest, models_root, opener=urllib.request.urlopen):
    data = json.loads(manifest.read_text())
    files = load_manifest(manifest)
    repository, revision = data['repository'], data['revision']
    if repository != 'google/siglip2-base-patch16-224' or not re.fullmatch(r'[a-f0-9]{40}', revision):
        raise ValueError('Unsupported public model repository/revision')
    destination = target(models_root, 'document-check/' + revision)
    try:
        verify(destination, files)
        print('Public classifier already verified: ' + revision)
        return destination
    except ValueError:
        pass
    destination.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + 15 * 60
    with tempfile.TemporaryDirectory(prefix='.download-', dir=destination.parent) as temporary:
        stage = Path(temporary) / 'model'
        stage.mkdir()
        for name, item in files.items():
            output = target(stage, name)
            output.parent.mkdir(parents=True, exist_ok=True)
            download(f'https://huggingface.co/{repository}/resolve/{revision}/{name}',
                     output, item, opener=opener, deadline=deadline)
        verify(stage, files)
        # A corrupt directory of this exact revision may be replaced, never a
        # different revision used by a running/rollback release.
        backup = Path(temporary) / 'corrupt'
        if destination.exists():
            os.replace(destination, backup)
        try:
            os.replace(stage, destination)
        except BaseException:
            if backup.exists():
                os.replace(backup, destination)
            raise
    print('Public classifier installed and verified: ' + revision)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, default=ROOT / 'models/public-manifest.json')
    parser.add_argument('--models-dir', type=Path, default=ROOT / 'models')
    args = parser.parse_args()
    try:
        install(args.manifest, args.models_dir.absolute())
    except (OSError, ValueError, KeyError, TypeError) as error:
        # No remote bodies, signed redirects, or private filesystem paths.
        print('Public classifier preparation failed: ' + type(error).__name__, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
