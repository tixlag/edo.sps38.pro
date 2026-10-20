#!/usr/bin/env python3
# build_dataset_fixed.py
import os
import json
import cv2
import numpy as np
from pathlib import Path
from PIL import Image
import random
from dotenv import load_dotenv
from ultralytics import YOLO
from ultralytics.utils.ops import scale_masks
import csv
from datetime import datetime

# Try import paddleocr interfaces (optional)
try:
    from paddleocr import TextDetection, TextRecognition
    PADDLE_AVAILABLE = True
except Exception as e:
    print(f"[WARN] paddleocr not available: {e}")
    PADDLE_AVAILABLE = False

# Load environment variables
load_dotenv()

BASE_DIR = os.getenv('BASE_DIR')        # папки с исходными PDF/данными
MODEL_PATH = os.getenv('MODEL_PATH')    # YOLO модель для сегментации
OUTPUT_DIR = os.getenv('OUTPUT_DIR', './output_dataset_fixed')
AUG_PER_SEGMENT = int(os.getenv('AUG_PER_SEGMENT', '3'))  # кол-во изображений на сегмент (включая оригинал)
USE_ALBUMENTATIONS = os.getenv('USE_ALBUMENTATIONS', 'True').strip().lower() == 'true'

# Флаг для генерации YOLO-датасета
BUILD_YOLO_DATASET = os.getenv('BUILD_YOLO_DATASET', 'False').strip().lower() == 'true'
YOLO_CLASSES = [cls.strip() for cls in os.getenv('YOLO_CLASSES', 'second_name').split(',')] if BUILD_YOLO_DATASET else []
YOLO_DATASET_DIR = os.path.join(OUTPUT_DIR, 'yolo_dataset') if BUILD_YOLO_DATASET else None

# Создаём структуру для OCR датасета
IMAGES_DIR = os.path.join(OUTPUT_DIR, 'images')
LABELS_FILE = os.path.join(OUTPUT_DIR, 'labels.txt')
os.makedirs(IMAGES_DIR, exist_ok=True)

BUILD_MULTILINE_DATASET = os.getenv('BUILD_MULTILINE_DATASET', 'True').strip().lower() == 'true'
MULTILINE_DIR = os.path.join(OUTPUT_DIR, 'multiline') if BUILD_MULTILINE_DATASET else None
RUN_LINE_DETECTOR = os.getenv('RUN_LINE_DETECTOR', 'False').strip().lower() == 'true'  # опционно запускает PADDLE_DETECTOR если он есть

if BUILD_MULTILINE_DATASET:
    for split in ['train', 'validation', 'test']:
        os.makedirs(os.path.join(MULTILINE_DIR, split, 'images'), exist_ok=True)
    multiline_manifest_path = os.path.join(MULTILINE_DIR, 'multiline_manifest.csv')
    print(f"[INFO] Multiline dataset for CVAT will be saved to: {MULTILINE_DIR}")

if BUILD_YOLO_DATASET:
    for split in ['train', 'validation', 'test']:
        os.makedirs(os.path.join(YOLO_DATASET_DIR, split, 'images'), exist_ok=True)
        os.makedirs(os.path.join(YOLO_DATASET_DIR, split, 'labels'), exist_ok=True)
    print(f"[INFO] YOLO dataset будет сохранён в: {YOLO_DATASET_DIR}")

# Загружаем модель сегментации (YOLO)
model = YOLO(MODEL_PATH)
CLASS_TO_ID = {name: idx for idx, name in enumerate(YOLO_CLASSES)} if BUILD_YOLO_DATASET else {}

# Список меток
labels_list = []
# will hold dict rows to dump as CSV at the end
labels_list_multiline = []

# ------- Параметры нормализации / augs -------
OCR_HEIGHT = 48        # рекомендовано для твоего тренинга (смотри конфиг)
OCR_MAX_WIDTH = 320    # ограничение ширины; остаток — паддинг
MAX_SEGMENTS_PER_IMAGE = None  # None = брать все сегменты; можно поставить число для контроля
# ------------------------------------------------
# Документы этих людей повернуты по часовой стрелке
right_oriented_docs = ['Сухов Дмитрий', 'Ткаченко Галина', "Азаров Сергей", "Алексеева Марина", "Галлямов Дамир",
                 "Гущенко Андрей", "Литвинов Юрий", "Малмыга Андрей", "Мымриков Сергей", "Очередных Надежда",
                 "Первов Игорь", "Прокопьева Яна", "Руденко Антон", "Свистков Иван", "Сухов Дмитрий", "Ткаченко Галина", "Савкин Юрий", "Сухов Дмитрий"]

