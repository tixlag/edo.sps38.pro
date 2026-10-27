"""
OCR API — GLM-OCR edition.

Workflow:
  Взяли первое фото из pdf (или просто фото) →
  Вырезали сегменты паспорта с помощью YOLO →
  Распознали текст на сегментах с помощью GLM-OCR (zai-org/GLM-OCR)

  Многострочные сегменты (issued_by, address) передаются целиком.
  Все остальные сегменты передаются как crop по bbox.
  Fallback отсутствует.
"""

import logging
import os
import re
import sys
import shutil
import tempfile
import json
import asyncio
import math
import warnings
from asyncio import Lock
from datetime import datetime
from io import BytesIO
from pathlib import Path
from time import perf_counter
from typing import Any, Dict, List, Optional

import cv2
import numpy as np
from PIL import Image
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import uvicorn

from dotenv import load_dotenv

load_dotenv()

# ── optional heavy imports ──────────────────────────────────────────────────
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

# ── GLM-OCR ─────────────────────────────────────────────────────────────────
try:
    import torch
    from transformers import AutoTokenizer, AutoModelForImageTextToText, AutoProcessor

    _GLM_AVAILABLE = True
except Exception:
    _GLM_AVAILABLE = False

GLM_MODEL_PATH = os.environ.get("GLM_OCR_MODEL_PATH", "zai-org/GLM-OCR")

# ── Document type config ─────────────────────────────────────────────────────
DOC_TYPE_CONFIG = {
    "passport_ru": {
        "main_model_path": "/home/neuro/AI/OCR/yolo_model_new/runs/segment/train5/weights/PASPORT_SEGMENT_MODEL.pt",
        "multiline_model_path": "/home/neuro/PycharmProjects/DocRecognizer/yolo_models/rus_passport_multiline.pt",
    },
}

# Классы, которые передаются целиком (многострочные)
MULTILINE_CLASSES = {"issued_by", "address"}

# ── Pydantic model ────────────────────────────────────────────────────────────
class RussianPassport(BaseModel):
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
    "name": "first_name",
    "second_name": "second_name",
    "third_name": "third_name",
    "date": "date_birth",
    "address": "place_birth",
    "gender": "sex",
    "date_issue": "date_issue",
    "issued_by": "issued_by",
    "issued_by_code": "issued_by_code",
    "serial_number": "serial_number",
    "citizenship": "citizenship",
}

DEFAULT_MAX_W = 1920
DEFAULT_MAX_H = 1920

# ── GLM-OCR service ───────────────────────────────────────────────────────────

class GLMOCRService:
    """Singleton wrapper вокруг GLM-OCR model + processor."""

    _instance: Optional["GLMOCRService"] = None
    _lock = asyncio.Lock()

    def __init__(self):
        self.tokenizer = None
        self.processor = None
        self.model = None
        self._ready = False

    @classmethod
    def get_instance(cls) -> "GLMOCRService":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def load(self, model_path: str = GLM_MODEL_PATH):
        if self._ready:
            return
        if not _GLM_AVAILABLE:
            raise RuntimeError("transformers / torch not installed")
        # Эта модель регистрирует AutoTokenizer, а не AutoProcessor
        # self.tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
        self.processor = AutoProcessor.from_pretrained(model_path)
        self.model = AutoModelForImageTextToText.from_pretrained(
            pretrained_model_name_or_path=model_path,
            torch_dtype="auto",
            device_map="auto"
        )
        self._ready = True

    def recognize(self, image_path: str, prompt_text: str) -> str:
        """
        Распознаёт текст на изображении по пути image_path.
        Изображение загружается явно как PIL Image — apply_chat_template
        не умеет читать файлы по пути самостоятельно.
        """
        if not self._ready:
            raise RuntimeError("GLM-OCR model not loaded")

        # pil_image = Image.open(image_path).convert("RGB")

        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image", "url": image_path},
                    {"type": "text", "text": prompt_text},
                ],
            }
        ]

        inputs = self.processor.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=True,
            return_dict=True,
            return_tensors="pt",
        ).to(self.model.device)
        inputs.pop("token_type_ids", None)

        with torch.no_grad():
            generated_ids = self.model.generate(**inputs, max_new_tokens=8192)

        # skip_special_tokens=False — как в официальном примере модели
        output_text = self.processor.decode(
            generated_ids[0][inputs["input_ids"].shape[1]:],
            skip_special_tokens=False,
        )
        print(output_text) # todo убарть

        # Убираем служебные токены <|im_end|> и markdown-обёртки ``` ... ```
        output_text = re.sub(r"<\|[^|]+\|>", "", output_text)
        output_text = re.sub(r"```[a-zA-Z]*\n?", "", output_text)
        output_text = output_text.replace("```", "").strip()
        return output_text


