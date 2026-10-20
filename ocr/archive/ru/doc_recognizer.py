import uvicorn
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List, Optional, Union, Any, Dict
import tempfile
import shutil
import os
import uuid
from pathlib import Path
from PIL import Image
import io
import fitz  # PyMuPDF
import cv2
import numpy as np
import requests
import re
from typing import Any
import math
from datetime import datetime
import base64

#Try to import PaddleOCR, but make it optional
try:
    from paddleocr import PaddleOCR
    PADDLE_OCR_AVAILABLE = True
except ImportError:
    PADDLE_OCR_AVAILABLE = False
    PaddleOCR = None

app = FastAPI(title="DocImage -> LLM JSON extractor",
              description="Принимает PDF или изображения, извлекает фото документов и шлёт пути изображений в LLM. Возвращает JSON по типу документа.",
              version="1.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ----- Pydantic схемы (без confidence) -----
class RussianPassport(BaseModel):
    doc_type: str = "rus_passport"
    citizenship: Optional[str] = None
    first_name: Optional[str] = None   # Фамилия
    second_name: Optional[str] = None  # Имя
    third_name: Optional[str] = None   # Отчество
    date_birth: Optional[str] = None  # DD.MM.YYYY
    place_birth: Optional[str] = None
    sex: Optional[str] = None
    date_issue: Optional[str] = None  # DD.MM.YYYY
    issued_by: Optional[str] = None
    issued_by_code: Optional[str] = None
    series: Optional[str] = None
    number: Optional[str] = None

class UzbekistanPassport(BaseModel):
    doc_type: str = "uz_passport"
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    patronymic: Optional[str] = None
    date_birth: Optional[str] = None  # DD.MM.YYYY
    date_issue: Optional[str] = None  # DD.MM.YYYY
    series: Optional[str] = None
    number: Optional[str] = None
    issued_by: Optional[str] = None
    registration_address: Optional[str] = None

class TajikistanPassport(BaseModel):
    doc_type: str = "tj_passport"
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    patronymic: Optional[str] = None
    date_birth: Optional[str] = None  # DD.MM.YYYY
    date_issue: Optional[str] = None  # DD.MM.YYYY
    series: Optional[str] = None
    number: Optional[str] = None
    issued_by: Optional[str] = None
    registration_address: Optional[str] = None

class SNILS(BaseModel):
    doc_type: str = "snils"
    snils: Optional[str] = None

class INN(BaseModel):
    doc_type: str = "inn"
    inn: Optional[str] = None

class OMC(BaseModel):
    doc_type: str = "omc"
    omc: Optional[str] = None

class DocumentResponse(BaseModel):
    result: Union[RussianPassport, UzbekistanPassport, TajikistanPassport, SNILS, INN, OMC, dict]
    images_processed: List[str] = Field(..., description="Absolute paths to images sent to the LLM.")

# ----------------- utilities (unchanged) -----------------
def save_upload_to_file(upload: UploadFile, dst_dir: Path) -> Path:
    suffix = Path(upload.filename).suffix or ""
    fn = dst_dir / f"{uuid.uuid4().hex}{suffix}"
    with fn.open("wb") as f:
        shutil.copyfileobj(upload.file, f)
    return fn

def pdf_to_images(pdf_path: Path, dpi: int = 200) -> List[Image.Image]:
    images = []
    doc = fitz.open(str(pdf_path))
    for page in doc:
        mat = fitz.Matrix(dpi / 72, dpi / 72)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        images.append(img)
    return images

def split_page_into_photos(pil_image: Image.Image, min_area_ratio=0.03) -> List[Image.Image]:
    np_img = np.array(pil_image.convert("RGB"))
    img_gray = cv2.cvtColor(np_img, cv2.COLOR_RGB2GRAY)
    blur = cv2.GaussianBlur(img_gray, (5,5), 0)
    th = cv2.adaptiveThreshold(blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                               cv2.THRESH_BINARY_INV, 25, 15)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (25,25))
    closed = cv2.morphologyEx(th, cv2.MORPH_CLOSE, kernel)
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    h, w = img_gray.shape
    min_area = h * w * min_area_ratio
    rects = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < min_area:
            continue
        x,y,ww,hh = cv2.boundingRect(cnt)
        if ww < w*0.1 or hh < h*0.1:
            continue
        rects.append((x,y,ww,hh))
    if not rects:
        return [pil_image]
    rects = sorted(rects, key=lambda r: (r[1], r[0]))
    merged = []
    for r in rects:
        if not merged:
            merged.append(r)
            continue
        x,y,ww,hh = r
        mx,my,mw,mh = merged[-1]
        if x < mx+mw*1.2 and y < my+mh*1.2:
            nx = min(x, mx)
            ny = min(y, my)
            nxx = max(x+ww, mx+mw)
            nyy = max(y+hh, my+mh)
            merged[-1] = (nx, ny, nxx-nx, nyy-ny)
        else:
            merged.append(r)
    crops = []
    for (x,y,ww,hh) in merged:
        crop = np_img[y:y+hh, x:x+ww]
        crops.append(Image.fromarray(crop))
    return crops

