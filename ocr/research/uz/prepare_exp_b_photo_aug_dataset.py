from __future__ import annotations

import json
import random
import shutil
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps, ImageEnhance, ImageFilter


# =============================================================================
# PATHS
# =============================================================================

PROJECT_ROOT = Path("/home/neuro/PycharmProjects/RecognizeUZ")

SOURCE_DATASET = PROJECT_ROOT / "paddleocr_passport_rec"

OUT_DATASET = PROJECT_ROOT / "paddleocr_passport_rec_exp_b_photo_aug"

OUT_CONFIG = (
    PROJECT_ROOT
    / "paddleocr/configs/rec/uz_passport_ppocrv5_mobile_rec_exp_b_photo_aug_finetune.yml"
)

EXP_B_BEST_MODEL_PREFIX = (
    PROJECT_ROOT
    / "paddleocr/output/ocr/passport_rec_exp_b_ctc_only/best_model/model"
)

OUT_MODEL_DIR = (
    PROJECT_ROOT
    / "paddleocr/output/ocr/passport_rec_exp_b_photo_aug_finetune"
)

OUT_PREDICTS_PATH = OUT_MODEL_DIR / "predicts.txt"


# =============================================================================
# AUGMENTATION SETTINGS
# =============================================================================

SEED = 42
CLEAR_OUTPUT = True

# Копируем текущие train/val строки как есть.
COPY_EXISTING_ROWS = True

# Аугментации генерируем только от original rows, если такие найдены.
# Если original rows не найдены, fallback — генерировать от всех строк.
BASE_AUG_POLICY = "orig_if_available"

# Сколько новых photo-like вариантов делать.
TRAIN_AUG_PER_BASE_IMAGE = 8
VAL_AUG_PER_BASE_IMAGE = 3

# Не делаем слишком разрушительные аугментации для val.
TRAIN_SEVERITY = "train"
VAL_SEVERITY = "val"

# Важно: строки будут перемешаны.
SHUFFLE_LABELS = True

# Формат сохраняемых изображений.
SAVE_EXT = ".png"


# =============================================================================
# CONFIG SETTINGS
# =============================================================================

WRITE_TRAIN_CONFIG = True

EPOCH_NUM = 25
BATCH_SIZE = 16
EVAL_BATCH_SIZE = 16
NUM_WORKERS_TRAIN = 8
NUM_WORKERS_EVAL = 4

LEARNING_RATE = 0.00002
WARMUP_EPOCH = 1
L2_FACTOR = 0.0001

REC_IMAGE_SHAPE = [3, 48, 768]
MAX_TEXT_LENGTH = 32


# =============================================================================
# DATA STRUCTURES
# =============================================================================

@dataclass(frozen=True)
class LabelRow:
    image_rel: str
    text: str

    @property
    def image_path_part(self) -> Path:
        return Path(self.image_rel)

    @property
    def filename(self) -> str:
        return Path(self.image_rel).name


# =============================================================================
# IO
# =============================================================================

def read_label_file(path: Path) -> list[LabelRow]:
    if not path.exists():
        raise FileNotFoundError(path)

    rows: list[LabelRow] = []

    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue

        if "\t" not in line:
            raise ValueError(f"Bad label line without TAB: {path}:{line_no}: {line}")

        image_rel, text = line.split("\t", 1)

        rows.append(
            LabelRow(
                image_rel=image_rel,
                text=text,
            )
        )

    return rows


def write_label_file(path: Path, rows: list[LabelRow]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    lines = [
        f"{row.image_rel}\t{row.text}"
        for row in rows
    ]

    path.write_text(
        "\n".join(lines) + ("\n" if lines else ""),
        encoding="utf-8",
    )


def read_image_bgr(path: Path) -> np.ndarray:
    if not path.exists():
        raise FileNotFoundError(path)

    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    img = img.convert("RGB")

    arr = np.array(img)
    return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)