_glm_service = GLMOCRService.get_instance()


def glm_recognize(img_array: np.ndarray, class_name: str, prompt: str,
                  output_dir: str = "/tmp/ocr_glm") -> tuple[str, str]:
    """
    Сохраняет numpy-кроп во временный файл и вызывает GLM-OCR.
    Возвращает (recognized_text, tmp_file_path).
    """
    os.makedirs(output_dir, exist_ok=True)
    tmp = tempfile.NamedTemporaryFile(
        suffix=".png", prefix=f"glm_{class_name}_", dir=output_dir, delete=False
    )
    tmp_path = tmp.name
    tmp.close()

    # конвертируем в BGR если нужно
    if img_array.ndim == 2:
        save_img = cv2.cvtColor(img_array, cv2.COLOR_GRAY2BGR)
    elif img_array.shape[2] == 4:
        save_img = cv2.cvtColor(img_array, cv2.COLOR_BGRA2BGR)
    else:
        save_img = img_array

    cv2.imwrite(tmp_path, save_img)
    text = _glm_service.recognize(tmp_path, prompt)
    return text, tmp_path


async def glm_recognize_async(img_array: np.ndarray, class_name: str, prompt: str,
                               output_dir: str = "/tmp/ocr_glm") -> tuple[str, str]:
    """Асинхронная обёртка над glm_recognize."""
    return await asyncio.to_thread(glm_recognize, img_array, class_name, prompt, output_dir)


# ── Prompts ───────────────────────────────────────────────────────────────────

# GLM-OCR поддерживает только фиксированные промпты для Document Parsing:
# "Text Recognition:", "Formula Recognition:", "Table Recognition:"
# Для сегментов паспорта всегда используем Text Recognition.
GLM_PROMPT_TEXT = "Text Recognition (Russian):"
GLM_PROMPT_FORMULA = "Formula Recognition:"
GLM_PROMPT_TABLE = "Table Recognition:"


