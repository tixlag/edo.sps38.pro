from __future__ import annotations

from typing import Any

from recognizeuz.core import resources
from recognizeuz.documents.base import DocumentSpec, IntermediateStageSpec
from recognizeuz.pipeline.stages.migration_fio_grid import run_migration_fio_grid_stage
from recognizeuz.pipeline.types import DocumentContext


def apply_intermediate_field_stages(
    *,
    spec: DocumentSpec,
    ctx: DocumentContext,
    field_name: str,
    field_crop_bgr: Any,
    item: dict[str, Any],
) -> None:
    """
    Extension hook for document-specific refinement stages.

    The pipeline stays generic: document specs declare stages, this dispatcher
    connects stage keys to explicit handlers. Unknown/half-configured stages are
    reported in debug instead of silently changing production behavior.
    """

    enabled = spec.enabled_intermediate_stages_for_field(field_name)
    if not enabled:
        return

    item.setdefault("intermediate", [])

    for stage in enabled:
        if _run_known_stage(
            stage=stage,
            ctx=ctx,
            field_name=field_name,
            field_crop_bgr=field_crop_bgr,
            item=item,
        ):
            continue

        model = resources.model_registry.get_optional(stage.model.key)
        if model is None and stage.model.required:
            item["intermediate"].append(
                {
                    "stage": stage.key,
                    "status": "model_missing",
                    "model_key": stage.model.key,
                    "mode": stage.mode,
                }
            )
            continue

        item["intermediate"].append(
            {
                "stage": stage.key,
                "status": "handler_not_implemented",
                "model_key": stage.model.key,
                "mode": stage.mode,
            }
        )


def _run_known_stage(
    *,
    stage: IntermediateStageSpec,
    ctx: DocumentContext,
    field_name: str,
    field_crop_bgr: Any,
    item: dict[str, Any],
) -> bool:
    if stage.key == "migration_fio_grid_letters":
        run_migration_fio_grid_stage(
            ctx=ctx,
            field_name=field_name,
            field_crop_bgr=field_crop_bgr,
            item=item,
            mode=stage.mode,
        )
        return True

    return False
