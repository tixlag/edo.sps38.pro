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

import GlmOCRService

sys.path.insert(0, os.path.dirname(__file__))
# или
sys.path.insert(0, "/home/neuro/PycharmProjects/DocRecognizer")

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

load_dotenv()

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
# from full_pipeline.PassportEnhancer import PassportEnhancer

# from full_pipeline.TrOCRService import TrOCRService, trocr_recognize_async  # или from .trocr_service import ...
# trocr_svc = TrOCRService()
trocr_svc = None


# ── GLM-OCR ─────────────────────────────────────────────────────────────────

# av_vision_svc = AvVisionServiceSync.get_instance()
# av_vision_svc.init(
#     model_name="AvitoTech/avision",
#     device="cuda:0",
#     hf_token=os.environ.get("HF_TOKEN"),  # или явно передайте токен
#     cache_dir="./model_cache"  # опционально для сохранения модели локально
# )

glm_ocr_svc = GlmOCRService.GLMOCRService.get_instance()
glm_ocr_svc.load()

# Optional heavy l
# ibs
try:
    import cv2
except Exception:
    cv2 = None

try:
    import ollama
except Exception:
    ollama = None

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

# --------------------------- Document type config ---------------------------
DOC_TYPE_CONFIG = {
    "passport_ru": {
        "main_model_path": "/home/neuro/AI/OCR/yolo_model_new/runs/segment/train5/weights/PASPORT_SEGMENT_MODEL.pt",
        "multiline_model_path": "/home/neuro/PycharmProjects/DocRecognizer/yolo_models/rus_passport_multiline.pt"
    },
    "passport_uz": {
        "main_model_path": "/path/to/uzbek_passport_model.pt",
    },
    "snils": {
        "main_model_path": "/path/to/snils_model.pt",
    },
}

# Семафор для ограничения одновременных запросов к Ollama
OLLAMA_SEMAPHORE = asyncio.Semaphore(4)


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
    """
    Выполняет детекцию объектов через YOLO и возвращает кропы для OCR.

    Изменения по сравнению с оригиналом:
    1. Использует bbox вместо масок для вырезания кропов
    2. Добавляет пост-обработку кропов (поворот текстовых полей)
    3. Возвращает BGR-изображения без альфа-канала
    4. Добавлены параметры для управления ориентацией страницы

    Args:
        img: входное изображение (BGR)
        model: YOLO модель
        folder_name: имя папки для определения ориентации (опционально)
        right_oriented_docs: список исключений для поворота (опционально)

    Returns:
        segments: {class_name: [BGR_crop1, BGR_crop2, ...]}
        или None при ошибках
    """
    if img is None or model is None:
        return None

    h, w = img.shape[:2]
    # Значения по умолчанию для параметров ориентации
    if right_oriented_docs is None:
        right_oriented_docs = []

    # --- ПЕРВЫЙ ПРОХОД: ОПРЕДЕЛЕНИЕ ОРИЕНТАЦИИ ---
    results = model(img, verbose=False)
    result = results[0]

    # Проверяем необходимость поворота страницы
    if result.boxes is not None and len(result.boxes) > 0:
        boxes_xyxy = result.boxes.xyxy.cpu().numpy()
        if should_rotate_image(boxes_xyxy, h, w):
            # Определяем направление поворота (аналогично второму коду)
            clockwise = cv2.ROTATE_90_CLOCKWISE
            if folder_name and any(name in folder_name for name in right_oriented_docs):
                clockwise = cv2.ROTATE_90_COUNTERCLOCKWISE

            img = cv2.rotate(img, clockwise)
            h, w = img.shape[:2]  # обновляем размеры

    # --- ВТОРОЙ ПРОХОД НА ИСПРАВЛЕННОМ ИЗОБРАЖЕНИИ ---
    results = model(img, verbose=False)
    result = results[0]

    # Если нет детекций - возвращаем пустой словарь
    if result.boxes is None or len(result.boxes) == 0:
        return {}

    boxes = result.boxes
    names = result.names
    segments = {}

    for i in range(len(boxes)):
        cls_id = int(boxes[i].cls.item())
        class_name = names[cls_id]

        # Получаем и нормализуем координаты bbox
        x1f, y1f, x2f, y2f = map(float, boxes[i].xyxy[0])
        x1 = max(0, min(w - 1, int(round(x1f))))
        y1 = max(0, min(h - 1, int(round(y1f))))
        x2 = max(0, min(w, int(round(x2f))))
        y2 = max(0, min(h, int(round(y2f))))

        # Проверка валидности bbox
        if x2 <= x1 or y2 <= y1:
            continue

        # Вырезаем кроп по bbox (BGR)
        crop = img[y1:y2, x1:x2].copy()
        if crop.size == 0:
            continue

        # Пост-обработка для текстовых полей (аналогично второму коду)
        if class_name != 'document':
            crop_h, crop_w = crop.shape[:2]
            # Поворачиваем если текст вертикальный
            if crop_w < crop_h:
                crop = cv2.rotate(crop, cv2.ROTATE_90_COUNTERCLOCKWISE)

        # Добавляем в результат
        if class_name not in segments:
            segments[class_name] = []
        segments[class_name].append(crop)

    return segments


