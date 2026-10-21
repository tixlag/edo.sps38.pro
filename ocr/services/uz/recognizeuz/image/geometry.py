from __future__ import annotations

import base64
import hashlib
import io
import json
from math import isfinite
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

def polygon_to_list(points: np.ndarray) -> list[list[float]]:
    return [
        [float(x), float(y)]
        for x, y in points
    ]

def bbox_from_polygon(points: np.ndarray) -> list[float]:
    xs = points[:, 0]
    ys = points[:, 1]

    return [
        float(xs.min()),
        float(ys.min()),
        float(xs.max()),
        float(ys.max()),
    ]

def order_quad_points(points: np.ndarray) -> np.ndarray:
    rect = cv2.minAreaRect(points.astype(np.float32))
    box = cv2.boxPoints(rect)

    s = box.sum(axis=1)
    diff = np.diff(box, axis=1).reshape(-1)

    ordered = np.zeros((4, 2), dtype=np.float32)
    ordered[0] = box[np.argmin(s)]
    ordered[2] = box[np.argmax(s)]
    ordered[1] = box[np.argmin(diff)]
    ordered[3] = box[np.argmax(diff)]

    return ordered

def warp_document_by_polygon(
    image_bgr: np.ndarray,
    polygon: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    src = order_quad_points(polygon)

    top_w = np.linalg.norm(src[1] - src[0])
    bottom_w = np.linalg.norm(src[2] - src[3])
    crop_w = int(max(top_w, bottom_w))

    right_h = np.linalg.norm(src[2] - src[1])
    left_h = np.linalg.norm(src[3] - src[0])
    crop_h = int(max(right_h, left_h))

    crop_w = max(crop_w, 8)
    crop_h = max(crop_h, 8)

    dst = np.array(
        [
            [0, 0],
            [crop_w - 1, 0],
            [crop_w - 1, crop_h - 1],
            [0, crop_h - 1],
        ],
        dtype=np.float32,
    )

    matrix = cv2.getPerspectiveTransform(src, dst)
    crop = cv2.warpPerspective(
        image_bgr,
        matrix,
        (crop_w, crop_h),
    )

    return crop, matrix

def rotate_image(
    image_bgr: np.ndarray,
    angle: int,
) -> np.ndarray:
    if angle == 0:
        return image_bgr

    if angle == 90:
        return cv2.rotate(
            image_bgr,
            cv2.ROTATE_90_CLOCKWISE,
        )

    if angle == 180:
        return cv2.rotate(
            image_bgr,
            cv2.ROTATE_180,
        )

    if angle == 270:
        return cv2.rotate(
            image_bgr,
            cv2.ROTATE_90_COUNTERCLOCKWISE,
        )

    raise ValueError(f"Unsupported rotation: {angle}")


def source_field_regions(ctx: Any, field: dict[str, Any], text: str | None) -> list[dict[str, Any]]:
    """Undo orientation and perspective so boxes refer to the displayed upload."""
    matrix = ctx.source_to_document
    if matrix is None or field.get("polygon") is None:
        return []
    try:
        inverse = np.linalg.inv(matrix).tolist()
    except np.linalg.LinAlgError:
        return []
    region = source_polygon_region(field["polygon"], inverse, ctx.page.image_bgr.shape,
                                   ctx.base_doc_crop.shape, ctx.rotation)
    if region is None:
        return []
    return [{
        "file_index": ctx.page.file_index, "page_number": ctx.page.page_index + 1,
        **region, "text": text,
    }]


def source_polygon_region(points, inverse_matrix, source_shape, base_shape, rotation=0):
    """Project oriented field vertices into the original page; inference-independent."""
    if len(points) < 3 or rotation not in (0, 90, 180, 270):
        return None
    height, width = base_shape[:2]
    page_height, page_width = source_shape[:2]
    source = []
    for point in points:
        if len(point) != 2:
            return None
        x, y = map(float, point)
        if rotation == 90:
            x, y = y, height - 1 - x
        elif rotation == 180:
            x, y = width - 1 - x, height - 1 - y
        elif rotation == 270:
            x, y = width - 1 - y, x
        m = inverse_matrix
        denominator = m[2][0] * x + m[2][1] * y + m[2][2]
        if not isfinite(denominator) or abs(denominator) < 1e-9:
            return None
        x_source = (m[0][0] * x + m[0][1] * y + m[0][2]) / denominator / page_width
        y_source = (m[1][0] * x + m[1][1] * y + m[1][2]) / denominator / page_height
        if not isfinite(x_source) or not isfinite(y_source):
            return None
        source.append((max(0.0, min(1.0, x_source)), max(0.0, min(1.0, y_source))))
    left, top = min(p[0] for p in source), min(p[1] for p in source)
    right, bottom = max(p[0] for p in source), max(p[1] for p in source)
    if right <= left or bottom <= top:
        return None
    return dict(x=float(left), y=float(top), width=float(right - left), height=float(bottom - top))

def crop_field_bbox(
    doc_bgr: np.ndarray,
    polygon: np.ndarray,
    pad_ratio_x: float = 0.04,
    pad_ratio_y: float = 0.18,
    min_pad: int = 2,
) -> np.ndarray:
    h, w = doc_bgr.shape[:2]

    x1, y1, x2, y2 = bbox_from_polygon(polygon)

    bw = x2 - x1
    bh = y2 - y1

    pad_x = max(min_pad, int(bw * pad_ratio_x))
    pad_y = max(min_pad, int(bh * pad_ratio_y))

    x1 = max(0, int(round(x1)) - pad_x)
    y1 = max(0, int(round(y1)) - pad_y)
    x2 = min(w - 1, int(round(x2)) + pad_x)
    y2 = min(h - 1, int(round(y2)) + pad_y)

    if x2 <= x1 or y2 <= y1:
        return doc_bgr[0:1, 0:1].copy()

    return doc_bgr[y1:y2 + 1, x1:x2 + 1].copy()

def center_of(field: dict[str, Any]) -> tuple[float, float]:
    poly = field["polygon"]
    return float(poly[:, 0].mean()), float(poly[:, 1].mean())

def crop_field_polygon_masked(
    doc_bgr: np.ndarray,
    polygon: np.ndarray,
    pad_ratio_x: float = 0.03,
    pad_ratio_y: float = 0.08,
    min_pad: int = 2,
) -> np.ndarray:
    """
    Crop поля по bbox полигона, но всё, что находится вне polygon,
    заливаем белым. Так OCR не видит соседние строки/подписи.

    Это важно:
    - YOLO field model даёт polygon/mask.
    - OCR должен видеть только текст внутри этого polygon.
    """

    h, w = doc_bgr.shape[:2]

    poly = polygon.astype(np.float32)

    x1 = float(poly[:, 0].min())
    y1 = float(poly[:, 1].min())
    x2 = float(poly[:, 0].max())
    y2 = float(poly[:, 1].max())

    bw = x2 - x1
    bh = y2 - y1

    pad_x = max(min_pad, int(bw * pad_ratio_x))
    pad_y = max(min_pad, int(bh * pad_ratio_y))

    x1i = max(0, int(round(x1)) - pad_x)
    y1i = max(0, int(round(y1)) - pad_y)
    x2i = min(w - 1, int(round(x2)) + pad_x)
    y2i = min(h - 1, int(round(y2)) + pad_y)

    if x2i <= x1i or y2i <= y1i:
        return doc_bgr[0:1, 0:1].copy()

    crop = doc_bgr[y1i:y2i + 1, x1i:x2i + 1].copy()

    shifted_poly = poly.copy()
    shifted_poly[:, 0] -= x1i
    shifted_poly[:, 1] -= y1i

    mask = np.zeros(crop.shape[:2], dtype=np.uint8)
    cv2.fillPoly(
        mask,
        [shifted_poly.astype(np.int32)],
        255,
    )

    white = np.full_like(crop, 255)
    masked = np.where(mask[:, :, None] == 255, crop, white)

    return masked
