"""Bounded GLM classification adapter; failures always require manual review."""
from __future__ import annotations

import base64
import json
import math
import urllib.error
import urllib.request

from recognizeuz.quality.type_matcher import DocumentTypeMatcher


class GlmTypeVerifier:
    def __init__(self, url: str, model: str, *, timeout: float = 12.0,
                 matcher: DocumentTypeMatcher | None = None):
        self.url = url
        self.model = model
        self.timeout = timeout
        self.matcher = matcher or DocumentTypeMatcher()

    def verify_image(self, image_bytes: bytes, expected_code: str,
                     mime_type: str = 'image/png') -> dict:
        uncertain = {'verdict': 'UNCERTAIN', 'detected_code': None, 'source': 'GLM'}
        if expected_code not in self.matcher.rules or mime_type not in {'image/png', 'image/jpeg'}:
            return uncertain
        choices = [{'code': code, 'title': rule['title']}
                   for code, rule in self.matcher.rules.items()]
        prompt = ('Определи тип документа по изображению из списка. '
                  'Если доказательств недостаточно, верни UNCERTAIN. '
                  'Верни только JSON с полями verdict (MATCH, MISMATCH или UNCERTAIN), '
                  'detected_code и confidence от 0 до 1. '
                  f'Ожидаемый код: {expected_code}. Список: '
                  + json.dumps(choices, ensure_ascii=False))
        body = json.dumps({
            'model': self.model, 'temperature': 0, 'max_tokens': 128,
            'messages': [{'role': 'user', 'content': [
                {'type': 'image_url', 'image_url': {'url':
                    f'data:{mime_type};base64,{base64.b64encode(image_bytes).decode("ascii")}'}},
                {'type': 'text', 'text': prompt},
            ]}],
        }, ensure_ascii=False).encode('utf-8')
        request = urllib.request.Request(self.url, data=body,
            headers={'Content-Type': 'application/json'}, method='POST')
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read(65537)
            if len(raw) > 65536:
                return uncertain
            envelope = json.loads(raw)
            content = json.loads(envelope['choices'][0]['message']['content'])
            verdict, code, confidence = (content['verdict'], content['detected_code'],
                                         content['confidence'])
            if (verdict not in ('MATCH', 'MISMATCH') or code not in self.matcher.rules
                    or isinstance(confidence, bool) or not isinstance(confidence, (int, float))
                    or not math.isfinite(confidence) or not 0.98 <= confidence <= 1
                    or (verdict == 'MATCH') != (code == expected_code)):
                return uncertain
            # Self-reported model confidence is not calibrated evidence for an
            # automatic rejection. Preserve the classification as a hint.
            return {'verdict': 'UNCERTAIN', 'detected_code': code, 'source': 'GLM'}
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError,
                IndexError, TypeError):
            return uncertain
