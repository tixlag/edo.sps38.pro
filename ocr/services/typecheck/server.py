"""Loopback-only Xiaomi text reader. Document decisions belong to the UZ adapter."""
from __future__ import annotations

import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import io
import json
import logging
import os
from pathlib import Path
import time

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = json.loads((ROOT / 'models/xiaomi-manifest.json').read_text())
MAX_UPLOAD = 10 * 1024 * 1024
MAX_OUTPUT = 65536
PROMPT = 'Extract the text in the image.'
PIXEL_PROFILES = (786432, 1258291)


class TextReader:
    def __init__(self, model_path: Path):
        import torch
        from transformers import AutoModelForImageTextToText, AutoProcessor

        for item in MANIFEST['files']:
            path = model_path / item['path']
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
            if path.stat().st_size != item['size'] or digest.hexdigest() != item['sha256']:
                raise ValueError('Model verification failed')
        if not torch.cuda.is_available():
            raise RuntimeError('CUDA required for the production text reader')
        fraction = float(os.getenv('XIAOMI_GPU_MEMORY_FRACTION', '0.23'))
        if not 0 < fraction <= 0.35:
            raise ValueError('Invalid GPU memory budget')
        torch.cuda.set_per_process_memory_fraction(fraction)
        self.processors = {pixels: AutoProcessor.from_pretrained(
            model_path, local_files_only=True, trust_remote_code=False,
            min_pixels=65536, max_pixels=pixels) for pixels in PIXEL_PROFILES}
        self.model = AutoModelForImageTextToText.from_pretrained(
            model_path, dtype=torch.bfloat16, local_files_only=True,
            trust_remote_code=False).to('cuda').eval()
        self.torch = torch

    def memory(self):
        free, total = self.torch.cuda.mem_get_info()
        return {'allocated_bytes': self.torch.cuda.memory_allocated(),
                'reserved_bytes': self.torch.cuda.memory_reserved(),
                'peak_allocated_bytes': self.torch.cuda.max_memory_allocated(),
                'gpu_free_bytes': free, 'gpu_total_bytes': total}

    def recognize(self, data: bytes, deadline: float, pixels: int = PIXEL_PROFILES[0]) -> dict:
        from PIL import Image, ImageOps

        Image.MAX_IMAGE_PIXELS = 40_000_000
        with Image.open(io.BytesIO(data)) as source:
            if source.width * source.height > 40_000_000:
                return {'reason': 'INPUT_LIMIT', 'text': '', 'truncated': False}
            image = ImageOps.exif_transpose(source).convert('RGB')
        # Preserve the whole page, including document titles. Bound visual tokens.
        if pixels not in PIXEL_PROFILES:
            return {'reason': 'INPUT_LIMIT', 'text': '', 'truncated': False}
        scale = min(2.0, (pixels / (image.width * image.height)) ** 0.5)
        if scale != 1:
            image = image.resize((max(1, int(image.width * scale)),
                                  max(1, int(image.height * scale))))
        messages = [{'role': 'user', 'content': [
            {'type': 'image', 'image': image}, {'type': 'text', 'text': PROMPT}]}]
        processor = self.processors[pixels]
        inputs = processor.apply_chat_template(
            messages, tokenize=True, add_generation_prompt=True,
            enable_thinking=False, return_dict=True, return_tensors='pt').to('cuda')
        prefix = inputs['input_ids'].shape[1]
        if prefix > 8192:
            return {'reason': 'INPUT_LIMIT', 'text': '', 'truncated': False}
        remaining = deadline - time.time()
        if remaining <= 0:
            return {'reason': 'TIMEOUT', 'text': '', 'truncated': False}
        with self.torch.inference_mode():
            output = self.model.generate(**inputs, max_new_tokens=2048,
                                         max_time=remaining, do_sample=False)
        tokens = output[0, prefix:]
        eos = self.model.generation_config.eos_token_id
        eos = eos if isinstance(eos, list) else [eos]
        truncated = len(tokens) >= 2048 or time.time() >= deadline or not len(tokens) or int(tokens[-1]) not in eos
        text = processor.decode(tokens, skip_special_tokens=True)
        if len(text.encode('utf-8')) > MAX_OUTPUT:
            truncated = True
        return {'text': '' if truncated else text, 'truncated': truncated,
                'reason': 'TRUNCATED' if truncated else None}


def create_server(reader, port: int):
    class Handler(BaseHTTPRequestHandler):
        def reply(self, status, result):
            body = json.dumps(result, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            if self.path != '/health':
                return self.reply(404, {})
            self.reply(200, {'status': 'ok', 'model': MANIFEST['repository'],
                             'revision': MANIFEST['revision'], 'memory': reader.memory()})

        def do_POST(self):
            started = time.monotonic()
            if self.path != '/recognize-text':
                return self.reply(404, {})
            try:
                length = int(self.headers.get('Content-Length', '0'))
                deadline = float(self.headers.get('X-Deadline-Unix', '0'))
                pixels = int(self.headers.get('X-Image-Pixels', str(PIXEL_PROFILES[0])))
                if not 0 < length <= MAX_UPLOAD:
                    return self.reply(413, {'reason': 'INPUT_LIMIT'})
                if pixels not in PIXEL_PROFILES:
                    return self.reply(413, {'reason': 'INPUT_LIMIT'})
                if not time.time() < deadline <= time.time() + 55:
                    return self.reply(408, {'reason': 'TIMEOUT'})
                self.connection.settimeout(min(5, deadline - time.time()))
                data = self.rfile.read(length)
                if len(data) != length:
                    return self.reply(400, {'reason': 'INVALID_RESPONSE'})
                result = reader.recognize(data, deadline, pixels)
                self.reply(200, {**result, 'model': MANIFEST['repository'],
                                 'revision': MANIFEST['revision'],
                                 'pixels': pixels,
                                 'elapsed_ms': round((time.monotonic() - started) * 1000, 2)})
            except Exception as error:
                # Never log images, recognized text or exception bodies.
                logging.error('xiaomi_text_reader failed error_class=%s', type(error).__name__)
                self.reply(503, {'reason': 'OCR_UNAVAILABLE'})

        def log_message(self, *_):
            pass

    return HTTPServer(('127.0.0.1', port), Handler)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8084)
    parser.add_argument('--models-dir', type=Path, required=True)
    args = parser.parse_args()
    create_server(TextReader(args.models_dir / 'document-type' / MANIFEST['revision']), args.port).serve_forever()
