"""Version 3: independent full-page text extraction followed by explicit rules."""
import logging
import time

from recognizeuz.quality.type_matcher import DocumentTypeMatcher, canonical_code, ROOT
from recognizeuz.quality.xiaomi_text import MANIFEST, ReaderError, recognize_page


def recognize_type_text(image, deadline, matcher):
    """Choose orientation using the same evidence for every expected type.

    All candidates preserve the complete page. Neither its label nor the expected
    document type is sent to the text reader or used to select an orientation.
    """
    first_text = None
    observed_codes = set()
    probe_code = next(iter(matcher.rules))
    for angle, pixels in ((0, 786432), (0, 1258291), (270, 786432), (90, 786432), (180, 786432)):
        if time.monotonic() >= deadline:
            raise ReaderError('TIMEOUT')
        candidate = image.rotate(angle, expand=True) if angle else image
        try:
            text = recognize_page(candidate, deadline, pixels=pixels)
        finally:
            if angle:
                candidate.close()
        if first_text is None:
            first_text = text
        detected = matcher.evaluate_text(text, probe_code)
        if detected.get('reason') == 'MIXED_DOCUMENT_TYPES':
            raise ReaderError('MIXED_DOCUMENT_TYPES')
        if detected['detected_code']:
            observed_codes.add(detected['detected_code'])
        if len(observed_codes) > 1:
            raise ReaderError('MIXED_DOCUMENT_TYPES')
        if detected['verdict'] != 'UNCERTAIN':
            return text, angle, pixels
    return first_text or '', 0, 786432


def aggregate(pages, expected_code, expected_pages):
    keys = [(p.get('file_index'), p.get('page_number')) for p in pages]
    if not expected_pages or len(keys) != len(set(keys)) or set(keys) != expected_pages:
        return 'UNCERTAIN', None, 'INVALID_RESPONSE'
    matches = [p for p in pages if p['verdict'] == 'MATCH']
    mismatches = [p for p in pages if p['verdict'] == 'MISMATCH']
    if any(p['detected_code'] != expected_code for p in matches) or any(
            not p['detected_code'] or p['detected_code'] == expected_code for p in mismatches):
        return 'UNCERTAIN', None, 'INVALID_RESPONSE'
    if matches and mismatches:
        return 'UNCERTAIN', None, 'MIXED_DOCUMENT_TYPES'
    if matches:
        return 'MATCH', expected_code, None
    codes = {p['detected_code'] for p in mismatches}
    if len(mismatches) == len(pages) and len(codes) == 1:
        return 'MISMATCH', next(iter(codes)), None
    return 'UNCERTAIN', None, 'MIXED_DOCUMENT_TYPES' if len(codes) > 1 else next(
        (p['reason'] for p in pages if p.get('reason')), 'LOW_EVIDENCE')


def check_types(payload, expected_code, presence, *, deadline):
    from recognizeuz.quality.document_check import pages

    matcher = DocumentTypeMatcher(ROOT / 'contracts/document-type-rules-v2.json')
    canonical = canonical_code(expected_code)
    rule = matcher.rules.get(canonical)
    results = [{
        'file_index': p['file_index'], 'page_number': p['page_number'],
        'verdict': 'UNCERTAIN', 'detected_code': None, 'source': None,
        'reason': 'NOT_PROCESSED' if rule else 'UNKNOWN_EXPECTED_TYPE', 'matched_phrases': [],
    } for p in presence['pages']]
    lookup = {(p['file_index'], p['page_number']): p for p in results}
    presence_lookup = {(p['file_index'], p['page_number']): p for p in presence['pages']}
    if rule:
        for file_index, (filename, data, mime) in enumerate(payload):
            try:
                for number, image in pages(data, filename, mime):
                    if time.monotonic() >= deadline:
                        for pending in results:
                            if pending['reason'] == 'NOT_PROCESSED':
                                pending['reason'] = 'TIMEOUT'
                        break
                    key = (file_index, number)
                    if key not in lookup:
                        continue
                    result = lookup[key]
                    if presence_lookup[key]['verdict'] == 'NON_DOCUMENT':
                        result['reason'] = 'NON_DOCUMENT'
                        continue
                    started = time.monotonic()
                    try:
                        text, angle, pixels = recognize_type_text(image, deadline, matcher)
                        matched = matcher.evaluate_text(text, canonical)
                        result.update(verdict=matched['verdict'], detected_code=matched['detected_code'],
                                      rotation=angle,
                                      reading_pixels=pixels,
                                      matched_phrases=matched['matched_phrases'][:8],
                                      source='XIAOMI_RULES', reason=None if matched['verdict'] != 'UNCERTAIN'
                                      else matched.get('reason', 'LOW_EVIDENCE'))
                    except ReaderError as error:
                        result['reason'] = error.reason
                    except Exception as error:
                        result['reason'] = 'INVALID_RESPONSE'
                        logging.warning('document_type_reader error_class=%s', type(error).__name__)
                    result['elapsed_ms'] = round((time.monotonic() - started) * 1000, 2)
                    logging.info('document_type_page file_index=%d page=%d verdict=%s reason=%s elapsed_ms=%s',
                                 file_index, number, result['verdict'], result['reason'], result['elapsed_ms'])
            except Exception as error:
                for key, result in lookup.items():
                    if key[0] == file_index and result['reason'] == 'NOT_PROCESSED':
                        result['reason'] = 'DECODE_UNAVAILABLE'
                logging.warning('document_type_decode error_class=%s', type(error).__name__)
    verdict, detected, reason = aggregate(results, canonical, set(lookup))
    return {
        'policy_version': 'document-check-v3', 'expected_code': expected_code,
        'expected_title': rule['title'] if rule else None,
        'expected_canonical_code': canonical if rule else None,
        'detected_code': detected, 'detected_title': matcher.rules[detected]['title'] if detected else None,
        'type_verdict': verdict, 'type_reason': reason,
        'rejection_reason': (f'Загружен документ «{matcher.rules[detected]["title"]}» вместо '
                             f'ожидаемого «{rule["title"]}»' if verdict == 'MISMATCH' else None),
        'source': 'XIAOMI_RULES' if any(p['source'] for p in results) else None,
        'type_model': MANIFEST['repository'], 'type_model_revision': MANIFEST['revision'],
        'type_rules_version': 'document-type-rules-v2',
        'type_pages': results,
    }
