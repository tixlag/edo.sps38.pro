from __future__ import annotations

from pydantic import BaseModel

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