def create_segment_prompt(class_name: str, doc_type: str = "passport_ru") -> str:
    """
    Возвращает промпт для GLM-OCR.
    GLM-OCR поддерживает только фиксированный набор Document Parsing промптов,
    поэтому для всех текстовых сегментов используется "Text Recognition:".
    """
    default_prompts = {
        "name": (
            "Extract only the name (имя) from this passport image. Return ONLY the text, nothing else. "
            "No explanations. Популярные имена для сравнения в помощь: АЛЕКСАНДР, ДМИТРИЙ, МАКСИМ, ИВАН, "
            "АРТЁМ, МИХАИЛ, СЕРГЕЙ, АНДРЕЙ, НИКОЛАЙ, ЕГОР, ИЛЬЯ, КИРИЛЛ, ВЛАДИСЛАВ, ТИМОФЕЙ, РОМАН, "
            "ДАНИИЛ, АЛЕКСЕЙ, НИКИТА, ПАВЕЛ, СТЕПАН, АНАСТАСИЯ, МАРИЯ, АННА, ДАРЬЯ, ЕКАТЕРИНА, АЛИНА, "
            "ПОЛИНА, ВИКТОРИЯ, СОФИЯ, АРИНА, ЕЛИЗАВЕТА, ВАРВАРА, КСЕНИЯ, МИЛАНА, ВЕРОНИКА, УЛЬЯНА, "
            "ТАИСИЯ, АЛИСА, ВАЛЕРИЯ, ЗЛАТА"
        ),
        "second_name": (
            "Extract only the surname (фамилия) from this passport image. "
            "Return ONLY the text, nothing else. No explanations."
        ),
        "third_name": (
            "Extract only the patronymic (отчество) from this passport image. "
            "Return ONLY the text, nothing else. No explanations."
        ),
        "date": (
            "Extract the birth date from this passport image in format DD.MM.YYYY. "
            "Return ONLY the date, nothing else. No explanations."
        ),
        "address": (
            "Extract the place of birth (место рождения) from this passport image. "
            "Return ONLY the text, nothing else, return ALL recognized text. No explanations. "
            "Это объекты России, Советского Союза или СНГ. Скорее всего текст написан на трех строках. "
            "В ответе верни ВЕСЬ распознанный текст, на каждой строке, "
            "ИГНОРИРУЙ мелкий шрифт, водяные знаки и отдельностоящую аббревиатуру РФ."
        ),
        "gender": (
            "Extract the sex/gender (пол) from this passport image. "
            "Return ONLY МУЖ or ЖЕН, nothing else. No explanations."
        ),
        "date_issue": (
            "Extract the issue date from this passport image in format DD.MM.YYYY. "
            "Return ONLY the date, nothing else. No explanations."
        ),
        "issued_by": (
            "Extract the 'issued by' organization name (кем выдан|паспорт выдан) from this passport image. "
            "Return ONLY the text, nothing else, return ALL recognized text. No explanations. "
            "Это объекты России, Советского Союза или СНГ. Скорее всего текст написан на трех строках. "
            "В ответе верни ВЕСЬ распознанный текст, на каждой строке, исключая мелкий шрифт. "
            "Важно сохранить каждый символ, и вернуть ответ в заглавном регистре"
        ),
        "issued_by_code": (
            "Extract the department code (код подразделения) from this passport image in format XXX-XXX. "
            "Return ONLY the code, nothing else. No explanations."
        ),
        "serial_number": (
            "Extract the passport series and number (серия и номер) from this passport image. "
            "Format: XX XX XXXXXX. Либо возвращаешь 10 цифр в формате XX XX XXXXXX, либо пустую строку. "
            "Return ONLY the series and number, nothing else. No explanations."
        ),
        "citizenship": (
            "Extract citizenship (гражданство) from this passport image. "
            "Return ONLY the text, nothing else. No explanations. Variants: RU, KZ, TG, UZ etc."
        ),
    }

    doc_specific = {
        "passport_ru": default_prompts,
        "passport_uz": {
            "name": "Extract the surname from this Uzbek passport. Return ONLY the text.",
            "second_name": "Extract the first name from this Uzbek passport. Return ONLY the text.",
            "date": "Extract the birth date from this Uzbek passport in format DD.MM.YYYY. Return ONLY the date.",
            "serial_number": "Extract the passport number from this Uzbek passport. Return ONLY the number.",
        },
    }

    prompts = doc_specific.get(doc_type, default_prompts)
    return GLM_PROMPT_TEXT
    # return prompts.get(
    #     class_name,
    #     f"Extract text from this {class_name} field of a {doc_type} document. Return only the text.",
    # )


def build_json_extraction_prompt(schema: dict) -> str:
    """
    Строит промпт для режима Information Extraction согласно требованиям GLM-OCR:
      请按下列JSON格式输出图中信息:
      {<schema>}
    Значения всех ключей обнуляются — GLM-OCR заполнит их сам.
    """
    def _empty_values(d: dict) -> dict:
        result = {}
        for k, v in d.items():
            if isinstance(v, dict):
                result[k] = _empty_values(v)
            else:
                result[k] = ""
        return result

    empty_schema = _empty_values(schema)
    schema_str = json.dumps(empty_schema, ensure_ascii=False, indent=4)
    return f"请按下列JSON格式输出图中信息:\n{schema_str}"


# ── Image helpers ─────────────────────────────────────────────────────────────

def ensure_dir(p: str):
    os.makedirs(p, exist_ok=True)


def order_points(pts):
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]
    return rect


def _resize_preserve_aspect_cv(img_cv, max_w=DEFAULT_MAX_W, max_h=DEFAULT_MAX_H):
    h, w = img_cv.shape[:2]
    if w <= max_w and h <= max_h:
        return img_cv
    scale = min(max_w / w, max_h / h)
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    return cv2.resize(img_cv, (new_w, new_h), interpolation=cv2.INTER_AREA)


def _pil_to_cv_bgr(pil_img):
    arr = np.array(pil_img.convert("RGB"))
    return arr[:, :, ::-1].copy()


def _compute_dpi_for_target_size(page_rect, target_w=DEFAULT_MAX_W, target_h=DEFAULT_MAX_H):
    w_in = page_rect.width / 72.0
    h_in = page_rect.height / 72.0
    if w_in <= 0 or h_in <= 0:
        return 72
    dpi = int(math.floor(min(target_w / w_in, target_h / h_in)))
    return max(dpi, 1)


