# avision_service.py
import asyncio
import functools
import os
import uuid
from typing import Optional, Tuple, Union

import numpy as np
from PIL import Image
import torch
from transformers import (
    AutoProcessor,
    AutoModelForImageTextToText,
    BitsAndBytesConfig,
)

class AvVisionService:
    """
    Singleton async service for AvitoTech/avision loaded in 4-bit (bitsandbytes).
    Usage:
        svc = AvVisionService()
        await svc.init(model_name="AvitoTech/avision", device="cuda:0", max_parallel=1)
        res = await svc.generate(image_pil, prompt="Опиши изображение.")
    """
    _instance: Optional["AvVisionService"] = None
    _lock = asyncio.Lock()

    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    async def init(
        self,
        model_name: str = "AvitoTech/avision",
        device: str = "cuda:0",
        max_parallel: int = 1,
        trust_remote_code: bool = True,
        load_in_4bit: bool = True,
        bnb_quant_type: str = "nf4",   # or "fp4" / "nf4" depending on bnb version and hardware
        use_fast_processor: bool = True,
    ):
        """
        Lazy async init. Loads model in 4-bit if load_in_4bit=True.
        """
        async with self._lock:
            if getattr(self, "_ready", False):
                return

            self.model_name = model_name
            self.device_str = device
            self.max_parallel = max_parallel

            print(f"Initializing AvVisionService: {model_name} (4-bit={load_in_4bit})")

            # Processor (tokenizer + vision preprocessing helpers)
            print("Loading processor...")
            self.processor = AutoProcessor.from_pretrained(
                model_name, trust_remote_code=trust_remote_code
            )

            # Prepare bitsandbytes quantization config if requested
            quant_config = None
            if load_in_4bit:
                print("Using BitsAndBytes 4-bit quantization config")
                quant_config = BitsAndBytesConfig(
                    load_in_4bit=True,
                    bnb_4bit_compute_dtype=torch.float16,  # compute in fp16
                    bnb_4bit_quant_type=bnb_quant_type,    # 'nf4' or 'fp4'
                    # keep_in_fp32: optionally force some layers into fp32, default False
                )

            # Try to set device and load model with device_map="auto"
            try:
                # If device string mentions cuda but no cuda available -> fallback to cpu
                if device.startswith("cuda") and not torch.cuda.is_available():
                    print("CUDA not available — falling back to CPU (4-bit requires GPU!).")
                    self.device = torch.device("cpu")
                else:
                    self.device = torch.device(device)
            except Exception:
                self.device = torch.device("cpu")

            # Load model (AutoModelForImageTextToText supports Qwen-VL variants)
            print("Loading model weights (this may take a while)...")
            # device_map="auto" helps place layers between GPU(s) and CPU if needed
            model_kwargs = dict(
                trust_remote_code=trust_remote_code,
                device_map="auto",
            )
            if quant_config is not None:
                model_kwargs["quantization_config"] = quant_config
                # legacy flag supported in some versions:
                # model = AutoModelForImageTextToText.from_pretrained(..., load_in_4bit=True, device_map="auto")
            try:
                self.model = AutoModelForImageTextToText.from_pretrained(
                    model_name,
                    **model_kwargs,
                )
            except Exception as e:
                # Provide more actionable error
                raise RuntimeError(
                    f"Failed to load model '{model_name}' with quantization={load_in_4bit}: {e}"
                )

            self.model.eval()
            self._sem = asyncio.Semaphore(max_parallel)
            self._ready = True

            # Diagnostics
            print(f"Model loaded. device_map: {getattr(self.model, 'hf_device_map', 'auto')}")
            print(f"Service ready. max_parallel={max_parallel}")

    async def generate(
        self,
        image: Union[np.ndarray, Image.Image],
        prompt: str = "Опиши изображение.",
        max_new_tokens: int = 256,
    ) -> str:
        """
        image: numpy BGR/GRAY or PIL.Image
        returns: generated text (str)
        """
        if not getattr(self, "_ready", False):
            # try default init
            await self.init()

        async with self._sem:
            return await self._infer(image, prompt, max_new_tokens)

    async def _infer(self, image: Union[np.ndarray, Image.Image], prompt: str, max_new_tokens: int):
        loop = asyncio.get_event_loop()

        # Normalize input -> PIL Image RGB
        if isinstance(image, Image.Image):
            img_pil = image.convert("RGB")
        else:
            arr = image
            # if grayscale single-channel convert to 3-channel
            if arr.ndim == 2:
                import cv2
                arr = cv2.cvtColor(arr, cv2.COLOR_GRAY2RGB)
            elif arr.shape[2] == 4:
                import cv2
                arr = cv2.cvtColor(arr, cv2.COLOR_RGBA2RGB)
            else:
                # BGR -> RGB (common for cv2)
                import cv2
                try:
                    arr = cv2.cvtColor(arr, cv2.COLOR_BGR2RGB)
                except Exception:
                    pass
            img_pil = Image.fromarray(arr.astype("uint8"))

        # Build chat-style messages as in the model quickstart
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": img_pil},
                    {"type": "text", "text": prompt},
                ],
            }
        ]

        # Prepare inputs via processor (tokenize + preprocess images)
        def _prepare_inputs():
            chat_text = self.processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
            image_inputs, video_inputs = None, None
            # If model repo has helper utilities (like qwen_vl_utils.process_vision_info) you can reuse them.
            inputs = self.processor(
                text=[chat_text],
                images=[img_pil],
                padding=True,
                return_tensors="pt",
            )
            return inputs

        inputs = await loop.run_in_executor(None, _prepare_inputs)

        # Move inputs to device where model expects them.
        # When device_map="auto" some submodules on CPU, so use accelerate helpers or to_device selectively.
        try:
            # simple approach: move tensors to cuda if available
            device = next(iter(self.model.hf_device_map.values())) if hasattr(self.model, "hf_device_map") else str(self.device)
            # prefer cuda if any part is on cuda
            if torch.cuda.is_available():
                inputs = {k: v.to("cuda") for k, v in inputs.items() if hasattr(v, "to")}
        except Exception:
            try:
                inputs = {k: v.to(self.device) for k, v in inputs.items() if hasattr(v, "to")}
            except Exception:
                pass

        # Generation call (run in threadpool)
        def _gen():
            with torch.no_grad():
                out = self.model.generate(**inputs, max_new_tokens=max_new_tokens)
            return out

        generated_ids = await loop.run_in_executor(None, _gen)

        # Postprocess decode
        # processor.batch_decode expects ids tensor
        text = self.processor.batch_decode(generated_ids, skip_special_tokens=True)[0]
        return text.strip()


