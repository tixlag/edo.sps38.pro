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

from recognizeuz.image.geometry import center_of

def score_passport_layout(
    fields: list[dict[str, Any]],
    image_shape: tuple[int, int, int],
) -> float:
    h, w = image_shape[:2]
    by_name = {f["name"]: f for f in fields}

    score = 0.0

    score += len(fields) * 0.5
    score += sum(float(f["confidence"]) for f in fields)

    mrz = by_name.get("pas_mrz")
    photo = by_name.get("pas_photo")

    if mrz:
        _, cy = center_of(mrz)
        ratio = cy / h

        if ratio > 0.70:
            score += 4.0
        elif ratio > 0.55:
            score += 1.5
        else:
            score -= 4.0

    if photo:
        cx, _ = center_of(photo)

        others = [
            f for f in fields
            if f["name"] not in {"pas_photo", "pas_mrz"}
        ]

        if others:
            min_other_x = min(center_of(f)[0] for f in others)

            if cx < min_other_x:
                score += 2.0
            else:
                score -= 2.0

    def below(a: str, b: str, weight: float = 0.5):
        nonlocal score

        if a in by_name and b in by_name:
            _, ay = center_of(by_name[a])
            _, by = center_of(by_name[b])

            if ay > by:
                score += weight
            else:
                score -= weight

    def right_of(a: str, b: str, weight: float = 0.5):
        nonlocal score

        if a in by_name and b in by_name:
            ax, _ = center_of(by_name[a])
            bx, _ = center_of(by_name[b])

            if ax > bx:
                score += weight
            else:
                score -= weight

    below("pas_surname", "pas_number")
    below("pas_name", "pas_surname")
    below("pas_patronymic", "pas_name")
    below("pas_nationality", "pas_patronymic")
    below("pas_date_of_birth", "pas_nationality")
    below("pas_sex", "pas_date_of_birth")
    right_of("pas_place_of_birth", "pas_sex")
    below("pas_date_of_issue", "pas_sex")
    below("pas_date_of_expiry", "pas_date_of_issue")
    right_of("pas_authority", "pas_date_of_issue")
    right_of("pas_authority", "pas_date_of_expiry")

    return score


def is_passport_orientation_confident(
    fields: list[dict[str, Any]],
    score: float,
    image_shape: tuple[int, int, int],
) -> bool:
    names = {f["name"] for f in fields}
    required_any = {
        "pas_number",
        "pas_surname",
        "pas_name",
        "pas_date_of_birth",
    }

    if len(fields) >= 8 and len(names & required_any) >= 3 and score >= 12:
        return True

    return False
