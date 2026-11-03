import json
import sys
from pathlib import Path
from unittest import TestCase
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services/uz'))
from recognizeuz.quality.glm_type_verifier import GlmTypeVerifier


class TestGlmTypeVerifier(TestCase):
    def setUp(self):
        self.verifier = GlmTypeVerifier('http://127.0.0.1:8083/v1/chat/completions', 'model')

    def response(self, content):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({
            'choices': [{'message': {'content': json.dumps(content)}}]}).encode()
        return response

    @patch('urllib.request.urlopen')
    def test_valid_mismatch(self, urlopen):
        urlopen.return_value = self.response({'verdict': 'MISMATCH', 'detected_code': 'PASSPORT', 'confidence': 0.99})
        result = self.verifier.verify_image(b'image', 'INN')
        self.assertEqual(result['detected_code'], 'PASSPORT')
        self.assertEqual(result['verdict'], 'UNCERTAIN')

    @patch('urllib.request.urlopen')
    def test_inconsistent_unknown_and_low_confidence_fail_closed(self, urlopen):
        for content in [
            {'verdict': 'MATCH', 'detected_code': 'PASSPORT', 'confidence': 1},
            {'verdict': 'MISMATCH', 'detected_code': 'UNKNOWN', 'confidence': 1},
            {'verdict': 'MISMATCH', 'detected_code': 'PASSPORT', 'confidence': 0.8},
        ]:
            urlopen.return_value = self.response(content)
            self.assertEqual(self.verifier.verify_image(b'image', 'INN')['verdict'], 'UNCERTAIN')

    @patch('urllib.request.urlopen', side_effect=TimeoutError())
    def test_unavailable(self, urlopen):
        self.assertEqual(self.verifier.verify_image(b'image', 'INN')['verdict'], 'UNCERTAIN')
