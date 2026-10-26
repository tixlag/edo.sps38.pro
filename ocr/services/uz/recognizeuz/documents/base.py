from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Protocol

import numpy as np

ModelKind = Literal["yolo", "paddle_recognizer", "paddle_detector", "glm", "custom"]
StageScope = Literal["document", "field", "glyph", "debug"]
StageMode = Literal["disabled", "debug_only", "candidate", "replace"]


@dataclass(frozen=True)
class ModelRef:
    """Logical model key used by the pipeline instead of hardcoded globals."""

    key: str
    kind: ModelKind
    required: bool = True


@dataclass(frozen=True)
class IntermediateStageSpec:
    """
    Optional document-specific intermediate stage.

    Example for future migration_card FIO letter pipeline:
      key="migration_fio_letters",
      model=ModelRef("migration_fio_letter_detector", "paddle_detector"),
      applies_to_fields=frozenset({"mg_surname", "mg_name", "mg_patronymic"}),
      scope="field",
      mode="candidate" or "replace".

    The default implementation does nothing; specs make extension explicit and
    discoverable without changing the main recognition loop.
    """

    key: str
    model: ModelRef
    applies_to_fields: frozenset[str] = frozenset()
    scope: StageScope = "field"
    mode: StageMode = "disabled"
    description: str = ""
    config: dict[str, Any] = field(default_factory=dict)

    def enabled_for_field(self, field_name: str) -> bool:
        return self.mode != "disabled" and (
            not self.applies_to_fields or field_name in self.applies_to_fields
        )


class FieldPostProcessor(Protocol):
    def __call__(self, *, field_name: str, text: str) -> str: ...


@dataclass(frozen=True)
class DocumentSpec:
    doc_type: str
    field_names: frozenset[str]
    output_fields: tuple[str, ...]
    field_detector: ModelRef
    text_recognizer: ModelRef
    score_layout: Callable[[list[dict[str, Any]], tuple[int, int, int]], float]
    is_orientation_confident: Callable[[list[dict[str, Any]], float, tuple[int, int, int]], bool]
    skip_ocr_fields: frozenset[str] = frozenset()
    internal_only_fields: frozenset[str] = frozenset()
    field_labels: dict[str, str] = field(default_factory=dict)
    intermediate_stages: tuple[IntermediateStageSpec, ...] = ()
    add_cyrillic_output: bool = False
    cyrillic_converter: FieldPostProcessor | None = None

    @property
    def public_output_field_names(self) -> set[str]:
        return set(self.output_fields)

    def should_skip_ocr(self, field_name: str) -> bool:
        return field_name in self.skip_ocr_fields

    def is_internal_field(self, field_name: str) -> bool:
        return field_name in self.internal_only_fields

    def convert_to_cyrillic(self, *, field_name: str, text: str) -> str:
        if not text or not self.cyrillic_converter:
            return ""
        return self.cyrillic_converter(field_name=field_name, text=text)

    def enabled_intermediate_stages_for_field(
        self,
        field_name: str,
    ) -> tuple[IntermediateStageSpec, ...]:
        return tuple(
            stage for stage in self.intermediate_stages
            if stage.enabled_for_field(field_name)
        )


@dataclass(slots=True)
class DetectedDocument:
    raw: dict[str, Any]
    spec: DocumentSpec
    crop_bgr: np.ndarray
    oriented_bgr: np.ndarray | None = None
    fields: list[dict[str, Any]] = field(default_factory=list)
    rotation: int = 0
    orientation_score: float = 0.0
    orientation_confident: bool = False
    orientation_timing: dict[str, Any] = field(default_factory=dict)
