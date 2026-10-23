from __future__ import annotations

import argparse
import csv
import html
import importlib
import json
import random
from collections import defaultdict
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from lxml import etree


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

SKIP_OCR_FIELDS = {"pas_photo"}

TRAIN_RATIO = 0.9
SPLIT_SEED = 42

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}
PDF_EXTS = {".pdf"}


def parse_points(points: str) -> np.ndarray:
    return np.array(
        [list(map(float, p.split(","))) for p in points.split(";")],
        dtype=np.float32,
    )


def get_attr(polygon_node, name: str, default: str = "") -> str:
    attr = polygon_node.find(f"./attribute[@name='{name}']")
    if attr is None or attr.text is None:
        return default
    return attr.text.strip()


def bbox_from_polygon(points: np.ndarray) -> list[float]:
    xs = points[:, 0]
    ys = points[:, 1]
    return [float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max())]


def polygon_center(points: np.ndarray) -> tuple[float, float]:
    return float(points[:, 0].mean()), float(points[:, 1].mean())


def point_in_polygon(point: tuple[float, float], polygon: np.ndarray) -> bool:
    return cv2.pointPolygonTest(polygon.astype(np.float32), point, False) >= 0


def bbox_iou(a: list[float], b: list[float]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b

    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)

    iw = max(0.0, ix2 - ix1)
    ih = max(0.0, iy2 - iy1)

    inter = iw * ih
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)

    denom = area_a + area_b - inter
    if denom <= 0:
        return 0.0

    return inter / denom


def safe_filename_part(text: str, max_len: int = 120) -> str:
    out = []
    for ch in text:
        if ch.isalnum() or ch in {"_", "-", "."}:
            out.append(ch)
        else:
            out.append("_")
    result = "".join(out).strip("_")
    return result[:max_len] if result else "sample"


def normalize_text(text: str) -> str:
    text = str(text).upper()
    text = text.replace("\t", " ")
    text = text.replace("\n", " ")
    text = " ".join(text.split())
    return text.strip()


def normalize_text_strict(text: str) -> str:
    return normalize_text(text).replace(" ", "")


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


def char_error_rate(expected: str, predicted: str) -> float:
    e = normalize_text(expected)
    p = normalize_text(predicted)

    if not e:
        return 0.0 if not p else 1.0

    return edit_distance(e, p) / max(1, len(e))


def find_image_path(images_dir: Path, name: str) -> Path:
    direct = images_dir / name
    if direct.exists():
        return direct

    found = list(images_dir.rglob(name))
    if found:
        return found[0]

    raise FileNotFoundError(name)


def cv2_write(path: Path, image_bgr: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(path), image_bgr)


def rel_to(path: Path, base: Path) -> str:
    try:
        return path.relative_to(base).as_posix()
    except ValueError:
        return path.as_posix()


def parse_cvat_image(image_node) -> dict[str, Any]:
    image_name = image_node.get("name")
    task_id = image_node.get("task_id", "unknown")
    image_id = int(image_node.get("id", "0"))
    frame_id = image_id % 50

    documents = []
    fields = []

    for polygon_node in image_node.findall("polygon"):
        label = polygon_node.get("label")
        points = parse_points(polygon_node.get("points"))

        if label in DOCUMENT_LABELS:
            doc_type = DOCUMENT_LABELS[label]
            documents.append(
                {
                    "label": label,
                    "type": doc_type,
                    "points": points,
                    "bbox": bbox_from_polygon(points),
                }
            )

        elif label in ALL_FIELD_LABELS:
            field_name = ALL_FIELD_LABELS[label]
            fields.append(
                {
                    "label": label,
                    "name": field_name,
                    "points": points,
                    "bbox": bbox_from_polygon(points),
                    "content": get_attr(polygon_node, "content", ""),
                    "line_index": get_attr(polygon_node, "line_index", "1"),
                }
            )

    return {
        "image_name": image_name,
        "task_id": task_id,
        "image_id": image_id,
        "frame_id": frame_id,
        "documents": documents,
        "fields": fields,
    }


