# import sys
# # print("sys.path:")
# # for p in sys.path:
# #     print("  ", p)
#
# import pprint
#
# pprint.pp(sys.path)
# import importlib.util
#
# print(importlib.util.find_spec('starlette'))
import logging
import base64
from asyncio import Lock
from datetime import datetime

import math
import sys
import warnings

from PIL import ImageEnhance, Image
# # sys.path = [p for p in sys.path if not p.endswith('python312.zip')]
#
# # Удаляем дубликаты, сохраняя порядок
# seen = set()
# sys.path = [p for p in sys.path if not (p in seen or seen.add(p))]
#
# print()
# print()
# print()
#
# print("sys.path_after:")
# for p in sys.path:
#     print("  ", p)

import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
# или


from fastapi import FastAPI, File, UploadFile, HTTPException, Depends, Query
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import tempfile
import os
import shutil
from pathlib import Path
from typing import List, Optional, Dict, Any, Tuple
import asyncio
import time
from time import perf_counter
import httpx

# Reuse many helpers from original script adapted into this module
import json
import re
import numpy as np
from paddleocr import PaddleOCR, TextDetection
from pydantic import BaseModel

from dotenv import load_dotenv


"""
Собственно, сам распознаватор.
Текущий рабочий процесс:
Взяли первое фото из pdf (или просто фото) ->
Вырезали сегменты паспорта с помощью YOLO ->
Распознали текст на сегментах с помощью дообученной PaddleOCR ->
дле сегментов, где плохо рапознается текст, отправилив в LLM (Avision в библиотеке Transformers)
"""

load_dotenv(Path(__file__).with_name(".env"))

from settings import (RU_DOC_MODEL_PATH, RU_MULTILINE_MODEL_PATH, RU_OCR_MODEL_DIR, RU_LOG_DIR, RU_DEBUG_DIR)

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
# from full_pipeline.PassportEnhancer import PassportEnhancer

# from full_pipeline.TrOCRService import TrOCRService, trocr_recognize_async  # или from .trocr_service import ...
# trocr_svc = TrOCRService()
trocr_svc = None


# ── GLM-OCR / vLLM OpenAI-compatible service ────────────────────────────────
# Используем тот же GLM-OCR сервис, что и в текущем UZ pipeline:
# POST /v1/chat/completions с image_url=data:image/png;base64,...
# Модель/URL меняются через env без изменения кода.

# Optional heavy l
# ibs
try:
    import cv2
except Exception:
    cv2 = None

try:
    from ultralytics import YOLO
except Exception:
    YOLO = None

try:
    import fitz
except Exception:
    fitz = None

try:
    from pdf2image import convert_from_path
except Exception:
    convert_from_path = None

# --------------------------- GLM OCR service --------------------------------
GLM_OCR_URL = os.getenv("GLM_OCR_URL", "http://127.0.0.1:8083/v1/chat/completions")
GLM_OCR_MODEL = os.getenv("GLM_OCR_MODEL", "zai-org/GLM-OCR")
GLM_OCR_TIMEOUT_SEC = float(os.getenv("GLM_OCR_TIMEOUT_SEC", "12"))
GLM_OCR_ENABLED = os.getenv("GLM_OCR_ENABLED", "1").lower() not in {"0", "false", "no", "off"}
GLM_OCR_MAX_TOKENS_FIELD = int(os.getenv("GLM_OCR_MAX_TOKENS_FIELD", "160"))
GLM_OCR_MAX_TOKENS_DOCUMENT = int(os.getenv("GLM_OCR_MAX_TOKENS_DOCUMENT", "512"))

# Для этих полей GLM полезен особенно часто: многострочный текст и строгие числовые поля.
GLM_DIRECT_FIELDS = {
    item.strip()
    for item in os.getenv("GLM_DIRECT_FIELDS", "issued_by,serial_number").split(",")
    if item.strip()
}

# Многострочные поля в российских паспортах часто хуже читаются строковой Paddle-моделью.
# Поэтому после line-detector + PaddleOCR считаем среднюю уверенность по строкам.
# Если средняя уверенность ниже порога — отправляем ВЕСЬ исходный crop многострочного поля в GLM OCR.
MULTILINE_GLM_FALLBACK_ENABLED = (
    os.getenv("MULTILINE_GLM_FALLBACK_ENABLED", "1").lower()
    not in {"0", "false", "no", "off"}
)
MULTILINE_GLM_AVG_SCORE_THRESHOLD = float(
    os.getenv("MULTILINE_GLM_AVG_SCORE_THRESHOLD", "0.98")
)
MULTILINE_MIN_LINE_SCORE = float(
    os.getenv("MULTILINE_MIN_LINE_SCORE", "0.60")
)


def _ensure_bgr(image: np.ndarray) -> np.ndarray:
    if image is None:
        raise ValueError("image is None")
    if len(image.shape) == 2:
        return cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    if image.shape[2] == 4:
        # Сегменты из YOLO могут быть BGRA. Для OCR лучше положить их на белый фон,
        # иначе прозрачные пиксели/альфа могут давать тёмные артефакты.
        bgr = image[:, :, :3].copy()
        alpha = image[:, :, 3].astype(np.float32) / 255.0
        white = np.full_like(bgr, 255)
        return (bgr.astype(np.float32) * alpha[..., None] + white.astype(np.float32) * (1 - alpha[..., None])).astype(np.uint8)
    return image


def bgr_to_png_base64(image_bgr: np.ndarray) -> str:
    image_bgr = _ensure_bgr(image_bgr)
    ok, buffer = cv2.imencode(".png", image_bgr)
    if not ok:
        raise RuntimeError("Failed to encode image as PNG")
    return base64.b64encode(buffer.tobytes()).decode("ascii")


def clean_glm_text(text: str) -> str:
    text = str(text or "").strip()
    text = re.sub(r"^```(?:json|text)?", "", text, flags=re.I).strip()
    text = re.sub(r"```$", "", text).strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {'\"', "'"}:
        text = text[1:-1].strip()
    lowered = text.lower()
    if lowered in {"null", "none", "empty", "пусто", "нет", "нет данных"}:
        return ""
    return text


def call_glm_ocr_vllm(image_bgr: np.ndarray, prompt: str, *, max_tokens: int = GLM_OCR_MAX_TOKENS_FIELD) -> str:
    if not GLM_OCR_ENABLED:
        return ""
    if cv2 is None:
        raise RuntimeError("OpenCV is required for GLM OCR image encoding")

    image_b64 = bgr_to_png_base64(image_bgr)
    payload = {
        "model": GLM_OCR_MODEL,
        "temperature": 0,
        "max_tokens": int(max_tokens),
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{image_b64}"},
                    },
                    {"type": "text", "text": prompt},
                ],
            }
        ],
    }

    with httpx.Client(timeout=GLM_OCR_TIMEOUT_SEC) as client:
        response = client.post(GLM_OCR_URL, json=payload)
        response.raise_for_status()
        data = response.json()
    return clean_glm_text(data["choices"][0]["message"].get("content", ""))


async def call_glm_ocr_vllm_async(image_bgr: np.ndarray, prompt: str, *, max_tokens: int = GLM_OCR_MAX_TOKENS_FIELD) -> str:
    return await asyncio.to_thread(call_glm_ocr_vllm, image_bgr, prompt, max_tokens=max_tokens)


def _save_debug_image(image: np.ndarray, class_name: str, output_dir: Optional[str], prefix: str = "glm") -> str:
    if not output_dir:
        return ""
    ensure_dir(output_dir)
    safe_name = re.sub(r"[^a-zA-Z0-9_\-]+", "_", class_name or "field")
    path = os.path.join(output_dir, f"{prefix}_{safe_name}_{datetime.now().strftime('%H%M%S_%f')}.png")
    try:
        cv2.imwrite(path, _ensure_bgr(image))
    except Exception:
        return ""
    return path


def glm_recognize_with_score_vllm(img_array: np.ndarray, class_name: str, prompt: str, output_dir: Optional[str] = None) -> Tuple[Tuple[str, float], str]:
    path = _save_debug_image(img_array, class_name, output_dir, prefix="glm")
    text = call_glm_ocr_vllm(img_array, prompt, max_tokens=GLM_OCR_MAX_TOKENS_FIELD)
    return (text, 1.0 if text else 0.0), path


def glm_recognize_vllm(img_array: np.ndarray, class_name: str, prompt: str, output_dir: Optional[str] = None) -> Tuple[str, str]:
    (text, _score), path = glm_recognize_with_score_vllm(img_array, class_name, prompt, output_dir)
    return text, path


async def glm_recognize_vllm_async(img_array: np.ndarray, class_name: str, prompt: str, output_dir: Optional[str] = None) -> Tuple[str, str]:
    return await asyncio.to_thread(glm_recognize_vllm, img_array, class_name, prompt, output_dir)


def extract_json_object(text: str) -> dict:
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


def glm_ocr_russian_passport_json(image_bgr: np.ndarray) -> dict:
    keys = [
        "citizenship", "first_name", "second_name", "third_name", "date_birth",
        "place_birth", "sex", "date_issue", "issued_by", "issued_by_code",
        "series", "number",
    ]
    prompt = (
        "Recognize this Russian passport page. Return strict minified JSON only. "
        f"Use exactly these keys: {json.dumps(keys, ensure_ascii=False)}. "
        "Dates must be DD.MM.YYYY. Department code must be XXX-XXX. "
        "Passport series is 4 digits formatted as 'XX XX'; number is 6 digits. "
        "Use empty string for missing fields. Do not add markdown or explanations."
    )
    raw = call_glm_ocr_vllm(image_bgr, prompt, max_tokens=GLM_OCR_MAX_TOKENS_DOCUMENT)
    obj = extract_json_object(raw)
    return {key: clean_glm_text(obj.get(key, "")) for key in keys}

# --------------------------- Document type config ---------------------------
DOC_TYPE_CONFIG = {
    "passport_ru": {
        "main_model_path": str(RU_DOC_MODEL_PATH),
        "multiline_model_path": str(RU_MULTILINE_MODEL_PATH)
    },
    "passport_uz": {
        "main_model_path": "/path/to/uzbek_passport_model.pt",
    },
    "snils": {
        "main_model_path": "/path/to/snils_model.pt",
    },
}

# --------------------------- Pydantic model ---------------------------------
class RussianPassport(BaseModel):
    """
    Pydantic-модель результата паспорта.
    Поля опциональны — их заполняют распознанные значения.
    """
    doc_type: str = "passport_ru"
    citizenship: Optional[str] = None
    first_name: Optional[str] = None
    second_name: Optional[str] = None
    third_name: Optional[str] = None
    date_birth: Optional[str] = None
    place_birth: Optional[str] = None
    sex: Optional[str] = None
    date_issue: Optional[str] = None
    issued_by: Optional[str] = None
    issued_by_code: Optional[str] = None
    series: Optional[str] = None
    number: Optional[str] = None


SEGMENT_TO_FIELD_MAP = {
    'name': 'first_name',
    'second_name': 'second_name',
    'third_name': 'third_name',
    'date': 'date_birth',
    'address': 'place_birth',
    'gender': 'sex',
    'date_issue': 'date_issue',
    'issued_by': 'issued_by',
    'issued_by_code': 'issued_by_code',
    'serial_number': 'serial_number',
    'citizenship': 'citizenship',
}

OCR_SEGMENT_CLASSES = {
    'name',
    'second_name',
    'third_name',
    'date',
    'date_issue',
    'issued_by',
    'issued_by_code',
    'serial_number',
}


# --------------------------- Utilities -------------------------------------
def ensure_dir(p: str):
    """
    Создаёт директорию (включая промежуточные) если её нет.
    """
    os.makedirs(p, exist_ok=True)


# --------------------------- Image helpers ---------------------------------
def order_points(pts):
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]
    return rect


def four_point_transform(image, pts):
    rect = order_points(pts)
    (tl, tr, br, bl) = rect
    widthA = np.linalg.norm(br - bl)
    widthB = np.linalg.norm(tr - tl)
    maxWidth = max(int(widthA), int(widthB))
    heightA = np.linalg.norm(tr - br)
    heightB = np.linalg.norm(tl - bl)
    maxHeight = max(int(heightA), int(heightB))
    if maxWidth < 1 or maxHeight < 1:
        return image.copy()
    dst = np.array([[0, 0],
                    [maxWidth - 1, 0],
                    [maxWidth - 1, maxHeight - 1],
                    [0, maxHeight - 1]], dtype="float32")
    M = cv2.getPerspectiveTransform(rect, dst)
    warped = cv2.warpPerspective(image, M, (maxWidth, maxHeight))
    return warped


