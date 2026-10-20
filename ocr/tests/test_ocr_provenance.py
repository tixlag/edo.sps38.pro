"""Runner-only contract checks. No inference dependencies or private inputs."""
import ast
import __future__
from pathlib import Path
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]


def load_functions(path, names, namespace):
    tree = ast.parse(path.read_text())
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    assert len(functions) == len(names)
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(path), 'exec',
                 flags=__future__.annotations.compiler_flag), namespace)
    return namespace


class ProvenanceTests(unittest.TestCase):
    def test_uz_non_debug_output_keeps_original_score_and_glm_source(self):
        ns = load_functions(ROOT / 'services/uz/recognizeuz/pipeline/output.py',
                            ['build_output_document'], {
            'build_field_output_item': lambda ctx, item, field: {'text': item['final_text']},
            'build_debug_output_doc': lambda ctx, fields: {'fields': fields},
        })
        item = dict(field={}, field_name='pas_name', final_text='FINAL', source='glm_field',
                    paddle_text='PADDLE', paddle_score=1.0, original_paddle_text='ORIGINAL', original_paddle_score=0.42)
        ctx = SimpleNamespace(spec=SimpleNamespace(public_output_field_names=['pas_name'], should_skip_ocr=lambda name: False),
                              page=SimpleNamespace(options=SimpleNamespace(debug=False, save_segments=False)),
                              recognized_fields=[item], doc_type='passport')
        output = ns['build_output_document'](ctx)
        self.assertEqual(output['fields']['pas_name']['text'], 'FINAL')
        self.assertEqual(output['ocr_fields'], [dict(name='pas_name', value='FINAL', source='GLM', paddle_text='ORIGINAL', paddle_confidence=0.42)])
        ctx.page.options.debug = True
        self.assertEqual(ns['build_output_document'](ctx)['ocr_fields'], output['ocr_fields'])

    def test_ru_internal_multiline_glm_retains_paddle_attempt(self):
        ns = load_functions(ROOT / 'services/ru/doc_recognizer_universe.py', ['process_multiline_image_current'], {
            '_ensure_bgr': lambda img: img,
            '_base_multiline_class_name': lambda name: name,
            'PADDLE_INSTANCE_MULTILINE': None,
            'MULTILINE_GLM_FALLBACK_ENABLED': True,
            'MULTILINE_GLM_AVG_SCORE_THRESHOLD': 0.98,
            'paddle_recognize': lambda img, name: (('PADDLE', 0.4), ''),
            '_try_glm_multiline_fallback': lambda img, name: ('GLM', 1.0, 'glm_multiline_avg_score_fallback'),
        })
        provenance = {}
        result = ns['process_multiline_image_current'](object(), 'issued_by', None, provenance=provenance)
        self.assertEqual(result[0], ('GLM', 1.0))
        self.assertEqual(provenance, dict(source='GLM', paddle_text='PADDLE', paddle_confidence=0.4))

    def test_ru_final_metadata_follows_winning_segments(self):
        def recognize(img, name, idx, multiline, **options):
            options['provenance'].update(source='PADDLE', paddle_text='RAW', paddle_confidence=0.99)
            return ('FINAL', 0.99), ''
        ns = load_functions(ROOT / 'services/ru/doc_recognizer_universe.py', ['process_images_list_paddle'], {
            'run_yolo_segments_from_array_paddle': lambda img, model: {'name': [object()]},
            '_count_useful_paddle_segments': lambda segments: 1,
            'OCR_SEGMENT_CLASSES': {'name'}, 'SEGMENT_TO_FIELD_MAP': {'name': 'first_name'},
            'get_glm_prompt': lambda name: '', '_run_paddle_ocr_for_segment': recognize,
            '_normalize_ocr_text': lambda doc, name, text: text,
            '_is_acceptable_ocr_result': lambda *args: True,
            'RussianPassport': lambda **data: SimpleNamespace(model_dump=lambda: data),
        })
        output = ns['process_images_list_paddle']([{'img': object()}], object(), None, '', '', 'passport_ru', ocr_engine='paddle')
        self.assertEqual(output['data']['first_name'], 'Final')
        self.assertEqual(output['ocr_fields'], [dict(name='first_name', value='Final', source='PADDLE', paddle_text='RAW', paddle_confidence=0.99)])
