from __future__ import annotations

from recognizeuz.documents.base import DocumentSpec, ModelRef
from recognizeuz.documents.fields import FIELD_LABELS
from recognizeuz.documents.passport.constants import FIELD_NAMES, INTERNAL_ONLY_FIELDS, OUTPUT_FIELDS, SKIP_OCR_FIELDS
from recognizeuz.documents.passport.layout import is_passport_orientation_confident, score_passport_layout
from recognizeuz.text.transliteration import transliterate_uz_latin_to_russian_migration_cyrillic


def _to_cyrillic(*, field_name: str, text: str) -> str:
    return transliterate_uz_latin_to_russian_migration_cyrillic(
        text,
        field_name=field_name,
    )


PASSPORT_SPEC = DocumentSpec(
    doc_type="passport",
    field_names=FIELD_NAMES,
    output_fields=OUTPUT_FIELDS,
    field_detector=ModelRef("passport_fields", "yolo"),
    text_recognizer=ModelRef("passport_ocr", "paddle_recognizer"),
    score_layout=score_passport_layout,
    is_orientation_confident=is_passport_orientation_confident,
    skip_ocr_fields=SKIP_OCR_FIELDS,
    internal_only_fields=INTERNAL_ONLY_FIELDS,
    field_labels=FIELD_LABELS,
    add_cyrillic_output=True,
    cyrillic_converter=_to_cyrillic,
)
