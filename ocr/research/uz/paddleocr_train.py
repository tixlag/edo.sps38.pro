from pathlib import Path
import subprocess
import sys
import os
from datetime import datetime


PROJECT_ROOT = Path("/home/neuro/PycharmProjects/RecognizeUZ")

# Путь к репозиторию PaddleOCR
PADDLEOCR_ROOT = Path('/home/neuro/PycharmProjects/createOCRDataset/PaddleOCR_training/PaddleOCR')

PASSPORT_CONFIG = PROJECT_ROOT / "paddleocr/configs/rec/uz_passport_ppocrv5_mobile_rec.yml"
MIGRATION_CONFIG = PROJECT_ROOT / "paddleocr/configs/rec/uz_migration_ppocrv5_mobile_rec.yml"

PASSPORT_DATASET = PROJECT_ROOT / "paddleocr_passport_rec"
MIGRATION_DATASET = PROJECT_ROOT / "paddleocr_migration_rec"

LOG_DIR = PROJECT_ROOT / "logs/ocr_train"

PYTHON_BIN = '/home/neuro/PycharmProjects/createOCRDataset/.venv/bin/python'

CUDA_VISIBLE_DEVICES = "0"


# Expeeriments
PASSPORT_CONFIG_A = PROJECT_ROOT / "paddleocr/configs/rec/uz_passport_ppocrv5_mobile_rec_exp_a_latin_dict.yml"
PASSPORT_CONFIG_B = PROJECT_ROOT / "paddleocr/configs/rec/uz_passport_ppocrv5_mobile_rec_exp_b_ctc_only.yml"


PASSPORT_CONFIG_B_FINETUNED = PROJECT_ROOT / "paddleocr/configs/rec/uz_passport_ppocrv5_mobile_rec_exp_b_photo_aug_finetune.yml"
PASSPORT_DATASET_MORE_AUG = PROJECT_ROOT / "paddleocr_passport_rec_exp_b_photo_aug"


PASSPORT_CONFIG_C_MORE_AUG = PROJECT_ROOT / "paddleocr/configs/rec/uz_passport_ppocrv5_mobile_rec_exp_c_latin_low_lr_more_aug.yml"


TRAIN_JOBS_PASS_EXP = [
    # {
    #     "name": "passport_rec_exp_a_latin_dict",
    #     "config": PASSPORT_CONFIG_A,
    #     "dataset": PASSPORT_DATASET,
    # },
    # {
    #     "name": "passport_rec_exp_b_ctc_only",
    #     "config": PASSPORT_CONFIG_B,
    #     "dataset": PASSPORT_DATASET,
    # },
    # {
    #     "name": "passport_rec_exp_b_ctc_only",
    #     "config": PASSPORT_CONFIG_B_FINETUNED,
    #     "dataset": PASSPORT_DATASET_MORE_AUG,
    # },
    {
        "name": "passport_rec_exp_b_ctc_only",
        "config": PASSPORT_CONFIG_C_MORE_AUG,
        "dataset": PASSPORT_DATASET_MORE_AUG,
    },
]

TRAIN_JOBS = [
    {
        "name": "passport_rec",
        "config": PASSPORT_CONFIG,
        "dataset": PASSPORT_DATASET,
    },
    {
        "name": "migration_rec",
        "config": MIGRATION_CONFIG,
        "dataset": MIGRATION_DATASET,
    },
]


def check_file(path: Path, description: str):
    if not path.exists():
        raise FileNotFoundError(f"{description} not found: {path}")


def check_dataset(dataset_dir: Path):
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


def count_non_empty_lines(path: Path) -> int:
    return sum(
        1
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    )


def run_command(command: list[str], cwd: Path, log_path: Path):
    env = os.environ.copy()
    env["CUDA_VISIBLE_DEVICES"] = CUDA_VISIBLE_DEVICES

    print()
    print("=" * 100)
    print("COMMAND:")
    print(" ".join(command))
    print(f"CWD: {cwd}")
    print(f"LOG: {log_path}")
    print("=" * 100)
    print()

    with log_path.open("w", encoding="utf-8") as log_file:
        process = subprocess.Popen(
            command,
            cwd=str(cwd),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        assert process.stdout is not None

        for line in process.stdout:
            print(line, end="")
            log_file.write(line)
            log_file.flush()

        return_code = process.wait()

    if return_code != 0:
        raise RuntimeError(
            f"Command failed with exit code {return_code}. Log: {log_path}"
        )


def train_job(job: dict):
    name = job["name"]
    config = job["config"]
    dataset = job["dataset"]

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

    run_command(
        command=command,
        cwd=PADDLEOCR_ROOT,
        log_path=log_path,
    )

    print()
    print("#" * 100)
    print(f"FINISHED TRAINING: {name}")
    print("#" * 100)


def main():
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    check_file(PADDLEOCR_ROOT / "tools/train.py", "PaddleOCR train.py")

    print(f"Python: {PYTHON_BIN}")
    print(f"Project root: {PROJECT_ROOT}")
    print(f"PaddleOCR root: {PADDLEOCR_ROOT}")
    print(f"CUDA_VISIBLE_DEVICES={CUDA_VISIBLE_DEVICES}")

    for job in TRAIN_JOBS_PASS_EXP:
        train_job(job)

    print()
    print("All OCR models trained successfully.")


if __name__ == "__main__":
    main()
