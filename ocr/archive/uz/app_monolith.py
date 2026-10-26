from __future__ import annotations

import base64
import hashlib
import unicodedata
import io
import json
import os
import re
import tempfile
import time
import urllib.error
import urllib.request
from collections import Counter
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

import cv2
import numpy as np
import requests
from fastapi import FastAPI, File, UploadFile, Form, Query, HTTPException
from pydantic import BaseModel
from PIL import Image, ImageOps, ImageFilter, ImageEnhance
from ultralytics import YOLO


# Кастомные TextRecognizer
import sys
from argparse import Namespace

PADDLEOCR_ROOT = Path(
    "/home/neuro/PycharmProjects/createOCRDataset/PaddleOCR_training/PaddleOCR"
)

sys.path.insert(0, str(PADDLEOCR_ROOT))

from tools.infer.predict_rec import TextRecognizer

def make_rec_args(
    *,
    rec_model_dir: Path,
    rec_char_dict_path: Path,
) -> Namespace:
    return Namespace(
        image_dir="",
        rec_algorithm="SVTR_LCNet",
        rec_model_dir=str(rec_model_dir),
        rec_image_shape="3,48,768",
        rec_char_dict_path=str(rec_char_dict_path),
        use_space_char=True,

        use_gpu=USE_GPU,
        gpu_id=DEVICE,
        gpu_mem=500,
        use_tensorrt=False,
        use_fp16=False,
        ir_optim=True,
        enable_mkldnn=False,
        cpu_threads=10,

        benchmark=False,
        save_log_path="./log_output/",
        show_log=False,

        # Эти параметры нужны parse/utility, даже если recognition их не использует.
        det=False,
        rec=True,
        cls=False,
        use_angle_cls=False,
        drop_score=0.0,
        max_batch_size=1,
        rec_batch_num=1,

        # Paddle static predictor ожидает эти поля в разных версиях PaddleOCR.
        use_onnx=False,
        precision="fp32",
        enable_hpi=False,
        use_mp=False,
        total_process_num=1,
        process_id=0,
        warmup=False,
        min_subgraph_size=15,
        rec_yaml_path=None,

        # --- ДОБАВИТЬ ЭТИ ДВА ПАРАМЕТРА ---
        use_gcu=False,  # Исправляет ошибку AttributeError: 'use_gcu'
        return_word_box=False,  # Исправляет ошибку AttributeError: 'return_word_box'
        # ----------------------------------
    )

# ---------------------------------------------------------------------
# PATHS
# ---------------------------------------------------------------------

PROJECT_ROOT = Path("/home/neuro/PycharmProjects/RecognizeUZ")

DOC_MODEL_PATH = PROJECT_ROOT / "runs/segment/runs_doc/doc_type_seg/weights/best.pt"

PASSPORT_FIELDS_MODEL_PATH = (
    # PROJECT_ROOT / "runs/segment/runs_fields/passport_fields_seg/weights/best.pt"
    PROJECT_ROOT / "runs/segment/runs_fields_yolo26m/passport_fields_yolo26m_doc_safe/weights/best.pt"

)

MIGRATION_FIELDS_MODEL_PATH = (
    PROJECT_ROOT / "runs/segment/runs_fields/migration_fields_seg/weights/best.pt"
)


PASSPORT_OCR_MODEL_DIR = Path('/home/neuro/PycharmProjects/RecognizeUZ/paddleocr/inference/ocr/passport_rec_exp_g_hard_mix')
MIGRATION_OCR_MODEL_DIR = Path('/home/neuro/PycharmProjects/RecognizeUZ/paddleocr/inference/ocr/migration_rec_v3')

# PASSPORT_DICT_PATH = (
#     PROJECT_ROOT / "paddleocr_passport_rec/dict.txt"
# )
PASSPORT_DICT_PATH = Path('/home/neuro/PycharmProjects/createOCRDataset/PaddleOCR_training/PaddleOCR/ppocr/utils/dict/ppocrv5_latin_dict.txt')

MIGRATION_DICT_PATH = (
    PROJECT_ROOT / "paddleocr_migration_rec/dict.txt"
)


# ---------------------------------------------------------------------
# SETTINGS
# ---------------------------------------------------------------------

DEVICE = 0
USE_GPU = True

DOC_IMGSZ = 1280
FIELDS_IMGSZ = 1280

DOC_CONF = 0.1
FIELD_CONF = 0.25

# Если document detector ничего не нашёл, считаем, что на вход уже передали
# crop/фото паспорта целиком. Это сохраняет быстрый production-путь для
# случаев, когда внешний сервис уже вырезал паспорт.
ASSUME_PASSPORT_WHEN_DOCUMENTS_EMPTY = (
    os.getenv("ASSUME_PASSPORT_WHEN_DOCUMENTS_EMPTY", "1").lower()
    not in {"0", "false", "no", "off"}
)

PDF_DPI = 220

OCR_TARGET_HEIGHT = 48
OCR_MIN_WIDTH = 32
OCR_MAX_WIDTH = 768
OCR_PAD_X = 4
OCR_PAD_Y = 4

# Поля, которые нужны внутри пайплайна, но не должны распознаваться/выводиться.
# pas_mrz оставляем в детекции, потому что score_passport_layout использует его
# как сильный якорь для выбора ориентации паспорта.
INTERNAL_ONLY_FIELDS = {
    "pas_mrz",
}

SKIP_OCR_FIELDS = {
    "pas_photo",
    *INTERNAL_ONLY_FIELDS,
}

# PaddleOCR возвращает score в диапазоне 0..1.
# 95% => 0.95, 90% => 0.90.
GLM_FIELD_FALLBACK_THRESHOLD = float(
    os.getenv("GLM_FIELD_FALLBACK_THRESHOLD", "0.90")
)
GLM_FULL_DOC_AVG_THRESHOLD = float(
    os.getenv("GLM_FULL_DOC_AVG_THRESHOLD", "0.85")
)

# ---------------------------------------------------------------------
# OCR QUALITY / PRODUCTION VERIFICATION
# ---------------------------------------------------------------------
# Слой защиты от CTC-ошибок длины: лишние/пропущенные повторные символы
# вроде UZBEKISTAAN, KARAKALPAKSSTAN, FK00055527.
# Быстрый путь не замедляем: TTA/GLM включаются только для подозрительных полей.
OCR_VERIFY_ENABLED = (
    os.getenv("OCR_VERIFY_ENABLED", "1").lower()
    not in {"0", "false", "no", "off"}
)
OCR_SAFE_REPAIR_ENABLED = (
    os.getenv("OCR_SAFE_REPAIR_ENABLED", "1").lower()
    not in {"0", "false", "no", "off"}
)
OCR_TTA_ENABLED = (
    os.getenv("OCR_TTA_ENABLED", "1").lower()
    not in {"0", "false", "no", "off"}
)
OCR_TTA_MAX_VARIANTS = int(os.getenv("OCR_TTA_MAX_VARIANTS", "4"))
OCR_TTA_MIN_MAJORITY = int(os.getenv("OCR_TTA_MIN_MAJORITY", "2"))
OCR_GLM_ON_QUALITY_FLAGS = (
    os.getenv("OCR_GLM_ON_QUALITY_FLAGS", "1").lower()
    not in {"0", "false", "no", "off"}
)
OCR_ACCEPT_GLM_ONLY_IF_VALID = (
    os.getenv("OCR_ACCEPT_GLM_ONLY_IF_VALID", "1").lower()
    not in {"0", "false", "no", "off"}
)
OCR_SAFE_REPAIR_PERSON_TRIPLE = (
    os.getenv("OCR_SAFE_REPAIR_PERSON_TRIPLE", "0").lower()
    not in {"0", "false", "no", "off"}
)

# Token-level repair for dictionary phrase fields.
# Fixes cases like: KASHKADARYA REGIQON -> KASHKADARYA REGION.
# This is intentionally field-scoped and dictionary-scoped; we do NOT globally
# replace Q/O/E because Q can be a valid Latin character in Uzbek names/places.
OCR_SAFE_REPAIR_DICTIONARY_TOKENS = (
    os.getenv("OCR_SAFE_REPAIR_DICTIONARY_TOKENS", "1").lower()
    not in {"0", "false", "no", "off"}
)
OCR_SAFE_REPAIR_DICTIONARY_NEAREST = (
    os.getenv("OCR_SAFE_REPAIR_DICTIONARY_NEAREST", "1").lower()
    not in {"0", "false", "no", "off"}
)
OCR_DICTIONARY_NEAREST_MAX_DISTANCE = int(
    os.getenv("OCR_DICTIONARY_NEAREST_MAX_DISTANCE", "2")
)

# Датасет для спорных, но подтверждённых GLM OCR примеров:
# PaddleOCR дал низкий score, но текст совпал с GLM OCR.
LOW_CONF_AGREEMENT_DATASET_ENABLED = (
    os.getenv("LOW_CONF_AGREEMENT_DATASET_ENABLED", "1").lower()
    not in {"0", "false", "no", "off"}
)
LOW_CONF_AGREEMENT_DATASET_DIR = Path(
    os.getenv(
        "LOW_CONF_AGREEMENT_DATASET_DIR",
        str(PROJECT_ROOT / "datasets/paddle_low_conf_glm_agree"),
    )
)
LOW_CONF_AGREEMENT_SCORE_THRESHOLD = float(
    os.getenv(
        "LOW_CONF_AGREEMENT_SCORE_THRESHOLD",
        str(GLM_FIELD_FALLBACK_THRESHOLD),
    )
)

# Датасеты для активного улучшения PaddleOCR.
# Режим включается на запросе флагом ocr_improve=true.
# В этом режиме каждый OCR-сегмент читается и PaddleOCR, и GLM OCR.
# Если нормализованные тексты отличаются, а сегмент выглядит валидным,
# сохраняем passport-сегмент в датасет как 4 prepared-картинки:
# оригинал + 3 мягкие фото-аугментации, затем preprocess каждой версии.
OCR_IMPROVE_DATASET_ENABLED = (
    os.getenv("OCR_IMPROVE_DATASET_ENABLED", "1").lower()
    not in {"0", "false", "no", "off"}
)
OCR_IMPROVE_DATASET_ROOT = Path(
    os.getenv(
        "OCR_IMPROVE_DATASET_ROOT",
        str(PROJECT_ROOT / "datasets/ocr_improve"),
    )
)
OCR_IMPROVE_MIN_DOC_CONF = float(
    os.getenv("OCR_IMPROVE_MIN_DOC_CONF", "0.50")
)
OCR_IMPROVE_MIN_FIELD_CONF = float(
    os.getenv("OCR_IMPROVE_MIN_FIELD_CONF", "0.50")
)
OCR_IMPROVE_REQUIRE_CONFIDENT_ORIENTATION = (
    os.getenv("OCR_IMPROVE_REQUIRE_CONFIDENT_ORIENTATION", "1").lower()
    not in {"0", "false", "no", "off"}
)
OCR_IMPROVE_MAX_LABEL_LEN = int(
    os.getenv("OCR_IMPROVE_MAX_LABEL_LEN", "128")
)

# В режиме ocr_improve собираем датасет только для паспортов.
# Миграционные карты специально не трогаем, чтобы не загрязнять паспортный rec dataset.
OCR_IMPROVE_ALLOWED_DOC_TYPES = {"passport", "migration_card"}
ALLOWED_DOC_TYPES = {"passport", "migration_card"}

# На каждый найденный OCR-сегмент паспорта сохраняем 4 prepared-версии:
# оригинал + 3 мягкие фото-аугментации, затем preprocess каждой версии.
OCR_IMPROVE_AUGMENTATIONS_PER_SEGMENT = int(
    os.getenv("OCR_IMPROVE_AUGMENTATIONS_PER_SEGMENT", "3")
)

# Ollama API. Для vLLM/OpenAI-compatible клиента лучше вынести отдельный адаптер,
# но Ollama — самый простой быстрый Docker-вариант для glm-ocr.
GLM_OCR_URL = os.getenv(
    "GLM_OCR_URL",
    "http://127.0.0.1:8083/v1/chat/completions",
)
GLM_OCR_MODEL = os.getenv(
    "GLM_OCR_MODEL",
    "zai-org/GLM-OCR",
)
GLM_OCR_TIMEOUT_SEC = float(
    os.getenv("GLM_OCR_TIMEOUT_SEC", "12")
)

DOC_ALIASES = {
    "passport": "passport",
    "1_passport_uz": "passport",
    "migration_card": "migration_card",
    "27_migration_card": "migration_card",
}

PASSPORT_FIELD_NAMES = {
    "pas_number",
    "pas_surname",
    "pas_name",
    "pas_patronymic",
    "pas_nationality",
    "pas_date_of_birth",
    "pas_sex",
    "pas_place_of_birth",
    "pas_date_of_issue",
    "pas_date_of_expiry",
    "pas_authority",
    "pas_photo",
    "pas_mrz",
}

MIGRATION_FIELD_NAMES = {
    "mg_series",
    "mg_number",
    "mg_surname",
    "mg_surname_lat",
    "mg_name",
    "mg_patronymic",
    "mg_date_of_birth",
    "mg_nationality",
    "mg_passport_number",
    "mg_visa_number",
    "mg_duration_from",
    "mg_duration_to",
}

@asynccontextmanager
async def lifespan(app: FastAPI):
    load_models()
    yield
    cleanup_models()


# ---------------------------------------------------------------------
# APP / MODELS
# ---------------------------------------------------------------------

app = FastAPI(
    title="RecognizeUZ OCR API",
    version="1.0.0",
    lifespan=lifespan
)

infer_lock = Lock()
ocr_improve_dataset_lock = Lock()

doc_model: YOLO | None = None
passport_fields_model: YOLO | None = None
migration_fields_model: YOLO | None = None


# Кастомные TextRecognizer




def cleanup_models() -> None:
    global doc_model
    global passport_fields_model
    global migration_fields_model
    global passport_ocr
    global migration_ocr

    doc_model = None
    passport_fields_model = None
    migration_fields_model = None
    passport_ocr = None
    migration_ocr = None

def load_models() -> None:
    global doc_model
    global passport_fields_model
    global migration_fields_model
    global passport_ocr
    global migration_ocr

    os.environ.setdefault("CUDA_VISIBLE_DEVICES", str(DEVICE))

    doc_model = YOLO(str(DOC_MODEL_PATH))
    passport_fields_model = YOLO(str(PASSPORT_FIELDS_MODEL_PATH))
    migration_fields_model = YOLO(str(MIGRATION_FIELDS_MODEL_PATH))

    device = f"gpu:{DEVICE}" if USE_GPU else "cpu"

    passport_ocr = TextRecognizer(
        make_rec_args(
            rec_model_dir=PASSPORT_OCR_MODEL_DIR,
            rec_char_dict_path=PASSPORT_DICT_PATH,
        )
    )

    migration_ocr = TextRecognizer(
        make_rec_args(
            rec_model_dir=MIGRATION_OCR_MODEL_DIR,
            rec_char_dict_path=MIGRATION_DICT_PATH,
        )
    )


# ---------------------------------------------------------------------
# INPUT MODELS
# ---------------------------------------------------------------------

class Base64InputItem(BaseModel):
    filename: str
    content_base64: str


class Base64Request(BaseModel):
    files: list[Base64InputItem]
    # Можно передать debug как query-параметр /recognize-base64?debug=true
    # или прямо в JSON body: {"debug": true, "files": [...]}.
    debug: bool = False
    # Аналогично можно передать ocr_improve как query-параметр
    # /recognize-base64?ocr_improve=true или прямо в JSON body.
    ocr_improve: bool = False


# ---------------------------------------------------------------------
# IMAGE/PDF LOADING
# ---------------------------------------------------------------------

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


# ---------------------------------------------------------------------
# GEOMETRY
# ---------------------------------------------------------------------

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


# ---------------------------------------------------------------------
# OCR PREPROCESSING
# ---------------------------------------------------------------------

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


# ---------------------------------------------------------------------
# YOLO DETECTION
# ---------------------------------------------------------------------

def yolo_predict_segments(
    model: YOLO,
    image_bgr: np.ndarray,
    imgsz: int,
    conf: float,
) -> list[dict[str, Any]]:
    result = model.predict(
        image_bgr,
        imgsz=imgsz,
        conf=conf,
        verbose=False,
        device=DEVICE,
    )[0]

    if result.masks is None or result.boxes is None:
        return []

    names = model.names

    segments: list[dict[str, Any]] = []

    for cls_id, score, polygon in zip(
        result.boxes.cls.cpu().numpy(),
        result.boxes.conf.cpu().numpy(),
        result.masks.xy,
    ):
        class_id = int(cls_id)
        class_name = names[class_id]

        poly = np.array(
            polygon,
            dtype=np.float32,
        )

        if len(poly) < 3:
            continue

        segments.append(
            {
                "class_id": class_id,
                "class_name": class_name,
                "confidence": float(score),
                "polygon": poly,
                "bbox": bbox_from_polygon(poly),
            }
        )

    return segments

def build_full_image_passport_document(
    image_bgr: np.ndarray,
) -> dict[str, Any]:
    """
    Synthetic document fallback: the whole input image is treated as a passport.

    Needed when the request already contains a cropped passport page and the
    document detector therefore returns no document mask.
    """

    h, w = image_bgr.shape[:2]
    polygon = np.array(
        [
            [0, 0],
            [w - 1, 0],
            [w - 1, h - 1],
            [0, h - 1],
        ],
        dtype=np.float32,
    )

    return {
        "class_id": -1,
        "class_name": "passport",
        "confidence": 1.0,
        "polygon": polygon,
        "bbox": bbox_from_polygon(polygon),
        "type": "passport",

        # Служебные признаки для debug/понимания.
        "synthetic_document": True,
        "document_detection_fallback": "full_image_as_passport",
    }

