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

def score_migration_layout(
    fields: list[dict[str, Any]],
    image_shape: tuple[int, int, int],
) -> float:
    h, w = image_shape[:2]
    by_name = {f["name"]: f for f in fields}

    score = 0.0

    score += len(fields) * 0.5
    score += sum(float(f["confidence"]) for f in fields)

    def below(a: str, b: str, weight: float = 0.6):
        nonlocal score

        if a in by_name and b in by_name:
            _, ay = center_of(by_name[a])
            _, by = center_of(by_name[b])

            if ay > by:
                score += weight
            else:
                score -= weight

    def right_of(a: str, b: str, weight: float = 0.6):
        nonlocal score

        if a in by_name and b in by_name:
            ax, _ = center_of(by_name[a])
            bx, _ = center_of(by_name[b])

            if ax > bx:
                score += weight
            else:
                score -= weight

    below("mg_number", "mg_series")
    below("mg_surname", "mg_number")
    below("mg_surname_lat", "mg_surname")
    below("mg_name", "mg_surname_lat")
    below("mg_patronymic", "mg_name")
    below("mg_date_of_birth", "mg_patronymic")
    below("mg_nationality", "mg_patronymic")
    right_of("mg_nationality", "mg_date_of_birth")
    below("mg_passport_number", "mg_date_of_birth")
    below("mg_passport_number", "mg_nationality")
    right_of("mg_visa_number", "mg_passport_number")
    below("mg_duration_from", "mg_passport_number")
    below("mg_duration_to", "mg_passport_number")
    right_of("mg_duration_to", "mg_duration_from")

    anchors = [
        by_name.get("mg_duration_from"),
        by_name.get("mg_duration_to"),
    ]
    anchors = [a for a in anchors if a is not None]

    if anchors:
        avg_y = np.mean(
            [
                center_of(a)[1]
                for a in anchors
            ]
        )

        if avg_y / h > 0.65:
            score += 2.0
        else:
            score -= 1.5

    return score


def is_migration_orientation_confident(
    fields: list[dict[str, Any]],
    score: float,
    image_shape: tuple[int, int, int],
) -> bool:
    names = {f["name"] for f in fields}
    required_any = {
        "mg_series",
        "mg_number",
        "mg_surname",
        "mg_name",
        "mg_date_of_birth",
        "mg_passport_number",
    }

    if len(fields) >= 7 and len(names & required_any) >= 4 and score >= 10:
        return True

    return False
