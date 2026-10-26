from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import time
from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path("/home/neuro/PycharmProjects/RecognizeUZ")

PADDLEOCR_ROOT = Path(
    "/home/neuro/PycharmProjects/createOCRDataset/PaddleOCR_training/PaddleOCR"
)

PYTHON_BIN = "/home/neuro/PycharmProjects/createOCRDataset/.venv/bin/python"

CUDA_VISIBLE_DEVICES = "0"

LOG_DIR = PROJECT_ROOT / "logs/ocr_train"

PASSPORT_DATASET = PROJECT_ROOT / "paddleocr_passport_rec_exp_b_photo_aug"

PASSPORT_CONFIG_C_MORE_AUG = (
    PROJECT_ROOT
    / "paddleocr/configs/rec/uz_passport_ppocrv5_mobile_rec_exp_c_latin_low_lr_more_aug.yml"
)

TRAIN_JOBS = [
    {
        "name": "passport_rec_exp_c_latin_low_lr_more_aug",
        "config": PASSPORT_CONFIG_C_MORE_AUG,
        "dataset": PASSPORT_DATASET,
    },
]


# =============================================================================
# EARLY STOP SETTINGS
# =============================================================================

EARLY_STOP_ENABLED = True

# Обычно для PaddleOCR лучше мониторить acc.
# Можно заменить на "norm_edit_dis".
MONITOR_METRIC = "acc"

# "max" для acc/norm_edit_dis, "min" для loss.
MONITOR_MODE = "max"

# Улучшение меньше этого значения не считается прогрессом.
MIN_DELTA = 0.001

# Сколько validation-проверок подряд ждать без прогресса.
PATIENCE_EVALS = 6

# Минимальное количество validation-проверок перед тем, как разрешить early stop.
MIN_EVALS_BEFORE_STOP = 8

# Минимальная эпоха перед тем, как разрешить early stop.
MIN_EPOCH_BEFORE_STOP = 3

# Если True, остановка будет через SIGINT, затем SIGTERM/SIGKILL при необходимости.
GRACEFUL_STOP = True

# Сколько секунд ждать после SIGINT.
WAIT_AFTER_SIGINT_SECONDS = 30

# Сколько секунд ждать после SIGTERM.
WAIT_AFTER_SIGTERM_SECONDS = 10


# =============================================================================
# REGEX
# =============================================================================

# Примеры строк PaddleOCR:
# [2026/05/28 13:05:04] ppocr INFO: best metric, acc: 0.520446086980556, is_float16: False, norm_edit_dis: 0.9163141512474123, fps: 121.7541642748317, best_epoch: 21
# [2026/05/28 00:38:52] ppocr INFO: cur metric, acc: 0.412639405204461, norm_edit_dis: 0.9123, fps: 120.1
METRIC_LINE_RE = re.compile(
    r"(cur metric|best metric),\s*(?P<body>.*)",
    re.IGNORECASE,
)

KV_RE = re.compile(
    r"(?P<key>[a-zA-Z_][a-zA-Z0-9_]*):\s*(?P<value>[^,\s]+)"
)

EPOCH_RE = re.compile(
    r"epoch:\s*\[(?P<epoch>\d+)/(?P<epoch_total>\d+)\]",
    re.IGNORECASE,
)

GLOBAL_STEP_RE = re.compile(
    r"global_step:\s*(?P<step>\d+)",
    re.IGNORECASE,
)


# =============================================================================
# DATA CLASSES
# =============================================================================

