"""Exercise real UZ HTTP adapters with inference replaced at its boundary.

These tests validate requests/responses, not OCR accuracy. Real inference is a
separate local acceptance check because private models/documents stay out of CI.
"""
import base64
import importlib
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services/uz'))


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.result = [{'type': 'migration_card', 'fields': {'mg_name': {'text': 'TEST'}}}]
        resources = types.ModuleType('recognizeuz.core.resources')
        resources.get_models_status = lambda: {'doc_model': True}
        pipeline = types.ModuleType('recognizeuz.pipeline.recognition')
        def recognize(payload, **options):
            self.calls.append((payload, options))
            return self.result
        pipeline.recognize_files_payload = recognize
        self.modules = patch.dict(sys.modules, {'recognizeuz.core.resources': resources,
            'recognizeuz.pipeline.recognition': pipeline})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        import recognizeuz.core
        self.core_attr = patch.object(recognizeuz.core, 'resources', resources, create=True)
        self.core_attr.start()
        self.addCleanup(self.core_attr.stop)
        module = importlib.import_module('recognizeuz.api.routes')
        module = importlib.reload(module)
        app = FastAPI()
        app.include_router(module.router)
        self.client = TestClient(app)

    def test_health(self):
        self.assertEqual(self.client.get('/health').json(), {'status':'ok','models':{'doc_model':True},
                                                          'document_check_memory': {}})

    def test_document_check_has_a_separate_typed_contract(self):
        from recognizeuz.api import routes
        result = {'policy_version': 'document-check-v1', 'model': 'test', 'model_revision': 'revision',
                  'elapsed_ms': 1, 'pages': [{'file_index': 0, 'page_number': 1,
                      'verdict': 'NON_DOCUMENT', 'reason': None, 'non_document_scores': [0.999] * 4}]}
        with patch.object(routes, 'check_files', return_value=result) as check:
            response = self.client.post('/document-check', files={'files': ('x.jpg', b'photo', 'image/jpeg')})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), result)
        check.assert_called_once_with([('x.jpg', b'photo', 'image/jpeg')])
        self.assertEqual(self.calls, [])

    def test_multipart_form_flags_override_query(self):
        response = self.client.post('/recognize?debug=true&ocr_improve=true&dump_segments=true',
            files=[('files', ('a.jpg', b'a', 'image/jpeg')), ('files', ('b.pdf', b'b', 'application/pdf'))],
            data={'debug':'false','ocr_improve':'false','save_segments':'false'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), self.result)
        payload, options = self.calls[-1]
        self.assertEqual(len(payload), 2)
        self.assertEqual(payload[1], ('b.pdf', b'b', 'application/pdf'))
        self.assertEqual(options, {'debug':False,'ocr_improve':False,'save_segments':False})

    def test_base64_flags_and_decoding(self):
        response = self.client.post('/recognize-base64?dump_segments=true', json={
            'files':[{'filename':'x.jpg','content_base64':base64.b64encode(b'image').decode()}], 'debug':True})
        self.assertEqual(response.status_code, 200)
        payload, options = self.calls[-1]
        self.assertEqual(payload, [('x.jpg', b'image', None)])
        self.assertEqual(options, {'debug':True,'ocr_improve':False,'save_segments':True})

    def test_missing_files_validation(self):
        self.assertEqual(self.client.post('/recognize').status_code, 422)
        self.assertEqual(self.client.post('/recognize-base64', json={}).status_code, 422)

    def test_empty_results_keep_original_different_statuses(self):
        self.result = []
        response = self.client.post('/recognize', files={'files':('x.jpg', b'x', 'image/jpeg')})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {'detail':'Плохое качество документа'})
        self.assertEqual(self.client.post('/recognize-base64', json={'files':[]}).json(), [])
