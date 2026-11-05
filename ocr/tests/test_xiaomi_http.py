"""HTTP limits can be checked without importing torch or loading weights."""
import importlib.util
import json
from pathlib import Path
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('xiaomi_server', ROOT / 'services/typecheck/server.py')
server_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server_module)


class XiaomiHttpTests(unittest.TestCase):
    def setUp(self):
        self.reader = Mock()
        self.server = server_module.create_server(self.reader, 0)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.url = 'http://127.0.0.1:' + str(self.server.server_port)

    def post(self, path='/recognize-text', data=b'image', deadline=None):
        return urllib.request.urlopen(urllib.request.Request(self.url + path, data=data,
            headers={'X-Deadline-Unix': str(time.time() + 40 if deadline is None else deadline)}), timeout=3)

    def test_response_attests_model_revision_and_preserves_truncation(self):
        for result in [{'text': 'read text', 'reason': None, 'truncated': False},
                       {'text': '', 'reason': 'TRUNCATED', 'truncated': True}]:
            self.reader.recognize.return_value = result
            with self.post() as response:
                value = json.load(response)
            self.assertEqual(value['revision'], server_module.MANIFEST['revision'])
            self.assertEqual(value['truncated'], result['truncated'])
            self.assertEqual(self.reader.recognize.call_args.args[0], b'image')

    def test_expired_or_unbounded_deadlines_never_run_inference(self):
        for deadline in [0, time.time() + 120, float('nan')]:
            with self.assertRaises(urllib.error.HTTPError) as caught:
                self.post(deadline=deadline)
            self.assertEqual(caught.exception.code, 408)
        self.reader.recognize.assert_not_called()

    def test_empty_body_and_unknown_endpoint_are_rejected(self):
        for kwargs, status in [({'data': b''}, 413), ({'path': '/other'}, 404)]:
            with self.assertRaises(urllib.error.HTTPError) as caught:
                self.post(**kwargs)
            self.assertEqual(caught.exception.code, status)
        self.reader.recognize.assert_not_called()

    def test_model_failure_is_technical_and_does_not_expose_body(self):
        self.reader.recognize.side_effect = RuntimeError('private diagnostic')
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.post()
        self.assertEqual(caught.exception.code, 503)
        self.assertEqual(json.load(caught.exception), {'reason': 'OCR_UNAVAILABLE'})
