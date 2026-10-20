from __future__ import annotations

from recognizeuz.documents.base import DocumentSpec
from recognizeuz.documents.migration_card.spec import MIGRATION_CARD_SPEC
from recognizeuz.documents.passport.spec import PASSPORT_SPEC

_DOCUMENT_SPECS: dict[str, DocumentSpec] = {
    PASSPORT_SPEC.doc_type: PASSPORT_SPEC,
    MIGRATION_CARD_SPEC.doc_type: MIGRATION_CARD_SPEC,
}


def get_document_spec(doc_type: str) -> DocumentSpec:
    try:
        return _DOCUMENT_SPECS[doc_type]
    except KeyError as exc:
        raise ValueError(f"Unsupported document type: {doc_type}") from exc


def maybe_get_document_spec(doc_type: str) -> DocumentSpec | None:
    return _DOCUMENT_SPECS.get(doc_type)
