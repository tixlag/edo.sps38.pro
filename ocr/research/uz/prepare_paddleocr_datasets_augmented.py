from pathlib import Path
from lxml import etree
from PIL import Image, ImageOps, ImageFilter, ImageEnhance, ImageDraw, ImageFont
import cv2
import numpy as np
import random
import json
import re
import shutil


CVAT_ROOT = Path("uz-annotaited-dataset")
XML_PATH = CVAT_ROOT / "annotations.xml"
IMAGES_DIR = CVAT_ROOT / "images"

PASSPORT_OUT = Path("paddleocr_passport_rec")
MIGRATION_OUT = Path("paddleocr_migration_rec")

TRAIN_RATIO = 0.9
SEED = 42
RESET_OUTPUT_DIRS = True

TARGET_HEIGHT = 48
MIN_WIDTH = 32
MAX_WIDTH = 768
PAD_X = 4
PAD_Y = 4

# Аугментации применяются ДО prepare_ocr_image_bgr().
# Важно: оригинал и все его augment-версии сохраняются в тот же subset,
# потому что split делается на уровне исходного image_node.
TRAIN_AUGMENTATIONS_PER_SAMPLE = 3
VAL_AUGMENTATIONS_PER_SAMPLE = 0

# Synthetic Q/W добавляем только в passport train.
ADD_SYNTHETIC_QW = True
SYNTH_QW_PER_POSITION = 60  # Q begin/middle/end + W begin/middle/end = 6 * 60 = 360 samples
SYNTH_REL_DIR = Path("train") / "_synthetic_qw"

PASSPORT_FORCE_DICT_CHARS = set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ")

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/home/neuro/Downloads/freemono/FreeMonoBold.ttf",
    "/home/neuro/Downloads/freesans/FreeSans/FreeSansBold.ttf",
]

DOCUMENT_LABELS = {
    "1_passport_uz": "passport",
    "27_migration_card": "migration_card",
}

PASSPORT_FIELDS = {
    "2_pas_number": "pas_number",
    "3_pas_surname": "pas_surname",
    "4_pas_name": "pas_name",
    "5_pas_patronymic": "pas_patronymic",
    "6_pas_nationality": "pas_nationality",
    "7_pas_date_of_birth": "pas_date_of_birth",
    "8_pas_sex": "pas_sex",
    "9_pas_place_of_birth": "pas_place_of_birth",
    "10_pas_date_of_issue": "pas_date_of_issue",
    "11_pas_date_of_expiry": "pas_date_of_expiry",
    "12_pas_authority": "pas_authority",
    "14_pas_mrz": "pas_mrz",
}

MIGRATION_FIELDS = {
    "15_mg_series": "mg_series",
    "16_mg_number": "mg_number",
    "17_mg_surname": "mg_surname",
    "18_mg_surname_lat": "mg_surname_lat",
    "19_mg_name": "mg_name",
    "20_mg_patronymic": "mg_patronymic",
    "21_mg_date_of_birth": "mg_date_of_birth",
    "22_mg_nationality": "mg_nationality",
    "23_mg_passport_number": "mg_passport_number",
    "24_mg_visa_number": "mg_visa_number",
    "25_mg_duration_from": "mg_duration_from",
    "26_mg_duration_to": "mg_duration_to",
}


# ---------------------------------------------------------------------
# OCR PREPROCESSING
# ---------------------------------------------------------------------

