from __future__ import annotations

import base64
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile

from recognizeuz.api.schemas import Base64Request
from recognizeuz.core import resources
from recognizeuz.pipeline.recognition import recognize_files_payload

router = APIRouter()


@router.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "models": resources.get_models_status(),
    }


@router.post("/recognize")
async def recognize_multipart(
    files: list[UploadFile] = File(...),
    debug: bool = Query(False),
    ocr_improve: bool = Query(False),
    save_segments: bool = Query(False),
    dump_segments: bool = Query(False),
    debug_form: bool | None = Form(None, alias="debug"),
    ocr_improve_form: bool | None = Form(None, alias="ocr_improve"),
    save_segments_form: bool | None = Form(None, alias="save_segments"),
) -> list[dict[str, Any]]:
    # Поддерживаем оба варианта:
    #   POST /recognize?debug=true&ocr_improve=true
    #   multipart form-data: debug=true, ocr_improve=true
    effective_debug = debug_form if debug_form is not None else debug
    effective_ocr_improve = (
        ocr_improve_form
        if ocr_improve_form is not None
        else ocr_improve
    )
    effective_save_segments = (
        save_segments_form
        if save_segments_form is not None
        else bool(save_segments or dump_segments)
    )

    payload = []

    for f in files:
        data = await f.read()
        payload.append(
            (
                f.filename or "uploaded_file",
                data,
                f.content_type,
            )
        )

    res = recognize_files_payload(
        payload,
        debug=bool(effective_debug),
        ocr_improve=bool(effective_ocr_improve),
        save_segments=bool(effective_save_segments),
    )
    if len(res) == 0:
        raise HTTPException(400, f"Плохое качество документа")
    return res


@router.post("/recognize-base64")
def recognize_base64(
    request: Base64Request,
    debug: bool = Query(False),
    ocr_improve: bool = Query(False),
    save_segments: bool = Query(False),
    dump_segments: bool = Query(False),
) -> list[dict[str, Any]]:
    effective_debug = bool(debug or request.debug)
    effective_ocr_improve = bool(ocr_improve or request.ocr_improve)
    effective_save_segments = bool(save_segments or dump_segments or request.save_segments)

    payload = []

    for item in request.files:
        payload.append(
            (
                item.filename,
                base64.b64decode(item.content_base64),
                None,
            )
        )

    return recognize_files_payload(
        payload,
        debug=effective_debug,
        ocr_improve=effective_ocr_improve,
        save_segments=effective_save_segments,
    )
