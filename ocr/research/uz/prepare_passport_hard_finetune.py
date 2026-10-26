from __future__ import annotations

import json
import random
import re
import shutil
from dataclasses import dataclass
from pathlib import Path


# =============================================================================
# PATHS
# =============================================================================

PROJECT_ROOT = Path("/home/neuro/PycharmProjects/RecognizeUZ")

PADDLEOCR_ROOT = Path(
    "/home/neuro/PycharmProjects/createOCRDataset/PaddleOCR_training/PaddleOCR"
)

PADDLE_PYTHON = Path(
    "/home/neuro/PycharmProjects/createOCRDataset/.venv/bin/python"
)

PROJECT_PYTHON = Path(
    "/home/neuro/PycharmProjects/RecognizeUZ/venv/bin/python"
)

# Лучшая текущая модель, от которой дообучаемся.
BEST_OUTPUT_DIR = (
    PROJECT_ROOT
    / "paddleocr/output/ocr/passport_rec_exp_c_latin_low_lr_more_aug"
)

# Старый хороший OCR dataset.
BASE_DATASET = PROJECT_ROOT / "paddleocr_passport_rec_exp_b_photo_aug"

# Новый датасет ошибок.
HARD_LABELS = (
    PROJECT_ROOT
    / "datasets/ocr_improve/passport/labels.txt"
)

HARD_DATASET_ROOT = HARD_LABELS.parent

# Новый смешанный dataset.
OUT_DATASET = PROJECT_ROOT / "paddleocr_passport_rec_exp_g_hard_mix"

# Новый config.
OUT_CONFIG = (
    PROJECT_ROOT
    / "paddleocr/configs/rec/uz_passport_ppocrv5_mobile_rec_exp_g_hard_mix.yml"
)

# Куда PaddleOCR будет сохранять checkpoint'ы.
OUT_MODEL_DIR = (
    PROJECT_ROOT
    / "paddleocr/output/ocr/passport_rec_exp_g_hard_mix"
)

# Куда экспортируем inference model.
OUT_INFERENCE_DIR = (
    PROJECT_ROOT
    / "paddleocr/inference/ocr/passport_rec_exp_g_hard_mix"
)

# ВАЖНО: Experiment C обучался на большом ppocrv5 latin dict.
PP_OCRV5_LATIN_DICT = (
    PADDLEOCR_ROOT
    / "ppocr/utils/dict/ppocrv5_latin_dict.txt"
)

EVALUATOR = PROJECT_ROOT / "paddleocr/evaluate_finetuned_ocr_baseline.py"


# =============================================================================
# SETTINGS
# =============================================================================

SEED = 42
CLEAR_OUTPUT_DATASET = True

# Делим hard-блоки на train/val.
HARD_TRAIN_RATIO = 0.9

# В новом hard labels.txt уже есть orig + aug01 + aug02 + aug03.
# Поэтому НЕ надо повторять hard examples 3 раза.
HARD_REPEAT = 1

# Старый train добавляем целиком, чтобы модель не забыла обычные кейсы.
USE_FULL_BASE_TRAIN = True

# 0 = весь старый train.
# Можно поставить, например, 30000, если надо ускорить.
BASE_TRAIN_MAX_ROWS = 0

# Мягкий fine-tune.
EPOCH_NUM = 12
LEARNING_RATE = 0.000005
WARMUP_EPOCH = 1
L2_FACTOR = 0.0001

BATCH_SIZE = 16
EVAL_BATCH_SIZE = 16

REC_IMAGE_SHAPE = [3, 48, 768]
MAX_TEXT_LENGTH = 80

# Early stopping в самом PaddleOCR нет, но config будет eval каждые 500 шагов.
# Лучше запускать через твой train_pipeline_v2.py / early-stop wrapper,
# либо вручную остановить, когда hard-val перестал расти.
EVAL_EVERY_STEPS = 500


# =============================================================================
# DATA
# =============================================================================

@dataclass(frozen=True)
class Row:
    image_rel: str
    text: str


def fail(message: str) -> None:
    raise RuntimeError(message)


def check_file(path: Path, name: str) -> None:
    if not path.exists() or not path.is_file():
        raise FileNotFoundError(f"{name} not found: {path}")


