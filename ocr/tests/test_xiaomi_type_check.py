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
    width = 20
    height = 10

    def __init__(self, index=0, angle=0):
        self.index, self.angle = index, angle

    def rotate(self, angle, expand=True):
        return Image(self.index, angle)

    def close(self):
        pass

    def save(self, buffer, format):
        buffer.write(b'png')


class XiaomiPolicyTests(unittest.TestCase):
    def check(self, texts, expected):
        presence = {'pages': [{'file_index': 0, 'page_number': i + 1, 'verdict': 'DOCUMENT'}
                              for i in range(len(texts))]}
        def read(image, _, **_options):
            value = texts[image.index]
            if isinstance(value, Exception):
                raise value
            return value
        with patch('recognizeuz.quality.document_check.pages',
                   return_value=iter((i + 1, Image(i)) for i in range(len(texts)))), \
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

    def test_orientation_is_selected_without_the_expected_type(self):
        matcher = DocumentTypeMatcher(ROOT / 'contracts/document-type-rules-v2.json')
        with patch.object(xiaomi_type_check, 'recognize_page',
                          side_effect=lambda image, _, **_options: SNILS if image.angle == 270 else ''):
            text, angle, _pixels = xiaomi_type_check.recognize_type_text(Image(), time.monotonic() + 10, matcher)
        self.assertEqual((text, angle), (SNILS, 270))

    def test_a_larger_read_is_tried_before_rotating_the_page(self):
        matcher = DocumentTypeMatcher(ROOT / 'contracts/document-type-rules-v2.json')
        with patch.object(xiaomi_type_check, 'recognize_page',
                          side_effect=lambda _image, _deadline, *, pixels: SNILS if pixels == 1258291 else '') as read:
            text, angle, pixels = xiaomi_type_check.recognize_type_text(Image(), time.monotonic() + 10, matcher)
        self.assertEqual((text, angle, pixels), (SNILS, 0, 1258291))
        self.assertEqual(read.call_count, 2)

    def test_rotations_cannot_overrule_a_conflicting_original(self):
        matcher = DocumentTypeMatcher(ROOT / 'contracts/document-type-rules-v2.json')
        with patch.object(xiaomi_type_check, 'recognize_page',
                          side_effect=lambda image, _, **_options: MIGRATION if image.angle else 'АДИ-РЕГ'), \
                self.assertRaises(xiaomi_text.ReaderError) as caught:
            xiaomi_type_check.recognize_type_text(Image(), time.monotonic() + 10, matcher)
        self.assertEqual(caught.exception.reason, 'MIXED_DOCUMENT_TYPES')

    def test_unreadable_page_does_not_confirm_a_mismatch(self):
        for reason in xiaomi_text.REASONS:
            result = self.check([MIGRATION, xiaomi_text.ReaderError(reason)], 'PASSPORT')
            self.assertEqual((result['type_verdict'], result['type_reason']), ('UNCERTAIN', reason))

    def test_neutral_page_allows_type_match_but_not_a_return(self):
        self.assertEqual(self.check([SNILS, ''], 'SNILS')['type_verdict'], 'MATCH')
        self.assertEqual(self.check([SNILS, ''], 'NAKS')['type_verdict'], 'UNCERTAIN')

    def test_old_rules_do_not_gain_new_supporting_markers(self):
        self.assertEqual(DocumentTypeMatcher().evaluate_text(SNILS, 'NAKS')['verdict'], 'UNCERTAIN')

    def test_catalog_variants_are_supported_without_changing_legacy(self):
        matcher = DocumentTypeMatcher(ROOT / 'contracts/document-type-rules-v2.json')
        for code, text in [
                ('HIGHER_EDUCATION_DIPLOMA', 'Диплом бакалавра. Документ об образовании и о квалификации'),
                ('VOCATIONAL_DIPLOMA', 'Диплом о среднем профессиональном образовании. Государственной экзаменационной комиссии'),
                ('INSURANCE_POLICY', 'Полис добровольного медицинского страхования. Страхователь'),
                ('SNILS', 'СТРАХОВЕЕ СВИДЕТЕЛЬСТВО обязательного пенсионного страхования. Дата регистрации')]:
            self.assertEqual(matcher.evaluate_text(text, code)['verdict'], 'MATCH', code)

    def test_naks_material_certificate_is_not_a_personal_credential(self):
        matcher = DocumentTypeMatcher(ROOT / 'contracts/document-type-rules-v2.json')
        text = 'НАКС Национальное агентство контроля сварки. Свидетельство об аттестации сварочных материалов. Сварка'
        self.assertEqual(matcher.evaluate_text(text, 'NAKS')['verdict'], 'UNCERTAIN')

    def test_a_passport_field_does_not_override_the_registration_title(self):
        matcher = DocumentTypeMatcher(ROOT / 'contracts/document-type-rules-v2.json')
        text = 'Уведомление о прибытии иностранного гражданина. Место пребывания. Паспорт выдан'
        self.assertEqual(matcher.evaluate_text(text, 'REGISTRATION_NOTICE')['verdict'], 'MATCH')

    def test_two_corroborated_types_on_one_page_are_still_mixed(self):
        matcher = DocumentTypeMatcher(ROOT / 'contracts/document-type-rules-v2.json')
        result = matcher.evaluate_text(SNILS + ' ' + MIGRATION, 'SNILS')
        self.assertEqual((result['verdict'], result['reason']), ('UNCERTAIN', 'MIXED_DOCUMENT_TYPES'))

    def test_passport_identity_page_can_use_mrz_and_country_without_the_issuer_page(self):
        matcher = DocumentTypeMatcher(ROOT / 'contracts/document-type-rules-v2.json')
        for text in ['Российская Федерация PNRUSIVANOV<<IVAN<<<<<<<<',
                     'REPUBLIC OF UZBEKISTAN PASSPORT P<UZBTEST<<TEST<<<<<<<<']:
            result = matcher.evaluate_text(text, 'PASSPORT')
            self.assertEqual(result['verdict'], 'MATCH')
            self.assertFalse(any('IVANOV' in phrase or 'TEST<' in phrase for phrase in result['matched_phrases']))
        self.assertEqual(matcher.evaluate_text('Российская Федерация I<RUSTEST<<TEST<<<<<<<<', 'PASSPORT')['verdict'], 'UNCERTAIN')

    def test_layout_markup_does_not_hide_a_document_title(self):
        matcher = DocumentTypeMatcher(ROOT / 'contracts/document-type-rules-v2.json')
        result = matcher.evaluate_text('<p>Диплом</p><p>бакалавра</p>Документ об образовании и о квалификации', 'HIGHER_EDUCATION_DIPLOMA')
        self.assertEqual(result['verdict'], 'MATCH')

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
                  'text': SNILS, 'reason': None, 'truncated': False, 'pixels': 786432}
        self.assertEqual(self.invoke(result), SNILS)
        for key, value in [('revision', 'untrusted'), ('truncated', True), ('text', 1), ('reason', 'UNKNOWN'), ('pixels', 1)]:
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
