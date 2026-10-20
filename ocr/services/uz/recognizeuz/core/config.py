from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[4]
MODELS_ROOT = Path(os.getenv("MODELS_ROOT", str(PROJECT_ROOT / "models"))).expanduser().resolve()
PADDLEOCR_ROOT = Path(os.getenv("PADDLEOCR_ROOT", str(PROJECT_ROOT / "vendor/PaddleOCR"))).expanduser().resolve()


def model_path(name: str, default: str) -> Path:
    return Path(os.getenv(name, str(MODELS_ROOT / default))).expanduser().resolve()


DOC_MODEL_PATH = model_path("DOC_MODEL_PATH", "uz/doc_detector.pt")
PASSPORT_FIELDS_MODEL_PATH = model_path("PASSPORT_FIELDS_MODEL_PATH", "uz/passport_fields.pt")
MIGRATION_FIELDS_MODEL_PATH = model_path("MIGRATION_FIELDS_MODEL_PATH", "uz/migration_fields.pt")
PASSPORT_OCR_MODEL_DIR = model_path("PASSPORT_OCR_MODEL_DIR", "uz/passport_ocr")
MIGRATION_OCR_MODEL_DIR = model_path("MIGRATION_OCR_MODEL_DIR", "uz/migration_ocr")
PASSPORT_DICT_PATH = model_path("PASSPORT_DICT_PATH", "uz/passport_ocr/dict.txt")
MIGRATION_DICT_PATH = model_path("MIGRATION_DICT_PATH", "uz/migration_ocr/dict.txt")
DEVICE = int(os.getenv("DEVICE", "0"))
USE_GPU = os.getenv("USE_GPU", "1").lower() not in {"0", "false", "no", "off"}

DOC_IMGSZ = 1280

FIELDS_IMGSZ = 1280

DOC_CONF = 0.1

FIELD_CONF = 0.25

ASSUME_PASSPORT_WHEN_DOCUMENTS_EMPTY = (
    os.getenv("ASSUME_PASSPORT_WHEN_DOCUMENTS_EMPTY", "1").lower()
    not in {"0", "false", "no", "off"}
)

PDF_DPI = 220

OCR_TARGET_HEIGHT = 48

OCR_MIN_WIDTH = 32

OCR_MAX_WIDTH = 768

OCR_PAD_X = 4

OCR_PAD_Y = 4

INTERNAL_ONLY_FIELDS = {
    "pas_mrz",
}

SKIP_OCR_FIELDS = {
    "pas_photo",
    *INTERNAL_ONLY_FIELDS,
}

GLM_FIELD_FALLBACK_THRESHOLD = float(
    os.getenv("GLM_FIELD_FALLBACK_THRESHOLD", "0.90")
)

GLM_FULL_DOC_AVG_THRESHOLD = float(
    os.getenv("GLM_FULL_DOC_AVG_THRESHOLD", "0.85")
)

OCR_VERIFY_ENABLED = (
    os.getenv("OCR_VERIFY_ENABLED", "1").lower()
    not in {"0", "false", "no", "off"}
)

OCR_SAFE_REPAIR_ENABLED = (
    os.getenv("OCR_SAFE_REPAIR_ENABLED", "1").lower()
    not in {"0", "false", "no", "off"}
)

OCR_TTA_ENABLED = (
    os.getenv("OCR_TTA_ENABLED", "1").lower()
    not in {"0", "false", "no", "off"}
)

OCR_TTA_MAX_VARIANTS = int(os.getenv("OCR_TTA_MAX_VARIANTS", "4"))

OCR_TTA_MIN_MAJORITY = int(os.getenv("OCR_TTA_MIN_MAJORITY", "2"))

OCR_GLM_ON_QUALITY_FLAGS = (
    os.getenv("OCR_GLM_ON_QUALITY_FLAGS", "1").lower()
    not in {"0", "false", "no", "off"}
)

OCR_ACCEPT_GLM_ONLY_IF_VALID = (
    os.getenv("OCR_ACCEPT_GLM_ONLY_IF_VALID", "1").lower()
    not in {"0", "false", "no", "off"}
)

