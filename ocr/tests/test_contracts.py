"""Freeze endpoint signatures without importing inference frameworks."""
import ast
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
BASELINE = json.loads((ROOT / 'tests/api_baseline.json').read_text())


def routes(path):
    result = []
    for node in ast.walk(ast.parse(path.read_text())):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for dec in node.decorator_list:
            if isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute) and dec.func.attr in {'get','post'}:
                result.append({'method':dec.func.attr.upper(), 'path':ast.literal_eval(dec.args[0]),
                               'signature':ast.dump(node.args, include_attributes=False)})
    return result


class ContractTests(unittest.TestCase):
    def test_uz_signatures_preserved(self):
        self.assertEqual(routes(ROOT / 'services/uz/recognizeuz/api/routes.py'), BASELINE['uz_modular'])

    def test_ru_signatures_preserved(self):
        self.assertEqual(routes(ROOT / 'services/ru/doc_recognizer_universe.py'), BASELINE['ru'])

    def test_all_runtime_python_parses(self):
        for path in (ROOT / 'services').rglob('*.py'):
            if '.venv' not in path.parts:
                with self.subTest(path=path):
                    ast.parse(path.read_text())
