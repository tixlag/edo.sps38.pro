from pathlib import Path
import gc
import torch
from ultralytics import YOLO


DEVICE = 0

WORKERS = 12
CACHE = True

BASE_MODEL_DOC = "yolo26n-seg.pt"
BASE_MODEL_FIELDS = "yolo26n-seg.pt"


TRAIN_JOBS = [
    {
        "title": "Document type model",
        "model": BASE_MODEL_DOC,
        "data": "yolo_doc_dataset/dataset.yaml",
        "project": "runs_doc_v2",
        "name": "doc_type_seg",
        "epochs": 200,
        "imgsz": 1280,
        "batch": 8,
        "patience": 40,
        "lr0": 0.003,
    },
    {
        "title": "Passport fields model",
        "model": BASE_MODEL_FIELDS,
        "data": "yolo_passport_fields_dataset/dataset.yaml",
        "project": "runs_fields",
        "name": "passport_fields_seg",
        "epochs": 300,
        "imgsz": 1280,
        "batch": 4,
        "patience": 60,
        "lr0": 0.003,
    },
    {
        "title": "Migration card fields model",
        "model": BASE_MODEL_FIELDS,
        "data": "yolo_migration_fields_dataset/dataset.yaml",
        "project": "runs_fields",
        "name": "migration_fields_seg",
        "epochs": 300,
        "imgsz": 1280,
        "batch": 4,
        "patience": 60,
        "lr0": 0.003,
    },
]

TRAIN_JOBS_V2 = [
    {
        "title": "Passport fields model — no mosaic photo aug",
        "model": BASE_MODEL_FIELDS,
        "data": "yolo_passport_fields_dataset/dataset.yaml",
        "project": "runs_fields",
        "name": "passport_fields_seg_no_mosaic_photo_aug",
        "epochs": 260,
        "imgsz": 1280,
        "batch": 4,
        "patience": 50,
        "lr0": 0.002,
    },
    {
        "title": "Migration card fields model — no mosaic photo aug",
        "model": BASE_MODEL_FIELDS,
        "data": "yolo_migration_fields_dataset/dataset.yaml",
        "project": "runs_fields",
        "name": "migration_fields_seg_no_mosaic_photo_aug",
        "epochs": 260,
        "imgsz": 1280,
        "batch": 4,
        "patience": 50,
        "lr0": 0.002,
    },
]


def clear_memory():
    gc.collect()

    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.ipc_collect()


def check_dataset(path: str):
    dataset_path = Path(path)

    if not dataset_path.exists():
        raise FileNotFoundError(f"Dataset yaml not found: {dataset_path}")

    print(f"Dataset OK: {dataset_path}")


def train_job(job: dict):
    print("\n" + "=" * 80)
    print(f"START: {job['title']}")
    print("=" * 80)

    check_dataset(job["data"])

    model = YOLO(job["model"])

    model.train(
        data=job["data"],
        epochs=job["epochs"],
        imgsz=job["imgsz"],
        batch=job["batch"],
        device=DEVICE,
        workers=WORKERS,
        cache=CACHE,
        patience=job["patience"],

        project=job["project"],
        name=job["name"],
        exist_ok=True,

        cos_lr=True,
        lr0=job["lr0"],
        lrf=0.01,
        warmup_epochs=5,

        optimizer="AdamW",
        weight_decay=0.0005,

        mosaic=0.3,
        close_mosaic=20,
        mixup=0.0,
        copy_paste=0.0,

        degrees=5,
        translate=0.05,
        scale=0.3,
        shear=2,
        perspective=0.0005,

        fliplr=0.0,
        flipud=0.0,

        amp=True,
        verbose=True,
    )

    print(f"FINISHED: {job['title']}")

    del model
    clear_memory()

def train_job_harder(job: dict):
    print("\n" + "=" * 80)
    print(f"START: {job['title']}")
    print("=" * 80)

    check_dataset(job["data"])

    model = YOLO(job["model"])

    model.train(
        data=job["data"],
        epochs=job["epochs"],
        imgsz=job["imgsz"],
        batch=job["batch"],
        device=DEVICE,
        workers=WORKERS,
        cache=CACHE,
        patience=job["patience"],

        project=job["project"],
        name=job["name"],
        exist_ok=True,

        cos_lr=True,
        lr0=job["lr0"],
        lrf=0.01,
        warmup_epochs=5,

        optimizer="AdamW",
        weight_decay=0.0005,

        mosaic=0.0,
        close_mosaic=0,
        mixup=0.0,
        copy_paste=0.0,

        degrees=7,
        translate=0.08,
        scale=0.35,
        shear=3,
        perspective=0.001,

        hsv_h=0.015,
        hsv_s=0.45,
        hsv_v=0.45,

        fliplr=0.0,
        flipud=0.0,

        amp=True,
        verbose=True,
    )

    print(f"FINISHED: {job['title']}")

    del model
    clear_memory()


def main():
    print("CUDA available:", torch.cuda.is_available())

    if torch.cuda.is_available():
        print("GPU:", torch.cuda.get_device_name(DEVICE))
        print("VRAM GB:", round(torch.cuda.get_device_properties(DEVICE).total_memory / 1024**3, 2))

    for job in TRAIN_JOBS_V2:
        train_job_harder(job)

    print("\nAll models trained successfully")


if __name__ == "__main__":
    main()
