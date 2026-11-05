"""The v3 type policy never treats technical failures as a foreign document."""
import io
import json
import os
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services/uz'))
from recognizeuz.quality import xiaomi_text, xiaomi_type_check
from recognizeuz.quality.type_matcher import DocumentTypeMatcher

MIGRATION = 'Миграционная карта. Migration card. Срок пребывания'
SNILS = 'Форма АДИ-РЕГ. Уведомление о регистрации в системе индивидуального учета'


class Image:
    def save(self, buffer, format):
        buffer.write(b'png')


class XiaomiPolicyTests(unittest.TestCase):
    def check(self, texts, expected):
        presence = {'pages': [{'file_index': 0, 'page_number': i + 1, 'verdict': 'DOCUMENT'}
                              for i in range(len(texts))]}
        def read(*_):
            value = next(values)
            if isinstance(value, Exception):
                raise value
            return value
        values = iter(texts)
        with patch('recognizeuz.quality.document_check.pages',
                   return_value=iter((i + 1, Image()) for i in range(len(texts)))), \
                patch.object(xiaomi_type_check, 'recognize_page', side_effect=read), \
                patch('recognizeuz.quality.page_text.recognize_page', side_effect=AssertionError('Paddle must not run')):
            return xiaomi_type_check.check_types([('input.pdf', b'', 'application/pdf')], expected,
                                                 presence, deadline=time.monotonic() + 45)

    def test_required_scenarios(self):
        for expected, text, verdict, code in [
                ('PASSPORT', MIGRATION, 'MISMATCH', 'MIGRATION_CARD'),
                ('NAKS', SNILS, 'MISMATCH', 'SNILS'),
                ('SNILS', SNILS, 'MATCH', 'SNILS')]:
            result = self.check([text], expected)
            self.assertEqual((result['type_verdict'], result['detected_code']), (verdict, code))
            self.assertEqual(result['source'], 'XIAOMI_RULES')
            self.assertGreaterEqual(len(result['type_pages'][0]['matched_phrases']), 2)

    def test_mixed_package_needs_manual_review(self):
        result = self.check([SNILS, MIGRATION], 'SNILS')
        self.assertEqual((result['type_verdict'], result['type_reason']), ('UNCERTAIN', 'MIXED_DOCUMENT_TYPES'))
        self.assertIsNone(result['rejection_reason'])

    def test_unreadable_page_does_not_confirm_a_mismatch(self):
        for reason in xiaomi_text.REASONS:
            result = self.check([MIGRATION, xiaomi_text.ReaderError(reason)], 'PASSPORT')
            self.assertEqual((result['type_verdict'], result['type_reason']), ('UNCERTAIN', reason))

    def test_neutral_page_allows_type_match_but_not_a_return(self):
        self.assertEqual(self.check([SNILS, ''], 'SNILS')['type_verdict'], 'MATCH')
        self.assertEqual(self.check([SNILS, ''], 'NAKS')['type_verdict'], 'UNCERTAIN')

    def test_old_rules_do_not_gain_new_supporting_markers(self):
        self.assertEqual(DocumentTypeMatcher().evaluate_text(SNILS, 'NAKS')['verdict'], 'UNCERTAIN')

    def test_shadow_does_not_apply_new_decisions(self):
        from recognizeuz.quality import type_check
        legacy = {'type_verdict': 'UNCERTAIN', 'detected_code': None}
        with patch.dict(os.environ, {'DOCUMENT_TYPE_PROVIDER': 'shadow'}), \
                patch.object(type_check, 'legacy_check_types', return_value=legacy), \
                patch.object(xiaomi_type_check, 'check_types', return_value={
                    'type_verdict': 'MISMATCH', 'detected_code': 'SNILS', 'type_reason': None}):
            self.assertEqual(type_check.check_types([], 'NAKS', {}, deadline=0), legacy)

    def test_shadow_failure_preserves_the_legacy_response(self):
        from recognizeuz.quality import type_check
        legacy = {'type_verdict': 'MATCH', 'detected_code': 'NAKS'}
        with patch.dict(os.environ, {'DOCUMENT_TYPE_PROVIDER': 'shadow'}), \
                patch.object(type_check, 'legacy_check_types', return_value=legacy), \
                patch.object(xiaomi_type_check, 'check_types', side_effect=ValueError('private')):
            self.assertEqual(type_check.check_types([], 'NAKS', {}, deadline=0), legacy)


class XiaomiClientTests(unittest.TestCase):
    def invoke(self, result):
        opener = type('Opener', (), {'open': lambda *a, **kw: io.BytesIO(json.dumps(result).encode())})()
        with patch.object(xiaomi_text.urllib.request, 'build_opener', return_value=opener):
            return xiaomi_text.recognize_page(Image(), time.monotonic() + 10)

    def test_pinned_complete_text_only(self):
        result = {'model': xiaomi_text.MANIFEST['repository'], 'revision': xiaomi_text.MANIFEST['revision'],
                  'text': SNILS, 'reason': None, 'truncated': False}
        self.assertEqual(self.invoke(result), SNILS)
        for key, value in [('revision', 'untrusted'), ('truncated', True), ('text', 1), ('reason', 'UNKNOWN')]:
            with self.assertRaises(xiaomi_text.ReaderError):
                self.invoke({**result, key: value})

    def test_timeout_and_unavailable_are_distinct(self):
        for error, reason in [(TimeoutError(), 'TIMEOUT'), (OSError(), 'OCR_UNAVAILABLE')]:
            opener = type('Opener', (), {'open': lambda *a, **kw: (_ for _ in ()).throw(error)})()
            with patch.object(xiaomi_text.urllib.request, 'build_opener', return_value=opener), \
                    self.assertRaises(xiaomi_text.ReaderError) as caught:
                xiaomi_text.recognize_page(Image(), time.monotonic() + 10)
            self.assertEqual(caught.exception.reason, reason)

    def test_no_remote_url_or_expired_deadline(self):
        with patch.dict(os.environ, {'DOCUMENT_TYPE_XIAOMI_URL': 'https://example.com/recognize-text'}), \
                self.assertRaises(xiaomi_text.ReaderError):
            xiaomi_text.recognize_page(Image(), time.monotonic() + 10)
        with self.assertRaises(xiaomi_text.ReaderError) as caught:
            xiaomi_text.recognize_page(Image(), time.monotonic() - 1)
        self.assertEqual(caught.exception.reason, 'TIMEOUT')