OCR_SAFE_REPAIR_PERSON_TRIPLE = (
    os.getenv("OCR_SAFE_REPAIR_PERSON_TRIPLE", "0").lower()
    not in {"0", "false", "no", "off"}
)

OCR_SAFE_REPAIR_DICTIONARY_TOKENS = (
    os.getenv("OCR_SAFE_REPAIR_DICTIONARY_TOKENS", "1").lower()
    not in {"0", "false", "no", "off"}
)

OCR_SAFE_REPAIR_DICTIONARY_NEAREST = (
    os.getenv("OCR_SAFE_REPAIR_DICTIONARY_NEAREST", "1").lower()
    not in {"0", "false", "no", "off"}
)

OCR_DICTIONARY_NEAREST_MAX_DISTANCE = int(
    os.getenv("OCR_DICTIONARY_NEAREST_MAX_DISTANCE", "2")
)

LOW_CONF_AGREEMENT_DATASET_ENABLED = (
    os.getenv("LOW_CONF_AGREEMENT_DATASET_ENABLED", "1").lower()
    not in {"0", "false", "no", "off"}
)

LOW_CONF_AGREEMENT_DATASET_DIR = Path(
    os.getenv(
        "LOW_CONF_AGREEMENT_DATASET_DIR",
        str(PROJECT_ROOT / "var/uz/datasets/paddle_low_conf_glm_agree"),
    )
)

LOW_CONF_AGREEMENT_SCORE_THRESHOLD = float(
    os.getenv(
        "LOW_CONF_AGREEMENT_SCORE_THRESHOLD",
        str(GLM_FIELD_FALLBACK_THRESHOLD),
    )
)

OCR_IMPROVE_DATASET_ENABLED = (
    os.getenv("OCR_IMPROVE_DATASET_ENABLED", "1").lower()
    not in {"0", "false", "no", "off"}
)

OCR_IMPROVE_DATASET_ROOT = Path(
    os.getenv(
        "OCR_IMPROVE_DATASET_ROOT",
        str(PROJECT_ROOT / "var/uz/datasets/ocr_improve"),
    )
)

OCR_IMPROVE_MIN_DOC_CONF = float(
    os.getenv("OCR_IMPROVE_MIN_DOC_CONF", "0.50")
)

OCR_IMPROVE_MIN_FIELD_CONF = float(
    os.getenv("OCR_IMPROVE_MIN_FIELD_CONF", "0.50")
)

OCR_IMPROVE_REQUIRE_CONFIDENT_ORIENTATION = (
    os.getenv("OCR_IMPROVE_REQUIRE_CONFIDENT_ORIENTATION", "1").lower()
    not in {"0", "false", "no", "off"}
)

OCR_IMPROVE_MAX_LABEL_LEN = int(
    os.getenv("OCR_IMPROVE_MAX_LABEL_LEN", "128")
)

OCR_IMPROVE_ALLOWED_DOC_TYPES = {"passport", "migration_card"}

ALLOWED_DOC_TYPES = {"passport", "migration_card"}

OCR_IMPROVE_AUGMENTATIONS_PER_SEGMENT = int(
    os.getenv("OCR_IMPROVE_AUGMENTATIONS_PER_SEGMENT", "3")
)

GLM_OCR_URL = os.getenv(
    "GLM_OCR_URL",
    "http://127.0.0.1:8083/v1/chat/completions",
)

GLM_OCR_MODEL = os.getenv(
    "GLM_OCR_MODEL",
    "zai-org/GLM-OCR",
)

GLM_OCR_TIMEOUT_SEC = float(
    os.getenv("GLM_OCR_TIMEOUT_SEC", "12")
)


# ---------------------------------------------------------------------
# DEBUG SEGMENT DUMP
# ---------------------------------------------------------------------
# Enabled per request with GET/form/body flag save_segments=true.
# Saves every important image that was passed between pipeline stages:
# page image, document crops, orientation candidates, field crops,
# prepared OCR inputs, GLM inputs and optional glyph crops.
SEGMENT_DUMP_ROOT = Path(
    os.getenv(
        "SEGMENT_DUMP_ROOT",
        str(PROJECT_ROOT / "var/uz/segment_dumps"),
    )
)

