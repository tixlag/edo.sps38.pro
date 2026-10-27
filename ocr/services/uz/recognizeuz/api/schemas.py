from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field


class DocumentCheckPage(BaseModel):
    file_index: int = Field(ge=0)
    page_number: int = Field(ge=1)
    verdict: Literal['DOCUMENT', 'NON_DOCUMENT', 'UNCERTAIN']
    reason: Literal['DISABLED', 'UNAVAILABLE', 'INFERENCE_UNAVAILABLE', 'DECODE_UNAVAILABLE'] | None
    non_document_scores: list[float] = Field(max_length=4)


class DocumentCheckResponse(BaseModel):
    policy_version: str
    model: str
    model_revision: str
    pages: list[DocumentCheckPage] = Field(max_length=100)
    elapsed_ms: float

class Base64InputItem(BaseModel):
    filename: str
    content_base64: str

class Base64Request(BaseModel):
    files: list[Base64InputItem]
    # Можно передать debug как query-параметр /recognize-base64?debug=true
    # или прямо в JSON body: {"debug": true, "files": [...]}.
    debug: bool = False
    # Аналогично можно передать ocr_improve как query-параметр
    # /recognize-base64?ocr_improve=true или прямо в JSON body.
    ocr_improve: bool = False
    # Сохраняет промежуточные изображения pipeline в SEGMENT_DUMP_ROOT.
    save_segments: bool = False
