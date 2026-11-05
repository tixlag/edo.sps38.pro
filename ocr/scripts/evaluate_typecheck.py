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
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services/uz'))
from recognizeuz.quality.type_matcher import DocumentTypeMatcher
from recognizeuz.quality.xiaomi_text import MANIFEST, ReaderError, recognize_page


def rules_digest(root=ROOT):
    return hashlib.sha256(b'\0'.join((root / name).read_bytes() for name in (
        'contracts/document-type-rules.json', 'contracts/document-type-rules-v2.json',
        'services/uz/recognizeuz/quality/type_matcher.py',
        'services/uz/recognizeuz/quality/xiaomi_type_check.py',
        'scripts/evaluate_typecheck.py',
        'services/typecheck/server.py'))).hexdigest()


def summarize(samples, rows, codes):
    problems = []
    for code in codes:
        labeled = [s for s in samples if s['code'] == code]
        sources = {s['source_url'] for s in labeled}
        heldout = [s for s in labeled if s['split'] == 'heldout']
        heldout_sources = {s['source_url'] for s in heldout}
        tuning_sources = {s['source_url'] for s in labeled if s['split'] == 'tuning'}
        if (len(sources) < 3 or len({s['sha256'] for s in labeled}) < 3
                or len(heldout_sources) < 2 or heldout_sources & tuning_sources):
            problems.append('INSUFFICIENT_INDEPENDENT_SAMPLES:' + code)
    heldout_ids = {s['id'] for s in samples if s['split'] == 'heldout'}
    evaluated = [r for r in rows if r['id'] in heldout_ids]
    positives = [r for r in evaluated if r['expected'] == r['actual']]
    negatives = [r for r in evaluated if r['expected'] != r['actual']]
    false_returns = sum(r['verdict'] == 'MISMATCH' for r in positives)
    positive_rate = sum(r['verdict'] == 'MATCH' for r in positives) / max(1, len(positives))
    negative_rate = sum(r['verdict'] == 'MISMATCH' and r['detected'] == r['actual']
                        for r in negatives) / max(1, len(negatives))
    if false_returns:
        problems.append('FALSE_RETURNS')
    if positive_rate < .95:
        problems.append('POSITIVE_COVERAGE_BELOW_95_PERCENT')
    if negative_rate < .95:
        problems.append('NEGATIVE_COVERAGE_BELOW_95_PERCENT')
    if any(r['verdict'] == 'MISMATCH' and r['detected'] != r['actual'] for r in evaluated):
        problems.append('WRONG_DETECTED_TYPE')
    if len(evaluated) != len(heldout_ids) * len(codes):
        problems.append('INCOMPLETE_MATRIX')
    return {'passed': not problems, 'problems': problems, 'false_returns': false_returns,
            'positive_rate': positive_rate, 'negative_rate': negative_rate,
            'heldout_samples': len(heldout_ids), 'matrix_rows': len(evaluated)}


def evaluate(manifest, output):
    from PIL import Image, ImageOps

    matcher = DocumentTypeMatcher(ROOT / 'contracts/document-type-rules-v2.json')
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
        url = urlsplit(sample['source_url'])
        if (sample['code'] not in matcher.rules or sample['split'] not in {'tuning', 'heldout'}
                or url.scheme != 'https' or not url.hostname or url.username or url.password):
            raise ValueError('Invalid public sample metadata')
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
                text = recognize_page(ImageOps.exif_transpose(source).convert('RGB'), time.monotonic() + 45)
            reason = None
        except ReaderError as error:
            text, reason = '', error.reason
        # Filename uses a digest rather than an untrusted corpus ID.
        (output / (digest + '.text.json')).write_text(json.dumps({
            'text': text, 'reason': reason, 'model_revision': MANIFEST['revision'],
            'elapsed_ms': round((time.monotonic() - started) * 1000, 2)}, ensure_ascii=False))
        for expected in matcher.rules:
            result = matcher.evaluate_text(text, expected)
            rows.append({'id': sample['id'], 'actual': sample['code'], 'expected': expected,
                         'verdict': result['verdict'], 'detected': result['detected_code'],
                         'reason': reason or result.get('reason'),
                         'matched_phrases': result['matched_phrases']})
    report = {**summarize(prepared, rows, set(matcher.rules)),
              'model_revision': MANIFEST['revision'], 'rules_sha256': rules_digest(),
              'samples': prepared}
    (output / 'matrix.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    (output / 'gate.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({key: value for key, value in report.items() if key != 'samples'}))
    return 0 if report['passed'] else 2


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    raise SystemExit(evaluate(args.manifest.resolve(), args.output.resolve()))