def extract_one_image_from_pdf(pdf_path, max_w=DEFAULT_MAX_W, max_h=DEFAULT_MAX_H,
                                initial_dpi=500):
    pdf_stem = Path(pdf_path).stem
    images = convert_from_path(str(pdf_path), first_page=1, last_page=1)
    if not images:
        raise RuntimeError(f"Failed to convert PDF: {pdf_path}")
    img_cv = _pil_to_cv_bgr(images[0])
    img_cv = _resize_preserve_aspect_cv(img_cv, max_w=max_w, max_h=max_h)
    return [{"img": img_cv, "name": pdf_stem}]


def ensure_min_size(image_array, min_size=48):
    if len(image_array.shape) == 3:
        h, w, _ = image_array.shape
    else:
        h, w = image_array.shape
    if w >= min_size and h >= min_size:
        return image_array
    scale = min_size / min(w, h)
    new_w = int(w * scale)
    new_h = int(h * scale)
    return cv2.resize(image_array, (new_w, new_h), interpolation=cv2.INTER_LANCZOS4)


# ── YOLO segmentation ─────────────────────────────────────────────────────────

def should_rotate_image(boxes_xyxy, img_h, img_w, threshold_ratio=1.5):
    if len(boxes_xyxy) == 0:
        return False
    vertical = sum(
        1 for x1, y1, x2, y2 in boxes_xyxy
        if (y2 - y1) > (x2 - x1) * threshold_ratio
    )
    return vertical / len(boxes_xyxy) > 0.7


def run_yolo_segments(img, model, right_oriented_docs=None):
    """
    Детектирует сегменты через YOLO; возвращает {class_name: [crop_bgr, …]}.
    Многострочные классы (issued_by, address) возвращаются целиком по bbox.
    """
    if img is None or model is None:
        return None

    if right_oriented_docs is None:
        right_oriented_docs = []

    h, w = img.shape[:2]

    # первый проход — проверка ориентации
    results = model(img, verbose=False)
    result = results[0]

    if result.boxes is not None and len(result.boxes) > 0:
        boxes_xyxy = result.boxes.xyxy.cpu().numpy()
        if should_rotate_image(boxes_xyxy, h, w):
            img = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
            h, w = img.shape[:2]

    # второй проход на откорректированном изображении
    results = model(img, verbose=False)
    result = results[0]

    if result.boxes is None or len(result.boxes) == 0:
        return {}

    boxes = result.boxes
    names = result.names
    segments: Dict[str, List[np.ndarray]] = {}

    for i in range(len(boxes)):
        cls_id = int(boxes[i].cls.item())
        class_name = names[cls_id]

        x1f, y1f, x2f, y2f = map(float, boxes[i].xyxy[0])
        x1 = max(0, min(w - 1, int(round(x1f))))
        y1 = max(0, min(h - 1, int(round(y1f))))
        x2 = max(0, min(w,     int(round(x2f))))
        y2 = max(0, min(h,     int(round(y2f))))

        if x2 <= x1 or y2 <= y1:
            continue

        crop = img[y1:y2, x1:x2].copy()
        if crop.size == 0:
            continue

        # поворот для не-многострочных вертикальных полей
        if class_name not in MULTILINE_CLASSES and class_name != "document":
            ch, cw = crop.shape[:2]
            if cw < ch:
                crop = cv2.rotate(crop, cv2.ROTATE_90_COUNTERCLOCKWISE)

        segments.setdefault(class_name, []).append(crop)

    return segments


# ── Parsing helpers ───────────────────────────────────────────────────────────

def parse_serial_number(text: str):
    if not text:
        return None, None
    cleaned = re.sub(r"[^\d\s]", "", text)
    parts = cleaned.split()
    if len(parts) >= 2:
        if len(parts[0]) == 2 and len(parts[1]) == 2:
            series = f"{parts[0]} {parts[1]}"
            number = "".join(parts[2:]) if len(parts) > 2 else None
        elif len(parts[0]) == 4:
            series = f"{parts[0][:2]} {parts[0][2:]}"
            number = "".join(parts[1:])
        else:
            all_digits = "".join(parts)
            if len(all_digits) >= 4:
                series = f"{all_digits[:2]} {all_digits[2:4]}"
                number = all_digits[4:10] if len(all_digits) > 4 else None
            else:
                return None, None
        return series, number
    digits = "".join(parts)
    if len(digits) >= 10:
        return f"{digits[:2]} {digits[2:4]}", digits[4:10]
    return None, None


