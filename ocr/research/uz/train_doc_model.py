from ultralytics import YOLO

model = YOLO("yolo26n-seg.pt")

model.train(
    data="yolo_doc_dataset/dataset.yaml",
    epochs=200,
    imgsz=1280,
    batch=4,
    device=0,
    patience=40,
    cache=True,
    workers=8,
    project="runs_doc",
    name="doc_type_seg",
)