def save_pil(img: Image.Image, dst_dir: Path, prefix="img") -> Path:
    fn = dst_dir / f"{prefix}_{uuid.uuid4().hex}.jpg"
    img = img.convert("RGB")
    img.save(fn, format="JPEG", quality=95)
    return fn

# ----------------- image encoder -----------------
def encode_image(image_path: str) -> str:
    """Кодирует изображение в base64 строку."""
    with open(image_path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")

# ----------------- call to ollama (без упоминания confidence) -----------------
def call_ollama_generate(
    model: str,
    system_prompt: str,
    user_messages: List[Dict[str, Any]],  # list of {"text": str, "image_paths": [...] } or simple strings
    image_paths: List[str],
    timeout: int = 60
):
    url = "http://127.0.0.1:11434/api/chat"

    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})

    for um in user_messages:
        if isinstance(um, str):
            messages.append({"role": "user", "content": um})
            continue
        if isinstance(um, dict):
            text = um.get("text", "")
            example_image_paths = um.get("image_paths", []) or []
            user_msg = {"role": "user", "content": text}
            images_encoded = []
            for p in example_image_paths:
                try:
                    if p and Path(p).exists():
                        images_encoded.append(encode_image(str(p)))
                except Exception:
                    continue
            if images_encoded:
                user_msg["images"] = images_encoded
            messages.append(user_msg)
            continue
        messages.append({"role": "user", "content": str(um)})

    final_instruction = (
        "IMPORTANT: Return exactly one JSON object (no explanation). "
        "Return plain field values (strings, booleans or null) — do NOT include any 'confidence' keys. "
        "Mapping for Russian passports (critical):\n"
        " - first_name => ФАМИЛИЯ\n"
        " - second_name => ИМЯ\n"
        " - third_name => ОТЧЕСТВО\n"
        "If they are not exactly matching these patterns, return null for that field. "
        "For Russian internal passport enforce: 'series' MUST be exactly 4 digits and 'number' MUST be exactly 6 digits. "
        "The following fields MUST be extracted from the FIRST PAGE of the document (first image): "
        "first_name, second_name, third_name, date_birth, place_birth, sex, date_issue, issued_by, issued_by_code, series, number, citizenship. "
        "All dates MUST be formatted as DD.MM.YYYY (e.g., 31.12.1999) or null if ambiguous. "
        "Supported doc types: rus_passport, uz_passport, tj_passport, snils, inn, omc. "
        "If the document type is Russian passport, set 'doc_type': 'rus_passport'. "
        "Example minimal JSON (rus_passport):\n"
        '{\n'
        '  "doc_type": "rus_passport",\n'
        '  "citizenship": "RUS",\n'
        '  "first_name": "ИВАНОВ",\n'
        '  "second_name": "ИВАН",\n'
        '  "third_name": "ИВАНОВИЧ",\n'
        '  "date_birth": "20.09.1991",\n'
        '  "place_birth": "город ...",\n'
        '  "sex": "М",\n'
        '  "date_issue": "23.01.2015",\n'
        '  "issued_by": "ОТДЕЛ ...",\n'
        '  "issued_by_code": "090-004",\n'
        '  "series": "9114",\n'
        '  "number": "694358",\n'
        "}\n"
    )

    user_message = {"role": "user", "content": final_instruction}
    if image_paths:
        images_encoded = []
        for p in image_paths:
            try:
                images_encoded.append(encode_image(str(p)))
            except Exception:
                continue
        if images_encoded:
            user_message["images"] = images_encoded
    messages.append(user_message)

    payload = {
        "model": model,
        "messages": messages,
        "stream": False
    }

    try:
        resp = requests.post(url, json=payload, timeout=timeout)
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        raise RuntimeError(f"Failed to call ollama at {url}: {e}")


