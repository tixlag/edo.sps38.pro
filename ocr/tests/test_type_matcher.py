import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services/uz'))
from recognizeuz.quality.type_matcher import DocumentTypeMatcher, canonical_code


class TestTypeMatcher(unittest.TestCase):
    def setUp(self):
        self.matcher = DocumentTypeMatcher()

    def test_expected_type_and_other_type(self):
        inn = 'Идентификационный номер налогоплательщика. Свидетельство о постановке на учет в налоговом органе'
        passport = 'Паспорт гражданина Российской Федерации'
        self.assertEqual(self.matcher.evaluate_text(inn, 'INN')['verdict'], 'MATCH')
        result = self.matcher.evaluate_text(passport, 'INN')
        self.assertEqual((result['verdict'], result['detected_code']), ('UNCERTAIN', 'PASSPORT'))
        self.assertIsNone(result['rejection_reason'])
        self.assertEqual(canonical_code('MILITARY'), 'MILITARY_ID')
        self.assertEqual(canonical_code('ERP_39554ac3-6462-11ec-80cc-002590854e7f'), 'MIGRATION_CARD')

    def test_generic_words_numbers_and_unknown_codes_are_uncertain(self):
        for text, code in [('место рождения 770123456789', 'INN'),
                           ('Паспорт гражданина Российской Федерации', 'ERP_unknown')]:
            self.assertEqual(self.matcher.evaluate_text(text, code)['verdict'], 'UNCERTAIN')

    def test_conflicting_markers_are_uncertain(self):
        text = 'Паспорт гражданина Российской Федерации. Свидетельство о рождении'
        self.assertEqual(self.matcher.evaluate_text(text, 'INN')['verdict'], 'UNCERTAIN')

    def test_normalization_and_word_boundaries(self):
        self.assertEqual(self.matcher.evaluate_text('ТРУДОВАЯ\nКНИЖКА сведения о трудовой деятельности', 'EMPLOYMENT_RECORD')['verdict'], 'MATCH')
        self.assertEqual(self.matcher.evaluate_text('предводительское удостоверение', 'INN')['verdict'], 'UNCERTAIN')

    def test_each_rule_has_anchor_and_corroborating_marker(self):
        for code, rule in self.matcher.rules.items():
            self.assertTrue(rule.get('strong_markers'), code)
            self.assertTrue(rule.get('supporting_markers'), code)
            outcomes = [self.matcher.evaluate_text(f'{anchor} {support}', code)['verdict']
                        for anchor in rule['strong_markers']
                        for support in rule['supporting_markers']]
            self.assertIn('MATCH', outcomes, code)