def nonwhite_mask_box(img, white_thresh=245, kernel_size=(9, 9), min_area_ratio=0.002):
    """
    Возвращает minAreaRect box (4x2 float32) вокруг нен- белых пикселей
    или None если ничего существенного не найдено.
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, mask = cv2.threshold(gray, white_thresh, 255, cv2.THRESH_BINARY_INV)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, kernel_size)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    c = max(contours, key=cv2.contourArea)
    area = cv2.contourArea(c)
    if area < min_area_ratio * (img.shape[0] * img.shape[1]):
        return None
    rect = cv2.minAreaRect(c)
    box = cv2.boxPoints(rect).astype("float32")
    return box


def _is_reasonable_quad(pts, img_area, min_area_ratio=0.04, min_area_abs=1000, ar_bounds=(0.4, 2.5), max_skew=4.0):
    # pts в координатах исходного изображения
    area = cv2.contourArea(pts.astype(np.float32))
    if area < min_area_abs:
        return False
    if area < min_area_ratio * img_area:
        return False
    rect = order_points(pts)
    tl, tr, br, bl = rect
    width = (np.linalg.norm(tr - tl) + np.linalg.norm(br - bl)) / 2.0
    height = (np.linalg.norm(tl - bl) + np.linalg.norm(tr - br)) / 2.0
    if height <= 0 or width <= 0:
        return False
    ar = width / height
    if ar < ar_bounds[0] or ar > ar_bounds[1]:
        return False
    side_lengths = [
        np.linalg.norm(tr - tl),
        np.linalg.norm(br - tr),
        np.linalg.norm(bl - br),
        np.linalg.norm(tl - bl)
    ]
    mn = min(side_lengths)
    if mn == 0:
        return False
    if max(side_lengths) / mn > max_skew:
        return False
    return True


def find_and_crop_document(img, resize_width=2056, some_ratio=0.30):
    """
    Пытается найти самый большой четырёхугольник (документ).
    Если найденная область слишком мала (< some_ratio от всей площади),
    используется fallback: nonwhite_mask_box (маска не-белого) -> minAreaRect.
    Возвращает (warped_image, chosen_contour_or_None).
    """
    if img is None:
        return None, None

    # todo пока напрямую из документа вытаскиваем сегменты
    return img, None

    orig = img.copy()
    h0, w0 = img.shape[:2]
    print("Original area = ", h0 * w0)

    ratio = 1.0
    if resize_width and w0 > resize_width:
        ratio = w0 / float(resize_width)
        img_resized = cv2.resize(img, (resize_width, int(h0 / ratio)))
    else:
        img_resized = img.copy()

    # 1) Детекция контуров (внешние) на уменьшенном изображении
    gray = cv2.cvtColor(img_resized, cv2.COLOR_BGR2GRAY)
    gray = cv2.bilateralFilter(gray, 9, 75, 75)
    edged = cv2.Canny(gray, 50, 200)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))
    closed = cv2.morphologyEx(edged, cv2.MORPH_CLOSE, kernel)
    contours, _ = cv2.findContours(closed.copy(), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    img_area_resized = img_resized.shape[0] * img_resized.shape[1]
    print("Resized area = ", img_area_resized)
    quad_candidates = []

    for c in contours:
        area = cv2.contourArea(c)
        if area < 0.006 * img_area_resized:
            continue
        peri = cv2.arcLength(c, True)
        for eps in (0.02, 0.04, 0.06, 0.08):
            approx = cv2.approxPolyDP(c, eps * peri, True)
            if len(approx) == 4 and cv2.isContourConvex(approx):
                quad_candidates.append((area, approx.reshape(4, 2).astype("float32")))
                break

    chosen = None
    chosen_area_orig = 0.0
    img_total_area = orig.shape[0] * orig.shape[1]

    if quad_candidates:
        quad_candidates.sort(key=lambda x: x[0], reverse=True)
        # пробуем лучшие кандидаты, проверяя их геометрию в масштабе оригинала
        for area_res, quad in quad_candidates:
            quad_orig = quad * (ratio if ratio != 1.0 else 1.0)
            area_orig = cv2.contourArea(quad_orig.astype(np.float32))
            if _is_reasonable_quad(quad_orig, img_total_area, min_area_ratio=0.06):
                chosen = quad_orig
                chosen_area_orig = area_orig
                break
        # если ни один не подошёл - временно поставим самый большой (для fallback логики)
        if chosen is None:
            quad_orig = quad_candidates[0][1] * (ratio if ratio != 1.0 else 1.0)
            chosen = quad_orig
            chosen_area_orig = cv2.contourArea(quad_orig.astype(np.float32))

    # Если квадрат слишком мал по отношению к изображению — используем fallback
    area_ratio = chosen_area_orig / float(img_total_area) if chosen is not None else 0.0
    if chosen is None or area_ratio < some_ratio:
        # Попытка 1: использовать minAreaRect по самому большому контуру (на сильнее обработанном изображении)
        # подготовим более мягкие/широкие параметры детекции
        gray2 = cv2.cvtColor(img_resized, cv2.COLOR_BGR2GRAY)
        gray2 = cv2.bilateralFilter(gray2, 9, 75, 75)
        edged2 = cv2.Canny(gray2, 30, 150)
        kernel2 = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9))
        closed2 = cv2.morphologyEx(edged2, cv2.MORPH_CLOSE, kernel2)
        cnts, _ = cv2.findContours(closed2.copy(), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if cnts:
            largest = max(cnts, key=cv2.contourArea)
            rect = cv2.minAreaRect(largest)
            box = cv2.boxPoints(rect).astype("float32") * (ratio if ratio != 1.0 else 1.0)
            area_box = cv2.contourArea(box.astype(np.float32))
            if _is_reasonable_quad(box, img_total_area, min_area_ratio=0.03):
                chosen = box
                chosen_area_orig = area_box
                area_ratio = chosen_area_orig / float(img_total_area)

    # Попытка 2 (если всё ещё не ок): маска "не белого"
    if chosen is None or area_ratio < some_ratio:
        box = nonwhite_mask_box(orig, white_thresh=245, kernel_size=(9, 9), min_area_ratio=0.002)
        if box is not None:
            # box уже в координатах оригинала
            area_box = cv2.contourArea(box.astype(np.float32))
            if _is_reasonable_quad(box, img_total_area, min_area_ratio=0.02):
                chosen = box
                chosen_area_orig = area_box
                area_ratio = chosen_area_orig / float(img_total_area)

    # Финальные проверки: если найдено, но слишком мало — считаем, что нет результата
    if chosen is None:
        return orig, None

    if (chosen_area_orig / float(img_total_area)) < 0.12:
        # слишком малая площадь => подозрение на внутренний прямоугольник => вернём оригинал
        return orig, None

    warped = four_point_transform(orig, chosen.astype("float32"))
    return warped, chosen


DEFAULT_MAX_W = 1920
DEFAULT_MAX_H = 1920


def _resize_preserve_aspect_cv(img_cv, max_w=DEFAULT_MAX_W, max_h=DEFAULT_MAX_H):
    h, w = img_cv.shape[:2]
    if w <= max_w and h <= max_h:
        return img_cv
    # scale factor to fit into box
    scale = min(max_w / w, max_h / h)
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    resized = cv2.resize(img_cv, (new_w, new_h), interpolation=cv2.INTER_AREA)
    return resized


def _compute_dpi_for_target_size(page_rect, target_w=DEFAULT_MAX_W, target_h=DEFAULT_MAX_H):
    """
    Вычисляем dpi, при котором ширина/высота страницы в пикселях не превысят target_w/target_h.
    page_rect — fitz.Rect с размерами в points (1pt = 1/72 inch).
    """
    # page width/height in inches:
    w_in = page_rect.width / 72.0
    h_in = page_rect.height / 72.0
    # required dpi to reach target dimensions:
    if w_in <= 0 or h_in <= 0:
        print('странный фаллбэк на 72')
        return 72  # fallback
    dpi_by_w = target_w / w_in
    dpi_by_h = target_h / h_in
    dpi = int(math.floor(min(dpi_by_w, dpi_by_h)))
    if dpi < 1:
        dpi = 1
    return dpi


def _pil_to_cv_bgr(pil_img):
    arr = np.array(pil_img.convert("RGB"))
    # RGB -> BGR
    return arr[:, :, ::-1].copy()


def _decode_pdf_image_bytes(image_bytes):
    if not image_bytes:
        return None
    nparr = np.frombuffer(image_bytes, np.uint8)
    return cv2.imdecode(nparr, cv2.IMREAD_COLOR)


def _embedded_image_looks_like_page(image_info, page, min_area_ratio=0.45, max_aspect_delta=0.35):
    img_w = float(image_info[2])
    img_h = float(image_info[3])
    page_w = float(page.rect.width)
    page_h = float(page.rect.height)
    if img_w <= 0 or img_h <= 0 or page_w <= 0 or page_h <= 0:
        return False

    area_ratio = (img_w * img_h) / (page_w * page_h)
    img_aspect = img_w / img_h
    page_aspect = page_w / page_h
    aspect_delta = abs(img_aspect - page_aspect) / page_aspect
    return area_ratio >= min_area_ratio and aspect_delta <= max_aspect_delta


def _extract_largest_embedded_image_from_page(doc, page):
    image_list = page.get_images(full=True)
    if not image_list:
        return None

    # get_images(full=True): xref, smask, width, height, ...
    image_list = sorted(image_list, key=lambda item: item[2] * item[3], reverse=True)
    for image_info in image_list:
        if not _embedded_image_looks_like_page(image_info, page):
            continue

        xref = image_info[0]
        try:
            base_image = doc.extract_image(xref)
            img_cv = _decode_pdf_image_bytes(base_image.get("image"))
            if img_cv is not None:
                return img_cv
        except Exception:
            pass

        try:
            pix = fitz.Pixmap(doc, xref)
            img_cv = _decode_pdf_image_bytes(pix.tobytes("png"))
            if img_cv is not None:
                return img_cv
        except Exception:
            continue

    return None


def _render_pdf_page_with_fitz(page, max_w=DEFAULT_MAX_W, max_h=DEFAULT_MAX_H, initial_dpi=500):
    safe_dpi = _compute_dpi_for_target_size(page.rect, target_w=max_w, target_h=max_h)
    safe_dpi = min(initial_dpi, safe_dpi)
    pix = page.get_pixmap(dpi=safe_dpi, alpha=False)
    return _decode_pdf_image_bytes(pix.tobytes("png"))


def get_pdf_page_count(pdf_path):
    if fitz is not None:
        doc = fitz.open(pdf_path)
        try:
            return len(doc)
        finally:
            doc.close()

    if convert_from_path is None:
        raise RuntimeError("No PDF backend available (fitz/pdf2image)")

    return len(convert_from_path(str(pdf_path), dpi=1))


def extract_pdf_page_image(pdf_path, page_index=0, max_w=DEFAULT_MAX_W, max_h=DEFAULT_MAX_H,
                           initial_dpi=500, min_dpi=50):
    """
    Извлекает одну страницу PDF по 0-based page_index.
    Возвращает list с одним {'img': img_cv_bgr, 'name': name} для совместимости с текущим pipeline.
    """
    pdf_stem = Path(pdf_path).stem
    page_name = f"{pdf_stem}_page{page_index + 1}"

    if fitz is not None:
        try:
            doc = fitz.open(pdf_path)
            try:
                if page_index < 0 or page_index >= len(doc):
                    return []

                page = doc[page_index]
                img_cv = _extract_largest_embedded_image_from_page(doc, page)
                if img_cv is None:
                    img_cv = _render_pdf_page_with_fitz(page, max_w=max_w, max_h=max_h, initial_dpi=initial_dpi)
                if img_cv is not None:
                    img_cv = _resize_preserve_aspect_cv(img_cv, max_w=max_w, max_h=max_h)
                    return [{'img': img_cv, 'name': page_name}]
            finally:
                doc.close()
        except Exception as e:
            warnings.warn(f"PyMuPDF failed for PDF page extraction; falling back to pdf2image: {e}")

    if convert_from_path is None:
        raise RuntimeError("No PDF backend available (fitz/pdf2image)")

    page_number = page_index + 1
    images = convert_from_path(str(pdf_path), first_page=page_number, last_page=page_number)
    if not images:
        return []

    img_cv = _pil_to_cv_bgr(images[0])
    img_cv = _resize_preserve_aspect_cv(img_cv, max_w=max_w, max_h=max_h)
    return [{'img': img_cv, 'name': page_name}]


def extract_images_from_pdf_in_memory(pdf_path, max_w=DEFAULT_MAX_W, max_h=DEFAULT_MAX_H,
                                      initial_dpi=500, min_dpi=50):
    """
    Извлекает изображения из PDF; все выходные изображения не превышают (max_w x max_h).
    Возвращает list of {'img': img_cv_bgr, 'name': name}.
    """
    images = []
    pdf_stem = Path(pdf_path).stem

    warnings.warn('im here')
    # PyMuPDF backend — предпочтительный: мы прямо подбираем dpi чтобы получить <= FullHD
    if fitz is not None:
        doc = fitz.open(pdf_path)
        try:
            for page_num, page in enumerate(doc):
                image_list = page.get_images(full=True)
                if not image_list:
                    safe_dpi = _compute_dpi_for_target_size(page.rect, target_w=max_w, target_h=max_h)
                    warnings.warn(f'safe dpi ${safe_dpi}')
                    # не превышаем initial_dpi
                    safe_dpi = min(initial_dpi, safe_dpi)
                    warnings.warn(f'safe dpi ${safe_dpi}')

                    if safe_dpi < initial_dpi:
                        warnings.warn(
                            f"Page {page_num + 1}: reduced dpi {initial_dpi} -> {safe_dpi} to fit {max_w}x{max_h}"
                        )
                    pix = page.get_pixmap(dpi=safe_dpi, alpha=False)
                    # берём PNG bytes чтобы cv2 мог корректно декодировать
                    png_bytes = pix.tobytes("png")
                    nparr = np.frombuffer(png_bytes, np.uint8)
                    img_cv = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                    if img_cv is None:
                        continue
                    img_cv = _resize_preserve_aspect_cv(img_cv, max_w=max_w, max_h=max_h)
                    images.append({'img': img_cv, 'name': f"{pdf_stem}_page{page_num + 1}"})
                    continue

                # извлекаем встроенные изображения
                for img_index, img in enumerate(image_list):
                    xref = img[0]
                    base_image = doc.extract_image(xref)
                    image_bytes = base_image.get("image")
                    if image_bytes is None:
                        # пробуем рендерить xref как pixmap
                        try:
                            pix = fitz.Pixmap(doc, xref)
                            image_bytes = pix.tobytes("png")
                        except Exception:
                            image_bytes = None
                    if image_bytes is None:
                        continue
                    nparr = np.frombuffer(image_bytes, np.uint8)
                    img_cv = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                    if img_cv is None:
                        continue
                    img_cv = _resize_preserve_aspect_cv(img_cv, max_w=max_w, max_h=max_h)
                    images.append({
                        'img': img_cv,
                        'name': f"{pdf_stem}_page{page_num + 1}_img{img_index + 1}"
                    })
        finally:
            doc.close()

        return images

    # Fallback: pdf2image / Pillow
    elif convert_from_path is not None:
        # Попытаемся рендерить с initial_dpi, при ошибке понижаем dpi до min_dpi по шагам
        dpi = initial_dpi
        warnings.warn(f'dpi: ${dpi}')
        warnings.warn(f'dpi: ${min_dpi}')
        pil_images = None
        last_exc = None
        while dpi >= min_dpi:
            try:
                pil_images = convert_from_path(pdf_path, dpi=dpi)
                break
            except Exception as e:
                last_exc = e
                # Если Pillow жалуется на DecompressionBombWarning/DecompressionBombError,
                # попробуем понизить dpi в 2 раза
                warnings.warn(f"Pillow raised during convert_from_path with dpi={dpi}; retrying with lower dpi.")
                dpi = dpi // 2
        if pil_images is None:
            # не удалось получить изображения
            raise RuntimeError(f"Failed to render PDF with pdf2image; last error: {last_exc!r}")

        for idx, pil_im in enumerate(pil_images):
            img_cv = _pil_to_cv_bgr(pil_im)
            img_cv = _resize_preserve_aspect_cv(img_cv, max_w=max_w, max_h=max_h)
            images.append({'img': img_cv, 'name': f"{pdf_stem}_page{idx + 1}"})

        return images

    else:
        raise RuntimeError("No PDF backend available (fitz/pdf2image)")


def extract_one_image_from_pdf(pdf_path, max_w=DEFAULT_MAX_W, max_h=DEFAULT_MAX_H,
                               initial_dpi=500, min_dpi=50):
    """
    Извлекает одно изображение из первой страницы PDF; все выходные изображения
    не превышают (max_w x max_h).
    Возвращает list of {'img': img_cv_bgr, 'name': name}.
    """
    return extract_pdf_page_image(pdf_path, 0, max_w=max_w, max_h=max_h, initial_dpi=initial_dpi, min_dpi=min_dpi)


def should_rotate_image(boxes_xyxy, img_h, img_w, threshold_ratio=1.5):
    """
    Определяет, нужно ли поворачивать изображение по часовой стрелке.
    Если большинство боксов — вертикальные (высота > ширина * threshold_ratio),
    то считаем, что изображение перевёрнуто.
    """
    vertical_count = 0
    total_count = len(boxes_xyxy)

    if total_count == 0:
        return False

    for box in boxes_xyxy:
        x1, y1, x2, y2 = box
        w = x2 - x1
        h = y2 - y1
        if h > w * threshold_ratio:
            vertical_count += 1

    # Если более 70% боксов — вертикальные — поворачиваем
    return vertical_count / total_count > 0.7


# --------------------------- YOLO segmentation -----------------------------


def run_yolo_segments_from_array(img, model):
    """
    Выполняет сегментацию изображения при помощи модели YOLO (ultralytics).
    Возвращает словарь segments: {class_name: [ { 'image': cropped_rgba, 'bbox': (x1,y1,x2,y2) }, ... ] }
    Если модель или результат отсутствует — возвращает None.
    """
    if img is None or model is None:
        return None

    h, w = img.shape[:2]
    original_orientation = 0  # 0: без поворота, 1: 90° CW, 2: 180°, 3: 270° CW

    # --- ПОВОРОТ ИСХОДНОГО ИЗОБРАЖЕНИЯ ---
    results = model(img, verbose=False)
    result = results[0]

    # Если нет объектов — не поворачиваем
    if result.boxes is not None and len(result.boxes) > 0:
        boxes_xyxy = result.boxes.xyxy.cpu().numpy()
        if should_rotate_image(boxes_xyxy, h, w):
            img = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
            h, w = img.shape[:2]  # обновляем размеры
            original_orientation = 1  # запоминаем, что было повернуто

    # --- ЗАПУСК МОДЕЛИ НА ПОВЕРНУТОМ ИЗОБРАЖЕНИИ ---
    results = model(img, verbose=False)
    result = results[0]

    if getattr(result, 'masks', None) is None:
        return None
    masks = result.masks.data
    boxes = result.boxes
    names = result.names

    segments = {}
    for i in range(len(boxes)):
        cls_id = int(boxes[i].cls.item())
        class_name = names[cls_id]
        mask_raw = masks[i].cpu().numpy()
        mask_raw = np.squeeze(mask_raw)
        if mask_raw.ndim != 2:
            continue
        # приводим маску к размеру исходного изображения (0..1 float)
        mask_resized = cv2.resize(mask_raw, (w, h), interpolation=cv2.INTER_NEAREST)
        mask_uint8 = (mask_resized > 0.5).astype(np.uint8) * 255

        x1f, y1f, x2f, y2f = map(float, boxes[i].xyxy[0])
        x1 = max(0, min(w - 1, int(round(x1f))))
        x2 = max(0, min(w, int(round(x2f))))
        y1 = max(0, min(h - 1, int(round(y1f))))
        y2 = max(0, min(h, int(round(y2f))))
        if x2 <= x1 or y2 <= y1:
            continue

        # создаём RGBA и применяем маску как альфу
        rgba = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
        # alpha для всего изображения
        rgba[:, :, 3] = mask_uint8

        # вырезаем по bbox
        cropped = rgba[y1:y2, x1:x2]
        if cropped.size == 0:
            continue
        segments.setdefault(class_name, []).append({
            'image': cropped,
            'bbox': (x1, y1, x2, y2)
        })
    return segments


def run_yolo_segments_from_array_paddle(img, model, folder_name=None, right_oriented_docs=None):
    """YOLO bbox-crops для OCR с быстрым orientation fallback.

    Оптимизация: раньше YOLO запускался дважды всегда. Теперь второй прогон делается
    только если первый проход показал вертикальную ориентацию и картинку реально повернули.
    """
    if img is None or model is None:
        return None

    if right_oriented_docs is None:
        right_oriented_docs = []

    h, w = img.shape[:2]
    results = model(img, verbose=False)
    result = results[0]

    rotated = False
    if result.boxes is not None and len(result.boxes) > 0:
        boxes_xyxy = result.boxes.xyxy.cpu().numpy()
        if should_rotate_image(boxes_xyxy, h, w):
            rotate_code = cv2.ROTATE_90_CLOCKWISE
            if folder_name and any(name in folder_name for name in right_oriented_docs):
                rotate_code = cv2.ROTATE_90_COUNTERCLOCKWISE
            img = cv2.rotate(img, rotate_code)
            h, w = img.shape[:2]
            rotated = True

    if rotated:
        results = model(img, verbose=False)
        result = results[0]

    if result.boxes is None or len(result.boxes) == 0:
        return {}

    boxes = result.boxes
    names = result.names
    segments = {}

    for i in range(len(boxes)):
        cls_id = int(boxes[i].cls.item())
        class_name = names[cls_id]

        x1f, y1f, x2f, y2f = map(float, boxes[i].xyxy[0])
        x1 = max(0, min(w - 1, int(round(x1f))))
        y1 = max(0, min(h - 1, int(round(y1f))))
        x2 = max(0, min(w, int(round(x2f))))
        y2 = max(0, min(h, int(round(y2f))))

        if x2 <= x1 or y2 <= y1:
            continue

        crop = img[y1:y2, x1:x2].copy()
        if crop.size == 0:
            continue

        if class_name != 'document':
            crop_h, crop_w = crop.shape[:2]
            if crop_w < crop_h:
                crop = cv2.rotate(crop, cv2.ROTATE_90_COUNTERCLOCKWISE)

        segments.setdefault(class_name, []).append(crop)

    return segments


# --------------------------- Vision OCR compatibility wrappers --------------
def create_segment_prompt(class_name: str, doc_type: str = "passport_ru") -> str:
    """
    Формирует текстовый prompt для vision OCR по имени сегмента и типу документа.
    Есть набор дефолтных промптов и специфичные для типов документов.
    Возвращает строку — prompt.
    """
    default_prompts = {
        'name': "Extract only the name (имя) from this passport image. Return ONLY the text, nothing else. No explanations. "
                "Популярные имена для сравнения в помощь:"
                "АЛЕКСАНДР, ДМИТРИЙ, МАКСИМ, ИВАН, АРТЁМ, МИХАИЛ, СЕРГЕЙ, АНДРЕЙ, НИКОЛАЙ, ЕГОР, ИЛЬЯ, КИРИЛЛ, ВЛАДИСЛАВ, ТИМОФЕЙ, РОМАН, ДАНИИЛ, АЛЕКСЕЙ, НИКИТА, ПАВЕЛ, СТЕПАН, АНАСТАСИЯ, МАРИЯ, АННА, ДАРЬЯ, ЕКАТЕРИНА, АЛИНА, ПОЛИНА, ВИКТОРИЯ, СОФИЯ, АРИНА, ЕЛИЗАВЕТА, ВАРВАРА, КСЕНИЯ, МИЛАНА, ВЕРОНИКА, УЛЬЯНА, ТАИСИЯ, АЛИСА, ВАЛЕРИЯ, ЗЛАТА",
        'second_name': "Extract only the surname (фамилия) from this passport image. Return ONLY the text, nothing else. No explanations.",
        'third_name': "Extract only the patronymic (отчество) from this passport image. Return ONLY the text, nothing else. No explanations.",
        'date': "Extract the birth date from this passport image in format DD.MM.YYYY. Return ONLY the date, nothing else. No explanations.",
        'address': "Extract the place of birth (место рождения) from this passport image. Return ONLY the text, nothing else, return ALL recognized text. No explanations. Это объекты России, Советского Союза или СНГ. Скорее всего текст написан на трех строках. В ответе верни ВЕСЬ распознанный текст, на каждой строке, ИГНОРИРУЙ мелкий шрифт, водяные знаки и отдельностоящую аббревиатуру РФ.",
        'gender': "Extract the sex/gender (пол) from this passport image. Return ONLY МУЖ or ЖЕН, nothing else. No explanations.",
        'date_issue': "Extract the issue date from this passport image in format DD.MM.YYYY. Return ONLY the date, nothing else. No explanations.",
        'issued_by': "Extract the 'issued by' organization name (кем выдан|паспорт выдан) from this passport image. Return ONLY the text, nothing else, return ALL recognized text. No explanations. Это объекты России, Советского Союза или СНГ. Скорее всего текст написан на трех строках. В ответе верни ВЕСЬ распознанный текст, на каждой строке, исключая мелкий шрифт. Важно сохранить каждый символ, и вернуть ответ в заглавном регистре",
        'issued_by_code': "Extract the department code (код подразделения) from this passport image in format XXX-XXX. Return ONLY the code, nothing else. No explanations.",
        'serial_number': "Extract the passport series and number (серия и номер) from this passport image. Format: XX XX XXXXXX. Либо возвращаешь 10 цифр в формате XX XX XXXXXX, либо пустую строку Return ONLY the series and number, nothing else. No explanations.",
        'citizenship': "Extract citizenship (гражданство) from this passport image. Return ONLY the text, nothing else. No explanations. Variants: RU, KZ, TG, UZ etc.",
    }

    doc_specific_prompts = {
        "passport_ru": default_prompts,
        "passport_uz": {
            'name': "Extract the surname from this Uzbek passport. Return ONLY the text.",
            'second_name': "Extract the first name from this Uzbek passport. Return ONLY the text.",
            'date': "Extract the birth date from this Uzbek passport in format DD.MM.YYYY. Return ONLY the date.",
            'serial_number': "Extract the passport number from this Uzbek passport. Return ONLY the number.",
        },
        "snils": {
            'snils_number': "Extract the SNILS number from this image. Format: XXX-XXX-XXX XX. Return ONLY the number, nothing else.",
            'name': "Extract the full name from this SNILS card. Return ONLY the text.",
        }
    }

    prompts = doc_specific_prompts.get(doc_type, doc_specific_prompts["passport_ru"])

    return prompts.get(class_name,
                       f"Extract text from this {class_name} field of a {doc_type} document. Return only the text.")

def get_glm_prompt(class_name: str) -> str:
    """Поле-специфичные промпты для GLM OCR.

    Важно: просим только значение поля, без JSON/markdown, чтобы результат можно было
    напрямую прогонять через _normalize_ocr_text()/validate_ocr().
    """
    prompts = {
        'name': (
            "OCR Russian passport field. Extract ONLY the given name (ИМЯ). "
            "Return uppercase Cyrillic text only. No labels, no explanations."
        ),
        'second_name': (
            "OCR Russian passport field. Extract ONLY the surname (ФАМИЛИЯ). "
            "Return uppercase Cyrillic text only. No labels, no explanations."
        ),
        'third_name': (
            "OCR Russian passport field. Extract ONLY the patronymic (ОТЧЕСТВО). "
            "Return uppercase Cyrillic text only. No labels, no explanations."
        ),
        'date': (
            "OCR Russian passport field. Extract ONLY date of birth in DD.MM.YYYY format. "
            "Return only the date. If not visible, return empty string."
        ),
        'date_issue': (
            "OCR Russian passport field. Extract ONLY issue date in DD.MM.YYYY format. "
            "Return only the date. If not visible, return empty string."
        ),
        'gender': (
            "OCR Russian passport field. Extract ONLY sex. Return exactly МУЖ or ЖЕН. "
            "No labels, no explanations."
        ),
        'issued_by_code': (
            "OCR Russian passport field. Extract ONLY department code in XXX-XXX format. "
            "Count all digits carefully. Return only the code."
        ),
        'serial_number': (
            "OCR Russian passport field. Extract ONLY passport series and number. "
            "It must contain exactly 10 digits: 4 digits series and 6 digits number. "
            "Prefer format 'XX XX XXXXXX'. Count repeated digits very carefully. "
            "Return only digits/spaces, no labels. If not visible, return empty string."
        ),
        'issued_by': (
            "OCR Russian passport field: КЕМ ВЫДАН. Extract ONLY the issuing organization text. "
            "Return ALL visible main lines in uppercase Cyrillic. Preserve abbreviations like ГУ МВД, УФМС, ОВД. "
            "Ignore watermarks, small background text, labels and the words 'ПАСПОРТ ВЫДАН'. No explanations."
        ),
        'address': (
            "OCR Russian passport field: МЕСТО РОЖДЕНИЯ. Extract ONLY the place of birth. "
            "Return ALL visible main lines in uppercase Cyrillic. Ignore watermarks, labels and small background text. "
            "No explanations."
        ),
        'citizenship': (
            "OCR Russian passport field. Extract ONLY citizenship/country code if visible. "
            "Return RU, KZ, TJ, UZ or exact visible text. No explanations."
        ),
    }
    return prompts.get(class_name, "OCR Russian passport field. Extract only exact visible text. No labels, no explanations.")

def clean_address(text):
    # Заменяем переносы строк на пробелы
    text = text.replace('\n', ' ')
    text = text.replace('ОВЛАСТИ', 'ОБЛАСТИ')
    text = text.replace('ОBЛАСТИ', 'ОБЛАСТИ')
    text = text.replace('ОBЛАСТИ', 'ОБЛАСТИ')
    text = text.replace('B', 'Б')
    text = text.replace('JL', 'Л')
    text = text.replace('Паспорт выдан', '')
    text = text.replace('паспорт выдан', '')
    text = text.replace('ПАСПОРТ ВЫДАН', '')
    # Убираем лишние пробелы (включая множественные)
    text = re.sub(r'\s+', ' ', text).strip()
    # Удаляем отдельно стоящие "РФ"
    # text = re.sub(r'\bРФ\b', '', text)
    # Снова убираем лишние пробелы и пробелы в начале/конце
    text = re.sub(r'\s+', ' ', text).strip()
    return text



def enhance_passport_for_ocr_v2(img, segment_name='none', base_dir="enhanced_v2"):
    kernel = np.ones((2, 2), np.uint8)

    h, w = img.shape[:2]
    scale = min(3000 / max(h, w), 2.0)
    resized = cv2.resize(img, None, fx=scale, fy=scale)

    gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)

    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)

    denoised = cv2.fastNlMeansDenoising(gray, None, h=25, templateWindowSize=7, searchWindowSize=21)

    blur = cv2.GaussianBlur(denoised, (0, 0), 1.0)
    sharp = cv2.addWeighted(denoised, 1.8, blur, -0.8, 0)

    bg = cv2.medianBlur(sharp, 25)
    norm = cv2.addWeighted(sharp, 1.5, bg, -0.5, 128)

    # Возвращаем нормализованное изображение (single-channel или BGR в зависимости от предыдущих шагов).
    return norm


async def ollama_vision_recognize_async(img_array: np.ndarray, class_name, prompt: str, model: str = 'qwen2.5vl:7b',
                                        output: str = '/tmp/ocr_api', base_url: str = 'http://localhost:11434') -> Tuple[str, str]:
    """Compatibility wrapper: старый vision API теперь ходит в общий GLM OCR vLLM сервис."""
    return await glm_recognize_vllm_async(img_array, class_name, prompt, output)


def ollama_vision_recognize(img_array: np.ndarray, class_name, prompt: str, model: str = 'qwen2.5vl:7b',
                            output: str = '/tmp/ocr_api', base_url: str = 'http://localhost:11434') -> Tuple[str, str]:
    """Compatibility wrapper: старый vision API теперь ходит в общий GLM OCR vLLM сервис."""
    return glm_recognize_vllm(img_array, class_name, prompt, output)


def pil_from_cv2(bgra):
    b, g, r, a = cv2.split(bgra)
    rgba = cv2.merge([r, g, b, a])
    return Image.fromarray(rgba, mode='RGBA')


def preserve_natural_artifacts(img_np):
    """Возвращает корректный BGR без альфы.

    Старый код делал cv2.COLOR_RGB2BGR для уже BGR/BGRA изображения и имел
    недостижимый PIL-блок после return. Это могло портить каналы и тратить время.
    """
    return _ensure_bgr(img_np)


def paddle_recognize(img_array, class_name="segment"):
    """Быстрое распознавание сегмента через PaddleOCR.

    Горячий путь: BGR/BGRA -> CLAHE -> 48x320 canvas -> TextRecognition.predict(np.ndarray).
    Без лишней записи файлов и без повторной нормализации.
    """
    if PaddleOCR is None or PADDLE_INSTANCE is None:
        return ("", 0.0), ""

    try:
        img_bgr = _ensure_bgr(img_array)
        prepared = preprocess_for_ocr(img_bgr)
        prepared = normalize_for_paddle_recognize(prepared)
        res = PADDLE_INSTANCE.predict(prepared)
    except BaseException as e:
        logger.warning("PaddleOCR error for %s: %s", class_name, e)
        return ("", 0.0), ""

    if not res:
        return ("", 0.0), ""

    text = str(res[0].get('rec_text', '')).strip()
    score = float(res[0].get('rec_score', 0.0) or 0.0)
    return (text, score), ""


def process_multiline_image(img_rgb, class_name):
    """
    Распознает многострочный текст с использованием детекции строк
    """

    img_rgb = preprocess_for_ocr(img_rgb)

    # оригинал (normalized)
    # img_rgb = normalize_rec_image(img_rgb)

    # 1. Сохраняем исходное изображение
    RU_DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    img_path = str(RU_DEBUG_DIR / f'current_rec_{class_name}.png')
    # norm = normalize_rec_image(img_rgb)  # Ваша функция нормализации
    norm = img_rgb  # Исходное
    cv2.imwrite(img_path, norm)
    # временно передаем в AvisionService для OCR
    return ("", 0), img_path


    try:
        # 2. Загружаем изображение для детекции
        img = cv2.imread(img_path)
        if img is None:
            raise ValueError(f"Ошибка загрузки изображения: {img_path}")

        # 3. Выполняем детекцию
        det_results = PADDLE_DETECTOR.predict(img_path)

        # Проверяем формат результата
        if not det_results or 'dt_polys' not in det_results[0]:
            print("Детекция вернула неожиданный формат. Используем fallback.")
            return _fallback_single_line(img_path)

        dt_polys = det_results[0]['dt_polys']
        dt_scores = det_results[0]['dt_scores']

        # 4. Проверяем наличие детекций
        if len(dt_polys) == 0 or len(dt_scores) == 0:
            print("Детектор не нашел строк. Используем fallback.")
            return _fallback_single_line(img_path)

        # 5. Фильтруем и сортируем строки
        min_score = 0.3
        boxes_with_scores = [
            (box, score) for box, score in zip(dt_polys, dt_scores)
            if score > min_score
        ]

        if not boxes_with_scores:
            print("Все детекции отфильтрованы по порогу. Используем fallback.")
            return _fallback_single_line(img_path)

        # Сортируем по минимальной Y-координате в полигоне
        boxes_with_scores.sort(key=lambda x: np.min(x[0][:, 1]))
        valid_boxes = [box for box, _ in boxes_with_scores]

        # 6. Обрабатываем каждую строку
        recognized_lines = []
        recognized_score = []
        for i, box in enumerate(valid_boxes):
            # Вырезаем строку с коррекцией поворота
            line_img = _crop_rotated_box(img, box)

            if line_img.size == 0 or line_img.shape[0] == 0 or line_img.shape[1] == 0:
                continue

            # Подготавливаем к формату 320x48
            processed_line = _prepare_for_recognition(line_img)

            # Сохраняем во временный файл
            line_path = img_path.replace('.png', f'_line_{i}.png')
            cv2.imwrite(line_path, processed_line)

            try:
                # Распознаем строку
                res = PADDLE_INSTANCE.predict(line_path)
                text = res[0]['rec_text']
                score = res[0]['rec_score']

                # Отладка для понимания формата
                if not text:
                    print(f"Пустой результат для строки {i}. Формат: {type(res)}")
                    print(f"Значение: {res}")

                if text.strip():  # Игнорируем пустые строки
                    recognized_lines.append(text)
                    recognized_score.append(float(score))
            finally:
                # Удаляем временный файл
                # if os.path.exists(line_path):
                #     os.remove(line_path)
                pass

        # 7. Собираем результат
        if recognized_lines:
            return (" ".join(recognized_lines), min(recognized_score)), img_path

        print("Не распознано ни одной строки. Используем fallback.")
        return _fallback_single_line(img_path)

    except Exception as e:
        print(f"Критическая ошибка в распознавании: {str(e)}")
        import traceback
        traceback.print_exc()
        return _fallback_single_line(img_path)


def _base_multiline_class_name(class_name: str) -> str:
    """Возвращает базовый class_name без индекса, сохраняя имена с подчёркиванием."""
    value = str(class_name or "")
    for known in ("issued_by", "address"):
        if value == known or value.startswith(f"{known}_"):
            return known
    return re.sub(r"_\d+$", "", value)


def _try_glm_multiline_fallback(img_bgr: np.ndarray, class_name: str) -> tuple[str, float, str] | None:
    """GLM fallback для всего многострочного crop.

    Возвращает ((text, score, source_path_marker)) или None, если GLM выключен/упал/пустой.
    Важно: сюда передаём исходный crop поля, а не нарезанные строки и не 48x320 Paddle-normalized картинку.
    """
    if not (GLM_OCR_ENABLED and MULTILINE_GLM_FALLBACK_ENABLED):
        return None

    base_class_name = _base_multiline_class_name(class_name)
    prompt = get_glm_prompt(base_class_name)

    try:
        text = call_glm_ocr_vllm(
            img_bgr,
            prompt,
            max_tokens=GLM_OCR_MAX_TOKENS_FIELD,
        )
    except Exception as exc:
        logger.warning("GLM multiline fallback failed for %s: %s", class_name, exc)
        return None

    text = clean_glm_text(text)
    if not text:
        return None

    return text, 1.0, "glm_multiline_avg_score_fallback"


def process_multiline_image_current(
    img_rgb,
    class_name,
    multiline_model,
    *,
    allow_glm_fallback: bool = True,
    provenance: dict | None = None,
):
    """Распознаёт многострочное поле.

    Быстрый путь:
      1) YOLO line-detector режет строки.
      2) PADDLE_INSTANCE_MULTILINE читает каждую строку.
      3) Если средняя уверенность строк >= MULTILINE_GLM_AVG_SCORE_THRESHOLD,
         возвращаем склеенный Paddle-текст.

    Качественный fallback:
      - если строк нет, все строки отфильтрованы, средняя уверенность < 0.98,
        или multiline-модель недоступна — отправляем ВЕСЬ исходный crop поля в GLM OCR.
      - если GLM недоступен/пустой, возвращаем лучший Paddle-вариант, чтобы не терять результат.
    """
    img_bgr = _ensure_bgr(img_rgb)
    base_class_name = _base_multiline_class_name(class_name)

    def record_paddle(text, score):
        if provenance is not None:
            provenance.update(source="PADDLE", paddle_text=text, paddle_confidence=score)

    def record_glm():
        if provenance is not None:
            provenance["source"] = "GLM"

    def maybe_glm_or_paddle_single(reason: str):
        if allow_glm_fallback:
            glm_result = _try_glm_multiline_fallback(img_bgr, base_class_name)
            if glm_result is not None:
                text, score, source = glm_result
                record_glm()
                return (text, score), source
        result = paddle_recognize(img_bgr, class_name)
        record_paddle(*result[0])
        return result

    if multiline_model is None or multiline_model == "" or PADDLE_INSTANCE_MULTILINE is None:
        (paddle_text, paddle_score), paddle_path = paddle_recognize(img_bgr, class_name)
        record_paddle(paddle_text, paddle_score)
        if (
            allow_glm_fallback
            and MULTILINE_GLM_FALLBACK_ENABLED
            and (paddle_score or 0.0) < MULTILINE_GLM_AVG_SCORE_THRESHOLD
        ):
            glm_result = _try_glm_multiline_fallback(img_bgr, base_class_name)
            if glm_result is not None:
                text, score, source = glm_result
                record_glm()
                return (text, score), source
        return (paddle_text, paddle_score), paddle_path

    try:
        height, width = img_bgr.shape[:2]
        is_vertical_image = height > width

        results = multiline_model(img_bgr, verbose=False)
        line_boxes = []
        if hasattr(results[0], 'boxes') and len(results[0].boxes) > 0:
            for i, cls_id in enumerate(results[0].boxes.cls.cpu().numpy()):
                if int(cls_id) == 0:
                    line_boxes.append(results[0].boxes.xyxy[i].cpu().numpy())

        if not line_boxes:
            return maybe_glm_or_paddle_single("no_line_boxes")

        if is_vertical_image:
            line_boxes_sorted = sorted(line_boxes, key=lambda box: (box[0], box[1]))
        else:
            line_boxes_sorted = sorted(line_boxes, key=lambda box: (box[1], box[0]))

        recognized_lines = []
        recognized_scores = []

        for idx, box in enumerate(line_boxes_sorted):
            x1, y1, x2, y2 = map(int, box[:4])
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(width, x2), min(height, y2)
            if x2 <= x1 or y2 <= y1:
                continue

            line_img = img_bgr[y1:y2, x1:x2].copy()
            if line_img.size == 0:
                continue

            line_img = preprocess_for_ocr(line_img)
            line_img = normalize_for_paddle_recognize(line_img)

            try:
                res = PADDLE_INSTANCE_MULTILINE.predict(line_img)
            except Exception as exc:
                logger.warning("Paddle multiline line OCR failed for %s line %s: %s", class_name, idx, exc)
                continue

            if not res:
                continue

            text = str(res[0].get('rec_text', '')).strip()
            score = float(res[0].get('rec_score', 0.0) or 0.0)
            if text and score >= MULTILINE_MIN_LINE_SCORE:
                recognized_lines.append(text)
                recognized_scores.append(score)

        if not recognized_lines:
            return maybe_glm_or_paddle_single("no_recognized_lines")

        paddle_text = " ".join(recognized_lines)
        avg_score = sum(recognized_scores) / len(recognized_scores)
        record_paddle(paddle_text, avg_score)

        if (
            allow_glm_fallback
            and MULTILINE_GLM_FALLBACK_ENABLED
            and avg_score < MULTILINE_GLM_AVG_SCORE_THRESHOLD
        ):
            glm_result = _try_glm_multiline_fallback(img_bgr, base_class_name)
            if glm_result is not None:
                text, score, source = glm_result
                record_glm()
                return (text, score), source

        # Возвращаем именно average score, как просили, а не min score.
        return (paddle_text, avg_score), "paddle_multiline_avg_score"

    except Exception as exc:
        logger.warning("Multiline OCR failed for %s: %s", class_name, exc)
        return maybe_glm_or_paddle_single("multiline_exception")


# --- Вспомогательные функции ---

def _crop_rotated_box(img, box):
    """Вырезает текстовый регион по полигону без поворота"""
    box = np.array(box, dtype=np.int32)
    x, y, w, h = cv2.boundingRect(box)
    cropped = img[y:y + h, x:x + w]
    return cropped


def _prepare_for_recognition(img):
    """Приводит изображение к формату 320x48 с сохранением пропорций"""
    h, w = img.shape[:2]
    if h == 0 or w == 0:
        return np.ones((48, 320, 3), dtype=np.uint8) * 255

    # Сохраняем пропорции: масштабируем по высоте до 48px
    ratio = 48 / h
    new_w = int(w * ratio)

    # Защищаемся от экстремальных размеров
    MAX_WIDTH = 3000
    new_w = min(new_w, MAX_WIDTH)

    # Ресайз с сохранением пропорций
    resized = cv2.resize(img, (new_w, 48), interpolation=cv2.INTER_AREA)

    # Добавляем белые поля для достижения 320px
    if new_w < 320:
        pad = np.ones((48, 320 - new_w, 3), dtype=np.uint8) * 255
        output = np.hstack((resized, pad))
    else:
        output = cv2.resize(resized, (320, 48), interpolation=cv2.INTER_AREA)

    return output[:48, :320]  # Гарантируем точные размеры


def _fallback_single_line(img_path):
    """Резервный вариант: обрабатываем всё изображение как одну строку"""
    try:
        res = PADDLE_INSTANCE.predict(img_path)
        return (res[0]['rec_text'], res[0]['rec_score']), img_path
    except Exception as e:
        print(f"Ошибка fallback-распознавания: {str(e)}")
        return "", img_path


async def paddle_recognize_async(img_array, class_name="segment"):
    """Асинхронная обертка"""
    return await asyncio.to_thread(paddle_recognize, img_array, class_name)


# --------------------------- parsing helpers --------------------------------
def parse_serial_number(text: str):
    """
    Парсит строку, содержащую серию и номер паспорта.
    Возвращает (series, number) или (None, None) если не удалось извлечь.
    Поддерживает несколько форматов (с пробелами, без, слитно).
    """
    if not text:
        return None, None
    cleaned = re.sub(r'[^\d\s]', '', text)
    parts = cleaned.split()
    if len(parts) >= 2:
        if len(parts[0]) == 2 and len(parts[1]) == 2:
            series = f"{parts[0]} {parts[1]}"
            number = ''.join(parts[2:]) if len(parts) > 2 else None
        elif len(parts[0]) == 4:
            series = f"{parts[0][:2]} {parts[0][2:]}"
            number = ''.join(parts[1:])
        else:
            all_digits = ''.join(parts)
            if len(all_digits) >= 4:
                series = f"{all_digits[:2]} {all_digits[2:4]}"
                number = all_digits[4:10] if len(all_digits) > 4 else None
            else:
                return None, None
        return series, number
    digits = ''.join(parts)
    if len(digits) >= 10:
        series = f"{digits[:2]} {digits[2:4]}"
        number = digits[4:10]
        return series, number
    return None, None


def parse_remaining_text(text: str):
    """
    Анализирует текст (например, результат общего OCR) и пытается извлечь
    поля citizenship, date_issue, issued_by_code, issued_by и т.д.
    Возвращает словарь найденных полей.
    """
    fields = {}
    if not text:
        return fields
    parts = [p.strip() for p in text.split('|') if p.strip()]
    for part in parts:
        if 'РОССИЙСКАЯ ФЕДЕРАЦИЯ' in part.upper():
            fields['citizenship'] = 'RU'
        date_match = re.search(r'\b(\d{2}\.\d{2}\.\d{4})\b', part)
        if date_match:
            fields['date_issue'] = date_match.group(1)
        code_match = re.search(r'\b(\d{3}-\d{3})\b', part)
        if code_match:
            fields['issued_by_code'] = code_match.group(1)
        if ('РОССИЙСКАЯ ФЕДЕРАЦИЯ' not in part.upper() and
                not re.search(r'\d{2}\.\d{2}\.\d{4}', part) and
                not re.search(r'\d{3}-\d{3}', part) and
                not re.search(r'\b\d{2}\s?\d{2}\s?\d{6}\b', part) and
                not re.match(r'^\d+$', part) and
                len(part) > 3):
            # предполагаем, что это текст "кем выдан" или похожее
            if 'issued_by' in fields:
                fields['issued_by'] = fields['issued_by'] + ' ' + part
            else:
                fields['issued_by'] = part
    if 'issued_by' in fields:
        fields['issued_by'] = ' '.join(fields['issued_by'].split())
    return fields


# --------------------------- Mask helpers ----------------------------------
def create_exclusion_mask(img_shape, segment_bboxes):
    """
    Создаёт маску (white=255 everywhere except black=0 внутри bbox'ов),
    которую можно применять, чтобы "убрать" уже распознанные сегменты.
    """
    mask = np.ones(img_shape[:2], dtype=np.uint8) * 255
    for (x1, y1, x2, y2) in segment_bboxes:
        mask[y1:y2, x1:x2] = 0
    return mask


def extract_remaining_image(img, mask):
    """
    Применяет маску к изображению — возвращает изображение только из областей, где mask != 0.
    """
    return cv2.bitwise_and(img, img, mask=mask)


def ensure_min_size(image_array, min_size=48):
    """
    Увеличивает изображение (numpy array), чтобы обе стороны были >= min_size,
    сохраняя пропорции. Возвращает изменённый numpy array.
    Это полезно перед подачей маленьких кусочков в OCR.
    """
    if len(image_array.shape) == 3:
        h, w, _ = image_array.shape
    else:
        h, w = image_array.shape

    if w >= min_size and h >= min_size:
        return image_array

    scale = min_size / min(w, h)
    new_w = int(w * scale)
    new_h = int(h * scale)

    resized_img = cv2.resize(image_array, (new_w, new_h), interpolation=cv2.INTER_LANCZOS4)

    return resized_img


# --------------------------- Core processing -------------------------------
async def process_images_list_async(work_images: List[dict], model, ollama_model: str, ollama_url: str, doc_type: str,
                                    output_dir: Optional[str] = None, ocr_engine: str = 'qwen2.5vl:7b',
                                    debug: bool = False):
    """
    Асинхронная версия основной функции обработки списка изображений.
    Все legacy vision-запросы выполняются конкурентно с ограничением в 4 одновременных запроса (через семафор).
    """
    all_recognized_fields = {}
    all_segment_info = []

    timings = {
        'total_start': perf_counter(),
        'images': [],
    }

    for item in work_images:
        img_cv = item['img']
        img_name = item.get('name', 'input')
        img_t0 = perf_counter() if debug else None
        image_timing = {'name': img_name, 'stages': {}}

        # find and crop (deskew) document - синхронная операция
        if debug:
            tmp = tempfile.NamedTemporaryFile(suffix='.png', prefix=f"{img_name}_", dir=output_dir, delete=False)
            tmpf = tmp.name
            cv2.imwrite(tmpf, img_cv)
            t0 = perf_counter()
        warped, _ = await asyncio.to_thread(find_and_crop_document, img_cv)
        if debug:
            image_timing['stages']['find_and_crop'] = perf_counter() - t0

        if warped is None:
            warped = img_cv

        if debug:
            tmp = tempfile.NamedTemporaryFile(suffix='.png', prefix=f"{img_name}_warped_", dir=output_dir, delete=False)
            tmpf = tmp.name
            cv2.imwrite(tmpf, warped)

        segments = None
        # try YOLO segmentation
        if model is not None:
            if debug:
                t0 = perf_counter()
            try:
                segments = run_yolo_segments_from_array(warped, model)
            except Exception as e:
                segments = None
                if debug:
                    image_timing['stages']['yolo_exception'] = str(e)
            if debug:
                image_timing['stages']['yolo_segmentation'] = perf_counter() - t0

        # Если сегменты отсутствуют, делаем единый OCR на всю страницу
        if not segments:
            continue
            if debug:
                t0 = perf_counter()
            remaining_prompt = ("This is a Russian passport page. Extract visible fields like "
                                "issue_date, citizenship, issued by, code. "
                                "Return only the extracted text, separate multiple fields with |.")
            remaining_text, file_path = await ollama_vision_recognize_async(warped, 'full', remaining_prompt,
                                                                            ollama_model, output_dir, ollama_url)
            if debug:
                image_timing['stages']['ollama_full_page'] = perf_counter() - t0
                image_timing['stages']['ollama_full_page_path'] = file_path
            if remaining_text:
                remaining_fields = parse_remaining_text(remaining_text)
                for k, v in remaining_fields.items():
                    if k not in all_recognized_fields or not all_recognized_fields[k]:
                        all_recognized_fields[k] = v
                all_segment_info.append({'file_path': file_path, 'class': 'full', 'recognized_text': remaining_text})
            timings['images'].append(image_timing)
            continue

        # Если есть сегменты — собираем все задачи для конкурентного выполнения
        segment_bboxes = []
        page_fields = {}
        if debug:
            image_timing['stages']['segments_count'] = sum(len(v) for v in segments.values())
            image_timing['segments'] = []

        # Собираем все задачи распознавания сегментов
        recognition_tasks = []
        task_metadata = []

        for class_name, items in segments.items():
            # сегменты, маску которых не будем вырезать
            if class_name in ['document']:
                continue
            # сегменты, которые вырезаем, но не отправляем на распознавание
            if class_name in ['MRZ']:
                for seg in items:
                    segment_bboxes.append(seg['bbox'])
                continue

            for idx, seg in enumerate(items):
                seg_img = seg['image']
                bbox = seg['bbox']
                segment_bboxes.append(bbox)
                prompt = create_segment_prompt(class_name, doc_type=doc_type)
                seg_img = ensure_min_size(seg_img)

                # Поворот при необходимости
                h_c, w_c = seg_img.shape[:2]
                if w_c < h_c:
                    seg_img = cv2.rotate(seg_img, cv2.ROTATE_90_COUNTERCLOCKWISE)

                # seg_img = PassportEnhancer().enhance_segment(seg_img)['grayscale_enhanced']
                # seg_img = enhance_passport_for_ocr_v2(seg_img)

                # if class_name != 'name':
                #     continue

                # Создаём задачу
                if ocr_engine in {'tr', 'avito_vision', 'glm'}:
                    # Старые движки отключены; для совместимости используем общий GLM OCR сервис.
                    task = glm_recognize_vllm_async(seg_img, f"{class_name}_{idx}", prompt, output_dir)
                elif ocr_engine == 'paddle':
                    # PaddleOCR — без prompt
                    task = paddle_recognize_async(seg_img, f"{class_name}_{idx}")
                else:
                    # legacy vision-путь через общий GLM OCR
                    task = ollama_vision_recognize_async(seg_img, f"{class_name}_{idx}", prompt,
                                                         ollama_model, output_dir, ollama_url)
                recognition_tasks.append(task)
                task_metadata.append({
                    'class_name': class_name,
                    'idx': idx,
                    'bbox': bbox,
                    'start_time': perf_counter() if debug else None
                })

        # Запускаем все задачи конкурентно
        if recognition_tasks:
            if debug:
                tasks_start = perf_counter()

            results = await asyncio.gather(*recognition_tasks, return_exceptions=True)

            if debug:
                image_timing['stages']['all_segments_recognition'] = perf_counter() - tasks_start

            # Обрабатываем результаты
            for result, metadata in zip(results, task_metadata):
                class_name = metadata['class_name']
                idx = metadata['idx']
                bbox = metadata['bbox']

                if isinstance(result, Exception):
                    print(f"Error recognizing {class_name}_{idx}: {result}")
                    recognized_text = ""
                    file_path = output_dir or "/tmp/ocr_api"
                else:
                    recognized_text, file_path = result

                if debug:
                    seg_timing = {
                        'class': class_name,
                        'index': idx,
                        'bbox': bbox,
                        'ollama_path': file_path,
                    }
                    if metadata['start_time']:
                        seg_timing['completed_at'] = perf_counter() - metadata['start_time']
                    image_timing['segments'].append(seg_timing)

                # Маппинг в поля
                if class_name in SEGMENT_TO_FIELD_MAP:
                    field_name = SEGMENT_TO_FIELD_MAP[class_name]
                    if class_name == 'serial_number':
                        series, number = parse_serial_number(recognized_text)
                        if series:
                            page_fields['series'] = series
                        if number:
                            page_fields['number'] = number
                    else:
                        if recognized_text:
                            page_fields[field_name] = recognized_text if idx == 0 else (
                                page_fields[field_name] if page_fields[field_name] else recognized_text)

                all_segment_info.append({
                    'file_path': file_path,
                    'class': class_name,
                    'recognized_text': recognized_text,
                    'bbox': bbox
                })

        # merge page fields
        all_recognized_fields.update({k: v for k, v in page_fields.items() if v})

        # Обработка оставшихся областей (исключая уже распознанные bboxes)
        # if segment_bboxes:
        #     if debug:
        #         t0 = perf_counter()
        #     mask = create_exclusion_mask(warped.shape, segment_bboxes)
        #     remaining_img = extract_remaining_image(warped, mask)
        #     remaining_prompt = ("This is a Russian passport page with some fields already recognized. "
        #                         "Extract any remaining visible text fields like citizenship, place of birth, issued by. "
        #                         "Return only the extracted text. If you see multiple fields, separate them with |. Возвращай ВЕСЬ распознанный текст")
        #     remaining_text, file_path = await ollama_vision_recognize_async(remaining_img, 'remaining',
        #                                                                     remaining_prompt, ollama_model, output_dir,
        #                                                                     ollama_url)
        #     if debug:
        #         image_timing['stages']['ollama_remaining'] = perf_counter() - t0
        #         image_timing['stages']['ollama_remaining_path'] = file_path
        #     if remaining_text:
        #         remaining_fields = parse_remaining_text(remaining_text)
        #         for key, value in remaining_fields.items():
        #             if key not in all_recognized_fields or not all_recognized_fields[key]:
        #                 all_recognized_fields[key] = value
        #         all_segment_info.append(
        #             {'file_path': file_path, 'class': 'remaining', 'recognized_text': remaining_text})

        if debug:
            image_timing['stages']['image_total'] = perf_counter() - img_t0
            timings['images'].append(image_timing)

    # попытаемся влить распознанные поля в Pydantic-модель
    try:
        passport = RussianPassport(**all_recognized_fields)
        data = passport.model_dump()
    except Exception as e:
        data = all_recognized_fields
        # включаем информацию о валид. ошибке в вывод, если она есть
        if debug:
            timings['validation_error'] = str(e)

    if debug:
        timings['total_time'] = perf_counter() - timings['total_start']
        return {'data': data, 'segments_info': all_segment_info, 'timings': timings}
    else:
        return {'data': data, 'segments_info': all_segment_info}


def process_images_list(work_images: List[dict], model, ollama_model: str, ollama_url: str, doc_type: str,
                        output_dir: Optional[str] = None, ocr_engine: str = 'qwen2.5vl:7b', debug: bool = False):
    """
    Основная функция обработки списка изображений:
    - Для каждой картинки: выравнивает документ, запускает сегментацию (YOLO),
      для каждого сегмента вызывает OCRв зависимости от ocr_engine и маппит результат в поля паспорта.
    - Если сегменты не найдены — делает общий OCR по всей странице.
    - Собирает информацию о каждом сегменте (file_path, class, recognized_text).
    - Если debug=True — ведёт подробный лог таймингов для каждого шага и возвращает их в результирующем словаре под 'timings'.
    Возвращает {'data': ..., 'segments_info': ..., 'timings': ... (опционально)}
    """
    all_recognized_fields = {}
    all_segment_info = []

    timings = {
        'total_start': perf_counter(),
        'images': [],  # список таймингов по каждой обработанной картинке
    }

    for item in work_images:
        img_cv = item['img']
        img_name = item.get('name', 'input')
        img_t0 = perf_counter() if debug else None
        image_timing = {'name': img_name, 'stages': {}}

        # find and crop (deskew) document
        if debug:
            t0 = perf_counter()
        warped, _ = find_and_crop_document(img_cv)
        if debug:
            image_timing['stages']['find_and_crop'] = perf_counter() - t0

        if warped is None:
            warped = img_cv

        segments = None
        # try YOLO segmentation
        if model is not None:
            if debug:
                t0 = perf_counter()
            try:
                segments = run_yolo_segments_from_array(warped, model)
            except Exception as e:
                segments = None
                if debug:
                    image_timing['stages']['yolo_exception'] = str(e)
            if debug:
                image_timing['stages']['yolo_segmentation'] = perf_counter() - t0

        # Если сегменты отсутствуют, делаем единый OCR на всю страницу
        if not segments:
            continue
            if debug:
                t0 = perf_counter()

            # Выбор метода OCR в зависимости от ocr_engine
            if ocr_engine == 'paddle':
                # Для PaddleOCR без prompt
                remaining_text, file_path = paddle_recognize(warped, 'full')
            else:
                # legacy vision-путь через общий GLM OCR
                remaining_prompt = ("This is a Russian passport page. Extract visible fields like "
                                    "issue_date, citizenship, issued by, code. "
                                    "Return only the extracted text, separate multiple fields with |.")
                remaining_text, file_path = ollama_vision_recognize(warped, 'full', remaining_prompt, ollama_model,
                                                                    output_dir, ollama_url)
            if debug:
                image_timing['stages']['ocr_full_page'] = perf_counter() - t0
                image_timing['stages']['ocr_full_page_path'] = file_path
            if remaining_text:
                remaining_fields = parse_remaining_text(remaining_text)
                for k, v in remaining_fields.items():
                    if k not in all_recognized_fields or not all_recognized_fields[k]:
                        all_recognized_fields[k] = v
                all_segment_info.append({'file_path': file_path, 'class': 'full', 'recognized_text': remaining_text})
            timings['images'].append(image_timing)
            continue

        # Если есть сегменты — по каждому сегменту вызываем OCR
        segment_bboxes = []
        page_fields = {}
        if debug:
            image_timing['stages']['segments_count'] = sum(len(v) for v in segments.values())

        for class_name, items in segments.items():
            # сегменты, маску которых не будем вырезать
            if class_name in ['document']:
                continue
            # сегменты, которые вырезаем, но не отправляем на распознавание
            if class_name in ['MRZ']:
                for seg in items:
                    segment_bboxes.append(seg['bbox'])
                continue
            for idx, seg in enumerate(items):
                seg_t0 = perf_counter() if debug else None
                seg_img = seg['image']
                bbox = seg['bbox']
                segment_bboxes.append(bbox)
                prompt = create_segment_prompt(class_name, doc_type=doc_type)
                seg_img = ensure_min_size(seg_img)
                # Поворот при необходимости
                h_c, w_c = seg_img.shape[:2]
                if w_c < h_c:
                    seg_img = cv2.rotate(seg_img, cv2.ROTATE_90_COUNTERCLOCKWISE)

                if debug:
                    t0 = perf_counter()

                # Выбор метода OCR в зависимости от ocr_engine
                if ocr_engine in {'tr', 'avito_vision', 'glm'}:
                    # Старые движки отключены; для совместимости используем общий GLM OCR сервис.
                    recognized_text, file_path = glm_recognize_vllm(seg_img, f"{class_name}_{idx}", prompt, output_dir)
                elif ocr_engine == 'paddle':
                    # PaddleOCR — без prompt
                    recognized_text, file_path = paddle_recognize(seg_img, f"{class_name}_{idx}")
                else:
                    # legacy vision-путь через общий GLM OCR
                    recognized_text, file_path = ollama_vision_recognize(seg_img, f"{class_name}_{idx}", prompt,
                                                                         ollama_model, output_dir, ollama_url)
                if debug:
                    dt = perf_counter() - t0
                    image_timing.setdefault('segments', []).append({
                        'class': class_name,
                        'index': idx,
                        'bbox': bbox,
                        'ocr_time': dt,
                        'ocr_path': file_path,
                    })

                if class_name in SEGMENT_TO_FIELD_MAP:
                    field_name = SEGMENT_TO_FIELD_MAP[class_name]
                    if class_name == 'serial_number':
                        series, number = parse_serial_number(recognized_text)
                        if series:
                            page_fields['series'] = series
                        if number:
                            page_fields['number'] = number
                    else:
                        if recognized_text:
                            page_fields[field_name] = recognized_text
                all_segment_info.append(
                    {'file_path': file_path, 'class': class_name, 'recognized_text': recognized_text, 'bbox': bbox})

        # merge page fields
        all_recognized_fields.update({k: v for k, v in page_fields.items() if v})

        # Обработка оставшихся областей (исключая уже распознанные bboxes)
        # if segment_bboxes:
        #     if debug:
        #         t0 = perf_counter()
        #    mask = create_exclusion_mask(warped.shape, segment_bboxes)
        #     remaining_img = extract_remaining_image(warped, mask)
        #
        #     # Выбор метода OCR в зависимости от ocr_engine
        #     if ocr_engine == 'paddle':
        #         # Для PaddleOCR без prompt
        #         remaining_text, file_path = paddle_recognize(remaining_img, 'remaining')
        #     else:
        ## legacy vision-путь через общий GLM OCR
        #         remaining_prompt = ("This is a Russian passport page with some fields already recognized. "
        #                             "Extract any remaining visible text fields like citizenship, place of birth, issued by. "
        #                             "Return only the extracted text. If yousee multiplefields, separate them with |.")
        #         remaining_text, file_path = ollama_vision_recognize(remaining_img, 'remaining', remaining_prompt, ollama_model, output_dir, ollama_url)
        #
        #     if debug:
        #         image_timing['stages']['ocr_remaining'] = perf_counter() - t0
        #         image_timing['stages']['ocr_remaining_path'] = file_path
        #     if remaining_text:
        #         remaining_fields = parse_remaining_text(remaining_text)
        #         for key, value in remaining_fields.items():
        #            if keynot in all_recognized_fields or not all_recognized_fields[key]:
        #                 all_recognized_fields[key] = value
        #         all_segment_info.append({'file_path': file_path, 'class': 'remaining', 'recognized_text': remaining_text})

        if debug:
            image_timing['stages']['image_total'] = perf_counter() - img_t0
            timings['images'].append(image_timing)

    # попытаемся влить распознанные поля в Pydantic-модель
    try:
        passport = RussianPassport(**all_recognized_fields)
        data = passport.model_dump()
    except Exception as e:
        data = all_recognized_fields
        # включаем информацию о валид. ошибке в вывод, если она есть
        if debug:
            timings['validation_error'] = str(e)

    if debug:
        timings['total_time'] = perf_counter() - timings['total_start']
        return {'data': data, 'segments_info': all_segment_info, 'timings': timings}
    else:
        return {'data': data, 'segments_info': all_segment_info}


OCR_HEIGHT = 48  # модель тренировалась на таком датасете
OCR_MAX_WIDTH = 320  # ограничение ширины; остаток — паддинг


def _count_useful_paddle_segments(segments):
    if not segments:
        return 0
    return sum(len(crops) for cls, crops in segments.items() if cls in OCR_SEGMENT_CLASSES)


def _run_paddle_ocr_for_segment(
    img,
    class_name,
    idx,
    multiline_model,
    *,
    allow_multiline_glm_fallback: bool = True,
    provenance: dict | None = None,
):
    if class_name in ['issued_by', 'address']:
        return process_multiline_image_current(
            img,
            class_name,
            multiline_model,
            allow_glm_fallback=allow_multiline_glm_fallback,
            provenance=provenance,
        )
    result = paddle_recognize(img, f"{class_name}_{idx}")
    if provenance is not None:
        provenance.update(source="PADDLE", paddle_text=result[0][0], paddle_confidence=result[0][1])
    return result


def _normalize_ocr_text(doc_type, class_name, text):
    if not text:
        return ""
    if class_name in ['address', 'issued_by']:
        text = clean_address(text)
    fixed_text = fix_ocr(doc_type, class_name, text)
    return fixed_text or ""


def _is_acceptable_ocr_result(doc_type, class_name, text, score, paddle_score_threshold):
    if score is None:
        return False
    return score >= paddle_score_threshold and validate_ocr(doc_type, class_name, text)


def process_images_list_paddle(
        work_images: List[dict],
        model,
        multiline_model,
        ollama_model: str,
        ollama_url: str,
        doc_type: str,
        output_dir: Optional[str] = None,
        ocr_engine: str = 'qwen2.5vl:7b',
        debug: bool = False,
        no_llm: bool = False,
        paddle_score_threshold: float = 0.85  # Новый параметр
):
    all_recognized_fields = {}
    all_ocr_fields = {}
    all_segment_info = []
    timings = {'images': []} if debug else None
    total_start = perf_counter() if debug else None

    for item in work_images:
        img_t0 = perf_counter() if debug else None
        img_cv = item.get('img')
        img_name = item.get('name', 'input')
        segments = None
        pdf_page_timings = []
        selected_page = None
        pdf_pages_checked = None

        if item.get('source_type') == 'pdf':
            pdf_path = item['path']
            page_count = item.get('page_count') or get_pdf_page_count(pdf_path)
            pdf_pages_checked = 0

            for page_index in range(page_count):
                page_timing = {
                    'page': page_index + 1,
                    'pdf_page_skipped_no_segments': True,
                }

                extract_t0 = perf_counter() if debug else None
                page_images = extract_pdf_page_image(
                    pdf_path,
                    page_index,
                    max_w=DEFAULT_MAX_W,
                    max_h=DEFAULT_MAX_H,
                    initial_dpi=item.get('dpi', 500),
                )
                if debug:
                    page_timing['pdf_page_extract'] = perf_counter() - extract_t0

                pdf_pages_checked += 1
                if not page_images:
                    if debug:
                        page_timing['segments_count'] = 0
                        pdf_page_timings.append(page_timing)
                    continue

                page_image = page_images[0]
                img_cv = page_image['img']
                img_name = page_image.get('name', f"{item.get('name', 'pdf')}_page{page_index + 1}")

                if debug:
                    img_path = os.path.join(output_dir or '/tmp', f'current_rec_0_main_page{page_index + 1}.png')
                    cv2.imwrite(img_path, img_cv)

                segment_t0 = perf_counter() if debug else None
                segments = run_yolo_segments_from_array_paddle(img_cv, model) if model else None
                useful_segments_count = _count_useful_paddle_segments(segments)
                if debug:
                    page_timing['yolo_time'] = perf_counter() - segment_t0
                    page_timing['segments_count'] = useful_segments_count

                if useful_segments_count > 6:
                    selected_page = page_index + 1
                    if debug:
                        page_timing['pdf_page_skipped_no_segments'] = False
                        pdf_page_timings.append(page_timing)
                    break

                if debug:
                    pdf_page_timings.append(page_timing)
        else:
            # Обработка документа (пытается из всей страницы взть только прямоугольник паспорта)
            # warped, _ = find_and_crop_document(img_cv) or (img_cv, None)

            # Сегментация
            if debug:
                img_path = os.path.join(output_dir or '/tmp', f'current_rec_0_main.png')
                cv2.imwrite(img_path, img_cv)
            segments = run_yolo_segments_from_array_paddle(img_cv, model) if model else None

        if _count_useful_paddle_segments(segments) == 0:
            full_page_fields = {}
            full_page_error = None
            used_full_page_glm = False

            if not no_llm and GLM_OCR_ENABLED:
                try:
                    full_page_fields = glm_ocr_russian_passport_json(img_cv)
                    used_full_page_glm = True
                    all_recognized_fields.update({k: v for k, v in full_page_fields.items() if v})
                    for name, value in full_page_fields.items():
                        if value:
                            all_ocr_fields[name] = dict(name=name, value=value, source="GLM", paddle_text=None, paddle_confidence=None)
                    all_segment_info.append({
                        'class': 'full_page_glm',
                        'recognized_text': json.dumps(full_page_fields, ensure_ascii=False),
                        'score': 1.0,
                        'file_path': _save_debug_image(img_cv, 'full_page', output_dir, prefix='glm_full') if debug else '',
                    })
                except Exception as exc:
                    full_page_error = str(exc)

            if debug:
                image_timing = {
                    'name': img_name,
                    'segments_count': 0,
                    'fallback_count': 1 if used_full_page_glm else 0,
                    'full_page_glm_used': used_full_page_glm,
                    'full_page_glm_error': full_page_error,
                    'segment_timings': [],
                    'total_time': perf_counter() - img_t0,
                }
                if item.get('source_type') == 'pdf':
                    image_timing.update({
                        'source_type': 'pdf',
                        'pdf_pages_checked': pdf_pages_checked,
                        'selected_page': selected_page,
                        'pdf_page_timings': pdf_page_timings,
                    })
                timings['images'].append(image_timing)
            continue

        page_fields = {}
        segment_info = []

        # Обработка сегментов
        for class_name, crops in segments.items():
            if class_name in ('document', 'MRZ'):  # Пропускаем служебные классы
                continue

            if class_name not in OCR_SEGMENT_CLASSES:
                continue

            #prompt = create_segment_prompt(class_name, doc_type)
            prompt = get_glm_prompt(class_name)

            for idx, crop in enumerate(crops):
                ocr_t0 = perf_counter() if debug else None
                # prep = preprocess_for_ocr(crop)
                #
                # # оригинал (normalized)
                # processed = normalize_rec_image(prep)
                # processed = ensure_min_size(crop.copy())  # Защита от модификации оригинала
                processed = crop

                provenance = dict(source="GLM", paddle_text=None, paddle_confidence=None)
                primary_paddle_ocr = False
                if ocr_engine == 'paddle':
                    primary_paddle_ocr = True
                    (text, score), img_path = _run_paddle_ocr_for_segment(
                        processed, class_name, idx, multiline_model,
                        allow_multiline_glm_fallback=not no_llm,
                        provenance=provenance,
                    )
                elif ocr_engine == 'paddle_GLM':
                    if class_name in GLM_DIRECT_FIELDS:
                        (text, score), img_path = glm_recognize_with_score_vllm(
                            processed, class_name, prompt, output_dir
                        )
                    else:
                        primary_paddle_ocr = True
                        (text, score), img_path = _run_paddle_ocr_for_segment(
                            processed, class_name, idx, multiline_model,
                            allow_multiline_glm_fallback=not no_llm,
                            provenance=provenance,
                        )
                elif ocr_engine in {'tr', 'avito_vision', 'glm'}:
                    text, img_path = glm_recognize_vllm(processed, f"{class_name}_{idx}", prompt, output_dir)
                    score = 1.0
                else:
                    text, img_path = glm_recognize_vllm(processed, f"{class_name}_{idx}", prompt, output_dir)
                    score = 1.0

                text = _normalize_ocr_text(doc_type, class_name, text)

                # НОВАЯ ЛОГИКА: Проверка score и fallback на 180° rotation / GLM OCR
                used_fallback = False
                before_fallback_text = text
                used_rotation_fallback = False
                before_rotation_text = text
                before_rotation_score = score
                rotation_fallback_text = None
                rotation_fallback_score = None

                primary_ok = _is_acceptable_ocr_result(doc_type, class_name, text, score, paddle_score_threshold)
                if primary_paddle_ocr and not primary_ok:
                    rotated_provenance = {}
                    rotated = cv2.rotate(processed, cv2.ROTATE_180)
                    (rotated_text, rotated_score), rotated_path = _run_paddle_ocr_for_segment(
                        rotated, class_name, idx, multiline_model,
                        allow_multiline_glm_fallback=False,
                        provenance=rotated_provenance,
                    )
                    rotated_text = _normalize_ocr_text(doc_type, class_name, rotated_text)
                    rotation_fallback_text = rotated_text
                    rotation_fallback_score = rotated_score
                    rotated_ok = _is_acceptable_ocr_result(
                        doc_type, class_name, rotated_text, rotated_score, paddle_score_threshold
                    )

                    if rotated_ok or (
                            not validate_ocr(doc_type, class_name, text)
                            and (rotated_score or 0) > (score or 0)
                    ):
                        text = rotated_text
                        score = rotated_score
                        img_path = rotated_path
                        provenance = rotated_provenance
                        used_rotation_fallback = True
                        primary_ok = rotated_ok

                before_fallback_text = text
                if ocr_engine in {'paddle', 'paddle_GLM'} and primary_paddle_ocr and not no_llm and not primary_ok:
                    if debug:
                        print(
                            f"[FALLBACK] Segment {class_name}_{idx}: score {score:.3f} < {paddle_score_threshold} or bad validate_ocr, retrying with GLM OCR")

                    fallback_t0 = perf_counter() if debug else None
                    try:
                        # Повторное распознавание через общий GLM OCR vLLM сервис
                        ollama_text, ollama_path = glm_recognize_vllm(processed, class_name, prompt, output_dir)

                        glm_text_norm = _normalize_ocr_text(doc_type, class_name, ollama_text)
                        glm_valid = validate_ocr(doc_type, class_name, glm_text_norm)
                        paddle_valid = validate_ocr(doc_type, class_name, text)

                        if glm_text_norm and (glm_valid or not paddle_valid or (score or 0.0) < paddle_score_threshold):
                            text = glm_text_norm
                            img_path = ollama_path
                            score = 1.0  # GLM не возвращает score, помечаем как max
                            provenance["source"] = "GLM"
                            used_fallback = True

                        if debug:
                            fallback_time = perf_counter() - fallback_t0
                            print(
                                f"[FALLBACK] Completed in {fallback_time:.3f}s: '{ollama_text}', "
                                f"accepted={used_fallback}"
                            )

                    except Exception as e:
                        if debug:
                            print(f"[FALLBACK] Error: {e}, keeping PaddleOCR result")

                # Сохранение результатов
                if class_name in SEGMENT_TO_FIELD_MAP:
                    field = SEGMENT_TO_FIELD_MAP[class_name]
                    if class_name == 'serial_number':
                        series, number = parse_serial_number(text)
                        if series: page_fields['series'] = series
                        if number: page_fields['number'] = number
                    elif text:
                        page_fields[field] = text

                segment_info.append({
                    'provenance': provenance,
                    'class': class_name,
                    'recognized_text': text,
                    'score': score,
                    'file_path': img_path,
                    'ocr_time': perf_counter() - ocr_t0 if debug else None,
                    'used_fallback': used_fallback,  # Новое поле для отладки
                    'before_fallback_text': before_fallback_text,  # Новое поле для отладки
                    'used_rotation_fallback': used_rotation_fallback,
                    'before_rotation_text': before_rotation_text,
                    'before_rotation_score': before_rotation_score,
                    'rotation_fallback_text': rotation_fallback_text,
                    'rotation_fallback_score': rotation_fallback_score
                })

        # Выбор лучших сегментов по классам
        best_by_class = {}
        for seg in segment_info:
            cls = seg['class']
            if cls not in best_by_class or seg['score'] > best_by_class[cls]['score']:
                best_by_class[cls] = seg

        # Заполнение page_fields только из лучших сегментов
        for class_name, seg in best_by_class.items():
            if class_name in SEGMENT_TO_FIELD_MAP:
                field = SEGMENT_TO_FIELD_MAP[class_name]
                text = seg['recognized_text']
                if class_name == 'serial_number':
                    series, number = parse_serial_number(text)
                    if series:
                        page_fields['series'] = series
                    if number:
                        page_fields['number'] = number
                if class_name in ['name', 'second_name', 'third_name']:
                    page_fields[field] = text.title()
                elif text:
                    page_fields[field] = text

        for class_name, seg in best_by_class.items():
            names = ['series', 'number'] if class_name == 'serial_number' else [SEGMENT_TO_FIELD_MAP.get(class_name)]
            for name in names:
                if name and page_fields.get(name):
                    all_ocr_fields[name] = dict(name=name, value=page_fields[name], **seg['provenance'])

        # Финальная агрегация
        all_recognized_fields.update({k: v for k, v in page_fields.items() if v})
        all_segment_info.extend(segment_info)

        # Тайминги для отладки
        if debug:
            img_time = perf_counter() - img_t0
            fallback_count = sum(1 for info in segment_info if info.get('used_fallback', False))
            image_timing = {
                'name': img_name,
                'segments_count': _count_useful_paddle_segments(segments),
                'fallback_count': fallback_count,
                'segment_timings': [info for info in segment_info if 'ocr_time' in info],
                'total_time': img_time
            }
            if item.get('source_type') == 'pdf':
                image_timing.update({
                    'source_type': 'pdf',
                    'pdf_pages_checked': pdf_pages_checked,
                    'selected_page': selected_page,
                    'pdf_page_timings': pdf_page_timings,
                })
            timings['images'].append(image_timing)

    # Валидация результатов
    try:
        passport = RussianPassport(**all_recognized_fields)
        result_data = passport.model_dump()
    except Exception as e:
        result_data = all_recognized_fields
        if debug:
            timings['validation_error'] = str(e)

    # Формирование ответа
    result = {'data': result_data, 'segments_info': all_segment_info, 'ocr_fields': list(all_ocr_fields.values())}
    if debug:
        result['timings'] = {
            **timings,
            'total_time': perf_counter() - total_start
        }
    return result

async def process_images_list_parse_birthday(
        work_images: List[dict],
        output_dir: Optional[str] = None,
        debug: bool = False,
):
    total_start = perf_counter() if debug else None
    results = []
    prompt = (
        'Extract strict JSON only: {"passport_id":"XXXXXXXXX","birthday":"DD.MM.YYYY"}. '
        'passport_id is Russian passport series+number, exactly 10 digits if visible. '
        'birthday is date of birth in DD.MM.YYYY. Use empty strings for missing values. No markdown.'
    )

    for item in work_images:
        img_cv = item['img']
        img_name = item.get('name', 'input')
        started = perf_counter() if debug else None
        try:
            raw = await call_glm_ocr_vllm_async(img_cv, prompt, max_tokens=128)
            result = extract_json_object(raw)
        except Exception as exc:
            result = {"passport_id": "", "birthday": "", "error": str(exc)}

        result.setdefault("passport_id", "")
        result.setdefault("birthday", "")

        if debug:
            result['metrics'] = {
                'img_name': img_name,
                'ocr_engine': 'glm_vllm',
                'total_time': perf_counter() - started if started is not None else None,
                'request_total_time': perf_counter() - total_start if total_start is not None else None,
            }
        results.append(result)

    return results


def _normalize_digits(text: str) -> str:
    return str(text or "").translate(str.maketrans({
        'О': '0', 'O': '0', 'о': '0', 'o': '0',
        'З': '3', 'з': '3',
        'Б': '6',
        'I': '1', 'l': '1', '|': '1',
        'S': '5', 's': '5',
    }))


def _fix_date(text: str) -> str:
    t = _normalize_digits(text)
    t = re.sub(r'[^0-9]', '.', t)
    nums = re.findall(r'\d+', t)
    joined = ''.join(nums)
    if len(joined) >= 8:
        return f"{joined[:2]}.{joined[2:4]}.{joined[4:8]}"
    m = re.search(r'(\d{1,2})\D+(\d{1,2})\D+(\d{4})', t)
    if not m:
        return str(text or "").strip()
    d, mth, y = m.groups()
    return f"{int(d):02d}.{int(mth):02d}.{y}"


def _fix_department_code(text: str) -> str:
    digits = re.sub(r'\D+', '', _normalize_digits(text))
    if len(digits) >= 6:
        return f"{digits[:3]}-{digits[3:6]}"
    return str(text or "").strip().upper()


def _fix_serial_number(text: str) -> str:
    digits = re.sub(r'\D+', '', _normalize_digits(text))
    if len(digits) >= 10:
        return f"{digits[:2]} {digits[2:4]} {digits[4:10]}"
    return str(text or "").strip()


def _fix_gender(text: str) -> str:
    t = str(text or "").upper().replace('.', '').strip()
    t = re.sub(r'[^А-ЯЁA-Z]+', '', t)
    if t.startswith('М') or t in {'MUZH', 'M', 'MALE'}:
        return 'МУЖ'
    if t.startswith('Ж') or t in {'ZHEN', 'F', 'FEMALE'}:
        return 'ЖЕН'
    return str(text or "").strip().upper()


def _fix_person_name(text: str) -> str:
    t = str(text or "").upper().replace('Ё', 'Е')
    t = re.sub(r'[^А-ЯЁ\- ]+', ' ', t)
    t = re.sub(r'\s+', ' ', t).strip()
    return t


def fix_ocr(doc_type, class_name, text):
    if not text:
        return ""
    t = str(text).strip()
    if doc_type != 'passport_ru':
        return t

    if class_name in {'name', 'second_name', 'third_name'}:
        return _fix_person_name(t)
    if class_name in {'date', 'date_issue'}:
        return _fix_date(t)
    if class_name == 'gender':
        return _fix_gender(t)
    if class_name == 'issued_by_code':
        return _fix_department_code(t)
    if class_name == 'serial_number':
        return _fix_serial_number(t)
    if class_name in {'address', 'issued_by'}:
        t = clean_address(t).upper()
        t = t.replace('Г МВД', 'ГУ МВД')
        t = t.replace('ГУМВД', 'ГУ МВД')
        t = t.replace('УМВДРОССИИ', 'УМВД РОССИИ')
        return t
    if class_name == 'citizenship':
        return t.upper()
    return t


def _valid_date(text: str) -> bool:
    if not re.fullmatch(r'\d{2}\.\d{2}\.\d{4}', str(text or '')):
        return False
    try:
        datetime.strptime(text, '%d.%m.%Y')
        return True
    except ValueError:
        return False


def validate_ocr(doc_type, class_name, text):
    if not text:
        return False
    t = str(text).strip()
    if doc_type != 'passport_ru':
        return bool(t)

    validators = {
        'name': lambda v: bool(re.fullmatch(r'[А-ЯЁ][А-ЯЁ\- ]{1,80}', v)),
        'second_name': lambda v: bool(re.fullmatch(r'[А-ЯЁ][А-ЯЁ\- ]{1,80}', v)),
        'third_name': lambda v: bool(re.fullmatch(r'[А-ЯЁ][А-ЯЁ\- ]{1,80}', v)),
        'date': _valid_date,
        'address': lambda v: len(v) >= 2,
        'gender': lambda v: v in {'МУЖ', 'ЖЕН', 'МУЖ.', 'ЖЕН.'},
        'date_issue': _valid_date,
        'issued_by': lambda v: len(v) >= 3,
        'issued_by_code': lambda v: bool(re.fullmatch(r'\d{3}-\d{3}', v)),
        'serial_number': lambda v: bool(re.fullmatch(r'\d{2} ?\d{2} ?\d{6}', v)),
        'citizenship': lambda v: len(v) > 0,
    }
    return validators.get(class_name, lambda v: bool(v))(t)


def normalize_for_paddle_recognize(img_bgr, out_h=48, out_w=320):
    """
    Приводит изображение к PaddleOCR-совместимому размеру:
    - сохраняет пропорции
    - вписывает в белый фон 48×320
    - не растягивает текст
    """
    h, w = img_bgr.shape[:2]
    scale = min(out_h / h, out_w / w)

    new_w = int(w * scale)
    new_h = int(h * scale)

    # масштабируем изображение
    resized = cv2.resize(img_bgr, (new_w, new_h), interpolation=cv2.INTER_LINEAR)

    # создаём белый фон
    canvas = np.ones((out_h, out_w, 3), dtype=np.uint8) * 255

    # позиционирование по центру
    x_offset = (out_w - new_w) // 2
    y_offset = (out_h - new_h) // 2

    canvas[y_offset:y_offset + new_h, x_offset:x_offset + new_w] = resized

    return canvas


def preprocess_for_ocr(img_bgr):
    """
    Повышение читаемости: конвертация в серый + CLAHE и обратно в BGR.
    Возвращает BGR изображение.
    """
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=1.5, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    return cv2.cvtColor(enhanced, cv2.COLOR_GRAY2BGR)


# --------------------------- FastAPI app -----------------------------------
app = FastAPI(title="OCR Passport API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])



# Кэш: ключ = хэш путей, значение = инстанции моделей
MODEL_CACHE: Dict[str, Dict[str, Any]] = {}
_cache_lock = Lock()


async def get_yolo_model(config: Optional[Dict] = None) -> Dict[str, Any]:
    if config is None:
        return {}

    # Формируем уникальный ключ на основе путей
    main_path = config.get("main_model_path", "")
    multiline_path = config.get("multiline_model_path", "")
    cache_key = f"{main_path}:{multiline_path}"

    # Быстрая проверка без блокировки
    if cache_key in MODEL_CACHE:
        return MODEL_CACHE[cache_key]

    # Безопасная загрузка с блокировкой
    async with _cache_lock:
        # Double-checked locking
        if cache_key in MODEL_CACHE:
            return MODEL_CACHE[cache_key]

        if YOLO is None:
            raise HTTPException(500, "ultralytics YOLO not installed")

        try:
            main_model = await asyncio.to_thread(YOLO, main_path)
            multiline_model = await asyncio.to_thread(YOLO, multiline_path) if multiline_path != "" else ""

            model_instance = {
                "main_model": main_model,
                "multiline_model": multiline_model
            }

            MODEL_CACHE[cache_key] = model_instance
            return model_instance

        except Exception as e:
            raise HTTPException(500, f"Failed to load YOLO model: {e}")


# ---------------- PaddleOCR model ----------------
from paddleocr import TextRecognition

PADDLE_INSTANCE: TextRecognition|None = None
PADDLE_INSTANCE_MULTILINE: TextRecognition|None = None
PADDLE_DETECTOR = None


async def get_paddle_model() -> Tuple[TextRecognition, None, TextRecognition|None]:
    """
    Лениво загружает PaddleOCR c пользовательской моделью.
    """
    global PADDLE_INSTANCE
    global PADDLE_DETECTOR
    global PADDLE_INSTANCE_MULTILINE
    if PADDLE_INSTANCE is not None:
        return PADDLE_INSTANCE, PADDLE_DETECTOR, PADDLE_INSTANCE_MULTILINE

    if PaddleOCR is None:
        raise HTTPException(status_code=500, detail="PaddleOCR not installed on server")

    # путь к вашей дообученной модели
    # rec_model = "./best_model/without_multiline/inference.pdiparams"
    # rec_model_for_multiline = "./best_model/biggest_dataset/inference.pdiparams"
    rec_model = str(RU_OCR_MODEL_DIR / "inference.pdiparams")
    rec_model_for_multiline = str(RU_OCR_MODEL_DIR / "inference.pdiparams")

    # Загружаем модель
    PADDLE_INSTANCE = TextRecognition(
        model_dir=os.path.dirname(rec_model),
        model_name='cyrillic_PP-OCRv5_mobile_rec',
    )
    PADDLE_INSTANCE_MULTILINE = TextRecognition(
        model_dir=os.path.dirname(rec_model_for_multiline),
        model_name='cyrillic_PP-OCRv5_mobile_rec',
    )
    #
    # PADDLE_DETECTOR = TextDetection(
    #     model_name="PP-OCRv5_mobile_det"
    # )

    return PADDLE_INSTANCE, PADDLE_DETECTOR, PADDLE_INSTANCE_MULTILINE

# Настройка логирования
LOG_DIR = RU_LOG_DIR
LOG_DIR.mkdir(parents=True, exist_ok=True)

# Создаём отдельную папку для файлов
FILES_LOG_DIR = LOG_DIR / "files"
FILES_LOG_DIR_BIRTHDAY_ID = LOG_DIR / "birthday"
FILES_LOG_DIR.mkdir(exist_ok=True)
FILES_LOG_DIR_BIRTHDAY_ID.mkdir(exist_ok=True)

# Настройка логгера
logger = logging.getLogger("ocr_api")
logger.setLevel(logging.INFO)

# Обработчик для записи в файл
file_handler = logging.FileHandler(LOG_DIR / "api_requests.log", encoding='utf-8')
file_handler.setFormatter(logging.Formatter(
    '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
))
logger.addHandler(file_handler)

@app.post('/parse')
async def parse_files(files: List[UploadFile] = File(...),
                      doc_type: str = Query('passport_ru'),
                      ollama_model: str = Query('qwen2.5vl:7b'),
                      ollama_url: str = Query('http://localhost:11434'),
                      dpi: int = Query(500),
                      ocr_engine: str = Query('paddle'),
                      debug: bool = Query(True),
                      async_proc: bool = Query(True),
                      no_llm: bool = Query(False)):
    """
    Основной endpoint:
    Принимает multipart файлы (PDF или изображения). Параметры:
      - doc_type: тип документа (используется для выбора промптов и модели)
      - ollama_model: legacy-параметр, оставлен для совместимости; GLM берётся из env
      - ollama_url: legacy-параметр, оставлен для совместимости; GLM_OCR_URL берётся из env
      - dpi: при рендере PDF
      - debug: если True — в ответ добавляется поле 'timings' с детальными замерами времени.

    Все legacy vision-запросы выполняются асинхронно с ограничением в 4 одновременных запроса.
    Поведение:
      - Загружает YOLO модель (лениво) согласно DOC_TYPE_CONFIG
      - Сохраняет загруженные файлы во временную папку
      - Извлекает изображения (если pdf — разворачивает страницы)
      - Вызывает process_images_list в threadpool (т.к. heavy blocking операции)
      - Возвращает JSONResponse с распознанными данными. Если debug=True — включает тайминги.
    """
    endpoint_t0 = perf_counter()
    request_stage_timings = []

    def record_stage(name: str, started_at: float, **extra):
        entry = {
            "name": name,
            "time": perf_counter() - started_at,
        }
        if extra:
            entry.update(extra)
        request_stage_timings.append(entry)

    if cv2 is None:
        raise HTTPException(status_code=500, detail='opencv-python not installed on server')

    # Если no_llm=True, убедимся, что ocr_engine не использует LLM
    if no_llm and ocr_engine in ["paddle_GLM", "glm"]:
        ocr_engine = "paddle"

    # Генерируем уникальный ID для запроса
    request_id = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    request_log_dir = FILES_LOG_DIR / request_id
    stage_t0 = perf_counter()
    request_log_dir.mkdir(exist_ok=True)
    record_stage("request_log_dir_create", stage_t0, path=str(request_log_dir))

    # Логируем параметры запроса
    logger.info(f"Request {request_id} - Parameters: doc_type={doc_type}, "
                f"ollama_model={ollama_model}, dpi={dpi}, ocr_engine={ocr_engine}")

    # проверка doc_type
    if doc_type not in DOC_TYPE_CONFIG:
        raise HTTPException(status_code=400, detail=f"Unsupported doc_type: {doc_type}")

    config = DOC_TYPE_CONFIG[doc_type]
    stage_t0 = perf_counter()
    models = await get_yolo_model(config)
    record_stage("get_yolo_model", stage_t0)

    model = models['main_model']
    multiline_model = models['multiline_model']

    if ocr_engine in ["paddle", "paddle_GLM"]:
        stage_t0 = perf_counter()
        await get_paddle_model()
        record_stage("get_paddle_model", stage_t0)

    # создаём временную директорию для загрузки файлов и временных PNG'ов
    stage_t0 = perf_counter()
    tmpdir = tempfile.mkdtemp(prefix='ocr_api_')
    record_stage("tmpdir_create", stage_t0, path=tmpdir)
    work_images = []
    request_t0 = perf_counter() if debug else None
    try:
        # сохраняем загруженные файлы на диск и извлекаем изображения
        uploaded_files_info = []
        for idx, up in enumerate(files):
            filename = up.filename or f'upload_{idx}'
            dest = os.path.join(tmpdir, filename)

            # Читаем содержимое файла
            stage_t0 = perf_counter()
            content = await up.read()
            record_stage("upload_read", stage_t0, file_index=idx, filename=filename, bytes=len(content))

            # Сохраняем в рабочую директорию
            stage_t0 = perf_counter()
            with open(dest, 'wb') as f:
                f.write(content)
            record_stage("tmp_file_write", stage_t0, file_index=idx, filename=filename, path=dest, bytes=len(content))

            # Логируем файл: сохраняем копию в папку логов
            log_file_path = request_log_dir / f"{idx:02d}_{filename}"
            stage_t0 = perf_counter()
            with open(log_file_path, 'wb') as f:
                f.write(content)
            record_stage("log_file_write", stage_t0, file_index=idx, filename=filename, path=str(log_file_path),
                         bytes=len(content))

            uploaded_files_info.append({
                "index": idx,
                "filename": filename,
                "size": len(content),
                "logged_path": str(log_file_path)
            })

            logger.info(f"Request {request_id} - File {idx}: {filename} ({len(content)} bytes)")

            suffix = Path(dest).suffix.lower()
            if suffix == '.pdf':
                try:
                    if ocr_engine in ["paddle", "paddle_GLM"]:
                        stage_t0 = perf_counter()
                        page_count = await asyncio.to_thread(get_pdf_page_count, dest)
                        record_stage("pdf_register_pages", stage_t0, file_index=idx, filename=filename,
                                     page_count=page_count)
                        work_images.append({
                            'source_type': 'pdf',
                            'path': dest,
                            'name': Path(filename).stem,
                            'page_count': page_count,
                            'dpi': dpi,
                            'file_index': idx,
                            'filename': filename,
                        })
                    else:
                        stage_t0 = perf_counter()
                        imgs = await asyncio.to_thread(extract_one_image_from_pdf, dest, DEFAULT_MAX_W,
                                                       DEFAULT_MAX_H, dpi)
                        record_stage("pdf_extract_first_page", stage_t0, file_index=idx, filename=filename,
                                     images_count=len(imgs) if imgs else 0)
                        work_images.extend(imgs)
                except Exception as e:
                    logger.error(f"Request {request_id} - PDF processing failed: {e}")
                    raise HTTPException(status_code=400, detail=f'PDF processing failed: {e}')
            else:
                # пытаемся прочитать изображение через OpenCV
                stage_t0 = perf_counter()
                img_cv = cv2.imdecode(np.frombuffer(content, np.uint8), cv2.IMREAD_COLOR)
                if img_cv is None:
                    img_cv = await asyncio.to_thread(cv2.imread, dest)
                record_stage("image_decode", stage_t0, file_index=idx, filename=filename,
                             success=img_cv is not None)
                if img_cv is None:
                    logger.error(f"Request {request_id} - Failed to read image {filename}")
                    raise HTTPException(status_code=400, detail=f'Failed to read image {filename}')
                work_images.append({'img': img_cv, 'name': Path(filename).stem})

        # Запускаем синхронную или асинхронную обработку

        if ocr_engine in ["paddle", "paddle_GLM"]:
            stage_t0 = perf_counter()
            result = process_images_list_paddle(work_images, model, multiline_model, ollama_model, ollama_url, doc_type, tmpdir,
                                                ocr_engine, debug, no_llm)
            record_stage("recognition_process", stage_t0, ocr_engine=ocr_engine, images_count=len(work_images))
        elif async_proc:
            stage_t0 = perf_counter()
            result = await process_images_list_async(work_images, model, ollama_model, ollama_url, doc_type, tmpdir,
                                                     ocr_engine, debug)
            record_stage("recognition_process", stage_t0, ocr_engine=ocr_engine, async_proc=True,
                         images_count=len(work_images))
        else:
            stage_t0 = perf_counter()
            result = process_images_list(work_images, model, ollama_model, ollama_url, doc_type, tmpdir, ocr_engine,
                                         debug)
            record_stage("recognition_process", stage_t0, ocr_engine=ocr_engine, async_proc=False,
                         images_count=len(work_images))

        # Если мы хотим измерить общее время запроса
        if debug:
            result.setdefault('timings', {})
            result['timings']['request_total'] = perf_counter() - request_t0
            result['timings']['endpoint_total'] = perf_counter() - endpoint_t0
            result['timings']['request_stages'] = request_stage_timings

        # Логируем ответ
        response_log_path = request_log_dir / "response.json"
        stage_t0 = perf_counter()
        with open(response_log_path, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        record_stage("response_json_write", stage_t0, path=str(response_log_path))

        # Сохраняем метаинформацию о запросе
        metadata = {
            "request_id": request_id,
            "timestamp": datetime.now().isoformat(),
            "parameters": {
                "doc_type": doc_type,
                "ollama_model": ollama_model,
                "ollama_url": ollama_url,
                "dpi": dpi,
                "ocr_engine": ocr_engine,
                "debug": debug,
                "async_proc": async_proc
            },
            "files": uploaded_files_info,
            "response_logged": str(response_log_path),
            "timings": {
                "endpoint_total": perf_counter() - endpoint_t0,
                "request_stages": request_stage_timings
            }
        }

        metadata_path = request_log_dir / "metadata.json"
        stage_t0 = perf_counter()
        with open(metadata_path, 'w', encoding='utf-8') as f:
            json.dump(metadata, f, ensure_ascii=False, indent=2)
        record_stage("metadata_json_write", stage_t0, path=str(metadata_path))

        logger.info(f"Request {request_id} - Processing completed successfully")

        return JSONResponse(content=result)

    except Exception as e:
        # Логируем ошибку
        logger.error(f"Request {request_id} - Error: {str(e)}", exc_info=True)

        error_log_path = request_log_dir / "error.txt"
        with open(error_log_path, 'w', encoding='utf-8') as f:
            f.write(f"Error: {str(e)}\n")
            f.write(f"Timestamp: {datetime.now().isoformat()}\n")

        raise

    finally:
        # пытаемся удалить временную директорию (аккуратно — игнорируем ошибки)
        if not debug:
            try:
                shutil.rmtree(tmpdir)
            except Exception:
                pass

@app.post('/parse-id-birthday')
async def parse_id_birthday(files: List[UploadFile] = File(...),
                      doc_type: str = Query('passport_ru'),
                      ollama_model: str = Query('qwen2.5vl:7b'),
                      ollama_url: str = Query('http://localhost:11434'),
                      dpi: int = Query(500),
                      ocr_engine: str = Query('paddle_GLM'),
                      debug: bool = Query(True),
                      async_proc: bool = Query(True)):
    """
    Основной endpoint:
    Принимает multipart файлы (PDF или изображения). Параметры:
      - doc_type: тип документа (используется для выбора промптов и модели)
      - ollama_model: legacy-параметр, оставлен для совместимости; GLM берётся из env
      - ollama_url: legacy-параметр, оставлен для совместимости; GLM_OCR_URL берётся из env
      - dpi: при рендере PDF
      - debug: если True — в ответ добавляется поле 'timings' с детальными замерами времени.

    Все legacy vision-запросы выполняются асинхронно с ограничением в 4 одновременных запроса.
    Поведение:
      - Загружает YOLO модель (лениво) согласно DOC_TYPE_CONFIG
      - Сохраняет загруженные файлы во временную папку
      - Извлекает изображения (если pdf — разворачивает страницы)
      - Вызывает process_images_list в threadpool (т.к. heavy blocking операции)
      - Возвращает JSONResponse с распознанными данными. Если debug=True — включает тайминги.
    """

    # Генерируем уникальный ID для запроса
    request_id = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    request_log_dir = FILES_LOG_DIR_BIRTHDAY_ID / request_id
    request_log_dir.mkdir(exist_ok=True)

    # Логируем параметры запроса
    logger.info(f"Request {request_id} - Parameters: doc_type={doc_type}, "
                f"ollama_model={ollama_model}, dpi={dpi}, ocr_engine={ocr_engine}")


    # создаём временную директорию для загрузки файлов и временных PNG'ов
    tmpdir = tempfile.mkdtemp(prefix='parse_id_birthday')
    work_images = []
    request_t0 = perf_counter() if debug else None
    try:
        # сохраняем загруженные файлы на диск и извлекаем изображения
        uploaded_files_info = []
        for idx, up in enumerate(files):
            filename = up.filename or f'upload_{idx}'
            dest = os.path.join(tmpdir, filename)

            # Читаем содержимое файла
            content = await up.read()

            # Сохраняем в рабочую директорию
            with open(dest, 'wb') as f:
                f.write(content)

            # Логируем файл: сохраняем копию в папку логов
            log_file_path = request_log_dir / f"{idx:02d}_{filename}"
            with open(log_file_path, 'wb') as f:
                f.write(content)

            uploaded_files_info.append({
                "index": idx,
                "filename": filename,
                "size": len(content),
                "logged_path": str(log_file_path)
            })

            logger.info(f"Request {request_id} - File {idx}: {filename} ({len(content)} bytes)")

            suffix = Path(dest).suffix.lower()
            if suffix == '.pdf':
                # извлекаем страницы/встраиваемые изображения из PDF
                try:
                    imgs = await asyncio.to_thread(extract_one_image_from_pdf, dest, 1280,
                                                   1280, 150)
                    work_images.extend(imgs)
                except Exception as e:
                    logger.error(f"Request {request_id} - PDF processing failed: {e}")
                    raise HTTPException(status_code=400, detail=f'PDF processing failed: {e}')
            else:
                # пытаемся прочитать изображение через OpenCV
                img_cv = cv2.imdecode(np.frombuffer(content, np.uint8), cv2.IMREAD_COLOR)
                if img_cv is None:
                    img_cv = await asyncio.to_thread(cv2.imread, dest)
                if img_cv is None:
                    logger.error(f"Request {request_id} - Failed to read image {filename}")
                    raise HTTPException(status_code=400, detail=f'Failed to read image {filename}')
                work_images.append({'img': img_cv, 'name': Path(filename).stem})

        # Запускаем синхронную или асинхронную обработку
        result = await process_images_list_parse_birthday(work_images, tmpdir, debug)

        # Логируем ответ
        response_log_path = request_log_dir / "response.json"
        with open(response_log_path, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

        # Сохраняем метаинформацию о запросе
        metadata = {
            "request_id": request_id,
            "timestamp": datetime.now().isoformat(),
            "parameters": {
                "doc_type": doc_type,
                "ollama_model": ollama_model,
                "ollama_url": ollama_url,
                "dpi": dpi,
                "ocr_engine": ocr_engine,
                "debug": debug,
                "async_proc": async_proc
            },
            "files": uploaded_files_info,
            "response_logged": str(response_log_path)
        }

        metadata_path = request_log_dir / "metadata.json"
        with open(metadata_path, 'w', encoding='utf-8') as f:
            json.dump(metadata, f, ensure_ascii=False, indent=2)

        logger.info(f"Request {request_id} - Processing completed successfully")

        final_result = {
            "result": result,
            "metadata": metadata
        }

        return JSONResponse(content=final_result)

    except Exception as e:
        # Логируем ошибку
        logger.error(f"Request {request_id} - Error: {str(e)}", exc_info=True)

        error_log_path = request_log_dir / "error.txt"
        with open(error_log_path, 'w', encoding='utf-8') as f:
            f.write(f"Error: {str(e)}\n")
            f.write(f"Timestamp: {datetime.now().isoformat()}\n")

        raise

    finally:
        # пытаемся удалить временную директорию (аккуратно — игнорируем ошибки)
        if not debug:
            try:
                shutil.rmtree(tmpdir)
            except Exception:
                pass


if __name__ == '__main__':
    uvicorn.run(app, host='0.0.0.0', port=8001, reload=False)