# ---------- PADDLE models (user provided recognizer) ----------
# Укажи путь в переменной окружения или оставь дефолт
rec_model = os.getenv('REC_MODEL', "./best_model/inference/inference.pdiparams")
PADDLE_DETECTOR = None
PADDLE_INSTANCE = None
if PADDLE_AVAILABLE:
    try:
        PADDLE_DETECTOR = TextDetection(model_name="PP-OCRv5_mobile_det")
    except Exception as e:
        print(f"[WARN] Can't init TextDetection: {e}")
        PADDLE_DETECTOR = None

    try:
        # use provided rec_model — модель в формате inference (folder expected)
        PADDLE_INSTANCE = TextRecognition(
            model_dir=os.path.dirname(rec_model),
            model_name='cyrillic_PP-OCRv5_mobile_rec',
        )
    except Exception as e:
        print(f"[WARN] Can't init TextRecognition: {e}")
        PADDLE_INSTANCE = None
else:
    print("[WARN] paddleocr isn't installed — pre-annotations won't be produced")

# ---------- Helpers ----------
def normalize_rec_image(img_bgr, out_h=OCR_HEIGHT, out_w=OCR_MAX_WIDTH):
    """
    Вписать изображение в canvas out_h x out_w, сохраняя пропорции.
    Центрирование по вертикали и горизонтали; фон = белый.
    """
    h, w = img_bgr.shape[:2]
    if h == 0 or w == 0:
        return None

    scale = min(out_h / h, out_w / w)
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))

    resized = cv2.resize(img_bgr, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
    canvas = np.ones((out_h, out_w, 3), dtype=np.uint8) * 255
    x_offset = (out_w - new_w) // 2
    y_offset = (out_h - new_h) // 2
    canvas[y_offset:y_offset + new_h, x_offset:x_offset + new_w] = resized
    return canvas


def light_augment(img_bgr):
    """
    Щадящая аугментация с имитацией небольших углов съёмки.
    Включает: контраст/яркость, blur, перспективные искажения и лёгкие повороты.
    """
    img = img_bgr.copy()
    h, w = img.shape[:2]

    # 1. Случайный контраст/яркость +/-5%
    alpha = 1.0 + (np.random.rand() * 0.1 - 0.05)
    beta = int(np.random.uniform(-8, 8))
    img = cv2.convertScaleAbs(img, alpha=alpha, beta=beta)

    # 2. Редкий лёгкий Gaussian Blur
    if np.random.rand() < 0.15:
        img = cv2.GaussianBlur(img, (3, 3), 0)

    # 3. Лёгкие перспективные искажения (имитация съёмки под углом)
    if np.random.rand() < 0.4:  # 40% вероятность
        # Небольшие смещения углов (±2-5% от размера изображения)
        max_shift = min(w, h) * 0.05

        pts1 = np.float32([[0, 0], [w, 0], [0, h], [w, h]])
        pts2 = np.float32([
            [np.random.uniform(0, max_shift), np.random.uniform(0, max_shift)],
            [w - np.random.uniform(0, max_shift), np.random.uniform(0, max_shift)],
            [np.random.uniform(0, max_shift), h - np.random.uniform(0, max_shift)],
            [w - np.random.uniform(0, max_shift), h - np.random.uniform(0, max_shift)]
        ])

        matrix = cv2.getPerspectiveTransform(pts1, pts2)
        img = cv2.warpPerspective(img, matrix, (w, h),
                                  borderMode=cv2.BORDER_CONSTANT,
                                  borderValue=(255, 255, 255))

    # 4. Небольшой поворот (±2-3 градуса)
    if np.random.rand() < 0.3:  # 30% вероятность
        angle = np.random.uniform(-3, 3)
        center = (w // 2, h // 2)
        M = cv2.getRotationMatrix2D(center, angle, 1.0)
        img = cv2.warpAffine(img, M, (w, h),
                             borderMode=cv2.BORDER_CONSTANT,
                             borderValue=(255, 255, 255))

    return img

def preprocess_for_ocr(img_bgr):
    """
    Повышение читаемости: конвертация в серый + CLAHE и обратно в BGR.
    Возвращает BGR изображение.
    """
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=1.5, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    return cv2.cvtColor(enhanced, cv2.COLOR_GRAY2BGR)

def mask_to_yolo_segmentation(mask, img_w, img_h):
    """
    Преобразует бинарную маску (H, W) в список нормализованных координат полигонов (yolo-seg format).
    Возвращает список контуров (каждый как [x1,y1,x2,y2,...] нормализованные).
    """
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    segments = []
    for contour in contours:
        if len(contour) < 3:
            continue
        contour = contour.squeeze()
        if contour.ndim == 1:
            continue
        epsilon = 0.005 * cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, epsilon, True)
        normalized = []
        for pt in approx:
            x = float(pt[0][0]) / img_w
            y = float(pt[0][1]) / img_h
            # clamp
            x = max(0.0, min(1.0, x))
            y = max(0.0, min(1.0, y))
            normalized.append(round(x, 6))
            normalized.append(round(y, 6))
        if len(normalized) >= 6:
            segments.append(normalized)
    return segments

def should_rotate_image(boxes_xyxy, img_h, img_w, threshold_ratio=1.5):
    """
    Определяет, нужно ли поворачивать всю страницу.
    Возвращает True если большинство боксов вертикальные.
    """
    vertical_count = 0
    total = len(boxes_xyxy)
    if total == 0:
        return False
    for box in boxes_xyxy:
        x1, y1, x2, y2 = box
        w = x2 - x1
        h = y2 - y1
        if h > w * threshold_ratio:
            vertical_count += 1
    return (vertical_count / total) > 0.7

def parse_fullname(folder_name):
    parts = folder_name.strip().split()
    if len(parts) >= 3:
        return {'second_name': parts[0], 'name': parts[1], 'third_name': ' '.join(parts[2:])}
    elif len(parts) == 2:
        return {'second_name': parts[0], 'name': parts[1], 'third_name': ''}
    return None

def format_serial_number(series, number):
    if len(series) == 4:
        return f"{series[:2]} {series[2:]} {number}"
    return f"{series} {number}"

# ---------- COCO accumulator for pre-annotations ----------
COCO = {
    "images": [],
    "annotations": [],
    "categories": [{"id": 1, "name": "text_line"}]
}
_next_img_id = 1
_next_ann_id = 1

def _poly_to_bbox(poly):
    xs = [float(p[0]) for p in poly]
    ys = [float(p[1]) for p in poly]
    x_min = min(xs); y_min = min(ys)
    x_max = max(xs); y_max = max(ys)
    return [x_min, y_min, x_max - x_min, y_max - y_min]

def _flatten_poly(poly):
    return [float(v) for pt in poly for v in (pt[0], pt[1])]

# ---------- Сохраняем нормализованный многострочный кроп и добавляем COCO аннотацию ----------
def save_multiline_segment(folder_name, class_name, crop_bgr, text_label, split):
    """
    Сохраняет НОРМАЛИЗОВАННЫЙ кроп (OCR_HEIGHT x OCR_MAX_WIDTH) для последующего импорта в CVAT.
    Запускает PADDLE_DETECTOR для предразметки строк и PADDLE_INSTANCE для распознавания текста.
    Добавляет записи в глобальную COCO структуру.
    """
    global _next_img_id, _next_ann_id

    if not BUILD_MULTILINE_DATASET:
        return None

    safe_folder = folder_name.replace(' ', '_').replace('/', '_').replace('\\', '_')
    # нормализуем кроп (предварительно делаем CLAHE)
    prep = preprocess_for_ocr(crop_bgr)
    # norm = normalize_rec_image(prep)
    norm = prep
    if norm is None:
        return None

    base_fname = f"{safe_folder}_{class_name}.png"
    out_dir = os.path.join(MULTILINE_DIR, split, 'images')
    out_path = os.path.join(out_dir, base_fname)

    # Сохраняем нормализованный кроп
    cv2.imwrite(out_path, norm)

    # Добавляем запись image в COCO
    img_id = _next_img_id
    COCO["images"].append({
        "id": img_id,
        "file_name": os.path.join(split, 'images', base_fname),  # относительный путь внутри MULTILINE_DIR
        "width": norm.shape[1],
        "height": norm.shape[0]
    })
    _next_img_id += 1

    # Попытка получить предварительные полигоны через PADDLE_DETECTOR (если доступен)
    polygons = None
    detections = None
    if RUN_LINE_DETECTOR and PADDLE_DETECTOR is not None:
        try:
            # PADDLE_DETECTOR.predict returns a structure — try a few access patterns
            det_res = PADDLE_DETECTOR.predict(out_path)
            # normalize det_res to list of dicts with 'dt_polys' and 'dt_scores' if possible
            if isinstance(det_res, dict) and 'dt_polys' in det_res:
                detections = [det_res]
            elif isinstance(det_res, list):
                detections = det_res
            else:
                detections = None
        except Exception as e:
            print(f"[WARN] PADDLE_DETECTOR failed on {out_path}: {e}")
            detections = None

    # Если детектор дал полигоны — используем их; иначе — один bbox на весь кроп
    if detections and len(detections) > 0 and 'dt_polys' in detections[0] and len(detections[0]['dt_polys'])>0:
        # ожидаем dt_polys как list of np.arrays или lists
        dt_polys = detections[0].get('dt_polys', [])
        dt_scores = detections[0].get('dt_scores', [None]*len(dt_polys))
        for poly, score in zip(dt_polys, dt_scores):
            # ensure list of [ [x,y], ... ]
            try:
                pts = np.array(poly).reshape(-1, 2).tolist()
            except:
                pts = [list(p) for p in poly]
            bbox = _poly_to_bbox(pts)
            segmentation = _flatten_poly(pts)

            # crop axis-aligned to feed recognizer
            x, y, w, h = map(int, [bbox[0], bbox[1], bbox[2], bbox[3]])
            x = max(0, x); y = max(0, y)
            x2 = min(norm.shape[1], x + w); y2 = min(norm.shape[0], y + h)
            crop_line = norm[y:y2, x:x2]
            recog_text = ""
            recog_score = None
            if PADDLE_INSTANCE is not None:
                try:
                    # save temporary line image
                    tmp_line = out_path.replace('.png', f'_line_{_next_ann_id}.png')
                    cv2.imwrite(tmp_line, crop_line)
                    res = PADDLE_INSTANCE.predict(tmp_line)
                    # API may vary; try to extract text
                    if isinstance(res, list) and len(res) > 0:
                        item = res[0]
                        if isinstance(item, dict):
                            recog_text = item.get('rec_text') or item.get('text') or item.get('transcription', "")
                            recog_score = item.get('rec_score') or item.get('score') or None
                        elif isinstance(item, (list, tuple)) and len(item) >= 1:
                            # fallback
                            recog_text = item[0].get('rec_text','') if isinstance(item[0], dict) else ""
                    # remove tmp
                    try:
                        os.remove(tmp_line)
                    except:
                        pass
                except Exception as e:
                    print(f"[WARN] recognition failed on tmp_line {tmp_line}: {e}")
            # Fallback: if recognizer not available — use provided text_label (upper) for whole crop
            if not recog_text:
                recog_text = text_label

            COCO["annotations"].append({
                "id": _next_ann_id,
                "image_id": img_id,
                "category_id": 1,
                "bbox": [float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])],
                "area": float(bbox[2] * bbox[3]),
                "iscrowd": 0,
                "segmentation": [segmentation],
                "attributes": {"text": recog_text, "det_score": float(score) if score is not None else None, "rec_score": float(recog_score) if recog_score is not None else None}
            })
            _next_ann_id += 1
    else:
        # fallback — one annotation for whole normalized image
        h, w = norm.shape[:2]
        bbox = [0.0, 0.0, float(w), float(h)]
        segmentation = [0,0, w,0, w,h, 0,h]
        recog_text = text_label
        recog_score = None
        # try to run recognizer on full image
        if PADDLE_INSTANCE is not None:
            try:
                tmp_full = out_path.replace('.png', f'_full_{_next_ann_id}.png')
                cv2.imwrite(tmp_full, norm)
                res = PADDLE_INSTANCE.predict(tmp_full)
                if isinstance(res, list) and len(res) > 0:
                    item = res[0]
                    if isinstance(item, dict):
                        recog_text = item.get('rec_text') or item.get('text') or recog_text
                        recog_score = item.get('rec_score') or item.get('score') or recog_score
                try:
                    os.remove(tmp_full)
                except:
                    pass
            except Exception as e:
                print(f"[WARN] recognition fallback failed: {e}")

        COCO["annotations"].append({
            "id": _next_ann_id,
            "image_id": img_id,
            "category_id": 1,
            "bbox": bbox,
            "area": bbox[2] * bbox[3],
            "iscrowd": 0,
            "segmentation": [segmentation],
            "attributes": {"text": recog_text, "det_score": None, "rec_score": float(recog_score) if recog_score is not None else None}
        })
        _next_ann_id += 1

    # manifest row for bookkeeping
    manifest_row = {
        'image': os.path.join('multiline', split, 'images', base_fname),
        'class': class_name,
        'text': text_label,
        'source_folder': folder_name,
    }
    labels_list_multiline.append(manifest_row)
    return out_path

