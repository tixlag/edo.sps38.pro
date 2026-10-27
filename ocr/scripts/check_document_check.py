#!/usr/bin/env python3
"""Prepare a checksummed public negative and verify deployed document checking.

Run only on the OCR runner. Private document bytes/fields never enter CI logs.
"""
import argparse
import json
from pathlib import Path
import sys
import urllib.request
import uuid

from models import digest
from public_models import download

CONTROL = {
    'url': 'https://huggingface.co/datasets/huggingface/documentation-images/resolve/main/pipeline-cat-chonk.jpeg',
    'size': 56308,
    'sha256': '88b9eb3e6ec026c5ab96aab516f4a4a2773522a474abc52e934a52d86bba21e5',
}


def prepare(private):
    directory = private / 'public'
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / 'non-document.jpeg'
    if destination.is_file() and destination.stat().st_size == CONTROL['size'] and digest(destination) == CONTROL['sha256']:
        return
    temporary = directory / ('.download-' + uuid.uuid4().hex)
    try:
        download(CONTROL['url'], temporary, CONTROL)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def request(url, path):
    boundary = 'check-' + uuid.uuid4().hex
    mime = {'.pdf': 'application/pdf', '.png': 'image/png'}.get(path.suffix, 'image/jpeg')
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="input{path.suffix}"\r\n'
            f'Content-Type: {mime}\r\n\r\n').encode() + path.read_bytes() + f'\r\n--{boundary}--\r\n'.encode()
    request = urllib.request.Request(url, data=body, headers={
        'Content-Type': 'multipart/form-data; boundary=' + boundary})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=90) as response:
        return json.loads(response.read(256 * 1024))


def check(private, url):
    for label, filename, negative in (
            ('UZ', 'uz.jpg', False), ('migration', 'migration.png', False),
            ('RU', 'ru.pdf', False), ('public negative', 'public/non-document.jpeg', True)):
        data = request(url, private / filename)
        pages = data.get('pages', [])
        valid = (data.get('policy_version') == 'document-check-v1' and bool(pages)
                 and all(page.get('reason') is None and len(page.get('non_document_scores', [])) == 4 for page in pages))
        if negative:
            valid = valid and any(page.get('verdict') == 'NON_DOCUMENT' for page in pages)
        else:
            valid = valid and all(page.get('verdict') in ('DOCUMENT', 'UNCERTAIN') for page in pages)
        if not valid:
            raise RuntimeError('Document presence regression failed: ' + label)
        print(f'Document presence regression passed: {label}; elapsed_ms={data.get("elapsed_ms")}')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url.rsplit('/', 1)[0] + '/health', timeout=10) as response:
        memory = json.load(response).get('document_check_memory', {})
    print('Document checker GPU memory: ' + json.dumps(memory))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('prepare', 'check'))
    parser.add_argument('--private-dir', type=Path, required=True)
    parser.add_argument('--url', default='http://127.0.0.1:8000/document-check')
    args = parser.parse_args()
    if args.command == 'prepare':
        prepare(args.private_dir)
    else:
        check(args.private_dir, args.url)


if __name__ == '__main__':
    main()
