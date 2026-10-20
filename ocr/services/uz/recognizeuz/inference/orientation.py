from __future__ import annotations

import time
from typing import Any

import numpy as np

from recognizeuz.debug.segment_dump import SegmentDumpSession
from recognizeuz.documents.base import DocumentSpec
from recognizeuz.documents.registry import get_document_spec
from recognizeuz.image.geometry import rotate_image
from recognizeuz.inference.yolo import detect_fields_for_spec
from recognizeuz.utils.timing import elapsed_seconds


def is_orientation_confident(
    doc_type: str,
    fields: list[dict[str, Any]],
    score: float,
    image_shape: tuple[int, int, int],
) -> bool:
    spec = get_document_spec(doc_type)
    return spec.is_orientation_confident(fields, score, image_shape)


def choose_best_document_orientation_for_spec(
    spec: DocumentSpec,
    base_crop_bgr: np.ndarray,
    *,
    segment_dump: SegmentDumpSession | None = None,
    dump_meta: dict[str, Any] | None = None,
) -> tuple[np.ndarray, list[dict[str, Any]], int, float, dict[str, Any]]:
    orientation_started = time.perf_counter()
    candidates = []

    def evaluate_angle(angle: int) -> dict[str, Any]:
        candidate_started = time.perf_counter()
        rotated = rotate_image(base_crop_bgr, angle)

        if segment_dump is not None:
            segment_dump.save_image(
                stage="orientation.field_detector_input",
                image_bgr=rotated,
                meta={
                    **(dump_meta or {}),
                    "angle": angle,
                    "field_detector_key": spec.field_detector.key,
                    "passed_to": ["field_detector"],
                },
                name_parts=[
                    (dump_meta or {}).get("file_index"),
                    (dump_meta or {}).get("page_index"),
                    (dump_meta or {}).get("document_index"),
                    spec.doc_type,
                    f"angle{angle}",
                ],
            )

        yolo_started = time.perf_counter()
        fields = detect_fields_for_spec(spec, rotated)
        yolo_seconds = elapsed_seconds(yolo_started)

        if segment_dump is not None:
            segment_dump.add_event(
                stage="orientation.field_detector_output",
                meta={
                    **(dump_meta or {}),
                    "angle": angle,
                    "field_detector_key": spec.field_detector.key,
                    "fields_count": len(fields),
                    "fields": [
                        {
                            "name": field.get("name"),
                            "class_name": field.get("class_name"),
                            "confidence": float(field.get("confidence", 0.0)),
                            "bbox": field.get("bbox"),
                            "polygon": field.get("polygon"),
                        }
                        for field in fields
                    ],
                },
            )

        scoring_started = time.perf_counter()
        score = spec.score_layout(fields, rotated.shape)
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

    if spec.is_orientation_confident(
        fields=first["fields"],
        score=float(first["score"]),
        image_shape=first["image"].shape,
    ):
        best = first
    else:
        # 2. Самый вероятный плохой случай после warp — документ вверх ногами.
        second = evaluate_angle(180)
        candidates.append(second)

        if spec.is_orientation_confident(
            fields=second["fields"],
            score=float(second["score"]),
            image_shape=second["image"].shape,
        ):
            best = second
        else:
            for angle in [90, 270]:
                candidates.append(evaluate_angle(angle))

            best = max(candidates, key=lambda x: x["score"])

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


def choose_best_document_orientation(
    doc_type: str,
    base_crop_bgr: np.ndarray,
) -> tuple[np.ndarray, list[dict[str, Any]], int, float, dict[str, Any]]:
    # Backward-compatible wrapper.
    return choose_best_document_orientation_for_spec(
        get_document_spec(doc_type),
        base_crop_bgr,
    )