def detect_documents(
    image_bgr: np.ndarray,
) -> list[dict[str, Any]]:
    assert doc_model is not None

    raw = yolo_predict_segments(
        model=doc_model,
        image_bgr=image_bgr,
        imgsz=DOC_IMGSZ,
        conf=DOC_CONF,
    )

    docs = []

    for item in raw:
        doc_type = DOC_ALIASES.get(item["class_name"])

        if doc_type is None:
            continue

        docs.append(
            {
                **item,
                "type": doc_type,
                "synthetic_document": False,
                "document_detection_fallback": None,
            }
        )

    docs.sort(
        key=lambda d: (
            d["bbox"][1],
            d["bbox"][0],
        )
    )

    if not docs and ASSUME_PASSPORT_WHEN_DOCUMENTS_EMPTY:
        return [build_full_image_passport_document(image_bgr)]

    return docs


def detect_fields(
    doc_type: str,
    doc_bgr: np.ndarray,
) -> list[dict[str, Any]]:
    if doc_type == "passport":
        assert passport_fields_model is not None
        model = passport_fields_model
        allowed = PASSPORT_FIELD_NAMES

    elif doc_type == "migration_card":
        assert migration_fields_model is not None
        model = migration_fields_model
        allowed = MIGRATION_FIELD_NAMES

    else:
        return []

    raw = yolo_predict_segments(
        model=model,
        image_bgr=doc_bgr,
        imgsz=FIELDS_IMGSZ,
        conf=FIELD_CONF,
    )

    fields = []

    for item in raw:
        field_name = item["class_name"]

        if field_name not in allowed:
            continue

        fields.append(
            {
                **item,
                "name": field_name,
            }
        )

    return keep_best_field_per_class(fields)