# ---------- Сегментация / извлечение кропов ----------
def extract_segments(image_path, model, folder_name, padding: bool = True):
    """
    Возвращает:
      segments_dict - {class_name: [BGR crops (no alpha)]}
      full_img - изображение страницы (BGR)
      masks_data - словарь (masks, boxes, classes, img_shape) для YOLO аннотаций
    IMPORTANT: OCR crops создаются из bbox'ов (rect crops), а не из масок!
    """
    img = cv2.imread(image_path)
    if img is None:
        return {}, None, None

    h, w = img.shape[:2]
    # Первый проход — проверка ориентации
    results = model(img, verbose=False)
    result = results[0]
    if result.boxes is not None and len(result.boxes) > 0:
        boxes_xyxy = result.boxes.xyxy.cpu().numpy()
        if should_rotate_image(boxes_xyxy, h, w):
            # Поворот страницы (если нужно) — с учётом исключений по именам
            clockwise = cv2.ROTATE_90_CLOCKWISE if not any(
                second_name in folder_name for second_name in right_oriented_docs
            ) else cv2.ROTATE_90_COUNTERCLOCKWISE
            img = cv2.rotate(img, clockwise)
            h, w = img.shape[:2]

    # Второй проход для получения боксов/масок
    results = model(img, verbose=False)
    result = results[0]
    if result.boxes is None or len(result.boxes) == 0:
        return {}, img, None

    masks = None
    if hasattr(result, 'masks') and result.masks is not None:
        masks = result.masks.data
        if masks.ndim == 3:
            masks = masks[:, None, ...]
        masks_up = scale_masks(masks, (h, w), padding=padding)
        masks_up_np = masks_up.cpu().numpy()[:, 0] if hasattr(masks_up, 'cpu') else masks_up[:, 0]
    else:
        masks_up_np = None

    boxes_xyxy = result.boxes.xyxy.cpu().numpy()
    classes = [result.names[int(b.cls.item())] for b in result.boxes]

    masks_data = {
        'masks': masks_up_np,
        'boxes': boxes_xyxy,
        'classes': classes,
        'img_shape': (h, w)
    }

    # Создаём rect crops для OCR: берем bbox'ы (не маски!)
    segments = {}
    for i, box in enumerate(boxes_xyxy):
        x1, y1, x2, y2 = map(int, box)
        # clamp
        x1 = max(0, min(w - 1, x1))
        x2 = max(0, min(w, x2))
        y1 = max(0, min(h - 1, y1))
        y2 = max(0, min(h, y2))
        if x2 <= x1 or y2 <= y1:
            continue
        crop = img[y1:y2, x1:x2]

        h_c, w_c = y2  - y1, x2 - x1
        cls_name = classes[i]

        if cls_name != 'document' and w_c < h_c :
            crop = cv2.rotate(crop, cv2.ROTATE_90_COUNTERCLOCKWISE)

        if crop.size == 0:
            continue
        # Не поворачиваем отдельные кропы — это сохраняет естественность
        if cls_name not in segments:
            segments[cls_name] = []
        segments[cls_name].append(crop)

    return segments, img, masks_data

