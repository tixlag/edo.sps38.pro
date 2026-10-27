"""Filesystem configuration; recognition behavior remains in the legacy service."""
import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
MODELS_ROOT = Path(os.getenv("MODELS_ROOT", str(PROJECT_ROOT / "models"))).expanduser().resolve()
RU_DOC_MODEL_PATH = Path(os.getenv("RU_DOC_MODEL_PATH", str(MODELS_ROOT / "ru/passport_fields.pt"))).expanduser().resolve()
RU_MULTILINE_MODEL_PATH = Path(os.getenv("RU_MULTILINE_MODEL_PATH", str(MODELS_ROOT / "ru/multiline.pt"))).expanduser().resolve()
RU_OCR_MODEL_DIR = Path(os.getenv("RU_OCR_MODEL_DIR", str(MODELS_ROOT / "ru/passport_ocr"))).expanduser().resolve()
RU_LOG_DIR = Path(os.getenv("RU_LOG_DIR", str(PROJECT_ROOT / "var/ru/logs"))).expanduser().resolve()
RU_DEBUG_DIR = Path(os.getenv("RU_DEBUG_DIR", str(PROJECT_ROOT / "var/ru/debug"))).expanduser().resolve()
