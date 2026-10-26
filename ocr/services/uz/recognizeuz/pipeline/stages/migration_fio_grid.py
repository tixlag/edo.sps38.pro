from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Any

import cv2
import numpy as np

from recognizeuz.core.config import (
    MIGRATION_FIO_GRID_CELL_OVERLAP_RATIO,
    MIGRATION_FIO_GRID_ERASE_LINES,
    MIGRATION_FIO_GRID_GLM_FALLBACK_ENABLED,
    MIGRATION_FIO_GRID_GLM_SCORE_THRESHOLD,
    MIGRATION_FIO_GRID_MIN_AVG_SCORE,
    MIGRATION_FIO_GRID_MIN_CELLS,
)
from recognizeuz.image.preprocessing import prepare_ocr_image_array
from recognizeuz.ocr.glm import glm_ocr_single_glyph
from recognizeuz.ocr.paddle import recognize_prepared_images_with_paddle
from recognizeuz.pipeline.types import DocumentContext
from recognizeuz.quality.verification import build_ocr_quality_report
from recognizeuz.utils.timing import elapsed_seconds

_CYRILLIC_LETTER_RE = re.compile(r"[А-ЯЁ]", re.IGNORECASE)
_LATIN_LETTER_RE = re.compile(r"[A-Z]", re.IGNORECASE)


@dataclass(slots=True)
class CellCrop:
    index: int
    bbox: tuple[int, int, int, int]
    raw_bgr: np.ndarray
    prepared_bgr: np.ndarray