def keep_best_field_per_class(
    fields: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    best: dict[str, dict[str, Any]] = {}

    for f in fields:
        name = f["name"]

        if name not in best:
            best[name] = f
            continue

        if f["confidence"] > best[name]["confidence"]:
            best[name] = f

    return list(best.values())


# ---------------------------------------------------------------------
# ORIENTATION SCORING
# ---------------------------------------------------------------------

def center_of(field: dict[str, Any]) -> tuple[float, float]:
    poly = field["polygon"]
    return float(poly[:, 0].mean()), float(poly[:, 1].mean())


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

def is_orientation_confident(
    doc_type: str,
    fields: list[dict[str, Any]],
    score: float,
    image_shape: tuple[int, int, int],
) -> bool:
    names = {f["name"] for f in fields}

    if doc_type == "passport":
        # Для паспорта нормальный crop обычно даёт много полей.
        # pas_mrz и pas_photo — сильные якоря, но не делаем их строго обязательными.
        required_any = {
            "pas_number",
            "pas_surname",
            "pas_name",
            "pas_date_of_birth",
        }

        if len(fields) >= 8 and len(names & required_any) >= 3 and score >= 12:
            return True

        return False

    if doc_type == "migration_card":
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

    return False

def choose_best_document_orientation(
    doc_type: str,
    base_crop_bgr: np.ndarray,
) -> tuple[np.ndarray, list[dict[str, Any]], int, float, dict[str, Any]]:
    orientation_started = time.perf_counter()
    candidates = []

    def evaluate_angle(angle: int) -> dict[str, Any]:
        candidate_started = time.perf_counter()

        rotated = rotate_image(
            base_crop_bgr,
            angle,
        )

        yolo_started = time.perf_counter()
        fields = detect_fields(
            doc_type=doc_type,
            doc_bgr=rotated,
        )
        yolo_seconds = elapsed_seconds(yolo_started)

        scoring_started = time.perf_counter()
        if doc_type == "passport":
            score = score_passport_layout(
                fields,
                rotated.shape,
            )
        else:
            score = score_migration_layout(
                fields,
                rotated.shape,
            )
        layout_scoring_seconds = elapsed_seconds(scoring_started)

        return {
            "angle": angle,
            "image": rotated,
            "fields": fields,
            "score": score,
            "yolo_seconds": yolo_seconds,
            "layout_scoring_seconds": layout_scoring_seconds,
            "total_seconds": elapsed_seconds(candidate_started),
        }

    # 1. Быстрый путь: доверяем document YOLO + warp.
    first = evaluate_angle(0)
    candidates.append(first)

    if is_orientation_confident(
        doc_type=doc_type,
        fields=first["fields"],
        score=float(first["score"]),
        image_shape=first["image"].shape,
    ):
        best = first
    else:
        # 2. Самый вероятный плохой случай после warp — документ вверх ногами.
        second = evaluate_angle(180)
        candidates.append(second)

        if is_orientation_confident(
            doc_type=doc_type,
            fields=second["fields"],
            score=float(second["score"]),
            image_shape=second["image"].shape,
        ):
            best = second
        else:
            # 3. Полный fallback только если быстрые варианты не дали уверенности.
            tried_angles = {0, 180}

            for angle in [90, 270]:
                if angle in tried_angles:
                    continue

                candidates.append(
                    evaluate_angle(angle)
                )

            best = max(
                candidates,
                key=lambda x: x["score"],
            )

    for field in best["fields"]:
        field["timing"] = {
            "yolo_seconds": best["yolo_seconds"],
            "yolo_scope": "shared_for_all_fields_in_best_orientation",
            "orientation_angle": best["angle"],
        }

    timing = {
        "total_seconds": elapsed_seconds(orientation_started),
        "best_orientation_yolo_seconds": best["yolo_seconds"],
        "best_orientation_layout_scoring_seconds": best["layout_scoring_seconds"],
        "fast_orientation_used": len(candidates) == 1,
        "candidates": [
            {
                "angle": int(candidate["angle"]),
                "field_yolo_seconds": float(candidate["yolo_seconds"]),
                "layout_scoring_seconds": float(candidate["layout_scoring_seconds"]),
                "total_seconds": float(candidate["total_seconds"]),
                "score": float(candidate["score"]),
                "fields_count": len(candidate["fields"]),
            }
            for candidate in candidates
        ],
    }

    return (
        best["image"],
        best["fields"],
        int(best["angle"]),
        float(best["score"]),
        timing,
    )


# ---------------------------------------------------------------------
# OCR
# ---------------------------------------------------------------------

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
    if doc_type == "passport":
        assert passport_ocr is not None
        return passport_ocr

    assert migration_ocr is not None
    return migration_ocr


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

    if field_name in SKIP_OCR_FIELDS:
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

FIELD_LABELS = {
    "pas_number": "passport number",
    "pas_surname": "surname",
    "pas_name": "given name",
    "pas_patronymic": "patronymic",
    "pas_nationality": "nationality",
    "pas_date_of_birth": "date of birth",
    "pas_sex": "sex",
    "pas_place_of_birth": "place of birth",
    "pas_date_of_issue": "date of issue",
    "pas_date_of_expiry": "date of expiry",
    "pas_authority": "issuing authority",
    "mg_series": "migration card series",
    "mg_number": "migration card number",
    "mg_surname": "surname in Cyrillic",
    "mg_surname_lat": "surname in Latin",
    "mg_name": "given name",
    "mg_patronymic": "patronymic",
    "mg_date_of_birth": "date of birth",
    "mg_nationality": "nationality",
    "mg_passport_number": "passport number",
    "mg_visa_number": "visa number",
    "mg_duration_from": "valid from date",
    "mg_duration_to": "valid to date",
}

DOC_OUTPUT_FIELDS = {
    "passport": [
        "pas_number",
        "pas_surname",
        "pas_name",
        "pas_patronymic",
        "pas_nationality",
        "pas_date_of_birth",
        "pas_sex",
        "pas_place_of_birth",
        "pas_date_of_issue",
        "pas_date_of_expiry",
        "pas_authority",
    ],
    "migration_card": [
        "mg_series",
        "mg_number",
        "mg_surname",
        "mg_surname_lat",
        "mg_name",
        "mg_patronymic",
        "mg_date_of_birth",
        "mg_nationality",
        "mg_passport_number",
        "mg_visa_number",
        "mg_duration_from",
        "mg_duration_to",
    ],
}


def score_to_unit(score: float) -> float:
    """Поддержка обоих форматов: 0.95 и 95."""
    if score > 1.0:
        return score / 100.0
    return score


def elapsed_seconds(start: float) -> float:
    """Монотонное время в секундах для debug-профилирования."""
    return round(time.perf_counter() - start, 6)


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

def bgr_to_png_base64(image_bgr: np.ndarray) -> str:
    """
    Конвертирует OpenCV BGR image в PNG base64.
    Нужно для отправки изображения во vLLM OpenAI-compatible API.
    """

    ok, buffer = cv2.imencode(".png", image_bgr)

    if not ok:
        raise RuntimeError("Failed to encode image as PNG")

    return base64.b64encode(buffer.tobytes()).decode("ascii")

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



# ---------------------------------------------------------------------
# TRANSLITERATION / DATASET COLLECTION
# ---------------------------------------------------------------------

_UZ_APOSTROPHES = "ʻʼ‘’`´ʹ'"
_UZ_LATIN_TO_RUSSIAN_CYRILLIC_SINGLE = {
    "a": "а",
    "b": "б",
    "c": "с",
    "d": "д",
    "e": "е",
    "f": "ф",
    "g": "г",
    # Для миграционной карты нужен русский вариант, без узбекской Ҳ.
    "h": "х",
    "i": "и",
    # В русской записи узбекских ФИО J чаще выглядит как ДЖ:
    # JASUR -> ДЖАСУР, JURAEV -> ДЖУРАЕВ.
    "j": "дж",
    "k": "к",
    "l": "л",
    "m": "м",
    "n": "н",
    "o": "о",
    "p": "п",
    # В русской миграционной записи не используем Қ.
    "q": "к",
    "r": "р",
    "s": "с",
    "t": "т",
    "u": "у",
    "v": "в",
    "w": "в",
    "x": "х",
    "y": "й",
    "z": "з",
}


_RUSSIAN_CYRILLIC_VOWELS = set("аеёиоуыэюяАЕЁИОУЫЭЮЯ")


# Словарь поверх алгоритмической транслитерации.
# Нужен для тех значений, где в российских миграционных документах обычно
# используется традиционная русская форма, а не буквальный перевод узбекской
# латиницы: TOSHKENT -> ТАШКЕНТ, SAMARQAND -> САМАРКАНД и т.д.
_RU_MIGRATION_COMMON_EXACT = {
    # Страна / республика
    "UZBEKISTAN": "УЗБЕКИСТАН",
    "O'ZBEKISTON": "УЗБЕКИСТАН",
    "OZBEKISTON": "УЗБЕКИСТАН",
    "UZB": "УЗБЕКИСТАН",

    # Города / области / регионы Узбекистана
    "TOSHKENT": "ТАШКЕНТ",
    "TASHKENT": "ТАШКЕНТ",
    "SAMARQAND": "САМАРКАНД",
    "SAMARKAND": "САМАРКАНД",
    "BUXORO": "БУХАРА",
    "BUKHARA": "БУХАРА",
    "ANDIJON": "АНДИЖАН",
    "ANDIZHAN": "АНДИЖАН",
    "FARG'ONA": "ФЕРГАНА",
    "FARGONA": "ФЕРГАНА",
    "FERGANA": "ФЕРГАНА",
    "NAMANGAN": "НАМАНГАН",
    "JIZZAX": "ДЖИЗАК",
    "JIZZAKH": "ДЖИЗАК",
    "NAVOIY": "НАВОИ",
    "NAVOI": "НАВОИ",
    "NUKUS": "НУКУС",
    "QARSHI": "КАРШИ",
    "KARSHI": "КАРШИ",
    "TERMIZ": "ТЕРМЕЗ",
    "TERMEZ": "ТЕРМЕЗ",
    "URGANCH": "УРГЕНЧ",
    "URGENCH": "УРГЕНЧ",
    "GULISTON": "ГУЛИСТАН",
    "GULISTAN": "ГУЛИСТАН",
    "ANGREN": "АНГРЕН",
    "OLMALIQ": "АЛМАЛЫК",
    "ALMALYK": "АЛМАЛЫК",
    "QO'QON": "КОКАНД",
    "QOQON": "КОКАНД",
    "KOKAND": "КОКАНД",
    "CHIRCHIQ": "ЧИРЧИК",
    "CHIRCHIK": "ЧИРЧИК",
    "MARG'ILON": "МАРГИЛАН",
    "MARGILON": "МАРГИЛАН",
    "SHAHRISABZ": "ШАХРИСАБЗ",
    "ZARAFSHON": "ЗАРАФШАН",
    "ZARAFSHAN": "ЗАРАФШАН",
    "DENOV": "ДЕНАУ",
    "DENAU": "ДЕНАУ",
    "BEKOBOD": "БЕКАБАД",
    "BEKABAD": "БЕКАБАД",
    "KATTAQO'RG'ON": "КАТТАКУРГАН",
    "KATTAQORGON": "КАТТАКУРГАН",
    "KATTAKURGAN": "КАТТАКУРГАН",
    "QASHQADARYO": "КАШКАДАРЬЯ",
    "KASHKADARYA": "КАШКАДАРЬЯ",
    "SURXONDARYO": "СУРХАНДАРЬЯ",
    "SURKHANDARYA": "СУРХАНДАРЬЯ",
    "SIRDARYO": "СЫРДАРЬЯ",
    "SYRDARYA": "СЫРДАРЬЯ",
    "XORAZM": "ХОРЕЗМ",
    "KHOREZM": "ХОРЕЗМ",
    "QORAQALPOG'ISTON": "КАРАКАЛПАКСТАН",
    "QORAQALPOGISTON": "КАРАКАЛПАКСТАН",
    "KARAKALPAKSTAN": "КАРАКАЛПАКСТАН",
}

_RU_MIGRATION_PLACE_EXACT = {
    **_RU_MIGRATION_COMMON_EXACT,

    # Области. В документах РФ обычно пишут русскую традиционную форму.
    "TOSHKENT VILOYATI": "ТАШКЕНТСКАЯ ОБЛАСТЬ",
    "TASHKENT VILOYATI": "ТАШКЕНТСКАЯ ОБЛАСТЬ",
    "SAMARQAND VILOYATI": "САМАРКАНДСКАЯ ОБЛАСТЬ",
    "SAMARKAND VILOYATI": "САМАРКАНДСКАЯ ОБЛАСТЬ",
    "BUXORO VILOYATI": "БУХАРСКАЯ ОБЛАСТЬ",
    "BUKHARA VILOYATI": "БУХАРСКАЯ ОБЛАСТЬ",
    "ANDIJON VILOYATI": "АНДИЖАНСКАЯ ОБЛАСТЬ",
    "ANDIZHAN VILOYATI": "АНДИЖАНСКАЯ ОБЛАСТЬ",
    "FARG'ONA VILOYATI": "ФЕРГАНСКАЯ ОБЛАСТЬ",
    "FARGONA VILOYATI": "ФЕРГАНСКАЯ ОБЛАСТЬ",
    "FERGANA VILOYATI": "ФЕРГАНСКАЯ ОБЛАСТЬ",
    "NAMANGAN VILOYATI": "НАМАНГАНСКАЯ ОБЛАСТЬ",
    "JIZZAX VILOYATI": "ДЖИЗАКСКАЯ ОБЛАСТЬ",
    "JIZZAKH VILOYATI": "ДЖИЗАКСКАЯ ОБЛАСТЬ",
    "NAVOIY VILOYATI": "НАВОИЙСКАЯ ОБЛАСТЬ",
    "NAVOI VILOYATI": "НАВОИЙСКАЯ ОБЛАСТЬ",
    "QASHQADARYO VILOYATI": "КАШКАДАРЬИНСКАЯ ОБЛАСТЬ",
    "KASHKADARYA VILOYATI": "КАШКАДАРЬИНСКАЯ ОБЛАСТЬ",
    "SURXONDARYO VILOYATI": "СУРХАНДАРЬИНСКАЯ ОБЛАСТЬ",
    "SURKHANDARYA VILOYATI": "СУРХАНДАРЬИНСКАЯ ОБЛАСТЬ",
    "SIRDARYO VILOYATI": "СЫРДАРЬИНСКАЯ ОБЛАСТЬ",
    "SYRDARYA VILOYATI": "СЫРДАРЬИНСКАЯ ОБЛАСТЬ",
    "XORAZM VILOYATI": "ХОРЕЗМСКАЯ ОБЛАСТЬ",
    "KHOREZM VILOYATI": "ХОРЕЗМСКАЯ ОБЛАСТЬ",

    # Республика Каракалпакстан.
    "QORAQALPOG'ISTON RESPUBLIKASI": "РЕСПУБЛИКА КАРАКАЛПАКСТАН",
    "QORAQALPOGISTON RESPUBLIKASI": "РЕСПУБЛИКА КАРАКАЛПАКСТАН",
    "KARAKALPAKSTAN RESPUBLIKASI": "РЕСПУБЛИКА КАРАКАЛПАКСТАН",

    # Город Ташкент.
    "TOSHKENT SHAHRI": "Г. ТАШКЕНТ",
    "TASHKENT SHAHRI": "Г. ТАШКЕНТ",
    "TOSHKENT SH": "Г. ТАШКЕНТ",
    "TASHKENT SH": "Г. ТАШКЕНТ",
    "TOSHKENT CITY": "Г. ТАШКЕНТ",
    "TASHKENT CITY": "Г. ТАШКЕНТ",
}

_RU_MIGRATION_NATIONALITY_EXACT = {
    # Национальность / гражданство в русской форме.
    "O'ZBEK": "УЗБЕК",
    "OZBEK": "УЗБЕК",
    "UZBEK": "УЗБЕК",
    "O'ZBEKISTON": "УЗБЕКИСТАН",
    "OZBEKISTON": "УЗБЕКИСТАН",
    "UZBEKISTAN": "УЗБЕКИСТАН",
    "TOJIK": "ТАДЖИК",
    "TAJIK": "ТАДЖИК",
    "QIRG'IZ": "КИРГИЗ",
    "QIRGIZ": "КИРГИЗ",
    "KYRGYZ": "КИРГИЗ",
    "QOZOQ": "КАЗАХ",
    "QAZAQ": "КАЗАХ",
    "KAZAKH": "КАЗАХ",
    "TURKMAN": "ТУРКМЕН",
    "RUS": "РУССКИЙ",
    "RUSSIAN": "РУССКИЙ",
    "QORAQALPOQ": "КАРАКАЛПАК",
    "QORAQALPOG'": "КАРАКАЛПАК",
    "QORAQALPOG": "КАРАКАЛПАК",
    "KARAKALPAK": "КАРАКАЛПАК",
}

_RU_MIGRATION_FIELD_EXACT_OVERRIDES = {
    "pas_place_of_birth": _RU_MIGRATION_PLACE_EXACT,
    "pas_nationality": _RU_MIGRATION_NATIONALITY_EXACT,
    "mg_nationality": _RU_MIGRATION_NATIONALITY_EXACT,
}

# Пост-замены нужны, когда поле не совпало со словарём полностью:
# например, "TOSHKENT VILOYATI YANGIYUL TUMANI".
_RU_MIGRATION_CYRILLIC_PHRASE_REPLACEMENTS = {
    "ТОШКЕНТ": "ТАШКЕНТ",
    "ТОШКЕНТСКАЯ": "ТАШКЕНТСКАЯ",
    "САМАРКАНД": "САМАРКАНД",
    "БУХОРО": "БУХАРА",
    "АНДИЖОН": "АНДИЖАН",
    "ФАРГОНА": "ФЕРГАНА",
    "ДЖИЗЗАХ": "ДЖИЗАК",
    "НАВОИЙ": "НАВОИ",
    "КАШКАДАРЁ": "КАШКАДАРЬЯ",
    "КАШКАДАРЙО": "КАШКАДАРЬЯ",
    "СУРХОНДАРЁ": "СУРХАНДАРЬЯ",
    "СУРХОНДАРЙО": "СУРХАНДАРЬЯ",
    "СИРДАРЁ": "СЫРДАРЬЯ",
    "СИРДАРЙО": "СЫРДАРЬЯ",
    "ХОРАЗМ": "ХОРЕЗМ",
    "КОРАКАЛПОГИСТОН": "КАРАКАЛПАКСТАН",
    "КОРАКАЛПОК": "КАРАКАЛПАК",
    "КОКОН": "КОКАНД",
    "МАРГИЛОН": "МАРГИЛАН",
    "ЗАРАФШОН": "ЗАРАФШАН",
    "БЕКОБОД": "БЕКАБАД",
    "КАТТАКОРГОН": "КАТТАКУРГАН",
    "ТЕРМИЗ": "ТЕРМЕЗ",
    "ЯНГИЮЛ": "ЯНГИЮЛЬ",
    "ЯНГИЙУЛ": "ЯНГИЮЛЬ",
    "ВИЛОЯТИ": "ОБЛАСТЬ",
    "ТУМАНИ": "РАЙОН",
    "ШАХРИ": "Г.",
    "РЕСПУБЛИКАСИ": "РЕСПУБЛИКА",
}


def _migration_dictionary_key(text: str) -> str:
    key = unicodedata.normalize("NFKC", str(text)).strip().upper()

    for apostrophe in _UZ_APOSTROPHES:
        key = key.replace(apostrophe, "'")

    # Убираем мусор OCR, но оставляем апостроф, потому что O' / G' значимы.
    key = key.replace("–", "-").replace("—", "-")
    key = re.sub(r"[.,;:()\[\]{}\"“”]+", " ", key)
    key = re.sub(r"[-_/]+", " ", key)
    key = re.sub(r"\s+", " ", key).strip()

    # Частые сокращения из адресных строк.
    key = re.sub(r"\bVIL\b", "VILOYATI", key)
    key = re.sub(r"\bTUM\b", "TUMANI", key)
    key = re.sub(r"\bRESP\b", "RESPUBLIKASI", key)

    return key


def _apply_dictionary_text_case(src: str, dst: str) -> str:
    letters = [ch for ch in src if ch.isalpha()]

    if letters and all(ch.isupper() for ch in letters):
        return dst.upper()

    if src[:1].isupper() and not src.isupper():
        # Для "Toshkent" вернём "Ташкент", но аббревиатуры типа "Г."
        # останутся корректными через title() не всегда, поэтому обрабатываем
        # только простые строки без точки.
        if "." not in dst:
            return dst.title()

    return dst


def _lookup_russian_migration_dictionary(
    text: str,
    *,
    field_name: str | None = None,
) -> str | None:
    key = _migration_dictionary_key(text)

    if not key:
        return None

    if field_name:
        field_dict = _RU_MIGRATION_FIELD_EXACT_OVERRIDES.get(field_name)
        if field_dict and key in field_dict:
            return _apply_dictionary_text_case(text, field_dict[key])

    if key in _RU_MIGRATION_COMMON_EXACT:
        return _apply_dictionary_text_case(text, _RU_MIGRATION_COMMON_EXACT[key])

    return None


def _normalize_latin_migration_text_for_replacements(text: str) -> str:
    result = unicodedata.normalize("NFKC", str(text))

    for apostrophe in _UZ_APOSTROPHES:
        result = result.replace(apostrophe, "'")

    # Приводим частые сокращения к полной форме, чтобы словарь сработал
    # и на "TOSHKENT VIL." / "TOSHKENT SH.".
    result = re.sub(r"\bVIL\.", "VILOYATI", result, flags=re.IGNORECASE)
    result = re.sub(r"\bTUM\.", "TUMANI", result, flags=re.IGNORECASE)
    result = re.sub(r"\bRESP\.", "RESPUBLIKASI", result, flags=re.IGNORECASE)
    result = re.sub(r"\bSH\.", "SHAHRI", result, flags=re.IGNORECASE)

    return result


def _latin_dictionary_pattern(key: str) -> str:
    escaped_parts = [re.escape(part) for part in key.split()]
    body = r"\s+".join(escaped_parts)
    return rf"(?<![A-Za-z0-9']){body}(?![A-Za-z0-9'])"


def _apply_latin_migration_phrase_replacements(
    text: str,
    *,
    field_name: str | None = None,
) -> str:
    """
    Заменяет известные латинские фразы до посимвольной транслитерации.
    Это позволяет нормально обработать длинные строки:
      TOSHKENT VILOYATI YANGIYUL TUMANI
      -> ТАШКЕНТСКАЯ ОБЛАСТЬ ЯНГИЮЛЬ РАЙОН
    """

    result = _normalize_latin_migration_text_for_replacements(text)

    replacement_dicts: list[dict[str, str]] = []

    if field_name:
        field_dict = _RU_MIGRATION_FIELD_EXACT_OVERRIDES.get(field_name)
        if field_dict:
            replacement_dicts.append(field_dict)

    replacement_dicts.append(_RU_MIGRATION_COMMON_EXACT)

    seen: set[str] = set()
    replacements: list[tuple[str, str]] = []

    for dictionary in replacement_dicts:
        for key, value in dictionary.items():
            if key in seen:
                continue
            seen.add(key)
            replacements.append((key, value))

    for key, value in sorted(
        replacements,
        key=lambda item: len(item[0]),
        reverse=True,
    ):
        result = re.sub(
            _latin_dictionary_pattern(key),
            value,
            result,
            flags=re.IGNORECASE,
        )

    return result


def _apply_russian_migration_post_replacements(text: str) -> str:
    result = text

    for src, dst in sorted(
        _RU_MIGRATION_CYRILLIC_PHRASE_REPLACEMENTS.items(),
        key=lambda item: len(item[0]),
        reverse=True,
    ):
        pattern = rf"(?<!\w){re.escape(src)}(?!\w)"
        result = re.sub(pattern, dst, result, flags=re.IGNORECASE)

    return result


def _apply_case(src: str, dst: str) -> str:
    if src.isupper():
        return dst.upper()

    if len(src) > 1 and src[0].isupper():
        return dst[:1].upper() + dst[1:]

    return dst


def _is_word_start(src: str, index: int) -> bool:
    j = index - 1

    while j >= 0:
        ch = src[j]

        if ch.isspace() or ch in "-_/.,;:()[]{}\"'":
            return True

        if ch.isalnum():
            return False

        j -= 1

    return True


_UZ_LATIN_TO_RUSSIAN_CYRILLIC_TRIPLETS = {
    "yo'": "ю",
}

_UZ_LATIN_TO_RUSSIAN_CYRILLIC_PAIRS = {
    # Passport / MRZ-style Latin variants.
    "kh": "х",  # KHUDAYBERGENOV -> ХУДАЙБЕРГЕНОВ, not КХ...
    "zh": "ж",
    "dj": "дж",

    # Uzbek/common digraphs.
    "sh": "ш",
    "ch": "ч",

    # Iotated vowels / common transliteration pairs.
    "yo": "йо",
    "yu": "ю",
    "ya": "я",
    "ye": "е",
    "ts": "ц",
}


def transliterate_uz_latin_to_russian_cyrillic(text: str) -> str:
    """
    Узбекская латиница -> русская кириллица для формы, похожей на
    миграционную карту РФ.

    Это не узбекская кириллица. Специально не используем Қ/Ғ/Ў/Ҳ:
      Q -> К
      G' -> Г
      O' -> У
      H -> Х
      X -> Х
      J -> ДЖ

    Для ФИО этого обычно достаточно. Для населённых пунктов идеального
    алгоритма нет: TOSHKENT формально даст ТОШКЕНТ, а в русском документе
    часто нужен традиционный вариант ТАШКЕНТ. Такие случаи лучше закрывать
    отдельным словарём нормализации поверх этой функции.
    """

    if not text:
        return ""

    src = text
    for apostrophe in _UZ_APOSTROPHES:
        src = src.replace(apostrophe, "'")

    out: list[str] = []
    i = 0

    while i < len(src):
        ch = src[i]
        low = ch.lower()

        # O' / G' в российской миграционной записи не должны становиться
        # Ў / Ғ. Используем приближённую русскую запись.
        if (
            i + 1 < len(src)
            and src[i + 1] == "'"
            and low in {"o", "g"}
        ):
            repl = "у" if low == "o" else "г"
            out.append(_apply_case(ch, repl))
            i += 2
            continue

        if i + 2 < len(src):
            triplet = src[i:i + 3]
            triplet_low = triplet.lower()

            repl = _UZ_LATIN_TO_RUSSIAN_CYRILLIC_TRIPLETS.get(triplet_low)
            if repl is not None:
                out.append(_apply_case(triplet, repl))
                i += 3
                continue

        if i + 1 < len(src):
            pair = src[i:i + 2]
            pair_low = pair.lower()

            repl = _UZ_LATIN_TO_RUSSIAN_CYRILLIC_PAIRS.get(pair_low)
            if repl is not None:
                out.append(_apply_case(pair, repl))
                i += 2
                continue

        if low == "e" and _is_word_start(src, i):
            out.append(_apply_case(ch, "э"))
            i += 1
            continue

        repl = _UZ_LATIN_TO_RUSSIAN_CYRILLIC_SINGLE.get(low)
        if repl is None:
            out.append(ch)
        else:
            out.append(_apply_case(ch, repl))

        i += 1

    return "".join(out)


def transliterate_uz_latin_to_russian_migration_cyrillic(
    text: str,
    *,
    field_name: str | None = None,
) -> str:
    """
    Узбекская латиница -> русская кириллица в стиле миграционной карты РФ.

    Порядок:
      1. точное совпадение по полевому словарю;
      2. точное совпадение по общему словарю;
      3. алгоритмическая транслитерация;
      4. пост-замены традиционных русских форм внутри длинной строки.
    """

    dictionary_value = _lookup_russian_migration_dictionary(
        text,
        field_name=field_name,
    )

    if dictionary_value is not None:
        return dictionary_value

    preprocessed = _apply_latin_migration_phrase_replacements(
        text,
        field_name=field_name,
    )
    transliterated = transliterate_uz_latin_to_russian_cyrillic(preprocessed)
    return _apply_russian_migration_post_replacements(transliterated)


# Старое имя оставляем как alias, чтобы не искать все вызовы и не ломать
# возможные внешние импорты/тесты. Но теперь оно возвращает русский вариант
# с миграционными словарными нормализациями.
def transliterate_uz_latin_to_cyrillic(text: str) -> str:
    return transliterate_uz_latin_to_russian_migration_cyrillic(text)


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


def safe_filename_part(value: str, max_len: int = 80) -> str:
    value = re.sub(r"[^a-zA-Z0-9а-яА-ЯёЁ._-]+", "_", value)
    value = value.strip("._-")
    return value[:max_len] or "empty"


def append_unique_line(path: Path, line: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    if path.exists():
        with path.open("r", encoding="utf-8") as f:
            for existing in f:
                if existing.rstrip("\n") == line.rstrip("\n"):
                    return

    with path.open("a", encoding="utf-8") as f:
        f.write(line)


def save_low_conf_agreement_sample(
    *,
    doc_type: str,
    field_name: str,
    field_crop_bgr: np.ndarray,
    paddle_text: str,
    paddle_score: float,
    glm_text: str,
    source_file: str,
    file_index: int,
    page_index: int,
    document_index: int,
) -> dict[str, Any] | None:
    """
    Сохраняет crop в PaddleOCR-rec датасет, если:
    - PaddleOCR score ниже порога;
    - GLM OCR прочитал то же значение;
    - текст не пустой.

    Формат:
      <dataset>/<doc_type>/<field_name>/images/<hash>.png
      <dataset>/<doc_type>/<field_name>/labels.txt
      <dataset>/metadata.jsonl
    """

    if not LOW_CONF_AGREEMENT_DATASET_ENABLED:
        return None

    paddle_score = score_to_unit(float(paddle_score))

    if paddle_score >= LOW_CONF_AGREEMENT_SCORE_THRESHOLD:
        return None

    if not paddle_and_glm_texts_match(paddle_text, glm_text):
        return None

    label = clean_glm_text(glm_text) or clean_glm_text(paddle_text)
    if not label:
        return None

    ok, encoded = cv2.imencode(".png", field_crop_bgr)
    if not ok:
        return None

    label_norm = normalize_ocr_text_for_match(label)
    digest = hashlib.sha1(
        encoded.tobytes()
        + b"\0"
        + field_name.encode("utf-8")
        + b"\0"
        + label_norm.encode("utf-8")
    ).hexdigest()[:24]

    field_dir = (
        LOW_CONF_AGREEMENT_DATASET_DIR
        / safe_filename_part(doc_type)
        / safe_filename_part(field_name)
    )
    image_dir = field_dir / "images"
    image_dir.mkdir(parents=True, exist_ok=True)

    image_path = image_dir / f"{digest}.png"
    is_new_image = not image_path.exists()

    if is_new_image:
        cv2.imwrite(str(image_path), field_crop_bgr)

    rel_image_path = image_path.relative_to(LOW_CONF_AGREEMENT_DATASET_DIR).as_posix()

    # Общий labels.txt удобен как готовый rec_gt_train.txt для PaddleOCR,
    # а labels.txt внутри поля — для быстрой ручной проверки по конкретному полю.
    root_labels_path = LOW_CONF_AGREEMENT_DATASET_DIR / "labels.txt"
    labels_path = field_dir / "labels.txt"

    label_line = f"{rel_image_path}\t{label}\n"

    append_unique_line(root_labels_path, label_line)
    append_unique_line(labels_path, label_line)

    metadata = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "doc_type": doc_type,
        "field_name": field_name,
        "label": label,
        "paddle_text": paddle_text,
        "glm_text": glm_text,
        "paddle_score": paddle_score,
        "threshold": LOW_CONF_AGREEMENT_SCORE_THRESHOLD,
        "source_file": source_file,
        "file_index": file_index,
        "page_index": page_index,
        "document_index": document_index,
        "image_path": str(image_path),
        "root_label_path": str(root_labels_path),
        "field_label_path": str(labels_path),
    }

    metadata_path = LOW_CONF_AGREEMENT_DATASET_DIR / "metadata.jsonl"

    if is_new_image:
        metadata_path.parent.mkdir(parents=True, exist_ok=True)
        with metadata_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(metadata, ensure_ascii=False) + "\n")

    return {
        "saved": True,
        "new_image": is_new_image,
        "image_path": str(image_path),
        "root_label_path": str(root_labels_path),
        "field_label_path": str(labels_path),
        "label": label,
    }



# ---------------------------------------------------------------------
# OCR IMPROVE DATASET COLLECTION
# ---------------------------------------------------------------------

DATE_FIELD_NAMES = {
    "pas_date_of_birth",
    "pas_date_of_issue",
    "pas_date_of_expiry",
    "mg_date_of_birth",
    "mg_duration_from",
    "mg_duration_to",
}

SEX_FIELD_NAMES = {
    "pas_sex",
}

PERSON_NAME_FIELD_NAMES = {
    "pas_surname",
    "pas_name",
    "pas_patronymic",
    "mg_surname",
    "mg_surname_lat",
    "mg_name",
    "mg_patronymic",
}

NUMBERISH_FIELD_NAMES = {
    "pas_number",
    "mg_series",
    "mg_number",
    "mg_passport_number",
    "mg_visa_number",
}


def collapse_label_spaces(text: str) -> str:
    return re.sub(r"\s+", " ", clean_glm_text(text)).strip()


def has_any_letter_or_digit(text: str) -> bool:
    return bool(re.search(r"[0-9A-Za-zА-Яа-яЁё]", text))


