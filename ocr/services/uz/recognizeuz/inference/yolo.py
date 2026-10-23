from __future__ import annotations

from typing import Any

import numpy as np
from ultralytics import YOLO

from recognizeuz.core import resources
from recognizeuz.core.config import ASSUME_PASSPORT_WHEN_DOCUMENTS_EMPTY, DEVICE, DOC_ALIASES, DOC_CONF, DOC_IMGSZ, FIELD_CONF, FIELDS_IMGSZ
from recognizeuz.documents.base import DocumentSpec
from recognizeuz.documents.registry import maybe_get_document_spec
from recognizeuz.image.geometry import bbox_from_polygon


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
        poly = np.array(polygon, dtype=np.float32)

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


def build_full_image_passport_document(image_bgr: np.ndarray) -> dict[str, Any]:
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
        "synthetic_document": True,
        "document_detection_fallback": "full_image_as_passport",
    }


def keep_best_field_per_class(fields: list[dict[str, Any]]) -> list[dict[str, Any]]:
    best: dict[str, dict[str, Any]] = {}

    for f in fields:
        name = f["name"]
        if name not in best or f["confidence"] > best[name]["confidence"]:
            best[name] = f

    return list(best.values())


def detect_documents(image_bgr: np.ndarray) -> list[dict[str, Any]]:
    model = resources.model_registry.get_yolo("doc_type")

    raw = yolo_predict_segments(
        model=model,
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

    docs.sort(key=lambda d: (d["bbox"][1], d["bbox"][0]))

    if not docs and ASSUME_PASSPORT_WHEN_DOCUMENTS_EMPTY:
        return [build_full_image_passport_document(image_bgr)]

    return docs


def detect_fields_for_spec(spec: DocumentSpec, doc_bgr: np.ndarray) -> list[dict[str, Any]]:
    model = resources.model_registry.get_yolo(spec.field_detector.key)

    raw = yolo_predict_segments(
        model=model,
        image_bgr=doc_bgr,
        imgsz=FIELDS_IMGSZ,
        conf=FIELD_CONF,
    )

    fields = []
    for item in raw:
        field_name = item["class_name"]
        if field_name not in spec.field_names:
            continue

        fields.append({**item, "name": field_name})

    return keep_best_field_per_class(fields)


def detect_fields(doc_type: str, doc_bgr: np.ndarray) -> list[dict[str, Any]]:
    # Backward-compatible wrapper.
    spec = maybe_get_document_spec(doc_type)
    if spec is None:
        return []
    return detect_fields_for_spec(spec, doc_bgr)