def split_image_nodes(
    image_nodes: list[Any],
    split: str,
    train_ratio: float,
    seed: int,
) -> list[Any]:
    nodes = list(image_nodes)
    random.seed(seed)
    random.shuffle(nodes)

    split_index = int(len(nodes) * train_ratio)

    if split == "train":
        return nodes[:split_index]

    if split == "val":
        return nodes[split_index:]

    if split == "all":
        return nodes

    raise ValueError(f"Unsupported split: {split}")


def gt_fields_for_document(
    gt_doc: dict[str, Any],
    all_fields: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    doc_type = gt_doc["type"]

    if doc_type == "passport":
        allowed = set(PASSPORT_FIELDS.values())
    elif doc_type == "migration_card":
        allowed = set(MIGRATION_FIELDS.values())
    else:
        allowed = set()

    result = {}

    for field in all_fields:
        if field["name"] not in allowed:
            continue

        if not point_in_polygon(polygon_center(field["points"]), gt_doc["points"]):
            continue

        result.setdefault(field["name"], field)

    return result


def match_documents(
    gt_docs: list[dict[str, Any]],
    pred_docs: list[dict[str, Any]],
    min_iou: float,
) -> tuple[list[tuple[int, int, float]], list[int], list[int]]:
    matches = []
    used_pred = set()

    for gt_idx, gt in enumerate(gt_docs):
        best_pred_idx = None
        best_iou = 0.0

        for pred_idx, pred in enumerate(pred_docs):
            if pred_idx in used_pred:
                continue

            if pred["type"] != gt["type"]:
                continue

            iou = bbox_iou(gt["bbox"], pred["bbox"])
            if iou > best_iou:
                best_iou = iou
                best_pred_idx = pred_idx

        if best_pred_idx is not None and best_iou >= min_iou:
            matches.append((gt_idx, best_pred_idx, best_iou))
            used_pred.add(best_pred_idx)

    matched_gt = {m[0] for m in matches}
    matched_pred = {m[1] for m in matches}

    missed_gt = [i for i in range(len(gt_docs)) if i not in matched_gt]
    extra_pred = [i for i in range(len(pred_docs)) if i not in matched_pred]

    return matches, missed_gt, extra_pred


def draw_poly(
    image: np.ndarray,
    polygon: np.ndarray,
    color: tuple[int, int, int],
    text: str | None = None,
    thickness: int = 2,
) -> None:
    pts = polygon.astype(np.int32)

    cv2.polylines(image, [pts], isClosed=True, color=color, thickness=thickness)

    overlay = image.copy()
    cv2.fillPoly(overlay, [pts], color=color)
    cv2.addWeighted(overlay, 0.10, image, 0.90, 0, image)

    if not text:
        return

    x = int(pts[:, 0].min())
    y = max(18, int(pts[:, 1].min()))

    font = cv2.FONT_HERSHEY_SIMPLEX
    scale = 0.55
    thick = 2

    size, _ = cv2.getTextSize(text, font, scale, thick)
    tw, th = size

    cv2.rectangle(image, (x, y - th - 8), (x + tw + 8, y + 4), (0, 0, 0), -1)
    cv2.putText(
        image,
        text,
        (x + 4, y - 4),
        font,
        scale,
        (255, 255, 255),
        thick,
        cv2.LINE_AA,
    )


def make_original_overlay(
    image_bgr: np.ndarray,
    gt_docs: list[dict[str, Any]] | None,
    pred_docs: list[dict[str, Any]],
) -> np.ndarray:
    out = image_bgr.copy()

    if gt_docs:
        for idx, doc in enumerate(gt_docs):
            draw_poly(out, doc["points"], (0, 180, 255), f"GT {idx} {doc['type']}", 2)

    for idx, doc in enumerate(pred_docs):
        draw_poly(
            out,
            doc["polygon"],
            (0, 255, 0),
            f"PRED {idx} {doc['type']} {doc['confidence']:.2f}",
            2,
        )

    return out


def make_doc_overlay(
    doc_bgr: np.ndarray,
    pred_fields: list[dict[str, Any]],
    expected_by_name: dict[str, dict[str, Any]] | None,
    recognized_by_name: dict[str, dict[str, Any]],
) -> np.ndarray:
    out = doc_bgr.copy()
    expected_by_name = expected_by_name or {}

    for field in pred_fields:
        name = field["name"]
        expected = expected_by_name.get(name, {}).get("content", "")
        predicted = recognized_by_name.get(name, {}).get("predicted", "")

        if expected_by_name:
            color = (0, 255, 0) if name in expected_by_name else (0, 0, 255)
        else:
            color = (255, 180, 0)

        label = f"{name}"
        if expected or predicted:
            label += f" | GT:{expected} | OCR:{predicted}"

        draw_poly(out, field["polygon"], color, label, 2)

    return out


def load_pipeline(module_name: str):
    pipeline = importlib.import_module(module_name)
    pipeline.load_models()
    return pipeline


def unload_pipeline(pipeline) -> None:
    if hasattr(pipeline, "cleanup_models"):
        pipeline.cleanup_models()


def evaluate_known_image(
    *,
    pipeline,
    image_bgr: np.ndarray,
    gt: dict[str, Any],
    out_dir: Path,
    min_doc_iou: float,
) -> list[dict[str, Any]]:
    rows = []

    image_name = gt["image_name"]
    task_id = gt["task_id"]
    frame_id = gt["frame_id"]

    stem = safe_filename_part(Path(image_name).stem)
    prefix = f"val_task_{task_id}_frame_{frame_id}_{stem}"

    pred_docs = pipeline.detect_documents(image_bgr)
    gt_docs = gt["documents"]

    original_overlay = make_original_overlay(image_bgr, gt_docs, pred_docs)
    original_overlay_path = out_dir / "overlays" / "original" / f"{prefix}.jpg"
    cv2_write(original_overlay_path, original_overlay)
    original_overlay_rel = rel_to(original_overlay_path, out_dir)

    matches, missed_gt, extra_pred = match_documents(gt_docs, pred_docs, min_doc_iou)

    for gt_idx in missed_gt:
        gt_doc = gt_docs[gt_idx]
        rows.append(
            {
                "dataset": "validation",
                "status": "MISS_DOC",
                "task_id": task_id,
                "frame_id": frame_id,
                "image": image_name,
                "doc_type": gt_doc["type"],
                "field": "",
                "expected": "",
                "predicted": "",
                "det_conf": "",
                "ocr_conf": "",
                "cer": "",
                "field_crop_rel": "",
                "field_prepared_rel": "",
                "doc_overlay_rel": "",
                "original_overlay_rel": original_overlay_rel,
            }
        )

    for pred_idx in extra_pred:
        pred_doc = pred_docs[pred_idx]
        rows.append(
            {
                "dataset": "validation",
                "status": "EXTRA_PRED_DOC",
                "task_id": task_id,
                "frame_id": frame_id,
                "image": image_name,
                "doc_type": pred_doc["type"],
                "field": "",
                "expected": "",
                "predicted": "",
                "det_conf": f"{pred_doc['confidence']:.4f}",
                "ocr_conf": "",
                "cer": "",
                "field_crop_rel": "",
                "field_prepared_rel": "",
                "doc_overlay_rel": "",
                "original_overlay_rel": original_overlay_rel,
            }
        )

    for gt_idx, pred_idx, doc_iou in matches:
        gt_doc = gt_docs[gt_idx]
        pred_doc = pred_docs[pred_idx]
        doc_type = gt_doc["type"]

        gt_fields = gt_fields_for_document(gt_doc, gt["fields"])

        base_doc_crop, _ = pipeline.warp_document_by_polygon(image_bgr, pred_doc["polygon"])
        oriented_doc_crop, pred_fields, rotation, orientation_score = (
            pipeline.choose_best_document_orientation(doc_type, base_doc_crop)
        )

        pred_fields_by_name = {f["name"]: f for f in pred_fields}
        recognized_by_name = {}

        doc_dir_name = f"{prefix}__{doc_type}__gt_{gt_idx}__pred_{pred_idx}"

        doc_crop_path = out_dir / "docs" / f"{doc_dir_name}.jpg"
        cv2_write(doc_crop_path, oriented_doc_crop)

        for field_name, pred_field in pred_fields_by_name.items():
            field_crop = pipeline.crop_field_polygon_masked(oriented_doc_crop, pred_field["polygon"])

            field_crop_path = (
                out_dir / "fields" / "validation" / doc_type / field_name / f"{doc_dir_name}__{field_name}__raw.jpg"
            )
            cv2_write(field_crop_path, field_crop)

            prepared = pipeline.prepare_ocr_image_array(field_crop)

            field_prepared_path = (
                out_dir / "fields_prepared" / "validation" / doc_type / field_name / f"{doc_dir_name}__{field_name}__prepared.png"
            )
            cv2_write(field_prepared_path, prepared)

            if field_name in SKIP_OCR_FIELDS:
                predicted = ""
                ocr_conf = 0.0
            else:
                predicted, ocr_conf = pipeline.recognize_field_text(doc_type, field_name, field_crop)

            recognized_by_name[field_name] = {
                "predicted": predicted,
                "ocr_conf": float(ocr_conf),
                "field_crop_rel": rel_to(field_crop_path, out_dir),
                "field_prepared_rel": rel_to(field_prepared_path, out_dir),
            }

        doc_overlay = make_doc_overlay(oriented_doc_crop, pred_fields, gt_fields, recognized_by_name)
        doc_overlay_path = out_dir / "overlays" / "docs" / f"{doc_dir_name}.jpg"
        cv2_write(doc_overlay_path, doc_overlay)
        doc_overlay_rel = rel_to(doc_overlay_path, out_dir)

        all_field_names = sorted(set(gt_fields.keys()) | set(pred_fields_by_name.keys()))

        for field_name in all_field_names:
            expected_item = gt_fields.get(field_name)
            pred_field = pred_fields_by_name.get(field_name)
            rec = recognized_by_name.get(field_name, {})

            expected = expected_item.get("content", "") if expected_item else ""
            predicted = rec.get("predicted", "")

            if expected_item is None:
                status = "EXTRA_PRED_FIELD"
            elif pred_field is None:
                status = "MISS_FIELD"
            elif field_name in SKIP_OCR_FIELDS:
                status = "SKIPPED_PHOTO"
            elif not normalize_text(expected):
                status = "EMPTY_GT"
            elif normalize_text(expected) == normalize_text(predicted):
                status = "OK"
            elif normalize_text_strict(expected) == normalize_text_strict(predicted):
                status = "OK_SPACE_DIFF"
            else:
                status = "TEXT_MISMATCH"

            cer = ""
            if expected_item is not None and field_name not in SKIP_OCR_FIELDS and normalize_text(expected):
                cer = f"{char_error_rate(expected, predicted):.4f}"

            rows.append(
                {
                    "dataset": "validation",
                    "status": status,
                    "task_id": task_id,
                    "frame_id": frame_id,
                    "image": image_name,
                    "doc_type": doc_type,
                    "gt_doc_index": gt_idx,
                    "pred_doc_index": pred_idx,
                    "doc_iou": f"{doc_iou:.4f}",
                    "rotation": rotation,
                    "orientation_score": f"{orientation_score:.4f}",
                    "field": field_name,
                    "expected": expected,
                    "predicted": predicted,
                    "det_conf": f"{float(pred_field['confidence']):.4f}" if pred_field else "",
                    "ocr_conf": f"{float(rec.get('ocr_conf', 0.0)):.4f}" if rec else "",
                    "cer": cer,
                    "field_crop_rel": rec.get("field_crop_rel", ""),
                    "field_prepared_rel": rec.get("field_prepared_rel", ""),
                    "doc_overlay_rel": doc_overlay_rel,
                    "original_overlay_rel": original_overlay_rel,
                }
            )

    return rows


def evaluate_unknown_page(
    *,
    pipeline,
    image_bgr: np.ndarray,
    source_name: str,
    file_index: int,
    page_index: int,
    out_dir: Path,
) -> list[dict[str, Any]]:
    rows = []

    stem = safe_filename_part(Path(source_name).stem)
    prefix = f"unknown_file_{file_index}_page_{page_index}_{stem}"

    pred_docs = pipeline.detect_documents(image_bgr)

    original_overlay = make_original_overlay(image_bgr, None, pred_docs)
    original_overlay_path = out_dir / "overlays" / "unknown_original" / f"{prefix}.jpg"
    cv2_write(original_overlay_path, original_overlay)
    original_overlay_rel = rel_to(original_overlay_path, out_dir)

    if not pred_docs:
        rows.append(
            {
                "dataset": "unknown",
                "status": "NO_DOC_FOUND",
                "task_id": "",
                "frame_id": "",
                "image": source_name,
                "page_index": page_index,
                "doc_type": "",
                "field": "",
                "expected": "",
                "predicted": "",
                "det_conf": "",
                "ocr_conf": "",
                "cer": "",
                "field_crop_rel": "",
                "field_prepared_rel": "",
                "doc_overlay_rel": "",
                "original_overlay_rel": original_overlay_rel,
            }
        )
        return rows

    for doc_index, pred_doc in enumerate(pred_docs):
        doc_type = pred_doc["type"]

        base_doc_crop, _ = pipeline.warp_document_by_polygon(image_bgr, pred_doc["polygon"])
        oriented_doc_crop, pred_fields, rotation, orientation_score = (
            pipeline.choose_best_document_orientation(doc_type, base_doc_crop)
        )

        doc_dir_name = f"{prefix}__{doc_type}__pred_{doc_index}"

        doc_crop_path = out_dir / "unknown_docs" / f"{doc_dir_name}.jpg"
        cv2_write(doc_crop_path, oriented_doc_crop)

        recognized_by_name = {}

        for pred_field in pred_fields:
            field_name = pred_field["name"]
            field_crop = pipeline.crop_field_polygon_masked(oriented_doc_crop, pred_field["polygon"])

            field_crop_path = (
                out_dir / "fields" / "unknown" / doc_type / field_name / f"{doc_dir_name}__{field_name}__raw.jpg"
            )
            cv2_write(field_crop_path, field_crop)

            prepared = pipeline.prepare_ocr_image_array(field_crop)

            field_prepared_path = (
                out_dir / "fields_prepared" / "unknown" / doc_type / field_name / f"{doc_dir_name}__{field_name}__prepared.png"
            )
            cv2_write(field_prepared_path, prepared)

            if field_name in SKIP_OCR_FIELDS:
                predicted = ""
                ocr_conf = 0.0
            else:
                predicted, ocr_conf = pipeline.recognize_field_text(doc_type, field_name, field_crop)

            recognized_by_name[field_name] = {
                "predicted": predicted,
                "ocr_conf": float(ocr_conf),
                "field_crop_rel": rel_to(field_crop_path, out_dir),
                "field_prepared_rel": rel_to(field_prepared_path, out_dir),
            }

            rows.append(
                {
                    "dataset": "unknown",
                    "status": "UNKNOWN_PRED_FIELD",
                    "task_id": "",
                    "frame_id": "",
                    "image": source_name,
                    "page_index": page_index,
                    "doc_type": doc_type,
                    "pred_doc_index": doc_index,
                    "doc_conf": f"{float(pred_doc['confidence']):.4f}",
                    "rotation": rotation,
                    "orientation_score": f"{orientation_score:.4f}",
                    "field": field_name,
                    "expected": "",
                    "predicted": predicted,
                    "det_conf": f"{float(pred_field['confidence']):.4f}",
                    "ocr_conf": f"{float(ocr_conf):.4f}",
                    "cer": "",
                    "field_crop_rel": rel_to(field_crop_path, out_dir),
                    "field_prepared_rel": rel_to(field_prepared_path, out_dir),
                    "doc_overlay_rel": "",
                    "original_overlay_rel": original_overlay_rel,
                }
            )

        doc_overlay = make_doc_overlay(oriented_doc_crop, pred_fields, None, recognized_by_name)
        doc_overlay_path = out_dir / "overlays" / "unknown_docs" / f"{doc_dir_name}.jpg"
        cv2_write(doc_overlay_path, doc_overlay)
        doc_overlay_rel = rel_to(doc_overlay_path, out_dir)

        for r in rows:
            if (
                r.get("dataset") == "unknown"
                and r.get("image") == source_name
                and r.get("page_index") == page_index
                and r.get("pred_doc_index") == doc_index
                and not r.get("doc_overlay_rel")
            ):
                r["doc_overlay_rel"] = doc_overlay_rel

    return rows


def iter_unknown_files(unknown_dir: Path) -> list[Path]:
    if not unknown_dir or not unknown_dir.exists():
        return []

    files = []
    for p in sorted(unknown_dir.rglob("*")):
        if not p.is_file():
            continue
        if p.suffix.lower() in IMAGE_EXTS | PDF_EXTS:
            files.append(p)

    return files


def process_unknown_dir(
    *,
    pipeline,
    unknown_dir: Path,
    out_dir: Path,
    limit: int,
) -> list[dict[str, Any]]:
    rows = []
    files = iter_unknown_files(unknown_dir)

    if limit > 0:
        files = files[:limit]

    for file_index, path in enumerate(files):
        print(f"[unknown {file_index + 1}/{len(files)}] {path}")

        data = path.read_bytes()
        pages = pipeline.load_pages_from_upload(data, path.name, None)

        for page_index, page_bgr in enumerate(pages):
            rows.extend(
                evaluate_unknown_page(
                    pipeline=pipeline,
                    image_bgr=page_bgr,
                    source_name=path.relative_to(unknown_dir).as_posix(),
                    file_index=file_index,
                    page_index=page_index,
                    out_dir=out_dir,
                )
            )

    return rows


def build_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    status_counts = defaultdict(int)
    field_counts = defaultdict(lambda: defaultdict(int))
    dataset_counts = defaultdict(int)
    cer_values = []

    for r in rows:
        status = r.get("status", "")
        field = r.get("field", "")
        dataset = r.get("dataset", "")

        status_counts[status] += 1
        dataset_counts[dataset] += 1

        if field:
            field_counts[field][status] += 1

        if r.get("cer") not in {"", None}:
            try:
                cer_values.append(float(r["cer"]))
            except ValueError:
                pass

    validation_text_rows = [
        r for r in rows
        if r.get("dataset") == "validation"
        and r.get("field")
        and r.get("status") not in {"SKIPPED_PHOTO", "EMPTY_GT", "EXTRA_PRED_FIELD", "MISS_FIELD"}
    ]

    ok_like = sum(1 for r in validation_text_rows if r.get("status") in {"OK", "OK_SPACE_DIFF"})

    return {
        "total_rows": len(rows),
        "dataset_counts": dict(sorted(dataset_counts.items())),
        "status_counts": dict(sorted(status_counts.items())),
        "validation_text_rows": len(validation_text_rows),
        "validation_text_accuracy_ok_or_space_diff": ok_like / len(validation_text_rows) if validation_text_rows else 0.0,
        "validation_avg_cer": float(np.mean(cer_values)) if cer_values else None,
        "field_counts": {
            field: dict(sorted(counts.items()))
            for field, counts in sorted(field_counts.items())
        },
    }


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    preferred = [
        "dataset",
        "status",
        "task_id",
        "frame_id",
        "image",
        "page_index",
        "doc_type",
        "gt_doc_index",
        "pred_doc_index",
        "doc_iou",
        "doc_conf",
        "rotation",
        "orientation_score",
        "field",
        "expected",
        "predicted",
        "det_conf",
        "ocr_conf",
        "cer",
        "field_crop_rel",
        "field_prepared_rel",
        "doc_overlay_rel",
        "original_overlay_rel",
    ]

    keys = []
    for k in preferred:
        if any(k in r for r in rows):
            keys.append(k)

    for r in rows:
        for k in r.keys():
            if k not in keys:
                keys.append(k)

    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=keys)
        writer.writeheader()
        writer.writerows(rows)


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def write_html_report(out_dir: Path, summary: dict[str, Any], rows: list[dict[str, Any]], max_rows: int) -> None:
    def img_tag(path: str | None, width: int = 220) -> str:
        if not path:
            return ""
        return f'<a href="{html.escape(path)}" target="_blank"><img src="{html.escape(path)}" width="{width}"></a>'

    error_rows = [
        r for r in rows
        if r.get("dataset") == "validation"
        and r.get("status") not in {"OK", "OK_SPACE_DIFF", "EMPTY_GT", "SKIPPED_PHOTO"}
    ]

    unknown_rows = [r for r in rows if r.get("dataset") == "unknown"]

    ok_rows = [
        r for r in rows
        if r.get("dataset") == "validation"
        and r.get("status") in {"OK", "OK_SPACE_DIFF", "EMPTY_GT", "SKIPPED_PHOTO"}
    ]

    shown = (error_rows + unknown_rows + ok_rows)[:max_rows]

    html_rows = []

    for r in shown:
        status = r.get("status", "")

        if r.get("dataset") == "unknown":
            color = "#eef3ff"
        elif status in {"OK", "OK_SPACE_DIFF"}:
            color = "#e8ffe8"
        elif status in {"EMPTY_GT", "SKIPPED_PHOTO"}:
            color = "#f5f5f5"
        else:
            color = "#ffe8e8"

        html_rows.append(
            f"""
            <tr style="background:{color}">
                <td>{html.escape(str(r.get("dataset", "")))}</td>
                <td>{html.escape(str(r.get("status", "")))}</td>
                <td>{html.escape(str(r.get("task_id", "")))}</td>
                <td>{html.escape(str(r.get("frame_id", "")))}</td>
                <td>{html.escape(str(r.get("image", "")))}</td>
                <td>{html.escape(str(r.get("doc_type", "")))}</td>
                <td>{html.escape(str(r.get("field", "")))}</td>
                <td><b>{html.escape(str(r.get("expected", "")))}</b></td>
                <td><b>{html.escape(str(r.get("predicted", "")))}</b></td>
                <td>{html.escape(str(r.get("ocr_conf", "")))}</td>
                <td>{html.escape(str(r.get("det_conf", "")))}</td>
                <td>{html.escape(str(r.get("cer", "")))}</td>
                <td>{img_tag(r.get("field_crop_rel"), 180)}</td>
                <td>{img_tag(r.get("field_prepared_rel"), 180)}</td>
                <td>{img_tag(r.get("doc_overlay_rel"), 260)}</td>
                <td>{img_tag(r.get("original_overlay_rel"), 260)}</td>
            </tr>
            """
        )

    text = f"""
    <!doctype html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>RecognizeUZ Validation + Unknown Evaluation</title>
        <style>
            body {{
                font-family: Arial, sans-serif;
                font-size: 14px;
                margin: 24px;
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
            code {{
                background: #f5f5f5;
                padding: 2px 4px;
            }}
        </style>
    </head>
    <body>
        <h1>RecognizeUZ Validation + Unknown Evaluation</h1>

        <h2>Summary</h2>
        <pre>{html.escape(json.dumps(summary, ensure_ascii=False, indent=2))}</pre>

        <p>
            Порядок строк: сначала ошибки validation, потом unknown samples, потом OK из validation.
            Полные данные: <code>metrics.csv</code>, <code>details.jsonl</code>, <code>summary.json</code>.
        </p>

        <table>
            <thead>
                <tr>
                    <th>Dataset</th>
                    <th>Status</th>
                    <th>Task</th>
                    <th>Frame</th>
                    <th>Image</th>
                    <th>Doc</th>
                    <th>Field</th>
                    <th>Expected</th>
                    <th>Predicted</th>
                    <th>OCR conf</th>
                    <th>Det conf</th>
                    <th>CER</th>
                    <th>Field crop</th>
                    <th>OCR prepared</th>
                    <th>Doc overlay</th>
                    <th>Original overlay</th>
                </tr>
            </thead>
            <tbody>
                {"".join(html_rows)}
            </tbody>
        </table>
    </body>
    </html>
    """

    (out_dir / "report.html").write_text(text, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()

    parser.add_argument("--annotations", type=Path, default=Path("uz-annotaited-dataset/annotations.xml"))
    parser.add_argument("--images-dir", type=Path, default=Path("uz-annotaited-dataset/images"))
    parser.add_argument("--out-dir", type=Path, default=Path("quality_report2"))
    parser.add_argument("--pipeline-module", type=str, default="app")

    parser.add_argument("--split", type=str, default="val", choices=["val", "train", "all"])
    parser.add_argument("--train-ratio", type=float, default=TRAIN_RATIO)
    parser.add_argument("--split-seed", type=int, default=SPLIT_SEED)

    parser.add_argument("--limit", type=int, default=1, help="Limit annotated split images; 0 = all")
    parser.add_argument("--unknown-limit", type=int, default=0, help="Limit unknown files; 0 = all")

    parser.add_argument("--task-id", type=str, default="")
    parser.add_argument("--frame-id", type=int, default=-1)
    parser.add_argument("--min-doc-iou", type=float, default=0.30)
    parser.add_argument("--html-max-rows", type=int, default=1500)
    parser.add_argument("--unknown-dir", type=Path, default=Path('./for-test'))

    args = parser.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)

    print("Loading pipeline models...")
    pipeline = load_pipeline(args.pipeline_module)

    rows = []

    try:
        if args.annotations.exists():
            tree = etree.parse(str(args.annotations))
            image_nodes = tree.findall(".//image")

            selected_nodes = split_image_nodes(
                image_nodes,
                split=args.split,
                train_ratio=args.train_ratio,
                seed=args.split_seed,
            )

            print(
                f"Annotated images: total={len(image_nodes)}, "
                f"selected_split={args.split}, selected={len(selected_nodes)}"
            )

            processed = 0

            for image_node in selected_nodes:
                parsed = parse_cvat_image(image_node)

                if args.task_id and str(parsed["task_id"]) != str(args.task_id):
                    continue

                if args.frame_id >= 0 and int(parsed["frame_id"]) != int(args.frame_id):
                    continue

                image_name = parsed["image_name"]
                image_path = find_image_path(args.images_dir, image_name)
                image_bgr = cv2.imread(str(image_path))

                if image_bgr is None:
                    rows.append(
                        {
                            "dataset": "validation",
                            "status": "UNREADABLE_IMAGE",
                            "task_id": parsed["task_id"],
                            "frame_id": parsed["frame_id"],
                            "image": image_name,
                        }
                    )
                    continue

                print(
                    f"[validation {processed + 1}] "
                    f"task={parsed['task_id']} "
                    f"frame={parsed['frame_id']} "
                    f"image={image_name}"
                )

                rows.extend(
                    evaluate_known_image(
                        pipeline=pipeline,
                        image_bgr=image_bgr,
                        gt=parsed,
                        out_dir=args.out_dir,
                        min_doc_iou=args.min_doc_iou,
                    )
                )

                processed += 1

                if args.limit > 0 and processed >= args.limit:
                    break

        if args.unknown_dir and args.unknown_dir.exists():
            rows.extend(
                process_unknown_dir(
                    pipeline=pipeline,
                    unknown_dir=args.unknown_dir,
                    out_dir=args.out_dir,
                    limit=args.unknown_limit,
                )
            )
        else:
            print(f"Unknown dir not found, skipped: {args.unknown_dir}")

    finally:
        unload_pipeline(pipeline)

    summary = build_summary(rows)

    write_csv(args.out_dir / "metrics.csv", rows)
    write_jsonl(args.out_dir / "details.jsonl", rows)

    (args.out_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    write_html_report(args.out_dir, summary, rows, args.html_max_rows)

    print()
    print("Done")
    print(f"Rows: {len(rows)}")
    print(f"Report: {args.out_dir / 'report.html'}")
    print(f"CSV: {args.out_dir / 'metrics.csv'}")
    print(f"JSONL: {args.out_dir / 'details.jsonl'}")
    print()
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
