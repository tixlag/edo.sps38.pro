"""Policy, HTTP and failure handling without inference, CUDA, Pillow or weights."""
from pathlib import Path
import sys
from threading import Lock
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services/uz'))
from recognizeuz.quality import document_check as module


class DocumentCheckTests(unittest.TestCase):
    def test_only_unanimous_high_negative_scores_reject(self):
        self.assertEqual(module.verdict_from_scores([0.999] * 4), 'NON_DOCUMENT')
        for scores in ([0.999, 0.999, 0.999, 0.98], [0.6] * 4,
                       [float('nan')] * 4, [float('inf')] * 4, [0.999] * 3):
            self.assertEqual(module.verdict_from_scores(scores), 'UNCERTAIN')
        self.assertEqual(module.verdict_from_scores([0.999, 0.999, 0.01, 0.999]), 'DOCUMENT')

    def test_all_pages_keep_file_and_page_identity(self):
        resources = types.ModuleType('recognizeuz.core.resources')
        resources.infer_lock = Lock()
        def pages(data, filename, content_type):
            yield 1, object()
            if filename.endswith('.pdf'):
                yield 2, object()
        with patch.dict(sys.modules, {'recognizeuz.core.resources': resources}), \
                patch.object(module, 'pages', pages), \
                patch.object(module.checker, 'classify', return_value={
                    'verdict': 'UNCERTAIN', 'reason': None, 'non_document_scores': [0.5] * 4}):
            result = module.check_files([('a.jpg', b'a', 'image/jpeg'), ('b.pdf', b'b', 'application/pdf')])
        self.assertEqual([(p['file_index'], p['page_number']) for p in result['pages']], [(0, 1), (1, 1), (1, 2)])
        self.assertEqual(result['policy_version'], 'document-check-v1')

    def test_inference_outage_never_becomes_non_document(self):
        resources = types.ModuleType('recognizeuz.core.resources')
        resources.infer_lock = Lock()
        with patch.dict(sys.modules, {'recognizeuz.core.resources': resources}), \
                patch.object(module, 'pages', return_value=iter([(1, object())])), \
                patch.object(module.checker, 'classify', side_effect=RuntimeError('CUDA out of memory')):
            result = module.check_files([('a.jpg', b'a', 'image/jpeg')])
        self.assertEqual(result['pages'][0]['verdict'], 'UNCERTAIN')
        self.assertEqual(result['pages'][0]['reason'], 'INFERENCE_UNAVAILABLE')

    def test_missing_model_is_uncertain(self):
        self.assertEqual(module.DocumentChecker().classify(object())['verdict'], 'UNCERTAIN')
