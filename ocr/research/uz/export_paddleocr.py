from pathlib import Path
import subprocess
import os
import shutil
from datetime import datetime


PROJECT_ROOT = Path("/home/neuro/PycharmProjects/RecognizeUZ")

# Путь к репозиторию PaddleOCR
PADDLEOCR_ROOT = Path(
    "/home/neuro/PycharmProjects/createOCRDataset/PaddleOCR_training/PaddleOCR"
)

PASSPORT_CONFIG = PROJECT_ROOT / "paddleocr/configs/rec/uz_passport_ppocrv5_mobile_rec.yml"
MIGRATION_CONFIG = PROJECT_ROOT / "paddleocr/configs/rec/uz_migration_ppocrv5_mobile_rec.yml"

PASSPORT_TRAINED_PREFIX = Path('/home/neuro/PycharmProjects/RecognizeUZ/paddleocr/output/ocr/passport_rec_v3/best_model/model')

MIGRATION_TRAINED_PREFIX = Path('/home/neuro/PycharmProjects/RecognizeUZ/paddleocr/output/ocr/migration_rec_v3/best_model/model')

PASSPORT_INFERENCE_DIR = (
    PROJECT_ROOT / "paddleocr/inference/ocr/passport_rec_v3"
)

MIGRATION_INFERENCE_DIR = (
    PROJECT_ROOT / "paddleocr/inference/ocr/migration_rec_v3"
)

PASSPORT_DICT = PROJECT_ROOT / "paddleocr_passport_rec/dict.txt"
MIGRATION_DICT = PROJECT_ROOT / "paddleocr_migration_rec/dict.txt"

LOG_DIR = PROJECT_ROOT / "logs/ocr_export"

PYTHON_BIN = "/home/neuro/PycharmProjects/createOCRDataset/.venv/bin/python"

CUDA_VISIBLE_DEVICES = "0"


# Expirements
PASSPORT_CONFIG_B_FINETUNED = PROJECT_ROOT / "paddleocr/configs/rec/uz_passport_ppocrv5_mobile_rec_exp_b_photo_aug_finetune.yml"
PASSPORT_DATASET_MORE_AUG = PROJECT_ROOT / "paddleocr_passport_rec_exp_b_photo_aug"

PASSPORT_CONFIG_B_TRAINED_PREFIX = Path('/home/neuro/PycharmProjects/RecognizeUZ/paddleocr/output/ocr/passport_rec_exp_b_photo_aug_finetune/best_model/model')
PASSPORT_CONFIG_B_INFERENCE_DIR = (
    PROJECT_ROOT / "paddleocr/inference/ocr/passport_rec_exp_b_photo_aug_finetune"
)
PASSPORT_CONFIG_B_DICT = PROJECT_ROOT / "paddleocr_passport_rec_exp_b_photo_aug/dict.txt"

#acc85%
PASSPORT_CONFIG_G_FINETUNED = Path("/home/neuro/PycharmProjects/RecognizeUZ/paddleocr/configs/rec/uz_passport_ppocrv5_mobile_rec_exp_g_hard_mix.yml")
PASSPORT_DATASET_G = PROJECT_ROOT / "paddleocr_passport_rec_exp_g_hard_mix"

PASSPORT_CONFIG_G_TRAINED_PREFIX = Path('/home/neuro/PycharmProjects/RecognizeUZ/paddleocr/output/ocr/passport_rec_exp_g_hard_mix/best_model/model')
PASSPORT_CONFIG_G_INFERENCE_DIR = (
    PROJECT_ROOT / "paddleocr/inference/ocr/passport_rec_exp_g_hard_mix"
)
PASSPORT_CONFIG_G_DICT = Path("/home/neuro/PycharmProjects/createOCRDataset/PaddleOCR_training/PaddleOCR/ppocr/utils/dict/ppocrv5_latin_dict.txt")

EXPORT_JOBS = [
    {
        "name": "passport_rec",
        "config": PASSPORT_CONFIG_G_FINETUNED,
        "trained_prefix": PASSPORT_CONFIG_G_TRAINED_PREFIX,
        "save_inference_dir": PASSPORT_CONFIG_G_INFERENCE_DIR,
        "dict_path": PASSPORT_CONFIG_G_DICT,
    },
    # {
    #     "name": "passport_rec",
    #     "config": PASSPORT_CONFIG_B_FINETUNED,
    #     "trained_prefix": PASSPORT_CONFIG_B_TRAINED_PREFIX,
    #     "save_inference_dir": PASSPORT_CONFIG_B_INFERENCE_DIR,
    #     "dict_path": PASSPORT_CONFIG_B_DICT,
    # },
    # {
    #     "name": "passport_rec",
    #     "config": PASSPORT_CONFIG,
    #     "trained_prefix": PASSPORT_TRAINED_PREFIX,
    #     "save_inference_dir": PASSPORT_INFERENCE_DIR,
    #     "dict_path": PASSPORT_DICT,
    # },
    # {
    #     "name": "migration_rec",
    #     "config": MIGRATION_CONFIG,
    #     "trained_prefix": MIGRATION_TRAINED_PREFIX,
    #     "save_inference_dir": MIGRATION_INFERENCE_DIR,
    #     "dict_path": MIGRATION_DICT,
    # },
]


