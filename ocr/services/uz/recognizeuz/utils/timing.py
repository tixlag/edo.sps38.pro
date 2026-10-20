from __future__ import annotations

import time

def score_to_unit(score: float) -> float:
    """Поддержка обоих форматов: 0.95 и 95."""
    if score > 1.0:
        return score / 100.0
    return score

def elapsed_seconds(start: float) -> float:
    """Монотонное время в секундах для debug-профилирования."""
    return round(time.perf_counter() - start, 6)
