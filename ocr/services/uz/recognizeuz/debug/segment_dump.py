from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import cv2
import numpy as np


def _slug(value: Any, *, max_len: int = 80) -> str:
    text = str(value)
    text = re.sub(r"[^0-9A-Za-zА-Яа-яЁё_.-]+", "_", text).strip("_")
    if not text:
        text = "item"
    return text[:max_len]


def _jsonable(value: Any) -> Any:
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, (np.integer, np.floating)):
        return value.item()
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_jsonable(v) for v in value]
    return value


@dataclass(slots=True)
class SegmentDumpSession:
    """
    Request-scoped image dump for debugging OCR pipelines.

    The object is intentionally cheap when disabled: every public method returns
    immediately and the hot production path pays only one boolean check.
    """

    enabled: bool = False
    root_dir: Path | None = None
    run_id: str | None = None
    _counter: int = 0
    _manifest: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def create(
        cls,
        *,
        enabled: bool,
        root_dir: Path,
        run_id: str | None = None,
    ) -> "SegmentDumpSession":
        if not enabled:
            return cls(enabled=False)

        if run_id is None:
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S_%fZ")
            run_id = f"{stamp}_{uuid.uuid4().hex[:8]}"

        run_dir = root_dir / run_id
        run_dir.mkdir(parents=True, exist_ok=True)
        return cls(enabled=True, root_dir=run_dir, run_id=run_id)

    @property
    def run_dir(self) -> str | None:
        return str(self.root_dir) if self.root_dir is not None else None

    def save_image(
        self,
        *,
        stage: str,
        image_bgr: np.ndarray | None,
        meta: dict[str, Any] | None = None,
        name_parts: list[Any] | tuple[Any, ...] = (),
        ext: str = "png",
    ) -> dict[str, Any] | None:
        if not self.enabled or self.root_dir is None or image_bgr is None:
            return None

        if not isinstance(image_bgr, np.ndarray) or image_bgr.size == 0:
            return None

        self._counter += 1
        stage_slug = _slug(stage.replace(".", "/"), max_len=160)
        # Keep nested stage paths readable: document/orientation/input.
        stage_dir = self.root_dir / Path(stage_slug)
        stage_dir.mkdir(parents=True, exist_ok=True)

        parts = [_slug(part) for part in name_parts if part is not None and str(part) != ""]
        stem = "__".join([f"{self._counter:05d}", *parts])
        image_path = stage_dir / f"{stem}.{ext.lstrip('.')}"
        json_path = stage_dir / f"{stem}.json"

        ok = cv2.imwrite(str(image_path), image_bgr)
        if not ok:
            return None

        record = {
            "index": self._counter,
            "stage": stage,
            "image_path": str(image_path),
            "shape": list(image_bgr.shape),
            "meta": _jsonable(meta or {}),
        }
        json_path.write_text(
            json.dumps(record, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        self._manifest.append(record)
        self._write_manifest()
        return record

    def add_event(
        self,
        *,
        stage: str,
        meta: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        if not self.enabled or self.root_dir is None:
            return None

        self._counter += 1
        record = {
            "index": self._counter,
            "stage": stage,
            "image_path": None,
            "shape": None,
            "meta": _jsonable(meta or {}),
        }
        self._manifest.append(record)
        self._write_manifest()
        return record

    def as_debug_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "run_id": self.run_id,
            "run_dir": self.run_dir,
            "items_count": len(self._manifest),
        }

    def manifest(self) -> list[dict[str, Any]]:
        return list(self._manifest)

    def _write_manifest(self) -> None:
        if not self.enabled or self.root_dir is None:
            return
        manifest_path = self.root_dir / "manifest.json"
        manifest_path.write_text(
            json.dumps(self._manifest, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
