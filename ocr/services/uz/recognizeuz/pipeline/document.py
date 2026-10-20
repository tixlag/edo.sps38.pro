from __future__ import annotations

from typing import Any

from recognizeuz.core.config import ALLOWED_DOC_TYPES, OCR_IMPROVE_ALLOWED_DOC_TYPES
from recognizeuz.documents.registry import maybe_get_document_spec
from recognizeuz.image.geometry import warp_document_by_polygon
from recognizeuz.inference.orientation import choose_best_document_orientation_for_spec
from recognizeuz.pipeline.fallbacks import apply_fallbacks_and_datasets
from recognizeuz.pipeline.field import recognize_document_fields
from recognizeuz.pipeline.output import build_output_document
from recognizeuz.pipeline.types import DocumentContext, PageContext


def process_detected_document(
    *,
    page: PageContext,
    doc: dict[str, Any],
    doc_index: int,
) -> dict[str, Any] | None:
    doc_type = doc["type"]

    if page.options.ocr_improve and doc_type not in OCR_IMPROVE_ALLOWED_DOC_TYPES:
        return None

    if doc_type not in ALLOWED_DOC_TYPES:
        return None

    spec = maybe_get_document_spec(doc_type)
    if spec is None:
        return None

    with page.profiler.stage("document.warp", doc_type=doc_type, document_index=doc_index):
        base_doc_crop, _ = warp_document_by_polygon(
            image_bgr=page.image_bgr,
            polygon=doc["polygon"],
        )
        page.segment_dump.save_image(
            stage="document.warp_crop",
            image_bgr=base_doc_crop,
            meta={
                "doc_type": doc_type,
                "document_index": doc_index,
                "confidence": float(doc["confidence"]),
                "bbox": doc.get("bbox"),
                "polygon": doc.get("polygon"),
                "passed_to": ["orientation", "field_detector"],
            },
            name_parts=[page.file_index, page.page_index, doc_index, doc_type],
        )

    with page.profiler.stage("document.orientation", doc_type=doc_type, document_index=doc_index):
        oriented_doc_crop, fields, rotation, orientation_score, orientation_timing = (
            choose_best_document_orientation_for_spec(
                spec=spec,
                base_crop_bgr=base_doc_crop,
                segment_dump=page.segment_dump,
                dump_meta={
                    "source_file": page.source_file,
                    "file_index": page.file_index,
                    "page_index": page.page_index,
                    "document_index": doc_index,
                    "doc_type": doc_type,
                },
            )
        )

    page.segment_dump.save_image(
        stage="document.oriented_best",
        image_bgr=oriented_doc_crop,
        meta={
            "doc_type": doc_type,
            "document_index": doc_index,
            "rotation": int(rotation),
            "orientation_score": float(orientation_score),
            "passed_to": ["field_ocr", "glm_document_fallback"],
        },
        name_parts=[page.file_index, page.page_index, doc_index, doc_type, f"rot{rotation}"],
    )

    orientation_confident = spec.is_orientation_confident(
        fields=fields,
        score=float(orientation_score),
        image_shape=oriented_doc_crop.shape,
    )

    # Старое поведение: если ориентация/набор полей неуверенные — документ не отдаём.
    if not orientation_confident:
        print("Пропускаем страницу")
        return None

    ctx = DocumentContext(
        page=page,
        spec=spec,
        doc=doc,
        doc_index=doc_index,
        base_doc_crop=base_doc_crop,
        oriented_doc_crop=oriented_doc_crop,
        fields=fields,
        rotation=rotation,
        orientation_score=orientation_score,
        orientation_confident=orientation_confident,
        orientation_timing=orientation_timing,
    )

    recognize_document_fields(ctx)
    apply_fallbacks_and_datasets(ctx)
    return build_output_document(ctx)
