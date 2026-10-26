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

from recognizeuz.core.config import *

def prepare_ocr_image_array(
    image_bgr: np.ndarray,
    target_height: int = OCR_TARGET_HEIGHT,
    min_width: int = OCR_MIN_WIDTH,
    max_width: int = OCR_MAX_WIDTH,
    pad_x: int = OCR_PAD_X,
    pad_y: int = OCR_PAD_Y,
    grayscale: bool = True,
    normalize_background: bool = True,
    contrast_enhance: float = 1.25,
) -> np.ndarray:
    rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    img = Image.fromarray(rgb).convert("RGB")

    img = ImageOps.expand(
        img,
        border=(pad_x, pad_y, pad_x, pad_y),
        fill=(255, 255, 255),
    )

    if grayscale:
        img = img.convert("L")

        if normalize_background:
            bg = img.filter(
                ImageFilter.GaussianBlur(
                    radius=max(3, img.height // 2),
                )
            )
            img = ImageOps.autocontrast(
                Image.blend(
                    img,
                    ImageOps.invert(bg),
                    alpha=0.18,
                )
            )

        img = ImageEnhance.Contrast(img).enhance(float(contrast_enhance))
        img = img.convert("RGB")

    scale = target_height / img.height
    new_w = round(img.width * scale)

    new_w = max(new_w, min_width)
    new_w = min(new_w, max_width)

    img = img.resize(
        (new_w, target_height),
        Image.Resampling.LANCZOS,
    )

    if img.width < min_width:
        canvas = Image.new(
            "RGB",
            (min_width, target_height),
            (255, 255, 255),
        )
        x = (min_width - img.width) // 2
        canvas.paste(img, (x, 0))
        img = canvas

    out_rgb = np.array(img)
    return cv2.cvtColor(out_rgb, cv2.COLOR_RGB2BGR)

def _clip_uint8_image(image: np.ndarray) -> np.ndarray:
    return np.clip(image, 0, 255).astype(np.uint8)

def _encode_decode_jpeg(image_bgr: np.ndarray, quality: int) -> np.ndarray:
    ok, encoded = cv2.imencode(
        ".jpg",
        image_bgr,
        [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)],
    )
    if not ok:
        return image_bgr.copy()

    decoded = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    if decoded is None:
        return image_bgr.copy()

    return decoded

def augment_ocr_field_photo_variant(
    image_bgr: np.ndarray,
    variant_index: int,
) -> np.ndarray:
    """
    Мягкие фото-аугментации для OCR-rec сегментов.

    Важно: аугментируем RAW crop поля, а не уже normalized 48px картинку.
    Потом каждая версия проходит тот же prepare_ocr_image_array(), что и инференс.
    """

    if image_bgr.size == 0:
        return image_bgr.copy()

    img = image_bgr.copy()
    h, w = img.shape[:2]

    seed = int.from_bytes(
        hashlib.sha1(
            img.tobytes()
            + b"\0"
            + str(variant_index).encode("ascii")
        ).digest()[:8],
        "big",
    )
    rng = np.random.default_rng(seed)

    if variant_index == 1:
        # Слегка другая экспозиция + контраст + едва заметный шум камеры.
        alpha = float(rng.uniform(1.06, 1.14))
        beta = float(rng.uniform(-7.0, 3.0))
        out = img.astype(np.float32) * alpha + beta
        noise_sigma = 2.0 if max(h, w) < 120 else 2.8
        noise = rng.normal(0.0, noise_sigma, out.shape)
        out = out + noise
        return _clip_uint8_image(out)

    if variant_index == 2:
        # Небольшая потеря резкости/деталей и JPEG-сжатие, как на фото/мессенджерах.
        scale = 0.88 if min(h, w) >= 18 else 0.94
        small_w = max(2, int(round(w * scale)))
        small_h = max(2, int(round(h * scale)))
        small = cv2.resize(img, (small_w, small_h), interpolation=cv2.INTER_AREA)
        out = cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)
        if min(h, w) >= 16:
            out = cv2.GaussianBlur(out, (3, 3), 0.35)
        return _encode_decode_jpeg(out, quality=76)

    if variant_index == 3:
        # Очень лёгкий наклон/сдвиг + неравномерная подсветка.
        angle = float(rng.uniform(-0.9, 0.9))
        if abs(angle) < 0.25:
            angle = -0.8 if w >= h else 0.8
        center = (w / 2.0, h / 2.0)
        matrix = cv2.getRotationMatrix2D(center, angle, 1.0)
        matrix[0, 2] += float(rng.uniform(-0.006, 0.008)) * max(w, 1)
        matrix[1, 2] += float(rng.uniform(-0.004, 0.006)) * max(h, 1)
        out = cv2.warpAffine(
            img,
            matrix,
            (w, h),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=(255, 255, 255),
        )

        x_gradient = np.linspace(0.96, 1.05, w, dtype=np.float32)
        y_gradient = np.linspace(1.02, 0.98, h, dtype=np.float32).reshape(h, 1)
        light = (x_gradient * y_gradient).reshape(h, w, 1)
        out = out.astype(np.float32) * light
        return _clip_uint8_image(out)

    return img

def build_ocr_improve_prepared_variants(
    field_crop_bgr: np.ndarray,
    *,
    include_augmentations: bool = True,
    prepared_orig_bgr: np.ndarray | None = None,
) -> list[dict[str, Any]]:
    """
    Возвращает prepared-варианты для датасета улучшения OCR.

    Эффективный порядок:
      - во время распознавания готовим только orig, чтобы PaddleOCR и GLM OCR
        видели одинаковую картинку;
      - aug01..aug03 строим только после подтверждённого mismatch, прямо перед
        сохранением в датасет.

    Важно: аугментируем RAW crop поля, а не уже normalized 48px картинку.
    Потом каждая версия проходит тот же prepare_ocr_image_array(), что и инференс.
    """

    prepared_variants: list[dict[str, Any]] = []

    if prepared_orig_bgr is None:
        prepared_orig_bgr = prepare_ocr_image_array(field_crop_bgr)

    prepared_variants.append(
        {
            "variant": "orig",
            "image": prepared_orig_bgr,
            "raw_shape": list(field_crop_bgr.shape),
            "prepared_shape": list(prepared_orig_bgr.shape),
        }
    )

    if not include_augmentations:
        return prepared_variants

    aug_count = max(0, OCR_IMPROVE_AUGMENTATIONS_PER_SEGMENT)
    for idx in range(1, min(aug_count, 3) + 1):
        raw_image = augment_ocr_field_photo_variant(field_crop_bgr, idx)
        prepared = prepare_ocr_image_array(raw_image)
        prepared_variants.append(
            {
                "variant": f"aug{idx:02d}",
                "image": prepared,
                "raw_shape": list(raw_image.shape),
                "prepared_shape": list(prepared.shape),
            }
        )

    return prepared_variants
