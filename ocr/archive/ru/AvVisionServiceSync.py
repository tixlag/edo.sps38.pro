# avision_service_sync.py
import os
import uuid
import threading
import warnings
from typing import Optional, Tuple, Union, Dict, Any
from pathlib import Path

import numpy as np
from PIL import Image
import torch
from transformers import (
    AutoProcessor,
    AutoModelForImageTextToText,
    BitsAndBytesConfig,
    PreTrainedTokenizerBase
)
from huggingface_hub import login, HfFolder, hf_hub_download
from huggingface_hub.utils import GatedRepoError, RepositoryNotFoundError, RevisionNotFoundError


class AvVisionServiceSync:
    """
    Singleton synchronous service for AvitoTech/a-vision model with 4-bit quantization support.

    Usage:
        svc = AvVisionServiceSync.get_instance()
        svc.init(model_name="AvitoTech/a-vision", device="cuda:0")
        response = svc.generate(image_pil, prompt="Опиши изображение.")
    """
    _instance: Optional["AvVisionServiceSync"] = None
    _lock = threading.Lock()
    _initialized = False

    @classmethod
    def get_instance(cls) -> "AvVisionServiceSync":
        """Thread-safe singleton instance getter."""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def __init__(self):
        # Prevent direct instantiation
        if self._initialized:
            return
        self._initialized = True
        self.model = None
        self.processor: Optional[PreTrainedTokenizerBase] = None
        self.device = torch.device("cpu")
        self._ready = False
        self.hf_token = None

    def _authenticate(self, hf_token: Optional[str] = None) -> str:
        """
        Authenticate with Hugging Face Hub.

        Args:
            hf_token: Explicit token or read from environment/credentials store

        Returns:
            Valid token string
        """
        token = hf_token or os.environ.get("HF_TOKEN") or HfFolder.get_token()

        if not token:
            raise ValueError(
                "❌ Hugging Face token required! Please:\n"
                "1. Get token at https://huggingface.co/settings/tokens\n"
                "2. Accept model terms at https://huggingface.co/AvitoTech/avision\n"
                "3. Set via:\n"
                "   - Environment variable: export HF_TOKEN='your_token'\n"
                "   - Or pass to init(): svc.init(hf_token='your_token')"
            )

        try:
            login(token=token, add_to_git_credential=False)
            print("✅ Hugging Face authentication successful")
        except Exception as e:
            raise RuntimeError(f"Authentication failed: {str(e)}") from e

        self.hf_token = token
        return token

    def init(
            self,
            model_name: str = "AvitoTech/avision",
            device: str = "cuda:0",
            trust_remote_code: bool = True,
            load_in_4bit: bool = True,
            bnb_quant_type: str = "nf4",
            hf_token: Optional[str] = None,
            cache_dir: Optional[str] = None,
    ) -> None:
        """
        Initialize the vision service with specified configuration.

        Args:
            model_name: Hugging Face model identifier
            device: Target device (e.g., "cuda:0", "cpu")
            trust_remote_code: Allow custom model code execution
            load_in_4bit: Enable 4-bit quantization
            bnb_quant_type: Quantization type ("nf4" or "fp4")
            hf_token: Hugging Face authentication token
            cache_dir: Directory to cache model files
        """
        with self._lock:
            if self._ready:
                return

            print(f"🚀 Initializing AvVisionServiceSync: {model_name} (4-bit={load_in_4bit})")

            # Handle authentication FIRST
            # self._authenticate(hf_token)

            # Validate device availability
            if device.startswith("cuda") and not torch.cuda.is_available():
                print("WARNING: CUDA not available - falling back to CPU (4-bit quantization disabled)")
                device = "cpu"
                load_in_4bit = False

            self.device = torch.device(device)
            self.model_name = model_name

            # Configure quantization
            quant_config = None
            if load_in_4bit and "cuda" in device:
                print("Configuring BitsAndBytes 4-bit quantization")
                quant_config = BitsAndBytesConfig(
                    load_in_4bit=True,
                    bnb_4bit_compute_dtype=torch.float16,
                    bnb_4bit_quant_type=bnb_quant_type,
                )

            # Load processor
            print("Loading processor...")
            self.processor = AutoProcessor.from_pretrained(
                model_name,
                trust_remote_code=trust_remote_code,
                token=self.hf_token,
                cache_dir=cache_dir,
            )

            # Load model
            print("Loading model weights...")
            model_kwargs = {
                "trust_remote_code": trust_remote_code,
                "token": self.hf_token,
                "cache_dir": cache_dir,
                "device_map": "auto"
            }
            if quant_config is not None:
                model_kwargs["quantization_config"] = quant_config

            try:
                self.model = AutoModelForImageTextToText.from_pretrained(
                    model_name,
                    **model_kwargs
                )
                if not torch.cuda.is_available() or not load_in_4bit:
                    self.model.to(self.device)
            except Exception as e:
                error_msg = str(e).lower()
                if "401" in error_msg or "unauthorized" in error_msg or "access denied" in error_msg:
                    raise RuntimeError(
                        f"❌ Authentication failed for model '{model_name}'.\n"
                        f"Please verify:\n"
                        f"- You accepted the model terms at https://huggingface.co/{model_name}\n"
                        f"- Your token is valid and has 'read' permissions\n"
                        f"- Token is passed correctly to init(hf_token=...)"
                    ) from e
                raise RuntimeError(
                    f"Failed to load model '{model_name}' with quantization={load_in_4bit}: {str(e)}"
                ) from e

            self.model.eval()
            self._ready = True

            device_info = f"CUDA (v{torch.version.cuda})"
            quant_info = "4-bit (NF4)" if load_in_4bit else "full precision"
            print(f"✅ Service initialized successfully on {device_info} with {quant_info}")
            print(f"   Model device map: {getattr(self.model, 'hf_device_map', 'N/A')}")
            print(f"   Model dtype: {next(self.model.parameters()).dtype}")

    def _validate_initialization(self) -> None:
        """Ensure service is initialized before use."""
        if not self._ready or self.model is None or self.processor is None:
            raise RuntimeError(
                "Service not initialized. Call init() before using generate()."
            )

    def _normalize_image(self, image: Union[np.ndarray, Image.Image]) -> Image.Image:
        """Convert input to standardized RGB PIL Image."""
        if isinstance(image, Image.Image):
            return image.convert("RGB")

        # Handle numpy arrays
        if image.ndim == 2:  # Grayscale
            return Image.fromarray(image).convert("RGB")

        # Handle color channels
        if image.shape[-1] == 4:  # RGBA
            return Image.fromarray(image[..., :3]).convert("RGB")

        if image.shape[-1] == 3:
            # Handle BGR format common in OpenCV
            if hasattr(image, 'flags') and hasattr(image.flags, 'c_contiguous') and not image.flags.c_contiguous:
                image = np.ascontiguousarray(image)
            return Image.fromarray(image[..., ::-1] if np.max(image) > 1 else image).convert("RGB")

        raise ValueError(f"Unsupported image format with shape {image.shape}")

    def generate(
            self,
            image: Union[np.ndarray, Image.Image],
            prompt: str = "Опиши изображение.",
            max_new_tokens: int = 32,
            min_pixels: int = 4 * 28 * 28,
            max_pixels: int = 1024 * 28 * 28,
    ) -> str:
        """
        Generate text description for an image.

        Args:
            image: Input image (PIL Image or numpy array in RGB/BGR format)
            prompt: Text prompt for the model
            max_new_tokens: Maximum tokens to generate
            min_pixels: Minimum image resolution for processing
            max_pixels: Maximum image resolution for processing

        Returns:
            Generated text response
        """
        self._validate_initialization()
        return self._infer(image, prompt, max_new_tokens, min_pixels, max_pixels)

    def _infer(
            self,
            image: Union[np.ndarray, Image.Image],
            prompt: str,
            max_new_tokens: int,
            min_pixels: int,
            max_pixels: int,
    ) -> str:
        """Core inference logic with proper token trimming."""
        img_pil = self._normalize_image(image)

        # Build messages with image parameters
        messages = [{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "image": img_pil,
                    "min_pixels": min_pixels,
                    "max_pixels": max_pixels,
                },
                {"type": "text", "text": prompt}
            ]
        }]

        # Prepare inputs
        chat_text = self.processor.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True
        )

        inputs = self.processor(
            text=[chat_text],
            images=[img_pil],
            min_pixels=min_pixels,
            max_pixels=max_pixels,
            padding=True,
            return_tensors="pt",
        ).to(self.device)

        # Generate response
        with torch.no_grad():
            output_ids = self.model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                pad_token_id=self.processor.tokenizer.pad_token_id,
            )

        # Trim input tokens from output
        input_length = inputs.input_ids.shape[1]
        output_ids = output_ids[:, input_length:]

        # Decode and clean response
        response = self.processor.batch_decode(
            output_ids,
            skip_special_tokens=True,
            clean_up_tokenization_spaces=True
        )[0]

        return response.strip()


    def fallback(
            self,
            img_path: str,
            prompt: str,
            max_new_tokens: int = 32,
            min_pixels: int = 4 * 28 * 28,
            max_pixels: int = 1024 * 28 * 28,
    ) -> tuple[str, str]:
        """В случае, если OCR не справилась"""

        image = Image.open(img_path)

        # Build messages with image parameters
        messages = [{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "image": image,
                    "min_pixels": min_pixels,
                    "max_pixels": max_pixels,
                },
                {"type": "text", "text": prompt}
            ]
        }]

        # Prepare inputs
        chat_text = self.processor.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True
        )

        inputs = self.processor(
            text=[chat_text],
            images=[image],
            min_pixels=min_pixels,
            max_pixels=max_pixels,
            padding=True,
            return_tensors="pt",
        ).to(self.device)

        # Generate response
        with torch.no_grad():
            output_ids = self.model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                pad_token_id=self.processor.tokenizer.pad_token_id,
            )

        # Trim input tokens from output
        input_length = inputs.input_ids.shape[1]
        output_ids = output_ids[:, input_length:]

        # Decode and clean response
        response = self.processor.batch_decode(
            output_ids,
            skip_special_tokens=True,
            clean_up_tokenization_spaces=True
        )[0]

        return response.strip(), img_path


