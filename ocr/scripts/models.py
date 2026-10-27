#!/usr/bin/env python3
"""Pack, verify and install the private model bundle. Standard library only."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def load_manifest(path):
    data = json.loads(path.read_text())
    if data.get('version') != 1 or not data.get('files'):
        raise ValueError('Unsupported or empty model manifest')
    files = {}
    for item in data['files']:
        name = item['path']
        pure = PurePosixPath(name)
        if pure.is_absolute() or '..' in pure.parts or str(pure) != name or '\\' in name:
            raise ValueError(f'Unsafe model path: {name}')
        if name in files or not pure.parts or not isinstance(item['size'], int) or item['size'] < 0:
            raise ValueError(f'Invalid model entry: {name}')
        if len(item['sha256']) != 64 or any(c not in '0123456789abcdef' for c in item['sha256']):
            raise ValueError(f'Invalid SHA-256: {name}')
        files[name] = item
    return files


def target(root, name):
    path = root / name
    # Reject links in both the final target and any existing parent directory.
    for part in [path, *path.parents]:
        if part.is_symlink():
            raise ValueError(f'Symbolic links are not allowed in model destination: {part}')
        if part == root:
            break
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError(f'Unsafe destination: {name}')
    return path


def verify(root, files):
    errors = []
    for name, item in files.items():
        path = target(root, name)
        if not path.is_file():
            errors.append(f'Missing: {name}')
        elif path.stat().st_size != item['size'] or digest(path) != item['sha256']:
            errors.append(f'Checksum/size mismatch: {name}')
    if errors:
        raise ValueError('\n'.join(errors))


def install(archive_path, root, files):
    root.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.models-stage-', dir=root.parent) as temporary:
        stage = Path(temporary)
        with tarfile.open(archive_path, 'r:gz') as archive:
            seen = set()
            for member in archive:
                if not member.isfile() or member.name not in files or member.name in seen:
                    raise ValueError(f'Unexpected, duplicate or unsafe archive member: {member.name}')
                if member.size != files[member.name]['size']:
                    raise ValueError(f'Unexpected size: {member.name}')
                seen.add(member.name)
                output = target(stage, member.name)
                output.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, output.open('wb') as dest:
                    shutil.copyfileobj(source, dest)
            if seen != files.keys():
                raise ValueError('Missing archive members: ' + ', '.join(sorted(files.keys() - seen)))
        verify(stage, files)
        # Validate every destination before promoting any staged file.
        for name in files:
            path = target(root, name)
            if path.exists() and not path.is_file():
                raise ValueError(f'Destination is not a file: {path}')
        for name in files:
            output = target(root, name)
            output.parent.mkdir(parents=True, exist_ok=True)
            os.replace(stage / name, output)
    verify(root, files)


def pack(output, root, files):
    verify(root, files)
    if output.exists():
        raise ValueError(f'Refusing to overwrite archive: {output}')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=output.parent, delete=False) as temporary:
        temp_path = Path(temporary.name)
    try:
        with tarfile.open(temp_path, 'w:gz') as archive:
            for name in sorted(files):
                archive.add(target(root, name), arcname=name, recursive=False)
        os.replace(temp_path, output)
    finally:
        temp_path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, default=ROOT / 'models/manifest.json')
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ['verify', 'install', 'pack']:
        command = sub.add_parser(name)
        if name != 'verify':
            command.add_argument('archive', type=Path)
        command.add_argument('--models-dir', type=Path, default=ROOT / 'models')
    args = parser.parse_args()
    try:
        files = load_manifest(args.manifest)
        if args.command == 'install':
            install(args.archive, args.models_dir.absolute(), files)
        elif args.command == 'pack':
            pack(args.archive, args.models_dir.absolute(), files)
        else:
            verify(args.models_dir.absolute(), files)
        print(f'{args.command}: OK ({len(files)} files)')
    except (ValueError, OSError, KeyError, TypeError, tarfile.TarError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