# helper wrapper to match your trocr_recognize_async signature (text, file_path)
async def avision_generate_async(
    image: Union[np.ndarray, Image.Image],
    name: str,
    prompt: str = "Опиши изображение.",
    output_dir: Optional[str] = None,
    avision_svc: Optional[AvVisionService] = None,
) -> Tuple[str, str]:
    if avision_svc is None:
        avision_svc = AvVisionService()
        await avision_svc.init(device="cuda:0", max_parallel=1, load_in_4bit=True)

    # Save debug image if requested
    file_path = "/tmp/avision_api"
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
        filename = f"{name}_{uuid.uuid4().hex[:8]}.png"
        file_path = os.path.join(output_dir, filename)
        if isinstance(image, Image.Image):
            image.save(file_path)
        else:
            try:
                import cv2
                cv2.imwrite(file_path, image)
            except Exception:
                rgb = Image.fromarray(image)
                rgb.save(file_path)

    print('prompt', prompt)
    text = await avision_svc.generate(image, prompt=prompt)
    return text, file_path


async def avision_generate(
    image: Union[np.ndarray, Image.Image],
    name: str,
    prompt: str = "Опиши изображение.",
    output_dir: Optional[str] = None,
    avision_svc: Optional[AvVisionService] = None,
) -> Tuple[str, str]:
    if avision_svc is None:
        avision_svc = AvVisionService()
        await avision_svc.init(device="cuda:0", max_parallel=1, load_in_4bit=True)

    # Save debug image if requested
    file_path = "/tmp/avision_api"
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
        filename = f"{name}_{uuid.uuid4().hex[:8]}.png"
        file_path = os.path.join(output_dir, filename)
        if isinstance(image, Image.Image):
            image.save(file_path)
        else:
            try:
                import cv2
                cv2.imwrite(file_path, image)
            except Exception:
                rgb = Image.fromarray(image)
                rgb.save(file_path)

    print('prompt', prompt)
    text = await avision_svc.generate(image, prompt=prompt)
    return text, file_path
