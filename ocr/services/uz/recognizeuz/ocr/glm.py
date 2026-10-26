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

from recognizeuz.core.config import GLM_OCR_MODEL, GLM_OCR_TIMEOUT_SEC, GLM_OCR_URL
from recognizeuz.documents.fields import DATE_FIELD_NAMES, DOC_OUTPUT_FIELDS, FIELD_LABELS, SEX_FIELD_NAMES

def image_bgr_to_base64_jpeg(
    image_bgr: np.ndarray,
    quality: int = 92,
) -> str:
    ok, buf = cv2.imencode(
        ".jpg",
        image_bgr,
        [int(cv2.IMWRITE_JPEG_QUALITY), quality],
    )
    if not ok:
        raise RuntimeError("Failed to encode image for GLM OCR")

    return base64.b64encode(buf.tobytes()).decode("ascii")

def bgr_to_png_base64(image_bgr: np.ndarray) -> str:
    """
    Конвертирует OpenCV BGR image в PNG base64.
    Нужно для отправки изображения во vLLM OpenAI-compatible API.
    """

    ok, buffer = cv2.imencode(".png", image_bgr)

    if not ok:
        raise RuntimeError("Failed to encode image as PNG")

    return base64.b64encode(buffer.tobytes()).decode("ascii")

def call_glm_ocr_vllm(
    image_bgr: np.ndarray,
    prompt: str,
    num_predict: int = 128,
) -> str:
    """
    Совместимый wrapper под старый код.

    ВАЖНО:
    - num_predict мапится в max_tokens;
    - внутри используется vLLM OpenAI-compatible API.
    """

    image_b64 = bgr_to_png_base64(image_bgr)

    payload = {
        "model": GLM_OCR_MODEL,
        "temperature": 0,
        "max_tokens": num_predict,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/png;base64,{image_b64}",
                        },
                    },
                    {
                        "type": "text",
                        "text": prompt,
                    },
                ],
            }
        ],
    }

    response = requests.post(
        GLM_OCR_URL,
        json=payload,
        timeout=GLM_OCR_TIMEOUT_SEC,
    )
    response.raise_for_status()

    data = response.json()

    return (
        data["choices"][0]["message"]["content"]
        .strip()
    )

def call_glm_ocr_ollama(
    image_bgr: np.ndarray,
    prompt: str,
    *,
    timeout_sec: float = GLM_OCR_TIMEOUT_SEC,
    num_predict: int = 96,
) -> str:
    payload = {
        "model": GLM_OCR_MODEL,
        "prompt": prompt,
        "images": [image_bgr_to_base64_jpeg(image_bgr)],
        "stream": False,
        "keep_alive": "-1",
        "options": {
            "temperature": 0,
            "num_predict": num_predict,
        },
    }

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        GLM_OCR_URL,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.URLError as exc:
        raise RuntimeError(f"GLM OCR request failed: {exc}") from exc

    parsed = json.loads(body)
    return str(parsed.get("response", "")).strip()

def clean_glm_text(text: str) -> str:
    text = text.strip()
    text = re.sub(r"^```(?:json|text)?", "", text, flags=re.I).strip()
    text = re.sub(r"```$", "", text).strip()

    if len(text) >= 2 and text[0] == text[-1] and text[0] in {'"', "'"}:
        text = text[1:-1].strip()

    lowered = text.lower()
    if lowered in {"null", "none", "empty", "пусто", "нет"}:
        return ""

    return text

def glm_ocr_field(
    doc_type: str,
    field_name: str,
    field_crop_bgr: np.ndarray,
) -> str:
    label = FIELD_LABELS.get(field_name, field_name)
    extra_instruction = ""
    if field_name == "pas_number":
        extra_instruction = (
            "The passport number must contain exactly 2 Latin uppercase letters "
            "followed by exactly 7 digits. Count repeated digits very carefully. "
            "For example, distinguish 00055 from 00555. "
        )
    elif field_name in DATE_FIELD_NAMES:
        extra_instruction = "The date must be returned as DD MM YYYY if visible. "
    elif field_name in SEX_FIELD_NAMES:
        extra_instruction = "Return only M or F if visible. "

    prompt = (
        "Text Recognition. Read only the value of the requested document field.\n"
        f"Document type: {doc_type}.\n"
        f"Field: {label}.\n"
        f"{extra_instruction}"
        "Return only exact visible text from this field image. "
        "Do not add explanations, labels, markdown, or JSON. "
        "If the field is empty, return an empty string."
    )

    raw = call_glm_ocr_vllm(
        field_crop_bgr,
        prompt,
        num_predict=64,
    )
    return clean_glm_text(raw)


def glm_ocr_single_glyph(
    image_bgr: np.ndarray,
    *,
    alphabet_hint: str = "Russian Cyrillic uppercase letter",
) -> str:
    prompt = (
        "Text Recognition. Read exactly one character from this cell image.\n"
        f"Expected alphabet: {alphabet_hint}.\n"
        "Return only one visible character. Do not add explanations, labels, markdown, or JSON. "
        "If the cell is empty, return an empty string."
    )
    raw = call_glm_ocr_vllm(image_bgr, prompt, num_predict=8)
    return clean_glm_text(raw)

def extract_json_object(text: str) -> dict[str, Any]:
    cleaned = clean_glm_text(text)

    try:
        obj = json.loads(cleaned)
        return obj if isinstance(obj, dict) else {}
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{.*\}", cleaned, flags=re.S)
    if not match:
        return {}

    try:
        obj = json.loads(match.group(0))
        return obj if isinstance(obj, dict) else {}
    except json.JSONDecodeError:
        return {}

def glm_ocr_document_json(
    doc_type: str,
    doc_crop_bgr: np.ndarray,
) -> dict[str, str]:
    fields = DOC_OUTPUT_FIELDS.get(doc_type, [])
    keys_json = json.dumps(fields, ensure_ascii=False)

    prompt = (
        "Recognize the document and extract only these fields.\n"
        f"Document type: {doc_type}.\n"
        f"Return a strict minified JSON object with exactly these keys: {keys_json}.\n"
        "Use empty string for missing values. Do not include MRZ. "
        "Do not add explanations or markdown."
    )

    raw = call_glm_ocr_vllm(
        doc_crop_bgr,
        prompt,
        num_predict=512,
    )
    obj = extract_json_object(raw)

    return {
        key: clean_glm_text(str(obj.get(key, "")))
        for key in fields
    }