def prepare_ocr_image_bgr(
    image_bgr: np.ndarray,
    dst_path: str | Path,
    target_height: int = TARGET_HEIGHT,
    min_width: int = MIN_WIDTH,
    max_width: int = MAX_WIDTH,
    pad_x: int = PAD_X,
    pad_y: int = PAD_Y,
    grayscale: bool = True,
    normalize_background: bool = True,
) -> None:
    dst_path = Path(dst_path)
    dst_path.parent.mkdir(parents=True, exist_ok=True)

    image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    img = Image.fromarray(image_rgb).convert("RGB")

    img = ImageOps.expand(
        img,
        border=(pad_x, pad_y, pad_x, pad_y),
        fill=(255, 255, 255),
    )

    if grayscale:
        img = img.convert("L")

        if normalize_background:
            blur_radius = max(3, img.height // 2)
            bg = img.filter(ImageFilter.GaussianBlur(radius=blur_radius))
            img = ImageOps.autocontrast(
                Image.blend(
                    img,
                    ImageOps.invert(bg),
                    alpha=0.18,
                )
            )

        img = ImageEnhance.Contrast(img).enhance(1.25)
        img = img.convert("RGB")

    scale = target_height / img.height
    new_w = round(img.width * scale)
    new_w = max(new_w, min_width)
    new_w = min(new_w, max_width)

    img = img.resize(
        (new_w, target_height),
        Image.Resampling.LANCZOS,
    )

    if img.width < min_width:
        canvas = Image.new(
            "RGB",
            (min_width, target_height),
            (255, 255, 255),
        )
        x = (min_width - img.width) // 2
        canvas.paste(img, (x, 0))
        img = canvas

    if dst_path.suffix.lower() in (".jpg", ".jpeg"):
        img.save(dst_path, quality=95, subsampling=0, optimize=True)
    else:
        img.save(dst_path, optimize=True)


# ---------------------------------------------------------------------
# CVAT / GEOMETRY
# ---------------------------------------------------------------------

def parse_points(points: str) -> np.ndarray:
    return np.array(
        [list(map(float, p.split(","))) for p in points.split(";")],
        dtype=np.float32,
    )


def get_attr(polygon_node, name: str, default: str = "") -> str:
    attr = polygon_node.find(f"./attribute[@name='{name}']")
    if attr is None or attr.text is None:
        return default
    return attr.text.strip()


def normalize_text(text: str, doc_type: str) -> str:
    text = text.replace("\t", " ")
    text = text.replace("\n", " ")

    # В паспортах даты приводим к формату, который ты выбрал для обучения:
    # 20.11.2007 -> 20 11 2007
    if doc_type == "passport":
        if re.match(r"^\d{2}\.\d{2}\.\d{4}$", text):
            text = text.replace(".", " ")

    text = re.sub(r"\s+", " ", text)
    return text.strip()


def find_image_path(name: str) -> Path:
    direct = IMAGES_DIR / name

    if direct.exists():
        return direct

    found = list(IMAGES_DIR.rglob(name))

    if found:
        return found[0]

    raise FileNotFoundError(name)


def polygon_center(points: np.ndarray) -> tuple[float, float]:
    return float(points[:, 0].mean()), float(points[:, 1].mean())


def point_in_polygon(point: tuple[float, float], polygon: np.ndarray) -> bool:
    return cv2.pointPolygonTest(
        polygon.astype(np.float32),
        point,
        False,
    ) >= 0


def order_quad_points(points: np.ndarray) -> np.ndarray:
    """
    Для документа используем порядок точек CVAT как направление:
    0 = top-left документа в правильной ориентации
    1 = top-right
    2 = bottom-right
    3 = bottom-left
    """
    if len(points) < 4:
        raise ValueError(
            f"Document polygon must have at least 4 points, got {len(points)}"
        )

    return points[:4].astype(np.float32)


def warp_document(image: np.ndarray, doc_polygon: np.ndarray):
    src = order_quad_points(doc_polygon)

    top_width = np.linalg.norm(src[1] - src[0])
    bottom_width = np.linalg.norm(src[2] - src[3])
    crop_w = int(max(top_width, bottom_width))

    right_height = np.linalg.norm(src[2] - src[1])
    left_height = np.linalg.norm(src[3] - src[0])
    crop_h = int(max(right_height, left_height))

    if crop_w <= 1 or crop_h <= 1:
        raise ValueError(f"Invalid crop size: {crop_w}x{crop_h}")

    dst = np.array(
        [
            [0, 0],
            [crop_w - 1, 0],
            [crop_w - 1, crop_h - 1],
            [0, crop_h - 1],
        ],
        dtype=np.float32,
    )

    matrix = cv2.getPerspectiveTransform(src, dst)
    crop = cv2.warpPerspective(image, matrix, (crop_w, crop_h))

    return crop, matrix, crop_w, crop_h


def transform_polygon(points: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    pts = points.reshape(-1, 1, 2).astype(np.float32)
    result = cv2.perspectiveTransform(pts, matrix)
    return result.reshape(-1, 2)


def crop_field_polygon_masked(
    doc_crop: np.ndarray,
    field_polygon: np.ndarray,
    pad_ratio_x: float = 0.03,
    pad_ratio_y: float = 0.08,
    min_pad: int = 2,
    mask_dilate_px: int = 1,
) -> np.ndarray:
    """
    Вырезает bbox поля, но всё вне polygon заливает белым.

    Это ключевое отличие от старого crop_field_from_document:
    соседние строки/подписи больше не попадают в OCR как валидный текст.
    """

    h, w = doc_crop.shape[:2]

    poly = field_polygon.astype(np.float32)

    x1 = float(poly[:, 0].min())
    y1 = float(poly[:, 1].min())
    x2 = float(poly[:, 0].max())
    y2 = float(poly[:, 1].max())

    bw = max(1.0, x2 - x1)
    bh = max(1.0, y2 - y1)

    pad_x = max(min_pad, int(bw * pad_ratio_x))
    pad_y = max(min_pad, int(bh * pad_ratio_y))

    x1i = max(0, int(round(x1)) - pad_x)
    y1i = max(0, int(round(y1)) - pad_y)
    x2i = min(w - 1, int(round(x2)) + pad_x)
    y2i = min(h - 1, int(round(y2)) + pad_y)

    if x2i <= x1i or y2i <= y1i:
        return doc_crop[0:1, 0:1].copy()

    crop = doc_crop[y1i:y2i + 1, x1i:x2i + 1].copy()

    shifted = poly.copy()
    shifted[:, 0] -= x1i
    shifted[:, 1] -= y1i

    mask = np.zeros(crop.shape[:2], dtype=np.uint8)
    cv2.fillPoly(mask, [shifted.astype(np.int32)], 255)

    if mask_dilate_px > 0:
        kernel = np.ones(
            (mask_dilate_px * 2 + 1, mask_dilate_px * 2 + 1),
            dtype=np.uint8,
        )
        mask = cv2.dilate(mask, kernel, iterations=1)

    white = np.full_like(crop, 255)
    masked = np.where(mask[:, :, None] == 255, crop, white)

    return masked


# ---------------------------------------------------------------------
# AUGMENTATIONS BEFORE OCR PREPROCESSING
# ---------------------------------------------------------------------

def ensure_uint8(img: np.ndarray) -> np.ndarray:
    return np.clip(img, 0, 255).astype(np.uint8)


def add_white_border(img: np.ndarray, x: int = 4, y: int = 3) -> np.ndarray:
    return cv2.copyMakeBorder(
        img,
        y,
        y,
        x,
        x,
        cv2.BORDER_CONSTANT,
        value=(255, 255, 255),
    )


def augment_brightness_contrast_gamma(img: np.ndarray) -> np.ndarray:
    arr = img.astype(np.float32)

    alpha = random.uniform(0.85, 1.20)
    beta = random.uniform(-18, 18)

    arr = arr * alpha + beta
    arr = ensure_uint8(arr)

    if random.random() < 0.50:
        gamma = random.uniform(0.80, 1.25)
        table = np.array(
            [
                ((i / 255.0) ** (1.0 / gamma)) * 255.0
                for i in range(256)
            ],
            dtype=np.uint8,
        )
        arr = cv2.LUT(arr, table)

    return arr


def augment_noise(img: np.ndarray) -> np.ndarray:
    arr = img.astype(np.int16)

    sigma = random.uniform(2.0, 8.0)
    noise = np.random.normal(0, sigma, arr.shape).astype(np.int16)
    arr = arr + noise

    return ensure_uint8(arr)


def augment_blur_or_sharpen(img: np.ndarray) -> np.ndarray:
    if random.random() < 0.55:
        k = random.choice([3, 3, 5])
        sigma = random.uniform(0.15, 0.75)
        return cv2.GaussianBlur(img, (k, k), sigmaX=sigma)

    blurred = cv2.GaussianBlur(img, (0, 0), sigmaX=random.uniform(0.4, 0.9))
    sharpened = cv2.addWeighted(img, 1.35, blurred, -0.35, 0)
    return ensure_uint8(sharpened)


def augment_jpeg(img: np.ndarray) -> np.ndarray:
    quality = random.randint(55, 92)

    ok, encoded = cv2.imencode(
        ".jpg",
        img,
        [cv2.IMWRITE_JPEG_QUALITY, quality],
    )

    if not ok:
        return img

    decoded = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    return decoded if decoded is not None else img


def augment_small_rotation(img: np.ndarray) -> np.ndarray:
    img = add_white_border(img, x=6, y=5)

    h, w = img.shape[:2]
    angle = random.uniform(-1.8, 1.8)

    matrix = cv2.getRotationMatrix2D(
        (w / 2.0, h / 2.0),
        angle,
        1.0,
    )

    rotated = cv2.warpAffine(
        img,
        matrix,
        (w, h),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(255, 255, 255),
    )

    return rotated


def augment_small_perspective(img: np.ndarray) -> np.ndarray:
    img = add_white_border(img, x=6, y=4)

    h, w = img.shape[:2]

    max_shift_x = max(1.0, w * 0.015)
    max_shift_y = max(1.0, h * 0.035)

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
            [
                random.uniform(-max_shift_x, max_shift_x),
                random.uniform(-max_shift_y, max_shift_y),
            ]
            for _ in range(4)
        ],
        dtype=np.float32,
    )

    dst = src + jitter

    matrix = cv2.getPerspectiveTransform(src, dst)

    warped = cv2.warpPerspective(
        img,
        matrix,
        (w, h),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(255, 255, 255),
    )

    return warped


