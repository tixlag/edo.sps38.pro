#!/usr/bin/env python3
"""Private corpus evaluation: extract once, then check every expected type.

Run on the OCR host. Images, extracted text and results must remain outside Git.
Only held-out samples contribute to the release gate; tuning images do not.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time
import re
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services/uz'))
from recognizeuz.quality.type_matcher import DocumentTypeMatcher
from recognizeuz.quality.xiaomi_text import MANIFEST, ReaderError
from recognizeuz.quality.xiaomi_type_check import recognize_type_text
from recognizeuz.quality.type_release import resolve_codes


def rules_digest(root=ROOT):
    return hashlib.sha256(b'\0'.join((root / name).read_bytes() for name in (
        'contracts/document-type-rules.json', 'contracts/document-type-rules-v2.json',
        'services/uz/recognizeuz/quality/type_matcher.py',
        'services/uz/recognizeuz/quality/xiaomi_type_check.py',
        'services/uz/recognizeuz/quality/xiaomi_text.py',
        'services/uz/recognizeuz/quality/type_release.py',
        'scripts/evaluate_typecheck.py',
        'services/typecheck/server.py'))).hexdigest()


def summarize(samples, rows, codes, release_codes=None):
    approved = set(codes) if release_codes is None else set(release_codes)
    if not approved or not approved <= set(codes):
        raise ValueError('Expected known, nonempty release codes')
    problems = []
    source = lambda s: s.get('source_url') or s.get('source_id')
    for code in approved:
        labeled = [s for s in samples if s['code'] == code]
        sources = {source(s) for s in labeled}
        groups = {s.get('independence_group') for s in labeled if s.get('independence_group')}
        heldout = [s for s in labeled if s['split'] == 'heldout']
        heldout_sources = {source(s) for s in heldout}
        tuning_sources = {source(s) for s in labeled if s['split'] == 'tuning'}
        if (len(sources) < 3 or len(groups) < 3 or len({s['sha256'] for s in labeled}) < 3
                or len(heldout_sources) < 2 or heldout_sources & tuning_sources):
            problems.append('INSUFFICIENT_INDEPENDENT_SAMPLES:' + code)
        training_groups = {s.get('independence_group') for s in labeled if s['split'] == 'tuning'}
        heldout_groups = {s.get('independence_group') for s in heldout}
        if training_groups & heldout_groups or len(heldout_groups - {None}) < 2:
            problems.append('SOURCE_LEAKAGE_OR_DUPLICATE:' + code)
    heldout_ids = {s['id'] for s in samples if s['split'] == 'heldout'}
    evaluated = [r for r in rows if r['id'] in heldout_ids]
    positives = [r for r in evaluated if r['expected'] == r['actual'] and r['actual'] in approved]
    negatives = [r for r in evaluated if r['expected'] != r['actual'] and r['actual'] in approved]
    # Every known sample can expose an unsafe return, including tuning images
    # and documents outside the enabled types. Coverage uses heldout only.
    returns = [r for r in rows if r['verdict'] == 'MISMATCH' and r['detected'] in approved]
    false_returns = sum(r['expected'] == r['actual'] for r in returns)
    positive_rate = sum(r['verdict'] == 'MATCH' for r in positives) / max(1, len(positives))
    negative_rate = sum(r['verdict'] == 'MISMATCH' and r['detected'] == r['actual']
                        for r in negatives) / max(1, len(negatives))
    if false_returns:
        problems.append('FALSE_RETURNS')
    if positive_rate < .95:
        problems.append('POSITIVE_COVERAGE_BELOW_95_PERCENT')
    if negative_rate < .95:
        problems.append('NEGATIVE_COVERAGE_BELOW_95_PERCENT')
    if any(r['detected'] != r['actual'] for r in returns):
        problems.append('WRONG_DETECTED_TYPE')
    if len(evaluated) != len(heldout_ids) * len(codes):
        problems.append('INCOMPLETE_MATRIX')
    return {'passed': not problems, 'problems': problems, 'false_returns': false_returns,
            'positive_rate': positive_rate, 'negative_rate': negative_rate,
            'heldout_samples': len(heldout_ids), 'matrix_rows': len(evaluated),
            'approved_codes': sorted(approved), 'positive_samples': len(positives),
            'negative_pairs': len(negatives)}


def evaluate(manifest, output, release_codes=None):
    from PIL import Image, ImageOps

    policy_hash = rules_digest()
    matcher = DocumentTypeMatcher(ROOT / 'contracts/document-type-rules-v2.json')
    approved = resolve_codes(','.join(release_codes) if release_codes is not None else None, matcher.rules)
    data = json.loads(manifest.read_text())
    samples = data['samples']
    if not 1 <= len(samples) <= 500 or len({s['id'] for s in samples}) != len(samples):
        raise ValueError('Expected 1..500 unique sample IDs')
    if output.is_relative_to(ROOT.parent) and not any(output.is_relative_to(allowed)
            for allowed in (ROOT.parent / '.cache', ROOT / 'var', ROOT / '.cache')):
        raise ValueError('Private evaluation output must be under .cache/ or ocr/var/')
    output.mkdir(parents=True, exist_ok=True)
    prepared, rows = [], []
    hashes = set()
    for sample in samples:
        url = urlsplit(sample.get('source_url', ''))
        public_source = (url.scheme == 'https' and url.hostname and not url.username and not url.password)
        supplied_source = (not sample.get('source_url') and isinstance(sample.get('source_id'), str)
                           and re.fullmatch(r'user-provided:[A-Za-z0-9._:-]{1,120}', sample['source_id']))
        if (sample['code'] not in matcher.rules or sample['split'] not in {'tuning', 'heldout'}
                or not isinstance(sample.get('independence_group'), str) or not sample['independence_group']
                or not (public_source or supplied_source)):
            raise ValueError('Invalid sample provenance')
        path = (manifest.parent / sample['path']).resolve()
        if not path.is_file() or path.stat().st_size > 10 * 1024 * 1024:
            raise ValueError('Missing/oversized sample')
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest in hashes:
            raise ValueError('Duplicate image bytes are not independent samples')
        hashes.add(digest)
        prepared.append({**sample, 'sha256': digest})
        started = time.monotonic()
        try:
            with Image.open(path) as source:
                if source.width * source.height > 40_000_000:
                    raise ValueError('Image pixel limit')
                text, angle, pixels = recognize_type_text(ImageOps.exif_transpose(source).convert('RGB'), time.monotonic() + 45, matcher)
            reason = None
        except ReaderError as error:
            text, reason, angle, pixels = '', error.reason, None, None
        # Filename uses a digest rather than an untrusted corpus ID.
        (output / (digest + '.text.json')).write_text(json.dumps({
            'text': text, 'reason': reason, 'model_revision': MANIFEST['revision'],
            'rotation': angle,
            'reading_pixels': pixels,
            'elapsed_ms': round((time.monotonic() - started) * 1000, 2)}, ensure_ascii=False))
        for expected in matcher.rules:
            result = matcher.evaluate_text(text, expected)
            rows.append({'id': sample['id'], 'actual': sample['code'], 'expected': expected,
                         'verdict': result['verdict'], 'detected': result['detected_code'],
                         'reason': reason or result.get('reason'),
                         'matched_phrases': result['matched_phrases']})
    report = {**summarize(prepared, rows, set(matcher.rules), approved),
              'model_revision': MANIFEST['revision'], 'rules_sha256': policy_hash,
              'samples': prepared}
    if rules_digest() != policy_hash:
        report['passed'] = False
        report['problems'].append('POLICY_CHANGED_DURING_EVALUATION')
    (output / 'matrix.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    (output / 'gate.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({key: value for key, value in report.items() if key != 'samples'}))
    return 0 if report['passed'] else 2


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--release-code', action='append', help='Canonical detected type allowed to cause returns; default all types')
    args = parser.parse_args()
    raise SystemExit(evaluate(args.manifest.resolve(), args.output.resolve(), args.release_code))
