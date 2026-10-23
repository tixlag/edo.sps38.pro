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

from recognizeuz.core.config import PDF_DPI

def pil_to_bgr(img: Image.Image) -> np.ndarray:
    img = ImageOps.exif_transpose(img)
    img = img.convert("RGB")
    arr = np.array(img)
    return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)

def load_image_bytes(data: bytes) -> np.ndarray:
    img = Image.open(io.BytesIO(data))
    return pil_to_bgr(img)

def load_pdf_bytes(data: bytes, dpi: int = PDF_DPI) -> list[np.ndarray]:
    import pypdfium2 as pdfium

    pages: list[np.ndarray] = []

    with tempfile.NamedTemporaryFile(suffix=".pdf") as tmp:
        tmp.write(data)
        tmp.flush()

        pdf = pdfium.PdfDocument(tmp.name)
        scale = dpi / 72.0

        for i in range(len(pdf)):
            page = pdf[i]
            bitmap = page.render(scale=scale)
            pil_img = bitmap.to_pil()
            pages.append(pil_to_bgr(pil_img))

    return pages

def load_pages_from_upload(
    data: bytes,
    filename: str,
    content_type: str | None,
) -> list[np.ndarray]:
    suffix = Path(filename).suffix.lower()

    is_pdf = (
        suffix == ".pdf"
        or content_type == "application/pdf"
    )

    if is_pdf:
        return load_pdf_bytes(data)

    return [load_image_bytes(data)]
