"""Bounded document type check for each page in a request."""
from __future__ import annotations

import io
import os
import time
from typing import Any

from recognizeuz.quality.glm_type_verifier import GlmTypeVerifier
from recognizeuz.quality.type_aggregation import aggregate_type_pages
from recognizeuz.quality.type_matcher import DocumentTypeMatcher, canonical_code


def legacy_check_types(payload: list[tuple[str, bytes, str | None]], expected_code: str,
                presence: dict[str, Any], *, deadline: float) -> dict[str, Any]:
    from recognizeuz.core.config import GLM_OCR_MODEL, GLM_OCR_URL
    from recognizeuz.quality.document_check import pages
    from recognizeuz.quality.page_text import recognize_page

    matcher = DocumentTypeMatcher()
    canonical = canonical_code(expected_code)
    rule = matcher.rules.get(canonical)
    results = [{'file_index': p['file_index'], 'page_number': p['page_number'],
                'verdict': 'UNCERTAIN', 'detected_code': None, 'source': None}
               for p in presence['pages']]
    lookup = {(p['file_index'], p['page_number']): p for p in results}
    presence_lookup = {(p['file_index'], p['page_number']): p for p in presence['pages']}
    glm_enabled = os.getenv('DOCUMENT_TYPE_GLM_ENABLED', 'true').lower() in {'1', 'true', 'yes', 'on'}
    if rule:
        for file_index, (filename, data, content_type) in enumerate(payload):
            try:
                for number, image in pages(data, filename, content_type):
                    key = (file_index, number)
                    if key not in lookup or time.monotonic() >= deadline:
                        break
                    if presence_lookup[key]['verdict'] == 'NON_DOCUMENT':
                        continue
                    try:
                        text = recognize_page(image, deadline)
                        matched = matcher.evaluate_text(text, canonical)
                        if matched['verdict'] in ('MATCH', 'MISMATCH'):
                            lookup[key].update(verdict=matched['verdict'], detected_code=matched['detected_code'], source='PADDLE_RULES')
                            continue
                    except Exception:
                        pass
                    remaining = deadline - time.monotonic()
                    if glm_enabled and remaining > 1:
                        with io.BytesIO() as buffer:
                            image.save(buffer, format='PNG')
                            encoded = buffer.getvalue()
                        remaining = deadline - time.monotonic()
                        if remaining <= 1:
                            break
                        verifier = GlmTypeVerifier(GLM_OCR_URL, GLM_OCR_MODEL,
                                                   timeout=min(8, remaining), matcher=matcher)
                        lookup[key].update(verifier.verify_image(encoded, canonical))
            except Exception:
                continue
    expected_pages = {(p['file_index'], p['page_number']) for p in presence['pages']}
    aggregate = aggregate_type_pages(results, canonical, expected_pages)
    detected = aggregate['detected_code']
    reason = (f'Загружен документ «{matcher.rules[detected]["title"]}» вместо '
              f'ожидаемого «{rule["title"]}»' if aggregate['verdict'] == 'MISMATCH' else None)
    return {'policy_version': 'document-check-v2', 'expected_code': expected_code,
            'expected_title': rule['title'] if rule else None,
            'expected_canonical_code': canonical if rule else None, 'detected_code': detected,
            'detected_title': matcher.rules[detected]['title'] if detected in matcher.rules else None,
            'type_verdict': aggregate['verdict'], 'rejection_reason': reason,
            'source': next((p['source'] for p in results if p['verdict'] == aggregate['verdict']), None),
            'type_pages': results}


def check_types(payload, expected_code, presence, *, deadline):
    provider = os.getenv('DOCUMENT_TYPE_PROVIDER', 'legacy')
    if provider not in {'legacy', 'shadow', 'xiaomi'}:
        raise ValueError('Invalid DOCUMENT_TYPE_PROVIDER')
    if provider == 'xiaomi':
        from recognizeuz.quality.xiaomi_type_check import check_types as xiaomi_check
        return xiaomi_check(payload, expected_code, presence, deadline=deadline)
    result = legacy_check_types(payload, expected_code, presence, deadline=deadline)
    if provider == 'shadow':
        import logging
        try:
            from recognizeuz.quality.xiaomi_type_check import check_types as xiaomi_check
            shadow = xiaomi_check(payload, expected_code, presence, deadline=deadline)
            logging.info('document_type_shadow legacy_verdict=%s legacy_code=%s verdict=%s detected_code=%s reason=%s',
                         result['type_verdict'], result['detected_code'], shadow['type_verdict'],
                         shadow['detected_code'], shadow['type_reason'])
        except Exception as error:
            logging.warning('document_type_shadow error_class=%s', type(error).__name__)
    return result