@dataclass
class EarlyStopState:
    enabled: bool
    monitor_metric: str
    monitor_mode: str
    min_delta: float
    patience_evals: int
    min_evals_before_stop: int
    min_epoch_before_stop: int

    best_value: float | None = None
    best_epoch: int | None = None
    best_eval_index: int | None = None
    eval_count: int = 0
    bad_eval_count: int = 0
    current_epoch: int | None = None
    current_global_step: int | None = None
    stopped_early: bool = False
    stop_reason: str | None = None

    history: list[dict[str, Any]] | None = None

    def __post_init__(self) -> None:
        if self.history is None:
            self.history = []

    def is_better(self, value: float) -> bool:
        if self.best_value is None:
            return True

        if self.monitor_mode == "max":
            return value > self.best_value + self.min_delta

        if self.monitor_mode == "min":
            return value < self.best_value - self.min_delta

        raise ValueError(f"Unsupported monitor_mode: {self.monitor_mode}")

    def update_from_metrics(self, metrics: dict[str, Any]) -> tuple[bool, str]:
        """
        Returns:
            should_stop, message
        """

        if not self.enabled:
            return False, "early stopping disabled"

        if self.monitor_metric not in metrics:
            return False, f"metric {self.monitor_metric!r} not found"

        try:
            value = float(metrics[self.monitor_metric])
        except Exception:
            return False, f"metric {self.monitor_metric!r} is not numeric: {metrics[self.monitor_metric]!r}"

        self.eval_count += 1

        epoch = self.current_epoch
        if "best_epoch" in metrics:
            try:
                epoch = int(float(metrics["best_epoch"]))
            except Exception:
                pass

        item = {
            "eval_index": self.eval_count,
            "epoch": self.current_epoch,
            "global_step": self.current_global_step,
            "monitor_metric": self.monitor_metric,
            "monitor_value": value,
            "metrics": metrics,
            "best_value_before": self.best_value,
            "bad_eval_count_before": self.bad_eval_count,
        }

        if self.is_better(value):
            self.best_value = value
            self.best_epoch = self.current_epoch
            self.best_eval_index = self.eval_count
            self.bad_eval_count = 0

            item["improved"] = True
            item["best_value_after"] = self.best_value
            item["bad_eval_count_after"] = self.bad_eval_count

            assert self.history is not None
            self.history.append(item)

            return False, (
                f"improved {self.monitor_metric}: {value:.8f}; "
                f"best={self.best_value:.8f}; eval={self.eval_count}"
            )

        self.bad_eval_count += 1

        item["improved"] = False
        item["best_value_after"] = self.best_value
        item["bad_eval_count_after"] = self.bad_eval_count

        assert self.history is not None
        self.history.append(item)

        if self.eval_count < self.min_evals_before_stop:
            return False, (
                f"no improvement; bad_evals={self.bad_eval_count}/{self.patience_evals}; "
                f"eval_count={self.eval_count} < min_evals_before_stop={self.min_evals_before_stop}"
            )

        if self.current_epoch is not None and self.current_epoch < self.min_epoch_before_stop:
            return False, (
                f"no improvement; bad_evals={self.bad_eval_count}/{self.patience_evals}; "
                f"epoch={self.current_epoch} < min_epoch_before_stop={self.min_epoch_before_stop}"
            )

        if self.bad_eval_count >= self.patience_evals:
            self.stopped_early = True
            self.stop_reason = (
                f"No improvement in {self.monitor_metric} for "
                f"{self.bad_eval_count} evals. "
                f"Best={self.best_value}, best_eval={self.best_eval_index}, "
                f"best_epoch={self.best_epoch}"
            )
            return True, self.stop_reason

        return False, (
            f"no improvement; bad_evals={self.bad_eval_count}/{self.patience_evals}; "
            f"best={self.best_value}"
        )


# =============================================================================
# HELPERS
# =============================================================================

def check_file(path: Path, description: str) -> None:
    if not path.exists():
        raise FileNotFoundError(f"{description} not found: {path}")


def count_non_empty_lines(path: Path) -> int:
    return sum(
        1
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    )


def check_dataset(dataset_dir: Path) -> None:
    check_file(dataset_dir, "Dataset directory")
    check_file(dataset_dir / "rec_gt_train.txt", "Train label file")
    check_file(dataset_dir / "rec_gt_val.txt", "Val label file")
    check_file(dataset_dir / "dict.txt", "Dict file")

    train_count = count_non_empty_lines(dataset_dir / "rec_gt_train.txt")
    val_count = count_non_empty_lines(dataset_dir / "rec_gt_val.txt")
    dict_count = count_non_empty_lines(dataset_dir / "dict.txt")

    if train_count == 0:
        raise RuntimeError(f"Empty train labels: {dataset_dir / 'rec_gt_train.txt'}")

    if val_count == 0:
        raise RuntimeError(f"Empty val labels: {dataset_dir / 'rec_gt_val.txt'}")

    if dict_count == 0:
        raise RuntimeError(f"Empty dict: {dataset_dir / 'dict.txt'}")

    print(f"Dataset OK: {dataset_dir}")
    print(f"  train samples: {train_count}")
    print(f"  val samples:   {val_count}")
    print(f"  dict chars:    {dict_count}")


