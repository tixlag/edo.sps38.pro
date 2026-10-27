from __future__ import annotations

import time
from typing import Any

import numpy as np

from recognizeuz.core import resources
from recognizeuz.core.config import SEGMENT_DUMP_ROOT
from recognizeuz.core.profiling import PipelineProfiler
from recognizeuz.debug.segment_dump import SegmentDumpSession
from recognizeuz.image.loading import load_pages_from_upload
from recognizeuz.inference.yolo import detect_documents
from recognizeuz.pipeline.document import process_detected_document
from recognizeuz.pipeline.types import PageContext, RecognitionOptions
from recognizeuz.utils.timing import elapsed_seconds


def process_page(
    image_bgr: np.ndarray,
    *,
    source_file: str,
    file_index: int,
    page_index: int,
    debug: bool = False,
    ocr_improve: bool = False,
    save_segments: bool = False,
    segment_dump: SegmentDumpSession | None = None,
) -> list[dict[str, Any]]:
    options = RecognitionOptions(debug=debug, ocr_improve=ocr_improve, save_segments=save_segments)
    profiler = PipelineProfiler(enabled=debug or save_segments)
    if segment_dump is None:
        segment_dump = SegmentDumpSession.create(
            enabled=save_segments,
            root_dir=SEGMENT_DUMP_ROOT,
        )

    segment_dump.save_image(
        stage="page.input",
        image_bgr=image_bgr,
        meta={
            "source_file": source_file,
            "file_index": file_index,
            "page_index": page_index,
        },
        name_parts=[file_index, page_index, source_file],
    )

    doc_yolo_started = time.perf_counter()
    with profiler.stage("page.document_detection"):
        documents = detect_documents(image_bgr)
    doc_yolo_seconds = elapsed_seconds(doc_yolo_started)
    segment_dump.add_event(
        stage="page.document_detector_output",
        meta={
            "source_file": source_file,
            "file_index": file_index,
            "page_index": page_index,
            "documents_count": len(documents),
            "documents": [
                {
                    "type": doc.get("type"),
                    "class_name": doc.get("class_name"),
                    "confidence": float(doc.get("confidence", 0.0)),
                    "bbox": doc.get("bbox"),
                    "polygon": doc.get("polygon"),
                    "synthetic_document": bool(doc.get("synthetic_document", False)),
                }
                for doc in documents
            ],
        },
    )

    page = PageContext(
        image_bgr=image_bgr,
        source_file=source_file,
        file_index=file_index,
        page_index=page_index,
        options=options,
        profiler=profiler,
        segment_dump=segment_dump,
        doc_yolo_seconds=doc_yolo_seconds,
    )

    output_docs: list[dict[str, Any]] = []
    for doc_index, doc in enumerate(documents):
        output = process_detected_document(
            page=page,
            doc=doc,
            doc_index=doc_index,
        )
        if output is not None:
            output_docs.append(output)

    return output_docs


def recognize_files_payload(
    files_payload: list[tuple[str, bytes, str | None]],
    *,
    debug: bool = False,
    ocr_improve: bool = False,
    save_segments: bool = False,
) -> list[dict[str, Any]]:
    all_documents: list[dict[str, Any]] = []
    segment_dump = SegmentDumpSession.create(
        enabled=save_segments,
        root_dir=SEGMENT_DUMP_ROOT,
    )

    with resources.infer_lock:
        for file_index, (filename, data, content_type) in enumerate(files_payload):
            pages = load_pages_from_upload(
                data=data,
                filename=filename,
                content_type=content_type,
            )

            for page_index, page_bgr in enumerate(pages):
                docs = process_page(
                    page_bgr,
                    source_file=filename,
                    file_index=file_index,
                    page_index=page_index,
                    debug=debug,
                    ocr_improve=ocr_improve,
                    save_segments=save_segments,
                    segment_dump=segment_dump,
                )
                all_documents.extend(docs)

    return all_documents
