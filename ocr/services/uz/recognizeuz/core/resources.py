from __future__ import annotations

import os
from dataclasses import dataclass, field
from threading import Lock
from typing import Any

from ultralytics import YOLO

from recognizeuz.core.config import (
    DEVICE,
    DOC_MODEL_PATH,
    MIGRATION_DICT_PATH,
    MIGRATION_FIELDS_MODEL_PATH,
    MIGRATION_OCR_MODEL_DIR,
    PASSPORT_DICT_PATH,
    PASSPORT_FIELDS_MODEL_PATH,
    PASSPORT_OCR_MODEL_DIR,
    USE_GPU,
)
from recognizeuz.core.paddle_args import TextRecognizer, make_rec_args

infer_lock = Lock()
ocr_improve_dataset_lock = Lock()

# Backward-compatible globals. New code should prefer model_registry.
doc_model: YOLO | None = None
passport_fields_model: YOLO | None = None
migration_fields_model: YOLO | None = None
passport_ocr: TextRecognizer | None = None
migration_ocr: TextRecognizer | None = None


@dataclass(slots=True)
class ModelRegistry:
    """Central model holder keyed by logical names from DocumentSpec."""

    yolo: dict[str, YOLO] = field(default_factory=dict)
    recognizers: dict[str, TextRecognizer] = field(default_factory=dict)
    extra: dict[str, Any] = field(default_factory=dict)

    def get_yolo(self, key: str) -> YOLO:
        try:
            return self.yolo[key]
        except KeyError as exc:
            raise RuntimeError(f"YOLO model is not loaded: {key}") from exc

    def get_recognizer(self, key: str) -> TextRecognizer:
        try:
            return self.recognizers[key]
        except KeyError as exc:
            raise RuntimeError(f"Paddle recognizer is not loaded: {key}") from exc

    def get_optional(self, key: str) -> Any | None:
        if key in self.yolo:
            return self.yolo[key]
        if key in self.recognizers:
            return self.recognizers[key]
        return self.extra.get(key)

    def status(self) -> dict[str, bool]:
        status: dict[str, bool] = {}
        for key in ("doc_type", "passport_fields", "migration_fields"):
            status[key] = key in self.yolo
        for key in ("passport_ocr", "migration_ocr"):
            status[key] = key in self.recognizers
        for key, value in self.extra.items():
            status[key] = value is not None
        return status

    def clear(self) -> None:
        self.yolo.clear()
        self.recognizers.clear()
        self.extra.clear()


model_registry = ModelRegistry()


def get_models_status() -> dict[str, bool]:
    # Keep old response keys stable, add logical keys for the new architecture.
    return {
        "doc_model": doc_model is not None,
        "passport_fields_model": passport_fields_model is not None,
        "migration_fields_model": migration_fields_model is not None,
        "passport_ocr": passport_ocr is not None,
        "migration_ocr": migration_ocr is not None,
        "registry": model_registry.status(),
    }


def cleanup_models() -> None:
    global doc_model
    global passport_fields_model
    global migration_fields_model
    global passport_ocr
    global migration_ocr

    doc_model = None
    passport_fields_model = None
    migration_fields_model = None
    passport_ocr = None
    migration_ocr = None
    model_registry.clear()


def load_models() -> None:
    global doc_model
    global passport_fields_model
    global migration_fields_model
    global passport_ocr
    global migration_ocr

    os.environ.setdefault("CUDA_VISIBLE_DEVICES", str(DEVICE))

    doc_model = YOLO(str(DOC_MODEL_PATH))
    passport_fields_model = YOLO(str(PASSPORT_FIELDS_MODEL_PATH))
    migration_fields_model = YOLO(str(MIGRATION_FIELDS_MODEL_PATH))

    passport_ocr = TextRecognizer(
        make_rec_args(
            rec_model_dir=PASSPORT_OCR_MODEL_DIR,
            rec_char_dict_path=PASSPORT_DICT_PATH,
        )
    )

    migration_ocr = TextRecognizer(
        make_rec_args(
            rec_model_dir=MIGRATION_OCR_MODEL_DIR,
            rec_char_dict_path=MIGRATION_DICT_PATH,
        )
    )

    model_registry.clear()
    model_registry.yolo["doc_type"] = doc_model
    model_registry.yolo["passport_fields"] = passport_fields_model
    model_registry.yolo["migration_fields"] = migration_fields_model
    model_registry.recognizers["passport_ocr"] = passport_ocr
    model_registry.recognizers["migration_ocr"] = migration_ocr

    # Future hook: a migration FIO glyph detector can be registered here as
    # model_registry.extra["migration_fio_glyph_detector"] or yolo/paddle entry.
