#!/usr/bin/env python3
"""Local inference smoke test. Inputs/results are private and stay outside Git."""
import argparse
import base64
import json
from pathlib import Path
import time
import urllib.request
import uuid


def request(url, path, as_base64):
    if as_base64:
        body = json.dumps({'files':[{'filename':path.name, 'content_base64':base64.b64encode(path.read_bytes()).decode()}]}).encode()
        content_type = 'application/json'
    else:
        boundary = uuid.uuid4().hex
        mime = 'application/pdf' if path.suffix.lower() == '.pdf' else 'image/jpeg'
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="input{path.suffix}"\r\nContent-Type: {mime}\r\n\r\n'.encode() + path.read_bytes() + f'\r\n--{boundary}--\r\n'.encode())
        content_type = f'multipart/form-data; boundary={boundary}'
    req = urllib.request.Request(url, data=body, headers={'Content-Type':content_type})
    with urllib.request.urlopen(req, timeout=240) as response:
        return response.status, json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',required=True)
    parser.add_argument('--input',required=True,type=Path)
    parser.add_argument('--expect-type',choices=['passport','migration_card'])
    parser.add_argument('--base64',action='store_true')
    parser.add_argument('--output',type=Path)
    args = parser.parse_args()
    if args.output and args.output.resolve().is_relative_to(Path(__file__).resolve().parents[1]):
        allowed = Path(__file__).resolve().parents[1] / 'var'
        if not args.output.resolve().is_relative_to(allowed):
            parser.error('Private results inside the repository must be stored under var/')
    start = time.monotonic()
    status,data = request(args.url,args.input,args.base64)
    if args.expect_type:
        assert isinstance(data,list) and data, 'Empty recognition result'
        assert any(d.get('type') == args.expect_type and d.get('fields') for d in data), 'Expected document/fields missing'
    else:
        assert data, 'Empty recognition result'
    if args.output:
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
    print(f'HTTP {status}; result present; {time.monotonic()-start:.2f}s. Inspect private fields separately.')


if __name__ == '__main__':
    main()