def parse_float_or_str(value: str) -> Any:
    value = value.strip()

    if value.lower() == "true":
        return True

    if value.lower() == "false":
        return False

    if value.lower() == "none":
        return None

    try:
        if "." in value or "e" in value.lower():
            return float(value)
        return int(value)
    except Exception:
        return value


def parse_metric_line(line: str) -> dict[str, Any] | None:
    match = METRIC_LINE_RE.search(line)

    if not match:
        return None

    body = match.group("body")
    metrics: dict[str, Any] = {
        "_metric_line_type": match.group(1).lower(),
    }

    for kv in KV_RE.finditer(body):
        key = kv.group("key")
        value = parse_float_or_str(kv.group("value"))
        metrics[key] = value

    return metrics


def parse_epoch_and_step(line: str) -> tuple[int | None, int | None]:
    epoch = None
    step = None

    epoch_match = EPOCH_RE.search(line)
    if epoch_match:
        epoch = int(epoch_match.group("epoch"))

    step_match = GLOBAL_STEP_RE.search(line)
    if step_match:
        step = int(step_match.group("step"))

    return epoch, step


def terminate_process(process: subprocess.Popen, log_file) -> None:
    if process.poll() is not None:
        return

    if GRACEFUL_STOP:
        print("\nEARLY STOP: sending SIGINT...\n")
        log_file.write("\nEARLY STOP: sending SIGINT...\n")
        log_file.flush()

        try:
            os.killpg(os.getpgid(process.pid), signal.SIGINT)
        except Exception:
            process.send_signal(signal.SIGINT)

        try:
            process.wait(timeout=WAIT_AFTER_SIGINT_SECONDS)
            return
        except subprocess.TimeoutExpired:
            pass

    if process.poll() is not None:
        return

    print("\nEARLY STOP: sending SIGTERM...\n")
    log_file.write("\nEARLY STOP: sending SIGTERM...\n")
    log_file.flush()

    try:
        os.killpg(os.getpgid(process.pid), signal.SIGTERM)
    except Exception:
        process.terminate()

    try:
        process.wait(timeout=WAIT_AFTER_SIGTERM_SECONDS)
        return
    except subprocess.TimeoutExpired:
        pass

    if process.poll() is not None:
        return

    print("\nEARLY STOP: sending SIGKILL...\n")
    log_file.write("\nEARLY STOP: sending SIGKILL...\n")
    log_file.flush()

    try:
        os.killpg(os.getpgid(process.pid), signal.SIGKILL)
    except Exception:
        process.kill()

    process.wait()


def write_summary(
    summary_path: Path,
    state: EarlyStopState,
    job: dict[str, Any],
    log_path: Path,
    return_code: int | None,
    started_at: str,
    finished_at: str,
) -> None:
    summary = {
        "job": {
            "name": job["name"],
            "config": str(job["config"]),
            "dataset": str(job["dataset"]),
        },
        "log_path": str(log_path),
        "started_at": started_at,
        "finished_at": finished_at,
        "return_code": return_code,
        "early_stop": asdict(state),
    }

    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


# =============================================================================
# TRAINING
# =============================================================================

