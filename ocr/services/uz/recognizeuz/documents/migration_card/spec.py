from __future__ import annotations

from recognizeuz.core.config import MIGRATION_FIO_GRID_STAGE_MODE
from recognizeuz.documents.base import DocumentSpec, IntermediateStageSpec, ModelRef
from recognizeuz.documents.fields import FIELD_LABELS
from recognizeuz.documents.migration_card.constants import FIELD_NAMES, FIO_FIELDS, INTERNAL_ONLY_FIELDS, OUTPUT_FIELDS, SKIP_OCR_FIELDS
from recognizeuz.documents.migration_card.layout import is_migration_orientation_confident, score_migration_layout

# Rule-based stage: no training required. It cuts detected FIO row crops into
# grid/cell glyphs and recognizes them in batch with the migration PaddleOCR
# recognizer. Set MIGRATION_FIO_GRID_STAGE_MODE=disabled to turn it off.
MIGRATION_FIO_GRID_STAGE = IntermediateStageSpec(
    key="migration_fio_grid_letters",
    model=ModelRef("rule_based_grid_cell_detector", "custom", required=False),
    applies_to_fields=FIO_FIELDS,
    scope="field",
    mode=MIGRATION_FIO_GRID_STAGE_MODE,  # disabled/debug_only/candidate/replace
    description=(
        "Migration-card FIO refinement: detect cells inside "
        "mg_surname/mg_name/mg_patronymic rows, OCR each glyph separately, "
        "then join glyphs into the final word."
    ),
)

MIGRATION_CARD_SPEC = DocumentSpec(
    doc_type="migration_card",
    field_names=FIELD_NAMES,
    output_fields=OUTPUT_FIELDS,
    field_detector=ModelRef("migration_fields", "yolo"),
    text_recognizer=ModelRef("migration_ocr", "paddle_recognizer"),
    score_layout=score_migration_layout,
    is_orientation_confident=is_migration_orientation_confident,
    skip_ocr_fields=SKIP_OCR_FIELDS,
    internal_only_fields=INTERNAL_ONLY_FIELDS,
    field_labels=FIELD_LABELS,
    intermediate_stages=(MIGRATION_FIO_GRID_STAGE,),
)
