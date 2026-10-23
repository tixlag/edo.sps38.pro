from __future__ import annotations

import argparse
import csv
import html
import importlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import traceback
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from lxml import etree


# =============================================================================
# PATHS
# =============================================================================

PROJECT_ROOT = Path("/home/neuro/PycharmProjects/RecognizeUZ")

PADDLEOCR_ROOT = Path(
    "/home/neuro/PycharmProjects/createOCRDataset/PaddleOCR_training/PaddleOCR"
)

PADDLE_PYTHON_BIN = Path(
    "/home/neuro/PycharmProjects/createOCRDataset/.venv/bin/python"
)

# Твой новый эксперимент.
PASSPORT_CONFIG = (
    PROJECT_ROOT
    / "paddleocr/configs/rec/uz_passport_ppocrv5_mobile_rec_exp_c_latin_low_lr_more_aug.yml"
)

PASSPORT_TRAIN_OUTPUT_DIR = (
    PROJECT_ROOT
    / "paddleocr/output/ocr/passport_rec_exp_c_latin_low_lr_more_aug"
)

PASSPORT_CHECKPOINT_PREFIX = PASSPORT_TRAIN_OUTPUT_DIR / "best_model/model"

PASSPORT_INFERENCE_DIR = (
    PROJECT_ROOT
    / "paddleocr/inference/ocr/passport_rec_exp_c_latin_low_lr_more_aug"
)

# Миграционную пока оставляем текущую.
MIGRATION_INFERENCE_DIR = (
    PROJECT_ROOT
    / "paddleocr/inference/ocr/migration_rec_v3"
)

CVAT_ROOT = PROJECT_ROOT / "uz-annotaited-dataset"
CVAT_XML_PATH = CVAT_ROOT / "annotations.xml"
CVAT_IMAGES_DIR = CVAT_ROOT / "images"

# Берём именно val документов из YOLO split.
EVAL_IMAGES_DIR = PROJECT_ROOT / "yolo_doc_dataset/images/train"

# Сюда можешь положить неизвестные боевые картинки.
UNKNOWN_IMAGES_DIR = PROJECT_ROOT / "unknown_samples"

REPORT_ROOT = PROJECT_ROOT / "reports/full_pipeline"

CUDA_VISIBLE_DEVICES = "0"


# =============================================================================
# EVAL SETTINGS
# =============================================================================

SKIP_FIELDS = {
    "pas_photo",
}

EMPTY_GT_FIELDS = {
    "pas_mrz",
}

DOCUMENT_LABELS = {
    "1_passport_uz": "passport",
    "27_migration_card": "migration_card",
}

PASSPORT_FIELDS = {
    "2_pas_number": "pas_number",
    "3_pas_surname": "pas_surname",
    "4_pas_name": "pas_name",
    "5_pas_patronymic": "pas_patronymic",
    "6_pas_nationality": "pas_nationality",
    "7_pas_date_of_birth": "pas_date_of_birth",
    "8_pas_sex": "pas_sex",
    "9_pas_place_of_birth": "pas_place_of_birth",
    "10_pas_date_of_issue": "pas_date_of_issue",
    "11_pas_date_of_expiry": "pas_date_of_expiry",
    "12_pas_authority": "pas_authority",
    "13_pas_photo": "pas_photo",
    "14_pas_mrz": "pas_mrz",
}

MIGRATION_FIELDS = {
    "15_mg_series": "mg_series",
    "16_mg_number": "mg_number",
    "17_mg_surname": "mg_surname",
    "18_mg_surname_lat": "mg_surname_lat",
    "19_mg_name": "mg_name",
    "20_mg_patronymic": "mg_patronymic",
    "21_mg_date_of_birth": "mg_date_of_birth",
    "22_mg_nationality": "mg_nationality",
    "23_mg_passport_number": "mg_passport_number",
    "24_mg_visa_number": "mg_visa_number",
    "25_mg_duration_from": "mg_duration_from",
    "26_mg_duration_to": "mg_duration_to",
}

ALL_FIELD_LABELS = {
    **PASSPORT_FIELDS,
    **MIGRATION_FIELDS,
}

TEXT_FIELD_NAMES = set(PASSPORT_FIELDS.values()) | set(MIGRATION_FIELDS.values())
TEXT_FIELD_NAMES -= SKIP_FIELDS


