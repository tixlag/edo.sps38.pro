from pathlib import Path
import gc
import torch
from ultralytics import YOLO


DEVICE = 0
WORKERS = 8
CACHE = True

BASE_MODEL_FIELDS = "yolo26s-seg.pt"


TRAIN_JOBS = [
    {
        "title": "Passport fields model — YOLO26m document-safe aug",
        "model": BASE_MODEL_FIELDS,
        "data": "yolo_passport_fields_dataset/dataset.yaml",
        "project": "runs_fields_yolo26m",
        "name": "passport_fields_yolo26m_doc_safe",
        "epochs": 300,
        "imgsz": 1280,
        "batch": 2,
        "patience": 70,
        "lr0": 0.0015,
    },
    {
        "title": "Migration card fields model — YOLO26m document-safe aug",
        "model": BASE_MODEL_FIELDS,
        "data": "yolo_migration_fields_dataset/dataset.yaml",
        "project": "runs_fields_yolo26m",
        "name": "migration_fields_yolo26m_doc_safe",
        "epochs": 300,
        "imgsz": 1280,
        "batch": 2,
        "patience": 70,
        "lr0": 0.0015,
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

        optimizer="AdamW",
        cos_lr=True,
        lr0=job["lr0"],
        lrf=0.01,
        warmup_epochs=5,
        weight_decay=0.0005,

        # важно для документов
        mosaic=0.0,
        close_mosaic=0,
        mixup=0.0,
        copy_paste=0.0,
        erasing=0.0,

        # геометрия: фото паспорта может быть кривым,
        # но поля не должны превращаться в кашу
        degrees=5.0,
        translate=0.04,
        scale=0.18,
        shear=1.5,
        perspective=0.0007,

        # цвет/свет: мягче, чем раньше
        hsv_h=0.005,
        hsv_s=0.20,
        hsv_v=0.25,

        # для документов нельзя
        fliplr=0.0,
        flipud=0.0,

        amp=True,
        verbose=True,
        save=True,
        plots=True,
        val=True,
    )

    print(f"FINISHED: {job['title']}")

    del model
    clear_memory()


def main():
    print("CUDA available:", torch.cuda.is_available())

    if torch.cuda.is_available():
        print("GPU:", torch.cuda.get_device_name(DEVICE))
        print("VRAM GB:", round(torch.cuda.get_device_properties(DEVICE).total_memory / 1024**3, 2))

    for job in TRAIN_JOBS:
        train_job(job)

    print("\nAll models trained successfully")


if __name__ == "__main__":
    main()