def check_dir(path: Path, name: str) -> None:
    if not path.exists() or not path.is_dir():
        raise FileNotFoundError(f"{name} not found: {path}")


def read_label_file(path: Path) -> list[Row]:
    check_file(path, "Label file")

    rows: list[Row] = []

    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue

        if "\t" not in line:
            raise ValueError(f"Bad label line without TAB: {path}:{line_no}: {line}")

        image_rel, text = line.split("\t", 1)

        image_rel = image_rel.strip()
        text = text.strip()

        if not image_rel:
            raise ValueError(f"Empty image path: {path}:{line_no}")

        rows.append(Row(image_rel=image_rel, text=text))

    return rows


def write_label_file(path: Path, rows: list[Row]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    text = "\n".join(f"{row.image_rel}\t{row.text}" for row in rows)

    if text:
        text += "\n"

    path.write_text(text, encoding="utf-8")


def extract_field_from_rel(image_rel: str) -> str:
    parts = Path(image_rel).parts

    # Новый формат:
    # images/pas_number/hash_orig.png
    if len(parts) >= 3 and parts[0] == "images":
        return parts[1]

    # Старый fallback.
    if len(parts) >= 2:
        return parts[-2]

    name = Path(image_rel).name

    match = re.search(
        r"__(?:\d+_)?([a-z]+_[a-z0-9_]+)__line_",
        name,
    )

    if match:
        return match.group(1)

    return "unknown"


def is_orig_image(image_rel: str) -> bool:
    return bool(re.search(r"_orig\.[a-zA-Z0-9]+$", Path(image_rel).name))


def is_aug_image(image_rel: str) -> bool:
    return bool(re.search(r"_aug\d+\.[a-zA-Z0-9]+$", Path(image_rel).name))


def hard_block_key(row: Row) -> tuple[str, str]:
    return extract_field_from_rel(row.image_rel), row.text


def group_hard_rows_by_contiguous_blocks(rows: list[Row]) -> list[list[Row]]:
    """
    Новый labels.txt выглядит так:

    images/pas_number/hash1_orig.png   FB0297353
    images/pas_number/hash2_aug01.png  FB0297353
    images/pas_number/hash3_aug02.png  FB0297353
    images/pas_number/hash4_aug03.png  FB0297353

    У orig/aug разные hash, поэтому нельзя группировать по имени файла.

    Группируем последовательными блоками. Новый блок начинается:
    - если встретили *_orig.png и текущий блок уже не пустой;
    - или если изменился field/text.
    """

    groups: list[list[Row]] = []
    current: list[Row] = []
    current_key: tuple[str, str] | None = None

    for row in rows:
        key = hard_block_key(row)
        starts_new_by_orig = is_orig_image(row.image_rel) and bool(current)
        starts_new_by_key = current_key is not None and key != current_key

        if starts_new_by_orig or starts_new_by_key:
            groups.append(current)
            current = [row]
            current_key = key
            continue

        if current_key is None:
            current_key = key

        current.append(row)

    if current:
        groups.append(current)

    return groups


def split_hard_rows_by_blocks(
    rows: list[Row],
    train_ratio: float,
    seed: int,
) -> tuple[list[Row], list[Row], list[Row], list[Row], dict]:
    """
    Возвращает:
    - hard_train_all
    - hard_val_all
    - hard_val_orig
    - hard_val_aug
    - report

    Один блок orig+aug никогда не делится между train и val.
    """

    groups = group_hard_rows_by_contiguous_blocks(rows)

    if not groups:
        fail("Hard dataset is empty after grouping")

    group_sizes = [len(group) for group in groups]
    groups_with_orig = sum(1 for group in groups if any(is_orig_image(row.image_rel) for row in group))
    groups_without_orig = len(groups) - groups_with_orig

    rng = random.Random(seed)
    rng.shuffle(groups)

    train_group_count = int(len(groups) * train_ratio)

    if train_group_count <= 0:
        train_group_count = 1

    if train_group_count >= len(groups):
        train_group_count = len(groups) - 1

    train_groups = groups[:train_group_count]
    val_groups = groups[train_group_count:]

    hard_train_all = [row for group in train_groups for row in group]
    hard_val_all = [row for group in val_groups for row in group]

    hard_val_orig = [
        row
        for row in hard_val_all
        if is_orig_image(row.image_rel)
    ]

    hard_val_aug = [
        row
        for row in hard_val_all
        if is_aug_image(row.image_rel)
    ]

    # Если почему-то orig не нашли, используем весь hard-val.
    # Но это будет явно видно в summary.
    if not hard_val_orig:
        hard_val_orig = hard_val_all[:]

    rng.shuffle(hard_train_all)
    rng.shuffle(hard_val_all)
    rng.shuffle(hard_val_orig)
    rng.shuffle(hard_val_aug)

    report = {
        "hard_groups": len(groups),
        "hard_group_size_min": min(group_sizes),
        "hard_group_size_max": max(group_sizes),
        "hard_group_size_avg": sum(group_sizes) / len(group_sizes),
        "hard_groups_with_orig": groups_with_orig,
        "hard_groups_without_orig": groups_without_orig,
        "hard_train_groups": len(train_groups),
        "hard_val_groups": len(val_groups),
    }

    return hard_train_all, hard_val_all, hard_val_orig, hard_val_aug, report


def resolve_source_image(dataset_root: Path, image_rel: str) -> Path:
    p = Path(image_rel)

    if p.is_absolute():
        if p.exists():
            return p
        raise FileNotFoundError(p)

    candidates = [
        dataset_root / image_rel,
        dataset_root / "images" / image_rel,
        dataset_root / "imgs" / image_rel,
    ]

    for candidate in candidates:
        if candidate.exists():
            return candidate

    # Fallback по basename.
    found = list(dataset_root.rglob(Path(image_rel).name))

    if found:
        return found[0]

    raise FileNotFoundError(
        f"Cannot find image for label: {image_rel}\n"
        f"Dataset root: {dataset_root}"
    )


def safe_filename(name: str) -> str:
    name = name.replace("\\", "/")
    name = Path(name).name

    result = []

    for ch in name:
        if ch.isalnum() or ch in {"_", "-", "."}:
            result.append(ch)
        else:
            result.append("_")

    out = "".join(result).strip("_")
    return out or "image.png"


def copy_rows(
    *,
    rows: list[Row],
    src_dataset_root: Path,
    dst_dataset_root: Path,
    dst_prefix: str,
) -> list[Row]:
    out_rows: list[Row] = []

    for i, row in enumerate(rows):
        src = resolve_source_image(src_dataset_root, row.image_rel)

        dst_rel = Path(dst_prefix) / f"{i:07d}__{safe_filename(row.image_rel)}"
        dst_abs = dst_dataset_root / dst_rel

        dst_abs.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst_abs)

        out_rows.append(
            Row(
                image_rel=dst_rel.as_posix(),
                text=row.text,
            )
        )

    return out_rows


