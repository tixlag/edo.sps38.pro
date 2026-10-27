from ultralytics import YOLO

model = YOLO("yolov8m-seg.pt")

model.train(
    data="yolo_fields_dataset/dataset.yaml",
    epochs=250,
    imgsz=1280,
    batch=4,
    device=0,
    patience=50,
    cache=True,
    workers=8,
    project="runs_fields",
    name="fields_seg",
)