def augment_background_tint(img: np.ndarray) -> np.ndarray:
    arr = img.astype(np.float32)

    # Лёгкий серый/желтоватый фон как у сканов.
    tint = np.array(
        [
            random.uniform(-4, 8),
            random.uniform(-4, 8),
            random.uniform(-4, 12),
        ],
        dtype=np.float32,
    )

    arr = arr + tint.reshape(1, 1, 3)

    # Слабый горизонтальный градиент.
    h, w = arr.shape[:2]
    grad = np.linspace(
        random.uniform(-8, 4),
        random.uniform(4, 10),
        w,
        dtype=np.float32,
    )
    arr = arr + grad.reshape(1, w, 1)

    return ensure_uint8(arr)


def augment_raw_ocr_crop(raw_crop_bgr: np.ndarray) -> np.ndarray:
    """
    Аугментации до OCR preprocessing.
    Не делаем flip и сильный crop, чтобы не портить label.
    """

    img = raw_crop_bgr.copy()

    if random.random() < 0.80:
        img = augment_background_tint(img)

    if random.random() < 0.90:
        img = augment_brightness_contrast_gamma(img)

    if random.random() < 0.65:
        img = augment_small_rotation(img)

    if random.random() < 0.30:
        img = augment_small_perspective(img)

    if random.random() < 0.75:
        img = augment_noise(img)

    if random.random() < 0.65:
        img = augment_blur_or_sharpen(img)

    if random.random() < 0.35:
        img = augment_jpeg(img)

    return ensure_uint8(img)


