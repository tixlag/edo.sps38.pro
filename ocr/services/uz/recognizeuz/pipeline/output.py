from __future__ import annotations

from typing import Any

from recognizeuz.core.config import (
    ASSUME_PASSPORT_WHEN_DOCUMENTS_EMPTY,
    GLM_FIELD_FALLBACK_THRESHOLD,
    GLM_FULL_DOC_AVG_THRESHOLD,
    LOW_CONF_AGREEMENT_DATASET_DIR,
    LOW_CONF_AGREEMENT_DATASET_ENABLED,
    LOW_CONF_AGREEMENT_SCORE_THRESHOLD,
    OCR_DICTIONARY_NEAREST_MAX_DISTANCE,
    OCR_GLM_ON_QUALITY_FLAGS,
    OCR_IMPROVE_ALLOWED_DOC_TYPES,
    OCR_IMPROVE_AUGMENTATIONS_PER_SEGMENT,
    OCR_IMPROVE_DATASET_ENABLED,
    OCR_IMPROVE_DATASET_ROOT,
    OCR_IMPROVE_MIN_DOC_CONF,
    OCR_IMPROVE_MIN_FIELD_CONF,
    OCR_IMPROVE_REQUIRE_CONFIDENT_ORIENTATION,
    OCR_SAFE_REPAIR_DICTIONARY_NEAREST,
    OCR_SAFE_REPAIR_ENABLED,
    OCR_TTA_ENABLED,
    OCR_TTA_MAX_VARIANTS,
    OCR_VERIFY_ENABLED,
    SEGMENT_DUMP_ROOT,
    MIGRATION_FIO_GRID_STAGE_MODE,
    MIGRATION_FIO_GRID_MIN_CELLS,
    MIGRATION_FIO_GRID_MIN_AVG_SCORE,
    MIGRATION_FIO_GRID_CELL_OVERLAP_RATIO,
    MIGRATION_FIO_GRID_ERASE_LINES,
    MIGRATION_FIO_GRID_GLM_FALLBACK_ENABLED,
)
from recognizeuz.image.geometry import polygon_to_list
from recognizeuz.pipeline.types import DocumentContext
from recognizeuz.text.normalization import normalize_ocr_text_for_match, paddle_and_glm_texts_match


def build_output_document(ctx: DocumentContext) -> dict[str, Any]:
    field_items: dict[str, Any] = {}
    public_output_field_names = ctx.spec.public_output_field_names

    for item in ctx.recognized_fields:
        field = item["field"]
        field_name = item["field_name"]

        # В обычном режиме не отдаём служебные поля вроде pas_photo/pas_mrz.
        # В debug-режиме оставляем поведение как раньше: показываем всё,
        # что прошло через pipeline и полезно для диагностики.
        if (
            not ctx.page.options.debug
            and public_output_field_names
            and field_name not in public_output_field_names
        ):
            continue

        field_items[field_name] = build_field_output_item(ctx, item, field)

    if ctx.page.options.debug:
        return build_debug_output_doc(ctx, field_items)

    output = {
        "type": ctx.doc_type,
        "fields": field_items,
    }
    if ctx.page.options.save_segments:
        output["segment_dump"] = ctx.page.segment_dump.as_debug_dict()
    return output


