> Справочник перенесён из исходной модульной версии. Актуальные пути, установка, запуск и результаты проверок — в корневом README, `installation.md` и `verification.md`. Старые абсолютные пути и sandbox-проверки ниже относятся к исходной версии.

# RecognizeUZ refactor v3

Этот архив продолжает целевую архитектуру `DocumentSpec + stage pipeline` и добавляет две практические вещи:

1. request-scoped сохранение промежуточных изображений pipeline;
2. rule-based stage для ФИО на миграционной карте: строка клеток -> отдельные буквы -> batch PaddleOCR -> склейка слова.

## Как включить сохранение промежуточных сегментов

Для multipart endpoint:

```bash
POST /recognize?save_segments=true
```

Поддерживается алиас:

```bash
POST /recognize?dump_segments=true
```

Для base64 endpoint:

```bash
POST /recognize-base64?save_segments=true
```

Или в JSON body:

```json
{
  "save_segments": true,
  "files": []
}
```

По умолчанию картинки сохраняются в:

```text
/home/neuro/PycharmProjects/RecognizeUZ/debug/segment_dumps/<run_id>/
```

Путь можно изменить через env:

```bash
SEGMENT_DUMP_ROOT=/path/to/debug/segment_dumps
```

Внутри run-директории создаётся `manifest.json`, а рядом с каждой картинкой лежит `.json` с метаданными: какой stage, какое поле, какой doc_type, что было передано дальше и что распознала модель.

Сохраняются основные изображения:

- `page.input` — входная страница;
- `document.warp_crop` — crop документа после YOLO document detector;
- `orientation.field_detector_input` — candidate crop, переданный в field detector для каждого угла;
- `orientation.field_detector_output` — метаданные найденных полей;
- `document.oriented_best` — лучший повернутый crop документа;
- `field.raw_crop` — field crop после field YOLO;
- `field.prepared_for_paddle` — normalized OCR image, реально переданный в PaddleOCR;
- `fallback.glm_*_input` — изображения, уходившие в GLM fallback;
- `migration_fio_grid.*` — вход строки ФИО, raw/prepared crop каждой клетки.

## Migration card FIO grid stage

Для полей:

- `mg_surname`
- `mg_surname_lat`
- `mg_name`
- `mg_patronymic`

добавлен stage:

```text
migration_fio_grid_letters
```

Он не требует обучения новой модели. Алгоритм:

1. берёт crop строки ФИО, который уже нашёл YOLO field detector;
2. через OpenCV ищет вертикальные линии клеток;
3. режет строку на cell/glyph crops с небольшим overlap;
4. готовит каждый glyph тем же OCR preprocess;
5. одним batch-запросом отправляет glyph images в migration PaddleOCR recognizer;
6. нормализует отдельные символы и склеивает слово.

По умолчанию stage включён в режиме:

```bash
MIGRATION_FIO_GRID_STAGE_MODE=replace
```

Режимы:

```text
disabled   - полностью выключить;
debug_only - запускать только при debug=true или save_segments=true, не заменять итог;
candidate  - запускать, показывать candidate в debug, не заменять итог;
replace    - заменить итоговый текст поля, если cells/text/score выглядят правдоподобно.
```

Полезные настройки:

```bash
MIGRATION_FIO_GRID_MIN_CELLS=2
MIGRATION_FIO_GRID_MIN_AVG_SCORE=0.45
MIGRATION_FIO_GRID_CELL_OVERLAP_RATIO=0.10
MIGRATION_FIO_GRID_ERASE_LINES=0
MIGRATION_FIO_GRID_GLM_FALLBACK_ENABLED=0
MIGRATION_FIO_GRID_GLM_SCORE_THRESHOLD=0.35
```

GLM fallback для каждой буквы по умолчанию выключен, потому что это медленно. Его лучше включать только для диагностики или если Paddle по одиночным буквам всё равно ошибается.

## Совместимость

Обычные запросы без `save_segments=true` и без изменения env работают как раньше, кроме улучшенного recognition path для migration-card FIO fields, потому что stage по умолчанию в режиме `replace`.

Чтобы полностью вернуть старое поведение миграционных карт:

```bash
MIGRATION_FIO_GRID_STAGE_MODE=disabled
```