# ---------------------------------------------------------------------
# OUTPUT HELPERS
# ---------------------------------------------------------------------

def reset_output_dir(base: Path):
    if RESET_OUTPUT_DIRS and base.exists():
        shutil.rmtree(base)


def make_dirs(base: Path):
    (base / "train").mkdir(parents=True, exist_ok=True)
    (base / "val").mkdir(parents=True, exist_ok=True)


def safe_filename_part(text: str) -> str:
    text = re.sub(r"[^\w\-]+", "_", text, flags=re.UNICODE)
    text = text.strip("_")
    return text[:80] if text else "sample"


def write_dict(
    base: Path,
    texts: list[str],
    force_chars: set[str] | None = None,
):
    chars = {
        ch
        for text in texts
        for ch in text
        if ch != " "
    }

    if force_chars:
        chars.update(force_chars)

    (base / "dict.txt").write_text(
        "\n".join(sorted(chars)) + "\n",
        encoding="utf-8",
    )


def append_label(label_lines: list[str], image_path: Path, text: str):
    label_lines.append(
        f"{image_path.as_posix()}\t{text}"
    )


def append_metadata(
    metadata_lines: list[str],
    *,
    image_path: Path,
    text: str,
    task_id: str,
    frame_id: str | int,
    source_image: str,
    doc_type: str,
    doc_index: int,
    field_label: str,
    field_name: str,
    line_index: str,
    augmentation: str,
):
    metadata_lines.append(
        json.dumps(
            {
                "image": image_path.as_posix(),
                "text": text,
                "task_id": task_id,
                "frame_id": frame_id,
                "source_image": source_image,
                "doc_type": doc_type,
                "doc_index": doc_index,
                "field_label": field_label,
                "field_name": field_name,
                "line_index": line_index,
                "augmentation": augmentation,
            },
            ensure_ascii=False,
        )
    )


def save_ocr_sample(
    *,
    out_dir: Path,
    subset: str,
    label_lines: list[str],
    metadata_lines: list[str],
    all_texts: list[str],
    raw_crop_bgr: np.ndarray,
    text: str,
    source_stem: str,
    source_image_name: str,
    task_id: str,
    frame_id: str | int,
    doc_type: str,
    doc_index: int,
    field_label: str,
    field_name: str,
    line_index: str,
    sample_index: int,
    variant_name: str,
):
    label_prefix = field_label.split("_", 1)[0]

    file_name = (
        f"{source_stem}"
        f"__{doc_type}_{doc_index}"
        f"__{label_prefix}_{field_name}"
        f"__line_{line_index}"
        f"__sample_{sample_index}"
        f"__{variant_name}.png"
    )

    dst_rel = Path(subset) / file_name
    dst_abs = out_dir / dst_rel

    prepare_ocr_image_bgr(
        image_bgr=raw_crop_bgr,
        dst_path=dst_abs,
    )

    append_label(
        label_lines=label_lines,
        image_path=dst_rel,
        text=text,
    )

    append_metadata(
        metadata_lines=metadata_lines,
        image_path=dst_rel,
        text=text,
        task_id=task_id,
        frame_id=frame_id,
        source_image=source_image_name,
        doc_type=doc_type,
        doc_index=doc_index,
        field_label=field_label,
        field_name=field_name,
        line_index=line_index,
        augmentation=variant_name,
    )

    all_texts.append(text)


# ---------------------------------------------------------------------
# SYNTHETIC Q/W
# ---------------------------------------------------------------------