# =============================================================================
# DATA STRUCTURES
# =============================================================================

@dataclass
class GroundTruthDocument:
    image_name: str
    doc_index: int
    doc_type: str
    fields: dict[str, str]


@dataclass
class EvalRow:
    image_name: str
    doc_index: int | None
    doc_type: str | None
    field: str
    expected: str
    predicted: str
    status: str
    cer: float | None
    cer_loose: float | None
    ocr_confidence: float | None
    recognizer: str | None


# =============================================================================
# GENERAL HELPERS
# =============================================================================

def check_file(path: Path, description: str) -> None:
    if not path.exists():
        raise FileNotFoundError(f"{description} not found: {path}")


def check_dir(path: Path, description: str) -> None:
    if not path.exists() or not path.is_dir():
        raise FileNotFoundError(f"{description} not found: {path}")


def run_command(command: list[str], cwd: Path) -> None:
    env = os.environ.copy()
    env["CUDA_VISIBLE_DEVICES"] = CUDA_VISIBLE_DEVICES

    print()
    print("=" * 100)
    print("COMMAND:")
    print(" ".join(command))
    print("CWD:", cwd)
    print("=" * 100)
    print()

    process = subprocess.Popen(
        command,
        cwd=str(cwd),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    assert process.stdout is not None

    for line in process.stdout:
        print(line, end="")

    return_code = process.wait()

    if return_code != 0:
        raise RuntimeError(f"Command failed with exit code {return_code}")


def safe_name(value: str) -> str:
    result = []

    for ch in value:
        if ch.isalnum() or ch in {"_", "-", "."}:
            result.append(ch)
        else:
            result.append("_")

    out = "".join(result).strip("_")
    return out[:140] if out else "file"


# =============================================================================
# EXPORT
# =============================================================================

def export_passport_model(force: bool = True) -> None:
    check_file(PADDLE_PYTHON_BIN, "Paddle Python")
    check_file(PADDLEOCR_ROOT / "tools/export_model.py", "PaddleOCR export_model.py")
    check_file(PASSPORT_CONFIG, "Passport config")
    check_file(PASSPORT_CHECKPOINT_PREFIX.with_suffix(".pdparams"), "Passport checkpoint .pdparams")

    if force and PASSPORT_INFERENCE_DIR.exists():
        print(f"Remove old inference dir: {PASSPORT_INFERENCE_DIR}")
        shutil.rmtree(PASSPORT_INFERENCE_DIR)

    PASSPORT_INFERENCE_DIR.parent.mkdir(parents=True, exist_ok=True)

    command = [
        str(PADDLE_PYTHON_BIN),
        "tools/export_model.py",
        "-c",
        str(PASSPORT_CONFIG),
        "-o",
        f"Global.checkpoints={PASSPORT_CHECKPOINT_PREFIX}",
        f"Global.save_inference_dir={PASSPORT_INFERENCE_DIR}",
        "Global.model_name=PP-OCRv5_mobile_rec",
    ]

    run_command(command, cwd=PADDLEOCR_ROOT)

    validate_inference_dir(PASSPORT_INFERENCE_DIR)

    print()
    print("Export done:")
    print(PASSPORT_INFERENCE_DIR)


def validate_inference_dir(path: Path) -> None:
    check_dir(path, "Inference dir")

    files = [p.name for p in path.iterdir() if p.is_file()]

    has_params = any(name.endswith(".pdiparams") for name in files)
    has_model = (
        any(name.endswith(".pdmodel") for name in files)
        or "inference.json" in files
        or "inference.yml" in files
    )

    if not has_params:
        raise RuntimeError(f"No .pdiparams in inference dir: {path}. Files: {files}")

    if not has_model:
        raise RuntimeError(f"No model file/json/yml in inference dir: {path}. Files: {files}")

    print("Inference dir OK:", path)
    print("Files:", sorted(files))


# =============================================================================
# CVAT GROUND TRUTH
# =============================================================================

def parse_points(points: str) -> np.ndarray:
    return np.array(
        [list(map(float, p.split(","))) for p in points.split(";")],
        dtype=np.float32,
    )


def polygon_center(points: np.ndarray) -> tuple[float, float]:
    return float(points[:, 0].mean()), float(points[:, 1].mean())


def point_in_polygon(point: tuple[float, float], polygon: np.ndarray) -> bool:
    return cv2.pointPolygonTest(polygon.astype(np.float32), point, False) >= 0


def get_attr_value(polygon_node: etree._Element, name: str) -> str:
    for attr in polygon_node.findall("attribute"):
        if attr.get("name") == name:
            return attr.text or ""
    return ""


def load_gt_from_cvat() -> dict[str, list[GroundTruthDocument]]:
    check_file(CVAT_XML_PATH, "CVAT annotations.xml")

    tree = etree.parse(str(CVAT_XML_PATH))
    result: dict[str, list[GroundTruthDocument]] = {}

    for image_node in tree.findall(".//image"):
        image_name = image_node.get("name")

        if not image_name:
            continue

        documents: list[dict[str, Any]] = []
        fields: list[dict[str, Any]] = []

        for polygon_node in image_node.findall("polygon"):
            label = polygon_node.get("label")
            points_text = polygon_node.get("points")

            if not label or not points_text:
                continue

            points = parse_points(points_text)

            if label in DOCUMENT_LABELS:
                documents.append(
                    {
                        "type": DOCUMENT_LABELS[label],
                        "polygon": points,
                    }
                )

            elif label in ALL_FIELD_LABELS:
                fields.append(
                    {
                        "name": ALL_FIELD_LABELS[label],
                        "label": label,
                        "points": points,
                        "content": get_attr_value(polygon_node, "content"),
                    }
                )

        gt_docs: list[GroundTruthDocument] = []

        for doc_index, doc in enumerate(documents):
            doc_type = doc["type"]
            doc_polygon = doc["polygon"]

            allowed = (
                set(PASSPORT_FIELDS.values())
                if doc_type == "passport"
                else set(MIGRATION_FIELDS.values())
            )

            doc_fields: dict[str, str] = {}

            for field in fields:
                field_name = field["name"]

                if field_name not in allowed:
                    continue

                cx, cy = polygon_center(field["points"])

                if not point_in_polygon((cx, cy), doc_polygon):
                    continue

                doc_fields[field_name] = field["content"]

            gt_docs.append(
                GroundTruthDocument(
                    image_name=image_name,
                    doc_index=doc_index,
                    doc_type=doc_type,
                    fields=doc_fields,
                )
            )

        if gt_docs:
            result[image_name] = gt_docs

    return result


# =============================================================================
# METRICS
# =============================================================================

def normalize_strict(text: str) -> str:
    text = str(text).upper()
    text = text.replace("\t", " ")
    text = text.replace("\n", " ")
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def normalize_loose(text: str) -> str:
    text = normalize_strict(text)
    text = text.replace(" ", "")
    text = text.replace(".", "")
    text = text.replace("-", "")
    text = text.replace("/", "")
    return text


def edit_distance(a: str, b: str) -> int:
    if a == b:
        return 0

    if not a:
        return len(b)

    if not b:
        return len(a)

    prev = list(range(len(b) + 1))

    for i, ca in enumerate(a, start=1):
        cur = [i]

        for j, cb in enumerate(b, start=1):
            cur.append(
                min(
                    cur[j - 1] + 1,
                    prev[j] + 1,
                    prev[j - 1] + (ca != cb),
                )
            )

        prev = cur

    return prev[-1]


def cer(expected: str, predicted: str, loose: bool = False) -> float:
    if loose:
        e = normalize_loose(expected)
        p = normalize_loose(predicted)
    else:
        e = normalize_strict(expected)
        p = normalize_strict(predicted)

    if not e:
        return 0.0 if not p else 1.0

    return edit_distance(e, p) / max(1, len(e))


def compare_text(expected: str, predicted: str) -> tuple[str, float | None, float | None]:
    expected_s = normalize_strict(expected)
    predicted_s = normalize_strict(predicted)

    if not expected_s:
        return "EMPTY_GT", None, None

    if expected_s == predicted_s:
        return "OK", 0.0, 0.0

    expected_l = normalize_loose(expected)
    predicted_l = normalize_loose(predicted)

    if expected_l == predicted_l:
        return "OK_SPACE_DIFF", cer(expected, predicted, False), 0.0

    return "TEXT_MISMATCH", cer(expected, predicted, False), cer(expected, predicted, True)


# =============================================================================
# APP PIPELINE IMPORT / EXECUTION
# =============================================================================

def import_app_with_new_model(
    *,
    passport_inference_dir: Path,
    migration_inference_dir: Path,
    disable_glm: bool = True,
):
    sys.path.insert(0, str(PROJECT_ROOT))

    if "app" in sys.modules:
        del sys.modules["app"]

    app_module = importlib.import_module("app")

    # Подменяем пути до load_models().
    if hasattr(app_module, "PASSPORT_OCR_MODEL_DIR"):
        app_module.PASSPORT_OCR_MODEL_DIR = passport_inference_dir

    if hasattr(app_module, "MIGRATION_OCR_MODEL_DIR"):
        app_module.MIGRATION_OCR_MODEL_DIR = migration_inference_dir

    if disable_glm:
        if hasattr(app_module, "GLM_OCR_ENABLED"):
            app_module.GLM_OCR_ENABLED = False

        os.environ["GLM_OCR_ENABLED"] = "0"

    if hasattr(app_module, "cleanup_models"):
        try:
            app_module.cleanup_models()
        except Exception:
            pass

    app_module.load_models()

    return app_module


def recognize_image_with_app(
    app_module,
    image_path: Path,
    debug: bool = False,
) -> list[dict[str, Any]]:
    content_type, _ = mimetypes.guess_type(str(image_path))
    payload = [
        (
            image_path.name,
            image_path.read_bytes(),
            content_type,
        )
    ]

    try:
        raw = app_module.recognize_files_payload(payload, debug=debug)
    except TypeError:
        raw = app_module.recognize_files_payload(payload)

    if isinstance(raw, dict):
        docs = raw.get("documents", [])
        if isinstance(docs, list):
            return docs
        return []

    if isinstance(raw, list):
        return raw

    return []


# =============================================================================
# PREDICTION NORMALIZATION
# =============================================================================

def normalize_predicted_docs(raw_docs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    docs = []

    for doc_index, doc in enumerate(raw_docs):
        doc_type = str(doc.get("type", "unknown"))

        raw_fields = doc.get("fields", {})
        fields: dict[str, dict[str, Any]] = {}

        if isinstance(raw_fields, dict):
            for name, value in raw_fields.items():
                if isinstance(value, dict):
                    text = str(value.get("text", ""))
                    confidence = extract_confidence(value)
                    recognizer = extract_recognizer(value)
                else:
                    text = str(value)
                    confidence = None
                    recognizer = None

                fields[name] = {
                    "text": text,
                    "confidence": confidence,
                    "recognizer": recognizer,
                    "raw": value,
                }

        elif isinstance(raw_fields, list):
            for item in raw_fields:
                if not isinstance(item, dict):
                    continue

                name = str(item.get("name", "unknown"))
                text = str(item.get("text", ""))
                confidence = extract_confidence(item)
                recognizer = extract_recognizer(item)

                fields[name] = {
                    "text": text,
                    "confidence": confidence,
                    "recognizer": recognizer,
                    "raw": item,
                }

        docs.append(
            {
                "doc_index": int(doc.get("document_index", doc_index)),
                "type": doc_type,
                "fields": fields,
                "raw": doc,
            }
        )

    return docs


def extract_confidence(value: dict[str, Any]) -> float | None:
    if "confidence" in value:
        conf = value["confidence"]

        if isinstance(conf, dict):
            if "ocr" in conf:
                try:
                    return float(conf["ocr"])
                except Exception:
                    return None

            if "recognition" in conf:
                try:
                    return float(conf["recognition"])
                except Exception:
                    return None

            return None

        try:
            return None if conf is None else float(conf)
        except Exception:
            return None

    if "ocr_conf" in value:
        try:
            return float(value["ocr_conf"])
        except Exception:
            return None

    return None


def extract_recognizer(value: dict[str, Any]) -> str | None:
    if "recognizer" in value:
        return str(value["recognizer"])

    if "source" in value:
        return str(value["source"])

    return None


def match_docs(
    gt_docs: list[GroundTruthDocument],
    pred_docs: list[dict[str, Any]],
) -> dict[int, dict[str, Any] | None]:
    result: dict[int, dict[str, Any] | None] = {}
    used_pred_indexes: set[int] = set()

    for gt_i, gt_doc in enumerate(gt_docs):
        best_pred_i = None
        best_score = -1

        for pred_i, pred_doc in enumerate(pred_docs):
            if pred_i in used_pred_indexes:
                continue

            if pred_doc["type"] != gt_doc.doc_type:
                continue

            pred_fields = set(pred_doc["fields"].keys())
            gt_fields = set(gt_doc.fields.keys())
            score = len(pred_fields & gt_fields)

            if score > best_score:
                best_score = score
                best_pred_i = pred_i

        if best_pred_i is None:
            result[gt_i] = None
        else:
            used_pred_indexes.add(best_pred_i)
            result[gt_i] = pred_docs[best_pred_i]

    return result


# =============================================================================
# EVALUATION
# =============================================================================

def collect_eval_images(eval_images_dir: Path) -> list[Path]:
    check_dir(eval_images_dir, "Evaluation images dir")

    exts = {
        ".jpg",
        ".jpeg",
        ".png",
        ".webp",
        ".bmp",
        ".tif",
        ".tiff",
        ".pdf",
    }

    images = [
        p
        for p in eval_images_dir.rglob("*")
        if p.is_file() and p.suffix.lower() in exts
    ]

    return sorted(images, key=lambda p: p.name)


def evaluate_known_images(
    *,
    app_module,
    image_paths: list[Path],
    gt_by_image: dict[str, list[GroundTruthDocument]],
    out_dir: Path,
    debug: bool,
) -> tuple[list[EvalRow], list[dict[str, Any]]]:
    rows: list[EvalRow] = []
    details: list[dict[str, Any]] = []

    predictions_dir = out_dir / "predictions"
    predictions_dir.mkdir(parents=True, exist_ok=True)

    for idx, image_path in enumerate(image_paths, start=1):
        print(f"[{idx}/{len(image_paths)}] {image_path.name}")

        gt_docs = gt_by_image.get(image_path.name)

        if not gt_docs:
            rows.append(
                EvalRow(
                    image_name=image_path.name,
                    doc_index=None,
                    doc_type=None,
                    field="_image",
                    expected="",
                    predicted="",
                    status="NO_GT_FOR_IMAGE",
                    cer=None,
                    cer_loose=None,
                    ocr_confidence=None,
                    recognizer=None,
                )
            )
            continue

        try:
            raw_docs = recognize_image_with_app(
                app_module,
                image_path,
                debug=debug,
            )
            pred_docs = normalize_predicted_docs(raw_docs)

            (predictions_dir / f"{safe_name(image_path.stem)}.json").write_text(
                json.dumps(raw_docs, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )

        except Exception as e:
            err = {
                "image": image_path.name,
                "error": str(e),
                "traceback": traceback.format_exc(),
            }

            details.append(err)

            rows.append(
                EvalRow(
                    image_name=image_path.name,
                    doc_index=None,
                    doc_type=None,
                    field="_image",
                    expected="",
                    predicted="",
                    status="PIPELINE_ERROR",
                    cer=None,
                    cer_loose=None,
                    ocr_confidence=None,
                    recognizer=None,
                )
            )
            continue

        matched = match_docs(gt_docs, pred_docs)

        image_detail = {
            "image": image_path.name,
            "gt_docs": [
                {
                    "doc_index": d.doc_index,
                    "type": d.doc_type,
                    "fields": d.fields,
                }
                for d in gt_docs
            ],
            "pred_docs": raw_docs,
            "rows": [],
        }

        for gt_i, gt_doc in enumerate(gt_docs):
            pred_doc = matched.get(gt_i)

            if pred_doc is None:
                for field_name, expected_text in gt_doc.fields.items():
                    if field_name in SKIP_FIELDS:
                        continue

                    if field_name in EMPTY_GT_FIELDS and not normalize_strict(expected_text):
                        continue

                    row = EvalRow(
                        image_name=image_path.name,
                        doc_index=gt_doc.doc_index,
                        doc_type=gt_doc.doc_type,
                        field=field_name,
                        expected=expected_text,
                        predicted="",
                        status="NO_DOC_FOUND",
                        cer=1.0 if normalize_strict(expected_text) else None,
                        cer_loose=1.0 if normalize_strict(expected_text) else None,
                        ocr_confidence=None,
                        recognizer=None,
                    )
                    rows.append(row)
                    image_detail["rows"].append(row.__dict__)

                continue

            pred_fields = pred_doc["fields"]

            for field_name, expected_text in gt_doc.fields.items():
                if field_name in SKIP_FIELDS:
                    continue

                if field_name in EMPTY_GT_FIELDS and not normalize_strict(expected_text):
                    continue

                pred_field = pred_fields.get(field_name)

                if pred_field is None:
                    row = EvalRow(
                        image_name=image_path.name,
                        doc_index=gt_doc.doc_index,
                        doc_type=gt_doc.doc_type,
                        field=field_name,
                        expected=expected_text,
                        predicted="",
                        status="MISS_FIELD",
                        cer=1.0 if normalize_strict(expected_text) else None,
                        cer_loose=1.0 if normalize_strict(expected_text) else None,
                        ocr_confidence=None,
                        recognizer=None,
                    )
                    rows.append(row)
                    image_detail["rows"].append(row.__dict__)
                    continue

                predicted_text = pred_field["text"]

                status, row_cer, row_cer_loose = compare_text(
                    expected_text,
                    predicted_text,
                )

                if status == "EMPTY_GT":
                    continue

                row = EvalRow(
                    image_name=image_path.name,
                    doc_index=gt_doc.doc_index,
                    doc_type=gt_doc.doc_type,
                    field=field_name,
                    expected=expected_text,
                    predicted=predicted_text,
                    status=status,
                    cer=row_cer,
                    cer_loose=row_cer_loose,
                    ocr_confidence=pred_field["confidence"],
                    recognizer=pred_field["recognizer"],
                )
                rows.append(row)
                image_detail["rows"].append(row.__dict__)

        details.append(image_detail)

    return rows, details


def evaluate_unknown_images(
    *,
    app_module,
    unknown_dir: Path,
    out_dir: Path,
    debug: bool,
) -> list[dict[str, Any]]:
    if not unknown_dir.exists():
        return []

    image_paths = collect_eval_images(unknown_dir)

    if not image_paths:
        return []

    output = []
    unknown_predictions_dir = out_dir / "unknown_predictions"
    unknown_predictions_dir.mkdir(parents=True, exist_ok=True)

    print()
    print("=" * 100)
    print(f"UNKNOWN IMAGES: {unknown_dir}")
    print("=" * 100)

    for idx, image_path in enumerate(image_paths, start=1):
        print(f"[UNKNOWN {idx}/{len(image_paths)}] {image_path.name}")

        try:
            raw_docs = recognize_image_with_app(
                app_module,
                image_path,
                debug=debug,
            )

            item = {
                "image": str(image_path),
                "documents": raw_docs,
            }

        except Exception as e:
            item = {
                "image": str(image_path),
                "error": str(e),
                "traceback": traceback.format_exc(),
            }

        output.append(item)

        (unknown_predictions_dir / f"{safe_name(image_path.stem)}.json").write_text(
            json.dumps(item, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    return output


# =============================================================================
# REPORTS
# =============================================================================

def build_summary(rows: list[EvalRow]) -> dict[str, Any]:
    status_counts: dict[str, int] = {}
    field_counts: dict[str, dict[str, int]] = {}
    doc_type_counts: dict[str, int] = {}

    text_rows = [
        r
        for r in rows
        if r.status not in {
            "EMPTY_GT",
            "NO_GT_FOR_IMAGE",
            "PIPELINE_ERROR",
        }
    ]

    ok_rows = [
        r
        for r in text_rows
        if r.status in {"OK", "OK_SPACE_DIFF"}
    ]

    cer_values = [
        float(r.cer)
        for r in text_rows
        if r.cer is not None
    ]

    cer_loose_values = [
        float(r.cer_loose)
        for r in text_rows
        if r.cer_loose is not None
    ]

    for r in rows:
        status_counts[r.status] = status_counts.get(r.status, 0) + 1

        if r.doc_type:
            doc_type_counts[r.doc_type] = doc_type_counts.get(r.doc_type, 0) + 1

        field_counts.setdefault(r.field, {})
        field_counts[r.field][r.status] = field_counts[r.field].get(r.status, 0) + 1

    by_field_metrics: dict[str, Any] = {}

    for field_name in sorted({r.field for r in text_rows}):
        field_rows = [r for r in text_rows if r.field == field_name]
        field_ok = [r for r in field_rows if r.status in {"OK", "OK_SPACE_DIFF"}]
        field_cer = [float(r.cer) for r in field_rows if r.cer is not None]
        field_cer_loose = [
            float(r.cer_loose)
            for r in field_rows
            if r.cer_loose is not None
        ]

        by_field_metrics[field_name] = {
            "rows": len(field_rows),
            "ok_or_space_accuracy": len(field_ok) / len(field_rows) if field_rows else 0.0,
            "avg_cer": sum(field_cer) / len(field_cer) if field_cer else None,
            "avg_cer_loose": (
                sum(field_cer_loose) / len(field_cer_loose)
                if field_cer_loose
                else None
            ),
        }

    return {
        "total_rows": len(rows),
        "text_rows": len(text_rows),
        "ok_or_space_rows": len(ok_rows),
        "accuracy_ok_or_space": len(ok_rows) / len(text_rows) if text_rows else 0.0,
        "avg_cer": sum(cer_values) / len(cer_values) if cer_values else None,
        "avg_cer_loose": (
            sum(cer_loose_values) / len(cer_loose_values)
            if cer_loose_values
            else None
        ),
        "status_counts": dict(sorted(status_counts.items())),
        "doc_type_counts": dict(sorted(doc_type_counts.items())),
        "field_counts": {
            k: dict(sorted(v.items()))
            for k, v in sorted(field_counts.items())
        },
        "by_field_metrics": by_field_metrics,
    }


def write_csv(path: Path, rows: list[EvalRow]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    keys = [
        "image_name",
        "doc_index",
        "doc_type",
        "field",
        "expected",
        "predicted",
        "status",
        "cer",
        "cer_loose",
        "ocr_confidence",
        "recognizer",
    ]

    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=keys)
        writer.writeheader()

        for row in rows:
            writer.writerow(row.__dict__)


def write_jsonl(path: Path, items: list[Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    with path.open("w", encoding="utf-8") as f:
        for item in items:
            if hasattr(item, "__dict__"):
                obj = item.__dict__
            else:
                obj = item

            f.write(json.dumps(obj, ensure_ascii=False) + "\n")


def write_html_report(
    path: Path,
    rows: list[EvalRow],
    summary: dict[str, Any],
    max_rows: int = 2000,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    order = {
        "TEXT_MISMATCH": 0,
        "MISS_FIELD": 1,
        "NO_DOC_FOUND": 2,
        "PIPELINE_ERROR": 3,
        "OK_SPACE_DIFF": 4,
        "OK": 5,
    }

    shown = sorted(
        rows,
        key=lambda r: (
            order.get(r.status, 99),
            r.field,
            r.image_name,
        ),
    )[:max_rows]

    table_rows = []

    for r in shown:
        if r.status == "OK":
            color = "#e8ffe8"
        elif r.status == "OK_SPACE_DIFF":
            color = "#fff7dc"
        elif r.status in {"TEXT_MISMATCH", "MISS_FIELD", "NO_DOC_FOUND", "PIPELINE_ERROR"}:
            color = "#ffe8e8"
        else:
            color = "#f5f5f5"

        table_rows.append(
            f"""
            <tr style="background:{color}">
                <td>{html.escape(r.image_name)}</td>
                <td>{html.escape(str(r.doc_type))}</td>
                <td>{html.escape(str(r.doc_index))}</td>
                <td>{html.escape(r.field)}</td>
                <td>{html.escape(r.status)}</td>
                <td><b>{html.escape(r.expected)}</b></td>
                <td><b>{html.escape(r.predicted)}</b></td>
                <td>{"" if r.cer is None else f"{r.cer:.4f}"}</td>
                <td>{"" if r.cer_loose is None else f"{r.cer_loose:.4f}"}</td>
                <td>{"" if r.ocr_confidence is None else f"{r.ocr_confidence:.4f}"}</td>
                <td>{html.escape(str(r.recognizer))}</td>
            </tr>
            """
        )

    text = f"""
<!doctype html>
<html>
<head>
    <meta charset="utf-8">
    <title>Full pipeline OCR evaluation</title>
    <style>
        body {{
            font-family: Arial, sans-serif;
            margin: 24px;
            font-size: 14px;
        }}
        table {{
            border-collapse: collapse;
            width: 100%;
        }}
        th, td {{
            border: 1px solid #ccc;
            padding: 6px;
            vertical-align: top;
        }}
        th {{
            background: #eee;
            position: sticky;
            top: 0;
        }}
        pre {{
            background: #f5f5f5;
            padding: 12px;
            overflow: auto;
        }}
    </style>
</head>
<body>
    <h1>Full pipeline OCR evaluation</h1>

    <h2>Summary</h2>
    <pre>{html.escape(json.dumps(summary, ensure_ascii=False, indent=2))}</pre>

    <h2>Rows</h2>
    <table>
        <thead>
            <tr>
                <th>Image</th>
                <th>Doc type</th>
                <th>Doc index</th>
                <th>Field</th>
                <th>Status</th>
                <th>Expected</th>
                <th>Predicted</th>
                <th>CER</th>
                <th>CER loose</th>
                <th>OCR conf</th>
                <th>Recognizer</th>
            </tr>
        </thead>
        <tbody>
            {"".join(table_rows)}
        </tbody>
    </table>
</body>
</html>
"""

    path.write_text(text, encoding="utf-8")


# =============================================================================
# MAIN
# =============================================================================

def main() -> None:
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "--skip-export",
        action="store_true",
        help="Do not export model, only evaluate existing inference dir",
    )

    parser.add_argument(
        "--skip-eval",
        action="store_true",
        help="Only export model",
    )

    parser.add_argument(
        "--eval-images-dir",
        type=Path,
        default=EVAL_IMAGES_DIR,
    )

    parser.add_argument(
        "--unknown-dir",
        type=Path,
        default=UNKNOWN_IMAGES_DIR,
    )

    parser.add_argument(
        "--debug-app",
        action="store_true",
        help="Pass debug=True to app pipeline if supported",
    )

    parser.add_argument(
        "--disable-glm",
        action="store_true",
        default=True,
        help="Disable GLM fallback during evaluation, so OCR model is measured directly",
    )

    args = parser.parse_args()

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    out_dir = REPORT_ROOT / f"{timestamp}_passport_rec_exp_c_latin_low_lr_more_aug"
    out_dir.mkdir(parents=True, exist_ok=True)

    print("Output dir:", out_dir)

    if not args.skip_export:
        export_passport_model(force=True)
    else:
        validate_inference_dir(PASSPORT_INFERENCE_DIR)

    if args.skip_eval:
        print("Skip eval requested.")
        return

    print()
    print("=" * 100)
    print("LOAD GT")
    print("=" * 100)

    gt_by_image = load_gt_from_cvat()
    print("GT images:", len(gt_by_image))

    print()
    print("=" * 100)
    print("LOAD APP WITH NEW OCR MODEL")
    print("=" * 100)
    print("Passport OCR:", PASSPORT_INFERENCE_DIR)
    print("Migration OCR:", MIGRATION_INFERENCE_DIR)

    app_module = import_app_with_new_model(
        passport_inference_dir=PASSPORT_INFERENCE_DIR,
        migration_inference_dir=MIGRATION_INFERENCE_DIR,
        disable_glm=args.disable_glm,
    )

    print()
    print("=" * 100)
    print("EVALUATE KNOWN VALIDATION IMAGES")
    print("=" * 100)

    image_paths = collect_eval_images(args.eval_images_dir)
    print("Eval images:", len(image_paths))

    rows, details = evaluate_known_images(
        app_module=app_module,
        image_paths=image_paths,
        gt_by_image=gt_by_image,
        out_dir=out_dir,
        debug=args.debug_app,
    )

    summary = build_summary(rows)

    write_csv(out_dir / "metrics.csv", rows)
    write_jsonl(out_dir / "details.jsonl", details)
    write_jsonl(out_dir / "rows.jsonl", rows)

    (out_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    write_html_report(
        out_dir / "report.html",
        rows,
        summary,
    )

    unknown_results = evaluate_unknown_images(
        app_module=app_module,
        unknown_dir=args.unknown_dir,
        out_dir=out_dir,
        debug=args.debug_app,
    )

    if unknown_results:
        (out_dir / "unknown_predictions.json").write_text(
            json.dumps(unknown_results, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    print()
    print("=" * 100)
    print("DONE")
    print("=" * 100)
    print("Summary:", out_dir / "summary.json")
    print("CSV:", out_dir / "metrics.csv")
    print("HTML:", out_dir / "report.html")
    print()
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