def looks_like_glm_explanation_or_markup(text: str) -> bool:
    stripped = text.strip()
    lowered = stripped.lower()

    if not stripped:
        return False

    if stripped.startswith(("{", "[", "```")):
        return True

    banned_fragments = {
        "document type",
        "field:",
        "requested document field",
        "return only",
        "visible text",
        "the text is",
        "i can",
        "i cannot",
        "не могу",
        "на изображении",
        "текст:",
        "поле:",
    }

    return any(fragment in lowered for fragment in banned_fragments)


def validate_glm_label_for_field(
    *,
    doc_type: str,
    field_name: str,
    glm_text: str,
) -> tuple[str | None, str | None]:
    """
    Возвращает (label, reject_reason).

    Это защита от случаев, когда YOLO вырезал не текстовое поле или GLM
    начал объяснять/галлюцинировать. Правила специально мягкие: лучше
    сохранить чуть меньше, чем положить в датасет мусор с неправильной меткой.
    """

    label = collapse_label_spaces(glm_text)

    if not label:
        return None, "empty_glm_text"

    if len(label) > OCR_IMPROVE_MAX_LABEL_LEN:
        return None, "glm_text_too_long"

    if "\n" in clean_glm_text(glm_text):
        return None, "glm_text_multiline"

    if looks_like_glm_explanation_or_markup(label):
        return None, "glm_explanation_or_markup"

    if not has_any_letter_or_digit(label):
        return None, "glm_text_without_letters_or_digits"

    normalized = normalize_ocr_text_for_match(label)

    if field_name in DATE_FIELD_NAMES:
        # Принимаем 01.02.1999 / 01-02-1999 / 01 02 1999 / 1.2.99.
        if not re.fullmatch(r"\d{1,2}[./\- ]\d{1,2}[./\- ]\d{2,4}", label):
            return None, "invalid_date_format"

    elif field_name in SEX_FIELD_NAMES:
        allowed = {
            "M",
            "F",
            "М",
            "Ж",
            "MALE",
            "FEMALE",
            "ERKAK",
            "AYOL",
            "МУЖ",
            "ЖЕН",
            "МУЖСКОЙ",
            "ЖЕНСКИЙ",
        }
        if normalized not in allowed:
            return None, "invalid_sex_value"

    elif field_name in PERSON_NAME_FIELD_NAMES:
        # ФИО не должны состоять только из цифр/символов.
        if not re.search(r"[A-Za-zА-Яа-яЁё]", label):
            return None, "name_without_letters"
        if not re.fullmatch(r"[A-Za-zА-Яа-яЁёʻʼ‘’`´ʹ'\- .]+", label):
            return None, "name_has_forbidden_chars"

    elif field_name in NUMBERISH_FIELD_NAMES:
        # Номера могут содержать буквы, цифры, пробелы и дефисы.
        if not re.fullmatch(r"[A-Za-zА-Яа-яЁё0-9\- /]+", label):
            return None, "number_has_forbidden_chars"
        if len(normalized) < 1:
            return None, "number_too_short"

    else:
        # Адреса/органы выдачи/национальность — шире, но без явного мусора.
        if not re.fullmatch(r"[A-Za-zА-Яа-яЁё0-9ʻʼ‘’`´ʹ'\- ./,№()]+", label):
            return None, "text_has_forbidden_chars"

    return label, None


# ---------------------------------------------------------------------
# OCR QUALITY / TTA / SAFE REPAIR
# ---------------------------------------------------------------------

PASSPORT_NUMBER_RE = re.compile(r"^[A-Z]{2}\d{7}$")
PASSPORT_DATE_RE = re.compile(r"^\d{2}\.\d{2}\.\d{4}$")

PASSPORT_AUTHORITY_RE = re.compile(r"^[A-Z]{3}\s+\d{5}$")
PASSPORT_AUTHORITY_KNOWN_PREFIXES = {
    item.strip().upper()
    for item in os.getenv("PASSPORT_AUTHORITY_KNOWN_PREFIXES", "MIA,PSC").split(",")
    if item.strip()
}


STRICT_FORMAT_FIELD_NAMES = {
    "pas_number",
    "pas_authority",
    *DATE_FIELD_NAMES,
    *SEX_FIELD_NAMES,
}

OCR_DICTIONARY_REPAIR_FIELD_NAMES = {
    "pas_nationality",
    "mg_nationality",
    "pas_place_of_birth",
}

# Token-level dictionary repair is weaker than exact field dictionary repair:
# it only repairs a broken token when the repaired token is in a small allow-list
# (REGIQON -> REGION, REGI0N -> REGION, etc.).
# Keep it disabled for names, dates, sex, and numeric/id fields, but allow it for
# free text fields such as place/authority even if field_name was not in
# OCR_DICTIONARY_REPAIR_FIELD_NAMES.
def should_allow_dictionary_token_repair(field_name: str) -> bool:
    if field_name in SKIP_OCR_FIELDS:
        return False

    if field_name in PERSON_NAME_FIELD_NAMES:
        return False

    if field_name in DATE_FIELD_NAMES:
        return False

    if field_name in SEX_FIELD_NAMES:
        return False

    if field_name in NUMBERISH_FIELD_NAMES:
        return False

    return True

# Значения, где безопасно исправлять ровно один лишний повтор,
# если кандидат после удаления повтора попадает в словарь.
# ФИО сюда намеренно не включаем: ABDULLAEV/ALLABERGANOV могут быть нормой.
OCR_SAFE_REPAIR_ENGLISH_PLACE_VALUES = {
    "TASHKENT REGION",
    "SAMARKAND REGION",
    "BUKHARA REGION",
    "ANDIJAN REGION",
    "FERGANA REGION",
    "NAMANGAN REGION",
    "JIZZAKH REGION",
    "NAVOI REGION",
    "KASHKADARYA REGION",
    "SURKHANDARYA REGION",
    "SYRDARYA REGION",
    "KHOREZM REGION",
    "REPUBLIC OF KARAKALPAKSTAN",
    "KARAKALPAKSTAN REPUBLIC",
    "TASHKENT CITY",
}

OCR_SAFE_REPAIR_EXACT_VALUES = {
    *_RU_MIGRATION_COMMON_EXACT.keys(),
    *_RU_MIGRATION_PLACE_EXACT.keys(),
    *_RU_MIGRATION_NATIONALITY_EXACT.keys(),
    *OCR_SAFE_REPAIR_ENGLISH_PLACE_VALUES,
    "UZBEKISTAN",
    "KARAKALPAKSTAN",
    "QORAQALPOGISTON",
    "KARAKALPAK",
    "QORAQALPOQ",
    "UZBEK",
    "TAJIK",
    "KYRGYZ",
    "KAZAKH",
    "TURKMAN",
    "RUSSIAN",
}

# Token dictionary used for safe repair inside longer place/nationality phrases.
# Examples:
#   KASHKADARYA REGIQON -> KASHKADARYA REGION  (delete extra Q)
#   SURKHANDARYA REGI0N -> SURKHANDARYA REGION (0 -> O)
def _build_safe_repair_token_values() -> set[str]:
    values: set[str] = set()

    for phrase in OCR_SAFE_REPAIR_EXACT_VALUES:
        norm = normalize_ocr_phrase_for_token_repair(str(phrase))
        for token in re.findall(r"[A-Z0-9]+", norm):
            if len(token) >= 2:
                values.add(token)

    values.update(
        {
            # English administrative words commonly printed in passport place fields.
            "REGION",
            "REPUBLIC",
            "DISTRICT",
            "CITY",
            "TOWN",
            "VILLAGE",
            "PROVINCE",
            "AREA",

            # Uzbek administrative words, in case the OCR reads the Uzbek/Latin line.
            "VILOYATI",
            "TUMANI",
            "SHAHRI",
            "RESPUBLIKASI",

            # Common English spellings of Uzbekistan regions/cities.
            "KASHKADARYA",
            "SURKHANDARYA",
            "SYRDARYA",
            "TASHKENT",
            "SAMARKAND",
            "BUKHARA",
            "ANDIJAN",
            "FERGANA",
            "JIZZAKH",
            "NAVOI",
            "KHOREZM",
            "KARSHI",
            "NUKUS",
            "TERMEZ",
            "URGENCH",
            "GULISTAN",
            "CHIRCHIK",
            "KOKAND",
            "MARGILAN",
            "SHAHRISABZ",
            "KARAKALPAKSTAN",
        }
    )

    return values


OCR_SAFE_REPAIR_TOKEN_VALUES = _build_safe_repair_token_values()

# Confusable substitutions are used only when the resulting token is in
# OCR_SAFE_REPAIR_TOKEN_VALUES, so this does not globally rewrite valid Q.
OCR_TOKEN_CONFUSABLE_REPLACEMENTS = {
    "0": {"O"},
    "О": {"O"},
    "Q": {"O"},  # REGIQN -> REGION; not applied unless REGION is a known token.
    "1": {"I", "L"},
    "I": {"1"},
    "L": {"I"},
    "5": {"S"},
    "8": {"B"},
}


def normalize_numberish_for_schema(text: str) -> str:
    value = normalize_ocr_text_for_match(text)
    value = re.sub(r"[-_/ ]+", "", value)
    return value

def _latinize_authority_text(text: str) -> str:
    """
    Безопасно приводит похожие кириллические/латинские символы к латинице
    именно для authority-кода.

    Важно: эта функция НЕ исправляет длину и НЕ угадывает префикс.
    Она только нормализует похожие символы.
    """

    value = unicodedata.normalize("NFKC", str(text or "")).upper()

    table = str.maketrans(
        {
            # Cyrillic -> Latin lookalikes
            "А": "A",
            "В": "B",
            "Е": "E",
            "К": "K",
            "М": "M",
            "Н": "H",
            "О": "O",
            "Р": "P",
            "С": "C",
            "Т": "T",
            "Х": "X",
            "І": "I",
            "И": "I",

            # Greek lookalikes, на всякий случай после OCR
            "Α": "A",
            "Β": "B",
            "Ε": "E",
            "Η": "H",
            "Ι": "I",
            "Κ": "K",
            "Μ": "M",
            "Ν": "N",
            "Ο": "O",
            "Ρ": "P",
            "Τ": "T",
            "Χ": "X",
        }
    )

    return value.translate(table)


def split_authority_prefix_and_digits(text: str) -> tuple[str | None, str | None]:
    """
    Возвращает (prefix, digits) для authority-поля.

    Примеры:
      MIA 35000   -> ("MIA", "35000")
      MIA35000    -> ("MIA", "35000")
      MIA 350000  -> ("MIA", "350000")
      MILA 10208  -> ("MILA", "10208")

    Здесь можно нормализовать OCR-confusions внутри цифровой части:
      O/Q -> 0
      I/L -> 1
      S -> 5
      B -> 8

    Но prefix не исправляем: MILA остаётся MILA.
    """

    value = _latinize_authority_text(text)
    compact = re.sub(r"[^A-Z0-9]", "", value)

    match = re.fullmatch(r"([A-Z]+)([0-9OQISBL]+)", compact)
    if not match:
        return None, None

    prefix, digits = match.groups()

    digit_table = str.maketrans(
        {
            "O": "0",
            "Q": "0",
            "I": "1",
            "L": "1",
            "S": "5",
            "B": "8",
        }
    )
    digits = digits.translate(digit_table)

    return prefix, digits


def normalize_authority_for_schema(text: str) -> str:
    """
    Канонизация pas_authority.

    Важно:
    - НЕ исправляет MILA -> MIA.
    - НЕ исправляет MIA 350000 -> MIA 35000.
    - Только приводит к виду PREFIX DIGITS, чтобы валидация могла сказать invalid.

    Примеры:
      MIA35000    -> MIA 35000     valid
      MIA 35000   -> MIA 35000     valid
      MIA 350000  -> MIA 350000    invalid
      MILA 10208  -> MILA 10208    invalid
      мусор       -> МУСОР/исходная нормализованная строка, invalid
    """

    prefix, digits = split_authority_prefix_and_digits(text)

    if prefix is not None and digits is not None:
        return f"{prefix} {digits}"

    # Если не смогли разобрать как prefix+digits — возвращаем нормализованный текст.
    # Он НЕ пройдёт PASSPORT_AUTHORITY_RE и останется invalid.
    return collapse_label_spaces(_latinize_authority_text(text))


def normalize_date_for_schema(text: str) -> str:
    value = clean_glm_text(str(text)).strip()
    value = unicodedata.normalize("NFKC", value)
    value = re.sub(r"[\s/\-]+", ".", value)
    value = re.sub(r"\.+", ".", value).strip(".")

    m = re.fullmatch(r"(\d{1,2})\.(\d{1,2})\.(\d{2,4})", value)
    if not m:
        return value

    day, month, year = m.groups()
    if len(year) == 2:
        year = "19" + year if int(year) > 30 else "20" + year

    return f"{int(day):02d}.{int(month):02d}.{int(year):04d}"


def normalize_sex_for_schema(text: str) -> str:
    value = normalize_ocr_text_for_match(text)
    mapping = {
        "M": "M",
        "MALE": "M",
        "ERKAK": "M",
        "М": "M",
        "МУЖ": "M",
        "МУЖСКОЙ": "M",
        "F": "F",
        "FEMALE": "F",
        "AYOL": "F",
        "Ж": "F",
        "ЖЕН": "F",
        "ЖЕНСКИЙ": "F",
    }
    return mapping.get(value, value)


def canonical_text_for_field_schema(field_name: str, text: str) -> str:
    if field_name == "pas_number":
        return normalize_numberish_for_schema(text)

    if field_name == "pas_authority":
        return normalize_authority_for_schema(text)

    if field_name in DATE_FIELD_NAMES:
        return normalize_date_for_schema(text)

    if field_name in SEX_FIELD_NAMES:
        return normalize_sex_for_schema(text)

    return collapse_label_spaces(text)


def validate_ocr_text_for_field(
    *,
    doc_type: str,
    field_name: str,
    text: str,
) -> tuple[bool, str | None, str]:
    """
    Строгая валидация финального OCR-значения.
    В отличие от validate_glm_label_for_field(), здесь есть бизнес-форматы:
    номер паспорта, дата, пол. Для свободных текстов правила мягкие.
    """

    value = canonical_text_for_field_schema(field_name, text)
    normalized = normalize_ocr_text_for_match(value)

    if field_name in SKIP_OCR_FIELDS:
        return True, None, value

    if not value:
        return False, "empty_text", value

    if looks_like_glm_explanation_or_markup(value):
        return False, "looks_like_explanation_or_markup", value

    if field_name == "pas_number":
        if not PASSPORT_NUMBER_RE.fullmatch(value):
            return False, "invalid_passport_number_format", value
        return True, None, value

    if field_name == "pas_authority":
        if not PASSPORT_AUTHORITY_RE.fullmatch(value):
            return False, "invalid_passport_authority_format", value
        return True, None, value

    if field_name in DATE_FIELD_NAMES:
        if not PASSPORT_DATE_RE.fullmatch(value):
            return False, "invalid_date_format", value
        try:
            datetime.strptime(value, "%d.%m.%Y")
        except ValueError:
            return False, "invalid_date_value", value
        return True, None, value

    if field_name in SEX_FIELD_NAMES:
        if value not in {"M", "F"}:
            return False, "invalid_sex_value", value
        return True, None, value

    if field_name in PERSON_NAME_FIELD_NAMES:
        if not re.search(r"[A-Za-zА-Яа-яЁё]", value):
            return False, "name_without_letters", value
        if not re.fullmatch(r"[A-Za-zА-Яа-яЁёʻʼ‘’`´ʹ'\- .]+", value):
            return False, "name_has_forbidden_chars", value
        return True, None, value

    if field_name in NUMBERISH_FIELD_NAMES:
        if not re.fullmatch(r"[A-Za-zА-Яа-яЁё0-9\- /]+", value):
            return False, "number_has_forbidden_chars", value
        if len(normalized) < 1:
            return False, "number_too_short", value
        return True, None, value

    if not has_any_letter_or_digit(value):
        return False, "text_without_letters_or_digits", value

    if not re.fullmatch(r"[A-Za-zА-Яа-яЁё0-9ʻʼ‘’`´ʹ'\- ./,№()]+", value):
        return False, "text_has_forbidden_chars", value

    return True, None, value


def build_one_extra_repeat_candidates(text: str) -> list[str]:
    """Кандидаты, полученные удалением ровно одного повторного символа."""

    value = normalize_ocr_text_for_match(text)
    candidates: list[str] = []
    seen: set[str] = set()

    for i in range(1, len(value)):
        if value[i] != value[i - 1]:
            continue

        candidate = value[:i] + value[i + 1:]
        if candidate and candidate not in seen:
            candidates.append(candidate)
            seen.add(candidate)

    return candidates


def build_one_deleted_char_candidates(text: str) -> list[str]:
    """Кандидаты, полученные удалением ровно одного символа в любом месте."""

    value = normalize_ocr_text_for_match(text)
    candidates: list[str] = []
    seen: set[str] = set()

    for i in range(len(value)):
        candidate = value[:i] + value[i + 1:]
        if candidate and candidate not in seen:
            candidates.append(candidate)
            seen.add(candidate)

    return candidates


def build_one_confusable_replacement_candidates(text: str) -> list[str]:
    """Кандидаты, полученные одной безопасной confusable-заменой."""

    value = normalize_ocr_text_for_match(text)
    candidates: list[str] = []
    seen: set[str] = set()

    for i, ch in enumerate(value):
        for repl in OCR_TOKEN_CONFUSABLE_REPLACEMENTS.get(ch, set()):
            if repl == ch:
                continue
            candidate = value[:i] + repl + value[i + 1:]
            if candidate and candidate not in seen:
                candidates.append(candidate)
                seen.add(candidate)

    return candidates


