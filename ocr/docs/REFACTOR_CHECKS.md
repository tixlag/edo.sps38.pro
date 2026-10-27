> Справочник перенесён из исходной модульной версии. Актуальные пути, установка, запуск и результаты проверок — в корневом README, `installation.md` и `verification.md`. Старые абсолютные пути и sandbox-проверки ниже относятся к исходной версии.

# Refactor v3 checks

Проверено в sandbox:

```bash
python3 -m compileall -q .
```

Проверен импорт приложения со stub-модулями `ultralytics` и PaddleOCR:

```text
from recognizeuz.main import app
from recognizeuz.documents.registry import get_document_spec
```

Проверено:

- приложение импортируется;
- `Base64Request` принимает `save_segments`;
- `RecognitionOptions` принимает `save_segments`;
- migration spec содержит `migration_fio_grid_letters:replace`;
- synthetic grid row режется на клетки через `detect_grid_cells`;
- `SegmentDumpSession` создаёт run dir, image file и `manifest.json`.

Ограничение проверки: реальные YOLO/PaddleOCR/GLM inference не запускались, потому что в sandbox нет весов, PaddleOCR checkout и GLM OCR сервера.