def load_dict_chars(dict_path: Path, use_space_char: bool = True) -> set[str]:
    check_file(dict_path, "Dictionary")

    chars: set[str] = set()

    for line in dict_path.read_text(encoding="utf-8").splitlines():
        value = line.rstrip("\n\r")

        if value:
            chars.add(value)

    if use_space_char:
        chars.add(" ")

    return chars


def validate_chars(rows: list[Row], dict_path: Path) -> dict:
    allowed = load_dict_chars(dict_path, use_space_char=True)

    used: set[str] = set()
    missing: set[str] = set()

    examples: dict[str, list[str]] = {}

    for row in rows:
        for ch in row.text:
            used.add(ch)

            if ch not in allowed:
                missing.add(ch)
                examples.setdefault(ch, [])
                if len(examples[ch]) < 5:
                    examples[ch].append(row.text)

    return {
        "used_chars": "".join(sorted(used)),
        "missing_chars": sorted(missing),
        "missing_examples": examples,
    }


def field_distribution(rows: list[Row]) -> dict[str, int]:
    result: dict[str, int] = {}

    for row in rows:
        field = extract_field_from_rel(row.image_rel)
        result[field] = result.get(field, 0) + 1

    return dict(sorted(result.items()))


def find_best_checkpoint_prefix(output_dir: Path) -> Path:
    candidates = [
        output_dir / "best_accuracy/model",
        output_dir / "best_model/model",
        output_dir / "latest/model",
    ]

    for prefix in candidates:
        if prefix.with_suffix(".pdparams").exists():
            return prefix

    found = sorted(output_dir.glob("**/model.pdparams"))

    if found:
        return found[0].with_suffix("")

    raise FileNotFoundError(
        "Cannot find checkpoint prefix in:\n"
        f"{output_dir}\n\n"
        "Expected one of:\n"
        + "\n".join(str(c) + ".pdparams" for c in candidates)
    )