def load_font_paths() -> list[Path]:
    paths = []

    for p in FONT_CANDIDATES:
        path = Path(p)
        if path.exists():
            paths.append(path)

    if not paths:
        raise RuntimeError(
            "No fonts found. Install fonts-dejavu or fonts-liberation."
        )

    return paths


def choose_font(font_paths: list[Path], size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(random.choice(font_paths)), size=size)


def measure_text(
    text: str,
    font: ImageFont.FreeTypeFont,
    spacing: int,
):
    dummy = Image.new("L", (1, 1), 255)
    draw = ImageDraw.Draw(dummy)

    items = []
    total_w = 0

    min_top = 10**9
    max_bottom = -10**9

    for ch in text:
        bbox = draw.textbbox((0, 0), ch, font=font)
        advance = int(round(draw.textlength(ch, font=font)))

        left, top, right, bottom = bbox
        bbox_w = right - left
        bbox_h = bottom - top

        width = max(advance, bbox_w, 1)

        items.append(
            {
                "ch": ch,
                "bbox": bbox,
                "advance": width,
            }
        )

        if bbox_h > 0:
            min_top = min(min_top, top)
            max_bottom = max(max_bottom, bottom)

        total_w += width

    if text:
        total_w += spacing * (len(text) - 1)

    if min_top == 10**9:
        min_top = 0
        max_bottom = font.size

    return items, total_w, min_top, max_bottom


def make_qw_text(char: str, position: str) -> str:
    q_begin = [
        "QODIROV",
        "QODIROVA",
        "QURBONOV",
        "QURBONOVA",
        "QOSIMOV",
        "QASHQADARYA REGION",
        "QORAQALPOGISTON",
        "QIBRAY",
    ]

    q_middle = [
        "ABDUQODIR",
        "TOQIROV",
        "ISHQOBILOV",
        "NURQULOV",
        "YOQUBOV",
        "RAQIMOV",
        "SAQIBOV",
        "MIRQOSIM",
    ]

    q_end = [
        "FARUQ",
        "SADIQ",
        "TARIQ",
        "RAFIQ",
        "SHAFIQ",
        "MUTLOQ",
        "MASHQ",
        "QODIRQ",
    ]

    w_begin = [
        "WILLIAM",
        "WILSON",
        "WATSON",
        "WASHINGTON",
        "WEST REGION",
        "WHITE",
        "WALKER",
        "WERNER",
    ]

    w_middle = [
        "BROWN",
        "LAWRENCE",
        "HOWARD",
        "NEWTON",
        "EDWARD",
        "LOWRENCE",
        "ALWON",
        "SHWARTZ",
    ]

    w_end = [
        "ANDREW",
        "MATTHEW",
        "NEW",
        "LOW",
        "ROW",
        "BROW",
        "MORROW",
        "WILLIAMW",
    ]

    pools = {
        ("Q", "begin"): q_begin,
        ("Q", "middle"): q_middle,
        ("Q", "end"): q_end,
        ("W", "begin"): w_begin,
        ("W", "middle"): w_middle,
        ("W", "end"): w_end,
    }

    return random.choice(pools[(char, position)])


