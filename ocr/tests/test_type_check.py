import os
from pathlib import Path
import sys
import time
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services/uz'))
from recognizeuz.quality.type_check import check_types


class TestTypeCheck(unittest.TestCase):
    def test_disabled_glm_and_unknown_codes_remain_uncertain(self):
        config = types.ModuleType('recognizeuz.core.config')
        config.GLM_OCR_MODEL = 'model'
        config.GLM_OCR_URL = 'http://127.0.0.1:8083/v1/chat/completions'
        presence = {'pages': [{'file_index': 0, 'page_number': 1, 'verdict': 'DOCUMENT'}]}
        with patch.dict(sys.modules, {'recognizeuz.core.config': config}), \
                patch.dict(os.environ, {'DOCUMENT_TYPE_GLM_ENABLED': 'false'}):
            for code in ('INN', 'ERP_unknown'):
                result = check_types([('a.png', b'', 'image/png')], code, presence,
                                     deadline=time.monotonic() + 10)
                self.assertEqual(result['expected_code'], code)
                self.assertEqual(result['type_verdict'], 'UNCERTAIN')
                self.assertIsNone(result['source'])

    def test_multi_page_match_precedes_uncertain(self):
        from unittest.mock import patch
        config = types.ModuleType('recognizeuz.core.config')
        config.GLM_OCR_MODEL = 'model'
        config.GLM_OCR_URL = 'http://127.0.0.1:8083/v1/chat/completions'
        presence = {'pages': [
            {'file_index': 0, 'page_number': 1, 'verdict': 'DOCUMENT'},
            {'file_index': 0, 'page_number': 2, 'verdict': 'DOCUMENT'},
        ]}
        with patch.dict(sys.modules, {'recognizeuz.core.config': config}), \
                patch.dict(os.environ, {'DOCUMENT_TYPE_GLM_ENABLED': 'false'}), \
                patch('recognizeuz.quality.document_check.pages', return_value=iter([(1, object()), (2, object())])), \
                patch('recognizeuz.quality.page_text.recognize_page', side_effect=['текст без признаков', 'трудовая книжка сведения о трудовой деятельности']):
            result = check_types([('a.pdf', b'', 'application/pdf')], 'EMPLOYMENT_RECORD', presence,
                                 deadline=time.monotonic() + 10)
        self.assertEqual(result['type_verdict'], 'MATCH')
        self.assertEqual(result['detected_code'], 'EMPLOYMENT_RECORD')

    def test_glm_outage_does_not_return_wrong_type(self):
        config = types.ModuleType('recognizeuz.core.config')
        config.GLM_OCR_MODEL = 'model'
        config.GLM_OCR_URL = 'http://127.0.0.1:8083/v1/chat/completions'
        presence = {'pages': [{'file_index': 0, 'page_number': 1, 'verdict': 'DOCUMENT'}]}
        class Image:
            def save(self, buffer, format):
                buffer.write(b'png')
        with patch.dict(sys.modules, {'recognizeuz.core.config': config}), \
                patch.dict(os.environ, {'DOCUMENT_TYPE_GLM_ENABLED': 'true'}), \
                patch('recognizeuz.quality.document_check.pages', return_value=iter([(1, Image())])), \
                patch('recognizeuz.quality.page_text.recognize_page', return_value=''), \
                patch('urllib.request.urlopen', side_effect=TimeoutError()):
            result = check_types([('a.png', b'', 'image/png')], 'INN', presence,
                                 deadline=time.monotonic() + 10)
        self.assertEqual(result['type_verdict'], 'UNCERTAIN')

    def test_multi_page_mismatch_requires_same_result_for_all_pages(self):
        config = types.ModuleType('recognizeuz.core.config')
        config.GLM_OCR_MODEL = 'model'
        config.GLM_OCR_URL = 'http://127.0.0.1:8083/v1/chat/completions'
        presence = {'pages': [
            {'file_index': 0, 'page_number': 1, 'verdict': 'DOCUMENT'},
            {'file_index': 0, 'page_number': 2, 'verdict': 'DOCUMENT'},
        ]}
        class Image:
            def save(self, buffer, format):
                buffer.write(b'png')
        wrong = {'verdict': 'MISMATCH', 'detected_code': 'PASSPORT', 'source': 'GLM'}
        with patch.dict(sys.modules, {'recognizeuz.core.config': config}), \
                patch.dict(os.environ, {'DOCUMENT_TYPE_GLM_ENABLED': 'true'}), \
                patch('recognizeuz.quality.document_check.pages', return_value=iter([(1, Image()), (2, Image())])), \
                patch('recognizeuz.quality.page_text.recognize_page', return_value=''), \
                patch('recognizeuz.quality.glm_type_verifier.GlmTypeVerifier.verify_image', return_value=wrong):
            result = check_types([('a.pdf', b'', 'application/pdf')], 'INN', presence,
                                 deadline=time.monotonic() + 10)
        self.assertEqual(result['type_verdict'], 'MISMATCH')
        self.assertEqual(result['detected_code'], 'PASSPORT')