def avision_generate_sync(
        image: Union[np.ndarray, Image.Image],
        name: str,
        prompt: str = "Опиши изображение.",
        output_dir: Optional[str] = None,
        max_new_tokens: int = 64,
        device: str = "cuda:0",
        hf_token: Optional[str] = None,
        cache_dir: Optional[str] = None,
) -> Tuple[str, str]:
    """
    Helper function for generating descriptions with image saving.

    Args:
        image: Input image
        name: Base filename for saved image
        prompt: Text prompt for generation
        output_dir: Directory to save processed images (uses /tmp if None)
        max_new_tokens: Maximum tokens to generate

    Returns:
        Tuple of (generated_text, saved_image_path)
    """
    # Initialize service (thread-safe singleton)
    svc = AvVisionServiceSync.get_instance()
    if not svc._ready:
        use_cuda = torch.cuda.is_available() and "cuda" in device
        svc.init(
            device=device,
            load_in_4bit=use_cuda,
            hf_token=hf_token or os.environ.get("HF_TOKEN"),
            cache_dir=cache_dir,
        )

    # Prepare output directory
    output_dir = output_dir or "/tmp/avision_api"
    os.makedirs(output_dir, exist_ok=True)

    # Generate unique filename
    filename = f"{name}_{uuid.uuid4().hex[:8]}.png"
    file_path = os.path.join(output_dir, filename)

    # Save image
    try:
        if isinstance(image, Image.Image):
            image.save(file_path)
        else:
            # Convert numpy array to PIL and save
            Image.fromarray(
                image[..., ::-1] if image.shape[-1] == 3 else image
            ).convert("RGB").save(file_path)
    except Exception as e:
        print(f"⚠️ Warning: Failed to save image: {str(e)}")
        file_path = "NOT_SAVED"

    # Generate description
    print(f'📝 Processing with prompt: "{prompt}"')
    try:
        text = svc.generate(
            image=image,
            prompt=prompt,
            max_new_tokens=max_new_tokens
        )
    except Exception as e:
        print(f"⚠️ Warning: Failed to generate description: {str(e)}")
        text = "NOT_GENERATED"
    return text, file_path