def get_safe_token_repair_candidates(token: str) -> list[dict[str, str]]:
    """
    Repair one token only when the target is an exact known token.

    This catches non-repeat insertions like REGIQON -> REGION:
      REGIQON --delete Q--> REGION

    It also catches classic OCR confusions when the result is known:
      REGI0N --0->O--> REGION
      REGIQN --Q->O--> REGION

    We keep this token-level and dictionary-level to avoid dangerous global
    replacements such as rewriting every Q in Uzbek names/places.
    """

    value = normalize_ocr_text_for_match(token)
    if len(value) < 5:
        return []

    if value in OCR_SAFE_REPAIR_TOKEN_VALUES:
        return []

    found: list[dict[str, str]] = []
    seen: set[str] = set()

    def add(candidate: str, reason: str) -> None:
        candidate = normalize_ocr_text_for_match(candidate)
        if candidate in OCR_SAFE_REPAIR_TOKEN_VALUES and candidate not in seen:
            found.append({"text": candidate, "reason": reason})
            seen.add(candidate)

    for candidate in build_one_deleted_char_candidates(value):
        add(candidate, "dictionary_token_one_extra_char")

    for candidate in build_one_confusable_replacement_candidates(value):
        add(candidate, "dictionary_token_confusable_char")

    return found


def try_safe_repair_dictionary_phrase_tokens(text: str) -> tuple[str | None, str | None, list[dict[str, Any]]]:
    """
    Repairs known tokens inside longer phrases.

    Example:
      KASHKADARYA REGIQON -> KASHKADARYA REGION

    If any token has multiple possible repairs, the whole phrase repair is
    considered ambiguous and must go to TTA/GLM/manual review.
    """

    if not OCR_SAFE_REPAIR_DICTIONARY_TOKENS:
        return None, None, []

    src = normalize_ocr_phrase_for_token_repair(text)
    if not src:
        return None, None, []

    repairs: list[dict[str, Any]] = []
    ambiguous: list[dict[str, Any]] = []

    def replace_token(match: re.Match[str]) -> str:
        token = match.group(0)
        token_candidates = get_safe_token_repair_candidates(token)
        if len(token_candidates) == 1:
            candidate = token_candidates[0]
            repairs.append(
                {
                    "from": token,
                    "to": candidate["text"],
                    "reason": candidate["reason"],
                }
            )
            return candidate["text"]

        if len(token_candidates) > 1:
            ambiguous.append(
                {
                    "token": token,
                    "candidates": token_candidates,
                }
            )

        return token

    repaired = re.sub(r"[A-Z0-9]+", replace_token, src)

    if ambiguous:
        return None, "dictionary_token_repair_ambiguous", ambiguous

    if not repairs or repaired == src:
        return None, None, []

    reasons = sorted({str(r["reason"]) for r in repairs})
    return repaired, "+".join(reasons), repairs


def has_dictionary_token_repair_candidate(*, field_name: str, text: str) -> bool:
    if not should_allow_dictionary_token_repair(field_name):
        return False

    repaired, _, _ = try_safe_repair_dictionary_phrase_tokens(text)
    return repaired is not None

def build_one_confusable_authority_prefix_candidates(prefix: str) -> list[str]:
    """
    Кандидаты prefix после одной confusable-замены.

    Это НЕ применяется вслепую. Итоговый prefix потом должен попасть
    в PASSPORT_AUTHORITY_KNOWN_PREFIXES.
    """

    value = normalize_ocr_text_for_match(_latinize_authority_text(prefix))

    replacements = {
        "1": {"I"},
        "I": {"1"},
        "L": {"I"},
        "0": {"O"},
        "O": {"0"},
    }

    candidates: list[str] = []
    seen: set[str] = set()

    for i, ch in enumerate(value):
        for repl in replacements.get(ch, set()):
            candidate = value[:i] + repl + value[i + 1:]
            if candidate and candidate not in seen:
                candidates.append(candidate)
                seen.add(candidate)

    return candidates


def get_pas_authority_repair_candidates(text: str) -> list[dict[str, str]]:
    """
    Безопасный repair для pas_authority.

    Формат итогового значения:
      3 латинские буквы + 5 цифр

    Безопасно исправляет:
      MIA 350000 -> MIA 35000

    Исправляет prefix 4->3 только через allow-list:
      MILA 10208 -> MIA 10208
    только если MIA есть в PASSPORT_AUTHORITY_KNOWN_PREFIXES.

    Не угадывает произвольные prefix:
      ABCD 10208 не будет превращён в ABC/ABD/ACD/BCD,
      если ровно один кандидат не найден в allow-list.
    """

    prefix, digits = split_authority_prefix_and_digits(text)
    if not prefix or not digits:
        return []

    prefix_candidates: list[tuple[str, str]] = []

    if re.fullmatch(r"[A-Z]{3}", prefix):
        prefix_candidates.append((prefix, "authority_prefix_exact"))

    elif re.fullmatch(r"[A-Z]{4}", prefix):
        deleted_candidates = sorted(
            {
                candidate
                for candidate in build_one_deleted_char_candidates(prefix)
                if re.fullmatch(r"[A-Z]{3}", candidate)
            }
        )

        known_deleted_candidates = [
            candidate
            for candidate in deleted_candidates
            if candidate in PASSPORT_AUTHORITY_KNOWN_PREFIXES
        ]

        if len(known_deleted_candidates) == 1:
            prefix_candidates.append(
                (
                    known_deleted_candidates[0],
                    "authority_prefix_one_extra_char_known",
                )
            )

        confusable_candidates = sorted(
            {
                candidate
                for candidate in build_one_confusable_authority_prefix_candidates(prefix)
                if re.fullmatch(r"[A-Z]{3}", candidate)
                and candidate in PASSPORT_AUTHORITY_KNOWN_PREFIXES
            }
        )

        if len(confusable_candidates) == 1:
            prefix_candidates.append(
                (
                    confusable_candidates[0],
                    "authority_prefix_confusable_char_known",
                )
            )

    digit_candidates: list[tuple[str, str]] = []

    if re.fullmatch(r"\d{5}", digits):
        digit_candidates.append((digits, "authority_code_exact"))

    else:
        # Пример:
        #   350000 -> 35000
        # Только если удаление одного повторного символа даёт единственный
        # 5-значный кандидат.
        code_candidates = sorted(
            {
                candidate
                for candidate in build_one_extra_repeat_candidates(digits)
                if re.fullmatch(r"\d{5}", candidate)
            }
        )

        if len(code_candidates) == 1:
            digit_candidates.append(
                (
                    code_candidates[0],
                    "authority_code_one_extra_repeat",
                )
            )

    found: list[dict[str, str]] = []
    seen: set[str] = set()

    for prefix_candidate, prefix_reason in prefix_candidates:
        for digit_candidate, digit_reason in digit_candidates:
            candidate_text = f"{prefix_candidate} {digit_candidate}"

            if not PASSPORT_AUTHORITY_RE.fullmatch(candidate_text):
                continue

            if candidate_text in seen:
                continue

            reason_parts: list[str] = []

            if prefix_reason != "authority_prefix_exact":
                reason_parts.append(prefix_reason)

            if digit_reason != "authority_code_exact":
                reason_parts.append(digit_reason)

            found.append(
                {
                    "text": candidate_text,
                    "reason": "+".join(reason_parts) or "authority_schema_normalized",
                }
            )
            seen.add(candidate_text)

    return found


def has_suspicious_alpha_triple(text: str) -> bool:
    value = normalize_ocr_text_for_match(text)
    return bool(re.search(r"([A-Z])\1{2,}", value))


def is_safe_dictionary_value_for_field(
    *,
    field_name: str,
    text: str,
) -> bool:
    if field_name not in OCR_DICTIONARY_REPAIR_FIELD_NAMES:
        return False

    value = normalize_ocr_text_for_match(
        canonical_text_for_field_schema(field_name, text)
    )

    if not value:
        return False

    if value in OCR_SAFE_REPAIR_EXACT_VALUES:
        return True

    return _lookup_russian_migration_dictionary(
        value,
        field_name=field_name,
    ) is not None


def has_dictionary_one_extra_repeat_candidate(
    *,
    field_name: str,
    text: str,
) -> bool:
    if field_name not in OCR_DICTIONARY_REPAIR_FIELD_NAMES:
        return False

    # Если текущее значение уже точное словарное — не считаем его подозрительным
    # только из-за наличия внутренних повторов.
    if is_safe_dictionary_value_for_field(field_name=field_name, text=text):
        return False

    for candidate in build_one_extra_repeat_candidates(text):
        if is_safe_dictionary_value_for_field(field_name=field_name, text=candidate):
            return True

    return False


def levenshtein_distance(
    a: str,
    b: str,
    *,
    max_distance: int | None = None,
) -> int:
    """Bounded Levenshtein distance for small OCR dictionaries."""

    a = str(a)
    b = str(b)

    if a == b:
        return 0

    if max_distance is not None and abs(len(a) - len(b)) > max_distance:
        return max_distance + 1

    previous = list(range(len(b) + 1))

    for i, ca in enumerate(a, 1):
        current = [i]
        row_min = current[0]

        for j, cb in enumerate(b, 1):
            value = min(
                current[j - 1] + 1,
                previous[j] + 1,
                previous[j - 1] + (0 if ca == cb else 1),
            )
            current.append(value)
            row_min = min(row_min, value)

        if max_distance is not None and row_min > max_distance:
            return max_distance + 1

        previous = current

    return previous[-1]


def get_dictionary_nearest_values_for_field(field_name: str) -> set[str]:
    """
    Small allow-list for edit-distance repair.

    This is intentionally limited to fields with stable dictionaries. It must
    NOT be used for personal names, because edit-distance repair can corrupt
    real surnames and given names.
    """

    values: set[str] = set()

    if field_name in {"pas_nationality", "mg_nationality"}:
        values.update(_RU_MIGRATION_NATIONALITY_EXACT.keys())
        values.update(
            {
                "UZBEKISTAN",
                "UZBEK",
                "KARAKALPAKSTAN",
                "KARAKALPAK",
                "QORAQALPOGISTON",
                "QORAQALPOQ",
                "TAJIK",
                "KYRGYZ",
                "KAZAKH",
                "TURKMAN",
                "RUSSIAN",
            }
        )

    if field_name == "pas_place_of_birth":
        values.update(_RU_MIGRATION_COMMON_EXACT.keys())
        values.update(_RU_MIGRATION_PLACE_EXACT.keys())
        values.update(OCR_SAFE_REPAIR_ENGLISH_PLACE_VALUES)

    return {collapse_label_spaces(v).upper() for v in values if collapse_label_spaces(v)}


def get_dictionary_nearest_repair_candidates_for_field(
    *,
    field_name: str,
    text: str,
) -> list[dict[str, str]]:
    """
    Safe dictionary repair by edit distance <= N.

    Examples:
      UZBEKISTNAAN -> UZBEKISTAN  (distance 2)
      KASHKADARYA REGIQON -> KASHKADARYA REGION

    Applied only when the nearest candidate is unique.
    """

    if not OCR_SAFE_REPAIR_DICTIONARY_NEAREST:
        return []

    if field_name not in OCR_DICTIONARY_REPAIR_FIELD_NAMES:
        return []

    source = collapse_label_spaces(canonical_text_for_field_schema(field_name, text)).upper()
    source_norm = normalize_ocr_text_for_match(source)

    if len(source_norm) < 5:
        return []

    dictionary_values = get_dictionary_nearest_values_for_field(field_name)
    if not dictionary_values:
        return []

    normalized_to_display: dict[str, str] = {}
    for value in dictionary_values:
        norm = normalize_ocr_text_for_match(value)
        if not norm:
            continue
        # Prefer the first display form; duplicates are equivalent for repair.
        normalized_to_display.setdefault(norm, value)

    if source_norm in normalized_to_display:
        return []

    max_distance = max(1, int(OCR_DICTIONARY_NEAREST_MAX_DISTANCE))
    best_distance = max_distance + 1
    best_norms: list[str] = []

    for candidate_norm in normalized_to_display:
        distance = levenshtein_distance(
            source_norm,
            candidate_norm,
            max_distance=max_distance,
        )

        if distance > max_distance:
            continue

        if distance < best_distance:
            best_distance = distance
            best_norms = [candidate_norm]
        elif distance == best_distance:
            best_norms.append(candidate_norm)

    if len(best_norms) != 1:
        return []

    winner = normalized_to_display[best_norms[0]]
    return [
        {
            "text": winner,
            "reason": f"dictionary_nearest_distance_{best_distance}",
        }
    ]


def has_dictionary_nearest_repair_candidate(
    *,
    field_name: str,
    text: str,
) -> bool:
    return bool(
        get_dictionary_nearest_repair_candidates_for_field(
            field_name=field_name,
            text=text,
        )
    )


def get_safe_repair_candidates_for_field(
    *,
    doc_type: str,
    field_name: str,
    text: str,
) -> list[dict[str, str]]:
    """
    Возвращает все валидные repair-кандидаты.

    ВАЖНО: для строгих полей repair безопасен только если кандидат ровно один.
    Пример опасности:
      FK00055527 -> FK0055527  # удалить один 0
      FK00055527 -> FK0005527  # удалить одну 5
    Оба формально валидны как AA + 7 цифр, но правильный только второй.
    Поэтому multiple candidates => не правим автоматически, зовём GLM/оставляем suspicious.
    """

    if not OCR_SAFE_REPAIR_ENABLED:
        return []

    original_valid, _, original_canonical = validate_ocr_text_for_field(
        doc_type=doc_type,
        field_name=field_name,
        text=text,
    )

    # pas_authority — строгое поле: 3 латинские буквы + 5 цифр.
    # Если уже валидно, не пытаемся чинить.
    if original_valid and field_name == "pas_authority":
        return []

    allow_token_repair = should_allow_dictionary_token_repair(field_name)

    # Для строгих форматов валидное значение уже считаем безопасным.
    # Для словарных/token-level полей valid=True не всегда означает,
    # что текст семантически правильный.
    if (
        original_valid
        and field_name not in OCR_DICTIONARY_REPAIR_FIELD_NAMES
        and not allow_token_repair
    ):
        return []

    found: list[dict[str, str]] = []
    seen: set[str] = set()

    def add(candidate: str, reason: str) -> None:
        candidate = canonical_text_for_field_schema(field_name, candidate)

        if candidate and candidate not in seen:
            found.append({"text": candidate, "reason": reason})
            seen.add(candidate)

    # Орган выдачи паспорта: 3 латинские буквы + 5 цифр.
    # Примеры:
    #   MIA 350000 -> MIA 35000
    #   MILA 10208 -> MIA 10208, только если MIA в allow-list.
    if field_name == "pas_authority":
        for candidate in get_pas_authority_repair_candidates(original_canonical):
            valid, _, canonical = validate_ocr_text_for_field(
                doc_type=doc_type,
                field_name=field_name,
                text=candidate["text"],
            )
            if valid:
                add(canonical, candidate["reason"])

    # Паспортный номер: AA + 7 цифр. Правим только если будет ровно один
    # валидный кандидат. Если кандидатов несколько — это неоднозначность.
    if field_name == "pas_number":
        for candidate in build_one_extra_repeat_candidates(original_canonical):
            candidate = normalize_numberish_for_schema(candidate)
            if PASSPORT_NUMBER_RE.fullmatch(candidate):
                add(candidate, "passport_number_one_extra_repeat")

    # Словарные поля: национальность/место рождения.
    # Здесь valid=True не гарантирует корректность: KARAKALPAKSSTAN формально
    # валидная строка, но семантически это один лишний повтор относительно
    # словарного KARAKALPAKSTAN. Поэтому разрешаем repair и для valid=True,
    # но только если текущее значение само НЕ является точным словарным и
    # кандидат после удаления одного повтора попадает в точный словарь.
    if field_name in OCR_DICTIONARY_REPAIR_FIELD_NAMES:
        if not is_safe_dictionary_value_for_field(
            field_name=field_name,
            text=original_canonical,
        ):
            for candidate in build_one_extra_repeat_candidates(original_canonical):
                if is_safe_dictionary_value_for_field(
                    field_name=field_name,
                    text=candidate,
                ):
                    add(candidate, "dictionary_one_extra_repeat")

    # Dictionary nearest repair catches non-repeat sequence errors in stable
    # dictionary fields, for example UZBEKISTNAAN -> UZBEKISTAN.
    if field_name in OCR_DICTIONARY_REPAIR_FIELD_NAMES:
        for candidate in get_dictionary_nearest_repair_candidates_for_field(
            field_name=field_name,
            text=original_canonical,
        ):
            valid, _, canonical = validate_ocr_text_for_field(
                doc_type=doc_type,
                field_name=field_name,
                text=candidate["text"],
            )
            if valid:
                add(canonical, candidate["reason"])

    # Token-level repair inside longer phrases. This fixes cases where the
    # whole phrase is not in an exact dictionary, but one administrative
    # token is clearly broken: REGIQON -> REGION. Unlike exact dictionary
    # repair, this is allowed for free-text fields too (for example if the
    # detector/OCR mapped the phrase to pas_authority or another text field).
    if allow_token_repair:
        phrase_candidate, phrase_reason, _ = try_safe_repair_dictionary_phrase_tokens(
            original_canonical
        )
        if phrase_candidate is not None and phrase_reason is not None:
            valid, _, canonical = validate_ocr_text_for_field(
                doc_type=doc_type,
                field_name=field_name,
                text=phrase_candidate,
            )
            if valid:
                add(canonical, phrase_reason)

    # Опционально: только тройные буквы в ФИО. По умолчанию выключено, потому
    # что лучше отдавать такие случаи в TTA/GLM, а не править имена regex'ом.
    if (
        OCR_SAFE_REPAIR_PERSON_TRIPLE
        and field_name in PERSON_NAME_FIELD_NAMES
        and has_suspicious_alpha_triple(original_canonical)
    ):
        candidate = re.sub(
            r"([A-Z])\1{2,}",
            r"\1\1",
            normalize_ocr_text_for_match(original_canonical),
        )
        valid, _, canonical = validate_ocr_text_for_field(
            doc_type=doc_type,
            field_name=field_name,
            text=candidate,
        )
        if valid:
            add(canonical, "person_name_triple_alpha_to_double")

    return found


