"""Conservative classification of OCR text using explicitly distinctive phrases.

A number or a generic word is not sufficient evidence for an automatic return.
The registry must opt phrases into definitive classification via strong_markers.
"""
from __future__ import annotations

import json
import html
from pathlib import Path
import re
import unicodedata

ROOT = Path(__file__).resolve().parents[4]


def normalize(text: str) -> str:
    text = unicodedata.normalize('NFKC', text).casefold().replace('ё', 'е')
    return ' '.join(re.sub(r'[^\w]+', ' ', text).split())


def canonical_code(code: str) -> str:
    # Codes observed in the EDO document catalog; unknown codes stay unknown.
    aliases = {
        'MILITARY': 'MILITARY_ID',
        'PATENT': 'WORK_PATENT',
        'DMS': 'INSURANCE_POLICY',
        'ERP_39554ac3-6462-11ec-80cc-002590854e7f': 'MIGRATION_CARD',
        'ERP_deb3bcd3-8340-11eb-ba8b-00259002db81': 'DRIVER_LICENSE',
        'ERP_a4e4f609-8c6a-11eb-ba8b-00259002db81': 'NAKS',
        'ERP_e6971b86-9120-11eb-ba8c-00259002db81': 'EXCAVATOR_OPERATOR_CERTIFICATE',
        'ERP_10fa3e03-751b-11ec-80cd-002590854e7f': 'VOCATIONAL_DIPLOMA',
        'ERP_b6e096a2-87be-11ec-80cf-002590854e7f': 'MEASLES_ANTIBODIES_CERTIFICATE',
        'ERP_e87d5a10-d248-11eb-80c7-002590854e7f': 'WORK_PATENT',
        'ERP_26b930ce-6462-11ec-80cc-002590854e7f': 'REGISTRATION_NOTICE',
        'ERP_90630325-7414-11ec-80cd-002590854e7f': 'RUSSIAN_LANGUAGE_CERTIFICATE',
        'ERP_6a4dd233-5f52-11ec-80cb-002590854e7f': 'PASSPORT_TRANSLATION',
        'ERP_a18522de-8341-11eb-ba8b-00259002db81': 'HIGHER_EDUCATION_DIPLOMA',
        'ERP_ea24dda5-8341-11eb-ba8b-00259002db81': 'PSYCHIATRIC_EVALUATION',
        'ERP_70fc9853-8c81-11eb-ba8b-00259002db81': 'MARRIAGE_CERTIFICATE',
        'ERP_f26b853d-0367-11ef-a9f6-0050560116fc': 'FOREIGN_MEDICAL_EXAMINATION',
        'ERP_5df73b8f-8c56-11eb-ba8b-00259002db81': 'INSURANCE_POLICY',
        'ERP_402ec3c2-3cf6-11f0-89f3-00505601221a': 'RETRAINING_DIPLOMA',
        'ERP_5f2d9eef-8341-11eb-ba8b-00259002db81': 'DOPOG',
        'ERP_65517702-8341-11eb-ba8b-00259002db81': 'TACHOGRAPH_CARD',
        'ERP_9b9cf254-d69d-11ee-a9e4-0050560116fc': 'RESIDENCE_PERMIT',
        'ERP_7d0a587a-8228-11eb-ba8b-00259002db81': 'SAFE_WINTER_DRIVING_CERTIFICATE',
        'ERP_bdf50265-5469-11ef-89df-00505601221a': 'PROFESSION_CERTIFICATE',
        'ERP_3f164241-8c5b-11eb-ba8b-00259002db81': 'BIRTH_CERTIFICATE',
        'ERP_b733d106-8c6b-11eb-ba8b-00259002db81': 'POLICE_CLEARANCE',
        'ERP_7725d068-8341-11eb-ba8b-00259002db81': 'EMPLOYMENT_RECORD',
    }
    return aliases.get(code, code)


