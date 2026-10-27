from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps, ImageFilter, ImageEnhance
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

NUM_Q_SAMPLES = 90
NUM_W_SAMPLES = 40
NUM_MIXED_SAMPLES = 30

TARGET_HEIGHT = 48
MIN_WIDTH = 32
MAX_WIDTH = 768

PAD_X = 8
PAD_Y = 8

FORCE_DICT_CHARS = set("-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ")

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
    # "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    # "/usr/share/fonts/truetype/liberation2/LiberationMono-Bold.ttf",
    # "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
    # "/usr/share/fonts/truetype/freefont/FreeMonoBold.ttf",
    # "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
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

COMMON_SUFFIXES = [
    "OV",
    "OVA",
    "EV",
    "EVA",
    "YEV",
    "YEVA",
    "JON",
    "BEK",
    "UGLI",
    "QIZI",
    "ZODA",
    "OVICH",
    "EVICH",
]


def prepare_ocr_image(
    src_path: str | Path,
    dst_path: str | Path,
    target_height: int = TARGET_HEIGHT,
    min_width: int = MIN_WIDTH,
    max_width: int = MAX_WIDTH,
    pad_x: int = PAD_X,
    pad_y: int = PAD_Y,
    grayscale: bool = True,
    normalize_background: bool = True,
) -> None:
    src_path = Path(src_path)
    dst_path = Path(dst_path)
    dst_path.parent.mkdir(parents=True, exist_ok=True)

    img = Image.open(src_path)
    img = ImageOps.exif_transpose(img)

    if img.mode in ("RGBA", "LA"):
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img.convert("RGB"), mask=img.getchannel("A"))
        img = bg
    else:
        img = img.convert("RGB")

    img = ImageOps.expand(
        img,
        border=(pad_x, pad_y, pad_x, pad_y),
        fill=(255, 255, 255),
    )

    if grayscale:
        img = img.convert("L")

        if normalize_background:
            bg = img.filter(
                ImageFilter.GaussianBlur(
                    radius=max(3, img.height // 2)
                )
            )
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

    img.save(dst_path, optimize=True)


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
    font_path = random.choice(font_paths)
    return ImageFont.truetype(str(font_path), size=size)


def measure_chars(
    text: str,
    font: ImageFont.FreeTypeFont,
    spacing: int,
):
    dummy = Image.new("L", (1, 1), 255)
    draw = ImageDraw.Draw(dummy)

    items = []

    min_top = 10**9
    max_bottom = -10**9
    total_w = 0

    for ch in text:
        bbox = draw.textbbox((0, 0), ch, font=font)

        left = bbox[0]
        top = bbox[1]
        right = bbox[2]
        bottom = bbox[3]

        w = right - left
        h = bottom - top

        items.append(
            {
                "ch": ch,
                "bbox": bbox,
                "w": w,
                "h": h,
            }
        )

        min_top = min(min_top, top)
        max_bottom = max(max_bottom, bottom)
        total_w += w

    if text:
        total_w += spacing * (len(text) - 1)

    total_h = max_bottom - min_top

    return items, total_w, total_h, min_top, max_bottom


def add_noise(img: Image.Image) -> Image.Image:
    arr = np.array(img).astype(np.int16)

    sigma = random.uniform(3.0, 10.0)
    noise = np.random.normal(0, sigma, arr.shape).astype(np.int16)
    arr = arr + noise

    if random.random() < 0.35:
        # Немного неравномерного фона по горизонтали
        h, w = arr.shape[:2]
        gradient = np.linspace(
            random.uniform(-10, 5),
            random.uniform(5, 14),
            w,
        ).astype(np.int16)

        arr = arr + gradient.reshape(1, w, 1)

    arr = np.clip(arr, 0, 255).astype(np.uint8)

    return Image.fromarray(arr)


def random_affine(
    img: Image.Image,
    fill: tuple[int, int, int],
) -> Image.Image:
    w, h = img.size

    # Лёгкий наклон, как от перспективы/скана
    shear = random.uniform(-0.04, 0.04)
    new_w = int(w + abs(shear) * h) + 12

    if shear >= 0:
        matrix = (1, shear, 4, 0, 1, 4)
    else:
        matrix = (1, shear, abs(shear) * h + 4, 0, 1, 4)

    img = img.transform(
        (new_w, h + 8),
        Image.Transform.AFFINE,
        matrix,
        resample=Image.Resampling.BICUBIC,
        fillcolor=fill,
    )

    angle = random.uniform(-1.2, 1.2)

    img = img.rotate(
        angle,
        resample=Image.Resampling.BICUBIC,
        expand=True,
        fillcolor=fill,
    )

    return img


def render_raw_text(
    text: str,
    font_paths: list[Path],
) -> Image.Image:
    font_size = random.randint(24, 36)
    spacing = random.randint(1, 4)
    font = choose_font(font_paths, font_size)

    items, text_w, text_h, min_top, _ = measure_chars(
        text=text,
        font=font,
        spacing=spacing,
    )

    safe_x = random.randint(10, 18)
    safe_y = random.randint(14, 24)

    pad_left = random.randint(6, 14) + safe_x
    pad_right = random.randint(6, 14) + safe_x
    pad_top = random.randint(6, 12) + safe_y
    pad_bottom = random.randint(6, 12) + safe_y

    bg_value = random.randint(205, 235)
    fg_value = random.randint(5, 45)

    bg = (
        bg_value + random.randint(-3, 3),
        bg_value + random.randint(-3, 3),
        bg_value + random.randint(-3, 3),
    )

    fg = (
        fg_value + random.randint(0, 10),
        fg_value + random.randint(0, 10),
        fg_value + random.randint(0, 10),
    )

    img_w = max(40, int(text_w + pad_left + pad_right))
    img_h = max(40, int(text_h + pad_top + pad_bottom))

    img = Image.new("RGB", (img_w, img_h), bg)
    draw = ImageDraw.Draw(img)

    cursor_x = pad_left

    # Компенсация bbox top.
    # Без этого буквы с верхними/нижними выносными элементами могут обрезаться.
    base_y = pad_top - min_top

    for item in items:
        ch = item["ch"]
        bbox = item["bbox"]
        ch_w = item["w"]

        jitter_y = random.randint(-1, 1)

        # Иногда чуть разная насыщенность букв.
        local_fg = tuple(
            max(0, min(255, c + random.randint(-5, 5)))
            for c in fg
        )

        draw_x = cursor_x - bbox[0]
        draw_y = base_y + jitter_y

        draw.text(
            (draw_x, draw_y),
            ch,
            font=font,
            fill=local_fg,
        )

        cursor_x += ch_w + spacing

    # Иногда чуть растянуть/сжать по ширине.
    stretch_x = random.uniform(0.88, 1.12)
    stretch_y = random.uniform(0.92, 1.08)

    img = img.resize(
        (
            max(20, int(img.width * stretch_x)),
            max(20, int(img.height * stretch_y)),
        ),
        Image.Resampling.BICUBIC,
    )

    img = ImageOps.expand(
        img,
        border=8,
        fill=bg,
    )

    img = random_affine(img, fill=bg)

    img = ImageOps.expand(
        img,
        border=8,
        fill=bg,
    )

    if random.random() < 0.85:
        img = img.filter(
            ImageFilter.GaussianBlur(
                radius=random.uniform(0.15, 0.65)
            )
        )

    if random.random() < 0.35:
        img = ImageEnhance.Contrast(img).enhance(
            random.uniform(0.85, 1.15)
        )

    img = add_noise(img)

    return img


def random_q_text() -> str:
    base = random.choice(Q_WORDS)
    mode = random.random()

    if mode < 0.50:
        base = random.choice(COMMON_SUFFIXES) + base

    if mode < 0.80:
        return base + " " + random.choice(COMMON_SUFFIXES)

    if mode < 0.90:
        return random.choice(["QODIR", "QURBON", "QOSIM", "QAHHOR", "QAYUM"]) + random.choice(COMMON_SUFFIXES)

    return random.choice(COMMON_SUFFIXES) + " " + base


def random_w_text() -> str:
    base = random.choice(W_WORDS)
    mode = random.random()

    if mode < 0.5:
        base = random.choice(COMMON_SUFFIXES) + base

    if mode < 0.7:
        return base

    if mode < 0.80:
        return base + " " + random.choice(["OV", "OVA", "EV", "EVA"])

    return random.choice(["NEW", "WEST", "WHITE"]) + base


def random_mixed_text() -> str:
    left = random.choice(Q_WORDS)
    right = random.choice(W_WORDS)

    if random.random() < 0.5:
        return left + " " + right

    return right + " " + left


def clean_old_synthetic_labels():
    if not TRAIN_LABEL_FILE.exists():
        raise FileNotFoundError(TRAIN_LABEL_FILE)

    lines = TRAIN_LABEL_FILE.read_text(
        encoding="utf-8"
    ).splitlines()

    prefix = SYNTH_REL_DIR.as_posix() + "/"

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


def update_dict(chars_to_add: set[str]):
    if not DICT_FILE.exists():
        raise FileNotFoundError(DICT_FILE)

    lines = DICT_FILE.read_text(
        encoding="utf-8"
    ).splitlines()

    existing = [
        line.strip()
        for line in lines
        if line.strip()
    ]

    existing_set = set(existing)

    for ch in sorted(chars_to_add):
        if ch == " ":
            continue

        if ch not in existing_set:
            existing.append(ch)
            existing_set.add(ch)

    DICT_FILE.write_text(
        "\n".join(existing) + "\n",
        encoding="utf-8",
    )


def safe_name(text: str) -> str:
    text = re.sub(r"[^A-Z0-9]+", "_", text)
    text = text.strip("_")
    return text[:64] if text else "sample"


def generate_samples():
    random.seed(SEED)
    np.random.seed(SEED)

    font_paths = load_font_paths()

    clean_old_synthetic_labels()
    reset_synthetic_dir()

    specs = []

    for _ in range(NUM_Q_SAMPLES):
        specs.append(("q", random_q_text()))

    for _ in range(NUM_W_SAMPLES):
        specs.append(("w", random_w_text()))

    for _ in range(NUM_MIXED_SAMPLES):
        specs.append(("mixed", random_mixed_text()))

    random.shuffle(specs)

    new_label_lines = []
    chars_used = set(FORCE_DICT_CHARS)

    raw_dir = SYNTH_ABS_DIR / "_raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    for idx, (kind, text) in enumerate(specs):
        raw_img = render_raw_text(text, font_paths)

        name = f"synth_{idx:06d}_{kind}_{safe_name(text)}.png"

        raw_path = raw_dir / name
        final_rel = SYNTH_REL_DIR / name
        final_abs = DATASET_DIR / final_rel

        raw_img.save(raw_path)

        prepare_ocr_image(
            src_path=raw_path,
            dst_path=final_abs,
        )

        new_label_lines.append(
            f"{final_rel.as_posix()}\t{text}"
        )

        chars_used.update(text)

    shutil.rmtree(raw_dir)

    with TRAIN_LABEL_FILE.open("a", encoding="utf-8") as f:
        for line in new_label_lines:
            f.write(line + "\n")

    update_dict(chars_used)

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
                f"pad_x={PAD_X}",
                f"pad_y={PAD_Y}",
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
    print(f"Dict updated: {DICT_FILE}")
    print(f"Report: {report_path}")


if __name__ == "__main__":
    generate_samples()