def render_synthetic_qw_image(
    text: str,
    font_paths: list[Path],
) -> np.ndarray:
    """
    Генерирует final-like OCR crop высотой 48px:
    серый фон, шум, чёрный моноширинный текст.
    """

    for _ in range(40):
        font_size = random.randint(28, 38)
        spacing = random.randint(2, 5)
        font = choose_font(font_paths, font_size)

        items, text_w, min_top, max_bottom = measure_text(text, font, spacing)
        width = text_w + random.randint(12, 40)

        if width <= MAX_WIDTH:
            break

    width = max(MIN_WIDTH, min(MAX_WIDTH, width))
    height = TARGET_HEIGHT

    bg_value = random.randint(168, 220)

    bg = np.full(
        (height, width, 3),
        bg_value,
        dtype=np.float32,
    )

    # Пятнистость и градиент как у реальных подготовленных кропов.
    bg += np.random.normal(
        0,
        random.uniform(3.0, 8.0),
        bg.shape,
    ).astype(np.float32)

    grad = np.linspace(
        random.uniform(-10, 4),
        random.uniform(4, 12),
        width,
        dtype=np.float32,
    )
    bg += grad.reshape(1, width, 1)

    bg = np.clip(bg, 90, 245).astype(np.uint8)

    img = Image.fromarray(cv2.cvtColor(bg, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(img)

    text_h = max_bottom - min_top
    y = int((height - text_h) / 2 - min_top) + random.randint(-2, 2)
    y = max(y, -min_top + 2)

    x = random.randint(3, 8)

    for item in items:
        ch = item["ch"]
        bbox = item["bbox"]

        ink = random.randint(0, 40)

        draw.text(
            (
                x - bbox[0] + random.choice([0, 0, 0, 1, -1]),
                y + random.choice([0, 0, 0, 1, -1]),
            ),
            ch,
            font=font,
            fill=(ink, ink, ink),
        )

        x += item["advance"] + spacing

    if random.random() < 0.85:
        img = img.filter(
            ImageFilter.GaussianBlur(
                radius=random.uniform(0.20, 0.70)
            )
        )

    if random.random() < 0.45:
        img = ImageEnhance.Contrast(img).enhance(
            random.uniform(1.05, 1.35)
        )

    out = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)

    if random.random() < 0.35:
        out = augment_jpeg(out)

    return out


def add_synthetic_qw_samples(
    *,
    out_dir: Path,
    label_lines: list[str],
    metadata_lines: list[str],
    all_texts: list[str],
    skip_report: list[str],
):
    if not ADD_SYNTHETIC_QW:
        return 0

    font_paths = load_font_paths()

    count = 0

    for char in ["Q", "W"]:
        for position in ["begin", "middle", "end"]:
            for i in range(SYNTH_QW_PER_POSITION):
                text = make_qw_text(char, position)

                # Гарантия, что символ реально стоит в нужной зоне строки.
                if position == "begin" and not text.startswith(char):
                    skip_report.append(
                        f"SYNTH_BAD_POSITION | {char} | {position} | {text}"
                    )
                    continue

                if position == "middle":
                    idx = text.find(char)
                    if idx <= 0 or idx >= len(text) - 1:
                        skip_report.append(
                            f"SYNTH_BAD_POSITION | {char} | {position} | {text}"
                        )
                        continue

                if position == "end" and not text.endswith(char):
                    skip_report.append(
                        f"SYNTH_BAD_POSITION | {char} | {position} | {text}"
                    )
                    continue

                img = render_synthetic_qw_image(text, font_paths)

                safe = safe_filename_part(text)
                file_name = (
                    f"synth_qw"
                    f"__{char.lower()}_{position}"
                    f"__{count:06d}"
                    f"__{safe}.png"
                )

                dst_rel = SYNTH_REL_DIR / file_name
                dst_abs = out_dir / dst_rel
                dst_abs.parent.mkdir(parents=True, exist_ok=True)

                cv2.imwrite(str(dst_abs), img)

                append_label(
                    label_lines=label_lines,
                    image_path=dst_rel,
                    text=text,
                )

                append_metadata(
                    metadata_lines=metadata_lines,
                    image_path=dst_rel,
                    text=text,
                    task_id="synthetic",
                    frame_id="synthetic",
                    source_image="synthetic_qw",
                    doc_type="passport",
                    doc_index=0,
                    field_label="synthetic_qw",
                    field_name="synthetic_qw",
                    line_index="1",
                    augmentation=f"synthetic_{char}_{position}",
                )

                all_texts.append(text)
                count += 1

    return count


# ---------------------------------------------------------------------
# MAIN DATASET PROCESSING
# ---------------------------------------------------------------------

def process_doc(
    *,
    out_dir: Path,
    subset: str,
    label_lines: list[str],
    metadata_lines: list[str],
    all_texts: list[str],
    source_stem: str,
    source_image_name: str,
    task_id: str,
    frame_id: int,
    image: np.ndarray,
    doc_type: str,
    doc_index: int,
    doc_polygon: np.ndarray,
    fields: list[dict],
    allowed_fields: dict[str, str],
    skip_report: list[str],
):
    doc_crop, doc_matrix, doc_w, doc_h = warp_document(
        image,
        doc_polygon,
    )

    sample_index = 0
    saved_count = 0
    original_count = 0
    augmented_count = 0

    if subset == "train":
        augmentations_per_sample = TRAIN_AUGMENTATIONS_PER_SAMPLE
    else:
        augmentations_per_sample = VAL_AUGMENTATIONS_PER_SAMPLE

    for field in fields:
        if field["label"] not in allowed_fields:
            continue

        text = normalize_text(field["content"], doc_type)

        if not text:
            skip_report.append(
                f"EMPTY_TEXT | task_id={task_id} | frame_id={frame_id} | "
                f"image={source_image_name} | {doc_type}_{doc_index} | "
                f"{field['label']}"
            )
            continue

        center = polygon_center(field["points"])

        if not point_in_polygon(center, doc_polygon):
            continue

        field_name = allowed_fields[field["label"]]
        transformed = transform_polygon(field["points"], doc_matrix)

        transformed[:, 0] = np.clip(transformed[:, 0], 0, doc_w - 1)
        transformed[:, 1] = np.clip(transformed[:, 1], 0, doc_h - 1)

        raw_crop = crop_field_polygon_masked(
            doc_crop=doc_crop,
            field_polygon=transformed,
        )

        save_ocr_sample(
            out_dir=out_dir,
            subset=subset,
            label_lines=label_lines,
            metadata_lines=metadata_lines,
            all_texts=all_texts,
            raw_crop_bgr=raw_crop,
            text=text,
            source_stem=source_stem,
            source_image_name=source_image_name,
            task_id=task_id,
            frame_id=frame_id,
            doc_type=doc_type,
            doc_index=doc_index,
            field_label=field["label"],
            field_name=field_name,
            line_index=field["line_index"],
            sample_index=sample_index,
            variant_name="orig",
        )

        saved_count += 1
        original_count += 1

        for aug_idx in range(augmentations_per_sample):
            aug_crop = augment_raw_ocr_crop(raw_crop)

            save_ocr_sample(
                out_dir=out_dir,
                subset=subset,
                label_lines=label_lines,
                metadata_lines=metadata_lines,
                all_texts=all_texts,
                raw_crop_bgr=aug_crop,
                text=text,
                source_stem=source_stem,
                source_image_name=source_image_name,
                task_id=task_id,
                frame_id=frame_id,
                doc_type=doc_type,
                doc_index=doc_index,
                field_label=field["label"],
                field_name=field_name,
                line_index=field["line_index"],
                sample_index=sample_index,
                variant_name=f"aug_{aug_idx + 1:02d}",
            )

            saved_count += 1
            augmented_count += 1

        sample_index += 1

    return {
        "saved": saved_count,
        "original": original_count,
        "augmented": augmented_count,
    }


def main():
    random.seed(SEED)
    np.random.seed(SEED)

    reset_output_dir(PASSPORT_OUT)
    reset_output_dir(MIGRATION_OUT)

    make_dirs(PASSPORT_OUT)
    make_dirs(MIGRATION_OUT)

    tree = etree.parse(str(XML_PATH))
    image_nodes = tree.findall(".//image")

    random.shuffle(image_nodes)
    split_index = int(len(image_nodes) * TRAIN_RATIO)

    passport_train_labels = []
    passport_val_labels = []
    passport_train_meta = []
    passport_val_meta = []
    passport_texts = []

    migration_train_labels = []
    migration_val_labels = []
    migration_train_meta = []
    migration_val_meta = []
    migration_texts = []

    skip_report = []

    stats = {
        "images": len(image_nodes),

        "passport_samples_train_total": 0,
        "passport_samples_train_original": 0,
        "passport_samples_train_augmented": 0,
        "passport_samples_val_total": 0,
        "passport_samples_val_original": 0,
        "passport_samples_val_augmented": 0,
        "passport_synthetic_qw_train": 0,

        "migration_samples_train_total": 0,
        "migration_samples_train_original": 0,
        "migration_samples_train_augmented": 0,
        "migration_samples_val_total": 0,
        "migration_samples_val_original": 0,
        "migration_samples_val_augmented": 0,

        "empty_text_skipped": 0,
    }

    for idx, image_node in enumerate(image_nodes):
        subset = "train" if idx < split_index else "val"

        image_name = image_node.get("name")
        task_id = image_node.get("task_id", "unknown")
        frame_id = int(image_node.get("id", "0")) % 50

        src_path = find_image_path(image_name)
        image = cv2.imread(str(src_path))

        if image is None:
            skip_report.append(
                f"UNREADABLE_IMAGE | task_id={task_id} | frame_id={frame_id} | image={image_name}"
            )
            continue

        source_stem = safe_filename_part(Path(image_name).stem)

        documents = []
        fields = []

        for polygon_node in image_node.findall("polygon"):
            label = polygon_node.get("label")
            points = parse_points(polygon_node.get("points"))

            if label in DOCUMENT_LABELS:
                documents.append(
                    {
                        "label": label,
                        "name": DOCUMENT_LABELS[label],
                        "points": points,
                    }
                )
            else:
                content = get_attr(polygon_node, "content", "")
                line_index = get_attr(polygon_node, "line_index", "1")

                fields.append(
                    {
                        "label": label,
                        "points": points,
                        "content": content,
                        "line_index": line_index,
                    }
                )

        passport_doc_index = 0
        migration_doc_index = 0

        for doc in documents:
            if doc["name"] == "passport":
                label_lines = (
                    passport_train_labels
                    if subset == "train"
                    else passport_val_labels
                )
                meta_lines = (
                    passport_train_meta
                    if subset == "train"
                    else passport_val_meta
                )

                result = process_doc(
                    out_dir=PASSPORT_OUT,
                    subset=subset,
                    label_lines=label_lines,
                    metadata_lines=meta_lines,
                    all_texts=passport_texts,
                    source_stem=source_stem,
                    source_image_name=image_name,
                    task_id=task_id,
                    frame_id=frame_id,
                    image=image,
                    doc_type="passport",
                    doc_index=passport_doc_index,
                    doc_polygon=doc["points"],
                    fields=fields,
                    allowed_fields=PASSPORT_FIELDS,
                    skip_report=skip_report,
                )

                if subset == "train":
                    stats["passport_samples_train_total"] += result["saved"]
                    stats["passport_samples_train_original"] += result["original"]
                    stats["passport_samples_train_augmented"] += result["augmented"]
                else:
                    stats["passport_samples_val_total"] += result["saved"]
                    stats["passport_samples_val_original"] += result["original"]
                    stats["passport_samples_val_augmented"] += result["augmented"]

                passport_doc_index += 1

            elif doc["name"] == "migration_card":
                label_lines = (
                    migration_train_labels
                    if subset == "train"
                    else migration_val_labels
                )
                meta_lines = (
                    migration_train_meta
                    if subset == "train"
                    else migration_val_meta
                )

                result = process_doc(
                    out_dir=MIGRATION_OUT,
                    subset=subset,
                    label_lines=label_lines,
                    metadata_lines=meta_lines,
                    all_texts=migration_texts,
                    source_stem=source_stem,
                    source_image_name=image_name,
                    task_id=task_id,
                    frame_id=frame_id,
                    image=image,
                    doc_type="migration_card",
                    doc_index=migration_doc_index,
                    doc_polygon=doc["points"],
                    fields=fields,
                    allowed_fields=MIGRATION_FIELDS,
                    skip_report=skip_report,
                )

                if subset == "train":
                    stats["migration_samples_train_total"] += result["saved"]
                    stats["migration_samples_train_original"] += result["original"]
                    stats["migration_samples_train_augmented"] += result["augmented"]
                else:
                    stats["migration_samples_val_total"] += result["saved"]
                    stats["migration_samples_val_original"] += result["original"]
                    stats["migration_samples_val_augmented"] += result["augmented"]

                migration_doc_index += 1

    if ADD_SYNTHETIC_QW:
        synthetic_count = add_synthetic_qw_samples(
            out_dir=PASSPORT_OUT,
            label_lines=passport_train_labels,
            metadata_lines=passport_train_meta,
            all_texts=passport_texts,
            skip_report=skip_report,
        )
        stats["passport_synthetic_qw_train"] = synthetic_count
        stats["passport_samples_train_total"] += synthetic_count

    (PASSPORT_OUT / "rec_gt_train.txt").write_text(
        "\n".join(passport_train_labels) + "\n",
        encoding="utf-8",
    )
    (PASSPORT_OUT / "rec_gt_val.txt").write_text(
        "\n".join(passport_val_labels) + "\n",
        encoding="utf-8",
    )
    (PASSPORT_OUT / "metadata_train.jsonl").write_text(
        "\n".join(passport_train_meta) + "\n",
        encoding="utf-8",
    )
    (PASSPORT_OUT / "metadata_val.jsonl").write_text(
        "\n".join(passport_val_meta) + "\n",
        encoding="utf-8",
    )

    write_dict(
        PASSPORT_OUT,
        passport_texts,
        force_chars=PASSPORT_FORCE_DICT_CHARS,
    )

    (MIGRATION_OUT / "rec_gt_train.txt").write_text(
        "\n".join(migration_train_labels) + "\n",
        encoding="utf-8",
    )
    (MIGRATION_OUT / "rec_gt_val.txt").write_text(
        "\n".join(migration_val_labels) + "\n",
        encoding="utf-8",
    )
    (MIGRATION_OUT / "metadata_train.jsonl").write_text(
        "\n".join(migration_train_meta) + "\n",
        encoding="utf-8",
    )
    (MIGRATION_OUT / "metadata_val.jsonl").write_text(
        "\n".join(migration_val_meta) + "\n",
        encoding="utf-8",
    )

    write_dict(
        MIGRATION_OUT,
        migration_texts,
        force_chars=None,
    )

    stats["empty_text_skipped"] = sum(
        1 for line in skip_report if line.startswith("EMPTY_TEXT")
    )

    Path("paddleocr_prepare_report.txt").write_text(
        "\n".join(skip_report) + "\n",
        encoding="utf-8",
    )

    Path("paddleocr_prepare_stats.json").write_text(
        json.dumps(stats, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    print("Done")
    for k, v in stats.items():
        print(f"{k}: {v}")

    print(f"Passport dataset: {PASSPORT_OUT}")
    print(f"Migration dataset: {MIGRATION_OUT}")
    print("Report: paddleocr_prepare_report.txt")
    print("Stats: paddleocr_prepare_stats.json")


if __name__ == "__main__":
    main()
