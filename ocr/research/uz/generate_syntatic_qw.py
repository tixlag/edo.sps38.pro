from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageOps, ImageEnhance
import numpy as np
import random
import shutil
import re


DATASET_DIR = Path("paddleocr_passport_rec")
TRAIN_LABEL_FILE = DATASET_DIR / "rec_gt_train.txt"
DICT_FILE = DATASET_DIR / "dict.txt"

SYNTH_REL_DIR = Path("train") / "_synthetic_qw"
SYNTH_ABS_DIR = DATASET_DIR / SYNTH_REL_DIR

SEED = 42

NUM_Q_SAMPLES = 120
NUM_W_SAMPLES = 60
NUM_MIXED_SAMPLES = 40

TARGET_HEIGHT = 48
MIN_WIDTH = 64
MAX_WIDTH = 768

DICT_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]

Q_WORDS = [
    "QODIROV",
    "QODIROVA",
    "QADIRBOEV",
    "QADIRBOEVA",
    "QURBONOV",
    "QURBONOVA",
    "QURBONBOEV",
    "QURBONBOEVA",
    "QOSIMOV",
    "QOSIMOVA",
    "QOSIMJON",
    "QOBILOV",
    "QOBILOVA",
    "QAHHOROV",
    "QAHHOROVA",
    "QAYUMOV",
    "QAYUMOVA",
    "QOCHQOROV",
    "QOCHQOROVA",
    "QODIRJON",
    "QUDRATOV",
    "QUDRATOVA",
    "QULMATOV",
    "QULMATOVA",
    "QALANDAROV",
    "QALANDAROVA",
    "QARSHI",
    "QASHQADARYA",
    "QORAQALPOGISTON",
    "QOQON",
    "QIBRAY",
    "QIZILTEPA",
    "QOZON",
]

W_WORDS = [
    "WILLIAM",
    "WILSON",
    "WALTER",
    "WATSON",
    "WASHINGTON",
    "WEST",
    "WHITE",
    "WILLIAMS",
    "WILLIAMSON",
    "BROWN",
    "WOOD",
    "WALKER",
    "WILKER",
    "WILHELM",
    "EDWARD",
    "HOWARD",
    "LAWRENCE",
    "LEWIS",
    "NEWTON",
    "WERNER",
]

EXTRA_PHRASES = [
    "QASHQADARYA REGION",
    "QORAQALPOGISTON",
    "WASHINGTON REGION",
    "NEW YORK",
    "WEST REGION",
    "WHITE REGION",
]

COMMON_PARTS = [
    "OV",
    "OVA",
    "EV",
    "EVA",
    "YEV",
    "YEVA",
    "UGLI",
    "QIZI",
    "ZODA",
    "OVICH",
    "EVICH",
]


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
    return ImageFont.truetype(
        str(random.choice(font_paths)),
        size=size,
    )


def collect_real_style_images() -> list[Path]:
    train_dir = DATASET_DIR / "train"

    if not train_dir.exists():
        raise FileNotFoundError(train_dir)

    images = []

    for ext in ("*.png", "*.jpg", "*.jpeg"):
        images.extend(train_dir.rglob(ext))

    images = [
        p
        for p in images
        if "_synthetic_qw" not in p.as_posix()
    ]

    if not images:
        raise RuntimeError(
            f"No real OCR images found in {train_dir}"
        )

    return images


def clean_old_synthetic_labels():
    if not TRAIN_LABEL_FILE.exists():
        raise FileNotFoundError(TRAIN_LABEL_FILE)

    prefix = SYNTH_REL_DIR.as_posix() + "/"

    lines = TRAIN_LABEL_FILE.read_text(
        encoding="utf-8",
    ).splitlines()

    filtered = [
        line
        for line in lines
        if not line.startswith(prefix)
    ]

    TRAIN_LABEL_FILE.write_text(
        "\n".join(filtered).rstrip() + "\n",
        encoding="utf-8",
    )


