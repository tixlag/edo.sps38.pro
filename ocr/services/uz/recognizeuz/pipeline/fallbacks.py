from __future__ import annotations

import time

from recognizeuz.core.config import (
    GLM_FIELD_FALLBACK_THRESHOLD,
    GLM_FULL_DOC_AVG_THRESHOLD,
)
from recognizeuz.dataset.low_conf_agreement import save_low_conf_agreement_sample
from recognizeuz.dataset.ocr_improve import save_ocr_improve_mismatch_sample
from recognizeuz.ocr.glm import glm_ocr_document_json, glm_ocr_field
from recognizeuz.pipeline.types import DocumentContext
from recognizeuz.quality.verification import apply_glm_text_to_item, apply_quality_verification_to_item
from recognizeuz.text.normalization import paddle_and_glm_texts_match
from recognizeuz.utils.timing import elapsed_seconds


def apply_fallbacks_and_datasets(ctx: DocumentContext) -> None:
    if ctx.page.options.ocr_improve:
        apply_ocr_improve_mode(ctx)
    else:
        apply_production_fallback_mode(ctx)


def apply_ocr_improve_mode(ctx: DocumentContext) -> None:
    ctx.fallback_mode = "ocr_improve_fields"

    for item in ctx.ocr_candidates:
        glm_started = time.perf_counter()
        try:
            glm_input = item.get("field_crop_prepared")
            if glm_input is None:
                glm_input = item["field_crop"]
            ctx.page.segment_dump.save_image(
                stage="fallback.glm_field_ocr_improve_input",
                image_bgr=glm_input,
                meta={
                    "doc_type": ctx.doc_type,
                    "document_index": ctx.doc_index,
                    "field_name": item["field_name"],
                    "passed_to": ["glm_ocr"],
                },
                name_parts=[ctx.page.file_index, ctx.page.page_index, ctx.doc_index, item["field_name"], "glm_improve"],
            )
            with ctx.page.profiler.stage(
                "fallback.glm_field_ocr_improve",
                doc_type=ctx.doc_type,
                field_name=item["field_name"],
            ):
                glm_text = glm_ocr_field(
                    doc_type=ctx.doc_type,
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
                    doc_type=ctx.doc_type,
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

    for item in ctx.ocr_candidates:
        item["ocr_improve_sample"] = save_ocr_improve_mismatch_sample(
            doc_type=ctx.doc_type,
            field_name=item["field_name"],
            field=item["field"],
            prepared_variants=item.get("field_crop_prepared_variants"),
            raw_field_crop_bgr=item.get("field_crop"),
            paddle_text=item["paddle_text"],
            paddle_score=float(item["paddle_score"]),
            glm_text=item.get("glm_text"),
            source_file=ctx.page.source_file,
            file_index=ctx.page.file_index,
            page_index=ctx.page.page_index,
            document_index=ctx.doc_index,
            doc_confidence=float(ctx.doc["confidence"]),
            orientation_angle=int(ctx.rotation),
            orientation_score=float(ctx.orientation_score),
            orientation_confident=bool(ctx.orientation_confident),
        )
        item["dataset_sample"] = item["ocr_improve_sample"]


def apply_production_fallback_mode(ctx: DocumentContext) -> None:
    # 1) Если средний score всех OCR-сегментов плохой — один GLM вызов
    # на весь выровненный документ. Это быстрее, чем много GLM-вызовов.
    if ctx.ocr_candidates and ctx.avg_paddle_score < GLM_FULL_DOC_AVG_THRESHOLD:
        ctx.fallback_mode = "glm_document"
        glm_document_started = time.perf_counter()
        glm_document_seconds = 0.0
        try:
            ctx.page.segment_dump.save_image(
                stage="fallback.glm_document_input",
                image_bgr=ctx.oriented_doc_crop,
                meta={
                    "doc_type": ctx.doc_type,
                    "document_index": ctx.doc_index,
                    "passed_to": ["glm_document_ocr"],
                },
                name_parts=[ctx.page.file_index, ctx.page.page_index, ctx.doc_index, ctx.doc_type, "glm_document"],
            )
            with ctx.page.profiler.stage("fallback.glm_document", doc_type=ctx.doc_type):
                ctx.glm_document_values = glm_ocr_document_json(
                    doc_type=ctx.doc_type,
                    doc_crop_bgr=ctx.oriented_doc_crop,
                )
            glm_document_seconds = elapsed_seconds(glm_document_started)
        except Exception:
            glm_document_seconds = elapsed_seconds(glm_document_started)
            ctx.fallback_mode = "glm_document_failed"
            ctx.glm_document_values = {}

        for item in ctx.ocr_candidates:
            field_name = item["field_name"]
            glm_text = ctx.glm_document_values.get(field_name, "")
            item["glm_text"] = glm_text
            item["timing"]["glm_ocr_seconds"] = glm_document_seconds
            item["timing"]["glm_ocr_scope"] = "shared_document"

            if glm_text:
                apply_glm_text_to_item(
                    item=item,
                    doc_type=ctx.doc_type,
                    glm_text=glm_text,
                    source="glm_document",
                )

    # 2) Иначе точечно добиваем только поля ниже порога.
    else:
        for item in ctx.ocr_candidates:
            if float(item["paddle_score"]) >= GLM_FIELD_FALLBACK_THRESHOLD:
                continue

            ctx.fallback_mode = "glm_field"
            glm_started = time.perf_counter()
            try:
                ctx.page.segment_dump.save_image(
                    stage="fallback.glm_field_input",
                    image_bgr=item["field_crop"],
                    meta={
                        "doc_type": ctx.doc_type,
                        "document_index": ctx.doc_index,
                        "field_name": item["field_name"],
                        "passed_to": ["glm_ocr"],
                    },
                    name_parts=[ctx.page.file_index, ctx.page.page_index, ctx.doc_index, item["field_name"], "glm_field"],
                )
                with ctx.page.profiler.stage(
                    "fallback.glm_field",
                    doc_type=ctx.doc_type,
                    field_name=item["field_name"],
                ):
                    glm_text = glm_ocr_field(
                        doc_type=ctx.doc_type,
                        field_name=item["field_name"],
                        field_crop_bgr=item["field_crop"],
                    )
                item["timing"]["glm_ocr_seconds"] = elapsed_seconds(glm_started)
                item["timing"]["glm_ocr_scope"] = "field"
                item["glm_text"] = glm_text

                if glm_text:
                    apply_glm_text_to_item(
                        item=item,
                        doc_type=ctx.doc_type,
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
    for item in ctx.ocr_candidates:
        before_quality_text = item.get("final_text", "")
        with ctx.page.profiler.stage(
            "quality.verification",
            doc_type=ctx.doc_type,
            field_name=item["field_name"],
        ):
            changed = apply_quality_verification_to_item(item=item, doc_type=ctx.doc_type)
        if changed:
            quality_changed_count += int(before_quality_text != item.get("final_text", ""))

    if quality_changed_count and ctx.fallback_mode == "none":
        ctx.fallback_mode = "quality_verification"

    # 4) Старый режим: если PaddleOCR был неуверен, но GLM OCR подтвердил
    # ровно тот же текст, сохраняем crop в датасет низкой уверенности.
    for item in ctx.ocr_candidates:
        glm_text = item.get("glm_text")
        if not glm_text:
            continue

        low_conf_image = item.get("field_crop_prepared")
        if low_conf_image is None:
            low_conf_image = item["field_crop"]
        item["dataset_sample"] = save_low_conf_agreement_sample(
            doc_type=ctx.doc_type,
            field_name=item["field_name"],
            field_crop_bgr=low_conf_image,
            paddle_text=item["paddle_text"],
            paddle_score=float(item["paddle_score"]),
            glm_text=glm_text,
            source_file=ctx.page.source_file,
            file_index=ctx.page.file_index,
            page_index=ctx.page.page_index,
            document_index=ctx.doc_index,
        )
