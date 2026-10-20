from pathlib import Path
from lxml import etree
import cv2
import numpy as np
from collections import defaultdict, Counter

CVAT_ROOT = Path("uz-annotaited-dataset")
XML_PATH = CVAT_ROOT / "annotations.xml"

REPORT_PATH = Path("annotation_validation_report.txt")


DOCUMENT_LABELS = {
    "1_passport_uz": "passport",
    "27_migration_card": "migration_card",
}

PASSPORT_FIELDS = {
    "2_pas_number": 2,
    "3_pas_surname": 3,
    "4_pas_name": 4,
    "5_pas_patronymic": 5,
    "6_pas_nationality": 6,
    "7_pas_date_of_birth": 7,
    "8_pas_sex": 8,
    "9_pas_place_of_birth": 9,
    "10_pas_date_of_issue": 10,
    "11_pas_date_of_expiry": 11,
    "12_pas_authority": 12,
    "13_pas_photo": 13,
    "14_pas_mrz": 14,
}

MIGRATION_FIELDS = {
    "15_mg_series": 15,
    "16_mg_number": 16,
    "17_mg_surname": 17,
    "18_mg_surname_lat": 18,
    "19_mg_name": 19,
    "20_mg_patronymic": 20,
    "21_mg_date_of_birth": 21,
    "22_mg_nationality": 22,
    "23_mg_passport_number": 23,
    "24_mg_visa_number": 24,
    "25_mg_duration_from": 25,
    "26_mg_duration_to": 26,
}

ALL_FIELDS = {
    **PASSPORT_FIELDS,
    **MIGRATION_FIELDS,
}


def parse_points(points: str) -> np.ndarray:
    return np.array(
        [list(map(float, p.split(","))) for p in points.split(";")],
        dtype=np.float32,
    )


def polygon_center(points: np.ndarray) -> tuple[float, float]:
    return float(points[:, 0].mean()), float(points[:, 1].mean())


def point_in_polygon(point: tuple[float, float], polygon: np.ndarray) -> bool:
    return cv2.pointPolygonTest(polygon.astype(np.float32), point, False) >= 0


def order_quad_points(points: np.ndarray) -> np.ndarray:
    if len(points) < 4:
        raise ValueError(f"document polygon has only {len(points)} points")

    return points[:4].astype(np.float32)


def get_document_matrix(doc_polygon: np.ndarray):
    src = order_quad_points(doc_polygon)

    top_width = np.linalg.norm(src[1] - src[0])
    bottom_width = np.linalg.norm(src[2] - src[3])
    crop_w = int(max(top_width, bottom_width))

    right_height = np.linalg.norm(src[2] - src[1])
    left_height = np.linalg.norm(src[3] - src[0])
    crop_h = int(max(right_height, left_height))

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

    return matrix, crop_w, crop_h


