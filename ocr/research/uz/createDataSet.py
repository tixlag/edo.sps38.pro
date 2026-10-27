from pathlib import Path
from lxml import etree
import cv2
import numpy as np
import shutil
import random
import math

CVAT_ROOT = Path("uz-annotaited-dataset")
XML_PATH = CVAT_ROOT / "annotations.xml"
IMAGES_DIR = CVAT_ROOT / "images"

DOC_OUT = Path("yolo_doc_dataset")
FIELDS_OUT = Path("yolo_fields_dataset")

TRAIN_RATIO = 0.9
SEED = 42

DOCUMENT_LABELS = {
    "1_passport_uz": "passport",
    "27_migration_card": "migration_card",
}

FIELD_LABELS = {
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
    result = []
    for p in points.split(";"):
        x, y = map(float, p.split(","))
        result.append([x, y])
    return np.array(result, dtype=np.float32)


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
    return cv2.pointPolygonTest(polygon, point, False) >= 0


def order_quad_points(points: np.ndarray) -> np.ndarray:
    """
    Берём minAreaRect, чтобы получить ровный perspective crop документа.
    """
    rect = cv2.minAreaRect(points.astype(np.float32))
    box = cv2.boxPoints(rect)

    s = box.sum(axis=1)
    diff = np.diff(box, axis=1).reshape(-1)

    ordered = np.zeros((4, 2), dtype=np.float32)
    ordered[0] = box[np.argmin(s)]      # top-left
    ordered[2] = box[np.argmax(s)]      # bottom-right
    ordered[1] = box[np.argmin(diff)]   # top-right
    ordered[3] = box[np.argmax(diff)]   # bottom-left

    return ordered


def warp_document(image: np.ndarray, doc_polygon: np.ndarray):
    src = order_quad_points(doc_polygon)

    width_a = np.linalg.norm(src[2] - src[3])
    width_b = np.linalg.norm(src[1] - src[0])
    max_width = int(max(width_a, width_b))

    height_a = np.linalg.norm(src[1] - src[2])
    height_b = np.linalg.norm(src[0] - src[3])
    max_height = int(max(height_a, height_b))

    dst = np.array([
        [0, 0],
        [max_width - 1, 0],
        [max_width - 1, max_height - 1],
        [0, max_height - 1],
    ], dtype=np.float32)

    matrix = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(image, matrix, (max_width, max_height))

    return warped, matrix, max_width, max_height


def transform_polygon(points: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    pts = points.reshape(-1, 1, 2).astype(np.float32)
    transformed = cv2.perspectiveTransform(pts, matrix)
    return transformed.reshape(-1, 2)


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


def main():
    random.seed(SEED)

    make_dirs(DOC_OUT)
    make_dirs(FIELDS_OUT)

    doc_classes = list(DOCUMENT_LABELS.values())
    field_classes = list(FIELD_LABELS.values())

    doc_class_to_id = {v: i for i, v in enumerate(doc_classes)}
    field_class_to_id = {v: i for i, v in enumerate(field_classes)}

    tree = etree.parse(str(XML_PATH))
    images = tree.findall(".//image")

    random.shuffle(images)
    split_index = int(len(images) * TRAIN_RATIO)

    total_doc_objects = 0
    total_field_objects = 0
    total_doc_crops = 0

    for idx, image_node in enumerate(images):
        subset = "train" if idx < split_index else "val"

        image_name = image_node.get("name")
        width = float(image_node.get("width"))
        height = float(image_node.get("height"))

        src_path = find_image_path(image_name)
        image = cv2.imread(str(src_path))

        if image is None:
            print(f"Skip unreadable image: {src_path}")
            continue

        safe_image_name = Path(image_name).name
        stem = Path(safe_image_name).stem

        # -------------------------
        # 1. Dataset для документов
        # -------------------------
        dst_img_path = DOC_OUT / "images" / subset / safe_image_name
        shutil.copy2(src_path, dst_img_path)

        doc_label_lines = []

        documents = []
        fields = []

        for polygon_node in image_node.findall("polygon"):
            label = polygon_node.get("label")
            points = parse_points(polygon_node.get("points"))

            if label in DOCUMENT_LABELS:
                doc_name = DOCUMENT_LABELS[label]
                class_id = doc_class_to_id[doc_name]

                line = f"{class_id} {normalize_polygon(points, width, height)}"
                doc_label_lines.append(line)

                documents.append({
                    "label": label,
                    "name": doc_name,
                    "points": points,
                })

                total_doc_objects += 1

            elif label in FIELD_LABELS:
                fields.append({
                    "label": label,
                    "name": FIELD_LABELS[label],
                    "points": points,
                })

        doc_label_path = DOC_OUT / "labels" / subset / f"{stem}.txt"
        doc_label_path.write_text("\n".join(doc_label_lines), encoding="utf-8")

        # -------------------------------------------
        # 2. Dataset для полей внутри кропов документов
        # -------------------------------------------
        for doc_index, doc in enumerate(documents):
            warped, matrix, crop_w, crop_h = warp_document(image, doc["points"])

            crop_name = f"{stem}__doc_{doc_index}_{doc['name']}.png"
            crop_path = FIELDS_OUT / "images" / subset / crop_name
            cv2.imwrite(str(crop_path), warped)

            field_lines = []

            for field in fields:
                cx, cy = polygon_center(field["points"])

                if not point_in_polygon((cx, cy), doc["points"]):
                    continue

                transformed = transform_polygon(field["points"], matrix)

                # Отсекаем точки по границам кропа
                transformed[:, 0] = np.clip(transformed[:, 0], 0, crop_w - 1)
                transformed[:, 1] = np.clip(transformed[:, 1], 0, crop_h - 1)

                field_name = field["name"]
                class_id = field_class_to_id[field_name]

                line = f"{class_id} {normalize_polygon(transformed, crop_w, crop_h)}"
                field_lines.append(line)

                total_field_objects += 1

            crop_label_path = FIELDS_OUT / "labels" / subset / f"{Path(crop_name).stem}.txt"
            crop_label_path.write_text("\n".join(field_lines), encoding="utf-8")

            total_doc_crops += 1

    write_yaml(DOC_OUT, doc_classes)
    write_yaml(FIELDS_OUT, field_classes)

    print("Done")
    print(f"Images: {len(images)}")
    print(f"Document objects: {total_doc_objects}")
    print(f"Document crops: {total_doc_crops}")
    print(f"Field objects inside crops: {total_field_objects}")
    print(f"Doc dataset: {DOC_OUT}")
    print(f"Fields dataset: {FIELDS_OUT}")


if __name__ == "__main__":
    main()
