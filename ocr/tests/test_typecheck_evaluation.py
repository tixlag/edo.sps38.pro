import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('evaluate_typecheck', ROOT / 'scripts/evaluate_typecheck.py')
evaluation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluation)


class EvaluationTests(unittest.TestCase):
    def corpus(self):
        samples, rows = [], []
        codes = {'SNILS', 'NAKS'}
        for code in codes:
            for i in range(3):
                sample = {'id': code + str(i), 'code': code, 'source_url': 'https://example.org/' + code + str(i),
                          'split': 'tuning' if i == 0 else 'heldout', 'sha256': code + str(i),
                          'independence_group': code + str(i)}
                samples.append(sample)
                rows.extend({'id': sample['id'], 'actual': code, 'expected': expected,
                             'verdict': 'MATCH' if expected == code else 'MISMATCH', 'detected': code}
                            for expected in codes)
        return samples, rows, codes

    def test_complete_heldout_matrix_passes(self):
        self.assertTrue(evaluation.summarize(*self.corpus())['passed'])

    def test_tuning_success_does_not_substitute_for_heldout_coverage(self):
        samples, rows, codes = self.corpus()
        for sample in samples:
            sample['split'] = 'tuning'
        self.assertFalse(evaluation.summarize(samples, rows, codes)['passed'])

    def test_selected_types_do_not_require_coverage_of_disabled_types(self):
        samples, rows, codes = self.corpus()
        for row in rows:
            if row['actual'] == 'NAKS':
                row.update(verdict='UNCERTAIN', detected=None)
        self.assertTrue(evaluation.summarize(samples, rows, codes, {'SNILS'})['passed'])
        self.assertFalse(evaluation.summarize(samples, rows, codes)['passed'])

    def test_a_disabled_document_misread_as_an_enabled_type_blocks_release(self):
        samples, rows, codes = self.corpus()
        row = next(r for r in rows if r['actual'] == r['expected'] == 'NAKS')
        row.update(verdict='MISMATCH', detected='SNILS')
        self.assertFalse(evaluation.summarize(samples, rows, codes, {'SNILS'})['passed'])

    def test_known_unsafe_tuning_samples_also_block_selected_release(self):
        samples, rows, codes = self.corpus()
        row = next(r for r in rows if r['id'] == 'NAKS0' and r['actual'] == r['expected'])
        row.update(verdict='MISMATCH', detected='SNILS')
        self.assertIn('FALSE_RETURNS', evaluation.summarize(samples, rows, codes, {'SNILS'})['problems'])

    def test_user_supplied_provenance_counts_without_a_fictional_public_url(self):
        samples, rows, codes = self.corpus()
        for sample in samples:
            sample['source_id'] = 'user-provided:' + sample['id']
            del sample['source_url']
        self.assertTrue(evaluation.summarize(samples, rows, codes)['passed'])

    def test_resized_copies_of_a_tuning_document_cannot_be_heldout(self):
        samples, rows, codes = self.corpus()
        for sample in samples:
            sample['independence_group'] = sample['code']
        self.assertFalse(evaluation.summarize(samples, rows, codes)['passed'])

    def test_false_return_wrong_label_and_missing_cells_block_the_gate(self):
        for kind in ('false_return', 'wrong_label', 'missing'):
            samples, rows, codes = self.corpus()
            if kind == 'false_return':
                next(r for r in rows if r['id'].endswith('1') and r['actual'] == r['expected'])['verdict'] = 'MISMATCH'
            elif kind == 'wrong_label':
                next(r for r in rows if r['id'].endswith('1') and r['actual'] != r['expected'])['detected'] = 'OTHER'
            else:
                rows.pop()
            self.assertFalse(evaluation.summarize(samples, rows, codes)['passed'])