# ---------- Основная логика обработки папки ----------
def process_folder(folder_path, split="train"):
    folder_name = os.path.basename(folder_path)
    fullname = parse_fullname(folder_name)
    if not fullname:
        print(f"[SKIP] Не удалось распарсить имя из: {folder_name}")
        return

    # Находим изображение/PDF
    pdf_files = list(Path(folder_path).glob('*.pdf'))
    image_files = list(Path(folder_path).glob('*.[jJ][pP][gG]')) + list(Path(folder_path).glob('*.[jJ][pP][eE][gG]')) + list(Path(folder_path).glob('*.[pP][nN][gG]'))
    json_files = list(Path(folder_path).glob('*.txt'))

    temp_image = None
    if pdf_files:
        try:
            from pdf2image import convert_from_path
            images = convert_from_path(str(pdf_files[0]), first_page=1, last_page=1)
            if not images:
                print(f"[ERROR] Не удалось конвертировать PDF: {pdf_files[0]}")
                return
            temp_image = os.path.join(folder_path, 'temp_page.png')
            images[0].save(temp_image, 'PNG')
            image_path = temp_image
        except Exception as e:
            print(f"[ERROR] PDF->PNG: {e}")
            return
    elif image_files:
        orig = str(image_files[0])
        temp_image = os.path.join(folder_path, 'temp_page.png')
        im = Image.open(orig)
        im.save(temp_image, 'PNG')
        image_path = temp_image
    else:
        print(f"[SKIP] Нет PDF/изображений в {folder_name}")
        return

    # Читаем JSON (если есть)
    json_data = {}
    if json_files:
        try:
            with open(json_files[0], 'r', encoding='utf-8') as f:
                json_data = json.load(f)
        except Exception as e:
            print(f"[WARN] Не удалось прочитать JSON: {e}")

    # Получаем сегменты и маски
    segments, full_img, masks_data = extract_segments(image_path, model, folder_name)

    if not segments:
        print(f"[SKIP] Нет сегментов в: {folder_name}")
        if temp_image and os.path.exists(temp_image):
            os.remove(temp_image)
        return

    # mapping class -> text (uppercase)
    text_mapping = {
        'name': fullname['name'].upper(),
        'second_name': fullname['second_name'].upper(),
        'third_name': fullname['third_name'].upper(),
        'address': (json_data.get('PlaceBirth') or '').upper(),
        'issued_by': (json_data.get('IssuedBy') or '').upper(),
        'issued_by_code': (json_data.get('IssuedByCode') or '').upper(),
        'sex': 'ЖЕН.' if json_data.get('Sex') == 'Ж' else 'МУЖ.',
        'citizenship': 'РОССИЙСКАЯ ФЕДЕРАЦИЯ' if json_data.get('Citizenship') == 'RU' else ''
    }
    if 'Series' in json_data and 'Number' in json_data:
        text_mapping['serial_number'] = format_serial_number(json_data['Series'], json_data['Number'])
    if 'IssueDate' in json_data:
        try:
            from datetime import datetime
            dt = datetime.fromisoformat(json_data['IssueDate'].split('T')[0])
            text_mapping['date_issue'] = dt.strftime('%d.%m.%Y')
        except:
            text_mapping['date_issue'] = json_data['IssueDate']
    if 'BirthDate' in json_data:
        try:
            from datetime import datetime
            dt = datetime.fromisoformat(json_data['BirthDate'].split('T')[0])
            text_mapping['date_birth'] = dt.strftime('%d.%m.%Y')
        except:
            text_mapping['date_birth'] = json_data['BirthDate']

    # --- Обрабатываем только многострочные классы: address и issued_by ---
    multiline_classes = ('address', 'issued_by')
    saved_count = 0
    for class_name in multiline_classes:
        class_segments = segments.get(class_name, [])
        if not class_segments:
            continue
        text_label = text_mapping.get(class_name, '')
        if not text_label or text_label.strip() == '':
            # если нет текста в json, всё равно сохраняем (можно разметить вручную)
            text_label = ''
        for idx, seg in enumerate(class_segments):
            # Optional: limit number of segments per image
            if MAX_SEGMENTS_PER_IMAGE is not None and idx >= MAX_SEGMENTS_PER_IMAGE:
                break

            try:
                saved_path = save_multiline_segment(folder_name, class_name, seg, text_label, split)
                if saved_path:
                    saved_count += 1
                    print(f"[MULTILINE] saved normalized for CVAT: {saved_path}")
            except Exception as e:
                print(f"[WARN] save_multiline_segment error: {e}")
                continue

    print(f"[OK] {folder_name}: saved {saved_count} multiline images")
    if temp_image and os.path.exists(temp_image):
        os.remove(temp_image)

