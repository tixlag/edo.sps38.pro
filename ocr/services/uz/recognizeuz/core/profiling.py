from __future__ import annotations

import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Iterator


@dataclass(slots=True)
class StageProfile:
    name: str
    seconds: float
    meta: dict[str, Any] = field(default_factory=dict)


class PipelineProfiler:
    """
    Lightweight profiler for request/debug mode.

    It does not replace old debug timing keys; it adds a structured trace that
    makes intermediate stages measurable without hand-writing new fields each
    time a stage is added.
    """

    def __init__(self, enabled: bool = False) -> None:
        self.enabled = enabled
        self._events: list[StageProfile] = []

    @contextmanager
    def stage(self, name: str, **meta: Any) -> Iterator[dict[str, Any]]:
        started = time.perf_counter()
        bucket: dict[str, Any] = {}
        try:
            yield bucket
        finally:
            seconds = round(time.perf_counter() - started, 6)
            if self.enabled:
                merged_meta = {**meta, **bucket}
                self._events.append(StageProfile(name=name, seconds=seconds, meta=merged_meta))

    def add(self, name: str, seconds: float, **meta: Any) -> None:
        if self.enabled:
            self._events.append(StageProfile(name=name, seconds=float(seconds), meta=meta))

    def as_list(self) -> list[dict[str, Any]]:
        return [
            {
                "stage": event.name,
                "seconds": event.seconds,
                "meta": event.meta,
            }
            for event in self._events
        ]

    def total_by_stage(self) -> dict[str, float]:
        totals: dict[str, float] = {}
        for event in self._events:
            totals[event.name] = round(totals.get(event.name, 0.0) + event.seconds, 6)
        return totals
