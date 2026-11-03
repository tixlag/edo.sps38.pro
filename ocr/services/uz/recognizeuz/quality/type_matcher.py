"""Conservative classification of OCR text using explicitly distinctive phrases.

A number or a generic word is not sufficient evidence for an automatic return.
The registry must opt phrases into definitive classification via strong_markers.
"""
from __future__ import annotations

import json
from pathlib import Path
import re
import unicodedata

ROOT = Path(__file__).resolve().parents[4]


def normalize(text: str) -> str:
    text = unicodedata.normalize('NFKC', text).casefold().replace('ё', 'е')
    return ' '.join(re.sub(r'[^\w]+', ' ', text).split())


def canonical_code(code: str) -> str:
    return {'MILITARY': 'MILITARY_ID'}.get(code, code)


class DocumentTypeMatcher:
    def __init__(self, rules_path: Path | None = None):
        path = rules_path or ROOT / 'contracts/document-type-rules.json'
        data = json.loads(path.read_text(encoding='utf-8'))
        if data.get('version') != 'document-type-rules-v1':
            raise ValueError('Unsupported document type rules version')
        self.rules = {rule['code']: rule for rule in data['rules']}
        if len(self.rules) != len(data['rules']):
            raise ValueError('Duplicate document type code')

    def evaluate_text(self, text: str, expected_code: str) -> dict:
        result = {'verdict': 'UNCERTAIN', 'detected_code': None,
                  'rejection_reason': None, 'matched_phrases': []}
        expected_code = canonical_code(expected_code)
        if expected_code not in self.rules:
            return result
        normalized = ' ' + normalize(text) + ' '
        hits = {}
        for code, rule in self.rules.items():
            phrases = [phrase for phrase in rule.get('strong_markers', [])
                       if normalize(phrase) and ' ' + normalize(phrase) + ' ' in normalized]
            if phrases:
                hits[code] = phrases
        # A document may mention other documents. Contradictory evidence needs review.
        if len(hits) != 1:
            return result
        code, phrases = next(iter(hits.items()))
        result.update(detected_code=code, matched_phrases=phrases)
        if code == expected_code:
            result['verdict'] = 'MATCH'
        else:
            # A type name can occur in another document. Treat it as a hint
            # until this rule is validated against representative documents.
            result['verdict'] = 'UNCERTAIN'
        return result
