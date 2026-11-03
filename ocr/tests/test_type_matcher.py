import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services/uz'))
from recognizeuz.quality.type_matcher import DocumentTypeMatcher


class TestTypeMatcher(unittest.TestCase):
    def setUp(self):
        self.matcher = DocumentTypeMatcher()

    def test_expected_type_and_other_type(self):
        inn = 'Идентификационный номер налогоплательщика'
        passport = 'Паспорт гражданина Российской Федерации'
        self.assertEqual(self.matcher.evaluate_text(inn, 'INN')['verdict'], 'MATCH')
        result = self.matcher.evaluate_text(passport, 'INN')
        self.assertEqual((result['verdict'], result['detected_code']), ('UNCERTAIN', 'PASSPORT'))
        self.assertIn('Паспорт', result['rejection_reason'])

    def test_generic_words_numbers_and_unknown_codes_are_uncertain(self):
        for text, code in [('место рождения 770123456789', 'INN'),
                           ('Паспорт гражданина Российской Федерации', 'ERP_unknown')]:
            self.assertEqual(self.matcher.evaluate_text(text, code)['verdict'], 'UNCERTAIN')

    def test_conflicting_markers_are_uncertain(self):
        text = 'Паспорт гражданина Российской Федерации. Свидетельство о рождении'
        self.assertEqual(self.matcher.evaluate_text(text, 'INN')['verdict'], 'UNCERTAIN')

    def test_normalization_and_word_boundaries(self):
        self.assertEqual(self.matcher.evaluate_text('ТРУДОВАЯ\nКНИЖКА', 'EMPLOYMENT_RECORD')['verdict'], 'MATCH')
        self.assertEqual(self.matcher.evaluate_text('предводительское удостоверение', 'INN')['verdict'], 'UNCERTAIN')
