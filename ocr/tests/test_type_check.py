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