def reset_synthetic_dir():
    if SYNTH_ABS_DIR.exists():
        shutil.rmtree(SYNTH_ABS_DIR)

    SYNTH_ABS_DIR.mkdir(parents=True, exist_ok=True)


def rewrite_passport_dict():
    DICT_FILE.parent.mkdir(parents=True, exist_ok=True)

    DICT_FILE.write_text(
        "\n".join(DICT_CHARS) + "\n",
        encoding="utf-8",
    )


def safe_name(text: str) -> str:
    text = re.sub(r"[^A-Z0-9]+", "_", text)
    text = text.strip("_")
    return text[:64] if text else "sample"


def random_q_text() -> str:
    base = random.choice(Q_WORDS)
    mode = random.random()

    if mode < 0.55:
        return base

    if mode < 0.75:
        return base + " " + random.choice(COMMON_PARTS)

    if mode < 0.90:
        return random.choice(COMMON_PARTS) + " " + base

    return random.choice(EXTRA_PHRASES)


def random_w_text() -> str:
    base = random.choice(W_WORDS)
    mode = random.random()

    if mode < 0.60:
        return base

    if mode < 0.80:
        return base + " " + random.choice(["OV", "OVA", "EV", "EVA"])

    return random.choice(EXTRA_PHRASES)


def random_mixed_text() -> str:
    left = random.choice(Q_WORDS)
    right = random.choice(W_WORDS)

    if random.random() < 0.5:
        return left + " " + right

    return right + " " + left


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
        advance = draw.textlength(ch, font=font)

        left, top, right, bottom = bbox
        bbox_w = right - left
        bbox_h = bottom - top

        width = max(int(round(advance)), bbox_w, 1)

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

    text_h = max_bottom - min_top

    return items, total_w, text_h, min_top, max_bottom


def choose_font_that_fits(
    text: str,
    font_paths: list[Path],
):
    for _ in range(30):
        font_size = random.randint(29, 38)
        spacing = random.randint(2, 5)
        font = choose_font(font_paths, font_size)

        items, text_w, text_h, min_top, max_bottom = measure_text(
            text,
            font,
            spacing,
        )

        width = text_w + random.randint(10, 22)

        if MIN_WIDTH <= width <= MAX_WIDTH:
            return font, spacing, items, text_w, text_h, min_top, max_bottom

    font_size = 30
    spacing = 2
    font = choose_font(font_paths, font_size)

    return (
        font,
        spacing,
        *measure_text(text, font, spacing),
    )