def clean_address(text: str) -> str:
    text = text.replace("\n", " ")
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\bРФ\b", "", text)
    return re.sub(r"\s+", " ", text).strip()


# ── Core processing ───────────────────────────────────────────────────────────

def process_images_list_glm(
    work_images: List[dict],
    model,
    doc_type: str,
    output_dir: Optional[str] = None,
    debug: bool = False,
) -> dict:
    """
    Для каждого изображения:
      1. Запускает YOLO-сегментацию.
      2. Для каждого сегмента вызывает GLM-OCR с соответствующим промптом.
         • Многострочные классы (issued_by, address) — crop целиком.
         • Остальные — обычный bbox-crop.
      3. Собирает поля паспорта, валидирует через Pydantic.

    Возвращает {'data': ..., 'segments_info': ..., 'timings': ... (если debug)}.
    """
    all_recognized_fields: Dict[str, Any] = {}
    all_segment_info: List[dict] = []
    total_start = perf_counter()

    timings: Dict[str, Any] = {"images": []} if debug else {}

    for item in work_images:
        img_cv = item["img"]
        img_name = item.get("name", "input")
        img_t0 = perf_counter()
        image_timing: Dict[str, Any] = {"name": img_name, "stages": {}}

        # ── сегментация ──────────────────────────────────────────────────────
        t0 = perf_counter()
        segments = None
        if model is not None:
            try:
                segments = run_yolo_segments(img_cv, model)
            except Exception as exc:
                if debug:
                    image_timing["stages"]["yolo_exception"] = str(exc)
        if debug:
            image_timing["stages"]["yolo_segmentation"] = perf_counter() - t0

        if not segments:
            if debug:
                timings["images"].append(image_timing)
            continue

        if debug:
            image_timing["stages"]["segments_count"] = sum(len(v) for v in segments.values())

        page_fields: Dict[str, Any] = {}
        segment_info_page: List[dict] = []

        # ── распознавание каждого сегмента ───────────────────────────────────
        for class_name, crops in segments.items():
            if class_name in ("document", "MRZ"):
                continue

            prompt = create_segment_prompt(class_name, doc_type)

            for idx, crop in enumerate(crops):
                seg_t0 = perf_counter()
                crop = ensure_min_size(crop)

                t0 = perf_counter()
                recognized_text, file_path = glm_recognize(
                    crop, f"{class_name}_{idx}", prompt, output_dir or "/tmp/ocr_glm"
                )
                ocr_time = perf_counter() - t0

                # постобработка многострочных полей
                if class_name in MULTILINE_CLASSES:
                    recognized_text = clean_address(recognized_text)

                # маппинг в поля паспорта
                if class_name in SEGMENT_TO_FIELD_MAP:
                    field = SEGMENT_TO_FIELD_MAP[class_name]
                    if class_name == "serial_number":
                        series, number = parse_serial_number(recognized_text)
                        if series:
                            page_fields["series"] = series
                        if number:
                            page_fields["number"] = number
                    elif class_name in ("name", "second_name", "third_name"):
                        if recognized_text:
                            page_fields[field] = recognized_text.title()
                    elif recognized_text:
                        page_fields[field] = recognized_text

                seg_entry: Dict[str, Any] = {
                    "class": class_name,
                    "recognized_text": recognized_text,
                    "file_path": file_path,
                }
                if debug:
                    seg_entry["ocr_time"] = ocr_time
                segment_info_page.append(seg_entry)

        all_recognized_fields.update({k: v for k, v in page_fields.items() if v})
        all_segment_info.extend(segment_info_page)

        if debug:
            image_timing["stages"]["image_total"] = perf_counter() - img_t0
            image_timing["segments"] = segment_info_page
            timings["images"].append(image_timing)

    # ── валидация ─────────────────────────────────────────────────────────────
    try:
        passport = RussianPassport(**all_recognized_fields)
        result_data = passport.model_dump()
    except Exception as exc:
        result_data = all_recognized_fields
        if debug:
            timings["validation_error"] = str(exc)

    result: Dict[str, Any] = {"data": result_data, "segments_info": all_segment_info}
    if debug:
        timings["total_time"] = perf_counter() - total_start
        result["timings"] = timings
    return result


# ── FastAPI app ───────────────────────────────────────────────────────────────

from contextlib import asynccontextmanager

