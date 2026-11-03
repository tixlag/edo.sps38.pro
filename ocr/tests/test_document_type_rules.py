import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
RULES_PATH = ROOT / "contracts" / "document-type-rules.json"


class TestDocumentTypeRules(unittest.TestCase):
    def setUp(self):
        self.assertTrue(RULES_PATH.exists(), f"Missing {RULES_PATH}")
        self.data = json.loads(RULES_PATH.read_text(encoding="utf-8"))

    def test_schema_structure(self):
        self.assertEqual(self.data.get("version"), "document-type-rules-v1")
        self.assertIn("rules", self.data)
        rules = self.data["rules"]
        self.assertIsInstance(rules, list)
        self.assertGreaterEqual(len(rules), 29)

    def test_unique_codes(self):
        codes = [rule["code"] for rule in self.data["rules"]]
        self.assertEqual(len(codes), len(set(codes)), "Rule codes must be unique")

    def test_rule_fields_and_regexes(self):
        for rule in self.data["rules"]:
            self.assertIn("code", rule)
            self.assertIn("title", rule)
            self.assertIn("markers", rule)
            self.assertIsInstance(rule["markers"], list)
            self.assertGreater(len(rule["markers"]), 0, f"Empty markers in {rule['code']}")
            for pattern in rule.get("patterns", []):
                try:
                    re.compile(pattern)
                except re.error as err:
                    self.fail(f"Invalid regex '{pattern}' in rule {rule['code']}: {err}")


if __name__ == "__main__":
    unittest.main()
