from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from recognizeuz.core.profiling import PipelineProfiler
from recognizeuz.debug.segment_dump import SegmentDumpSession
from recognizeuz.documents.base import DocumentSpec


@dataclass(slots=True)
class RecognitionOptions:
    debug: bool = False
    ocr_improve: bool = False
    save_segments: bool = False


@dataclass(slots=True)
class PageContext:
    image_bgr: np.ndarray
    source_file: str
    file_index: int
    page_index: int
    options: RecognitionOptions
    profiler: PipelineProfiler
    segment_dump: SegmentDumpSession
    doc_yolo_seconds: float = 0.0


@dataclass(slots=True)
class DocumentContext:
    page: PageContext
    spec: DocumentSpec
    doc: dict[str, Any]
    doc_index: int
    base_doc_crop: np.ndarray
    oriented_doc_crop: np.ndarray
    fields: list[dict[str, Any]]
    rotation: int
    orientation_score: float
    orientation_confident: bool
    orientation_timing: dict[str, Any]
    recognized_fields: list[dict[str, Any]] = field(default_factory=list)
    avg_paddle_score: float = 0.0
    fallback_mode: str = "none"
    glm_document_values: dict[str, str] = field(default_factory=dict)

    @property
    def doc_type(self) -> str:
        return self.spec.doc_type

    @property
    def ocr_candidates(self) -> list[dict[str, Any]]:
        return [
            item for item in self.recognized_fields
            if not self.spec.should_skip_ocr(item["field_name"])
        ]
