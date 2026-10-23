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
from recognizeuz.core.paddle_args import TextRecognizer
from recognizeuz.documents.registry import get_document_spec
from recognizeuz.image.preprocessing import prepare_ocr_image_array
from recognizeuz.utils.timing import elapsed_seconds, score_to_unit

def parse_text_recognition_result(raw: Any) -> tuple[str, float]:
    """
    PaddleOCR 3.x TextRecognition.predict() обычно возвращает list[Result].

    У Result может быть:
      result.json
      result.to_dict()
      dict-like структура

    Искомые поля:
      rec_text
      rec_score
    """

    if raw is None:
        return "", 0.0

    if isinstance(raw, list) and not raw:
        return "", 0.0

    item = raw[0] if isinstance(raw, list) else raw

    candidates = []

    if hasattr(item, "json"):
        candidates.append(item.json)

    if hasattr(item, "to_dict"):
        try:
            candidates.append(item.to_dict())
        except Exception:
            pass

    if isinstance(item, dict):
        candidates.append(item)

    if hasattr(item, "__dict__"):
        candidates.append(item.__dict__)

    def find_rec(obj: Any) -> tuple[str, float] | None:
        if isinstance(obj, dict):
            if "rec_text" in obj:
                text = obj.get("rec_text", "")
                score = obj.get("rec_score", 0.0)
                return str(text), float(score)

            if "res" in obj:
                found = find_rec(obj["res"])
                if found is not None:
                    return found

            for value in obj.values():
                found = find_rec(value)
                if found is not None:
                    return found

        elif isinstance(obj, (list, tuple)):
            # fallback для старого формата: ["TEXT", 0.99]
            if (
                len(obj) >= 2
                and isinstance(obj[0], str)
                and isinstance(obj[1], (float, int))
            ):
                return str(obj[0]), float(obj[1])

            for value in obj:
                found = find_rec(value)
                if found is not None:
                    return found

        return None

    for candidate in candidates:
        found = find_rec(candidate)
        if found is not None:
            return found

    return "", 0.0

def get_text_recognizer_for_doc_type(doc_type: str) -> TextRecognizer:
    spec = get_document_spec(doc_type)
    return resources.model_registry.get_recognizer(spec.text_recognizer.key)

def recognize_prepared_image_with_paddle(
    doc_type: str,
    prepared_image_bgr: np.ndarray,
) -> tuple[str, float]:
    ocr = get_text_recognizer_for_doc_type(doc_type)
    result, _ = ocr([prepared_image_bgr])

    if not result:
        return "", 0.0

    text, score = result[0]

    return str(text), score_to_unit(float(score))


def recognize_prepared_images_with_paddle(
    doc_type: str,
    prepared_images_bgr: list[np.ndarray],
) -> list[tuple[str, float]]:
    """Batch variant used by glyph/cell stages to avoid one Paddle call per letter."""

    if not prepared_images_bgr:
        return []

    ocr = get_text_recognizer_for_doc_type(doc_type)
    result, _ = ocr(prepared_images_bgr)

    output: list[tuple[str, float]] = []
    for item in result or []:
        if isinstance(item, (list, tuple)) and len(item) >= 2:
            output.append((str(item[0]), score_to_unit(float(item[1]))))
        else:
            text, score = parse_text_recognition_result(item)
            output.append((str(text), score_to_unit(float(score))))

    # Preserve 1:1 shape even if a backend returns fewer items.
    while len(output) < len(prepared_images_bgr):
        output.append(("", 0.0))

    return output[:len(prepared_images_bgr)]

def recognize_field_text(
    doc_type: str,
    field_name: str,
    field_crop_bgr: np.ndarray,
    prepared_image_bgr: np.ndarray | None = None,
) -> tuple[str, float, dict[str, float], np.ndarray | None]:
    timings = {
        "ocr_preprocess_seconds": 0.0,
        "paddle_seconds": 0.0,
    }

    spec = get_document_spec(doc_type)
    if spec.should_skip_ocr(field_name):
        return "", 0.0, timings, None

    if prepared_image_bgr is None:
        preprocess_started = time.perf_counter()
        prepared = prepare_ocr_image_array(field_crop_bgr)
        timings["ocr_preprocess_seconds"] = elapsed_seconds(preprocess_started)
    else:
        # В ocr_improve prepared-варианты уже собраны заранее:
        # raw crop -> augmentations -> prepare_ocr_image_array().
        # PaddleOCR должен читать именно первую prepared-версию: orig.
        prepared = prepared_image_bgr
        timings["ocr_preprocess_seconds"] = 0.0

    paddle_started = time.perf_counter()
    text, score = recognize_prepared_image_with_paddle(doc_type, prepared)
    timings["paddle_seconds"] = elapsed_seconds(paddle_started)

    return str(text), score_to_unit(float(score)), timings, prepared