def call_paddle_ocr(images_paths: List[str]) -> Dict[str, Any]:

    if not PADDLE_OCR_AVAILABLE:
        raise RuntimeError("PaddleOCR is not installed oravailable")

    # Initialize PaddleOCR with custom model
    ocr = PaddleOCR(
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        det_model_dir='./best_model',  # Using your custom model
        rec_model_dir='./best_model',  # Using your custom model
    )

    results = []
    for image_path in images_paths:
        result = ocr.ocr(image_path, cls=False)
        results.append({
            'image_path': image_path,
            'ocr_result': result
        })

    # Process OCR resultsto extract structured data
    return process_paddle_ocr_results(results)


def process_paddle_ocr_results(ocr_results: List[Dict]) -> Dict[str, Any]:

    # Placeholder implementation - you'll need to customize this based on your model's output
    extracted_data = {}

    # This is where you would implement your logic to parse the OCR results
    # and extract the structureddata according to your document types

    # For now, returning a minimal placeholder
    extracted_data['raw_ocr_results'] = ocr_results

    return extracted_data


# ----------------- нормализация дат -----------------
DATE_INPUT_FORMATS = [
    "%d.%m.%Y", "%d.%m.%y",
    "%Y-%m-%d", "%Y.%m.%d", "%Y/%m/%d",
    "%d/%m/%Y", "%d/%m/%y",
    "%d-%m-%Y", "%d-%m-%y",
    "%d %b %Y", "%d %B %Y", "%b %d %Y", "%B %d %Y",
]

def try_parse_date_to_ddmmYYYY(value: str) -> Optional[str]:
    if not value or not isinstance(value, str):
        return None
    v = value.strip()
    v = re.sub(r"[^\dA-Za-z.\-/ ]", "", v)
    for fmt in DATE_INPUT_FORMATS:
        try:
            dt = datetime.strptime(v, fmt)
            return dt.strftime("%d.%m.%Y")
        except Exception:
            continue
    m = re.search(r"(\d{1,2})[^\d](\d{1,2})\D(\d{2,4})", v)
    if m:
        d, mo, y = m.group(1), m.group(2), m.group(3)
        if len(y) == 2:
            yy = int(y)
            y_full = 2000 + yy if yy <= 30 else 1900 + yy
        else:
            y_full = int(y)
        try:
            dt = datetime(year=int(y_full), month=int(mo), day=int(d))
            return dt.strftime("%d.%m.%Y")
        except Exception:
            return None
    return None

def normalize_dates_in_result(obj: Any) -> Any:
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if isinstance(v, str) and re.search(r"(date|birth|issue|issued|дата|рожд)", k, flags=re.I):
                parsed = try_parse_date_to_ddmmYYYY(v)
                out[k] = parsed if parsed is not None else (v if v else None)
            else:
                out[k] = normalize_dates_in_result(v)
        return out
    elif isinstance(obj, list):
        return [normalize_dates_in_result(i) for i in obj]
    else:
        return obj

