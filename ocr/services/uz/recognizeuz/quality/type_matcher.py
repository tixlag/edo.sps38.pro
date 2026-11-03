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