def try_safe_repair_field_text(
    *,
    doc_type: str,
    field_name: str,
    text: str,
) -> tuple[str | None, str | None]:
    """
    Безопасный repair только там, где есть ровно один валидный кандидат.

    Если кандидатов несколько, repair считается НЕбезопасным:
    FK00055527 может стать и FK0055527, и FK0005527.
    В такой ситуации нужно TTA/GLM/ручная проверка, но не автозамена.
    """

    candidates = get_safe_repair_candidates_for_field(
        doc_type=doc_type,
        field_name=field_name,
        text=text,
    )

    if len(candidates) != 1:
        return None, None

    candidate = candidates[0]
    return candidate["text"], candidate["reason"]


def build_ocr_quality_report(
    *,
    doc_type: str,
    field_name: str,
    text: str,
    paddle_score: float | None = None,
) -> dict[str, Any]:
    valid, invalid_reason, canonical = validate_ocr_text_for_field(
        doc_type=doc_type,
        field_name=field_name,
        text=text,
    )

    flags: list[str] = []

    if paddle_score is not None and score_to_unit(float(paddle_score)) < GLM_FIELD_FALLBACK_THRESHOLD:
        flags.append("paddle_score_low")

    if not valid:
        flags.append("schema_invalid")

    if has_suspicious_alpha_triple(text):
        flags.append("suspicious_alpha_triple")

    if has_dictionary_one_extra_repeat_candidate(field_name=field_name, text=text):
        flags.append("dictionary_one_extra_repeat_candidate")

    if has_dictionary_token_repair_candidate(field_name=field_name, text=text):
        flags.append("dictionary_token_repair_candidate")

    if has_dictionary_nearest_repair_candidate(field_name=field_name, text=text):
        flags.append("dictionary_nearest_repair_candidate")

    repair_candidates = get_safe_repair_candidates_for_field(
        doc_type=doc_type,
        field_name=field_name,
        text=text,
    )
    repair_text = None
    repair_reason = None

    if len(repair_candidates) == 1:
        flags.append("safe_repair_available")
        repair_text = repair_candidates[0]["text"]
        repair_reason = repair_candidates[0]["reason"]
    elif len(repair_candidates) > 1:
        flags.append("safe_repair_ambiguous")
        repair_reason = "multiple_valid_one_extra_repeat_candidates"

    return {
        "enabled": bool(OCR_VERIFY_ENABLED),
        "text": text,
        "canonical_text": canonical,
        "normalized_text": normalize_ocr_text_for_match(canonical),
        "valid": bool(valid),
        "invalid_reason": invalid_reason,
        "flags": sorted(set(flags)),
        "repair_candidate": repair_text,
        "repair_candidates": repair_candidates,
        "repair_reason": repair_reason,
    }


def ocr_quality_needs_attention(report: dict[str, Any]) -> bool:
    if not OCR_VERIFY_ENABLED:
        return False

    attention_flags = {
        "paddle_score_low",
        "schema_invalid",
        "suspicious_alpha_triple",
        "dictionary_one_extra_repeat_candidate",
        "dictionary_token_repair_candidate",
        "dictionary_nearest_repair_candidate",
        "safe_repair_available",
        "safe_repair_ambiguous",
    }
    return bool(attention_flags & set(report.get("flags", [])))