def write_image_bgr(path: Path, image_bgr: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    image_bgr = np.clip(image_bgr, 0, 255).astype(np.uint8)
    rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    img = Image.fromarray(rgb)

    if path.suffix.lower() in {".jpg", ".jpeg"}:
        img.save(path, quality=94, subsampling=0, optimize=True)
    else:
        img.save(path, optimize=True)


def copy_row_image(
    row: LabelRow,
    source_dataset: Path,
    out_dataset: Path,
) -> None:
    src = source_dataset / row.image_rel
    dst = out_dataset / row.image_rel

    if not src.exists():
        raise FileNotFoundError(src)

    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def count_non_empty_lines(path: Path) -> int:
    return sum(
        1
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    )


# =============================================================================
# ROW SELECTION
# =============================================================================

def is_probably_original(row: LabelRow) -> bool:
    name = row.filename.lower()

    if "__orig" in name:
        return True

    if "_orig" in name:
        return True

    # Если в имени явно указана аугментация, это не original.
    aug_markers = [
        "__aug",
        "_aug_",
        "__photoaug",
        "_photoaug_",
        "__jpeg",
        "__blur",
        "__noise",
        "__light",
        "__shadow",
    ]

    if any(marker in name for marker in aug_markers):
        return False

    # Если маркеров вообще нет — считаем original.
    return True


def select_base_rows_for_aug(rows: list[LabelRow]) -> list[LabelRow]:
    if BASE_AUG_POLICY == "all":
        return rows

    if BASE_AUG_POLICY == "orig_if_available":
        originals = [
            row
            for row in rows
            if is_probably_original(row)
        ]

        # Если original rows почти нет, значит эвристика не сработала.
        if len(originals) >= max(10, int(len(rows) * 0.05)):
            return originals

        return rows

    raise ValueError(f"Unsupported BASE_AUG_POLICY: {BASE_AUG_POLICY}")


# =============================================================================
# AUGMENTATION HELPERS
# =============================================================================

def rand_float(
    rng: np.random.Generator,
    low: float,
    high: float,
) -> float:
    return float(rng.uniform(low, high))


def rand_int(
    rng: np.random.Generator,
    low: int,
    high: int,
) -> int:
    return int(rng.integers(low, high + 1))


def maybe(
    rng: np.random.Generator,
    p: float,
) -> bool:
    return bool(rng.random() < p)


def white_border_value(image_bgr: np.ndarray) -> tuple[int, int, int]:
    return (255, 255, 255)


def apply_affine(
    image_bgr: np.ndarray,
    rng: np.random.Generator,
    severity: str,
) -> np.ndarray:
    h, w = image_bgr.shape[:2]

    if severity == "val":
        max_angle = 1.2
        max_translate = 1.5
        scale_low, scale_high = 0.98, 1.02
    else:
        max_angle = 2.8
        max_translate = 3.0
        scale_low, scale_high = 0.94, 1.06

    angle = rand_float(rng, -max_angle, max_angle)
    scale = rand_float(rng, scale_low, scale_high)

    tx = rand_float(rng, -max_translate, max_translate)
    ty = rand_float(rng, -max_translate, max_translate)

    center = (w / 2.0, h / 2.0)
    matrix = cv2.getRotationMatrix2D(center, angle, scale)
    matrix[0, 2] += tx
    matrix[1, 2] += ty

    return cv2.warpAffine(
        image_bgr,
        matrix,
        (w, h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=white_border_value(image_bgr),
    )


def apply_perspective(
    image_bgr: np.ndarray,
    rng: np.random.Generator,
    severity: str,
) -> np.ndarray:
    h, w = image_bgr.shape[:2]

    if h < 8 or w < 16:
        return image_bgr

    if severity == "val":
        ratio = rand_float(rng, 0.002, 0.010)
    else:
        ratio = rand_float(rng, 0.004, 0.022)

    max_dx = max(1.0, w * ratio)
    max_dy = max(1.0, h * ratio)

    src = np.array(
        [
            [0, 0],
            [w - 1, 0],
            [w - 1, h - 1],
            [0, h - 1],
        ],
        dtype=np.float32,
    )

    jitter = np.array(
        [
            [rand_float(rng, -max_dx, max_dx), rand_float(rng, -max_dy, max_dy)],
            [rand_float(rng, -max_dx, max_dx), rand_float(rng, -max_dy, max_dy)],
            [rand_float(rng, -max_dx, max_dx), rand_float(rng, -max_dy, max_dy)],
            [rand_float(rng, -max_dx, max_dx), rand_float(rng, -max_dy, max_dy)],
        ],
        dtype=np.float32,
    )

    dst = src + jitter
    matrix = cv2.getPerspectiveTransform(src, dst)

    return cv2.warpPerspective(
        image_bgr,
        matrix,
        (w, h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=white_border_value(image_bgr),
    )


def apply_brightness_contrast_gamma(
    image_bgr: np.ndarray,
    rng: np.random.Generator,
    severity: str,
) -> np.ndarray:
    img = image_bgr.astype(np.float32) / 255.0

    if severity == "val":
        brightness = rand_float(rng, -0.05, 0.05)
        contrast = rand_float(rng, 0.90, 1.12)
        gamma = rand_float(rng, 0.92, 1.10)
    else:
        brightness = rand_float(rng, -0.13, 0.13)
        contrast = rand_float(rng, 0.78, 1.28)
        gamma = rand_float(rng, 0.78, 1.28)

    img = np.clip((img + brightness - 0.5) * contrast + 0.5, 0.0, 1.0)
    img = np.power(img, gamma)
    return np.clip(img * 255.0, 0, 255).astype(np.uint8)


def apply_color_temperature(
    image_bgr: np.ndarray,
    rng: np.random.Generator,
    severity: str,
) -> np.ndarray:
    img = image_bgr.astype(np.float32)

    if severity == "val":
        strength = rand_float(rng, -0.04, 0.04)
    else:
        strength = rand_float(rng, -0.10, 0.10)

    # BGR: холоднее -> больше B, теплее -> больше R.
    b_mul = 1.0 - strength
    r_mul = 1.0 + strength

    img[:, :, 0] *= b_mul
    img[:, :, 2] *= r_mul

    return np.clip(img, 0, 255).astype(np.uint8)


def apply_illumination_gradient(
    image_bgr: np.ndarray,
    rng: np.random.Generator,
    severity: str,
) -> np.ndarray:
    h, w = image_bgr.shape[:2]

    if severity == "val":
        strength = rand_float(rng, -0.08, 0.08)
    else:
        strength = rand_float(rng, -0.22, 0.22)

    horizontal = maybe(rng, 0.5)

    if horizontal:
        grad = np.linspace(-1.0, 1.0, w, dtype=np.float32)[None, :]
        grad = np.repeat(grad, h, axis=0)
    else:
        grad = np.linspace(-1.0, 1.0, h, dtype=np.float32)[:, None]
        grad = np.repeat(grad, w, axis=1)

    if maybe(rng, 0.5):
        grad = -grad

    factor = 1.0 + strength * grad
    factor = factor[:, :, None]

    img = image_bgr.astype(np.float32) * factor
    return np.clip(img, 0, 255).astype(np.uint8)


def apply_shadow(
    image_bgr: np.ndarray,
    rng: np.random.Generator,
    severity: str,
) -> np.ndarray:
    h, w = image_bgr.shape[:2]

    if h < 12 or w < 24:
        return image_bgr

    mask = np.ones((h, w), dtype=np.float32)

    count = 1 if severity == "val" else rand_int(rng, 1, 2)

    for _ in range(count):
        x1 = rand_int(rng, -w // 3, w)
        y1 = rand_int(rng, -h // 2, h)
        x2 = rand_int(rng, 0, w + w // 3)
        y2 = rand_int(rng, 0, h + h // 2)

        x1, x2 = sorted([x1, x2])
        y1, y2 = sorted([y1, y2])

        darkness = rand_float(rng, 0.86, 0.96) if severity == "val" else rand_float(rng, 0.70, 0.94)

        overlay = np.ones((h, w), dtype=np.float32)
        cv2.rectangle(
            overlay,
            (max(0, x1), max(0, y1)),
            (min(w - 1, x2), min(h - 1, y2)),
            darkness,
            thickness=-1,
        )

        blur = max(3, int(min(h, w) * rand_float(rng, 0.08, 0.22)))
        if blur % 2 == 0:
            blur += 1

        overlay = cv2.GaussianBlur(overlay, (blur, blur), 0)
        mask *= overlay

    img = image_bgr.astype(np.float32) * mask[:, :, None]
    return np.clip(img, 0, 255).astype(np.uint8)


def apply_noise(
    image_bgr: np.ndarray,
    rng: np.random.Generator,
    severity: str,
) -> np.ndarray:
    if severity == "val":
        sigma = rand_float(rng, 1.0, 3.5)
    else:
        sigma = rand_float(rng, 2.0, 9.0)

    noise = rng.normal(0.0, sigma, image_bgr.shape).astype(np.float32)
    img = image_bgr.astype(np.float32) + noise
    return np.clip(img, 0, 255).astype(np.uint8)


def apply_blur(
    image_bgr: np.ndarray,
    rng: np.random.Generator,
    severity: str,
) -> np.ndarray:
    if severity == "val":
        if maybe(rng, 0.7):
            return image_bgr
        k = 3
    else:
        k = 3 if maybe(rng, 0.85) else 5

    if maybe(rng, 0.65):
        return cv2.GaussianBlur(image_bgr, (k, k), 0)

    # motion blur
    kernel = np.zeros((k, k), dtype=np.float32)

    if maybe(rng, 0.5):
        kernel[k // 2, :] = 1.0
    else:
        kernel[:, k // 2] = 1.0

    kernel /= kernel.sum()

    return cv2.filter2D(image_bgr, -1, kernel)


def apply_jpeg_artifacts(
    image_bgr: np.ndarray,
    rng: np.random.Generator,
    severity: str,
) -> np.ndarray:
    if severity == "val":
        quality = rand_int(rng, 78, 94)
    else:
        quality = rand_int(rng, 45, 92)

    ok, encoded = cv2.imencode(
        ".jpg",
        image_bgr,
        [cv2.IMWRITE_JPEG_QUALITY, quality],
    )

    if not ok:
        return image_bgr

    decoded = cv2.imdecode(encoded, cv2.IMREAD_COLOR)

    if decoded is None:
        return image_bgr

    return decoded


def apply_resolution_loss(
    image_bgr: np.ndarray,
    rng: np.random.Generator,
    severity: str,
) -> np.ndarray:
    h, w = image_bgr.shape[:2]

    if h < 12 or w < 24:
        return image_bgr

    if severity == "val":
        scale = rand_float(rng, 0.82, 0.95)
    else:
        scale = rand_float(rng, 0.55, 0.92)

    small_w = max(8, int(round(w * scale)))
    small_h = max(8, int(round(h * scale)))

    small = cv2.resize(
        image_bgr,
        (small_w, small_h),
        interpolation=cv2.INTER_AREA,
    )

    return cv2.resize(
        small,
        (w, h),
        interpolation=cv2.INTER_LINEAR,
    )


def apply_sharpen(
    image_bgr: np.ndarray,
    rng: np.random.Generator,
) -> np.ndarray:
    pil = Image.fromarray(cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB))
    factor = rand_float(rng, 1.05, 1.7)
    pil = ImageEnhance.Sharpness(pil).enhance(factor)
    return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)


def apply_phone_photo_pipeline(
    image_bgr: np.ndarray,
    rng: np.random.Generator,
    severity: str,
) -> np.ndarray:
    img = image_bgr.copy()

    # Геометрия: осторожно, чтобы не уничтожить маленькие строки.
    if maybe(rng, 0.85 if severity == "train" else 0.55):
        img = apply_affine(img, rng, severity)

    if maybe(rng, 0.45 if severity == "train" else 0.20):
        img = apply_perspective(img, rng, severity)

    # Свет и цвет.
    if maybe(rng, 0.95):
        img = apply_brightness_contrast_gamma(img, rng, severity)

    if maybe(rng, 0.70 if severity == "train" else 0.45):
        img = apply_color_temperature(img, rng, severity)

    if maybe(rng, 0.85 if severity == "train" else 0.55):
        img = apply_illumination_gradient(img, rng, severity)

    if maybe(rng, 0.55 if severity == "train" else 0.20):
        img = apply_shadow(img, rng, severity)

    # Камера/сжатие.
    if maybe(rng, 0.65 if severity == "train" else 0.25):
        img = apply_resolution_loss(img, rng, severity)

    if maybe(rng, 0.55 if severity == "train" else 0.20):
        img = apply_blur(img, rng, severity)

    if maybe(rng, 0.75 if severity == "train" else 0.40):
        img = apply_noise(img, rng, severity)

    if maybe(rng, 0.85 if severity == "train" else 0.55):
        img = apply_jpeg_artifacts(img, rng, severity)

    if maybe(rng, 0.20 if severity == "train" else 0.10):
        img = apply_sharpen(img, rng)

    return img


# =============================================================================
# DATASET BUILDING
# =============================================================================

def build_augmented_split(
    *,
    split_name: str,
    source_rows: list[LabelRow],
    source_dataset: Path,
    out_dataset: Path,
    aug_per_base_image: int,
    severity: str,
    rng: np.random.Generator,
    py_rng: random.Random,
) -> tuple[list[LabelRow], list[LabelRow], dict]:
    out_rows: list[LabelRow] = []
    aug_only_rows: list[LabelRow] = []

    stats = {
        "split": split_name,
        "source_rows": len(source_rows),
        "copied_rows": 0,
        "base_rows_for_aug": 0,
        "aug_per_base_image": aug_per_base_image,
        "augmented_rows": 0,
        "missing_images": 0,
        "failed_images": 0,
    }

    if COPY_EXISTING_ROWS:
        for row in source_rows:
            src = source_dataset / row.image_rel

            if not src.exists():
                stats["missing_images"] += 1
                continue

            copy_row_image(row, source_dataset, out_dataset)
            out_rows.append(row)
            stats["copied_rows"] += 1

    base_rows = select_base_rows_for_aug(source_rows)
    stats["base_rows_for_aug"] = len(base_rows)

    aug_dir = f"{split_name}_photo_aug"

    for row_index, row in enumerate(base_rows):
        src = source_dataset / row.image_rel

        if not src.exists():
            stats["missing_images"] += 1
            continue

        try:
            base_img = read_image_bgr(src)
        except Exception:
            stats["failed_images"] += 1
            continue

        source_stem = Path(row.image_rel).stem

        for aug_index in range(aug_per_base_image):
            aug_img = apply_phone_photo_pipeline(
                base_img,
                rng,
                severity=severity,
            )

            aug_name = (
                f"{source_stem}"
                f"__photoaug_{aug_index:02d}"
                f"{SAVE_EXT}"
            )

            aug_rel = str(Path(aug_dir) / aug_name)
            aug_abs = out_dataset / aug_rel

            write_image_bgr(aug_abs, aug_img)

            aug_row = LabelRow(
                image_rel=aug_rel,
                text=row.text,
            )

            out_rows.append(aug_row)
            aug_only_rows.append(aug_row)
            stats["augmented_rows"] += 1

        if (row_index + 1) % 500 == 0:
            print(
                f"[{split_name}] augmented base rows: "
                f"{row_index + 1}/{len(base_rows)}"
            )

    if SHUFFLE_LABELS:
        py_rng.shuffle(out_rows)
        py_rng.shuffle(aug_only_rows)

    stats["output_rows"] = len(out_rows)

    return out_rows, aug_only_rows, stats


def copy_dict_file(source_dataset: Path, out_dataset: Path) -> None:
    src = source_dataset / "dict.txt"
    dst = out_dataset / "dict.txt"

    if not src.exists():
        raise FileNotFoundError(src)

    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def validate_labels_against_dict(dataset_dir: Path) -> dict:
    dict_path = dataset_dir / "dict.txt"

    dict_chars = set(
        line.strip()
        for line in dict_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    )

    # use_space_char=True
    dict_chars.add(" ")

    result = {}

    for label_name in [
        "rec_gt_train.txt",
        "rec_gt_val.txt",
        "rec_gt_val_clean.txt",
        "rec_gt_val_aug_only.txt",
    ]:
        label_path = dataset_dir / label_name

        if not label_path.exists():
            continue

        rows = read_label_file(label_path)
        chars = set()

        for row in rows:
            chars.update(row.text)

        missing = sorted(chars - dict_chars)

        result[label_name] = {
            "rows": len(rows),
            "unique_chars": "".join(sorted(chars)),
            "missing_chars": missing,
        }

    return result


def build_dataset() -> dict:
    if CLEAR_OUTPUT and OUT_DATASET.exists():
        shutil.rmtree(OUT_DATASET)

    OUT_DATASET.mkdir(parents=True, exist_ok=True)

    train_rows = read_label_file(SOURCE_DATASET / "rec_gt_train.txt")
    val_rows = read_label_file(SOURCE_DATASET / "rec_gt_val.txt")

    copy_dict_file(SOURCE_DATASET, OUT_DATASET)

    rng = np.random.default_rng(SEED)
    py_rng = random.Random(SEED)

    print("Source dataset:", SOURCE_DATASET)
    print("Output dataset:", OUT_DATASET)
    print("Train source rows:", len(train_rows))
    print("Val source rows:", len(val_rows))
    print()

    out_train_rows, train_aug_only_rows, train_stats = build_augmented_split(
        split_name="train",
        source_rows=train_rows,
        source_dataset=SOURCE_DATASET,
        out_dataset=OUT_DATASET,
        aug_per_base_image=TRAIN_AUG_PER_BASE_IMAGE,
        severity=TRAIN_SEVERITY,
        rng=rng,
        py_rng=py_rng,
    )

    out_val_rows, val_aug_only_rows, val_stats = build_augmented_split(
        split_name="val",
        source_rows=val_rows,
        source_dataset=SOURCE_DATASET,
        out_dataset=OUT_DATASET,
        aug_per_base_image=VAL_AUG_PER_BASE_IMAGE,
        severity=VAL_SEVERITY,
        rng=rng,
        py_rng=py_rng,
    )

    clean_val_rows = list(val_rows)

    if SHUFFLE_LABELS:
        py_rng.shuffle(clean_val_rows)

    write_label_file(
        OUT_DATASET / "rec_gt_train.txt",
        out_train_rows,
    )

    write_label_file(
        OUT_DATASET / "rec_gt_val.txt",
        out_val_rows,
    )

    write_label_file(
        OUT_DATASET / "rec_gt_val_clean.txt",
        clean_val_rows,
    )

    write_label_file(
        OUT_DATASET / "rec_gt_val_aug_only.txt",
        val_aug_only_rows,
    )

    dict_validation = validate_labels_against_dict(OUT_DATASET)

    summary = {
        "source_dataset": str(SOURCE_DATASET),
        "out_dataset": str(OUT_DATASET),
        "settings": {
            "seed": SEED,
            "copy_existing_rows": COPY_EXISTING_ROWS,
            "base_aug_policy": BASE_AUG_POLICY,
            "train_aug_per_base_image": TRAIN_AUG_PER_BASE_IMAGE,
            "val_aug_per_base_image": VAL_AUG_PER_BASE_IMAGE,
            "train_severity": TRAIN_SEVERITY,
            "val_severity": VAL_SEVERITY,
            "shuffle_labels": SHUFFLE_LABELS,
        },
        "train": train_stats,
        "val": val_stats,
        "dict_validation": dict_validation,
        "files": {
            "train_labels": str(OUT_DATASET / "rec_gt_train.txt"),
            "val_labels": str(OUT_DATASET / "rec_gt_val.txt"),
            "val_clean_labels": str(OUT_DATASET / "rec_gt_val_clean.txt"),
            "val_aug_only_labels": str(OUT_DATASET / "rec_gt_val_aug_only.txt"),
            "dict": str(OUT_DATASET / "dict.txt"),
        },
    }

    summary_path = OUT_DATASET / "dataset_summary.json"
    summary_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    return summary


# =============================================================================
# CONFIG WRITER
# =============================================================================

def write_finetune_config() -> None:
    OUT_CONFIG.parent.mkdir(parents=True, exist_ok=True)

    if not (EXP_B_BEST_MODEL_PREFIX.with_suffix(".pdparams")).exists():
        print()
        print("WARNING:")
        print(
            "Experiment B best model .pdparams not found:",
            EXP_B_BEST_MODEL_PREFIX.with_suffix(".pdparams"),
        )
        print("Config will still be written, but training will fail until model exists.")
        print()

    text = f"""Global:
  model_name: PP-OCRv5_mobile_rec_exp_b_photo_aug_finetune
  debug: false
  use_gpu: true

  epoch_num: {EPOCH_NUM}
  log_smooth_window: 20
  print_batch_step: 20

  save_model_dir: {OUT_MODEL_DIR}
  save_epoch_step: 1
  eval_batch_step: [500, 500]
  cal_metric_during_train: true

  # Fine-tune from Experiment B best model.
  # Important: path without .pdparams suffix.
  pretrained_model: {EXP_B_BEST_MODEL_PREFIX}
  checkpoints:
  save_inference_dir:

  use_visualdl: false

  infer_img: {OUT_DATASET / "val_photo_aug"}

  character_dict_path: {OUT_DATASET / "dict.txt"}
  max_text_length: &max_text_length {MAX_TEXT_LENGTH}

  infer_mode: false
  use_space_char: true
  distributed: true

  save_res_path: {OUT_PREDICTS_PATH}

  d2s_train_image_shape: {REC_IMAGE_SHAPE}

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

  Neck:
    name: SequenceEncoder
    encoder_type: reshape

  Head:
    name: CTCHead
    fc_decay: 0.00001

Loss:
  name: CTCLoss

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

      - CTCLabelEncode:

      - RecResizeImg:
          image_shape: {REC_IMAGE_SHAPE}

      - KeepKeys:
          keep_keys:
            - image
            - label
            - length
            - valid_ratio

  loader:
    shuffle: true
    batch_size_per_card: {BATCH_SIZE}
    drop_last: true
    num_workers: {NUM_WORKERS_TRAIN}

Eval:
  dataset:
    name: SimpleDataSet
    data_dir: {OUT_DATASET}
    label_file_list:
      # Augmented validation as requested.
      # For clean comparable validation, temporarily replace this with:
      # - {OUT_DATASET / "rec_gt_val_clean.txt"}
      - {OUT_DATASET / "rec_gt_val.txt"}

    transforms:
      - DecodeImage:
          img_mode: BGR
          channel_first: false

      - CTCLabelEncode:

      - RecResizeImg:
          image_shape: {REC_IMAGE_SHAPE}

      - KeepKeys:
          keep_keys:
            - image
            - label
            - length
            - valid_ratio

  loader:
    shuffle: false
    drop_last: false
    batch_size_per_card: {EVAL_BATCH_SIZE}
    num_workers: {NUM_WORKERS_EVAL}
"""

    OUT_CONFIG.write_text(text, encoding="utf-8")

    print("Config written:", OUT_CONFIG)


def write_train_hint() -> None:
    hint_path = OUT_DATASET / "train_command.txt"

    command = (
        "cd /home/neuro/PycharmProjects/createOCRDataset/PaddleOCR_training/PaddleOCR\n\n"
        "/home/neuro/PycharmProjects/createOCRDataset/.venv/bin/python "
        f"tools/train.py -c {OUT_CONFIG}\n"
    )

    hint_path.write_text(command, encoding="utf-8")
    print("Train command written:", hint_path)


# =============================================================================
# MAIN
# =============================================================================

def main() -> None:
    summary = build_dataset()

    print()
    print("=" * 100)
    print("DATASET DONE")
    print("=" * 100)
    print(json.dumps(summary, ensure_ascii=False, indent=2))

    if WRITE_TRAIN_CONFIG:
        write_finetune_config()
        write_train_hint()

    print()
    print("=" * 100)
    print("NEXT")
    print("=" * 100)
    print(f"Dataset: {OUT_DATASET}")
    print(f"Train labels: {OUT_DATASET / 'rec_gt_train.txt'}")
    print(f"Val labels: {OUT_DATASET / 'rec_gt_val.txt'}")
    print(f"Clean val labels: {OUT_DATASET / 'rec_gt_val_clean.txt'}")
    print(f"Config: {OUT_CONFIG}")
    print()
    print("Run:")
    print("cd /home/neuro/PycharmProjects/createOCRDataset/PaddleOCR_training/PaddleOCR")
    print(
        "/home/neuro/PycharmProjects/createOCRDataset/.venv/bin/python "
        f"tools/train.py -c {OUT_CONFIG}"
    )


if __name__ == "__main__":
    main()
