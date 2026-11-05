"""Extract short text lines with the already installed Paddle recognizer."""
from __future__ import annotations

import time


def recognize_page(image, deadline: float) -> str:
    import cv2
    import numpy as np
    from recognizeuz.core.resources import infer_lock
    from recognizeuz.image.preprocessing import prepare_ocr_image_array
    from recognizeuz.ocr.paddle import recognize_prepared_images_with_paddle

    if time.monotonic() >= deadline:
        raise TimeoutError('Type check deadline exceeded')
    rgb = np.asarray(image.convert('RGB'))
    height, width = rgb.shape[:2]
    scale = min(1.0, 2000 / max(height, width))
    if scale < 1:
        rgb = cv2.resize(rgb, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    height, width = bgr.shape[:2]
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    joined = cv2.morphologyEx(binary, cv2.MORPH_CLOSE,
                              cv2.getStructuringElement(cv2.MORPH_RECT, (max(3, width // 90), 3)))
    contours, _ = cv2.findContours(joined, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = sorted((cv2.boundingRect(contour) for contour in contours), key=lambda box: (box[1], box[0]))
    crops = []
    for x, y, w, h in boxes:
        if w < width * 0.025 or h < 7 or h > height * 0.12 or w / h < 1.5:
            continue
        pad = max(2, h // 5)
        crop = bgr[max(0, y-pad):min(height, y+h+pad), max(0, x-pad):min(width, x+w+pad)]
        crops.append(prepare_ocr_image_array(crop))
        if len(crops) == 40:
            break
    if not crops:
        return ''
    remaining = deadline - time.monotonic()
    if remaining <= 0 or not infer_lock.acquire(timeout=remaining):
        raise TimeoutError('Type check is busy')
    try:
        result = recognize_prepared_images_with_paddle('passport', crops)
    finally:
        infer_lock.release()
    return '\n'.join(text for text, score in result if score >= 0.75)