def transform_polygon(points: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    pts = points.reshape(-1, 1, 2).astype(np.float32)
    result = cv2.perspectiveTransform(pts, matrix)
    return result.reshape(-1, 2)


def field_box(points: np.ndarray):
    xs = points[:, 0]
    ys = points[:, 1]

    return {
        "x1": float(xs.min()),
        "y1": float(ys.min()),
        "x2": float(xs.max()),
        "y2": float(ys.max()),
        "cx": float(xs.mean()),
        "cy": float(ys.mean()),
        "w": float(xs.max() - xs.min()),
        "h": float(ys.max() - ys.min()),
    }


def image_prefix(image_node):
    image_name = image_node.get("name")
    task_id = image_node.get("task_id", "unknown")
    frame_id = int(image_node.get("id", "0")) % 50

    # return f"task_id={task_id} | frame_id={frame_id} | image={image_name}"
    return f"task_id={task_id} | frame_id={frame_id}"


def check_migration_order(fields: list[dict]) -> list[str]:
    errors = []

    nums = {f["number"]: f for f in fields}

    required = [
        15, 16, 17, 18, 19, 20,
        21, 22, 23, 25, 26,
    ]

    missing = [
        n for n in required
        if n not in nums
    ]

    if missing:
        errors.append(
            f"MIGRATION_MISSING_FIELDS | missing={missing}"
        )

    def below(a: int, b: int) -> bool:
        return nums[a]["box"]["cy"] > nums[b]["box"]["cy"]

    def right_of(a: int, b: int) -> bool:
        return nums[a]["box"]["cx"] > nums[b]["box"]["cx"]

    def check_below(a: int, b: int):
        if a in nums and b in nums and not below(a, b):
            errors.append(
                f"MIGRATION_BAD_POSITION | {a} must be below {b}"
            )

    def check_right(a: int, b: int):
        if a in nums and b in nums and not right_of(a, b):
            errors.append(
                f"MIGRATION_BAD_POSITION | {a} must be right of {b}"
            )

    # Верхняя вертикальная часть
    check_below(16, 15)
    check_below(17, 16)
    check_below(18, 17)
    check_below(19, 18)
    check_below(20, 19)

    # 21 слева от 22, оба ниже 20
    check_below(21, 20)
    check_below(22, 20)
    check_right(22, 21)

    # 23 ниже 21/22
    check_below(23, 21)
    check_below(23, 22)

    # 24 опционален, справа от 23
    if 24 in nums:
        check_right(24, 23)

    # 25 ниже 23, 26 справа от 25
    check_below(25, 23)
    check_below(26, 23)
    check_right(26, 25)

    return errors


def check_passport_layout(fields: list[dict]) -> list[str]:
    errors = []

    nums = {f["number"]: f for f in fields}

    # СНАЧАЛА ищем явные перепутанные классы.
    # Если нашли — остальные layout-проверки не выполняем,
    # иначе будет каскад ложных ошибок.
    swap_errors = detect_passport_label_swaps(fields)

    if swap_errors:
        return swap_errors

    expected = sorted(PASSPORT_FIELDS.values())
    existing = sorted(nums.keys())

    missing = [
        n for n in expected
        if n not in existing
    ]

    if missing:
        errors.append(
            f"PASSPORT_MISSING_FIELDS | missing={missing}"
        )

    # 13_pas_photo слева от остальных паспортных данных.
    if 13 in nums:
        photo = nums[13]

        others = [
            f for f in fields
            if f["number"] not in {13, 14}
        ]

        if others:
            min_other_x = min(
                f["box"]["cx"]
                for f in others
            )

            if photo["box"]["cx"] >= min_other_x:
                errors.append(
                    "PASSPORT_BAD_PHOTO_POSITION | "
                    f"photo_cx={photo['box']['cx']:.1f} "
                    f"min_other_cx={min_other_x:.1f}"
                )

    def check_below(a: int, b: int):
        if a in nums and b in nums:
            if nums[a]["box"]["cy"] <= nums[b]["box"]["cy"]:
                errors.append(
                    f"PASSPORT_BAD_POSITION | {a} must be below {b}"
                )

    def check_right(a: int, b: int):
        if a in nums and b in nums:
            if nums[a]["box"]["cx"] <= nums[b]["box"]["cx"]:
                errors.append(
                    f"PASSPORT_BAD_POSITION | {a} must be right of {b}"
                )

    check_below(3, 2)
    check_below(4, 3)
    check_below(5, 4)
    check_below(6, 5)
    check_below(7, 6)
    check_below(8, 7)

    check_right(9, 8)

    check_below(10, 8)
    check_below(11, 10)

    check_right(12, 10)
    check_right(12, 11)

    check_below(14, 11)

    return errors


def validate_document(
    image_node,
    doc: dict,
    all_fields: list[dict],
):
    errors = []

    doc_name = doc["name"]
    doc_polygon = doc["points"]

    if len(doc_polygon) != 4:
        errors.append(
            f"DOCUMENT_BAD_POINT_COUNT | "
            f"{doc_name} has {len(doc_polygon)} points"
        )

    try:
        matrix, crop_w, crop_h = get_document_matrix(doc_polygon)
    except Exception as e:
        errors.append(f"DOCUMENT_TRANSFORM_ERROR | {doc_name} | {e}")
        return errors

    if doc_name == "passport":
        allowed = PASSPORT_FIELDS
    elif doc_name == "migration_card":
        allowed = MIGRATION_FIELDS
    else:
        return errors

    doc_fields = []

    for field in all_fields:
        label = field["label"]

        if label not in allowed:
            continue

        center = polygon_center(field["points"])

        if not point_in_polygon(center, doc_polygon):
            errors.append(
                f"FIELD_OUTSIDE_DOCUMENT | {label}"
            )
            continue

        transformed = transform_polygon(field["points"], matrix)
        box = field_box(transformed)

        doc_fields.append(
            {
                "label": label,
                "number": allowed[label],
                "box": box,
            }
        )

    field_duplicates = check_duplicates(
        doc_fields,
        "number",
        "FIELD",
    )

    errors.extend(field_duplicates)

    if doc_name == "passport":
        errors.extend(check_passport_layout(doc_fields))

    elif doc_name == "migration_card":
        errors.extend(check_migration_order(doc_fields))

    return errors

def check_duplicates(
    objects: list[dict],
    key: str,
    prefix: str,
):
    errors = []

    counts = Counter(
        obj[key]
        for obj in objects
    )

    duplicates = {
        k: v
        for k, v in counts.items()
        if v > 1
    }

    for label, count in duplicates.items():
        errors.append(
            f"{prefix}_DUPLICATE | {label} appears {count} times"
        )

    return errors

def detect_passport_label_swaps(fields: list[dict]) -> list[str]:
    errors = []

    nums = {f["number"]: f for f in fields}

    if 13 not in nums or 14 not in nums:
        return errors

    photo = nums[13]
    mrz = nums[14]

    photo_box = photo["box"]
    mrz_box = mrz["box"]

    def aspect(box):
        if box["h"] <= 0:
            return 0
        return box["w"] / box["h"]

    photo_aspect = aspect(photo_box)
    mrz_aspect = aspect(mrz_box)

    # Настоящий MRZ обычно широкий.
    photo_looks_like_mrz = (
        photo_aspect > 4.0
    )

    # Настоящее фото обычно высокое / портретное.
    mrz_looks_like_photo = (
        mrz_aspect < 1.2
        and mrz_box["h"] > mrz_box["w"]
    )

    # Дополнительная проверка:
    # MRZ обычно ниже основной зоны данных.
    photo_lower_than_mrz = (
        photo_box["cy"] > mrz_box["cy"]
    )

    if photo_looks_like_mrz and mrz_looks_like_photo:
        errors.append(
            "PASSPORT_POSSIBLE_LABEL_SWAP | "
            "13_pas_photo looks like MRZ and 14_pas_mrz looks like photo"
        )

    elif photo_looks_like_mrz:
        errors.append(
            "PASSPORT_SUSPICIOUS_13_PHOTO | "
            f"13_pas_photo is too wide | aspect={photo_aspect:.2f}"
        )

    elif mrz_looks_like_photo:
        errors.append(
            "PASSPORT_SUSPICIOUS_14_MRZ | "
            f"14_pas_mrz looks vertical/photo-like | aspect={mrz_aspect:.2f}"
        )

    return errors

def main():
    tree = etree.parse(str(XML_PATH))
    image_nodes = tree.findall(".//image")

    report_lines = []

    total_images = 0
    total_errors = 0

    for image_node in image_nodes:
        total_images += 1

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
            elif label in ALL_FIELDS:
                fields.append(
                    {
                        "label": label,
                        "points": points,
                    }
                )

        doc_duplicate_errors = check_duplicates(
            documents,
            "label",
            "DOCUMENT",
        )

        for err in doc_duplicate_errors:
            report_lines.append(
                f"{image_prefix(image_node)} | {err}"
            )
            total_errors += 1

        prefix = image_prefix(image_node)

        has_passport = any(
            d["name"] == "passport"
            for d in documents
        )

        has_migration = any(
            d["name"] == "migration_card"
            for d in documents
        )

        if not documents and fields:
            report_lines.append(
                f"{prefix} | NO_DOCUMENT_POLYGON_BUT_FIELDS_EXIST"
            )
            total_errors += 1
            continue

        if has_migration:
            migration_docs = [
                d for d in documents
                if d["name"] == "migration_card"
            ]

            for i, doc in enumerate(migration_docs):
                errors = validate_document(
                    image_node=image_node,
                    doc=doc,
                    all_fields=fields,
                )

                for error in errors:
                    report_lines.append(
                        f"{prefix} | migration_card_{i} | {error}"
                    )
                    total_errors += 1

        if has_passport:
            passport_docs = [
                d for d in documents
                if d["name"] == "passport"
            ]

            for i, doc in enumerate(passport_docs):
                errors = validate_document(
                    image_node=image_node,
                    doc=doc,
                    all_fields=fields,
                )

                for error in errors:
                    report_lines.append(
                        f"{prefix} | passport_{i} | {error}"
                    )
                    total_errors += 1

    if report_lines:
        report_lines.sort()
        REPORT_PATH.write_text(
            "\n".join(report_lines) + "\n",
            encoding="utf-8",
        )
    else:
        REPORT_PATH.write_text(
            "No annotation problems found.\n",
            encoding="utf-8",
        )

    print("Done")
    print(f"images checked: {total_images}")
    print(f"errors found: {total_errors}")
    print(f"report: {REPORT_PATH}")


if __name__ == "__main__":
    main()