# ---------------------------------------------------------------------
# MIGRATION CARD FIO GRID OCR
# ---------------------------------------------------------------------
# Migration-card FIO fields are usually filled inside cells. This stage cuts
# a detected FIO row into cell/glyph crops and recognizes them in batch.
# Modes:
#   disabled  - do not run the stage;
#   debug_only - run only when debug=true or save_segments=true, do not replace;
#   candidate - run and return candidate in debug, do not replace;
#   replace   - replace field text when the cell result is plausible.
MIGRATION_FIO_GRID_STAGE_MODE = os.getenv(
    "MIGRATION_FIO_GRID_STAGE_MODE",
    "replace",
).lower()

MIGRATION_FIO_GRID_MIN_CELLS = int(
    os.getenv("MIGRATION_FIO_GRID_MIN_CELLS", "2")
)

MIGRATION_FIO_GRID_MIN_AVG_SCORE = float(
    os.getenv("MIGRATION_FIO_GRID_MIN_AVG_SCORE", "0.45")
)

MIGRATION_FIO_GRID_CELL_OVERLAP_RATIO = float(
    os.getenv("MIGRATION_FIO_GRID_CELL_OVERLAP_RATIO", "0.10")
)

MIGRATION_FIO_GRID_ERASE_LINES = (
    os.getenv("MIGRATION_FIO_GRID_ERASE_LINES", "0").lower()
    not in {"0", "false", "no", "off"}
)

MIGRATION_FIO_GRID_GLM_FALLBACK_ENABLED = (
    os.getenv("MIGRATION_FIO_GRID_GLM_FALLBACK_ENABLED", "0").lower()
    not in {"0", "false", "no", "off"}
)

MIGRATION_FIO_GRID_GLM_SCORE_THRESHOLD = float(
    os.getenv("MIGRATION_FIO_GRID_GLM_SCORE_THRESHOLD", "0.35")
)

DOC_ALIASES = {
    "passport": "passport",
    "1_passport_uz": "passport",
    "migration_card": "migration_card",
    "27_migration_card": "migration_card",
}

PASSPORT_FIELD_NAMES = {
    "pas_number",
    "pas_surname",
    "pas_name",
    "pas_patronymic",
    "pas_nationality",
    "pas_date_of_birth",
    "pas_sex",
    "pas_place_of_birth",
    "pas_date_of_issue",
    "pas_date_of_expiry",
    "pas_authority",
    "pas_photo",
    "pas_mrz",
}

MIGRATION_FIELD_NAMES = {
    "mg_series",
    "mg_number",
    "mg_surname",
    "mg_surname_lat",
    "mg_name",
    "mg_patronymic",
    "mg_date_of_birth",
    "mg_nationality",
    "mg_passport_number",
    "mg_visa_number",
    "mg_duration_from",
    "mg_duration_to",
}


# ---------------------------------------------------------------------
# Backward-compatible aliases for document constants.
# New code should read these from DocumentSpec/documents/*/constants.py.
# ---------------------------------------------------------------------
from recognizeuz.documents.migration_card.constants import FIELD_NAMES as _MIGRATION_FIELD_NAMES
from recognizeuz.documents.passport.constants import FIELD_NAMES as _PASSPORT_FIELD_NAMES
from recognizeuz.documents.passport.constants import INTERNAL_ONLY_FIELDS as _PASSPORT_INTERNAL_ONLY_FIELDS
from recognizeuz.documents.passport.constants import SKIP_OCR_FIELDS as _PASSPORT_SKIP_OCR_FIELDS

PASSPORT_FIELD_NAMES = set(_PASSPORT_FIELD_NAMES)
MIGRATION_FIELD_NAMES = set(_MIGRATION_FIELD_NAMES)
INTERNAL_ONLY_FIELDS = set(_PASSPORT_INTERNAL_ONLY_FIELDS)
SKIP_OCR_FIELDS = set(_PASSPORT_SKIP_OCR_FIELDS)
