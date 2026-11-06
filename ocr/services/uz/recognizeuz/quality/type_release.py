"""Explicit scope of document types allowed to cause automatic returns."""


def resolve_codes(value, known_codes):
    known = set(known_codes)
    if value is None:
        return known
    parts = [part.strip() for part in value.split(',')]
    if not parts or any(not part or part not in known for part in parts) or len(parts) != len(set(parts)):
        raise ValueError('Invalid DOCUMENT_TYPE_AUTORETURN_CODES; use unique canonical codes')
    return set(parts)