def run_command_with_early_stop(
    *,
    command: list[str],
    cwd: Path,
    log_path: Path,
    job: dict[str, Any],
) -> None:
    env = os.environ.copy()
    env["CUDA_VISIBLE_DEVICES"] = CUDA_VISIBLE_DEVICES

    state = EarlyStopState(
        enabled=EARLY_STOP_ENABLED,
        monitor_metric=MONITOR_METRIC,
        monitor_mode=MONITOR_MODE,
        min_delta=MIN_DELTA,
        patience_evals=PATIENCE_EVALS,
        min_evals_before_stop=MIN_EVALS_BEFORE_STOP,
        min_epoch_before_stop=MIN_EPOCH_BEFORE_STOP,
    )

    started_at = datetime.now().isoformat(timespec="seconds")

    print()
    print("=" * 100)
    print("COMMAND:")
    print(" ".join(command))
    print(f"CWD: {cwd}")
    print(f"LOG: {log_path}")
    print("EARLY STOP:")
    print(f"  enabled: {EARLY_STOP_ENABLED}")
    print(f"  monitor_metric: {MONITOR_METRIC}")
    print(f"  monitor_mode: {MONITOR_MODE}")
    print(f"  min_delta: {MIN_DELTA}")
    print(f"  patience_evals: {PATIENCE_EVALS}")
    print(f"  min_evals_before_stop: {MIN_EVALS_BEFORE_STOP}")
    print(f"  min_epoch_before_stop: {MIN_EPOCH_BEFORE_STOP}")
    print("=" * 100)
    print()

    log_path.parent.mkdir(parents=True, exist_ok=True)

    return_code: int | None = None

    with log_path.open("w", encoding="utf-8") as log_file:
        log_file.write("=" * 100 + "\n")
        log_file.write("COMMAND:\n")
        log_file.write(" ".join(command) + "\n")
        log_file.write(f"CWD: {cwd}\n")
        log_file.write(f"started_at: {started_at}\n")
        log_file.write("=" * 100 + "\n\n")
        log_file.flush()

        process = subprocess.Popen(
            command,
            cwd=str(cwd),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            preexec_fn=os.setsid if os.name != "nt" else None,
        )

        assert process.stdout is not None

        should_stop = False

        for line in process.stdout:
            print(line, end="")
            log_file.write(line)
            log_file.flush()

            epoch, step = parse_epoch_and_step(line)

            if epoch is not None:
                state.current_epoch = epoch

            if step is not None:
                state.current_global_step = step

            metrics = parse_metric_line(line)

            if metrics is None:
                continue

            # Нам важны validation lines. В PaddleOCR это обычно "cur metric".
            # "best metric" в конце тоже можно записать, но early stopping лучше считать по cur metric.
            metric_line_type = str(metrics.get("_metric_line_type", ""))

            if metric_line_type != "cur metric":
                continue

            should_stop, message = state.update_from_metrics(metrics)

            monitor_msg = (
                f"\n[EARLY_STOP_MONITOR] {message}; "
                f"epoch={state.current_epoch}; "
                f"global_step={state.current_global_step}; "
                f"eval_count={state.eval_count}; "
                f"bad_eval_count={state.bad_eval_count}\n"
            )

            print(monitor_msg, end="")
            log_file.write(monitor_msg)
            log_file.flush()

            if should_stop:
                terminate_process(process, log_file)
                break

        if process.poll() is None:
            return_code = process.wait()
        else:
            return_code = process.poll()

    finished_at = datetime.now().isoformat(timespec="seconds")

    summary_path = log_path.with_suffix(".early_stop_summary.json")

    write_summary(
        summary_path=summary_path,
        state=state,
        job=job,
        log_path=log_path,
        return_code=return_code,
        started_at=started_at,
        finished_at=finished_at,
    )

    print()
    print("=" * 100)
    print("TRAINING FINISHED")
    print(f"return_code: {return_code}")
    print(f"early_stopped: {state.stopped_early}")
    print(f"best_{MONITOR_METRIC}: {state.best_value}")
    print(f"best_eval_index: {state.best_eval_index}")
    print(f"best_epoch: {state.best_epoch}")
    print(f"summary: {summary_path}")
    print("=" * 100)
    print()

    if return_code != 0 and not state.stopped_early:
        raise RuntimeError(
            f"Command failed with exit code {return_code}. Log: {log_path}"
        )


def train_job(job: dict[str, Any]) -> None:
    name = job["name"]
    config = Path(job["config"])
    dataset = Path(job["dataset"])

    print()
    print("#" * 100)
    print(f"START TRAINING: {name}")
    print("#" * 100)

    check_file(config, "Config")
    check_dataset(dataset)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_path = LOG_DIR / f"{timestamp}_{name}.log"

    command = [
        PYTHON_BIN,
        "tools/train.py",
        "-c",
        str(config),
    ]

    run_command_with_early_stop(
        command=command,
        cwd=PADDLEOCR_ROOT,
        log_path=log_path,
        job=job,
    )

    print()
    print("#" * 100)
    print(f"FINISHED TRAINING: {name}")
    print("#" * 100)


def main() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    check_file(Path(PYTHON_BIN), "Python binary")
    check_file(PADDLEOCR_ROOT / "tools/train.py", "PaddleOCR train.py")

    print(f"Python: {PYTHON_BIN}")
    print(f"Project root: {PROJECT_ROOT}")
    print(f"PaddleOCR root: {PADDLEOCR_ROOT}")
    print(f"CUDA_VISIBLE_DEVICES={CUDA_VISIBLE_DEVICES}")

    for job in TRAIN_JOBS:
        train_job(job)

    print()
    print("All OCR training jobs completed.")


if __name__ == "__main__":
    main()
