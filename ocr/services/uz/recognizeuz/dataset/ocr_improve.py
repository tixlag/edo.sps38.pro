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

from recognizeuz.core import resources
from recognizeuz.core.config import *
from recognizeuz.image.geometry import polygon_to_list
from recognizeuz.image.preprocessing import build_ocr_improve_prepared_variants
from recognizeuz.quality.verification import validate_glm_label_for_field
from recognizeuz.text.normalization import normalize_ocr_text_for_match, paddle_and_glm_texts_match
from recognizeuz.utils.files import append_unique_line, safe_filename_part
from recognizeuz.utils.timing import score_to_unit

ocr_improve_dataset_lock = resources.ocr_improve_dataset_lock

def polygon_area(points: np.ndarray) -> float:
    if len(points) < 3:
        return 0.0
    return float(abs(cv2.contourArea(points.astype(np.float32))))

def is_field_geometry_plausible(field: dict[str, Any]) -> tuple[bool, str | None]:
    polygon = field.get("polygon")
    bbox = field.get("bbox")

    if polygon is None or bbox is None:
        return False, "missing_polygon_or_bbox"

    poly = np.asarray(polygon, dtype=np.float32)
    if len(poly) < 3:
        return False, "polygon_too_short"

    x1, y1, x2, y2 = [float(v) for v in bbox]
    bw = max(0.0, x2 - x1)
    bh = max(0.0, y2 - y1)

    if bw < 6 or bh < 4:
        return False, "bbox_too_small"

    aspect = bw / max(bh, 1.0)
    if aspect < 0.25 or aspect > 80.0:
        return False, "bbox_bad_aspect_ratio"

    bbox_area = bw * bh
    area = polygon_area(poly)
    fill_ratio = area / max(bbox_area, 1.0)

    if fill_ratio < 0.12:
        return False, "polygon_fill_ratio_too_low"

    return True, None

def is_prepared_ocr_image_visually_useful(
    image_bgr: np.ndarray | None,
) -> tuple[bool, str | None]:
    if image_bgr is None:
        return False, "missing_prepared_image"

    if image_bgr.size == 0:
        return False, "empty_prepared_image"

    h, w = image_bgr.shape[:2]
    if h < 8 or w < 8:
        return False, "prepared_image_too_small"

    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    std = float(gray.std())
    mean = float(gray.mean())
    dark_ratio = float(np.mean(gray < 245))
    black_ratio = float(np.mean(gray < 20))

    if mean < 15:
        return False, "prepared_image_too_dark"

    if std < 3.0 or dark_ratio < 0.002:
        return False, "prepared_image_looks_blank"

    if black_ratio > 0.70:
        return False, "prepared_image_too_black"

    return True, None

def ocr_improve_sample_reject_reason(
    *,
    doc_type: str,
    doc_confidence: float,
    field: dict[str, Any],
    prepared_image_bgr: np.ndarray | None,
    orientation_confident: bool,
) -> str | None:
    field_name = str(field.get("name", ""))

    if not OCR_IMPROVE_DATASET_ENABLED:
        return "ocr_improve_dataset_disabled"

    if field_name in SKIP_OCR_FIELDS:
        return "skip_ocr_field"

    if doc_type not in OCR_IMPROVE_ALLOWED_DOC_TYPES:
        return "unsupported_doc_type_for_ocr_improve"

    if float(doc_confidence) < OCR_IMPROVE_MIN_DOC_CONF:
        return "doc_confidence_too_low"

    if float(field.get("confidence", 0.0)) < OCR_IMPROVE_MIN_FIELD_CONF:
        return "field_confidence_too_low"

    if OCR_IMPROVE_REQUIRE_CONFIDENT_ORIENTATION and not orientation_confident:
        return "orientation_not_confident"

    geometry_ok, geometry_reason = is_field_geometry_plausible(field)
    if not geometry_ok:
        return geometry_reason

    image_ok, image_reason = is_prepared_ocr_image_visually_useful(prepared_image_bgr)
    if not image_ok:
        return image_reason

    return None

