from pathlib import Path
import random
import cv2
import yaml
import numpy as np


DATASETS = [
    {
        "name": "passport",
        "root": Path("yolo_passport_fields_dataset"),
    },
    {
        "name": "migration_card",
        "root": Path("yolo_migration_fields_dataset"),
    },
]

OUT_DIR = Path("debug_yolo_fields")
SAMPLES_PER_DATASET = 10
SUBSET = "train"
SEED = 42


def load_classes(dataset_root: Path) -> dict[int, str]:
    yaml_path = dataset_root / "dataset.yaml"

    with open(yaml_path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)

    names = data["names"]

    if isinstance(names, dict):
        return {int(k): v for k, v in names.items()}

    return {i: name for i, name in enumerate(names)}


def find_label_path(dataset_root: Path, subset: str, image_path: Path) -> Path:
    return (
        dataset_root
        / "labels"
        / subset
        / f"{image_path.stem}.txt"
    )


def parse_yolo_seg_line(line: str, width: int, height: int):
    parts = line.strip().split()

    if len(parts) < 7:
        return None

    class_id = int(float(parts[0]))
    coords = list(map(float, parts[1:]))

    points = []

    for i in range(0, len(coords), 2):
        x = int(round(coords[i] * width))
        y = int(round(coords[i + 1] * height))
        points.append([x, y])

    return class_id, np.array(points, dtype=np.int32)


def draw_label(
    image,
    polygon: np.ndarray,
    text: str,
):
    cv2.polylines(
        image,
        [polygon],
        isClosed=True,
        color=(0, 255, 0),
        thickness=2,
    )

    overlay = image.copy()
    cv2.fillPoly(
        overlay,
        [polygon],
        color=(0, 255, 0),
    )

    cv2.addWeighted(
        overlay,
        0.15,
        image,
        0.85,
        0,
        image,
    )

    x = int(polygon[:, 0].min())
    y = int(polygon[:, 1].min())

    y = max(20, y)

    font = cv2.FONT_HERSHEY_SIMPLEX
    font_scale = 0.7
    thickness = 2

    text_size, _ = cv2.getTextSize(
        text,
        font,
        font_scale,
        thickness,
    )

    text_w, text_h = text_size

    cv2.rectangle(
        image,
        (x, y - text_h - 8),
        (x + text_w + 8, y + 4),
        (0, 0, 0),
        -1,
    )

    cv2.putText(
        image,
        text,
        (x + 4, y - 4),
        font,
        font_scale,
        (255, 255, 255),
        thickness,
        cv2.LINE_AA,
    )


def debug_dataset(dataset_name: str, dataset_root: Path):
    classes = load_classes(dataset_root)

    images_dir = dataset_root / "images" / SUBSET
    image_paths = sorted(
        list(images_dir.glob("*.jpg"))
        + list(images_dir.glob("*.jpeg"))
        + list(images_dir.glob("*.png"))
    )

    if not image_paths:
        print(f"No images found: {images_dir}")
        return

    samples = random.sample(
        image_paths,
        min(SAMPLES_PER_DATASET, len(image_paths)),
    )

    out_dataset_dir = OUT_DIR / dataset_name
    out_dataset_dir.mkdir(parents=True, exist_ok=True)

    for image_path in samples:
        image = cv2.imread(str(image_path))

        if image is None:
            print(f"Cannot read image: {image_path}")
            continue

        height, width = image.shape[:2]

        label_path = find_label_path(
            dataset_root,
            SUBSET,
            image_path,
        )

        if not label_path.exists():
            print(f"No label: {label_path}")
            continue

        lines = label_path.read_text(
            encoding="utf-8"
        ).strip().splitlines()

        for line in lines:
            parsed = parse_yolo_seg_line(
                line,
                width,
                height,
            )

            if parsed is None:
                continue

            class_id, polygon = parsed
            class_name = classes.get(class_id, str(class_id))

            draw_label(
                image=image,
                polygon=polygon,
                text=class_name,
            )

        out_path = out_dataset_dir / image_path.name
        cv2.imwrite(str(out_path), image)

        print(f"Saved: {out_path}")


def main():
    random.seed(SEED)

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    for dataset in DATASETS:
        debug_dataset(
            dataset_name=dataset["name"],
            dataset_root=dataset["root"],
        )


if __name__ == "__main__":
    main()