def build_ocr_tta_prepared_variants(
    field_crop_bgr: np.ndarray,
    *,
    base_prepared_bgr: np.ndarray | None = None,
) -> list[dict[str, Any]]:
    variants: list[dict[str, Any]] = []

    if base_prepared_bgr is not None:
        variants.append(
            {
                "variant": "orig",
                "image": base_prepared_bgr,
                "settings": "already_prepared_default",
            }
        )

    # Мягкие варианты препроцесса. Не меняем геометрию сильно: цель — проверить,
    # не родил ли конкретный preprocess лишний штрих/лишний CTC-step.
    variant_configs = [
        {
            "variant": "no_bg_norm_soft_contrast",
            "normalize_background": False,
            "contrast_enhance": 1.10,
            "pad_x": OCR_PAD_X,
            "pad_y": OCR_PAD_Y,
            "grayscale": True,
        },
        {
            "variant": "bg_norm_soft_contrast",
            "normalize_background": True,
            "contrast_enhance": 1.10,
            "pad_x": OCR_PAD_X,
            "pad_y": OCR_PAD_Y,
            "grayscale": True,
        },
        {
            "variant": "bg_norm_strong_contrast",
            "normalize_background": True,
            "contrast_enhance": 1.35,
            "pad_x": OCR_PAD_X,
            "pad_y": OCR_PAD_Y,
            "grayscale": True,
        },
        {
            "variant": "less_padding_no_bg_norm",
            "normalize_background": False,
            "contrast_enhance": 1.15,
            "pad_x": max(1, OCR_PAD_X // 2),
            "pad_y": max(1, OCR_PAD_Y // 2),
            "grayscale": True,
        },
    ]

    used_names = {str(v["variant"]) for v in variants}
    for cfg in variant_configs:
        if len(variants) >= max(1, OCR_TTA_MAX_VARIANTS):
            break
        if cfg["variant"] in used_names:
            continue

        prepared = prepare_ocr_image_array(
            field_crop_bgr,
            pad_x=int(cfg["pad_x"]),
            pad_y=int(cfg["pad_y"]),
            grayscale=bool(cfg["grayscale"]),
            normalize_background=bool(cfg["normalize_background"]),
            contrast_enhance=float(cfg["contrast_enhance"]),
        )
        variants.append(
            {
                "variant": cfg["variant"],
                "image": prepared,
                "settings": {
                    k: v
                    for k, v in cfg.items()
                    if k != "variant"
                },
            }
        )

    return variants[:max(1, OCR_TTA_MAX_VARIANTS)]


def choose_ocr_tta_winner(
    *,
    doc_type: str,
    field_name: str,
    results: list[dict[str, Any]],
    current_text: str,
) -> dict[str, Any]:
    non_empty = [r for r in results if normalize_ocr_text_for_match(str(r.get("text", "")))]
    if not non_empty:
        return {
            "accepted": False,
            "reason": "no_non_empty_tta_results",
            "winner_text": None,
            "winner_score": 0.0,
            "winner_count": 0,
        }

    grouped: dict[str, list[dict[str, Any]]] = {}
    for result in non_empty:
        canonical = canonical_text_for_field_schema(field_name, str(result.get("text", "")))
        norm = normalize_ocr_text_for_match(canonical)
        grouped.setdefault(norm, []).append({**result, "canonical_text": canonical})

    def group_rank(item: tuple[str, list[dict[str, Any]]]) -> tuple[int, float, float]:
        _, rows = item
        scores = [float(r.get("score", 0.0)) for r in rows]
        return (
            len(rows),
            float(np.mean(scores)) if scores else 0.0,
            max(scores) if scores else 0.0,
        )

    winner_norm, winner_rows = max(grouped.items(), key=group_rank)
    winner_counter = Counter(str(r["canonical_text"]) for r in winner_rows)
    winner_text = winner_counter.most_common(1)[0][0]
    winner_score = max(float(r.get("score", 0.0)) for r in winner_rows)
    winner_count = len(winner_rows)

    current_norm = normalize_ocr_text_for_match(
        canonical_text_for_field_schema(field_name, current_text)
    )
    winner_valid, winner_invalid_reason, winner_canonical = validate_ocr_text_for_field(
        doc_type=doc_type,
        field_name=field_name,
        text=winner_text,
    )
    current_valid, _, _ = validate_ocr_text_for_field(
        doc_type=doc_type,
        field_name=field_name,
        text=current_text,
    )

    accepted = False
    reason = "winner_is_current"

    if winner_norm != current_norm:
        if winner_count >= max(1, OCR_TTA_MIN_MAJORITY) and winner_valid:
            accepted = True
            reason = "tta_majority_valid"
        elif not current_valid and winner_valid:
            accepted = True
            reason = "tta_valid_candidate_over_invalid_current"
        else:
            reason = winner_invalid_reason or "tta_no_safe_majority"

    return {
        "accepted": bool(accepted),
        "reason": reason,
        "winner_text": winner_canonical if winner_valid else winner_text,
        "winner_score": winner_score,
        "winner_count": winner_count,
        "winner_valid": bool(winner_valid),
        "winner_invalid_reason": winner_invalid_reason,
        "groups": [
            {
                "normalized": norm,
                "count": len(rows),
                "texts": sorted({str(r.get("canonical_text", r.get("text", ""))) for r in rows}),
                "max_score": max(float(r.get("score", 0.0)) for r in rows),
            }
            for norm, rows in sorted(grouped.items(), key=group_rank, reverse=True)
        ],
    }


def recognize_field_text_tta(
    *,
    doc_type: str,
    field_name: str,
    field_crop_bgr: np.ndarray,
    base_prepared_bgr: np.ndarray | None,
    base_text: str,
    base_score: float,
) -> dict[str, Any]:
    started = time.perf_counter()
    preprocess_seconds = 0.0
    paddle_seconds = 0.0
    results: list[dict[str, Any]] = []

    if field_name in SKIP_OCR_FIELDS:
        return {
            "enabled": False,
            "reason": "skipped_field",
            "accepted": False,
            "results": [],
            "seconds": 0.0,
        }

    variants_started = time.perf_counter()
    variants = build_ocr_tta_prepared_variants(
        field_crop_bgr,
        base_prepared_bgr=base_prepared_bgr,
    )
    preprocess_seconds += elapsed_seconds(variants_started)

    for variant in variants:
        variant_name = str(variant.get("variant", "variant"))

        if variant_name == "orig" and base_text is not None:
            results.append(
                {
                    "variant": variant_name,
                    "text": str(base_text),
                    "score": score_to_unit(float(base_score)),
                    "used_existing_result": True,
                }
            )
            continue

        paddle_started = time.perf_counter()
        text, score = recognize_prepared_image_with_paddle(
            doc_type,
            variant["image"],
        )
        paddle_seconds += elapsed_seconds(paddle_started)
        results.append(
            {
                "variant": variant_name,
                "text": text,
                "score": score_to_unit(float(score)),
                "used_existing_result": False,
            }
        )

    winner = choose_ocr_tta_winner(
        doc_type=doc_type,
        field_name=field_name,
        results=results,
        current_text=base_text,
    )

    return {
        "enabled": True,
        "accepted": bool(winner.get("accepted")),
        "reason": winner.get("reason"),
        "winner_text": winner.get("winner_text"),
        "winner_score": winner.get("winner_score"),
        "winner_count": winner.get("winner_count"),
        "winner_valid": winner.get("winner_valid"),
        "winner_invalid_reason": winner.get("winner_invalid_reason"),
        "groups": winner.get("groups", []),
        "results": results,
        "variants_count": len(variants),
        "preprocess_seconds": preprocess_seconds,
        "paddle_seconds": paddle_seconds,
        "seconds": elapsed_seconds(started),
    }


def ensure_item_quality(item: dict[str, Any], doc_type: str) -> dict[str, Any]:
    quality = item.get("quality")
    if not isinstance(quality, dict):
        quality = {}
        item["quality"] = quality

    report = build_ocr_quality_report(
        doc_type=doc_type,
        field_name=item["field_name"],
        text=item.get("final_text", ""),
        paddle_score=float(item.get("paddle_score", 0.0)),
    )
    quality["current"] = report
    return quality


def append_quality_event(item: dict[str, Any], event: dict[str, Any]) -> None:
    quality = item.setdefault("quality", {})
    events = quality.setdefault("events", [])
    events.append(event)


def apply_safe_repair_to_item(
    *,
    item: dict[str, Any],
    doc_type: str,
) -> bool:
    field_name = item["field_name"]
    repair_text, repair_reason = try_safe_repair_field_text(
        doc_type=doc_type,
        field_name=field_name,
        text=item.get("final_text", ""),
    )

    if repair_text is None:
        return False

    before = item.get("final_text", "")
    item["final_text"] = repair_text
    item["source"] = "safe_repair"
    append_quality_event(
        item,
        {
            "action": "safe_repair_applied",
            "reason": repair_reason,
            "before": before,
            "after": repair_text,
        },
    )
    ensure_item_quality(item, doc_type)
    return True


def apply_tta_to_item(
    *,
    item: dict[str, Any],
    doc_type: str,
) -> bool:
    if not OCR_TTA_ENABLED:
        return False

    tta_started = time.perf_counter()
    tta_result = recognize_field_text_tta(
        doc_type=doc_type,
        field_name=item["field_name"],
        field_crop_bgr=item["field_crop"],
        base_prepared_bgr=item.get("field_crop_prepared"),
        base_text=str(item.get("final_text", item.get("paddle_text", ""))),
        base_score=float(item.get("paddle_score", 0.0)),
    )
    item["tta"] = tta_result
    item["timing"]["tta_seconds"] = elapsed_seconds(tta_started)
    item["timing"]["tta_preprocess_seconds"] = float(tta_result.get("preprocess_seconds", 0.0))
    item["timing"]["tta_paddle_seconds"] = float(tta_result.get("paddle_seconds", 0.0))
    item["timing"]["tta_variants_count"] = int(tta_result.get("variants_count", 0))

    if not tta_result.get("accepted") or not tta_result.get("winner_text"):
        append_quality_event(
            item,
            {
                "action": "tta_checked",
                "accepted": False,
                "reason": tta_result.get("reason"),
            },
        )
        return False

    before = item.get("final_text", "")
    item["final_text"] = str(tta_result["winner_text"])
    item["source"] = "paddle_tta"
    append_quality_event(
        item,
        {
            "action": "tta_applied",
            "reason": tta_result.get("reason"),
            "before": before,
            "after": item["final_text"],
            "winner_count": tta_result.get("winner_count"),
            "winner_score": tta_result.get("winner_score"),
        },
    )
    ensure_item_quality(item, doc_type)
    return True


def should_accept_glm_text_for_field(
    *,
    doc_type: str,
    field_name: str,
    glm_text: str,
) -> tuple[str | None, str | None]:
    label, reject_reason = validate_glm_label_for_field(
        doc_type=doc_type,
        field_name=field_name,
        glm_text=glm_text,
    )
    if reject_reason is not None or label is None:
        return None, reject_reason or "invalid_glm_label"

    if OCR_ACCEPT_GLM_ONLY_IF_VALID:
        valid, invalid_reason, canonical = validate_ocr_text_for_field(
            doc_type=doc_type,
            field_name=field_name,
            text=label,
        )
        if not valid and field_name in STRICT_FORMAT_FIELD_NAMES:
            return None, invalid_reason or "invalid_glm_schema"
        return canonical if valid else label, None

    return label, None


def apply_glm_text_to_item(
    *,
    item: dict[str, Any],
    doc_type: str,
    glm_text: str | None,
    source: str,
) -> bool:
    item["glm_text"] = glm_text or ""

    if not glm_text:
        item["source"] = "paddle_glm_empty"
        append_quality_event(
            item,
            {
                "action": "glm_checked",
                "accepted": False,
                "reason": "empty_glm_text",
                "source": source,
            },
        )
        return False

    accepted_text, reject_reason = should_accept_glm_text_for_field(
        doc_type=doc_type,
        field_name=item["field_name"],
        glm_text=glm_text,
    )

    if accepted_text is None:
        item["source"] = "paddle_glm_invalid"
        append_quality_event(
            item,
            {
                "action": "glm_checked",
                "accepted": False,
                "reason": reject_reason,
                "source": source,
                "glm_text": glm_text,
            },
        )
        return False

    before = item.get("final_text", "")
    item["final_text"] = accepted_text
    item["source"] = source
    append_quality_event(
        item,
        {
            "action": "glm_applied",
            "source": source,
            "before": before,
            "after": accepted_text,
            "glm_text": glm_text,
        },
    )
    ensure_item_quality(item, doc_type)
    return True


def apply_quality_verification_to_item(
    *,
    item: dict[str, Any],
    doc_type: str,
) -> bool:
    """
    Production decision layer:
      Paddle -> quality flags -> TTA -> safe repair -> GLM fallback.
    Возвращает True, если итоговое значение изменилось.
    """

    if not OCR_VERIFY_ENABLED or item["field_name"] in SKIP_OCR_FIELDS:
        return False

    changed = False
    before_all = item.get("final_text", "")

    quality = ensure_item_quality(item, doc_type)
    initial_report = quality.get("current", {})

    if not ocr_quality_needs_attention(initial_report):
        append_quality_event(
            item,
            {
                "action": "quality_fast_path",
                "reason": "no_attention_flags",
            },
        )
        return False

    # 1. Safe repair сначала: он дешёвый и словарно/схемно ограниченный.
    # Это ускоряет production-путь: KARAKALPAKSSTAN/UZBEKISTNAAN исправятся
    # без дополнительных Paddle TTA-прогонов и без GLM.
    if apply_safe_repair_to_item(item=item, doc_type=doc_type):
        changed = True

    current_report = ensure_item_quality(item, doc_type).get("current", {})
    if not ocr_quality_needs_attention(current_report):
        append_quality_event(
            item,
            {
                "action": "quality_resolved_by_safe_repair",
                "before": before_all,
                "after": item.get("final_text", ""),
            },
        )
        return changed or before_all != item.get("final_text", "")

    # 2. TTA: несколько мягких препроцессов и голосование самой PaddleOCR-модели.
    if apply_tta_to_item(item=item, doc_type=doc_type):
        changed = True

    # 3. После TTA повторяем safe repair: TTA может дать новый кандидат,
    # который уже однозначно ремонтируется словарём/схемой.
    if apply_safe_repair_to_item(item=item, doc_type=doc_type):
        changed = True

    current_report = ensure_item_quality(item, doc_type).get("current", {})
    if not ocr_quality_needs_attention(current_report):
        append_quality_event(
            item,
            {
                "action": "quality_resolved_without_glm",
                "before": before_all,
                "after": item.get("final_text", ""),
            },
        )
        return changed or before_all != item.get("final_text", "")

    # 4. GLM fallback не только по low score, но и по quality-флагам.
    if OCR_GLM_ON_QUALITY_FLAGS:
        glm_started = time.perf_counter()
        try:
            # Для GLM/VLM лучше RAW crop: prepared 48px полезен PaddleOCR,
            # но может убивать мелкие визуальные различия между 00055 и 00555.
            glm_input = item["field_crop"]

            glm_text = glm_ocr_field(
                doc_type=doc_type,
                field_name=item["field_name"],
                field_crop_bgr=glm_input,
            )
            item["timing"]["glm_ocr_seconds"] = round(
                float(item["timing"].get("glm_ocr_seconds", 0.0))
                + elapsed_seconds(glm_started),
                6,
            )
            item["timing"]["glm_ocr_scope"] = "field_quality"
            changed = apply_glm_text_to_item(
                item=item,
                doc_type=doc_type,
                glm_text=glm_text,
                source="glm_quality",
            ) or changed

        except Exception as exc:
            item["timing"]["glm_ocr_seconds"] = round(
                float(item["timing"].get("glm_ocr_seconds", 0.0))
                + elapsed_seconds(glm_started),
                6,
            )
            item["timing"]["glm_ocr_scope"] = "field_quality"
            item["glm_error"] = str(exc)
            append_quality_event(
                item,
                {
                    "action": "glm_failed",
                    "source": "glm_quality",
                    "error": str(exc),
                },
            )

    ensure_item_quality(item, doc_type)
    return changed or before_all != item.get("final_text", "")



def polygon_area(points: np.ndarray) -> float:
    if len(points) < 3:
        return 0.0
    return float(abs(cv2.contourArea(points.astype(np.float32))))


def is_field_geometry_plausible(field: dict[str, Any]) -> tuple[bool, str | None]:
    polygon = field.get("polygon")
    bbox = field.get("bbox")

    if polygon is None or bbox is None:
        return False, "missing_polygon_or_bbox"

    poly = np.asarray(polygon, dtype=np.float32)
    if len(poly) < 3:
        return False, "polygon_too_short"

    x1, y1, x2, y2 = [float(v) for v in bbox]
    bw = max(0.0, x2 - x1)
    bh = max(0.0, y2 - y1)

    if bw < 6 or bh < 4:
        return False, "bbox_too_small"

    aspect = bw / max(bh, 1.0)
    if aspect < 0.25 or aspect > 80.0:
        return False, "bbox_bad_aspect_ratio"

    bbox_area = bw * bh
    area = polygon_area(poly)
    fill_ratio = area / max(bbox_area, 1.0)

    if fill_ratio < 0.12:
        return False, "polygon_fill_ratio_too_low"

    return True, None


def is_prepared_ocr_image_visually_useful(
    image_bgr: np.ndarray | None,
) -> tuple[bool, str | None]:
    if image_bgr is None:
        return False, "missing_prepared_image"

    if image_bgr.size == 0:
        return False, "empty_prepared_image"

    h, w = image_bgr.shape[:2]
    if h < 8 or w < 8:
        return False, "prepared_image_too_small"

    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    std = float(gray.std())
    mean = float(gray.mean())
    dark_ratio = float(np.mean(gray < 245))
    black_ratio = float(np.mean(gray < 20))

    if mean < 15:
        return False, "prepared_image_too_dark"

    if std < 3.0 or dark_ratio < 0.002:
        return False, "prepared_image_looks_blank"

    if black_ratio > 0.70:
        return False, "prepared_image_too_black"

    return True, None


def ocr_improve_sample_reject_reason(
    *,
    doc_type: str,
    doc_confidence: float,
    field: dict[str, Any],
    prepared_image_bgr: np.ndarray | None,
    orientation_confident: bool,
) -> str | None:
    field_name = str(field.get("name", ""))

    if not OCR_IMPROVE_DATASET_ENABLED:
        return "ocr_improve_dataset_disabled"

    if field_name in SKIP_OCR_FIELDS:
        return "skip_ocr_field"

    if doc_type not in OCR_IMPROVE_ALLOWED_DOC_TYPES:
        return "unsupported_doc_type_for_ocr_improve"

    if float(doc_confidence) < OCR_IMPROVE_MIN_DOC_CONF:
        return "doc_confidence_too_low"

    if float(field.get("confidence", 0.0)) < OCR_IMPROVE_MIN_FIELD_CONF:
        return "field_confidence_too_low"

    if OCR_IMPROVE_REQUIRE_CONFIDENT_ORIENTATION and not orientation_confident:
        return "orientation_not_confident"

    geometry_ok, geometry_reason = is_field_geometry_plausible(field)
    if not geometry_ok:
        return geometry_reason

    image_ok, image_reason = is_prepared_ocr_image_visually_useful(prepared_image_bgr)
    if not image_ok:
        return image_reason

    return None


def save_ocr_improve_mismatch_sample(
    *,
    doc_type: str,
    field_name: str,
    field: dict[str, Any],
    prepared_variants: list[dict[str, Any]] | None,
    raw_field_crop_bgr: np.ndarray | None,
    paddle_text: str,
    paddle_score: float,
    glm_text: str | None,
    source_file: str,
    file_index: int,
    page_index: int,
    document_index: int,
    doc_confidence: float,
    orientation_angle: int,
    orientation_score: float,
    orientation_confident: bool,
) -> dict[str, Any]:
    """
    Сохраняет mismatch PaddleOCR vs GLM OCR в OCR-improve датасет.

    На один валидный сегмент сохраняется несколько prepared-картинок:
      - orig: оригинальный crop после preprocess;
      - aug01..aug03: raw crop -> мягкая фото-аугментация -> preprocess.

    Формат:
      <OCR_IMPROVE_DATASET_ROOT>/passport/labels.txt
      <OCR_IMPROVE_DATASET_ROOT>/passport/images/<field>/<hash>_<variant>.png
      <OCR_IMPROVE_DATASET_ROOT>/passport/metadata.jsonl

      <OCR_IMPROVE_DATASET_ROOT>/migration_card/labels.txt
      <OCR_IMPROVE_DATASET_ROOT>/migration_card/images/<field>/<hash>.png
      <OCR_IMPROVE_DATASET_ROOT>/migration_card/metadata.jsonl

    В labels.txt пишется относительный путь и текст GLM OCR:
      images/pas_name/abc_aug01.png\tALI
    """

    base_result: dict[str, Any] = {
        "saved": False,
        "new_image": False,
        "reason": None,
        "label": None,
        "image_path": None,
        "label_path": None,
        "metadata_path": None,
        "saved_count": 0,
        "duplicate_count": 0,
        "skipped_count": 0,
        "saved_variants": [],
        "skipped_variants": [],
    }

    base_prepared_image = None
    if prepared_variants:
        for variant in prepared_variants:
            if variant.get("variant") == "orig":
                base_prepared_image = variant.get("image")
                break
        if base_prepared_image is None:
            base_prepared_image = prepared_variants[0].get("image")

    segment_reject_reason = ocr_improve_sample_reject_reason(
        doc_type=doc_type,
        doc_confidence=doc_confidence,
        field=field,
        prepared_image_bgr=base_prepared_image,
        orientation_confident=orientation_confident,
    )
    if segment_reject_reason is not None:
        base_result["reason"] = segment_reject_reason
        return base_result

    label, label_reject_reason = validate_glm_label_for_field(
        doc_type=doc_type,
        field_name=field_name,
        glm_text=glm_text or "",
    )
    if label_reject_reason is not None or label is None:
        base_result["reason"] = label_reject_reason or "invalid_glm_label"
        return base_result

    if paddle_and_glm_texts_match(paddle_text, label):
        base_result["reason"] = "paddle_and_glm_match"
        base_result["label"] = label
        return base_result

    # Только теперь, после всех дешёвых проверок и подтверждённого mismatch,
    # строим aug01..aug03. Так обычный ocr_improve-запрос не тратит CPU на
    # аугментации для сегментов, которые не попадут в датасет.
    if raw_field_crop_bgr is not None:
        prepared_variants = build_ocr_improve_prepared_variants(
            raw_field_crop_bgr,
            include_augmentations=True,
            prepared_orig_bgr=base_prepared_image,
        )

    if not prepared_variants:
        base_result["reason"] = "missing_prepared_variants"
        return base_result

    label_norm = normalize_ocr_text_for_match(label)
    paddle_norm = normalize_ocr_text_for_match(paddle_text)

    dataset_dir = OCR_IMPROVE_DATASET_ROOT / safe_filename_part(doc_type)
    labels_path = dataset_dir / "labels.txt"
    field_labels_path = dataset_dir / "fields" / safe_filename_part(field_name) / "labels.txt"
    metadata_path = dataset_dir / "metadata.jsonl"

    saved_count = 0
    duplicate_count = 0
    skipped_variants: list[dict[str, str]] = []
    saved_variants: list[dict[str, Any]] = []

    with ocr_improve_dataset_lock:
        labels_path.parent.mkdir(parents=True, exist_ok=True)
        field_labels_path.parent.mkdir(parents=True, exist_ok=True)
        metadata_path.parent.mkdir(parents=True, exist_ok=True)

        for variant in prepared_variants:
            variant_name = safe_filename_part(str(variant.get("variant", "variant")), max_len=32)
            prepared_image = variant.get("image")

            image_ok, image_reason = is_prepared_ocr_image_visually_useful(prepared_image)
            if not image_ok:
                skipped_variants.append(
                    {
                        "variant": variant_name,
                        "reason": image_reason or "invalid_prepared_image",
                    }
                )
                continue

            ok, encoded = cv2.imencode(".png", prepared_image)
            if not ok:
                skipped_variants.append(
                    {
                        "variant": variant_name,
                        "reason": "failed_to_encode_prepared_image",
                    }
                )
                continue

            digest = hashlib.sha1(
                encoded.tobytes()
                + b"\0"
                + doc_type.encode("utf-8")
                + b"\0"
                + field_name.encode("utf-8")
                + b"\0"
                + variant_name.encode("utf-8")
                + b"\0"
                + label_norm.encode("utf-8")
            ).hexdigest()[:24]

            image_rel_path = (
                Path("images")
                / safe_filename_part(field_name)
                / f"{digest}_{variant_name}.png"
            )
            image_path = dataset_dir / image_rel_path
            label_line = f"{image_rel_path.as_posix()}\t{label}\n"

            image_path.parent.mkdir(parents=True, exist_ok=True)
            is_new_image = not image_path.exists()

            if is_new_image:
                cv2.imwrite(str(image_path), prepared_image)
                append_unique_line(labels_path, label_line)
                append_unique_line(field_labels_path, label_line)

                metadata = {
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "mode": "ocr_improve",
                    "doc_type": doc_type,
                    "field_name": field_name,
                    "variant": variant_name,
                    "label": label,
                    "paddle_text": paddle_text,
                    "glm_text": glm_text,
                    "paddle_score": score_to_unit(float(paddle_score)),
                    "paddle_norm": paddle_norm,
                    "glm_norm": label_norm,
                    "source_file": source_file,
                    "file_index": file_index,
                    "page_index": page_index,
                    "document_index": document_index,
                    "doc_confidence": float(doc_confidence),
                    "field_confidence": float(field.get("confidence", 0.0)),
                    "orientation_angle": int(orientation_angle),
                    "orientation_score": float(orientation_score),
                    "orientation_confident": bool(orientation_confident),
                    "polygon_document": polygon_to_list(field["polygon"]),
                    "bbox_document": field["bbox"],
                    "raw_shape": variant.get("raw_shape"),
                    "prepared_shape": variant.get("prepared_shape"),
                    "image_path": str(image_path),
                    "label_path": str(labels_path),
                    "field_label_path": str(field_labels_path),
                }

                with metadata_path.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(metadata, ensure_ascii=False) + "\n")

                saved_count += 1
            else:
                duplicate_count += 1
                append_unique_line(labels_path, label_line)
                append_unique_line(field_labels_path, label_line)

            saved_variants.append(
                {
                    "variant": variant_name,
                    "new_image": is_new_image,
                    "image_path": str(image_path),
                }
            )

    if not saved_variants:
        base_result.update(
            {
                "reason": "no_valid_prepared_variants",
                "label": label,
                "skipped_count": len(skipped_variants),
                "skipped_variants": skipped_variants,
            }
        )
        return base_result

    base_result.update(
        {
            "saved": True,
            "new_image": saved_count > 0,
            "reason": (
                f"saved_{saved_count}_variants"
                if saved_count > 0
                else "duplicate_variants_already_exist"
            ),
            "label": label,
            "image_path": saved_variants[0]["image_path"],
            "label_path": str(labels_path),
            "field_label_path": str(field_labels_path),
            "metadata_path": str(metadata_path),
            "saved_count": saved_count,
            "duplicate_count": duplicate_count,
            "skipped_count": len(skipped_variants),
            "saved_variants": saved_variants,
            "skipped_variants": skipped_variants,
        }
    )
    return base_result

# ---------------------------------------------------------------------
# PIPELINE
# ---------------------------------------------------------------------

def process_page(
    image_bgr: np.ndarray,
    *,
    source_file: str,
    file_index: int,
    page_index: int,
    debug: bool = False,
    ocr_improve: bool = False,
) -> list[dict[str, Any]]:
    doc_yolo_started = time.perf_counter()
    documents = detect_documents(image_bgr)
    doc_yolo_seconds = elapsed_seconds(doc_yolo_started)

    output_docs: list[dict[str, Any]] = []

    for doc_index, doc in enumerate(documents):
        doc_type = doc["type"]

        if ocr_improve and doc_type not in OCR_IMPROVE_ALLOWED_DOC_TYPES:
            continue

        if  doc_type not in ALLOWED_DOC_TYPES:
            continue

        base_doc_crop, _ = warp_document_by_polygon(
            image_bgr=image_bgr,
            polygon=doc["polygon"],
        )

        oriented_doc_crop, fields, rotation, orientation_score, orientation_timing = (
            choose_best_document_orientation(
                doc_type=doc_type,
                base_crop_bgr=base_doc_crop,
            )
        )
        # todo убрать в продакшене
        orientation_confident = is_orientation_confident(
            doc_type=doc_type,
            fields=fields,
            score=float(orientation_score),
            image_shape=oriented_doc_crop.shape,
        )

        recognized_fields: list[dict[str, Any]] = []
        if not orientation_confident:
            ## кроме уверенности в ориентации, мы еще понимаем, достаточно ли полей распозналось
            print('Пропускаем страницу')
            continue

        for field in fields:
            field_name = field["name"]

            # MRZ не распознаём и не отдаём наружу, но он может участвовать
            # в выборе ориентации внутри score_passport_layout().
            if field_name in INTERNAL_ONLY_FIELDS:
                continue

            crop_started = time.perf_counter()
            field_crop = crop_field_polygon_masked(
                oriented_doc_crop,
                field["polygon"],
            )
            crop_seconds = elapsed_seconds(crop_started)

            prepared_variants: list[dict[str, Any]] = []
            prepared_field_crop: np.ndarray | None = None
            augment_preprocess_seconds = 0.0

            if ocr_improve and doc_type in OCR_IMPROVE_ALLOWED_DOC_TYPES and field_name not in SKIP_OCR_FIELDS:
                augment_started = time.perf_counter()
                # На горячем пути готовим только orig: это та картинка, которую
                # увидят PaddleOCR и GLM OCR. Aug01..aug03 строим только после
                # подтверждённого mismatch, прямо перед сохранением датасета.
                prepared_variants = build_ocr_improve_prepared_variants(
                    field_crop,
                    include_augmentations=False,
                )
                augment_preprocess_seconds = elapsed_seconds(augment_started)
                if prepared_variants:
                    prepared_field_crop = prepared_variants[0]["image"]

            text, ocr_conf, ocr_timings, prepared_field_crop = recognize_field_text(
                doc_type=doc_type,
                field_name=field_name,
                field_crop_bgr=field_crop,
                prepared_image_bgr=prepared_field_crop,
            )
            ocr_conf = score_to_unit(float(ocr_conf))

            if ocr_improve and not prepared_variants and prepared_field_crop is not None:
                prepared_variants = [
                    {
                        "variant": "orig",
                        "image": prepared_field_crop,
                        "raw_shape": list(field_crop.shape),
                        "prepared_shape": list(prepared_field_crop.shape),
                    }
                ]

            preprocess_seconds = round(
                crop_seconds
                + float(ocr_timings.get("ocr_preprocess_seconds", 0.0))
                + augment_preprocess_seconds,
                6,
            )

            recognized_fields.append(
                {
                    "field": field,
                    "field_name": field_name,
                    "field_crop": field_crop,
                    "field_crop_prepared": prepared_field_crop,
                    "field_crop_prepared_variants": prepared_variants,
                    "paddle_text": text,
                    "paddle_score": ocr_conf,
                    "final_text": text,
                    "source": "paddle" if field_name not in SKIP_OCR_FIELDS else "skipped",
                    "glm_text": None,
                    "glm_error": None,
                    "dataset_sample": None,
                    "ocr_improve_sample": None,
                    "quality": build_ocr_quality_report(
                        doc_type=doc_type,
                        field_name=field_name,
                        text=text,
                        paddle_score=ocr_conf,
                    ),
                    "tta": None,
                    "timing": {
                        "yolo_seconds": float(field.get("timing", {}).get("yolo_seconds", 0.0)),
                        "yolo_scope": field.get("timing", {}).get("yolo_scope"),
                        "preprocess_seconds": preprocess_seconds,
                        "crop_seconds": crop_seconds,
                        "ocr_preprocess_seconds": float(
                            ocr_timings.get("ocr_preprocess_seconds", 0.0)
                        ),
                        "ocr_improve_augment_preprocess_seconds": augment_preprocess_seconds,
                        "ocr_improve_prepared_variants_count": len(prepared_variants),
                        "paddle_seconds": float(ocr_timings.get("paddle_seconds", 0.0)),
                        "tta_seconds": 0.0,
                        "tta_preprocess_seconds": 0.0,
                        "tta_paddle_seconds": 0.0,
                        "tta_variants_count": 0,
                        "glm_ocr_seconds": 0.0,
                        "glm_ocr_scope": None,
                    },
                }
            )

        ocr_candidates = [
            item
            for item in recognized_fields
            if item["field_name"] not in SKIP_OCR_FIELDS
        ]
        paddle_scores = [float(item["paddle_score"]) for item in ocr_candidates]

        avg_paddle_score = (
            float(np.mean(paddle_scores))
            if paddle_scores
            else 0.0
        )

        fallback_mode = "ocr_improve_fields" if ocr_improve else "none"
        glm_document_values: dict[str, str] = {}

        if ocr_improve:
            # В режиме улучшения модели НЕ отправляем весь документ в GLM.
            # Каждый OCR-сегмент отдельно проходит PaddleOCR и GLM OCR.
            for item in ocr_candidates:
                try:
                    glm_started = time.perf_counter()
                    # Для сравнения и датасета используем ту же подготовленную
                    # картинку, которую видит PaddleOCR. Если prepare не вернул
                    # картинку, fallback на masked crop.
                    glm_input = item.get("field_crop_prepared")
                    if glm_input is None:
                        glm_input = item["field_crop"]
                    glm_text = glm_ocr_field(
                        doc_type=doc_type,
                        field_name=item["field_name"],
                        field_crop_bgr=glm_input,
                    )
                    item["timing"]["glm_ocr_seconds"] = elapsed_seconds(glm_started)
                    item["timing"]["glm_ocr_scope"] = "field_ocr_improve"
                    item["glm_text"] = glm_text

                    if glm_text:
                        source = (
                            "glm_improve_match"
                            if paddle_and_glm_texts_match(item["paddle_text"], glm_text)
                            else "glm_improve_mismatch"
                        )
                        apply_glm_text_to_item(
                            item=item,
                            doc_type=doc_type,
                            glm_text=glm_text,
                            source=source,
                        )
                    else:
                        item["source"] = "paddle_glm_empty"

                except Exception as exc:
                    item["timing"]["glm_ocr_seconds"] = elapsed_seconds(glm_started)
                    item["timing"]["glm_ocr_scope"] = "field_ocr_improve"
                    item["glm_error"] = str(exc)
                    item["source"] = "paddle_glm_failed"

            # Сохраняем только mismatch PaddleOCR vs GLM OCR, причём только если
            # сегмент прошёл проверки на валидность, чтобы не загрязнить датасет
            # неверно вырезанными YOLO-картинками.
            for item in ocr_candidates:
                item["ocr_improve_sample"] = save_ocr_improve_mismatch_sample(
                    doc_type=doc_type,
                    field_name=item["field_name"],
                    field=item["field"],
                    prepared_variants=item.get("field_crop_prepared_variants"),
                    raw_field_crop_bgr=item.get("field_crop"),
                    paddle_text=item["paddle_text"],
                    paddle_score=float(item["paddle_score"]),
                    glm_text=item.get("glm_text"),
                    source_file=source_file,
                    file_index=file_index,
                    page_index=page_index,
                    document_index=doc_index,
                    doc_confidence=float(doc["confidence"]),
                    orientation_angle=int(rotation),
                    orientation_score=float(orientation_score),
                    orientation_confident=bool(orientation_confident),
                )
                item["dataset_sample"] = item["ocr_improve_sample"]

        else:
            # 1) Если средний score всех OCR-сегментов плохой — один GLM вызов
            # на весь выровненный документ. Это быстрее, чем много GLM-вызовов.
            if ocr_candidates and avg_paddle_score < GLM_FULL_DOC_AVG_THRESHOLD:
                fallback_mode = "glm_document"
                glm_document_seconds = 0.0
                try:
                    glm_document_started = time.perf_counter()
                    glm_document_values = glm_ocr_document_json(
                        doc_type=doc_type,
                        doc_crop_bgr=oriented_doc_crop,
                    )
                    glm_document_seconds = elapsed_seconds(glm_document_started)
                except Exception:
                    glm_document_seconds = elapsed_seconds(glm_document_started)
                    fallback_mode = "glm_document_failed"
                    glm_document_values = {}

                for item in ocr_candidates:
                    field_name = item["field_name"]
                    glm_text = glm_document_values.get(field_name, "")
                    item["glm_text"] = glm_text
                    item["timing"]["glm_ocr_seconds"] = glm_document_seconds
                    item["timing"]["glm_ocr_scope"] = "shared_document"

                    if glm_text:
                        apply_glm_text_to_item(
                            item=item,
                            doc_type=doc_type,
                            glm_text=glm_text,
                            source="glm_document",
                        )

            # 2) Иначе точечно добиваем только поля ниже порога.
            else:
                for item in ocr_candidates:
                    if float(item["paddle_score"]) >= GLM_FIELD_FALLBACK_THRESHOLD:
                        continue

                    fallback_mode = "glm_field"

                    try:
                        glm_started = time.perf_counter()
                        # Для GLM/VLM лучше RAW crop: prepared 48px полезен PaddleOCR,
                        # но может убивать мелкие визуальные различия между повторами.
                        glm_input = item["field_crop"]
                        glm_text = glm_ocr_field(
                            doc_type=doc_type,
                            field_name=item["field_name"],
                            field_crop_bgr=glm_input,
                        )
                        item["timing"]["glm_ocr_seconds"] = elapsed_seconds(glm_started)
                        item["timing"]["glm_ocr_scope"] = "field"
                        item["glm_text"] = glm_text

                        if glm_text:
                            apply_glm_text_to_item(
                                item=item,
                                doc_type=doc_type,
                                glm_text=glm_text,
                                source="glm_field",
                            )
                        else:
                            item["source"] = "paddle_glm_empty"

                    except Exception as exc:
                        item["timing"]["glm_ocr_seconds"] = elapsed_seconds(glm_started)
                        item["timing"]["glm_ocr_scope"] = "field"
                        item["glm_error"] = str(exc)
                        item["source"] = "paddle_glm_failed"

            # 3) Production verification: ловим случаи, где PaddleOCR уверен,
            # но ошибся в длине/повторе символа. Запускается только по quality flags.
            quality_changed_count = 0
            for item in ocr_candidates:
                before_quality_text = item.get("final_text", "")
                if apply_quality_verification_to_item(item=item, doc_type=doc_type):
                    quality_changed_count += int(before_quality_text != item.get("final_text", ""))

            if quality_changed_count and fallback_mode == "none":
                fallback_mode = "quality_verification"

            # 4) Старый режим: если PaddleOCR был неуверен, но GLM OCR подтвердил
            # ровно тот же текст, сохраняем crop в датасет низкой уверенности.
            for item in ocr_candidates:
                glm_text = item.get("glm_text")
                if not glm_text:
                    continue

                low_conf_image = item.get("field_crop_prepared")
                if low_conf_image is None:
                    low_conf_image = item["field_crop"]

                item["dataset_sample"] = save_low_conf_agreement_sample(
                    doc_type=doc_type,
                    field_name=item["field_name"],
                    field_crop_bgr=low_conf_image,
                    paddle_text=item["paddle_text"],
                    paddle_score=float(item["paddle_score"]),
                    glm_text=glm_text,
                    source_file=source_file,
                    file_index=file_index,
                    page_index=page_index,
                    document_index=doc_index,
                )

        field_items: dict[str, Any] = {}
        public_output_field_names = set(DOC_OUTPUT_FIELDS.get(doc_type, []))

        for item in recognized_fields:
            field = item["field"]
            field_name = item["field_name"]

            # В обычном режиме не отдаём служебные поля вроде pas_photo/pas_mrz.
            # В debug-режиме оставляем поведение как раньше: показываем всё,
            # что прошло через pipeline и полезно для диагностики.
            if not debug and public_output_field_names and field_name not in public_output_field_names:
                continue

            glm_text = item.get("glm_text")
            has_glm_text = glm_text is not None and glm_text != ""
            paddle_glm_match = (
                paddle_and_glm_texts_match(item["paddle_text"], glm_text)
                if has_glm_text
                else None
            )
            paddle_glm_mismatch = bool(has_glm_text and paddle_glm_match is False)

            used_glm_as_final = (
                has_glm_text
                and item["source"] in {
                    "glm_field",
                    "glm_document",
                    "glm_quality",
                    "glm_improve_match",
                    "glm_improve_mismatch",
                }
            )

            if debug:
                field_item = {
                    "text": item["final_text"],
                    "recognition_source": item["source"],
                    "confidence": {
                        "detection": float(field["confidence"]),
                        # Числовой confidence есть только у PaddleOCR.
                        "ocr": float(item["paddle_score"]),
                        "paddle_ocr": float(item["paddle_score"]),
                        "glm_ocr": None,
                    },
                }

                # В debug-режиме, если GLM OCR и PaddleOCR не совпали, явно
                # дублируем вариант Paddle рядом с финальным текстом. Это удобно
                # при ручной проверке, потому что final_text в таком случае
                # обычно уже заменён на GLM OCR.
                if paddle_glm_mismatch:
                    field_item["paddle_text_if_glm_mismatch"] = item["paddle_text"]

                # Узбекские паспорта приходят в латинице; рядом отдаём русский
                # кириллический вариант, близкий к заполнению миграционной карты.
                # Сначала применяем словарь традиционных русских форм для полей
                # вроде места рождения/национальности, затем обычный алгоритм.
                if doc_type == "passport" and item["final_text"]:
                    field_item["text_cyrillic"] = transliterate_uz_latin_to_russian_migration_cyrillic(
                        item["final_text"],
                        field_name=field_name,
                    )

                field_item["debug"] = {
                    "timing": item["timing"],
                    "fallback": {
                        "ocr_improve": bool(ocr_improve),
                        "threshold_field": GLM_FIELD_FALLBACK_THRESHOLD,
                        "threshold_full_document_avg": GLM_FULL_DOC_AVG_THRESHOLD,
                        "paddle_text": item["paddle_text"],
                        "glm_text": item["glm_text"],
                        "glm_error": item["glm_error"],
                        "paddle_glm_match": paddle_glm_match,
                        "paddle_glm_mismatch": paddle_glm_mismatch,
                        "paddle_text_if_glm_mismatch": (
                            item["paddle_text"] if paddle_glm_mismatch else None
                        ),
                        "normalized": {
                            "paddle": normalize_ocr_text_for_match(item["paddle_text"]),
                            "glm": (
                                normalize_ocr_text_for_match(glm_text)
                                if has_glm_text
                                else None
                            ),
                        },
                    },
                    "quality": item.get("quality"),
                    "tta": item.get("tta"),
                    "low_conf_agreement_dataset": item["dataset_sample"] if not ocr_improve else None,
                    "ocr_improve_dataset": item["ocr_improve_sample"],
                    "polygon_document": polygon_to_list(field["polygon"]),
                    "bbox_document": field["bbox"],
                }

            else:
                # Публичный режим: только финальный текст, русский вариант для
                # паспорта и один confidence. Если итог взят из GLM OCR, считаем
                # confidence равным 1.0, как просил пользователь.
                field_item = {
                    "text": item["final_text"],
                    "confidence": 1.0 if used_glm_as_final else float(item["paddle_score"]),
                }

                if doc_type == "passport":
                    field_item["text_cyrillic"] = (
                        transliterate_uz_latin_to_russian_migration_cyrillic(
                            item["final_text"],
                            field_name=field_name,
                        )
                        if item["final_text"]
                        else ""
                    )

            field_items[field_name] = field_item

        if debug:
            output_doc = {
                "source": {
                    "file_index": file_index,
                    "filename": source_file,
                    "page_index": page_index,
                },
                "document_index": doc_index,
                "type": doc_type,
                "confidence": float(doc["confidence"]),
                "orientation": {
                    "rotation_applied_degrees_clockwise": rotation,
                    "score": orientation_score,
                    "confident": orientation_confident,
                },
                "ocr_quality": {
                    "avg_paddle_score": avg_paddle_score,
                    "fallback_mode": fallback_mode,
                    "ocr_improve": bool(ocr_improve),
                    "field_fallback_threshold": GLM_FIELD_FALLBACK_THRESHOLD,
                    "full_document_avg_threshold": GLM_FULL_DOC_AVG_THRESHOLD,
                    "verify_enabled": OCR_VERIFY_ENABLED,
                    "safe_repair_enabled": OCR_SAFE_REPAIR_ENABLED,
                    "tta_enabled": OCR_TTA_ENABLED,
                    "tta_max_variants": OCR_TTA_MAX_VARIANTS,
                    "dictionary_nearest_repair_enabled": OCR_SAFE_REPAIR_DICTIONARY_NEAREST,
                    "dictionary_nearest_max_distance": OCR_DICTIONARY_NEAREST_MAX_DISTANCE,
                    "assume_passport_when_documents_empty": ASSUME_PASSPORT_WHEN_DOCUMENTS_EMPTY,
                    "glm_on_quality_flags": OCR_GLM_ON_QUALITY_FLAGS,
                },
                "fields": field_items,
                "debug": {
                    "timing": {
                        "page_document_yolo_seconds": doc_yolo_seconds,
                        "orientation": orientation_timing,
                    },
                    "document_detection": {
                        "synthetic": bool(doc.get("synthetic_document", False)),
                        "fallback": doc.get("document_detection_fallback"),
                    },
                    "polygon_original": polygon_to_list(doc["polygon"]),
                    "bbox_original": doc["bbox"],
                    "detected_fields_count": len(fields),
                    "recognized_fields_count": len(recognized_fields),
                    "low_conf_agreement_dataset": {
                        "enabled": LOW_CONF_AGREEMENT_DATASET_ENABLED,
                        "dir": str(LOW_CONF_AGREEMENT_DATASET_DIR),
                        "score_threshold": LOW_CONF_AGREEMENT_SCORE_THRESHOLD,
                    },
                    "ocr_improve_dataset": {
                        "enabled": OCR_IMPROVE_DATASET_ENABLED,
                        "root": str(OCR_IMPROVE_DATASET_ROOT),
                        "min_doc_confidence": OCR_IMPROVE_MIN_DOC_CONF,
                        "min_field_confidence": OCR_IMPROVE_MIN_FIELD_CONF,
                        "require_confident_orientation": OCR_IMPROVE_REQUIRE_CONFIDENT_ORIENTATION,
                        "allowed_doc_types": sorted(OCR_IMPROVE_ALLOWED_DOC_TYPES),
                        "augmentations_per_segment": OCR_IMPROVE_AUGMENTATIONS_PER_SEGMENT,
                    },
                },
            }

        else:
            output_doc = {
                "type": doc_type,
                "fields": field_items,
            }

        output_docs.append(output_doc)

    return output_docs

def recognize_files_payload(
    files_payload: list[tuple[str, bytes, str | None]],
    *,
    debug: bool = False,
    ocr_improve: bool = False,
) -> list[dict[str, Any]]:
    all_documents: list[dict[str, Any]] = []

    with infer_lock:
        for file_index, (filename, data, content_type) in enumerate(files_payload):
            pages = load_pages_from_upload(
                data=data,
                filename=filename,
                content_type=content_type,
            )

            for page_index, page_bgr in enumerate(pages):
                docs = process_page(
                    page_bgr,
                    source_file=filename,
                    file_index=file_index,
                    page_index=page_index,
                    debug=debug,
                    ocr_improve=ocr_improve,
                )
                all_documents.extend(docs)

    return all_documents

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

# ---------------------------------------------------------------------
# ROUTES
# ---------------------------------------------------------------------

@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "models": {
            "doc_model": doc_model is not None,
            "passport_fields_model": passport_fields_model is not None,
            "migration_fields_model": migration_fields_model is not None,
            "passport_ocr": passport_ocr is not None,
            "migration_ocr": migration_ocr is not None,
        },
    }