# ----------------- postprocessing & validation (без confidence) -----------------
def postprocess_and_validate(extracted: Any, images_count: int) -> Any:
    """
    - Work with flat JSON: field -> value (or null)
    - Enforce rus_passport strict rules: series 4 digits, number 6 digits
    - Normalize dates to DD.MM.YYYY or None
    - Normalize FIO: trimming, uppercase for Cyrillic, and mapping
    - Ensure required first page fields exist (set None if missing)
    """
    if not isinstance(extracted, dict):
        return extracted

    out = dict(extracted)  # shallow copy

    # Normalize doc_type string if nested
    if isinstance(out.get("doc_type"), dict):
        maybe = out["doc_type"].get("value")
        out["doc_type"] = maybe if isinstance(maybe, str) else None

    # Normalize name fields: trim, uppercase (for cyrillic)
    for name_key in ("first_name", "second_name", "third_name"):
        val = out.get(name_key)
        if isinstance(val, str):
            v = val.strip()
            v = re.sub(r"\s+", " ", v)
            if re.search(r"[А-Яа-яЁё]", v):
                out[name_key] = v.upper()
            else:
                out[name_key] = v
        else:
            out[name_key] = None

    # Normalize dates
    for date_key in ("date_birth", "date_issue"):
        v = out.get(date_key)
        if isinstance(v, str):
            parsed = try_parse_date_to_ddmmYYYY(v)
            out[date_key] = parsed if parsed is not None else None
        else:
            out[date_key] = None

    # Sex normalization
    sex = out.get("sex")
    if isinstance(sex, str):
        s = sex.strip().upper()
        if s in ("М", "МУЖ", "MALE", "M"):
            out["sex"] = "М"
        elif s in ("Ж", "ЖЕН", "FEMALE", "F"):
            out["sex"] = "Ж"
        else:
            m = re.search(r"[МЖ]", s)
            out["sex"] = m.group(0) if m else None
    else:
        out["sex"] = None

    # Russian passport strict validation
    doc_type = out.get("doc_type")
    if isinstance(doc_type, str) and doc_type.lower().startswith("rus"):
        # series: exactly 4 digits
        series = out.get("series")
        if isinstance(series, str):
            s = re.sub(r"[^\d]", "", series)
            out["series"] = s if re.fullmatch(r"\d{4}", s) else None
        else:
            out["series"] = None

        # number: exactly 6 digits
        number = out.get("number")
        if isinstance(number, str):
            n = re.sub(r"[^\d]", "", number)
            out["number"] = n if re.fullmatch(r"\d{6}", n) else None
        else:
            out["number"] = None

    # issued_by_code: clean to digits and dashes or None
    if "issued_by_code" in out and isinstance(out["issued_by_code"], str):
        code = out["issued_by_code"].strip()
        code = re.sub(r"[^\d\-]", "", code)
        out["issued_by_code"] = code if code else None

    # Ensure required first-page fields exist explicitly
    required_first_page = [
        "first_name", "second_name", "third_name", "date_birth", "place_birth",
        "sex", "date_issue", "issued_by", "issued_by_code", "series", "number", "citizenship"
    ]
    for k in required_first_page:
        if k not in out:
            out[k] = None

    # is_marital normalization (accept strings -> boolean or None)
    if "is_marital" in out:
        v = out.get("is_marital")
        if isinstance(v, bool):
            pass
        elif isinstance(v, str):
            s = v.strip().lower()
            if s in ("yes", "y", "да", "женат", "замужем", "married", "true", "1"):
                out["is_marital"] = True
            elif s in ("no", "n", "нет", "не женат", "не замужем", "false", "0"):
                out["is_marital"] = False
            else:
                out["is_marital"] = None
        else:
            out["is_marital"] = None


    return out


# ----------------- call to paddleocr -----------------
def call_paddle_ocr(images_paths: List[str]) -> Dict[str, Any]:
    """
    Call PaddleOCR with custom trained model to extract document data
    """
    if not PADDLE_OCR_AVAILABLE:
        raise RuntimeError("PaddleOCR is not installed or available")

    # Initialize PaddleOCR with custom model
    ocr = PaddleOCR(
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        det_model_dir='./best_model',  # Using your custom model
        rec_model_dir='./best_model',  # Using your custom model
    )

    results = []
    for image_path in images_paths:
        result = ocr.ocr(image_path, cls=False)
        results.append({
            'image_path': image_path,
            'ocr_result': result
        })

    # Process OCR results to extract structured data
    return process_paddle_ocr_results(results)


def process_paddle_ocr_results(ocr_results: List[Dict]) -> Dict[str, Any]:
    """
    Process OCR results to extract structured document data.
    This is a simplified implementation - in practice, you would need to implement
    sophisticated logic to parse the OCR results and extract the relevant fields.
    """
    # Placeholder implementation - you'll need to customize this based on your model's output
    extracted_data = {}

    # This is where you would implement your logic to parse the OCR results
    # and extract the structured data according to your document types

    # For now, returning a minimal placeholder
    extracted_data['raw_ocr_results'] = ocr_results

    return extracted_data


