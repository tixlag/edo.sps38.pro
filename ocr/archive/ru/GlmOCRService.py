# avision_service_sync.py
import asyncio
import os
import re
import tempfile

from typing import Optional, Tuple


import cv2
import numpy as np
# ── GLM-OCR ─────────────────────────────────────────────────────────────────
try:
    import torch
    from transformers import AutoTokenizer, AutoModelForImageTextToText, AutoProcessor

    _GLM_AVAILABLE = True
except Exception:
    _GLM_AVAILABLE = False

GLM_MODEL_PATH = os.environ.get("GLM_OCR_MODEL_PATH", "zai-org/GLM-OCR")

class GLMOCRService:
    """Singleton wrapper вокруг GLM-OCR model + processor."""

    _instance: Optional["GLMOCRService"] = None
    _lock = asyncio.Lock()

    def __init__(self):
        self.tokenizer = None
        self.processor = None
        self.model = None
        self._ready = False

    @classmethod
    def get_instance(cls) -> "GLMOCRService":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def load(self, model_path: str = GLM_MODEL_PATH):
        if self._ready:
            return
        if not _GLM_AVAILABLE:
            raise RuntimeError("transformers / torch not installed")
        # Эта модель регистрирует AutoTokenizer, а не AutoProcessor
        # self.tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
        self.processor = AutoProcessor.from_pretrained(model_path)
        self.model = AutoModelForImageTextToText.from_pretrained(
            pretrained_model_name_or_path=model_path,
            torch_dtype="auto",
            device_map="auto"
        )
        self._ready = True

    def recognize(self, image_path: str, prompt_text: str) -> str:
        """
        Распознаёт текст на изображении по пути image_path.
        Изображение загружается явно как PIL Image — apply_chat_template
        не умеет читать файлы по пути самостоятельно.
        """
        if not self._ready:
            raise RuntimeError("GLM-OCR model not loaded")

        # pil_image = Image.open(image_path).convert("RGB")

        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image", "url": image_path},
                    {"type": "text", "text": prompt_text},
                ],
            }
        ]

        inputs = self.processor.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=True,
            return_dict=True,
            return_tensors="pt",
        ).to(self.model.device)
        inputs.pop("token_type_ids", None)

        with torch.no_grad():
            generated_ids = self.model.generate(**inputs, max_new_tokens=8192)

        # skip_special_tokens=False — как в официальном примере модели
        output_text = self.processor.decode(
            generated_ids[0][inputs["input_ids"].shape[1]:],
            skip_special_tokens=False,
        )
        print(output_text) # todo убарть

        # Убираем служебные токены <|im_end|> и markdown-обёртки ``` ... ```
        output_text = re.sub(r"<\|[^|]+\|>", "", output_text)
        output_text = re.sub(r"```[a-zA-Z]*\n?", "", output_text)
        output_text = output_text.replace("```", "").strip()
        return output_text

    def fallback(self, image_path: str, prompt_text: str) -> Tuple[str, str]:

        output_text = self.recognize(image_path, prompt_text)
        return output_text, image_path


_glm_service = GLMOCRService.get_instance()

def glm_recognize_with_score(img_array: np.ndarray, class_name: str, prompt: str,
                  output_dir: str = "/tmp/ocr_glm") -> tuple[tuple[str, float], str]:
    """
    Сохраняет numpy-кроп во временный файл и вызывает GLM-OCR.
    Возвращает (recognized_text, tmp_file_path).
    """
    os.makedirs(output_dir, exist_ok=True)
    tmp = tempfile.NamedTemporaryFile(
        suffix=".png", prefix=f"glm_{class_name}_", dir=output_dir, delete=False
    )
    tmp_path = tmp.name
    tmp.close()

    # конвертируем в BGR если нужно
    if img_array.ndim == 2:
        save_img = cv2.cvtColor(img_array, cv2.COLOR_GRAY2BGR)
    elif img_array.shape[2] == 4:
        save_img = cv2.cvtColor(img_array, cv2.COLOR_BGRA2BGR)
    else:
        save_img = img_array

    cv2.imwrite(tmp_path, save_img)



    text = _glm_service.recognize(tmp_path, prompt)
    return (text, 1.0), tmp_path

def glm_recognize(img_array: np.ndarray, class_name: str, prompt: str,
                  output_dir: str = "/tmp/ocr_glm") -> tuple[str, str]:
    """
    Сохраняет numpy-кроп во временный файл и вызывает GLM-OCR.
    Возвращает (recognized_text, tmp_file_path).
    """
    os.makedirs(output_dir, exist_ok=True)
    tmp = tempfile.NamedTemporaryFile(
        suffix=".png", prefix=f"glm_{class_name}_", dir=output_dir, delete=False
    )
    tmp_path = tmp.name
    tmp.close()

    # конвертируем в BGR если нужно
    if img_array.ndim == 2:
        save_img = cv2.cvtColor(img_array, cv2.COLOR_GRAY2BGR)
    elif img_array.shape[2] == 4:
        save_img = cv2.cvtColor(img_array, cv2.COLOR_BGRA2BGR)
    else:
        save_img = img_array

    cv2.imwrite(tmp_path, save_img)
    text = _glm_service.recognize(tmp_path, prompt)
    return text, tmp_path

async def glm_recognize_async(img_array: np.ndarray, class_name: str, prompt: str,
                               output_dir: str = "/tmp/ocr_glm") -> tuple[str, str]:
    """Асинхронная обёртка над glm_recognize."""
    return await asyncio.to_thread(glm_recognize, img_array, class_name, prompt, output_dir)


# ── Prompts ───────────────────────────────────────────────────────────────────

# GLM-OCR поддерживает только фиксированные промпты для Document Parsing:
# "Text Recognition:", "Formula Recognition:", "Table Recognition:"
# Для сегментов паспорта всегда используем Text Recognition.
GLM_PROMPT_TEXT = "Text Recognition (Russian):"
GLM_PROMPT_FORMULA = "Formula Recognition:"
GLM_PROMPT_TABLE = "Table Recognition:"
