from pathlib import Path
from lxml import etree
import cv2
import numpy as np
import shutil
import random


CVAT_ROOT = Path("uz-annotaited-dataset")
XML_PATH = CVAT_ROOT / "annotations.xml"
IMAGES_DIR = CVAT_ROOT / "images"

DOC_OUT = Path("yolo_doc_dataset")
PASSPORT_OUT = Path("yolo_passport_fields_dataset")
MIGRATION_OUT = Path("yolo_migration_fields_dataset")

SUSPECTS_PATH = Path("orientation_suspects.txt")

TRAIN_RATIO = 0.9
SEED = 42

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
    "13_pas_photo": "pas_photo",
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


def parse_points(points: str) -> np.ndarray:
    return np.array(
        [list(map(float, p.split(","))) for p in points.split(";")],
        dtype=np.float32,
    )


def normalize_polygon(points: np.ndarray, width: float, height: float) -> str:
    values = []

    for x, y in points:
        x = max(0.0, min(1.0, x / width))
        y = max(0.0, min(1.0, y / height))

        values.append(f"{x:.6f}")
        values.append(f"{y:.6f}")

    return " ".join(values)


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
    return cv2.pointPolygonTest(polygon.astype(np.float32), point, False) >= 0


def order_quad_points(points: np.ndarray) -> np.ndarray:
    """
    Используем первые 4 точки CVAT как направление документа.

    Ожидаемый порядок:
    0 = top-left
    1 = top-right
    2 = bottom-right
    3 = bottom-left

    Если точек больше 4 — считаем разметку подозрительной,
    но берём первые 4, чтобы скрипт не падал.
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


def make_dirs(base: Path):
    for subset in ["train", "val"]:
        (base / "images" / subset).mkdir(parents=True, exist_ok=True)
        (base / "labels" / subset).mkdir(parents=True, exist_ok=True)


def write_yaml(base: Path, classes: list[str]):
    text = f"path: {base.resolve()}\n\n"
    text += "train: images/train\n"
    text += "val: images/val\n\n"
    text += "names:\n"

    for i, name in enumerate(classes):
        text += f"  {i}: {name}\n"

    (base / "dataset.yaml").write_text(text, encoding="utf-8")


def collect_transformed_fields(
    doc_polygon: np.ndarray,
    fields: list[dict],
    allowed_fields: dict[str, str],
    matrix: np.ndarray,
    crop_w: int,
    crop_h: int,
):
    transformed_fields = []

    for field in fields:
        if field["label"] not in allowed_fields:
            continue

        cx, cy = polygon_center(field["points"])

        if not point_in_polygon((cx, cy), doc_polygon):
            continue

        field_name = allowed_fields[field["label"]]
        transformed = transform_polygon(field["points"], matrix)

        transformed[:, 0] = np.clip(transformed[:, 0], 0, crop_w - 1)
        transformed[:, 1] = np.clip(transformed[:, 1], 0, crop_h - 1)

        if len(transformed) < 3:
            continue

        transformed_fields.append(
            {
                "name": field_name,
                "points": transformed,
            }
        )

    return transformed_fields


def check_orientation_suspect(
    task_id: str,
    frame_id: str,
    image_name: str,
    doc_name: str,
    doc_index: int,
    crop_h: int,
    transformed_fields: list[dict],
):
    prefix = (
        f"task_id={task_id} | "
        f"frame_id={frame_id} | "
        f"image={image_name} | "
        f"{doc_name}_{doc_index} | "
    )

    def make_suspect(reason: str):
        return {
            "task_id": int(task_id),
            "frame_id": int(frame_id),
            "text": prefix + reason,
        }

    if doc_name == "passport":
        mrz_fields = [
            f for f in transformed_fields
            if f["name"] == "pas_mrz"
        ]

        if not mrz_fields:
            return make_suspect("NO_MRZ_FIELD_FOUND")

        mrz_y = float(mrz_fields[0]["points"][:, 1].mean())
        mrz_ratio = mrz_y / crop_h

        if mrz_ratio < 0.55:
            return make_suspect(
                f"SUSPECT_PASSPORT_ORIENTATION | pas_mrz_y_ratio={mrz_ratio:.3f}"
            )

    elif doc_name == "migration_card":
        anchors = [
            f for f in transformed_fields
            if f["name"] in {"mg_duration_from", "mg_duration_to"}
        ]

        if not anchors:
            return make_suspect("NO_DURATION_FIELDS_FOUND")

        avg_y = float(
            np.mean([f["points"][:, 1].mean() for f in anchors])
        )
        avg_ratio = avg_y / crop_h

        if avg_ratio < 0.55:
            return make_suspect(
                f"SUSPECT_MIGRATION_ORIENTATION | duration_y_ratio={avg_ratio:.3f}"
            )

    return None


def save_field_crop_dataset(
    out_dir: Path,
    subset: str,
    source_stem: str,
    original_image_name: str,
    doc_index: int,
    doc_name: str,
    image: np.ndarray,
    doc_polygon: np.ndarray,
    fields: list[dict],
    allowed_fields: dict[str, str],
    class_to_id: dict[str, int],
    suspects: list[dict],
    task_id: str,
    frame_id: str|int,
):
    if len(doc_polygon) != 4:
        suspects.append(
            {
                "task_id": int(task_id),
                "frame_id": int(frame_id),
                "text": (
                    f"task_id={task_id} | "
                    f"frame_id={frame_id} | "
                    f"image={original_image_name} | "
                    f"{doc_name}_{doc_index} | "
                    f"SUSPECT_DOCUMENT_POINT_COUNT | "
                    f"points={len(doc_polygon)}"
                ),
            }
        )
    crop, matrix, crop_w, crop_h = warp_document(image, doc_polygon)

    transformed_fields = collect_transformed_fields(
        doc_polygon=doc_polygon,
        fields=fields,
        allowed_fields=allowed_fields,
        matrix=matrix,
        crop_w=crop_w,
        crop_h=crop_h,
    )

    suspect = check_orientation_suspect(
        frame_id=str(frame_id),
        task_id=task_id,
        image_name=original_image_name,
        doc_name=doc_name,
        doc_index=doc_index,
        crop_h=crop_h,
        transformed_fields=transformed_fields,
    )

    if suspect:
        suspects.append(suspect)

    crop_name = f"{source_stem}__{doc_name}_{doc_index}.png"
    crop_path = out_dir / "images" / subset / crop_name
    cv2.imwrite(str(crop_path), crop)

    lines = []

    for field in transformed_fields:
        class_id = class_to_id[field["name"]]

        lines.append(
            f"{class_id} {normalize_polygon(field['points'], crop_w, crop_h)}"
        )

    label_path = out_dir / "labels" / subset / f"{Path(crop_name).stem}.txt"
    label_path.write_text("\n".join(lines), encoding="utf-8")

    return len(lines)


def main():
    random.seed(SEED)

    for out in [DOC_OUT, PASSPORT_OUT, MIGRATION_OUT]:
        make_dirs(out)

    doc_classes = list(DOCUMENT_LABELS.values())
    passport_classes = list(PASSPORT_FIELDS.values())
    migration_classes = list(MIGRATION_FIELDS.values())

    doc_class_to_id = {
        name: i
        for i, name in enumerate(doc_classes)
    }

    passport_class_to_id = {
        name: i
        for i, name in enumerate(passport_classes)
    }

    migration_class_to_id = {
        name: i
        for i, name in enumerate(migration_classes)
    }

    tree = etree.parse(str(XML_PATH))
    images = tree.findall(".//image")

    random.shuffle(images)
    split_index = int(len(images) * TRAIN_RATIO)

    suspects = []

    stats = {
        "images": len(images),
        "doc_objects": 0,
        "passport_crops": 0,
        "migration_crops": 0,
        "passport_fields": 0,
        "migration_fields": 0,
    }

    for idx, image_node in enumerate(images):
        subset = "train" if idx < split_index else "val"

        image_name = image_node.get("name")
        width = float(image_node.get("width"))
        height = float(image_node.get("height"))
        task_id = image_node.get("task_id")
        frame_id = int(image_node.get("id")) % 50

        src_path = find_image_path(image_name)
        image = cv2.imread(str(src_path))

        if image is None:
            print(f"Skip unreadable image: {src_path}")
            continue

        safe_name = Path(image_name).name
        stem = Path(safe_name).stem

        shutil.copy2(src_path, DOC_OUT / "images" / subset / safe_name)

        documents = []
        fields = []
        doc_lines = []

        for polygon_node in image_node.findall("polygon"):
            label = polygon_node.get("label")
            points = parse_points(polygon_node.get("points"))

            if label in DOCUMENT_LABELS:
                doc_name = DOCUMENT_LABELS[label]
                class_id = doc_class_to_id[doc_name]

                doc_lines.append(
                    f"{class_id} {normalize_polygon(points, width, height)}"
                )

                documents.append(
                    {
                        "label": label,
                        "name": doc_name,
                        "points": points,
                    }
                )

                stats["doc_objects"] += 1

            else:
                fields.append(
                    {
                        "label": label,
                        "points": points,
                    }
                )

        (DOC_OUT / "labels" / subset / f"{stem}.txt").write_text(
            "\n".join(doc_lines),
            encoding="utf-8",
        )

        for doc_index, doc in enumerate(documents):
            if doc["name"] == "passport":
                count = save_field_crop_dataset(
                    out_dir=PASSPORT_OUT,
                    subset=subset,
                    source_stem=stem,
                    original_image_name=image_name,
                    doc_index=doc_index,
                    doc_name="passport",
                    image=image,
                    doc_polygon=doc["points"],
                    fields=fields,
                    allowed_fields=PASSPORT_FIELDS,
                    class_to_id=passport_class_to_id,
                    suspects=suspects,
                    task_id=task_id,
                    frame_id=frame_id
                )

                stats["passport_crops"] += 1
                stats["passport_fields"] += count

            elif doc["name"] == "migration_card":
                count = save_field_crop_dataset(
                    out_dir=MIGRATION_OUT,
                    subset=subset,
                    source_stem=stem,
                    original_image_name=image_name,
                    doc_index=doc_index,
                    doc_name="migration_card",
                    image=image,
                    doc_polygon=doc["points"],
                    fields=fields,
                    allowed_fields=MIGRATION_FIELDS,
                    class_to_id=migration_class_to_id,
                    suspects=suspects,
                    task_id=task_id,
                    frame_id=frame_id
                )

                stats["migration_crops"] += 1
                stats["migration_fields"] += count

    write_yaml(DOC_OUT, doc_classes)
    write_yaml(PASSPORT_OUT, passport_classes)
    write_yaml(MIGRATION_OUT, migration_classes)

    if suspects:

        suspects.sort(
            key=lambda x: (int(x["task_id"]), int(x["frame_id"]))
        )

        lines = []

        current = None

        for s in suspects:

            if current != s["task_id"]:
                current = s["task_id"]

                lines.append("")
                lines.append(
                    f"===== TASK {current} ====="
                )

            lines.append(
                s["text"]
            )

        SUSPECTS_PATH.write_text(
            "\n".join(lines),
            encoding="utf-8",
        )

    else:

        SUSPECTS_PATH.write_text(
            "No orientation suspects found\n",
            encoding="utf-8",
        )

    print("Done")

    for k, v in stats.items():
        print(f"{k}: {v}")

    print(f"orientation suspects: {len(suspects)}")
    print(f"orientation suspects file: {SUSPECTS_PATH}")


if __name__ == "__main__":
    main()
