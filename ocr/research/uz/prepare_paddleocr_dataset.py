from pathlib import Path
from lxml import etree
from PIL import Image, ImageOps, ImageFilter, ImageEnhance
import cv2
import numpy as np
import random
import json
import re


CVAT_ROOT = Path("uz-annotaited-dataset")
XML_PATH = CVAT_ROOT / "annotations.xml"
IMAGES_DIR = CVAT_ROOT / "images"

PASSPORT_OUT = Path("paddleocr_passport_rec")
MIGRATION_OUT = Path("paddleocr_migration_rec")

TRAIN_RATIO = 0.9
SEED = 42

TARGET_HEIGHT = 48
MIN_WIDTH = 32
MAX_WIDTH = 768
PAD_X = 4
PAD_Y = 4

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
        Image.Resampling.BICUBIC,
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


def normalize_text(text: str, doc_type) -> str:
    text = text.replace("\t", " ")
    text = text.replace("\n", " ")
    # Replace dots with spaces for dates in format xx.xx.xxxx
    if doc_type == 'passport':
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


def order_field_quad(points: np.ndarray) -> np.ndarray:
    if len(points) >= 4:
        return points[:4].astype(np.float32)

    rect = cv2.minAreaRect(points.astype(np.float32))
    box = cv2.boxPoints(rect)

    s = box.sum(axis=1)
    diff = np.diff(box, axis=1).reshape(-1)

    ordered = np.zeros((4, 2), dtype=np.float32)
    ordered[0] = box[np.argmin(s)]
    ordered[2] = box[np.argmax(s)]
    ordered[1] = box[np.argmin(diff)]
    ordered[3] = box[np.argmax(diff)]

    return ordered


def crop_field_from_document(
    doc_crop: np.ndarray,
    field_polygon: np.ndarray,
):
    src = order_field_quad(field_polygon)

    top_w = np.linalg.norm(src[1] - src[0])
    bottom_w = np.linalg.norm(src[2] - src[3])
    crop_w = int(max(top_w, bottom_w))

    right_h = np.linalg.norm(src[2] - src[1])
    left_h = np.linalg.norm(src[3] - src[0])
    crop_h = int(max(right_h, left_h))

    crop_w = max(crop_w, 4)
    crop_h = max(crop_h, 4)

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
    crop = cv2.warpPerspective(doc_crop, matrix, (crop_w, crop_h))

    return crop


def make_dirs(base: Path):
    (base / "train").mkdir(parents=True, exist_ok=True)
    (base / "val").mkdir(parents=True, exist_ok=True)


def safe_filename_part(text: str) -> str:
    text = re.sub(r"[^\w\-]+", "_", text, flags=re.UNICODE)
    text = text.strip("_")
    return text[:80] if text else "sample"


def write_dict(base: Path, texts: list[str]):
    chars = sorted(
        {
            ch
            for text in texts
            for ch in text
            if ch != " "
        }
    )

    (base / "dict.txt").write_text(
        "\n".join(chars) + "\n",
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
            },
            ensure_ascii=False,
        )
    )


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

        raw_crop = crop_field_from_document(
            doc_crop=doc_crop,
            field_polygon=transformed,
        )

        raw_tmp = out_dir / "_tmp_raw" / f"{source_stem}_{doc_type}_{doc_index}_{sample_index}.png"
        raw_tmp.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(raw_tmp), raw_crop)

        label_prefix = field["label"].split("_", 1)[0]
        file_name = (
            f"{source_stem}"
            f"__{doc_type}_{doc_index}"
            f"__{label_prefix}_{field_name}"
            f"__line_{field['line_index']}"
            f"__{sample_index}.png"
        )

        dst_rel = Path(subset) / file_name
        dst_abs = out_dir / dst_rel

        prepare_ocr_image(
            src_path=raw_tmp,
            dst_path=dst_abs,
        )

        raw_tmp.unlink(missing_ok=True)

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
            field_label=field["label"],
            field_name=field_name,
            line_index=field["line_index"],
        )

        all_texts.append(text)
        sample_index += 1

    return sample_index


def main():
    random.seed(SEED)

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
        "passport_samples_train": 0,
        "passport_samples_val": 0,
        "migration_samples_train": 0,
        "migration_samples_val": 0,
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

                count = process_doc(
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
                    stats["passport_samples_train"] += count
                else:
                    stats["passport_samples_val"] += count

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

                count = process_doc(
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
                    stats["migration_samples_train"] += count
                else:
                    stats["migration_samples_val"] += count

                migration_doc_index += 1

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
    write_dict(PASSPORT_OUT, passport_texts)

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
    write_dict(MIGRATION_OUT, migration_texts)

    tmp_passport = PASSPORT_OUT / "_tmp_raw"
    tmp_migration = MIGRATION_OUT / "_tmp_raw"

    if tmp_passport.exists():
        for p in tmp_passport.glob("*"):
            p.unlink(missing_ok=True)
        tmp_passport.rmdir()

    if tmp_migration.exists():
        for p in tmp_migration.glob("*"):
            p.unlink(missing_ok=True)
        tmp_migration.rmdir()

    stats["empty_text_skipped"] = sum(
        1 for line in skip_report if line.startswith("EMPTY_TEXT")
    )

    Path("paddleocr_prepare_report.txt").write_text(
        "\n".join(skip_report) + "\n",
        encoding="utf-8",
    )

    print("Done")
    for k, v in stats.items():
        print(f"{k}: {v}")

    print(f"Passport dataset: {PASSPORT_OUT}")
    print(f"Migration dataset: {MIGRATION_OUT}")
    print("Report: paddleocr_prepare_report.txt")


if __name__ == "__main__":
    main()
