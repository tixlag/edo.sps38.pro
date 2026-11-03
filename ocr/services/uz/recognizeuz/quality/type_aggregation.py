"""Aggregate page decisions only after validating complete page coverage."""
from __future__ import annotations


def aggregate_type_pages(pages: list[dict], expected_code: str,
                         expected_pages: set[tuple[int, int]]) -> dict:
    uncertain = {'verdict': 'UNCERTAIN', 'detected_code': None}
    keys = [(page.get('file_index'), page.get('page_number')) for page in pages]
    if not expected_pages or len(keys) != len(set(keys)) or set(keys) != expected_pages:
        return uncertain
    if any(page.get('verdict') == 'MATCH' and page.get('detected_code') != expected_code
           for page in pages):
        return uncertain
    if any(page.get('verdict') == 'MATCH' for page in pages):
        return {'verdict': 'MATCH', 'detected_code': expected_code}
    if any(page.get('verdict') != 'MISMATCH' or not page.get('detected_code')
           or page.get('detected_code') == expected_code for page in pages):
        return uncertain
    codes = {page['detected_code'] for page in pages}
    if len(codes) != 1:
        return uncertain
    return {'verdict': 'MISMATCH', 'detected_code': next(iter(codes))}