def run_migration_fio_grid_stage(
    *,
    ctx: DocumentContext,
    field_name: str,
    field_crop_bgr: np.ndarray,
    item: dict[str, Any],
    mode: str,
) -> dict[str, Any]:
    """
    Recognize migration-card FIO rows by cutting a cell row into glyph crops.

    This is intentionally rule-based: no extra training is required. It is useful
    for A5 migration cards where Cyrillic FIO is handwritten/printed in boxes and
    full-row OCR is worse than per-glyph OCR.
    """

    started = time.perf_counter()

    if mode == "debug_only" and not (ctx.page.options.debug or ctx.page.options.save_segments):
        result = {
            "stage": "migration_fio_grid_letters",
            "status": "skipped_debug_only",
            "mode": mode,
        }
        item.setdefault("intermediate", []).append(result)
        return result

    cells = detect_grid_cells(field_crop_bgr)
    status = "ok" if len(cells) >= MIGRATION_FIO_GRID_MIN_CELLS else "not_enough_cells"

    ctx.page.segment_dump.save_image(
        stage="migration_fio_grid.field_input",
        image_bgr=field_crop_bgr,
        meta={
            "doc_type": ctx.doc_type,
            "field_name": field_name,
            "document_index": ctx.doc_index,
            "detected_cells_count": len(cells),
            "mode": mode,
            "passed_to": ["grid_cell_detector"],
        },
        name_parts=[ctx.page.file_index, ctx.page.page_index, ctx.doc_index, field_name, "grid_input"],
    )

    glyph_results: list[dict[str, Any]] = []
    text = ""
    avg_score = 0.0
    used_glm_count = 0

    if status == "ok":
        prepared_images = [cell.prepared_bgr for cell in cells]
        with ctx.page.profiler.stage(
            "migration_fio_grid.paddle_glyph_batch",
            doc_type=ctx.doc_type,
            field_name=field_name,
            cells_count=len(cells),
        ):
            paddle_results = recognize_prepared_images_with_paddle(ctx.doc_type, prepared_images)

        letters: list[str] = []
        scores: list[float] = []
        trailing_empty = 0

        for cell, (raw_text, raw_score) in zip(cells, paddle_results):
            letter = normalize_glyph_text(raw_text, field_name=field_name)
            score = float(raw_score)
            source = "paddle_glyph"
            glm_text = None
            glm_error = None

            if (
                MIGRATION_FIO_GRID_GLM_FALLBACK_ENABLED
                and (not letter or score < MIGRATION_FIO_GRID_GLM_SCORE_THRESHOLD)
            ):
                try:
                    with ctx.page.profiler.stage(
                        "migration_fio_grid.glm_glyph",
                        doc_type=ctx.doc_type,
                        field_name=field_name,
                        cell_index=cell.index,
                    ):
                        glm_text = glm_ocr_single_glyph(cell.prepared_bgr)
                    glm_letter = normalize_glyph_text(glm_text, field_name=field_name)
                    if glm_letter:
                        letter = glm_letter
                        score = 1.0
                        source = "glm_glyph"
                        used_glm_count += 1
                except Exception as exc:  # pragma: no cover - depends on GLM server
                    glm_error = str(exc)

            if letter:
                letters.append(letter)
                scores.append(score)
                trailing_empty = 0
            else:
                # Empty boxes at the end are normal. Internal empty cells are kept
                # out of text but visible in debug metadata.
                trailing_empty += 1

            raw_dump_record = ctx.page.segment_dump.save_image(
                stage="migration_fio_grid.glyph_raw_crop",
                image_bgr=cell.raw_bgr,
                meta={
                    "doc_type": ctx.doc_type,
                    "field_name": field_name,
                    "document_index": ctx.doc_index,
                    "cell_index": cell.index,
                    "cell_bbox": cell.bbox,
                    "passed_to": ["glyph_ocr_preprocess"],
                },
                name_parts=[
                    ctx.page.file_index,
                    ctx.page.page_index,
                    ctx.doc_index,
                    field_name,
                    f"cell{cell.index:02d}",
                    "raw",
                ],
            )

            dump_record = ctx.page.segment_dump.save_image(
                stage="migration_fio_grid.glyph_prepared_for_ocr",
                image_bgr=cell.prepared_bgr,
                meta={
                    "doc_type": ctx.doc_type,
                    "field_name": field_name,
                    "document_index": ctx.doc_index,
                    "cell_index": cell.index,
                    "cell_bbox": cell.bbox,
                    "paddle_text": raw_text,
                    "paddle_score": float(raw_score),
                    "normalized_letter": letter,
                    "source": source,
                    "glm_text": glm_text,
                    "glm_error": glm_error,
                    "passed_to": ["paddle_recognizer", "glm_glyph_fallback_if_enabled"],
                },
                name_parts=[
                    ctx.page.file_index,
                    ctx.page.page_index,
                    ctx.doc_index,
                    field_name,
                    f"cell{cell.index:02d}",
                    letter or "empty",
                ],
            )

            glyph_results.append(
                {
                    "index": cell.index,
                    "bbox": list(cell.bbox),
                    "paddle_text": raw_text,
                    "paddle_score": float(raw_score),
                    "text": letter,
                    "source": source,
                    "glm_text": glm_text,
                    "glm_error": glm_error,
                    "raw_dump": raw_dump_record,
                    "dump": dump_record,
                }
            )

        text = "".join(letters).strip()
        avg_score = float(np.mean(scores)) if scores else 0.0

        if not text:
            status = "empty_result"
        elif avg_score < MIGRATION_FIO_GRID_MIN_AVG_SCORE:
            status = "low_confidence"

    should_replace = (
        mode == "replace"
        and status == "ok"
        and text
        and avg_score >= MIGRATION_FIO_GRID_MIN_AVG_SCORE
    )

    if should_replace:
        item["final_text"] = text
        item["source"] = "migration_fio_grid_letters"
        # This confidence belongs to glyph OCR. Keep original paddle_score visible
        # in debug, but use better confidence for the final field.
        item["paddle_score"] = max(float(item.get("paddle_score", 0.0)), avg_score)
        item["quality"] = build_ocr_quality_report(
            doc_type=ctx.doc_type,
            field_name=field_name,
            text=text,
            paddle_score=float(item["paddle_score"]),
        )

    seconds = elapsed_seconds(started)
    item.setdefault("timing", {})["migration_fio_grid_seconds"] = seconds
    item.setdefault("timing", {})["migration_fio_grid_cells_count"] = len(cells)

    result = {
        "stage": "migration_fio_grid_letters",
        "status": status,
        "mode": mode,
        "replaced": should_replace,
        "text": text,
        "avg_score": avg_score,
        "cells_count": len(cells),
        "used_glm_count": used_glm_count,
        "seconds": seconds,
        "glyphs": glyph_results,
    }
    item.setdefault("intermediate", []).append(result)
    return result


def normalize_glyph_text(text: str | None, *, field_name: str) -> str:
    if not text:
        return ""

    cleaned = str(text).strip().upper()
    cleaned = cleaned.replace("0", "О").replace("3", "З").replace("6", "Б")
    cleaned = cleaned.replace("Ë", "Ё")

    # mg_surname_lat is technically Latin, but handwritten Russian FIO fields are
    # Cyrillic. Keep Latin support for the rare Latin row without a separate path.
    regex = _LATIN_LETTER_RE if field_name.endswith("_lat") else _CYRILLIC_LETTER_RE
    match = regex.search(cleaned)
    if match:
        return match.group(0).upper()

    # Some OCR models return Latin lookalikes for Cyrillic glyphs.
    lookalikes = {
        "A": "А",
        "B": "В",
        "C": "С",
        "E": "Е",
        "H": "Н",
        "K": "К",
        "M": "М",
        "O": "О",
        "P": "Р",
        "T": "Т",
        "X": "Х",
        "Y": "У",
    }
    for ch in cleaned:
        if ch in lookalikes and not field_name.endswith("_lat"):
            return lookalikes[ch]

    return ""


