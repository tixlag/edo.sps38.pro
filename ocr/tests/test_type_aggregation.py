import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services/uz'))
from recognizeuz.quality.type_aggregation import aggregate_type_pages


class TestTypeAggregation(unittest.TestCase):
    def test_match_wins_with_complete_coverage(self):
        pages = [{'file_index': 0, 'page_number': 1, 'verdict': 'UNCERTAIN'},
                 {'file_index': 0, 'page_number': 2, 'verdict': 'MATCH', 'detected_code': 'INN'}]
        self.assertEqual(aggregate_type_pages(pages, 'INN', {(0, 1), (0, 2)})['verdict'], 'MATCH')
        self.assertEqual(aggregate_type_pages(pages[:1], 'INN', {(0, 1), (0, 2)})['verdict'], 'UNCERTAIN')

    def test_uncertain_or_conflicting_pages_prevent_rejection(self):
        mismatch = {'file_index': 0, 'page_number': 1, 'verdict': 'MISMATCH', 'detected_code': 'PASSPORT'}
        other = {'file_index': 0, 'page_number': 2, 'verdict': 'UNCERTAIN'}
        self.assertEqual(aggregate_type_pages([mismatch, other], 'INN', {(0, 1), (0, 2)})['verdict'], 'UNCERTAIN')
        self.assertEqual(aggregate_type_pages([mismatch, mismatch], 'INN', {(0, 1), (0, 2)})['verdict'], 'UNCERTAIN')

    def test_all_pages_same_mismatch(self):
        pages = [{'file_index': 0, 'page_number': 1, 'verdict': 'MISMATCH', 'detected_code': 'PASSPORT'}]
        self.assertEqual(aggregate_type_pages(pages, 'INN', {(0, 1)}), {'verdict': 'MISMATCH', 'detected_code': 'PASSPORT'})