# --------------------------- Ollama Vision ---------------------------------
def create_segment_prompt(class_name: str, doc_type: str = "passport_ru") -> str:
    """
    Формирует текстовый prompt для Ollama по имени сегмента и типу документа.
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

GLM_PROMPT_TEXT = "Text Recognition (Russian):"
def get_glm_prompt(class_name) -> str:
    if class_name == "issued_by":
        return "Extract only name of organization. (Cyrillic symbols only)"
    return GLM_PROMPT_TEXT
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
                                        output: str = '/tmp/ocr_api', base_url: str = 'http://localhost:11434') -> (str,
                                                                                                                    str):
    """
    Асинхронная версия распознавания через Ollama.
    Сохраняет изображение временно на диск и отправляет запрос в Ollama с использованием семафора.
    Возвращает кортеж (recognized_text, tmp_file_path).
    """
    if ollama is None:
        return "", output

    tmpf = None
    try:
        ensure_dir(output)
        # Создаём временный файл синхронно (быстрая операция)
        tmp = tempfile.NamedTemporaryFile(suffix='.png', prefix=f"ocr_{class_name}_", dir=output, delete=False)
        tmpf = tmp.name
        tmp.close()

        # Сохранение изображения
        if len(img_array.shape) == 2:
            img_save = cv2.cvtColor(img_array, cv2.COLOR_GRAY2BGR)
        elif img_array.shape[2] == 4:
            img_save = cv2.cvtColor(img_array, cv2.COLOR_BGRA2BGR)
        else:
            img_save = img_array
        cv2.imwrite(tmpf, img_save)

        # Используем семафор для ограничения одновременных запросов
        async with OLLAMA_SEMAPHORE:
            # Выполняем синхронный вызов ollama.chat в thread pool
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None,
                lambda: ollama.chat(
                    model=model,
                    messages=[{
                        'role': 'user',
                        'content': prompt,
                        'images': [tmpf]
                    }],
                    think=False
                )
            )
            text = response['message']['content'].strip()
            return text, tmpf
    except Exception as e:
        print("ollama_vision_recognize_async error:", e)
        return "", output if tmpf is None else tmpf


def ollama_vision_recognize(img_array: np.ndarray, class_name, prompt: str, model: str = 'qwen2.5vl:7b',
                            output: str = '/tmp/ocr_api', base_url: str = 'http://localhost:11434') -> (str, str):
    """
    Сохраняет изображение временно на диск и отправляет запрос в Ollama (если библиотека доступна).
    Возвращает кортеж (recognized_text, tmp_file_path).
    Если ollama не установлен, возвращает пустую строку.
    В случае ошибки — пытается вернуть пустую строку и путь к output.
    """
    if ollama is None:
        return "", output
    tmpf = None
    try:
        ensure_dir(output)
        tmp = tempfile.NamedTemporaryFile(suffix='.png', prefix=f"ocr_{class_name}_", dir=output, delete=False)
        tmpf = tmp.name
        tmp.close()
        if len(img_array.shape) == 2:
            img_save = cv2.cvtColor(img_array, cv2.COLOR_GRAY2BGR)
        elif img_array.shape[2] == 4:
            img_save = cv2.cvtColor(img_array, cv2.COLOR_BGRA2BGR)
        else:
            img_save = img_array
        cv2.imwrite(tmpf, img_save)
        # вызов Ollama: передаём изображение как attachment в messages
        response = ollama.chat(
            model=model,
            messages=[{
                'role': 'user',
                'content': prompt,
                'images': [tmpf]
            }]
        )
        text = response['message']['content'].strip()
        return text, tmpf
    except Exception as e:
        # печатаем исключение для отладки и возвращаем пустой результат
        print("ollama_vision_recognize error:", e)
        return "", output


def pil_from_cv2(bgra):
    b, g, r, a = cv2.split(bgra)
    rgba = cv2.merge([r, g, b, a])
    return Image.fromarray(rgba, mode='RGBA')


def preserve_natural_artifacts(bgra_np):
    """
    Convert BGRA to BGR while preserving natural segmentation artifacts
    """

    return cv2.cvtColor(bgra_np, cv2.COLOR_RGB2BGR)  # временно отдаю целиком без лесенок
    pil_base = pil_from_cv2(bgra_np)
    base_rgb = Image.new("RGB", pil_base.size, (255, 255, 255))
    base_rgb.paste(pil_base, mask=pil_base.split()[3])

    # Apply very gentle processing to maintain natural look
    # Minimal contrast enhancement
    base_rgb = ImageEnhance.Contrast(base_rgb).enhance(1.02)

    # Very light JPEG compression
    from io import BytesIO
    buf = BytesIO()
    base_rgb.save(buf, format='JPEG', quality=98)
    buf.seek(0)
    processed = Image.open(buf).convert('RGB')

    return cv2.cvtColor(np.array(processed), cv2.COLOR_RGB2BGR)


def paddle_recognize(img_array, class_name="segment"):
    """
    Распознавание сегмента через PaddleOCR (с кастомной моделью).
    img_array — numpy BGR или BGRA
    """
    if PaddleOCR is None or PADDLE_INSTANCE is None:
        return ""

    img_array = preprocess_for_ocr(img_array)

    # оригинал (normalized)
    img_array = normalize_for_paddle_recognize(img_array)

    # конвертируем в RGB (PaddleOCR работает с RGB)
    img_rgb = preserve_natural_artifacts(img_array)

    img_rgb_tmp = os.path.join('/home/neuro/PycharmProjects/DocRecognizer', f'current_rec_{class_name}.png')
    # сохраняем изображение как раз для обученной PaddleOCR модели
    norm = normalize_for_paddle_recognize(img_rgb)
    # cv2.imwrite(img_rgb_tmp, norm)

    ocr = PADDLE_INSTANCE
    try:
        print(img_rgb_tmp)
        res = ocr.predict(norm)
    except BaseException as e:
        print(f"PaddleOCR error {img_rgb_tmp}:", e)
        return "", img_rgb_tmp

    # Парсинг результатов
    text = res[0]['rec_text']
    score = res[0]['rec_score']

    return (text, score), img_rgb_tmp


def process_multiline_image(img_rgb, class_name):
    """
    Распознает многострочный текст с использованием детекции строк
    """

    img_rgb = preprocess_for_ocr(img_rgb)

    # оригинал (normalized)
    # img_rgb = normalize_rec_image(img_rgb)

    # 1. Сохраняем исходное изображение
    img_path = os.path.join('/home/neuro/PycharmProjects/DocRecognizer', f'current_rec_{class_name}.png')
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


def process_multiline_image_current(img_rgb, class_name, multiline_model):
    """
    Распознает многострочный текст с использованием детекции строк через YOLO.
    При отсутствии распознанных строк вызывает fallback-метод и сохраняет отладочное изображение.
    Склеивает строки в правильном порядке:
      - Горизонтальное изображение (ширина >= высота): сверху вниз
      - Вертикальное изображение (высота > ширина): слева направо
    """
    import os
    import cv2
    from datetime import datetime

    # Получаем ID запроса из окружения (для организации отладочных файлов)
    req_id = 'multiline'
    debug_dir = f"/home/neuro/PycharmProjects/DocRecognizer/logs/debug/{req_id}"
    os.makedirs(debug_dir, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
    height, width = img_rgb.shape[0], img_rgb.shape[1]
    is_vertical_image = height > width
    orientation = "вертикальное (портрет)" if is_vertical_image else "горизонтальное (альбом)"
    print(f"[{timestamp}] 📐 Ориентация изображения: {orientation} ({width}x{height})")
    print(f"[{timestamp}] 🚀 Начало обработки многострочного изображения для класса '{class_name}' (req_id={req_id})")

    # 1. Детекция строк через YOLO
    print(f"[{timestamp}] Запуск YOLO-детекции строк...")
    results = multiline_model(img_rgb)

    # Извлекаем боксы класса 'line' (предполагаем, что индекс класса = 0)
    line_boxes = []
    if hasattr(results[0], 'boxes') and len(results[0].boxes) > 0:
        for i, cls_id in enumerate(results[0].boxes.cls.cpu().numpy()):
            if int(cls_id) == 0:  # класс 'line'
                xyxy = results[0].boxes.xyxy[i].cpu().numpy()
                line_boxes.append(xyxy)

    print(f"[{timestamp}] Обнаружено {len(line_boxes)} строк(и) для класса '{class_name}'")

    # 2. Сортировка боксов в зависимости от ориентации изображения
    if is_vertical_image:
        # Вертикальное изображение: сортируем слева направо (по x1), затем сверху вниз (по y1)
        line_boxes_sorted = sorted(line_boxes, key=lambda box: (box[0], box[1]))
        print(f"[{timestamp}] Сортировка строк: слева направо (вертикальное изображение)")
    else:
        # Горизонтальное изображение: сортируем сверху вниз (по y1), затем слева направо (по x1)
        line_boxes_sorted = sorted(line_boxes, key=lambda box: (box[1], box[0]))
        print(f"[{timestamp}] Сортировка строк: сверху вниз (горизонтальное изображение)")

    recognized_lines = []
    recognized_scores = []

    # 3. Обработка каждой обнаруженной строки в правильном порядке
    for idx, box in enumerate(line_boxes_sorted):
        x1, y1, x2, y2 = map(int, box[:4])
        # Защита от некорректных координат
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(img_rgb.shape[1], x2), min(img_rgb.shape[0], y2)

        if x2 <= x1 or y2 <= y1:
            print(f"  ⚠️ Пропуск строки {idx}: некорректные координаты ({x1},{y1},{x2},{y2})")
            continue

        # Вырезаем регион строки
        line_img = img_rgb[y1:y2, x1:x2].copy()
        if line_img.size == 0:
            print(f"  ⚠️ Пропуск строки {idx}: пустое изображение после кропа")
            continue

        # Предобработка для улучшения качества
        line_img = preprocess_for_ocr(line_img)
        line_img = normalize_for_paddle_recognize(line_img)

        # Сохраняем отладочное изображение строки
        debug_path = os.path.join(debug_dir, f"current_rec_{class_name}_line_{idx}_{timestamp}.png")
        # cv2.imwrite(debug_path, cv2.cvtColor(line_img, cv2.COLOR_RGB2BGR))
        position_info = f"x:{x1}-{x2}, y:{y1}-{y2}"
        print(f"  ✅ Строка {idx} [{position_info}]: сохранена в debug: {os.path.basename(debug_path)}")

        # Распознавание через PaddleOCR
        try:
            res = PADDLE_INSTANCE_MULTILINE.predict(line_img)
            if res and len(res) > 0 and 'rec_text' in res[0]:
                text = res[0]['rec_text'].strip()
                score = res[0]['rec_score']
                if text and score > 0.8:  # фильтр мусора
                    recognized_lines.append(text)
                    recognized_scores.append(score)
                    print(f"  ✅ Строка {idx}: '{text}' (score={score:.4f})")
                else:
                    print(f"  ⚠️ Строка {idx}: низкое качество распознавания (score={score:.4f}) или пустой текст")
            else:
                print(f"  ⚠️ Строка {idx}: PaddleOCR вернул пустой результат")
        except Exception as e:
            print(f"  ❌ Ошибка распознавания строки {idx}: {str(e)}")

    # 4. Формирование итогового результата
    if recognized_lines:
        final_text = " ".join(recognized_lines)
        min_score = min(recognized_scores) if recognized_scores else 0.0
        print(
            f"[{timestamp}] ✅ Успешно распознано {len(recognized_lines)} строк. Итог: '{final_text}' (min_score={min_score:.4f})")
        return (final_text, min_score), debug_path

    # 5. Fallback при полном отсутствии распознанных строк
    print(f"[{timestamp}] ❌ Не распознано ни одной строки. Активация fallback-метода...")

    # Сохраняем исходное изображение для анализа fallback-сценария
    fallback_debug_path = os.path.join(debug_dir, f"fallback_{class_name}_{timestamp}.png")
    cv2.imwrite(fallback_debug_path, cv2.cvtColor(img_rgb, cv2.COLOR_RGB2BGR))
    print(f"  💾 Сохранено изображение для анализа fallback: {os.path.basename(fallback_debug_path)}")

    # Вызываем резервный метод
    fallback_result = _fallback_single_line(fallback_debug_path)
    print(f"[{timestamp}] ✅ Fallback завершён. Результат: {fallback_result}")

    return fallback_result, fallback_debug_path

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
    Все запросы к Ollama выполняются конкурентно с ограничением в 4 одновременных запроса (через семафор).
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
                if ocr_engine == 'tr':
                    # распознаём TrOCR-ом
                    task = trocr_recognize_async(seg_img, f"{class_name}_{idx}", output_dir, trocr_svc)
                elif ocr_engine == 'avito_vision':
                    task = avision_generate_async(seg_img, f"{class_name}_{idx}", prompt, output_dir, av_vision_svc)
                elif ocr_engine == 'paddle':
                    # PaddleOCR — без prompt
                    task = paddle_recognize_async(seg_img, f"{class_name}_{idx}")
                else:
                    # старый Ollama-путь
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
                # Старый Ollama-путь
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
                if ocr_engine == 'tr':
                    # распознаём TrOCR-ом
                    recognized_text, file_path = trocr_recognize_async(seg_img, f"{class_name}_{idx}", output_dir,
                                                                       trocr_svc)
                elif ocr_engine == 'avito_vision':
                    recognized_text, file_path = avision_generate_async(seg_img, f"{class_name}_{idx}", prompt,
                                                                        output_dir, av_vision_svc)
                elif ocr_engine == 'paddle':
                    # PaddleOCR — без prompt
                    recognized_text, file_path = paddle_recognize(seg_img, f"{class_name}_{idx}")
                else:
                    # старый Ollama-путь
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
        ##Старый Ollama-путь
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


def _run_paddle_ocr_for_segment(img, class_name, idx, multiline_model):
    if class_name in ['issued_by', 'address']:
        return process_multiline_image_current(img, f"{class_name}_{idx}", multiline_model)
    return paddle_recognize(img, f"{class_name}_{idx}")


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

                img_path = os.path.join('/home/neuro/PycharmProjects/DocRecognizer', f'current_rec_0_main.png')
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
            img_path = os.path.join('/home/neuro/PycharmProjects/DocRecognizer', f'current_rec_0_main.png')
            cv2.imwrite(img_path, img_cv)
            segments = run_yolo_segments_from_array_paddle(img_cv, model) if model else None

        if _count_useful_paddle_segments(segments) == 0:
            if debug:
                image_timing = {
                    'name': img_name,
                    'segments_count': 0,
                    'fallback_count': 0,
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

                primary_paddle_ocr = False
                if ocr_engine == 'paddle':
                    primary_paddle_ocr = True
                    (text, score), img_path = _run_paddle_ocr_for_segment(processed, class_name, idx, multiline_model)
                elif ocr_engine == 'paddle_GLM':
                    if class_name in ['issued_by', 'serial_number']:
                        (text, score), img_path = GlmOCRService.glm_recognize_with_score(
                            processed, class_name, prompt, output_dir
                        )
                    else:
                        primary_paddle_ocr = True
                        (text, score), img_path = _run_paddle_ocr_for_segment(
                            processed, class_name, idx, multiline_model
                        )
                elif ocr_engine == 'tr':
                    text, img_path = trocr_recognize_async(processed, f"{class_name}_{idx}", output_dir)
                    score = 1.0
                elif ocr_engine == 'avito_vision':
                    text, img_path = avision_generate_async(processed, f"{class_name}_{idx}", prompt, output_dir)
                    score = 1.0
                else:
                    text, img_path = ollama_vision_recognize(
                        processed, f"{class_name}_{idx}", prompt, ollama_model, output_dir, ollama_url
                    )
                    score = 1.0

                text = _normalize_ocr_text(doc_type, class_name, text)

                # НОВАЯ ЛОГИКА: Проверка score и fallback на 180° rotation / Ollama
                used_fallback = False
                before_fallback_text = text
                used_rotation_fallback = False
                before_rotation_text = text
                before_rotation_score = score
                rotation_fallback_text = None
                rotation_fallback_score = None

                primary_ok = _is_acceptable_ocr_result(doc_type, class_name, text, score, paddle_score_threshold)
                if primary_paddle_ocr and not primary_ok:
                    rotated = cv2.rotate(processed, cv2.ROTATE_180)
                    (rotated_text, rotated_score), rotated_path = _run_paddle_ocr_for_segment(
                        rotated, class_name, idx, multiline_model
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
                        used_rotation_fallback = True
                        primary_ok = rotated_ok

                before_fallback_text = text
                if ocr_engine == 'paddle' and not no_llm and not primary_ok:
                    if debug:
                        print(
                            f"[FALLBACK] Segment {class_name}_{idx}: score {score:.3f} < {paddle_score_threshold} or bad validate_ocr, retrying with Ollama")

                    fallback_t0 = perf_counter() if debug else None
                    try:
                        # Повторное распознавание через Ollama
                        # Это старая CV LLM
                        # ollama_text, ollama_path = av_vision_svc.fallback(
                        #     img_path,
                        #     prompt,
                        # )

                        ollama_text, ollama_path = glm_ocr_svc.fallback(img_path, prompt)

                        # Используем результат Ollama
                        text = ollama_text
                        img_path = ollama_path
                        score = 1.0  # Ollama не возвращает score, помечаем как max
                        used_fallback = True

                        text = _normalize_ocr_text(doc_type, class_name, text)

                        if debug:
                            fallback_time = perf_counter() - fallback_t0
                            print(f"[FALLBACK] Completed in {fallback_time:.3f}s: '{ollama_text}'")

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
    result = {'data': result_data, 'segments_info': all_segment_info}
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
    for item in work_images:
        img_cv = item['img']
        img_name = item.get('name', 'input')

        text, img_path = await GlmOCRService.glm_recognize_async(img_cv, 'full',
                                                                 "Extract {\"passport_id\": \"XXXXXXXXX\", \"birthday\": \"DD.MM.YYYY\"}", output_dir)
        result = json.loads(text)

        # Тайминги для отладки
        if debug:
            img_time = perf_counter() - total_start
            result['metrics'] = {
                'img_name': img_name,
                'total_time': img_time
            }
            results.append(result)

    return results


def fix_ocr(doc_type, class_name, text):
    if not text:
        return False
    fn_by_doc = {
        'passport_ru': {
            'name': lambda t: t,
            'second_name': lambda t: t,
            'third_name': lambda t: t,
            'date': lambda t: t,
            'address': lambda t: t,
            'gender': lambda t: t,
            'date_issue': lambda t: t,
            'issued_by': lambda t: t.replace("Г МВД", "ГУ МВД"),
            'issued_by_code': lambda t: t,
            'serial_number': lambda t: t,
            'citizenship': lambda t: t,
        }
    }
    return fn_by_doc[doc_type][class_name](text)


def validate_ocr(doc_type, class_name, text):
    if not text:
        return False
    fn_by_doc = {
        'passport_ru': {
            'name': lambda t: len(t)> 0,
            'second_name': lambda t: len(t)> 0,
            'third_name': lambda t: len(t)> 0,
            'date': lambda t: bool(re.match(r'^\d{2}\.\d{2}\.\d{4}$', t)),
            'address': lambda t: len(t)> 0,
            'gender': lambda t: t in ['МУЖ', 'ЖЕН', 'МУЖ.', 'ЖЕН.'],
            'date_issue': lambda t: bool(re.match(r'^\d{2}\.\d{2}\.\d{4}$', text)),
            'issued_by': lambda t: len(t)> 0,
            'issued_by_code': lambda t: bool(re.match(r'^\d{3}-\d{3}$', t)),
            'serial_number': lambda t: bool(re.match(r'^\d{2} ?\d{2} ?\d{6}$', t)),
            'citizenship': lambda t: len(t)> 0,
        }
    }
    return fn_by_doc[doc_type][class_name](text)

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
    rec_model = "/home/neuro/PycharmProjects/DocRecognizer/best_model/excelent_with_multiline/inference.pdiparams"
    rec_model_for_multiline = "/home/neuro/PycharmProjects/DocRecognizer/best_model/excelent_with_multiline/inference.pdiparams"

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
    #     model_dir='/home/neuro/PycharmProjects/createOCRDataset/PaddleOCR_training/output/PP-OCRv5_mobile_det/best_model/inference',
    #     model_name="PP-OCRv5_mobile_det"
    # )

    return PADDLE_INSTANCE, PADDLE_DETECTOR, PADDLE_INSTANCE_MULTILINE

# Настройка логирования
LOG_DIR = Path("logs")
LOG_DIR.mkdir(exist_ok=True)

# Создаём отдельную папку для файлов
FILES_LOG_DIR = LOG_DIR / "files"
FILES_LOG_DIR_BIRTHDAY_ID = LOG_DIR / "birthday"
FILES_LOG_DIR.mkdir(exist_ok=True)

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
      - ollama_model: модель Ollama
      - ollama_url: base URL Ollama (в текущем коде не используется явно, т.к. мы используем ollama lib)
      - dpi: при рендере PDF
      - debug: если True — в ответ добавляется поле 'timings' с детальными замерами времени.

    Все запросы к Ollama выполняются асинхронно с ограничением в 4 одновременных запроса.
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
      - ollama_model: модель Ollama
      - ollama_url: base URL Ollama (в текущем коде не используется явно, т.к. мы используем ollama lib)
      - dpi: при рендере PDF
      - debug: если True — в ответ добавляется поле 'timings' с детальными замерами времени.

    Все запросы к Ollama выполняются асинхронно с ограничением в 4 одновременных запроса.
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