# ----------------- main endpoint -----------------
@app.post("/parse", response_model=DocumentResponse)
async def parse_documents(files: List[UploadFile] = File(...), model: str = "qwen2.5vl:7b",
                          system_prompt: Optional[str] = None, ocr_engine: str = "ollama"):
    tmp = Path(tempfile.mkdtemp(prefix="docparse_"))
    saved_image_paths = []
    try:
        for up in files:
            saved = save_upload_to_file(up, tmp)
            suffix = saved.suffix.lower()
            if suffix in [".pdf"]:
                pages = pdf_to_images(saved)
                for p in pages:
                    crops = split_page_into_photos(p)
                    for c in crops:
                        sp = save_pil(c, tmp)
                        saved_image_paths.append(str(sp.resolve()))
            else:
                try:
                    pil = Image.open(saved)
                    crops = split_page_into_photos(pil)
                    for c in crops:
                        sp = save_pil(c, tmp)
                        saved_image_paths.append(str(sp.resolve()))
                except Exception:
                    saved_image_paths.append(str(saved.resolve()))

        if not saved_image_paths:
            raise HTTPException(status_code=400, detail="No images extracted from input files.")

        # Process with selected OCR engine
        if ocr_engine.lower() == "paddleocr":
            if not PADDLE_OCR_AVAILABLE:
                raise HTTPException(status_code=501, detail="PaddleOCR is not installed or available")

            try:
                extracted_json = call_paddle_ocr(saved_image_paths)
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"PaddleOCR processing failed: {str(e)}")

        else:  # Default to Ollama
            # default system prompt (без confidence, с строгими правилами)
            if not system_prompt:
                system_prompt = (
                    "You are a helpful assistant that extracts structured VALID JSON data from images of documents. "
                    "The model receives only absolute filesystem paths to images (one or more). "
                    "Return a single JSON object with the exact fields required for the detected document type. "
                    "Supported doc types: rus_passport, uz_passport, tj_passport, snils, inn, omc. "
                    "IMPORTANT: Return plain field values (strings/booleans) or null. DO NOT include 'confidence'. "
                    "All dates MUST be formatted as DD.MM.YYYY (for example, 31.12.1999). "
                    "If you cannot determine a date unambiguously, return null for that field. "
                    "If there's ambiguity in OCR (e.g., 'РСФОР' detected), prefer the correct real-world expansion (for Russian passport use 'РСФСР' where appropriate). "
                    "Do not output any text other than the JSON object. "
                )

            # few_shot: restored original example images + example JSON (no confidences)
            few_shot = [
                {
                    "text": (
                        "Example (rus passport):\n"
                        "These images show a Russian internal passport. Expected structured JSON:\n"
                        "{\n"
                        '  "doc_type": "rus_passport",\n'
                        '  "citizenship": "RUS",\n'
                        '  "first_name": "ДМИТРИЙ",\n'
                        '  "second_name": "ВОЛОШИН",\n'
                        '  "third_name": "НИКОЛАЕВИЧ",\n'
                        '  "date_birth": "20.09.1991",\n'
                        '  "place_birth": "ПОС. ПРАВОКУБАНСКИЙ КАРАЧАЕВСКИЙ РАЙОН К-ЧАО РСФСР",\n'
                        '  "sex": "МУЖ",\n'
                        '  "date_issue": "23.01.2015",\n'
                        '  "issued_by": "ТП ОФМС РОССИИ ПО КАРАЧАЕВО-ЧЕРКЕССКОЙ РЕСПУБЛИКЕ В КАРАЧАЕВСКОМ Р-НЕ",\n'
                        '  "issued_by_code": "090-004",\n'
                        '  "series": "9114",\n'
                        '  "number": "694358",\n'
                        "}\n"
                    ),
                    "image_paths": [
                        "./examples_for_llm/example_rus_1.png",
                        "./examples_for_llm/example_rus_2.png",
                    ],
                },
            ]
            few_shot = []

            try:
                ollama_resp = call_ollama_generate(model=model, system_prompt=system_prompt, user_messages=few_shot, image_paths=saved_image_paths)
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e))

            # Robust JSON extraction from Ollama response
            extracted_json = None
            if isinstance(ollama_resp, dict):
                # Try common patterns
                content = None
                if "message" in ollama_resp and isinstance(ollama_resp, dict) and 'content' in ollama_resp["message"] and isinstance(ollama_resp["message"]['content'], str):
                    content = ollama_resp["message"]["content"]

                if content:
                    try:
                        import json as _json
                        extracted_json = _json.loads(content)
                    except Exception as e:
                        import re, json as _json2
                        m = re.search(r"(\{[\s\S]*\})", content)
                        if m:
                            try:
                                extracted_json = _json2.loads(m.group(1))
                            except Exception:
                                extracted_json = {"raw": content}
                        else:
                            extracted_json = {"raw": content}
                else:
                    extracted_json = {"raw_response": ollama_resp}
            else:
                # Try parse as JSON string
                try:
                    import json as _json
                    extracted_json = _json.loads(str(ollama_resp))
                except Exception:
                    extracted_json = {"raw": str(ollama_resp)}

        # Normalize dates in the returned JSON
        normalized_dates = normalize_dates_in_result(extracted_json)

        # Postprocess & validate (enforce series/number/FIO/dates)
        final_result = postprocess_and_validate(normalized_dates, images_count=len(saved_image_paths))

        return JSONResponse(status_code=200, content={
            "result": final_result,
            "images_processed": saved_image_paths
        })
    finally:
        # временную папку оставляем для отладки; при желании удалить:
        # shutil.rmtree(tmp, ignore_errors=True)
        pass

@app.get("/health")
def health():
    return {"status": "ok"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8001)
