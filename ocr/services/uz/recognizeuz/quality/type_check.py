"""Type check orchestration. Evidence is advisory until independently calibrated."""
from __future__ import annotations

import io
import os
import time
from typing import Any

from recognizeuz.quality.glm_type_verifier import GlmTypeVerifier
from recognizeuz.quality.type_aggregation import aggregate_type_pages
from recognizeuz.quality.type_matcher import DocumentTypeMatcher, canonical_code


def check_types(payload: list[tuple[str, bytes, str | None]], expected_code: str,
                presence: dict[str, Any], *, deadline: float) -> dict[str, Any]:
    from recognizeuz.core.config import GLM_OCR_MODEL, GLM_OCR_URL
    from recognizeuz.quality.document_check import pages

    matcher = DocumentTypeMatcher()
    canonical = canonical_code(expected_code)
    rule = matcher.rules.get(canonical)
    results = []
    # The current deployment has no page text detector; use GLM as a bounded
    # advisory fallback on one page only. Unknown codes never leave the service.
    used_glm = False
    for entry in presence['pages']:
        results.append({'file_index': entry['file_index'], 'page_number': entry['page_number'],
                        'verdict': 'UNCERTAIN', 'detected_code': None, 'source': None})
    glm_enabled = os.getenv('DOCUMENT_TYPE_GLM_ENABLED', 'false').lower() in {'1', 'true', 'yes', 'on'}
    if glm_enabled and rule and len(results) == 1 and presence['pages'][0]['verdict'] != 'NON_DOCUMENT':
        remaining = deadline - time.monotonic()
        if remaining > 1:
            filename, data, content_type = payload[0]
            try:
                for page_number, image in pages(data, filename, content_type):
                    if page_number != results[0]['page_number']:
                        continue
                    with io.BytesIO() as buffer:
                        image.save(buffer, format='PNG')
                        encoded = buffer.getvalue()
                    if time.monotonic() >= deadline:
                        break
                    verifier = GlmTypeVerifier(GLM_OCR_URL, GLM_OCR_MODEL,
                                               timeout=min(8, deadline - time.monotonic()),
                                               matcher=matcher)
                    results[0].update(verifier.verify_image(encoded, canonical))
                    used_glm = True
                    break
            except Exception:
                pass
    expected_pages = {(p['file_index'], p['page_number']) for p in presence['pages']}
    aggregate = aggregate_type_pages(results, canonical, expected_pages)
    return {'policy_version': 'document-check-v2', 'expected_code': expected_code,
            'expected_title': rule['title'] if rule else None,
            'detected_code': aggregate['detected_code'],
            'detected_title': (matcher.rules[aggregate['detected_code']]['title']
                               if aggregate['detected_code'] in matcher.rules else None),
            'type_verdict': aggregate['verdict'], 'rejection_reason': None,
            'source': 'GLM' if used_glm else None, 'type_pages': results}