@asynccontextmanager
async def _lifespan(app):
    """Загружаем GLM-OCR при старте сервера."""
    await asyncio.to_thread(_glm_service.load, GLM_MODEL_PATH)
    # logger ещё не инициализирован на этой стадии, используем print
    print(f"GLM-OCR loaded from {GLM_MODEL_PATH}")
    yield

app = FastAPI(title="OCR Passport API — GLM-OCR", lifespan=_lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

MODEL_CACHE: Dict[str, Dict[str, Any]] = {}
_cache_lock = Lock()

# Logging
LOG_DIR = Path("logs")
LOG_DIR.mkdir(exist_ok=True)
FILES_LOG_DIR = LOG_DIR / "files"
FILES_LOG_DIR.mkdir(exist_ok=True)

logger = logging.getLogger("ocr_glm_api")
logger.setLevel(logging.INFO)
_fh = logging.FileHandler(LOG_DIR / "api_requests.log", encoding="utf-8")
_fh.setFormatter(logging.Formatter("%(asctime)s - %(levelname)s - %(message)s"))
logger.addHandler(_fh)


async def get_yolo_model(config: Optional[Dict] = None) -> Dict[str, Any]:
    if config is None:
        return {}
    main_path = config.get("main_model_path", "")
    cache_key = main_path

    if cache_key in MODEL_CACHE:
        return MODEL_CACHE[cache_key]

    async with _cache_lock:
        if cache_key in MODEL_CACHE:
            return MODEL_CACHE[cache_key]
        if YOLO is None:
            raise HTTPException(500, "ultralytics YOLO not installed")
        try:
            main_model = await asyncio.to_thread(YOLO, main_path)
            MODEL_CACHE[cache_key] = {"main_model": main_model}
            return MODEL_CACHE[cache_key]
        except Exception as exc:
            raise HTTPException(500, f"Failed to load YOLO model: {exc}")



@app.post("/parse")
async def parse_files(
    files: List[UploadFile] = File(...),
    doc_type: str = Query("passport_ru"),
    dpi: int = Query(500),
    debug: bool = Query(True),
):
    """
    Основной endpoint.

    Принимает multipart-файлы (PDF или изображения).
    Параметры:
      - doc_type : тип документа
      - dpi      : dpi при рендере первой страницы PDF
      - debug    : если True — возвращает подробные тайминги

    Для каждого изображения запускается YOLO-сегментация, затем GLM-OCR
    распознаёт каждый сегмент. Многострочные классы (issued_by, address)
    передаются в OCR целиком; остальные — как отдельный bbox-crop.
    """
    if cv2 is None:
        raise HTTPException(500, "opencv-python not installed on server")
    if not _glm_service._ready:
        raise HTTPException(500, "GLM-OCR model not loaded yet")

    if doc_type not in DOC_TYPE_CONFIG:
        raise HTTPException(400, f"Unsupported doc_type: {doc_type}")

    request_id = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    request_log_dir = FILES_LOG_DIR / request_id
    request_log_dir.mkdir(exist_ok=True)
    logger.info(f"Request {request_id} — doc_type={doc_type}, dpi={dpi}")

    config = DOC_TYPE_CONFIG[doc_type]
    models = await get_yolo_model(config)
    model = models.get("main_model")

    tmpdir = tempfile.mkdtemp(prefix="ocr_glm_")
    work_images: List[dict] = []
    request_t0 = perf_counter()

    try:
        uploaded_info = []
        for idx, up in enumerate(files):
            filename = up.filename or f"upload_{idx}"
            dest = os.path.join(tmpdir, filename)
            content = await up.read()

            with open(dest, "wb") as fh:
                fh.write(content)

            log_path = request_log_dir / f"{idx:02d}_{filename}"
            with open(log_path, "wb") as fh:
                fh.write(content)

            uploaded_info.append(
                {"index": idx, "filename": filename, "size": len(content)}
            )
            logger.info(f"  File {idx}: {filename} ({len(content)} bytes)")

            suffix = Path(dest).suffix.lower()
            if suffix == ".pdf":
                if convert_from_path is None:
                    raise HTTPException(500, "pdf2image not installed")
                try:
                    imgs = await asyncio.to_thread(
                        extract_one_image_from_pdf, dest, DEFAULT_MAX_W, DEFAULT_MAX_H, dpi
                    )
                    work_images.extend(imgs)
                except Exception as exc:
                    raise HTTPException(400, f"PDF processing failed: {exc}")
            else:
                img_cv = cv2.imdecode(np.frombuffer(content, np.uint8), cv2.IMREAD_COLOR)
                if img_cv is None:
                    img_cv = await asyncio.to_thread(cv2.imread, dest)
                if img_cv is None:
                    raise HTTPException(400, f"Failed to read image: {filename}")
                work_images.append({"img": img_cv, "name": Path(filename).stem})

        # запускаем обработку в thread pool (CPU/GPU bound)
        result = await asyncio.to_thread(
            process_images_list_glm,
            work_images,
            model,
            doc_type,
            tmpdir,
            debug,
        )

        if debug:
            result.setdefault("timings", {})
            result["timings"]["request_total"] = perf_counter() - request_t0

        # сохраняем лог
        with open(request_log_dir / "response.json", "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=2)
        with open(request_log_dir / "metadata.json", "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "request_id": request_id,
                    "timestamp": datetime.now().isoformat(),
                    "parameters": {"doc_type": doc_type, "dpi": dpi, "debug": debug},
                    "files": uploaded_info,
                },
                fh,
                ensure_ascii=False,
                indent=2,
            )

        logger.info(f"Request {request_id} — completed OK")
        return JSONResponse(content=result)

    except Exception as exc:
        logger.error(f"Request {request_id} — error: {exc}", exc_info=True)
        with open(request_log_dir / "error.txt", "w", encoding="utf-8") as fh:
            fh.write(f"Error: {exc}\nTimestamp: {datetime.now().isoformat()}\n")
        raise

    finally:
        if not debug:
            try:
                shutil.rmtree(tmpdir)
            except Exception:
                pass



def process_images_raw(
    work_images: List[dict],
    prompt: str,
    output_dir: str,
    debug: bool = False,
) -> dict:
    """
    Обрабатывает изображения целиком — без YOLO-сегментации.
    Каждое изображение передаётся в GLM-OCR как есть, с указанным prompt.
    """
    results = []
    total_start = perf_counter()
    timings: Dict[str, Any] = {"images": []} if debug else {}

    for item in work_images:
        img_cv = item["img"]
        img_name = item.get("name", "input")
        t0 = perf_counter()

        recognized_text, file_path = glm_recognize(img_cv, img_name, prompt, output_dir)

        entry: Dict[str, Any] = {"name": img_name, "text": recognized_text, "file_path": file_path}
        results.append(entry)

        if debug:
            timings["images"].append({"name": img_name, "ocr_time": perf_counter() - t0})

    result: Dict[str, Any] = {"results": results}
    if debug:
        timings["total_time"] = perf_counter() - total_start
        result["timings"] = timings
    return result


def _apply_json_schema(raw_results: List[dict], schema: dict) -> dict:
    """
    GLM-OCR в режиме Information Extraction возвращает JSON напрямую.
    Склеиваем тексты всех страниц, пытаемся распарсить JSON.
    Если парсинг не удался — возвращаем схему с пустыми значениями.
    """
    full_text = "\n".join(r.get("text", "") for r in raw_results).strip()

    # Вырезаем JSON из ответа (модель иногда добавляет обёртку вроде ```json ... ```)
    json_match = re.search(r"\{.*\}", full_text, re.DOTALL)
    if json_match:
        candidate = json_match.group(0)
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass

    # Если парсинг не удался — возвращаем схему с пустыми строками
    def _empty(d: dict) -> dict:
        return {k: _empty(v) if isinstance(v, dict) else "" for k, v in d.items()}

    return _empty(schema)


@app.post("/parse_raw")
async def parse_raw(
    files: List[UploadFile] = File(...),
    prompt: str = Query("Text Recognition:"),
    schema: Optional[str] = Query(
        None,
        description=(
            "JSON-строка со схемой ответа. Ключи — имена полей, значения — "
            "подсказки для поиска в тексте или пустые строки. "
            "Пример: {\"last_name\": \"фамилия\", \"dob\": \"дата рождения\"}. "
            "Если передан — ответ вернёт тот же JSON с заполненными значениями."
        ),
    ),
    dpi: int = Query(500),
    debug: bool = Query(False),
):
    """
    Endpoint без сегментации — изображение/PDF передаётся в GLM-OCR целиком.

    Параметры:
      - prompt : текстовый prompt для GLM-OCR
      - schema : JSON-строка с желаемой структурой ответа (необязательно).
                 Если передан — ответ будет {"data": {<ключи схемы>: <значения>}, "raw": [...]}
                 Если не передан — ответ будет {"results": [{"name": ..., "text": ...}]}
      - dpi    : dpi при рендере первой страницы PDF
      - debug  : подробные тайминги
    """
    if cv2 is None:
        raise HTTPException(500, "opencv-python not installed on server")
    if not _glm_service._ready:
        raise HTTPException(500, "GLM-OCR model not loaded yet")

    parsed_schema: Optional[dict] = None
    if schema:
        try:
            parsed_schema = json.loads(schema)
            if not isinstance(parsed_schema, dict):
                raise ValueError("schema must be a JSON object")
        except Exception as exc:
            raise HTTPException(400, f"Invalid schema JSON: {exc}")

    request_id = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    request_log_dir = FILES_LOG_DIR / request_id
    request_log_dir.mkdir(exist_ok=True)
    logger.info(
        f"Request raw/{request_id} — prompt={prompt!r}, "
        f"schema={'yes' if parsed_schema else 'no'}"
    )

    tmpdir = tempfile.mkdtemp(prefix="ocr_glm_raw_")
    work_images: List[dict] = []
    request_t0 = perf_counter()

    try:
        uploaded_info = []
        for idx, up in enumerate(files):
            filename = up.filename or f"upload_{idx}"
            dest = os.path.join(tmpdir, filename)
            content = await up.read()

            with open(dest, "wb") as fh:
                fh.write(content)

            log_path = request_log_dir / f"{idx:02d}_{filename}"
            with open(log_path, "wb") as fh:
                fh.write(content)

            uploaded_info.append({"index": idx, "filename": filename, "size": len(content)})
            logger.info(f"  File {idx}: {filename} ({len(content)} bytes)")

            suffix = Path(dest).suffix.lower()
            if suffix == ".pdf":
                if convert_from_path is None:
                    raise HTTPException(500, "pdf2image not installed")
                try:
                    imgs = await asyncio.to_thread(
                        extract_one_image_from_pdf, dest, DEFAULT_MAX_W, DEFAULT_MAX_H, dpi
                    )
                    work_images.extend(imgs)
                except Exception as exc:
                    raise HTTPException(400, f"PDF processing failed: {exc}")
            else:
                img_cv = cv2.imdecode(np.frombuffer(content, np.uint8), cv2.IMREAD_COLOR)
                if img_cv is None:
                    img_cv = await asyncio.to_thread(cv2.imread, dest)
                if img_cv is None:
                    raise HTTPException(400, f"Failed to read image: {filename}")
                work_images.append({"img": img_cv, "name": Path(filename).stem})

        # Если передана schema — строим JSON-extraction промпт для GLM-OCR
        effective_prompt = (
            build_json_extraction_prompt(parsed_schema)
            if parsed_schema is not None
            else prompt
        )
        raw_result = await asyncio.to_thread(
            process_images_raw, work_images, effective_prompt, tmpdir, debug
        )

        if debug:
            raw_result.setdefault("timings", {})
            raw_result["timings"]["request_total"] = perf_counter() - request_t0

        if parsed_schema is not None:
            filled = await asyncio.to_thread(
                _apply_json_schema, raw_result["results"], parsed_schema
            )
            result: Dict[str, Any] = {"data": filled, "raw": raw_result["results"]}
            if debug and "timings" in raw_result:
                result["timings"] = raw_result["timings"]
        else:
            result = raw_result

        with open(request_log_dir / "response.json", "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=2)
        with open(request_log_dir / "metadata.json", "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "request_id": request_id,
                    "timestamp": datetime.now().isoformat(),
                    "parameters": {
                        "prompt": prompt, "dpi": dpi, "debug": debug, "schema": parsed_schema
                    },
                    "files": uploaded_info,
                },
                fh,
                ensure_ascii=False,
                indent=2,
            )

        logger.info(f"Request raw/{request_id} — completed OK")
        return JSONResponse(content=result)

    except Exception as exc:
        logger.error(f"Request raw/{request_id} — error: {exc}", exc_info=True)
        with open(request_log_dir / "error.txt", "w", encoding="utf-8") as fh:
            fh.write(f"Error: {exc}\nTimestamp: {datetime.now().isoformat()}\n")
        raise

    finally:
        if not debug:
            try:
                shutil.rmtree(tmpdir)
            except Exception:
                pass


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8002, reload=False)