# =============================================================================
# BUILD DATASET
# =============================================================================

def build_dataset() -> dict:
    check_dir(BASE_DATASET, "Base dataset")
    check_file(BASE_DATASET / "rec_gt_train.txt", "Base train labels")

    # base_val_clean_path = BASE_DATASET / "rec_gt_val_clean.txt"
    base_val_clean_path = BASE_DATASET / "rec_gt_val.txt"

    if not base_val_clean_path.exists():
        base_val_clean_path = BASE_DATASET / "rec_gt_val.txt"

    check_file(base_val_clean_path, "Base clean val labels")
    check_file(HARD_LABELS, "Hard labels")
    check_file(PP_OCRV5_LATIN_DICT, "PP-OCRv5 latin dict")

    if CLEAR_OUTPUT_DATASET and OUT_DATASET.exists():
        shutil.rmtree(OUT_DATASET)

    OUT_DATASET.mkdir(parents=True, exist_ok=True)

    base_train = read_label_file(BASE_DATASET / "rec_gt_train.txt")
    base_val_clean = read_label_file(base_val_clean_path)
    hard_rows = read_label_file(HARD_LABELS)

    if BASE_TRAIN_MAX_ROWS > 0 and len(base_train) > BASE_TRAIN_MAX_ROWS:
        rng = random.Random(SEED)
        base_train = base_train[:]
        rng.shuffle(base_train)
        base_train = base_train[:BASE_TRAIN_MAX_ROWS]

    (
        hard_train,
        hard_val_all,
        hard_val_orig,
        hard_val_aug,
        hard_group_report,
    ) = split_hard_rows_by_blocks(
        hard_rows,
        train_ratio=HARD_TRAIN_RATIO,
        seed=SEED,
    )

    print("Base train:", len(base_train))
    print("Base clean val:", len(base_val_clean))
    print("Hard total:", len(hard_rows))
    print("Hard train:", len(hard_train))
    print("Hard val all:", len(hard_val_all))
    print("Hard val orig:", len(hard_val_orig))
    print("Hard val aug:", len(hard_val_aug))
    print("Hard groups:", hard_group_report)

    copied_base_train = copy_rows(
        rows=base_train,
        src_dataset_root=BASE_DATASET,
        dst_dataset_root=OUT_DATASET,
        dst_prefix="base_train",
    )

    copied_base_val_clean = copy_rows(
        rows=base_val_clean,
        src_dataset_root=BASE_DATASET,
        dst_dataset_root=OUT_DATASET,
        dst_prefix="base_val_clean",
    )

    copied_hard_train = copy_rows(
        rows=hard_train,
        src_dataset_root=HARD_DATASET_ROOT,
        dst_dataset_root=OUT_DATASET,
        dst_prefix="hard_train",
    )

    copied_hard_val_all = copy_rows(
        rows=hard_val_all,
        src_dataset_root=HARD_DATASET_ROOT,
        dst_dataset_root=OUT_DATASET,
        dst_prefix="hard_val_all",
    )

    copied_hard_val_orig = copy_rows(
        rows=hard_val_orig,
        src_dataset_root=HARD_DATASET_ROOT,
        dst_dataset_root=OUT_DATASET,
        dst_prefix="hard_val_orig",
    )

    copied_hard_val_aug = copy_rows(
        rows=hard_val_aug,
        src_dataset_root=HARD_DATASET_ROOT,
        dst_dataset_root=OUT_DATASET,
        dst_prefix="hard_val_aug",
    )

    rng = random.Random(SEED)

    train_rows: list[Row] = []

    if USE_FULL_BASE_TRAIN:
        train_rows.extend(copied_base_train)

    for _ in range(HARD_REPEAT):
        train_rows.extend(copied_hard_train)

    rng.shuffle(train_rows)

    val_hard_orig_rows = copied_hard_val_orig[:]
    rng.shuffle(val_hard_orig_rows)

    val_hard_all_rows = copied_hard_val_all[:]
    rng.shuffle(val_hard_all_rows)

    val_hard_aug_rows = copied_hard_val_aug[:]
    rng.shuffle(val_hard_aug_rows)

    val_clean_rows = copied_base_val_clean[:]
    rng.shuffle(val_clean_rows)

    val_mix_rows = copied_base_val_clean + copied_hard_val_orig
    rng.shuffle(val_mix_rows)

    write_label_file(OUT_DATASET / "rec_gt_train.txt", train_rows)

    # Main monitored validation: hard originals.
    write_label_file(OUT_DATASET / "rec_gt_val.txt", val_hard_orig_rows)
    write_label_file(OUT_DATASET / "rec_gt_val_hard_orig.txt", val_hard_orig_rows)

    # Additional validation files.
    write_label_file(OUT_DATASET / "rec_gt_val_hard_all.txt", val_hard_all_rows)
    write_label_file(OUT_DATASET / "rec_gt_val_hard_aug.txt", val_hard_aug_rows)
    write_label_file(OUT_DATASET / "rec_gt_val_clean.txt", val_clean_rows)
    write_label_file(OUT_DATASET / "rec_gt_val_mix.txt", val_mix_rows)

    char_report = validate_chars(
        train_rows
        + val_hard_orig_rows
        + val_hard_all_rows
        + val_clean_rows,
        PP_OCRV5_LATIN_DICT,
    )

    if char_report["missing_chars"]:
        print()
        print("WARNING: missing chars in dict:")
        print(json.dumps(char_report["missing_examples"], ensure_ascii=False, indent=2))
        print()

    summary = {
        "base_dataset": str(BASE_DATASET),
        "hard_labels": str(HARD_LABELS),
        "hard_dataset_root": str(HARD_DATASET_ROOT),
        "out_dataset": str(OUT_DATASET),
        "dict": str(PP_OCRV5_LATIN_DICT),
        "settings": {
            "seed": SEED,
            "hard_train_ratio": HARD_TRAIN_RATIO,
            "hard_repeat": HARD_REPEAT,
            "use_full_base_train": USE_FULL_BASE_TRAIN,
            "base_train_max_rows": BASE_TRAIN_MAX_ROWS,
        },
        "counts": {
            "base_train": len(base_train),
            "base_val_clean": len(base_val_clean),
            "hard_total": len(hard_rows),
            "hard_train": len(hard_train),
            "hard_val_all": len(hard_val_all),
            "hard_val_orig": len(hard_val_orig),
            "hard_val_aug": len(hard_val_aug),
            "final_train": len(train_rows),
            "final_val_hard_orig": len(val_hard_orig_rows),
            "final_val_hard_all": len(val_hard_all_rows),
            "final_val_hard_aug": len(val_hard_aug_rows),
            "final_val_clean": len(val_clean_rows),
            "final_val_mix": len(val_mix_rows),
        },
        "hard_group_report": hard_group_report,
        "field_distribution": {
            "hard_total": field_distribution(hard_rows),
            "hard_train": field_distribution(hard_train),
            "hard_val_orig": field_distribution(hard_val_orig),
            "train_final": field_distribution(train_rows),
            "val_hard_orig_final": field_distribution(val_hard_orig_rows),
        },
        "char_report": char_report,
        "files": {
            "train": str(OUT_DATASET / "rec_gt_train.txt"),
            "val_main": str(OUT_DATASET / "rec_gt_val.txt"),
            "val_hard_orig": str(OUT_DATASET / "rec_gt_val_hard_orig.txt"),
            "val_hard_all": str(OUT_DATASET / "rec_gt_val_hard_all.txt"),
            "val_hard_aug": str(OUT_DATASET / "rec_gt_val_hard_aug.txt"),
            "val_clean": str(OUT_DATASET / "rec_gt_val_clean.txt"),
            "val_mix": str(OUT_DATASET / "rec_gt_val_mix.txt"),
        },
    }

    (OUT_DATASET / "dataset_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    return summary


# =============================================================================
# CONFIG
# =============================================================================

def yaml_list(value: list[int]) -> str:
    return "[" + ", ".join(str(x) for x in value) + "]"


def write_config(checkpoint_prefix: Path) -> None:
    OUT_CONFIG.parent.mkdir(parents=True, exist_ok=True)

    text = f"""Global:
  model_name: PP-OCRv5_mobile_rec
  debug: false
  use_gpu: true

  epoch_num: {EPOCH_NUM}
  log_smooth_window: 20
  print_batch_step: 20

  save_model_dir: {OUT_MODEL_DIR}
  save_epoch_step: 1
  eval_batch_step: [0, {EVAL_EVERY_STEPS}]
  cal_metric_during_train: true

  # Hard fine-tune from previous best model.
  # Important: path WITHOUT .pdparams suffix.
  pretrained_model: {checkpoint_prefix}
  checkpoints:
  save_inference_dir:

  use_visualdl: false

  infer_img: {OUT_DATASET}

  character_dict_path: {PP_OCRV5_LATIN_DICT}

  # Keep 80 for PP-OCRv5 MultiHead / NRTR compatibility.
  max_text_length: &max_text_length {MAX_TEXT_LENGTH}

  infer_mode: false
  use_space_char: true
  distributed: true

  save_res_path: {OUT_MODEL_DIR / "predicts.txt"}

  d2s_train_image_shape: {yaml_list(REC_IMAGE_SHAPE)}

Optimizer:
  name: Adam
  beta1: 0.9
  beta2: 0.999
  lr:
    name: Cosine
    learning_rate: {LEARNING_RATE}
    warmup_epoch: {WARMUP_EPOCH}
  regularizer:
    name: L2
    factor: {L2_FACTOR}

Architecture:
  model_type: rec
  algorithm: SVTR_LCNet

  Transform:

  Backbone:
    name: PPLCNetV3
    scale: 0.95

  Head:
    name: MultiHead
    head_list:
      - CTCHead:
          Neck:
            name: svtr
            dims: 120
            depth: 2
            hidden_dims: 120
            kernel_size: [1, 3]
            use_guide: true
          Head:
            fc_decay: 0.00001

      - NRTRHead:
          nrtr_dim: 384
          max_text_length: *max_text_length

Loss:
  name: MultiLoss
  loss_config_list:
    - CTCLoss:
    - NRTRLoss:

PostProcess:
  name: CTCLabelDecode

Metric:
  name: RecMetric
  main_indicator: acc

Train:
  dataset:
    name: SimpleDataSet
    data_dir: {OUT_DATASET}
    label_file_list:
      - {OUT_DATASET / "rec_gt_train.txt"}

    transforms:
      - DecodeImage:
          img_mode: BGR
          channel_first: false

      - MultiLabelEncode:
          gtc_encode: NRTRLabelEncode

      - RecResizeImg:
          image_shape: {yaml_list(REC_IMAGE_SHAPE)}

      - KeepKeys:
          keep_keys:
            - image
            - label_ctc
            - label_gtc
            - length
            - valid_ratio

  loader:
    shuffle: true
    batch_size_per_card: {BATCH_SIZE}
    drop_last: true
    num_workers: 8

Eval:
  dataset:
    name: SimpleDataSet
    data_dir: {OUT_DATASET}
    label_file_list:
      # Main monitored validation:
      # original hard examples only, without aug leakage.
      - {OUT_DATASET / "rec_gt_val_hard_orig.txt"}

    transforms:
      - DecodeImage:
          img_mode: BGR
          channel_first: false

      - MultiLabelEncode:
          gtc_encode: NRTRLabelEncode

      - RecResizeImg:
          image_shape: {yaml_list(REC_IMAGE_SHAPE)}

      - KeepKeys:
          keep_keys:
            - image
            - label_ctc
            - label_gtc
            - length
            - valid_ratio

  loader:
    shuffle: false
    drop_last: false
    batch_size_per_card: {EVAL_BATCH_SIZE}
    num_workers: 4
"""

    OUT_CONFIG.write_text(text, encoding="utf-8")
    print("Config written:", OUT_CONFIG)


def write_commands(checkpoint_prefix: Path) -> None:
    commands = f"""# =============================================================================
# Generated by prepare_passport_hard_finetune.py
# =============================================================================

# Previous best checkpoint:
# {checkpoint_prefix}

# Dataset summary:
cat {OUT_DATASET / "dataset_summary.json"}

# =============================================================================
# Train
# =============================================================================

cd {PADDLEOCR_ROOT}

{PADDLE_PYTHON} \\
  tools/train.py \\
  -c {OUT_CONFIG}

# =============================================================================
# Export best model
# =============================================================================

rm -rf {OUT_INFERENCE_DIR}

cd {PADDLEOCR_ROOT}

{PADDLE_PYTHON} \\
  tools/export_model.py \\
  -c {OUT_CONFIG} \\
  -o \\
  Global.checkpoints={OUT_MODEL_DIR / "best_accuracy/model"} \\
  Global.save_inference_dir={OUT_INFERENCE_DIR} \\
  Global.model_name=PP-OCRv5_mobile_rec

# =============================================================================
# Evaluate: hard original validation
# =============================================================================

cd {PROJECT_ROOT}

{PROJECT_PYTHON} \\
  {EVALUATOR} \\
  --passport \\
  --passport-model-dir {OUT_INFERENCE_DIR} \\
  --passport-label-file rec_gt_val_hard_orig.txt \\
  --limit 0 \\
  --out-dir {PROJECT_ROOT / "finetuned_ocr_eval/passport_rec_exp_g_hard_mix_hard_orig"}

# =============================================================================
# Evaluate: hard all validation, orig + aug
# =============================================================================

cd {PROJECT_ROOT}

{PROJECT_PYTHON} \\
  {EVALUATOR} \\
  --passport \\
  --passport-model-dir {OUT_INFERENCE_DIR} \\
  --passport-label-file rec_gt_val_hard_all.txt \\
  --limit 0 \\
  --out-dir {PROJECT_ROOT / "finetuned_ocr_eval/passport_rec_exp_g_hard_mix_hard_all"}

# =============================================================================
# Evaluate: old clean validation, regression check
# =============================================================================

cd {PROJECT_ROOT}

{PROJECT_PYTHON} \\
  {EVALUATOR} \\
  --passport \\
  --passport-model-dir {OUT_INFERENCE_DIR} \\
  --passport-label-file rec_gt_val_clean.txt \\
  --limit 0 \\
  --out-dir {PROJECT_ROOT / "finetuned_ocr_eval/passport_rec_exp_g_hard_mix_clean"}

# =============================================================================
# Evaluate: mixed validation
# =============================================================================

cd {PROJECT_ROOT}

{PROJECT_PYTHON} \\
  {EVALUATOR} \\
  --passport \\
  --passport-model-dir {OUT_INFERENCE_DIR} \\
  --passport-label-file rec_gt_val_mix.txt \\
  --limit 0 \\
  --out-dir {PROJECT_ROOT / "finetuned_ocr_eval/passport_rec_exp_g_hard_mix_mix"}
"""

    path = OUT_DATASET / "commands.txt"
    path.write_text(commands, encoding="utf-8")
    print("Commands written:", path)


# =============================================================================
# MAIN
# =============================================================================

def main() -> None:
    check_dir(PADDLEOCR_ROOT, "PaddleOCR root")
    check_file(PADDLE_PYTHON, "PaddleOCR python")
    check_file(PROJECT_PYTHON, "Project python")
    check_file(EVALUATOR, "Evaluator script")

    checkpoint_prefix = find_best_checkpoint_prefix(BEST_OUTPUT_DIR)

    print("Best checkpoint prefix:", checkpoint_prefix)
    print("Using dict:", PP_OCRV5_LATIN_DICT)
    print("Hard labels:", HARD_LABELS)
    print()

    summary = build_dataset()
    write_config(checkpoint_prefix)
    write_commands(checkpoint_prefix)

    print()
    print("=" * 100)
    print("DONE")
    print("=" * 100)
    print("Dataset:", OUT_DATASET)
    print("Config:", OUT_CONFIG)
    print("Commands:", OUT_DATASET / "commands.txt")
    print()
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print()
    print("Next:")
    print(f"cat {OUT_DATASET / 'commands.txt'}")


if __name__ == "__main__":
    main()
