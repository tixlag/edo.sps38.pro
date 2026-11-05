"""Bounded client for the isolated, pinned Xiaomi text reader."""
import io
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.parse
import urllib.request

MANIFEST = json.loads((Path(__file__).resolve().parents[4] / 'models/xiaomi-manifest.json').read_text())
REASONS = {'OCR_UNAVAILABLE', 'INPUT_LIMIT', 'INVALID_RESPONSE', 'TIMEOUT', 'TRUNCATED'}


class ReaderError(Exception):
    def __init__(self, reason):
        self.reason = reason
        super().__init__(reason)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def recognize_page(image, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ReaderError('TIMEOUT')
    url = os.getenv('DOCUMENT_TYPE_XIAOMI_URL', 'http://127.0.0.1:8084/recognize-text')
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != 'http' or parsed.hostname not in {'127.0.0.1', 'localhost'}
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path != '/recognize-text'):
        raise ReaderError('OCR_UNAVAILABLE')
    with io.BytesIO() as buffer:
        image.save(buffer, format='PNG')
        data = buffer.getvalue()
    if len(data) > 10 * 1024 * 1024:
        raise ReaderError('INPUT_LIMIT')
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ReaderError('TIMEOUT')
    request = urllib.request.Request(url, data=data, method='POST', headers={
        'Content-Type': 'image/png', 'X-Deadline-Unix': str(time.time() + min(45, remaining))})
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with opener.open(request, timeout=min(45, remaining)) as response:
            raw = response.read(128 * 1024 + 1)
        if len(raw) > 128 * 1024:
            raise ReaderError('INVALID_RESPONSE')
        result = json.loads(raw)
        reason = result.get('reason')
        if reason is not None:
            raise ReaderError(reason if reason in REASONS else 'INVALID_RESPONSE')
        if (result.get('model') != MANIFEST['repository']
                or result.get('revision') != MANIFEST['revision']
                or result.get('truncated') is not False
                or not isinstance(result.get('text'), str)
                or len(result['text'].encode('utf-8')) > 65536):
            raise ReaderError('INVALID_RESPONSE')
        return result['text']
    except TimeoutError as error:
        raise ReaderError('TIMEOUT') from error
    except urllib.error.HTTPError as error:
        raise ReaderError('TIMEOUT' if error.code == 408 else
                          'INPUT_LIMIT' if error.code == 413 else 'OCR_UNAVAILABLE') from error
    except (OSError, ValueError, TypeError, AttributeError) as error:
        raise ReaderError('INVALID_RESPONSE' if isinstance(error, (ValueError, TypeError, AttributeError))
                          else 'OCR_UNAVAILABLE') from error
