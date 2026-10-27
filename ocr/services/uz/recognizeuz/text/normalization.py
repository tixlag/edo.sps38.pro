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

from recognizeuz.ocr.glm import clean_glm_text
from recognizeuz.text.transliteration import _UZ_APOSTROPHES

def normalize_ocr_text_for_match(text: str) -> str:
    """
    Нормализация только для проверки совпадения PaddleOCR и GLM OCR.

    Нам важно не принять ошибку за совпадение, поэтому не делаем агрессивных
    замен вроде O->0 или I->1. Убираем только регистр, пробелы и варианты
    апострофа/дефиса.
    """

    text = clean_glm_text(str(text))
    text = unicodedata.normalize("NFKC", text)
    text = text.upper()

    for apostrophe in _UZ_APOSTROPHES:
        text = text.replace(apostrophe, "'")

    text = text.replace("–", "-").replace("—", "-")
    text = re.sub(r"\s+", "", text)

    return text

def normalize_ocr_phrase_for_token_repair(text: str) -> str:
    """
    Нормализация фразы именно для token-level repair.

    ВАЖНО: здесь нельзя использовать normalize_ocr_text_for_match(), потому что
    она специально склеивает пробелы для сравнения Paddle/GLM:
      KASHKADARYA REGIQON -> KASHKADARYAREGIQON

    А token-repair должен видеть отдельные токены:
      KASHKADARYA | REGIQON -> REGION
    """

    value = clean_glm_text(str(text))
    value = unicodedata.normalize("NFKC", value)
    value = value.upper()

    for apostrophe in _UZ_APOSTROPHES:
        value = value.replace(apostrophe, "'")

    # Разделители оставляем разделителями, а не склеиваем слова.
    value = value.replace("–", " ").replace("—", " ").replace("-", " ")
    value = re.sub(r"[_/\\|]+", " ", value)

    # Пунктуация вокруг административных слов не должна мешать токенизации.
    value = re.sub(r"[.,;:()\[\]{}\"“”]+", " ", value)

    # Оставляем только латиницу/цифры/пробелы для английских и узбекских
    # паспортных place tokens. Остальное становится разделителем.
    value = re.sub(r"[^A-Z0-9' ]+", " ", value)
    value = re.sub(r"\s+", " ", value).strip()

    return value

def paddle_and_glm_texts_match(
    paddle_text: str,
    glm_text: str | None,
) -> bool:
    if not glm_text:
        return False

    paddle_norm = normalize_ocr_text_for_match(paddle_text)
    glm_norm = normalize_ocr_text_for_match(glm_text)

    return bool(paddle_norm and paddle_norm == glm_norm)
