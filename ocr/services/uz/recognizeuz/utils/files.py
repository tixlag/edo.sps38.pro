from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import tempfile
import time
import unicodedata
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

import cv2
import numpy as np
import requests
from PIL import Image, ImageEnhance, ImageFilter, ImageOps

def safe_filename_part(value: str, max_len: int = 80) -> str:
    value = re.sub(r"[^a-zA-Z0-9а-яА-ЯёЁ._-]+", "_", value)
    value = value.strip("._-")
    return value[:max_len] or "empty"

def append_unique_line(path: Path, line: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    if path.exists():
        with path.open("r", encoding="utf-8") as f:
            for existing in f:
                if existing.rstrip("\n") == line.rstrip("\n"):
                    return

    with path.open("a", encoding="utf-8") as f:
        f.write(line)