def build_field_output_item(
    ctx: DocumentContext,
    item: dict[str, Any],
    field: dict[str, Any],
) -> dict[str, Any]:
    field_name = item["field_name"]
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

    if ctx.page.options.debug:
        field_item: dict[str, Any] = {
            "text": item["final_text"],
            "recognition_source": item["source"],
            "confidence": {
                "detection": float(field["confidence"]),
                "ocr": float(item["paddle_score"]),
                "paddle_ocr": float(item["paddle_score"]),
                "glm_ocr": None,
            },
        }

        if paddle_glm_mismatch:
            field_item["paddle_text_if_glm_mismatch"] = item["paddle_text"]

        if ctx.spec.add_cyrillic_output and item["final_text"]:
            field_item["text_cyrillic"] = ctx.spec.convert_to_cyrillic(
                field_name=field_name,
                text=item["final_text"],
            )

        field_item["debug"] = {
            "timing": item["timing"],
            "fallback": {
                "ocr_improve": bool(ctx.page.options.ocr_improve),
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
            "intermediate": item.get("intermediate", []),
            "low_conf_agreement_dataset": item["dataset_sample"] if not ctx.page.options.ocr_improve else None,
            "ocr_improve_dataset": item["ocr_improve_sample"],
            "polygon_document": polygon_to_list(field["polygon"]),
            "bbox_document": field["bbox"],
        }
        return field_item

    field_item = {
        "text": item["final_text"],
        "confidence": 1.0 if used_glm_as_final else float(item["paddle_score"]),
    }

    if ctx.spec.add_cyrillic_output:
        field_item["text_cyrillic"] = (
            ctx.spec.convert_to_cyrillic(
                field_name=field_name,
                text=item["final_text"],
            )
            if item["final_text"]
            else ""
        )

    return field_item


def build_debug_output_doc(ctx: DocumentContext, field_items: dict[str, Any]) -> dict[str, Any]:
    return {
        "source": {
            "file_index": ctx.page.file_index,
            "filename": ctx.page.source_file,
            "page_index": ctx.page.page_index,
        },
        "document_index": ctx.doc_index,
        "type": ctx.doc_type,
        "confidence": float(ctx.doc["confidence"]),
        "orientation": {
            "rotation_applied_degrees_clockwise": ctx.rotation,
            "score": ctx.orientation_score,
            "confident": ctx.orientation_confident,
        },
        "ocr_quality": {
            "avg_paddle_score": ctx.avg_paddle_score,
            "fallback_mode": ctx.fallback_mode,
            "ocr_improve": bool(ctx.page.options.ocr_improve),
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
            "segment_dump": ctx.page.segment_dump.as_debug_dict(),
            "timing": {
                "page_document_yolo_seconds": ctx.page.doc_yolo_seconds,
                "orientation": ctx.orientation_timing,
                "pipeline_profile": ctx.page.profiler.as_list(),
                "pipeline_profile_totals": ctx.page.profiler.total_by_stage(),
            },
            "document_detection": {
                "synthetic": bool(ctx.doc.get("synthetic_document", False)),
                "fallback": ctx.doc.get("document_detection_fallback"),
            },
            "polygon_original": polygon_to_list(ctx.doc["polygon"]),
            "bbox_original": ctx.doc["bbox"],
            "detected_fields_count": len(ctx.fields),
            "recognized_fields_count": len(ctx.recognized_fields),
            "intermediate_stages": [
                {
                    "key": stage.key,
                    "model_key": stage.model.key,
                    "kind": stage.model.kind,
                    "scope": stage.scope,
                    "mode": stage.mode,
                    "applies_to_fields": sorted(stage.applies_to_fields),
                    "description": stage.description,
                }
                for stage in ctx.spec.intermediate_stages
            ],
            "low_conf_agreement_dataset": {
                "enabled": LOW_CONF_AGREEMENT_DATASET_ENABLED,
                "dir": str(LOW_CONF_AGREEMENT_DATASET_DIR),
                "score_threshold": LOW_CONF_AGREEMENT_SCORE_THRESHOLD,
            },
            "migration_fio_grid_stage": {
                "mode": MIGRATION_FIO_GRID_STAGE_MODE,
                "min_cells": MIGRATION_FIO_GRID_MIN_CELLS,
                "min_avg_score": MIGRATION_FIO_GRID_MIN_AVG_SCORE,
                "cell_overlap_ratio": MIGRATION_FIO_GRID_CELL_OVERLAP_RATIO,
                "erase_lines": MIGRATION_FIO_GRID_ERASE_LINES,
                "glm_fallback_enabled": MIGRATION_FIO_GRID_GLM_FALLBACK_ENABLED,
            },
            "segment_dump_config": {
                "root": str(SEGMENT_DUMP_ROOT),
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