@app.post("/recognize")
async def recognize_multipart(
    files: list[UploadFile] = File(...),
    debug: bool = Query(False),
    ocr_improve: bool = Query(False),
    debug_form: bool | None = Form(None, alias="debug"),
    ocr_improve_form: bool | None = Form(None, alias="ocr_improve"),
) -> list[dict[str, Any]]:
    # Поддерживаем оба варианта:
    #   POST /recognize?debug=true&ocr_improve=true
    #   multipart form-data: debug=true, ocr_improve=true
    effective_debug = debug_form if debug_form is not None else debug
    effective_ocr_improve = (
        ocr_improve_form
        if ocr_improve_form is not None
        else ocr_improve
    )

    payload = []

    for f in files:
        data = await f.read()
        payload.append(
            (
                f.filename or "uploaded_file",
                data,
                f.content_type,
            )
        )

    res = recognize_files_payload(
        payload,
        debug=bool(effective_debug),
        ocr_improve=bool(effective_ocr_improve),
    )
    if len(res) == 0:
        raise HTTPException(400, f"Плохое качество документа")
    return res


@app.post("/recognize-base64")
def recognize_base64(
    request: Base64Request,
    debug: bool = Query(False),
    ocr_improve: bool = Query(False),
) -> list[dict[str, Any]]:
    effective_debug = bool(debug or request.debug)
    effective_ocr_improve = bool(ocr_improve or request.ocr_improve)

    payload = []

    for item in request.files:
        payload.append(
            (
                item.filename,
                base64.b64decode(item.content_base64),
                None,
            )
        )

    return recognize_files_payload(
        payload,
        debug=effective_debug,
        ocr_improve=effective_ocr_improve,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=8000,
        reload=False,
        workers=1,
    )