def save_ocr_improve_mismatch_sample(
    *,
    doc_type: str,
    field_name: str,
    field: dict[str, Any],
    prepared_variants: list[dict[str, Any]] | None,
    raw_field_crop_bgr: np.ndarray | None,
    paddle_text: str,
    paddle_score: float,
    glm_text: str | None,
    source_file: str,
    file_index: int,
    page_index: int,
    document_index: int,
    doc_confidence: float,
    orientation_angle: int,
    orientation_score: float,
    orientation_confident: bool,
) -> dict[str, Any]:
    """
    Сохраняет mismatch PaddleOCR vs GLM OCR в OCR-improve датасет.

    На один валидный сегмент сохраняется несколько prepared-картинок:
      - orig: оригинальный crop после preprocess;
      - aug01..aug03: raw crop -> мягкая фото-аугментация -> preprocess.

    Формат:
      <OCR_IMPROVE_DATASET_ROOT>/passport/labels.txt
      <OCR_IMPROVE_DATASET_ROOT>/passport/images/<field>/<hash>_<variant>.png
      <OCR_IMPROVE_DATASET_ROOT>/passport/metadata.jsonl

      <OCR_IMPROVE_DATASET_ROOT>/migration_card/labels.txt
      <OCR_IMPROVE_DATASET_ROOT>/migration_card/images/<field>/<hash>.png
      <OCR_IMPROVE_DATASET_ROOT>/migration_card/metadata.jsonl

    В labels.txt пишется относительный путь и текст GLM OCR:
      images/pas_name/abc_aug01.png\tALI
    """

    base_result: dict[str, Any] = {
        "saved": False,
        "new_image": False,
        "reason": None,
        "label": None,
        "image_path": None,
        "label_path": None,
        "metadata_path": None,
        "saved_count": 0,
        "duplicate_count": 0,
        "skipped_count": 0,
        "saved_variants": [],
        "skipped_variants": [],
    }

    base_prepared_image = None
    if prepared_variants:
        for variant in prepared_variants:
            if variant.get("variant") == "orig":
                base_prepared_image = variant.get("image")
                break
        if base_prepared_image is None:
            base_prepared_image = prepared_variants[0].get("image")

    segment_reject_reason = ocr_improve_sample_reject_reason(
        doc_type=doc_type,
        doc_confidence=doc_confidence,
        field=field,
        prepared_image_bgr=base_prepared_image,
        orientation_confident=orientation_confident,
    )
    if segment_reject_reason is not None:
        base_result["reason"] = segment_reject_reason
        return base_result

    label, label_reject_reason = validate_glm_label_for_field(
        doc_type=doc_type,
        field_name=field_name,
        glm_text=glm_text or "",
    )
    if label_reject_reason is not None or label is None:
        base_result["reason"] = label_reject_reason or "invalid_glm_label"
        return base_result

    if paddle_and_glm_texts_match(paddle_text, label):
        base_result["reason"] = "paddle_and_glm_match"
        base_result["label"] = label
        return base_result

    # Только теперь, после всех дешёвых проверок и подтверждённого mismatch,
    # строим aug01..aug03. Так обычный ocr_improve-запрос не тратит CPU на
    # аугментации для сегментов, которые не попадут в датасет.
    if raw_field_crop_bgr is not None:
        prepared_variants = build_ocr_improve_prepared_variants(
            raw_field_crop_bgr,
            include_augmentations=True,
            prepared_orig_bgr=base_prepared_image,
        )

    if not prepared_variants:
        base_result["reason"] = "missing_prepared_variants"
        return base_result

    label_norm = normalize_ocr_text_for_match(label)
    paddle_norm = normalize_ocr_text_for_match(paddle_text)

    dataset_dir = OCR_IMPROVE_DATASET_ROOT / safe_filename_part(doc_type)
    labels_path = dataset_dir / "labels.txt"
    field_labels_path = dataset_dir / "fields" / safe_filename_part(field_name) / "labels.txt"
    metadata_path = dataset_dir / "metadata.jsonl"

    saved_count = 0
    duplicate_count = 0
    skipped_variants: list[dict[str, str]] = []
    saved_variants: list[dict[str, Any]] = []

    with ocr_improve_dataset_lock:
        labels_path.parent.mkdir(parents=True, exist_ok=True)
        field_labels_path.parent.mkdir(parents=True, exist_ok=True)
        metadata_path.parent.mkdir(parents=True, exist_ok=True)

        for variant in prepared_variants:
            variant_name = safe_filename_part(str(variant.get("variant", "variant")), max_len=32)
            prepared_image = variant.get("image")

            image_ok, image_reason = is_prepared_ocr_image_visually_useful(prepared_image)
            if not image_ok:
                skipped_variants.append(
                    {
                        "variant": variant_name,
                        "reason": image_reason or "invalid_prepared_image",
                    }
                )
                continue

            ok, encoded = cv2.imencode(".png", prepared_image)
            if not ok:
                skipped_variants.append(
                    {
                        "variant": variant_name,
                        "reason": "failed_to_encode_prepared_image",
                    }
                )
                continue

            digest = hashlib.sha1(
                encoded.tobytes()
                + b"\0"
                + doc_type.encode("utf-8")
                + b"\0"
                + field_name.encode("utf-8")
                + b"\0"
                + variant_name.encode("utf-8")
                + b"\0"
                + label_norm.encode("utf-8")
            ).hexdigest()[:24]

            image_rel_path = (
                Path("images")
                / safe_filename_part(field_name)
                / f"{digest}_{variant_name}.png"
            )
            image_path = dataset_dir / image_rel_path
            label_line = f"{image_rel_path.as_posix()}\t{label}\n"

            image_path.parent.mkdir(parents=True, exist_ok=True)
            is_new_image = not image_path.exists()

            if is_new_image:
                cv2.imwrite(str(image_path), prepared_image)
                append_unique_line(labels_path, label_line)
                append_unique_line(field_labels_path, label_line)

                metadata = {
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "mode": "ocr_improve",
                    "doc_type": doc_type,
                    "field_name": field_name,
                    "variant": variant_name,
                    "label": label,
                    "paddle_text": paddle_text,
                    "glm_text": glm_text,
                    "paddle_score": score_to_unit(float(paddle_score)),
                    "paddle_norm": paddle_norm,
                    "glm_norm": label_norm,
                    "source_file": source_file,
                    "file_index": file_index,
                    "page_index": page_index,
                    "document_index": document_index,
                    "doc_confidence": float(doc_confidence),
                    "field_confidence": float(field.get("confidence", 0.0)),
                    "orientation_angle": int(orientation_angle),
                    "orientation_score": float(orientation_score),
                    "orientation_confident": bool(orientation_confident),
                    "polygon_document": polygon_to_list(field["polygon"]),
                    "bbox_document": field["bbox"],
                    "raw_shape": variant.get("raw_shape"),
                    "prepared_shape": variant.get("prepared_shape"),
                    "image_path": str(image_path),
                    "label_path": str(labels_path),
                    "field_label_path": str(field_labels_path),
                }

                with metadata_path.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(metadata, ensure_ascii=False) + "\n")

                saved_count += 1
            else:
                duplicate_count += 1
                append_unique_line(labels_path, label_line)
                append_unique_line(field_labels_path, label_line)

            saved_variants.append(
                {
                    "variant": variant_name,
                    "new_image": is_new_image,
                    "image_path": str(image_path),
                }
            )

    if not saved_variants:
        base_result.update(
            {
                "reason": "no_valid_prepared_variants",
                "label": label,
                "skipped_count": len(skipped_variants),
                "skipped_variants": skipped_variants,
            }
        )
        return base_result

    base_result.update(
        {
            "saved": True,
            "new_image": saved_count > 0,
            "reason": (
                f"saved_{saved_count}_variants"
                if saved_count > 0
                else "duplicate_variants_already_exist"
            ),
            "label": label,
            "image_path": saved_variants[0]["image_path"],
            "label_path": str(labels_path),
            "field_label_path": str(field_labels_path),
            "metadata_path": str(metadata_path),
            "saved_count": saved_count,
            "duplicate_count": duplicate_count,
            "skipped_count": len(skipped_variants),
            "saved_variants": saved_variants,
            "skipped_variants": skipped_variants,
        }
    )
    return base_result
