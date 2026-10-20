from __future__ import annotations

import time
from typing import Any

import numpy as np

from recognizeuz.core.config import OCR_IMPROVE_ALLOWED_DOC_TYPES
from recognizeuz.image.geometry import crop_field_polygon_masked
from recognizeuz.image.preprocessing import build_ocr_improve_prepared_variants
from recognizeuz.ocr.paddle import recognize_field_text
from recognizeuz.pipeline.intermediate import apply_intermediate_field_stages
from recognizeuz.pipeline.types import DocumentContext
from recognizeuz.quality.verification import build_ocr_quality_report
from recognizeuz.utils.timing import elapsed_seconds, score_to_unit


def recognize_document_fields(ctx: DocumentContext) -> None:
    for field in ctx.fields:
        field_name = field["name"]

        # MRZ не распознаём и не отдаём наружу, но он может участвовать
        # в выборе ориентации внутри score_layout().
        if ctx.spec.is_internal_field(field_name):
            continue

        item = recognize_single_field(ctx=ctx, field=field)
        ctx.recognized_fields.append(item)

    scores = [float(item["paddle_score"]) for item in ctx.ocr_candidates]
    ctx.avg_paddle_score = float(np.mean(scores)) if scores else 0.0


def recognize_single_field(
    *,
    ctx: DocumentContext,
    field: dict[str, Any],
) -> dict[str, Any]:
    field_name = field["name"]

    with ctx.page.profiler.stage(
        "field.crop",
        doc_type=ctx.doc_type,
        field_name=field_name,
    ):
        crop_started = time.perf_counter()
        field_crop = crop_field_polygon_masked(ctx.oriented_doc_crop, field["polygon"])
        crop_seconds = elapsed_seconds(crop_started)
        ctx.page.segment_dump.save_image(
            stage="field.raw_crop",
            image_bgr=field_crop,
            meta={
                "doc_type": ctx.doc_type,
                "document_index": ctx.doc_index,
                "field_name": field_name,
                "field_confidence": float(field.get("confidence", 0.0)),
                "bbox": field.get("bbox"),
                "polygon": field.get("polygon"),
                "passed_to": ["ocr_preprocess", "intermediate_stages"],
            },
            name_parts=[ctx.page.file_index, ctx.page.page_index, ctx.doc_index, field_name, "raw"],
        )

    prepared_variants: list[dict[str, Any]] = []
    prepared_field_crop: np.ndarray | None = None
    augment_preprocess_seconds = 0.0

    if (
        ctx.page.options.ocr_improve
        and ctx.doc_type in OCR_IMPROVE_ALLOWED_DOC_TYPES
        and not ctx.spec.should_skip_ocr(field_name)
    ):
        with ctx.page.profiler.stage(
            "field.ocr_improve_prepare",
            doc_type=ctx.doc_type,
            field_name=field_name,
        ):
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

    with ctx.page.profiler.stage(
        "field.paddle_ocr",
        doc_type=ctx.doc_type,
        field_name=field_name,
    ):
        text, ocr_conf, ocr_timings, prepared_field_crop = recognize_field_text(
            doc_type=ctx.doc_type,
            field_name=field_name,
            field_crop_bgr=field_crop,
            prepared_image_bgr=prepared_field_crop,
        )
    ocr_conf = score_to_unit(float(ocr_conf))

    if prepared_field_crop is not None:
        ctx.page.segment_dump.save_image(
            stage="field.prepared_for_paddle",
            image_bgr=prepared_field_crop,
            meta={
                "doc_type": ctx.doc_type,
                "document_index": ctx.doc_index,
                "field_name": field_name,
                "paddle_text": text,
                "paddle_score": float(ocr_conf),
                "passed_to": ["paddle_recognizer", "glm_ocr_improve_if_enabled"],
            },
            name_parts=[ctx.page.file_index, ctx.page.page_index, ctx.doc_index, field_name, "prepared"],
        )

    if ctx.page.options.ocr_improve and not prepared_variants and prepared_field_crop is not None:
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

    item = {
        "field": field,
        "field_name": field_name,
        "field_crop": field_crop,
        "field_crop_prepared": prepared_field_crop,
        "field_crop_prepared_variants": prepared_variants,
        "paddle_text": text,
        "paddle_score": ocr_conf,
        "final_text": text,
        "source": "paddle" if not ctx.spec.should_skip_ocr(field_name) else "skipped",
        "glm_text": None,
        "glm_error": None,
        "dataset_sample": None,
        "ocr_improve_sample": None,
        "quality": build_ocr_quality_report(
            doc_type=ctx.doc_type,
            field_name=field_name,
            text=text,
            paddle_score=ocr_conf,
        ),
        "tta": None,
        "intermediate": [],
        "timing": {
            "yolo_seconds": float(field.get("timing", {}).get("yolo_seconds", 0.0)),
            "yolo_scope": field.get("timing", {}).get("yolo_scope"),
            "preprocess_seconds": preprocess_seconds,
            "crop_seconds": crop_seconds,
            "ocr_preprocess_seconds": float(ocr_timings.get("ocr_preprocess_seconds", 0.0)),
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

    with ctx.page.profiler.stage(
        "field.intermediate_stages",
        doc_type=ctx.doc_type,
        field_name=field_name,
        stages=[stage.key for stage in ctx.spec.enabled_intermediate_stages_for_field(field_name)],
    ):
        apply_intermediate_field_stages(
            spec=ctx.spec,
            ctx=ctx,
            field_name=field_name,
            field_crop_bgr=field_crop,
            item=item,
        )

    return item
