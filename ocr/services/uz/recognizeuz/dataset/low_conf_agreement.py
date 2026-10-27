from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import tempfile
import time
import unicodedata
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

import cv2
import numpy as np
import requests
from PIL import Image, ImageEnhance, ImageFilter, ImageOps

from recognizeuz.core.config import LOW_CONF_AGREEMENT_DATASET_DIR, LOW_CONF_AGREEMENT_DATASET_ENABLED, LOW_CONF_AGREEMENT_SCORE_THRESHOLD
from recognizeuz.ocr.glm import clean_glm_text
from recognizeuz.text.normalization import normalize_ocr_text_for_match, paddle_and_glm_texts_match
from recognizeuz.utils.files import append_unique_line, safe_filename_part
from recognizeuz.utils.timing import score_to_unit

def save_low_conf_agreement_sample(
    *,
    doc_type: str,
    field_name: str,
    field_crop_bgr: np.ndarray,
    paddle_text: str,
    paddle_score: float,
    glm_text: str,
    source_file: str,
    file_index: int,
    page_index: int,
    document_index: int,
) -> dict[str, Any] | None:
    """
    Сохраняет crop в PaddleOCR-rec датасет, если:
    - PaddleOCR score ниже порога;
    - GLM OCR прочитал то же значение;
    - текст не пустой.

    Формат:
      <dataset>/<doc_type>/<field_name>/images/<hash>.png
      <dataset>/<doc_type>/<field_name>/labels.txt
      <dataset>/metadata.jsonl
    """

    if not LOW_CONF_AGREEMENT_DATASET_ENABLED:
        return None

    paddle_score = score_to_unit(float(paddle_score))

    if paddle_score >= LOW_CONF_AGREEMENT_SCORE_THRESHOLD:
        return None

    if not paddle_and_glm_texts_match(paddle_text, glm_text):
        return None

    label = clean_glm_text(glm_text) or clean_glm_text(paddle_text)
    if not label:
        return None

    ok, encoded = cv2.imencode(".png", field_crop_bgr)
    if not ok:
        return None

    label_norm = normalize_ocr_text_for_match(label)
    digest = hashlib.sha1(
        encoded.tobytes()
        + b"\0"
        + field_name.encode("utf-8")
        + b"\0"
        + label_norm.encode("utf-8")
    ).hexdigest()[:24]

    field_dir = (
        LOW_CONF_AGREEMENT_DATASET_DIR
        / safe_filename_part(doc_type)
        / safe_filename_part(field_name)
    )
    image_dir = field_dir / "images"
    image_dir.mkdir(parents=True, exist_ok=True)

    image_path = image_dir / f"{digest}.png"
    is_new_image = not image_path.exists()

    if is_new_image:
        cv2.imwrite(str(image_path), field_crop_bgr)

    rel_image_path = image_path.relative_to(LOW_CONF_AGREEMENT_DATASET_DIR).as_posix()

    # Общий labels.txt удобен как готовый rec_gt_train.txt для PaddleOCR,
    # а labels.txt внутри поля — для быстрой ручной проверки по конкретному полю.
    root_labels_path = LOW_CONF_AGREEMENT_DATASET_DIR / "labels.txt"
    labels_path = field_dir / "labels.txt"

    label_line = f"{rel_image_path}\t{label}\n"

    append_unique_line(root_labels_path, label_line)
    append_unique_line(labels_path, label_line)

    metadata = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "doc_type": doc_type,
        "field_name": field_name,
        "label": label,
        "paddle_text": paddle_text,
        "glm_text": glm_text,
        "paddle_score": paddle_score,
        "threshold": LOW_CONF_AGREEMENT_SCORE_THRESHOLD,
        "source_file": source_file,
        "file_index": file_index,
        "page_index": page_index,
        "document_index": document_index,
        "image_path": str(image_path),
        "root_label_path": str(root_labels_path),
        "field_label_path": str(labels_path),
    }

    metadata_path = LOW_CONF_AGREEMENT_DATASET_DIR / "metadata.jsonl"

    if is_new_image:
        metadata_path.parent.mkdir(parents=True, exist_ok=True)
        with metadata_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(metadata, ensure_ascii=False) + "\n")

    return {
        "saved": True,
        "new_image": is_new_image,
        "image_path": str(image_path),
        "root_label_path": str(root_labels_path),
        "field_label_path": str(labels_path),
        "label": label,
    }