class DocumentTypeMatcher:
    def __init__(self, rules_path: Path | None = None):
        path = rules_path or ROOT / 'contracts/document-type-rules.json'
        data = json.loads(path.read_text(encoding='utf-8'))
        overrides = {}
        if data.get('version') == 'document-type-rules-v2' and data.get('extends') == 'document-type-rules.json':
            overrides = data
            data = json.loads((path.parent / data['extends']).read_text(encoding='utf-8'))
        if data.get('version') != 'document-type-rules-v1':
            raise ValueError('Unsupported document type rules version')
        self.rules = {rule['code']: rule for rule in data['rules']}
        if len(self.rules) != len(data['rules']):
            raise ValueError('Duplicate document type code')
        for field in ('strong_markers', 'supporting_markers'):
            for code, phrases in overrides.get(field, {}).items():
                self.rules[code][field].extend(phrases)
        self.prefer_corroborated = overrides.get('prefer_corroborated', False)
        self.marker_sets = overrides.get('marker_sets', {})
        self.required_any = overrides.get('required_any', {})
        self.pattern_groups = overrides.get('pattern_groups', {})

    def evaluate_text(self, text: str, expected_code: str) -> dict:
        result = {'verdict': 'UNCERTAIN', 'detected_code': None,
                  'rejection_reason': None, 'matched_phrases': []}
        expected_code = canonical_code(expected_code)
        if expected_code not in self.rules:
            return result
        if self.prefer_corroborated:
            return self.evaluate_corroborated(text, expected_code)
        normalized = ' ' + normalize(text) + ' '
        hits = {}
        for code, rule in self.rules.items():
            phrases = [phrase for phrase in rule.get('strong_markers', [])
                       if normalize(phrase) and ' ' + normalize(phrase) + ' ' in normalized]
            if phrases:
                hits[code] = phrases
        # A document may mention other documents. Contradictory evidence needs review.
        if len(hits) != 1:
            if len(hits) > 1:
                result['reason'] = 'MIXED_DOCUMENT_TYPES'
            return result
        code, phrases = next(iter(hits.items()))
        result.update(detected_code=code, matched_phrases=phrases)
        # Overlapping phrases count once; require two independent markers.
        normalized_phrases = sorted({normalize(p) for p in phrases}, key=len, reverse=True)
        independent = []
        for phrase in normalized_phrases:
            if not any(' ' + phrase + ' ' in ' ' + other + ' ' for other in independent):
                independent.append(phrase)
        supporting = [p for p in self.rules[code].get('supporting_markers', [])
                      if normalize(p) and ' ' + normalize(p) + ' ' in normalized
                      and not any(normalize(p) in anchor for anchor in independent)]
        corroborated = bool(supporting)
        if len(independent) >= 2 or corroborated:
            result['verdict'] = 'MATCH' if code == expected_code else 'MISMATCH'
            result['matched_phrases'] = phrases + supporting
        return result

    def evaluate_corroborated(self, text, expected_code):
        text = html.unescape(text)
        text = re.sub(r'</?(?:table|tr|td|th|p|div|h[1-6]|br|span|strong|b|i|em|html|body)(?:\s[^>]*)?>', '\n', text, flags=re.IGNORECASE)
        normalized = ' ' + normalize(text) + ' '
        def contains(phrase):
            return bool(normalize(phrase)) and ' ' + normalize(phrase) + ' ' in normalized
        hits, confident = {}, {}
        for code, rule in self.rules.items():
            required = self.required_any.get(code, [])
            if required and not any(contains(p) for p in required):
                continue
            anchors = [p for p in rule['strong_markers'] if contains(p)]
            for group in self.marker_sets.get(code, []):
                if all(contains(p) for p in group):
                    anchors.extend(group)
            for group in self.pattern_groups.get(code, []):
                found = re.search(group['pattern'], text, re.IGNORECASE | re.MULTILINE)
                evidence = [p for p in group['supporting_markers'] if contains(p)]
                if found and evidence:
                    anchors.extend([found.group(0), *evidence])
            if not anchors:
                continue
            hits[code] = list(dict.fromkeys(anchors))
            supporting = [p for p in rule['supporting_markers'] if contains(p)]
            independent = []
            for phrase in sorted({normalize(p) for p in anchors + supporting}, key=len, reverse=True):
                if not any(' ' + phrase + ' ' in ' ' + other + ' ' for other in independent):
                    independent.append(phrase)
            if len(independent) >= 2:
                confident[code] = list(dict.fromkeys(anchors + supporting))
        # A field mentioning another document is weaker than corroborated type
        # evidence. Two corroborated types still require human review.
        selected = confident or hits
        result = {'verdict': 'UNCERTAIN', 'detected_code': None,
                  'rejection_reason': None, 'matched_phrases': []}
        if len(selected) > 1:
            return {**result, 'reason': 'MIXED_DOCUMENT_TYPES'}
        if selected:
            code, phrases = next(iter(selected.items()))
            result.update(detected_code=code, matched_phrases=phrases)
            if confident:
                result['verdict'] = 'MATCH' if code == expected_code else 'MISMATCH'
        return result
