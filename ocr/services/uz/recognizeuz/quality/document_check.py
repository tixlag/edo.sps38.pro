"""Conservative, local-only document presence check; independent of field OCR.

Imports of GPU/image libraries are lazy so contract/policy tests need no weights
or CUDA. Relative scores are not calibrated probabilities of document validity.
"""
from __future__ import annotations

import io
import json
import logging
import math
import os
from pathlib import Path
import time
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[4]
POLICY = json.loads((ROOT / 'contracts/document-check-v1.json').read_text())
LOGGER = logging.getLogger(__name__)


def enabled() -> bool:
    return os.getenv('DOCUMENT_CHECK_ENABLED', 'true').lower() not in {'0', 'false', 'no', 'off'}


def verdict_from_scores(scores: list[float], baseline_scores: list[float] | None = None) -> str:
    if len(scores) != len(POLICY['rotations']) or any(
            not math.isfinite(score) or not 0 <= score <= 1 for score in scores):
        return 'UNCERTAIN'
    if baseline_scores is None:
        baseline_scores = scores
    if len(baseline_scores) != len(POLICY['rotations']) or any(
            not math.isfinite(score) or not 0 <= score <= 1 for score in baseline_scores):
        return 'UNCERTAIN'
    if (all(score >= POLICY['reject_threshold'] for score in scores)
            and all(score >= POLICY['context_guard_threshold'] for score in baseline_scores)):
        return 'NON_DOCUMENT'
    if any(score <= 1 - POLICY['document_threshold'] for score in baseline_scores):
        return 'DOCUMENT'
    return 'UNCERTAIN'


class DocumentChecker:
    def __init__(self):
        self.model = None
        self.processor = None
        self.text_features = None
        self.device = None
        self.memory = {}

    def load(self):
        if not enabled():
            return
        import torch
        from transformers import AutoModel, AutoProcessor

        if not torch.cuda.is_available():
            raise RuntimeError('Document checker requires CUDA')
        models_root = Path(os.getenv('MODELS_ROOT', str(ROOT / 'models'))).expanduser().resolve()
        directory = models_root / 'document-check' / POLICY['revision']
        self.device = torch.device('cuda:0')
        before = torch.cuda.memory_allocated(self.device)
        # Never fetch model code, weights or tokenizer files at runtime.
        self.processor = AutoProcessor.from_pretrained(
            directory, local_files_only=True, trust_remote_code=False)
        self.model = AutoModel.from_pretrained(
            directory, local_files_only=True, trust_remote_code=False,
            use_safetensors=True, dtype=torch.float16).to(self.device).eval()
        prompts = (POLICY['document_prompts'] + POLICY['non_document_prompts']
                   + POLICY['context_non_document_prompts'])
        inputs = self.processor(text=prompts, padding='max_length', max_length=64,
                                truncation=True, return_tensors='pt').to(self.device)
        with torch.inference_mode():
            # Transformers 5.9 returns BaseModelOutputWithPooling here.
            text = self.model.get_text_features(**inputs).pooler_output.float()
            self.text_features = text / text.norm(dim=-1, keepdim=True).clamp_min(1e-12)
        # Warm up the image tower before the deployment readiness check.
        from PIL import Image
        self.classify(Image.new('RGB', (224, 224), 'white'))
        self.memory['model_allocated_bytes'] = torch.cuda.memory_allocated(self.device) - before

    def clear(self):
        self.model = self.processor = self.text_features = self.device = None
        self.memory = {}

    def classify(self, image) -> dict[str, Any]:
        if not enabled() or self.model is None:
            return {'verdict': 'UNCERTAIN', 'reason': 'DISABLED' if not enabled() else 'UNAVAILABLE',
                    'non_document_scores': []}
        import torch
        from PIL import ImageOps

        scores = []
        baseline_scores = []
        count = len(POLICY['document_prompts'])
        original_end = count + len(POLICY['non_document_prompts'])
        with torch.inference_mode():
            for angle in POLICY['rotations']:
                # A square letterbox preserves the entire frame. No center crop
                # that could remove a small/off-centre identity document.
                rotated = image.rotate(angle, expand=True)
                square = ImageOps.pad(rotated, (224, 224), color='white')
                inputs = self.processor(images=square, return_tensors='pt').to(
                    device=self.device, dtype=torch.float16)
                features = self.model.get_image_features(**inputs).pooler_output.float()
                features /= features.norm(dim=-1, keepdim=True).clamp_min(1e-12)
                logits = (features @ self.text_features.T) * self.model.logit_scale.float().exp()
                logits += self.model.logit_bias.float()
                document = logits[0, :count].max()
                baseline = logits[0, count:original_end].max()
                non_document = logits[0, count:].max()
                baseline_scores.append(float(torch.sigmoid(baseline - document).item()))
                scores.append(float(torch.sigmoid(non_document - document).item()))
        self.memory['torch_peak_allocated_bytes'] = torch.cuda.max_memory_allocated(self.device)
        self.memory['gpu_free_bytes'] = torch.cuda.mem_get_info(self.device)[0]
        return {'verdict': verdict_from_scores(scores, baseline_scores), 'reason': None,
                'non_document_scores': scores}