def make_background_from_real(
    real_paths: list[Path],
    width: int,
    height: int,
) -> Image.Image:
    ref_path = random.choice(real_paths)
    ref = Image.open(ref_path).convert("L")

    ref = ImageOps.autocontrast(ref)

    # Сильно размываем реальный OCR-кроп, чтобы убрать буквы,
    # но оставить тон бумаги/шум/полосы.
    bg = ref.filter(
        ImageFilter.GaussianBlur(
            radius=random.uniform(6.0, 12.0)
        )
    )

    bg = bg.resize(
        (width, height),
        Image.Resampling.BICUBIC,
    )

    arr = np.array(bg).astype(np.float32)

    # Приводим к серому фону как в реальных примерах.
    mean = arr.mean()
    target_mean = random.uniform(172, 215)
    arr = arr - mean + target_mean

    # Горизонтальный/вертикальный слабый градиент.
    x_grad = np.linspace(
        random.uniform(-8, 4),
        random.uniform(4, 10),
        width,
        dtype=np.float32,
    )
    y_grad = np.linspace(
        random.uniform(-4, 4),
        random.uniform(4, -4),
        height,
        dtype=np.float32,
    )

    arr += x_grad.reshape(1, width)
    arr += y_grad.reshape(height, 1)

    # Низкочастотная пятнистость.
    low = np.random.normal(
        0,
        random.uniform(2.0, 5.0),
        (max(4, height // 4), max(4, width // 4)),
    ).astype(np.float32)

    low_img = Image.fromarray(
        np.clip(low + 128, 0, 255).astype(np.uint8),
        mode="L",
    ).resize(
        (width, height),
        Image.Resampling.BICUBIC,
    )

    low_arr = np.array(low_img).astype(np.float32) - 128
    arr += low_arr

    # Мелкий шум.
    arr += np.random.normal(
        0,
        random.uniform(2.0, 5.5),
        arr.shape,
    ).astype(np.float32)

    arr = np.clip(arr, 110, 245).astype(np.uint8)

    return Image.fromarray(arr, mode="L").convert("RGB")


def draw_text_on_background(
    text: str,
    bg: Image.Image,
    font: ImageFont.FreeTypeFont,
    spacing: int,
    items: list[dict],
    min_top: int,
) -> Image.Image:
    width, height = bg.size

    img = bg.copy()
    draw = ImageDraw.Draw(img)

    total_w = sum(item["advance"] for item in items)
    total_w += spacing * max(0, len(items) - 1)

    x = random.randint(3, 8)

    if total_w + x > width - 3:
        x = max(2, width - total_w - 4)

    # Центрируем по высоте, но оставляем маленький случайный сдвиг.
    bbox_bottoms = [
        item["bbox"][3]
        for item in items
        if item["bbox"][3] > item["bbox"][1]
    ]
    bbox_tops = [
        item["bbox"][1]
        for item in items
        if item["bbox"][3] > item["bbox"][1]
    ]

    if bbox_tops and bbox_bottoms:
        real_top = min(bbox_tops)
        real_bottom = max(bbox_bottoms)
        text_h = real_bottom - real_top
    else:
        real_top = min_top
        text_h = font.size

    y = int((height - text_h) / 2 - real_top)
    y += random.randint(-2, 2)

    # Подстраховка от обрезания.
    y = max(y, -real_top + 2)

    for item in items:
        ch = item["ch"]
        bbox = item["bbox"]

        jitter_y = random.randint(-1, 1)
        jitter_x = random.choice([0, 0, 0, 1, -1])

        ink = random.randint(0, 38)

        # В реальных кропах буквы почти чёрные, но не идеально одинаковые.
        color = (
            ink + random.randint(0, 8),
            ink + random.randint(0, 8),
            ink + random.randint(0, 8),
        )

        draw.text(
            (
                x - bbox[0] + jitter_x,
                y + jitter_y,
            ),
            ch,
            font=font,
            fill=color,
        )

        x += item["advance"] + spacing

    return img


def degrade_like_passport_ocr(img: Image.Image) -> Image.Image:
    # Лёгкое размытие печати.
    if random.random() < 0.95:
        img = img.filter(
            ImageFilter.GaussianBlur(
                radius=random.uniform(0.25, 0.75)
            )
        )

    # Иногда чуть усиливаем чёрный текст.
    if random.random() < 0.5:
        img = ImageEnhance.Contrast(img).enhance(
            random.uniform(1.05, 1.35)
        )

    arr = np.array(img).astype(np.int16)

    # Мелкий шум после текста.
    sigma = random.uniform(2.0, 6.0)
    arr += np.random.normal(0, sigma, arr.shape).astype(np.int16)

    # Иногда лёгкая горизонтальная смазанность/сканирование.
    if random.random() < 0.25:
        pil = Image.fromarray(
            np.clip(arr, 0, 255).astype(np.uint8)
        )
        pil = pil.filter(
            ImageFilter.GaussianBlur(
                radius=(random.uniform(0.15, 0.35))
            )
        )
        arr = np.array(pil).astype(np.int16)

    arr = np.clip(arr, 0, 255).astype(np.uint8)

    img = Image.fromarray(arr)

    # Иногда лёгкая автоконтрастность, как после твоего preprocessing.
    if random.random() < 0.35:
        img = ImageOps.autocontrast(img, cutoff=random.uniform(0.0, 1.0))

    return img.convert("RGB")


def render_synthetic_ocr_image(
    text: str,
    font_paths: list[Path],
    real_style_images: list[Path],
) -> Image.Image:
    (
        font,
        spacing,
        items,
        text_w,
        text_h,
        min_top,
        _,
    ) = choose_font_that_fits(text, font_paths)

    width = int(text_w + random.randint(10, 22))

    # Длинные строки как place_of_birth должны быть широкими.
    if "REGION" in text or len(text) >= 14:
        width += random.randint(20, 80)

    width = max(MIN_WIDTH, min(MAX_WIDTH, width))

    bg = make_background_from_real(
        real_paths=real_style_images,
        width=width,
        height=TARGET_HEIGHT,
    )

    img = draw_text_on_background(
        text=text,
        bg=bg,
        font=font,
        spacing=spacing,
        items=items,
        min_top=min_top,
    )

    img = degrade_like_passport_ocr(img)

    return img


def generate_specs() -> list[tuple[str, str]]:
    specs = []

    for _ in range(NUM_Q_SAMPLES):
        specs.append(("q", random_q_text()))

    for _ in range(NUM_W_SAMPLES):
        specs.append(("w", random_w_text()))

    for _ in range(NUM_MIXED_SAMPLES):
        specs.append(("mixed", random_mixed_text()))

    random.shuffle(specs)

    return specs


def validate_text_for_passport_dict(text: str):
    allowed = set(DICT_CHARS) | {" "}

    bad = sorted(set(text) - allowed)

    if bad:
        raise ValueError(
            f"Text contains chars not in passport dict: {bad} | text={text}"
        )


def generate_samples():
    random.seed(SEED)
    np.random.seed(SEED)

    font_paths = load_font_paths()
    real_style_images = collect_real_style_images()

    clean_old_synthetic_labels()
    reset_synthetic_dir()
    rewrite_passport_dict()

    specs = generate_specs()

    new_label_lines = []

    for idx, (kind, text) in enumerate(specs):
        validate_text_for_passport_dict(text)

        img = render_synthetic_ocr_image(
            text=text,
            font_paths=font_paths,
            real_style_images=real_style_images,
        )

        name = f"synth_{idx:06d}_{kind}_{safe_name(text)}.png"

        final_rel = SYNTH_REL_DIR / name
        final_abs = DATASET_DIR / final_rel

        final_abs.parent.mkdir(parents=True, exist_ok=True)
        img.save(final_abs, optimize=True)

        new_label_lines.append(
            f"{final_rel.as_posix()}\t{text}"
        )

    with TRAIN_LABEL_FILE.open("a", encoding="utf-8") as f:
        for line in new_label_lines:
            f.write(line + "\n")

    report_path = DATASET_DIR / "synthetic_qw_report.txt"
    report_path.write_text(
        "\n".join(
            [
                f"generated_total={len(new_label_lines)}",
                f"q_samples={NUM_Q_SAMPLES}",
                f"w_samples={NUM_W_SAMPLES}",
                f"mixed_samples={NUM_MIXED_SAMPLES}",
                f"output_dir={SYNTH_REL_DIR.as_posix()}",
                f"label_file={TRAIN_LABEL_FILE.as_posix()}",
                f"dict_file={DICT_FILE.as_posix()}",
                f"target_height={TARGET_HEIGHT}",
                f"min_width={MIN_WIDTH}",
                f"max_width={MAX_WIDTH}",
                f"real_style_images={len(real_style_images)}",
                f"fonts_used={','.join(str(p) for p in font_paths)}",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    print("Done")
    print(f"Generated: {len(new_label_lines)}")
    print(f"Images: {SYNTH_ABS_DIR}")
    print(f"Labels appended to: {TRAIN_LABEL_FILE}")
    print(f"Dict rewritten: {DICT_FILE}")
    print(f"Report: {report_path}")


if __name__ == "__main__":
    generate_samples()
