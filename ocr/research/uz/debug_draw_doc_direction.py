from pathlib import Path
from lxml import etree
import cv2
import numpy as np
import random

CVAT_ROOT = Path("uz-annotaited-dataset")
XML_PATH = CVAT_ROOT / "annotations.xml"
IMAGES_DIR = CVAT_ROOT / "images"
OUT_DIR = Path("debug_doc_direction")

DOCUMENT_LABELS = {
    "1_passport_uz": "passport",
    "27_migration_card": "migration_card",
}

SAMPLES = 20
SEED = 42


def parse_points(points: str):
    return np.array(
        [list(map(float, p.split(","))) for p in points.split(";")],
        dtype=np.float32,
    )


def find_image_path(name: str) -> Path:
    direct = IMAGES_DIR / name
    if direct.exists():
        return direct

    found = list(IMAGES_DIR.rglob(name))
    if found:
        return found[0]

    raise FileNotFoundError(name)


def draw_direction(image, points, label):
    pts = points.astype(np.int32)

    cv2.polylines(image, [pts], True, (0, 255, 0), 3)

    for i, (x, y) in enumerate(pts):
        cv2.circle(image, (x, y), 12, (0, 0, 255), -1)
        cv2.putText(
            image,
            str(i),
            (x + 10, y - 10),
            cv2.FONT_HERSHEY_SIMPLEX,
            1.2,
            (255, 255, 255),
            3,
            cv2.LINE_AA,
        )

    cv2.arrowedLine(
        image,
        tuple(pts[0]),
        tuple(pts[1]),
        (255, 0, 0),
        4,
        tipLength=0.05,
    )

    cv2.putText(
        image,
        label,
        tuple(pts[0]),
        cv2.FONT_HERSHEY_SIMPLEX,
        1.0,
        (0, 0, 0),
        4,
        cv2.LINE_AA,
    )


def main():
    random.seed(SEED)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    tree = etree.parse(str(XML_PATH))
    images = tree.findall(".//image")
    random.shuffle(images)

    saved = 0

    for image_node in images:
        if saved >= SAMPLES:
            break

        image_name = image_node.get("name")
        src_path = find_image_path(image_name)
        image = cv2.imread(str(src_path))

        if image is None:
            continue

        has_doc = False

        for polygon in image_node.findall("polygon"):
            label = polygon.get("label")

            if label not in DOCUMENT_LABELS:
                continue

            points = parse_points(polygon.get("points"))
            draw_direction(image, points, DOCUMENT_LABELS[label])
            has_doc = True

        if not has_doc:
            continue

        out_path = OUT_DIR / Path(image_name).name
        cv2.imwrite(str(out_path), image)
        print(f"Saved: {out_path}")
        saved += 1


if __name__ == "__main__":
    main()
