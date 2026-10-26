#!/usr/bin/env python3
"""Check the Git index for private artifacts before a commit or push."""
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
BANNED = {'.pt','.pth','.pdparams','.pdiparams','.pdopt','.safetensors','.onnx','.bin',
          '.jpg','.jpeg','.png','.pdf','.zip','.gz','.tar','.pyc','.log'}
SECRET = re.compile(rb'(?:hf_[A-Za-z0-9]{25,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)')


def main():
    git_root = Path(subprocess.check_output(
        ['git','-C',str(ROOT),'rev-parse','--show-toplevel'],text=True).strip())
    component_prefix = ROOT.relative_to(git_root)
    prefix = component_prefix.as_posix() if component_prefix != Path('.') else ''
    command = ['git','-C',str(git_root),'ls-files','--stage','-z']
    if prefix:
        command += ['--',prefix + '/']
    result = subprocess.run(command,check=True,capture_output=True)
    errors = []
    count = 0
    for record in result.stdout.split(b'\0'):
        if not record:
            continue
        meta, name_bytes = record.split(b'\t',1)
        name = name_bytes.decode()
        path = Path(name).relative_to(component_prefix) if prefix else Path(name)
        count += 1
        if meta.startswith(b'120000') or meta.startswith(b'160000'):
            errors.append(f'Link/submodule in index: {name}')
        if path.suffix.lower() in BANNED or (path.name.startswith('.env') and path.name != '.env.example'):
            errors.append(f'Private/generated file in index: {name}')
        if any(part in {'__pycache__','.venv','venv','.idea','var','vendor','datasets','runs'} for part in path.parts):
            errors.append(f'Runtime directory in index: {name}')
        data = subprocess.check_output(['git','-C',str(git_root),'show',':'+name])
        if len(data) > 2 * 1024 * 1024:
            errors.append(f'Unexpected large file: {name}')
        if SECRET.search(data):
            errors.append(f'Possible credential in index: {name}')
    if not count:
        errors.append('Git index is empty: stage the intended source files first')
    if errors:
        print('\n'.join(errors),file=sys.stderr)
        return 1
    print(f'Git index: OK ({count} source/documentation files, no banned artifacts)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