def check_file(path: Path, description: str):
    if not path.exists():
        raise FileNotFoundError(f"{description} not found: {path}")


def check_trained_model_prefix(prefix: Path):
    """
    PaddleOCR export_model.py ожидает путь к модели без .pdparams:

        Global.pretrained_model=/path/to/best_accuracy

    Но физически должен существовать файл:

        /path/to/best_accuracy.pdparams
    """

    pdparams = Path(str(prefix) + ".pdparams")

    if not pdparams.exists():
        raise FileNotFoundError(
            f"Trained model weights not found: {pdparams}\n"
            f"Expected trained prefix: {prefix}"
        )

    return pdparams


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


def copy_dict_to_inference_dir(dict_path: Path, inference_dir: Path):
    """
    На всякий случай кладём dict рядом с inference-моделью.
    В норме export_model должен сохранить нужные параметры в inference.yml,
    но dict рядом с моделью полезен для контроля и ручного inference.
    """

    check_file(dict_path, "Dict file")

    inference_dir.mkdir(parents=True, exist_ok=True)

    shutil.copy2(
        dict_path,
        inference_dir / "dict.txt",
    )


def check_export_result(inference_dir: Path):
    """
    В PaddleOCR 3.x обычно появляются:
      inference.json / inference.yml / inference.pdiparams

    В некоторых версиях могут быть:
      inference.pdmodel / inference.pdiparams / inference.yml
    """

    if not inference_dir.exists():
        raise FileNotFoundError(f"Inference dir not created: {inference_dir}")

    files = {p.name for p in inference_dir.iterdir() if p.is_file()}

    has_params = (
        "inference.pdiparams" in files
        or any(name.endswith(".pdiparams") for name in files)
    )

    has_model_desc = (
        "inference.pdmodel" in files
        or "inference.json" in files
        or "inference.yml" in files
    )

    if not has_params:
        raise RuntimeError(
            f"Export looks incomplete: no inference.pdiparams in {inference_dir}. "
            f"Files: {sorted(files)}"
        )

    if not has_model_desc:
        raise RuntimeError(
            f"Export looks incomplete: no model description file in {inference_dir}. "
            f"Files: {sorted(files)}"
        )

    print(f"Export OK: {inference_dir}")
    print("Files:")
    for name in sorted(files):
        print(f"  {name}")


def export_job(job: dict):
    name = job["name"]
    config = job["config"]
    trained_prefix = job["trained_prefix"]
    save_inference_dir = job["save_inference_dir"]
    dict_path = job["dict_path"]

    print()
    print("#" * 100)
    print(f"START EXPORT: {name}")
    print("#" * 100)

    check_file(config, "Config")
    check_file(PADDLEOCR_ROOT / "tools/export_model.py", "PaddleOCR export_model.py")
    check_trained_model_prefix(trained_prefix)
    check_file(dict_path, "Dict")

    save_inference_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_path = LOG_DIR / f"{timestamp}_{name}_export.log"

    command = [
        PYTHON_BIN,
        "tools/export_model.py",
        "-c",
        str(config),
        "-o",
        f"Global.pretrained_model={trained_prefix}",
        f"Global.save_inference_dir={save_inference_dir}",
    ]

    run_command(
        command=command,
        cwd=PADDLEOCR_ROOT,
        log_path=log_path,
    )

    copy_dict_to_inference_dir(
        dict_path=dict_path,
        inference_dir=save_inference_dir,
    )

    check_export_result(save_inference_dir)

    print()
    print("#" * 100)
    print(f"FINISHED EXPORT: {name}")
    print("#" * 100)


def main():
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    check_file(Path(PYTHON_BIN), "Python binary")
    check_file(PADDLEOCR_ROOT, "PaddleOCR root")
    check_file(PADDLEOCR_ROOT / "tools/export_model.py", "PaddleOCR export_model.py")

    print(f"Python: {PYTHON_BIN}")
    print(f"Project root: {PROJECT_ROOT}")
    print(f"PaddleOCR root: {PADDLEOCR_ROOT}")
    print(f"CUDA_VISIBLE_DEVICES={CUDA_VISIBLE_DEVICES}")

    for job in EXPORT_JOBS:
        export_job(job)

    print()
    print("All OCR models exported successfully.")
    print(f"Passport inference:  {PASSPORT_INFERENCE_DIR}")
    print(f"Migration inference: {MIGRATION_INFERENCE_DIR}")


if __name__ == "__main__":
    main()