checker = DocumentChecker()


def pages(data: bytes, filename: str, content_type: str | None) -> Iterable[tuple[int, Any]]:
    from PIL import Image, ImageOps

    if content_type == 'application/pdf' or filename.lower().endswith('.pdf'):
        import pypdfium2 as pdfium
        # Render one page at a time from bytes, without /tmp files or retaining
        # a whole PDF's raster pages in RAM.
        with pdfium.PdfDocument(data) as pdf:
            if not 1 <= len(pdf) <= 100:
                raise ValueError('PDF page limit exceeded')
            for index in range(len(pdf)):
                page = pdf[index]
                width, height = page.get_size()
                bitmap = page.render(scale=min(120 / 72, 2048 / width, 2048 / height))
                image = bitmap.to_pil().convert('RGB')
                try:
                    yield index + 1, image
                finally:
                    image.close()
                    bitmap.close()
                    page.close()
    else:
        with Image.open(io.BytesIO(data)) as source:
            image = ImageOps.exif_transpose(source).convert('RGB')
            try:
                yield 1, image
            finally:
                image.close()


def check_files(payload: list[tuple[str, bytes, str | None]]) -> dict[str, Any]:
    from recognizeuz.core.resources import infer_lock

    output = []
    started = time.monotonic()
    for file_index, (filename, data, content_type) in enumerate(payload):
        try:
            for page_number, image in pages(data, filename, content_type):
                if len(output) >= 100:
                    raise ValueError('Total page limit exceeded')
                remaining = 55 - (time.monotonic() - started)
                if remaining <= 0:
                    raise TimeoutError('Document checker deadline exceeded')
                try:
                    # Share the existing UZ inference lock: no overlapping model
                    # workspaces inside this service, including concurrent HTTP calls.
                    if not infer_lock.acquire(timeout=remaining):
                        raise TimeoutError('Document checker is busy')
                    try:
                        result = checker.classify(image)
                    finally:
                        infer_lock.release()
                except Exception:
                    LOGGER.warning('Document checker inference unavailable')
                    result = {'verdict': 'UNCERTAIN', 'reason': 'INFERENCE_UNAVAILABLE',
                              'non_document_scores': []}
                output.append({'file_index': file_index, 'page_number': page_number, **result})
        except Exception:
            LOGGER.warning('Document checker page decoding unavailable')
            # The EDO adapter also requires complete page coverage before acting
            # on any rejection. Partial results never cause an automatic return.
            output.append({'file_index': file_index, 'page_number': 1,
                           'verdict': 'UNCERTAIN', 'reason': 'DECODE_UNAVAILABLE',
                           'non_document_scores': []})
    return {'policy_version': POLICY['version'], 'model': POLICY['model'],
            'model_revision': POLICY['revision'], 'pages': output,
            'elapsed_ms': round((time.monotonic() - started) * 1000, 2)}