# ---------- Main ----------
def main():
    print("Начинаю обработку датасета (fixed)...")

    # Создаём data.yaml для YOLO (если включено)
    if BUILD_YOLO_DATASET:
        yaml_content = f"""names:
- document
- name
- second_name
- third_name
- gender
- date
- address
- serial_number
- MRZ
- date_issue
- issued_by
- issued_by_code
- citizenship
nc: 13
train: train/images
val: validation/images
test: test/images
"""
        yaml_path = os.path.join(YOLO_DATASET_DIR, 'data.yaml')
        with open(yaml_path, 'w', encoding='utf-8') as f:
            f.write(yaml_content)
        print(f"[INFO] data.yaml создан: {yaml_path}")

    # Получаем и перемешиваем папки с фиксированным seed для воспроизводимости
    folders = [f for f in os.listdir(BASE_DIR) if os.path.isdir(os.path.join(BASE_DIR, f))
               # and f.find("Черпухин") == 0
               ]
    random.seed(42)  # для воспроизводимости
    random.shuffle(folders)

    total = len(folders)
    train_split = int(0.7 * total)
    val_split = int(0.9 * total)

    train_folders = set(folders[:train_split])
    val_folders = set(folders[train_split:val_split])
    test_folders = set(folders[val_split:])

    print(f"Всего папок: {total}")
    print(f"Train: {len(train_folders)}, Val: {len(val_folders)}, Test: {len(test_folders)}")

    for folder_name in folders:
        folder_path = os.path.join(BASE_DIR, folder_name)
        if folder_name in train_folders:
            split = 'train'
        elif folder_name in val_folders:
            split = 'validation'
        else:
            split = 'test'
        process_folder(folder_path, split)

    # Save labels
    with open(LABELS_FILE, 'w', encoding='utf-8') as f:
        f.writelines(labels_list)

    # Save multiline CSV (для импорта в CVAT / обмена метаданными)
    if BUILD_MULTILINE_DATASET:
        keys = ['image', 'class', 'text', 'source_folder']
        with open(multiline_manifest_path, 'w', newline='', encoding='utf-8') as mf:
            writer = csv.DictWriter(mf, fieldnames=keys)
            writer.writeheader()
            for row in labels_list_multiline:
                writer.writerow(row)
        print(f"[INFO] Multiline manifest saved: {multiline_manifest_path}")

        # Сохраняем COCO annotations (в корне MULTILINE_DIR)
        coco_path = os.path.join(MULTILINE_DIR, 'annotations.json')
        # приводим пути image.file_name к относительным path inside MULTILINE_DIR (мы уже писали так)
        with open(coco_path, 'w', encoding='utf-8') as cf:
            json.dump(COCO, cf, ensure_ascii=False, indent=2)
        print(f"[INFO] COCO annotations for CVAT saved: {coco_path}")
        print("Структура для загрузки в CVAT:")
        print(f" - {MULTILINE_DIR}/train/images/*.png")
        print(f" - {MULTILINE_DIR}/validation/images/*.png")
        print(f" - {MULTILINE_DIR}/test/images/*.png")
        print(f" - {MULTILINE_DIR}/annotations.json  (загрузи как COCO 1.0)")

    print("\nГотово.")
    print(f"Многострочных изображений: {len(COCO['images'])}")
    if BUILD_MULTILINE_DATASET:
        print(f"COCO annotations: {len(COCO['annotations'])}")

if __name__ == '__main__':
    main()