def detect_grid_cells(field_crop_bgr: np.ndarray) -> list[CellCrop]:
    if field_crop_bgr is None or field_crop_bgr.size == 0:
        return []

    h, w = field_crop_bgr.shape[:2]
    if h < 8 or w < 12:
        return []

    gray = cv2.cvtColor(field_crop_bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    binary = cv2.threshold(
        gray,
        0,
        255,
        cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU,
    )[1]

    vertical = _extract_vertical_lines(binary)
    boundaries = _find_vertical_boundaries(vertical, image_height=h, image_width=w)

    if len(boundaries) < 2:
        boundaries = _find_cell_boundaries_by_contours(binary, image_width=w, image_height=h)

    if len(boundaries) < 2:
        return []

    cells: list[CellCrop] = []
    cleaned_source = _erase_grid_lines(field_crop_bgr, binary) if MIGRATION_FIO_GRID_ERASE_LINES else field_crop_bgr

    for idx, (x1, x2) in enumerate(zip(boundaries, boundaries[1:])):
        cell_w = x2 - x1
        if cell_w < max(5, int(w * 0.01)):
            continue

        overlap = max(1, int(round(cell_w * MIGRATION_FIO_GRID_CELL_OVERLAP_RATIO)))
        cx1 = max(0, x1 - overlap)
        cx2 = min(w - 1, x2 + overlap)
        # Keep the full row height: grid top/bottom helps handwritten letters that
        # touch cell borders; OCR preprocessing will normalize the crop.
        raw = cleaned_source[:, cx1:cx2 + 1].copy()
        if raw.size == 0:
            continue

        prepared = prepare_ocr_image_array(raw)
        cells.append(
            CellCrop(
                index=len(cells),
                bbox=(int(cx1), 0, int(cx2), int(h - 1)),
                raw_bgr=raw,
                prepared_bgr=prepared,
            )
        )

    return cells


def _extract_vertical_lines(binary: np.ndarray) -> np.ndarray:
    h, w = binary.shape[:2]
    kernel_h = max(6, int(h * 0.55))
    kernel_w = 1 if w < 500 else 2
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kernel_w, kernel_h))
    vertical = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)
    return vertical


def _find_vertical_boundaries(
    vertical: np.ndarray,
    *,
    image_height: int,
    image_width: int,
) -> list[int]:
    projection = (vertical > 0).sum(axis=0)
    threshold = max(3, int(image_height * 0.30))
    xs = np.where(projection >= threshold)[0]
    if xs.size == 0:
        return []

    runs: list[tuple[int, int]] = []
    start = int(xs[0])
    prev = int(xs[0])
    for x in xs[1:]:
        x = int(x)
        if x <= prev + 1:
            prev = x
            continue
        runs.append((start, prev))
        start = prev = x
    runs.append((start, prev))

    centers = [int(round((a + b) / 2)) for a, b in runs]
    centers = _merge_close_boundaries(centers, min_gap=max(3, int(image_width * 0.004)))

    # Some crops cut away the outer grid lines. Add image edges only when the
    # first/last detected vertical lines are far from crop edges.
    if centers and centers[0] > max(4, int(image_width * 0.03)):
        centers.insert(0, 0)
    if centers and image_width - 1 - centers[-1] > max(4, int(image_width * 0.03)):
        centers.append(image_width - 1)

    return sorted(set(x for x in centers if 0 <= x < image_width))


def _find_cell_boundaries_by_contours(
    binary: np.ndarray,
    *,
    image_width: int,
    image_height: int,
) -> list[int]:
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes: list[tuple[int, int, int, int]] = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if h < image_height * 0.45:
            continue
        if w < 4 or w > image_width * 0.30:
            continue
        boxes.append((x, y, w, h))

    if len(boxes) < 2:
        return []

    # Rectangular cell contours usually give boxes; use left/right edges.
    edges: list[int] = []
    for x, _y, w, _h in boxes:
        edges.extend([x, x + w])
    return _merge_close_boundaries(sorted(edges), min_gap=max(3, int(image_width * 0.01)))


def _merge_close_boundaries(boundaries: list[int], *, min_gap: int) -> list[int]:
    if not boundaries:
        return []
    groups: list[list[int]] = [[int(boundaries[0])]]
    for x in boundaries[1:]:
        x = int(x)
        if x - groups[-1][-1] <= min_gap:
            groups[-1].append(x)
        else:
            groups.append([x])
    return [int(round(float(np.mean(group)))) for group in groups]


def _erase_grid_lines(image_bgr: np.ndarray, binary: np.ndarray) -> np.ndarray:
    h, w = binary.shape[:2]
    vertical_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(6, int(h * 0.55))))
    horizontal_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(8, int(w * 0.08)), 1))
    lines = cv2.morphologyEx(binary, cv2.MORPH_OPEN, vertical_kernel)
    lines = cv2.bitwise_or(lines, cv2.morphologyEx(binary, cv2.MORPH_OPEN, horizontal_kernel))
    lines = cv2.dilate(lines, np.ones((2, 2), dtype=np.uint8), iterations=1)
    out = image_bgr.copy()
    out[lines > 0] = (255, 255, 255)
    return out
