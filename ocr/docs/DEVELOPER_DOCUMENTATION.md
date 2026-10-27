> Справочник перенесён из исходной модульной версии. Актуальные пути, установка, запуск и результаты проверок — в корневом README, `installation.md` и `verification.md`. Старые абсолютные пути и sandbox-проверки ниже относятся к исходной версии.

# RecognizeUZ OCR API — документация для разработчиков

Версия документации: v3 refactor
Целевая архитектура: **DocumentSpec + stage pipeline**
Назначение проекта: распознавание документов Узбекистана и миграционных карт через FastAPI, YOLO segmentation, PaddleOCR recognition, GLM OCR fallback и дополнительные document-specific stages.

---

## 1. Что делает проект

`RecognizeUZ OCR API` принимает изображения или PDF-файлы, находит на них документы, вырезает документ, выбирает корректную ориентацию, находит поля, вырезает поля, распознаёт текст и возвращает структурированный JSON.

На текущий момент поддерживаются типы документов:

- `passport` — паспорт Узбекистана;
- `migration_card` — миграционная карта.

Основной runtime pipeline:

```text
file/pdf/image
  -> pages
  -> document YOLO detector
  -> document warp crop
  -> orientation candidates
  -> field YOLO detector
  -> best orientation
  -> field crops
  -> OCR preprocess
  -> PaddleOCR
  -> intermediate stages
  -> GLM fallback / quality verification / datasets
  -> public/debug response
```

Ключевая архитектурная идея: общий pipeline не должен знать деталей конкретного документа. Детали документа описывает `DocumentSpec`.

---

## 2. Главные архитектурные принципы

### 2.1. FastAPI должен быть тонким

Роуты только принимают входные данные, вычисляют flags и вызывают pipeline.

Файл:

```text
recognizeuz/api/routes.py
```

Роут не должен содержать OCR-логику, YOLO-логику, fallback-логику, правила полей или работу с датасетами.

### 2.2. Pipeline должен быть стадийным

Каждая стадия отвечает за один крупный шаг:

```text
page.py        — обработка страницы и document detector
/document.py   — crop документа, ориентация, запуск field pipeline
/field.py      — crop поля, OCR preprocess, PaddleOCR, intermediate stages
/fallbacks.py  — GLM fallback, OCR improve, quality verification, dataset collection
/output.py     — сбор public/debug ответа
```

Не нужно добавлять новые document-specific проверки прямо в `page.py` или `document.py`. Для этого есть `DocumentSpec` и `intermediate stages`.

### 2.3. DocumentSpec управляет документом

Каждый тип документа описывается объектом `DocumentSpec`:

```text
recognizeuz/documents/base.py
```

Спецификация отвечает за:

- `doc_type`;
- список допустимых полей;
- список публичных output-полей;
- field detector model key;
- text recognizer model key;
- layout scoring;
- проверку уверенности ориентации;
- skip/internal поля;
- промежуточные stages;
- конвертацию текста в кириллицу, если нужна.

### 2.4. Модели не должны импортироваться напрямую из pipeline

Модели хранятся в `ModelRegistry`:

```text
recognizeuz/core/resources.py
```

Pipeline обращается к моделям по логическим ключам:

```python
model_registry.yolo["doc_type"]
model_registry.yolo["passport_fields"]
model_registry.yolo["migration_fields"]
model_registry.recognizers["passport_ocr"]
model_registry.recognizers["migration_ocr"]
```

DocumentSpec указывает ключи моделей через `ModelRef`.

### 2.5. Промежуточные модели и этапы добавляются через stages

Для задач вроде:

- дополнительный detector букв;
- распознавание отдельных glyph/cell crop;
- отдельный классификатор качества поля;
- спец-обработка только одного документа;
- спец-обработка только некоторых полей;

используется механизм `IntermediateStageSpec`.

Текущий пример:

```text
migration_fio_grid_letters
```

Файл реализации:

```text
recognizeuz/pipeline/stages/migration_fio_grid.py
```

---

## 3. Структура проекта

```text
recognizeuz_refactor_v3/
  app.py
  pyproject.toml
  README_REFACTOR.md
  REFACTOR_CHECKS.md

  recognizeuz/
    main.py

    api/
      routes.py
      schemas.py

    core/
      config.py
      paddle_args.py
      resources.py
      profiling.py

    image/
      loading.py
      geometry.py
      preprocessing.py

    inference/
      yolo.py
      orientation.py

    ocr/
      paddle.py
      glm.py

    text/
      normalization.py
      transliteration.py

    quality/
      verification.py

    dataset/
      low_conf_agreement.py
      ocr_improve.py

    debug/
      segment_dump.py

    documents/
      base.py
      fields.py
      registry.py

      passport/
        constants.py
        layout.py
        spec.py

      migration_card/
        constants.py
        layout.py
        spec.py

    pipeline/
      recognition.py
      types.py
      page.py
      document.py
      field.py
      intermediate.py
      fallbacks.py
      output.py

      stages/
        migration_fio_grid.py

    utils/
      files.py
      timing.py
```

---

## 4. Точка входа приложения

### 4.1. `app.py`

Совместимый entrypoint для старого запуска:

```python
from recognizeuz.main import app
```

Это позволяет запускать сервис так:

```bash
uvicorn app:app --host 0.0.0.0 --port 8000 --workers 1
```

### 4.2. `recognizeuz/main.py`

Создаёт FastAPI-приложение, подключает роуты и управляет lifespan:

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    load_models()
    yield
    cleanup_models()
```

При старте загружаются YOLO и PaddleOCR модели. При остановке ссылки на модели очищаются.

---

## 5. API endpoints

### 5.1. `GET /health`

Возвращает статус сервиса и моделей.

Пример ответа:

```json
{
  "status": "ok",
  "models": {
    "doc_model": true,
    "passport_fields_model": true,
    "migration_fields_model": true,
    "passport_ocr": true,
    "migration_ocr": true,
    "registry": {
      "doc_type": true,
      "passport_fields": true,
      "migration_fields": true,
      "passport_ocr": true,
      "migration_ocr": true
    }
  }
}
```

### 5.2. `POST /recognize`

Multipart endpoint для загрузки файлов.

Параметры:

| Параметр | Где | Тип | Назначение |
|---|---:|---:|---|
| `files` | multipart | `list[UploadFile]` | один или несколько файлов |
| `debug` | query/form | `bool` | расширенный JSON с отладочной информацией |
| `ocr_improve` | query/form | `bool` | режим сбора OCR improve dataset |
| `save_segments` | query/form | `bool` | сохранить промежуточные изображения pipeline |
| `dump_segments` | query | `bool` | alias для `save_segments` |

Пример:

```bash
curl -X POST \
  'http://127.0.0.1:8000/recognize?debug=true&save_segments=true' \
  -F 'files=@/path/to/document.jpg'
```

### 5.3. `POST /recognize-base64`

JSON endpoint для передачи base64-файлов.

Тело запроса:

```json
{
  "debug": false,
  "ocr_improve": false,
  "save_segments": false,
  "files": [
    {
      "filename": "document.jpg",
      "content_base64": "..."
    }
  ]
}
```

Query flags имеют приоритет объединения через `or`:

```http
POST /recognize-base64?debug=true&save_segments=true
```

---

## 6. Форматы ответа

### 6.1. Production response

Без `debug=true` возвращается компактный ответ:

```json
[
  {
    "type": "passport",
    "fields": {
      "pas_number": {
        "text": "FK0005552",
        "confidence": 0.98,
        "text_cyrillic": "..."
      }
    }
  }
]
```

Для паспорта включён `text_cyrillic`, потому что `PASSPORT_SPEC.add_cyrillic_output=True`.

Для миграционной карты ответ аналогичный, но без кириллического дубля, потому что поля уже рассчитаны на кириллицу/как есть.

### 6.2. Debug response

При `debug=true` ответ содержит:

- source file metadata;
- document confidence;
- orientation info;
- avg PaddleOCR score;
- fallback mode;
- per-field timing;
- Paddle/GLM сравнение;
- quality report;
- TTA info;
- intermediate stage results;
- dataset sample info;
- polygons/bboxes;
- pipeline profile;
- segment dump info.

Ключевые debug-блоки:

```json
{
  "debug": {
    "segment_dump": {},
    "timing": {
      "page_document_yolo_seconds": 0.123,
      "orientation": {},
      "pipeline_profile": [],
      "pipeline_profile_totals": {}
    },
    "intermediate_stages": [],
    "migration_fio_grid_stage": {},
    "ocr_improve_dataset": {}
  }
}
```

### 6.3. Response при `save_segments=true` без debug

Production response остаётся компактным, но добавляется блок:

```json
{
  "segment_dump": {
    "enabled": true,
    "run_id": "20260619T...",
    "run_dir": "/home/neuro/PycharmProjects/RecognizeUZ/debug/segment_dumps/...",
    "items_count": 42
  }
}
```

---

## 7. Конфигурация

Основной файл:

```text
recognizeuz/core/config.py
```

### 7.1. Пути

| Константа | Назначение |
|---|---|
| `PADDLEOCR_ROOT` | путь к checkout PaddleOCR |
| `PROJECT_ROOT` | корень проекта RecognizeUZ |
| `DOC_MODEL_PATH` | YOLO модель определения типа документа |
| `PASSPORT_FIELDS_MODEL_PATH` | YOLO модель полей паспорта |
| `MIGRATION_FIELDS_MODEL_PATH` | YOLO модель полей миграционной карты |
| `PASSPORT_OCR_MODEL_DIR` | PaddleOCR rec model для паспорта |
| `MIGRATION_OCR_MODEL_DIR` | PaddleOCR rec model для миграционной карты |
| `PASSPORT_DICT_PATH` | словарь символов паспорта |
| `MIGRATION_DICT_PATH` | словарь символов миграционной карты |

Сейчас пути заданы как абсолютные. Это соответствует текущей production-среде, но при дальнейшем развитии лучше перевести их на env-переменные или pydantic settings.

### 7.2. GPU и размеры inference

| Константа | Значение | Назначение |
|---|---:|---|
| `DEVICE` | `0` | GPU id |
| `USE_GPU` | `True` | использовать GPU в PaddleOCR |
| `DOC_IMGSZ` | `1280` | размер YOLO inference для документа |
| `FIELDS_IMGSZ` | `1280` | размер YOLO inference для полей |
| `DOC_CONF` | `0.1` | threshold document detector |
| `FIELD_CONF` | `0.25` | threshold field detector |

### 7.3. PDF и OCR preprocessing

| Константа | Значение | Назначение |
|---|---:|---|
| `PDF_DPI` | `220` | DPI рендера PDF через pypdfium2 |
| `OCR_TARGET_HEIGHT` | `48` | высота OCR crop после normalize |
| `OCR_MIN_WIDTH` | `32` | минимальная ширина OCR crop |
| `OCR_MAX_WIDTH` | `768` | максимальная ширина OCR crop |
| `OCR_PAD_X` | `4` | горизонтальный padding |
| `OCR_PAD_Y` | `4` | вертикальный padding |

### 7.4. GLM fallback

| Env | Default | Назначение |
|---|---:|---|
| `GLM_FIELD_FALLBACK_THRESHOLD` | `0.90` | если Paddle score поля ниже — точечный GLM fallback |
| `GLM_FULL_DOC_AVG_THRESHOLD` | `0.85` | если средний Paddle score документа ниже — GLM на весь документ |
| `GLM_OCR_URL` | `http://127.0.0.1:8083/v1/chat/completions` | vLLM OpenAI-compatible endpoint |
| `GLM_OCR_MODEL` | `zai-org/GLM-OCR` | имя GLM OCR модели |
| `GLM_OCR_TIMEOUT_SEC` | `12` | timeout запроса к GLM |

### 7.5. OCR quality verification

| Env | Default | Назначение |
|---|---:|---|
| `OCR_VERIFY_ENABLED` | `1` | общий выключатель production verification |
| `OCR_SAFE_REPAIR_ENABLED` | `1` | безопасный repair одиночных ошибок |
| `OCR_TTA_ENABLED` | `1` | test-time augmentation для подозрительных OCR |
| `OCR_TTA_MAX_VARIANTS` | `4` | максимум TTA вариантов |
| `OCR_TTA_MIN_MAJORITY` | `2` | минимальное большинство для TTA |
| `OCR_GLM_ON_QUALITY_FLAGS` | `1` | вызывать GLM при quality flags |
| `OCR_ACCEPT_GLM_ONLY_IF_VALID` | `1` | принимать GLM только если поле прошло validation |
| `OCR_SAFE_REPAIR_PERSON_TRIPLE` | `0` | разрешить repair тройных повторов в ФИО |
| `OCR_SAFE_REPAIR_DICTIONARY_TOKENS` | `1` | token-level dictionary repair |
| `OCR_SAFE_REPAIR_DICTIONARY_NEAREST` | `1` | nearest dictionary repair |
| `OCR_DICTIONARY_NEAREST_MAX_DISTANCE` | `2` | max Levenshtein distance |
| `PASSPORT_AUTHORITY_KNOWN_PREFIXES` | `MIA,PSC` | известные префиксы authority |

### 7.6. Low confidence agreement dataset

| Env | Default | Назначение |
|---|---:|---|
| `LOW_CONF_AGREEMENT_DATASET_ENABLED` | `1` | включить сохранение samples |
| `LOW_CONF_AGREEMENT_DATASET_DIR` | `${PROJECT_ROOT}/datasets/paddle_low_conf_glm_agree` | каталог датасета |
| `LOW_CONF_AGREEMENT_SCORE_THRESHOLD` | `GLM_FIELD_FALLBACK_THRESHOLD` | score threshold |

Используется, когда PaddleOCR дал низкий score, но GLM подтвердил тот же текст.

### 7.7. OCR improve dataset

| Env | Default | Назначение |
|---|---:|---|
| `OCR_IMPROVE_DATASET_ENABLED` | `1` | включить режим сохранения improve samples |
| `OCR_IMPROVE_DATASET_ROOT` | `${PROJECT_ROOT}/datasets/ocr_improve` | корень датасета |
| `OCR_IMPROVE_MIN_DOC_CONF` | `0.50` | минимум confidence документа |
| `OCR_IMPROVE_MIN_FIELD_CONF` | `0.50` | минимум confidence поля |
| `OCR_IMPROVE_REQUIRE_CONFIDENT_ORIENTATION` | `1` | требовать уверенную ориентацию |
| `OCR_IMPROVE_MAX_LABEL_LEN` | `128` | максимум длины label |
| `OCR_IMPROVE_AUGMENTATIONS_PER_SEGMENT` | `3` | количество augmentations |

Включается на запросе:

```http
POST /recognize?ocr_improve=true
```

### 7.8. Segment dump

| Env | Default | Назначение |
|---|---|---|
| `SEGMENT_DUMP_ROOT` | `${PROJECT_ROOT}/debug/segment_dumps` | куда сохранять промежуточные изображения |

Включается на запросе:

```http
POST /recognize?save_segments=true
```

Или:

```http
POST /recognize?dump_segments=true
```

### 7.9. Migration FIO grid stage

| Env | Default | Назначение |
|---|---:|---|
| `MIGRATION_FIO_GRID_STAGE_MODE` | `replace` | режим stage |
| `MIGRATION_FIO_GRID_MIN_CELLS` | `2` | минимум найденных клеток |
| `MIGRATION_FIO_GRID_MIN_AVG_SCORE` | `0.45` | минимум среднего score glyph OCR |
| `MIGRATION_FIO_GRID_CELL_OVERLAP_RATIO` | `0.10` | overlap при crop клетки |
| `MIGRATION_FIO_GRID_ERASE_LINES` | `0` | удалять линии клеток перед OCR |
| `MIGRATION_FIO_GRID_GLM_FALLBACK_ENABLED` | `0` | GLM fallback для отдельных букв |
| `MIGRATION_FIO_GRID_GLM_SCORE_THRESHOLD` | `0.35` | threshold для GLM glyph fallback |

Режимы `MIGRATION_FIO_GRID_STAGE_MODE`:

```text
disabled   — не запускать stage;
debug_only — запускать только при debug/save_segments, не заменять текст;
candidate  — запускать всегда, но не заменять итог;
replace    — заменить итоговый текст поля, если результат правдоподобен.
```

---

## 8. Модели и ModelRegistry

Файл:

```text
recognizeuz/core/resources.py
```

### 8.1. Что загружается сейчас

При старте приложения вызывается `load_models()`:

```python
doc_model = YOLO(str(DOC_MODEL_PATH))
passport_fields_model = YOLO(str(PASSPORT_FIELDS_MODEL_PATH))
migration_fields_model = YOLO(str(MIGRATION_FIELDS_MODEL_PATH))

passport_ocr = TextRecognizer(...)
migration_ocr = TextRecognizer(...)
```

Затем модели регистрируются:

```python
model_registry.yolo["doc_type"] = doc_model
model_registry.yolo["passport_fields"] = passport_fields_model
model_registry.yolo["migration_fields"] = migration_fields_model
model_registry.recognizers["passport_ocr"] = passport_ocr
model_registry.recognizers["migration_ocr"] = migration_ocr
```

### 8.2. Как добавлять новую модель

Например, нужен дополнительный detector букв для миграционной карты.

1. Добавить путь в `core/config.py`:

```python
MIGRATION_GLYPH_DETECTOR_MODEL_PATH = PROJECT_ROOT / "runs/.../best.pt"
```

2. Загрузить модель в `load_models()`:

```python
migration_glyph_detector = YOLO(str(MIGRATION_GLYPH_DETECTOR_MODEL_PATH))
model_registry.yolo["migration_glyph_detector"] = migration_glyph_detector
```

3. В `DocumentSpec` добавить `IntermediateStageSpec`:

```python
IntermediateStageSpec(
    key="migration_fio_glyph_detector",
    model=ModelRef("migration_glyph_detector", "yolo"),
    applies_to_fields=frozenset({"mg_surname", "mg_name", "mg_patronymic"}),
    scope="field",
    mode="candidate",
)
```

4. В `pipeline/intermediate.py` добавить dispatch:

```python
if stage.key == "migration_fio_glyph_detector":
    run_migration_fio_glyph_detector_stage(...)
    return True
```

5. Реализацию положить в:

```text
recognizeuz/pipeline/stages/migration_fio_glyph_detector.py
```

---

## 9. DocumentSpec

Файл базовых типов:

```text
recognizeuz/documents/base.py
```

### 9.1. `ModelRef`

```python
@dataclass(frozen=True)
class ModelRef:
    key: str
    kind: ModelKind
    required: bool = True
```

Используется, чтобы pipeline не знал конкретных глобальных переменных модели.

Примеры:

```python
ModelRef("passport_fields", "yolo")
ModelRef("migration_ocr", "paddle_recognizer")
ModelRef("rule_based_grid_cell_detector", "custom", required=False)
```

### 9.2. `IntermediateStageSpec`

```python
@dataclass(frozen=True)
class IntermediateStageSpec:
    key: str
    model: ModelRef
    applies_to_fields: frozenset[str]
    scope: StageScope
    mode: StageMode
    description: str
    config: dict[str, Any]
```

Определяет optional stage, который может запускаться для отдельных полей.

### 9.3. `DocumentSpec`

Главный контракт документа:

```python
@dataclass(frozen=True)
class DocumentSpec:
    doc_type: str
    field_names: frozenset[str]
    output_fields: tuple[str, ...]
    field_detector: ModelRef
    text_recognizer: ModelRef
    score_layout: Callable
    is_orientation_confident: Callable
    skip_ocr_fields: frozenset[str]
    internal_only_fields: frozenset[str]
    field_labels: dict[str, str]
    intermediate_stages: tuple[IntermediateStageSpec, ...]
    add_cyrillic_output: bool
    cyrillic_converter: FieldPostProcessor | None
```

### 9.4. Passport spec

Файл:

```text
recognizeuz/documents/passport/spec.py
```

Особенности:

- `doc_type="passport"`;
- field detector: `passport_fields`;
- recognizer: `passport_ocr`;
- есть `pas_mrz` как internal field;
- `pas_photo` и `pas_mrz` пропускаются OCR;
- включён `text_cyrillic` через транслитерацию;
- layout scoring использует MRZ/photo/порядок полей.

### 9.5. Migration card spec

Файл:

```text
recognizeuz/documents/migration_card/spec.py
```

Особенности:

- `doc_type="migration_card"`;
- field detector: `migration_fields`;
- recognizer: `migration_ocr`;
- все поля публичные;
- подключён intermediate stage `migration_fio_grid_letters` для ФИО.

---

## 10. Registry документов

Файл:

```text
recognizeuz/documents/registry.py
```

Содержит:

```python
_DOCUMENT_SPECS = {
    "passport": PASSPORT_SPEC,
    "migration_card": MIGRATION_CARD_SPEC,
}
```

Методы:

```python
get_document_spec(doc_type: str) -> DocumentSpec
maybe_get_document_spec(doc_type: str) -> DocumentSpec | None
```

Чтобы добавить новый документ, его spec нужно зарегистрировать здесь.

---

## 11. Pipeline подробно

### 11.1. `recognize_files_payload()`

Файл:

```text
recognizeuz/pipeline/page.py
```

Это верхняя функция pipeline.

Вход:

```python
files_payload: list[tuple[str, bytes, str | None]]
```

Каждый tuple:

```text
(filename, data, content_type)
```

Функция:

1. создаёт общий `SegmentDumpSession` на весь запрос;
2. берёт `resources.infer_lock`;
3. грузит страницы из файла;
4. запускает `process_page()` для каждой страницы;
5. возвращает список найденных документов.

### 11.2. `process_page()`

Файл:

```text
recognizeuz/pipeline/page.py
```

Делает:

1. создаёт `RecognitionOptions`;
2. создаёт `PipelineProfiler`;
3. сохраняет `page.input`, если `save_segments=true`;
4. запускает `detect_documents()`;
5. сохраняет metadata события `page.document_detector_output`;
6. создаёт `PageContext`;
7. вызывает `process_detected_document()` для каждого найденного документа.

### 11.3. `process_detected_document()`

Файл:

```text
recognizeuz/pipeline/document.py
```

Делает:

1. проверяет `doc_type`;
2. получает `DocumentSpec`;
3. вырезает документ через `warp_document_by_polygon()`;
4. сохраняет `document.warp_crop`;
5. выбирает ориентацию через `choose_best_document_orientation_for_spec()`;
6. сохраняет `document.oriented_best`;
7. проверяет `orientation_confident`;
8. создаёт `DocumentContext`;
9. запускает:
   - `recognize_document_fields(ctx)`;
   - `apply_fallbacks_and_datasets(ctx)`;
   - `build_output_document(ctx)`.

Если ориентация неуверенная, документ пропускается.

### 11.4. `recognize_document_fields()`

Файл:

```text
recognizeuz/pipeline/field.py
```

Для каждого поля:

1. пропускает internal fields;
2. вырезает field crop через `crop_field_polygon_masked()`;
3. сохраняет `field.raw_crop`;
4. при `ocr_improve=true` подготавливает orig variant;
5. запускает PaddleOCR через `recognize_field_text()`;
6. сохраняет `field.prepared_for_paddle`;
7. формирует field item;
8. запускает `apply_intermediate_field_stages()`;
9. пересчитывает `avg_paddle_score` по OCR-кандидатам.

### 11.5. `apply_intermediate_field_stages()`

Файл:

```text
recognizeuz/pipeline/intermediate.py
```

Получает stages из `DocumentSpec`:

```python
spec.enabled_intermediate_stages_for_field(field_name)
```

Для известных stage keys вызывает конкретный обработчик.

Сейчас известен:

```text
migration_fio_grid_letters
```

Неизвестные stage не меняют production-результат. В debug они добавляют запись:

```json
{
  "stage": "...",
  "status": "handler_not_implemented"
}
```

### 11.6. `apply_fallbacks_and_datasets()`

Файл:

```text
recognizeuz/pipeline/fallbacks.py
```

Работает в двух режимах:

```python
if ctx.page.options.ocr_improve:
    apply_ocr_improve_mode(ctx)
else:
    apply_production_fallback_mode(ctx)
```

Production mode:

1. если средний Paddle score документа ниже `GLM_FULL_DOC_AVG_THRESHOLD`, вызывает GLM на весь документ;
2. иначе точечно вызывает GLM для полей ниже `GLM_FIELD_FALLBACK_THRESHOLD`;
3. запускает quality verification;
4. сохраняет low-conf agreement samples.

OCR improve mode:

1. для каждого OCR candidate вызывает GLM field OCR;
2. сравнивает Paddle и GLM;
3. сохраняет mismatch samples в OCR improve dataset.

### 11.7. `build_output_document()`

Файл:

```text
recognizeuz/pipeline/output.py
```

Собирает public/debug JSON.

В production:

- возвращает только публичные поля из `spec.output_fields`;
- скрывает служебные поля;
- confidence становится `1.0`, если финальный текст пришёл из GLM;
- добавляет `text_cyrillic`, если это указано в spec.

В debug:

- возвращает расширенную информацию по документу и полям;
- добавляет timing;
- добавляет quality/TTA/fallback/intermediate/dataset/segment dump info.

---

## 12. Image loading

Файл:

```text
recognizeuz/image/loading.py
```

Функции:

```python
pil_to_bgr(img: Image.Image) -> np.ndarray
load_image_bytes(data: bytes) -> np.ndarray
load_pdf_bytes(data: bytes, dpi: int = PDF_DPI) -> list[np.ndarray]
load_pages_from_upload(data, filename, content_type) -> list[np.ndarray]
```

Правила:

- все изображения внутри pipeline — OpenCV BGR `np.ndarray`;
- PDF рендерится через `pypdfium2`;
- EXIF orientation учитывается через `ImageOps.exif_transpose()`.

---

## 13. Geometry

Файл:

```text
recognizeuz/image/geometry.py
```

Основные функции:

| Функция | Назначение |
|---|---|
| `polygon_to_list()` | JSON-friendly polygon |
| `bbox_from_polygon()` | bbox из polygon |
| `order_quad_points()` | упорядочить 4 точки |
| `warp_document_by_polygon()` | perspective transform документа |
| `rotate_image()` | поворот на 0/90/180/270 |
| `crop_field_bbox()` | старый bbox crop |
| `crop_field_polygon_masked()` | crop поля по polygon mask |
| `center_of()` | центр поля |

Для field OCR используется `crop_field_polygon_masked()`, а не простой bbox. Это важно, если поле наклонено или polygon точнее bbox.

---

## 14. YOLO inference

Файл:

```text
recognizeuz/inference/yolo.py
```

### 14.1. `yolo_predict_segments()`

Универсальный wrapper вокруг `YOLO.predict()`.

Возвращает список:

```python
{
  "class_id": int,
  "class_name": str,
  "confidence": float,
  "polygon": np.ndarray,
  "bbox": list[float]
}
```

### 14.2. `detect_documents()`

Использует модель `doc_type`.

Классы переводятся через `DOC_ALIASES`:

```python
"1_passport_uz" -> "passport"
"27_migration_card" -> "migration_card"
```

Если документы не найдены и включён `ASSUME_PASSPORT_WHEN_DOCUMENTS_EMPTY`, весь вход считается паспортом.

### 14.3. `detect_fields_for_spec()`

Использует `spec.field_detector.key`, фильтрует классы по `spec.field_names`, оставляет лучший field per class.

---

## 15. Orientation

Файл:

```text
recognizeuz/inference/orientation.py
```

Алгоритм:

1. пробует угол `0`;
2. если ориентация уверенная — берёт его;
3. иначе пробует `180`;
4. если всё ещё неуверенно — пробует `90` и `270`;
5. выбирает candidate с максимальным layout score.

Layout score и confidence check приходят из `DocumentSpec`:

```python
spec.score_layout(fields, image_shape)
spec.is_orientation_confident(fields, score, image_shape)
```

Для паспорта scoring находится в:

```text
recognizeuz/documents/passport/layout.py
```

Для миграционной карты:

```text
recognizeuz/documents/migration_card/layout.py
```

---

## 16. OCR preprocessing

Файл:

```text
recognizeuz/image/preprocessing.py
```

Главная функция:

```python
prepare_ocr_image_array(image_bgr) -> np.ndarray
```

Что делает:

1. BGR -> RGB -> PIL;
2. добавляет белый padding;
3. переводит в grayscale;
4. нормализует фон;
5. усиливает контраст;
6. resize до `OCR_TARGET_HEIGHT`;
7. ограничивает ширину `OCR_MIN_WIDTH..OCR_MAX_WIDTH`;
8. возвращает BGR image.

Используется и на основном OCR пути, и при подготовке glyph crops.

---

## 17. PaddleOCR wrapper

Файл:

```text
recognizeuz/ocr/paddle.py
```

### 17.1. `recognize_field_text()`

Стандартный OCR поля:

```python
text, score, timings, prepared_image = recognize_field_text(
    doc_type,
    field_name,
    field_crop_bgr,
)
```

Если поле marked as skip в spec, возвращает пустой результат.

### 17.2. `recognize_prepared_image_with_paddle()`

Распознаёт уже подготовленную картинку.

### 17.3. `recognize_prepared_images_with_paddle()`

Batch-variant для glyph/cell stages.

Это важно для производительности: распознавание 30 букв должно быть одним batch call, а не 30 отдельными вызовами.

---

## 18. GLM OCR wrapper

Файл:

```text
recognizeuz/ocr/glm.py
```

### 18.1. `call_glm_ocr_vllm()`

Основной wrapper под vLLM OpenAI-compatible API.

Использует payload:

```json
{
  "model": "zai-org/GLM-OCR",
  "temperature": 0,
  "max_tokens": 128,
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}},
        {"type": "text", "text": "..."}
      ]
    }
  ]
}
```

### 18.2. `glm_ocr_field()`

Распознаёт одно поле.

Для некоторых полей добавляются инструкции:

- `pas_number` — строго 2 Latin letters + 7 digits;
- date fields — вернуть дату;
- sex fields — вернуть только `M` или `F`.

### 18.3. `glm_ocr_document_json()`

Распознаёт весь документ и просит вернуть JSON с ключами из `DOC_OUTPUT_FIELDS`.

### 18.4. `glm_ocr_single_glyph()`

Распознаёт один символ. Используется как optional fallback в `migration_fio_grid_letters`.

По умолчанию glyph GLM fallback выключен, потому что это медленно.

---

## 19. Quality verification

Файл:

```text
recognizeuz/quality/verification.py
```

Это самый большой и самый domain-heavy модуль. Он отвечает за:

- нормализацию полей;
- schema validation;
- safe repair;
- TTA;
- GLM acceptance rules;
- проверку подозрительных повторов символов;
- dictionary token repair;
- nearest dictionary repair;
- обработку `pas_authority`;
- построение quality report.

Ключевые функции:

| Функция | Назначение |
|---|---|
| `validate_ocr_text_for_field()` | проверить текст по схеме поля |
| `build_ocr_quality_report()` | построить report для поля |
| `apply_quality_verification_to_item()` | применить verification к field item |
| `get_safe_repair_candidates_for_field()` | найти безопасные repair-кандидаты |
| `apply_glm_text_to_item()` | применить GLM текст к item |

Важное правило: verification не должен запускать тяжёлые модели без необходимости. Сначала дешёвые проверки, потом TTA/GLM только при flags.

---

## 20. Text normalization и transliteration

### 20.1. `text/normalization.py`

Используется для сравнения Paddle и GLM:

```python
normalize_ocr_text_for_match(text)
paddle_and_glm_texts_match(paddle, glm)
```

Сравнение не должно быть обычным `==`, потому что OCR может различаться пробелами, пунктуацией, регистром и разделителями.

### 20.2. `text/transliteration.py`

Используется паспортом для `text_cyrillic`.

Главная функция:

```python
transliterate_uz_latin_to_russian_migration_cyrillic(text, field_name=...)
```

Особенности:

- учитывает узбекскую латиницу;
- применяет словари традиционных русских форм;
- отдельно обрабатывает place/nationality;
- подходит под российскую миграционную запись.

---

## 21. Migration FIO grid stage

Файл:

```text
recognizeuz/pipeline/stages/migration_fio_grid.py
```

Stage key:

```text
migration_fio_grid_letters
```

Подключён в:

```text
recognizeuz/documents/migration_card/spec.py
```

Поля:

```python
FIO_FIELDS = {
    "mg_surname",
    "mg_surname_lat",
    "mg_name",
    "mg_patronymic",
}
```

### 21.1. Зачем нужен

Миграционная карта — белый лист A5. Фамилия, имя, отчество часто вписаны в клетки. Full-row OCR хуже, чем OCR каждой буквы отдельно.

Stage делает:

```text
field crop строки ФИО
  -> поиск вертикальных границ клеток
  -> crop каждой клетки / glyph
  -> OCR preprocess каждой клетки
  -> batch PaddleOCR
  -> normalize one glyph
  -> join letters
  -> replace/candidate/debug result
```

### 21.2. Алгоритм detect_grid_cells

1. field crop переводится в grayscale;
2. применяется GaussianBlur;
3. бинаризация Otsu + inverse;
4. морфология для поиска вертикальных линий;
5. строится projection по X;
6. находятся vertical boundaries;
7. если границы не найдены — fallback по contours;
8. между соседними boundaries режутся cells;
9. к каждой cell добавляется overlap;
10. каждая cell проходит `prepare_ocr_image_array()`.

### 21.3. Замена результата поля

Stage заменяет `item["final_text"]`, если:

```python
mode == "replace"
status == "ok"
text is not empty
avg_score >= MIGRATION_FIO_GRID_MIN_AVG_SCORE
```

Источник становится:

```text
migration_fio_grid_letters
```

### 21.4. Debug info

В debug поле содержит:

```json
{
  "intermediate": [
    {
      "stage": "migration_fio_grid_letters",
      "status": "ok",
      "mode": "replace",
      "replaced": true,
      "text": "ИВАНОВ",
      "avg_score": 0.91,
      "cells_count": 6,
      "used_glm_count": 0,
      "glyphs": []
    }
  ]
}
```

При `save_segments=true` сохраняются:

```text
migration_fio_grid.field_input
migration_fio_grid.glyph_raw_crop
migration_fio_grid.glyph_prepared_for_ocr
```

### 21.5. Когда включать GLM fallback по glyph

Включать только для диагностики или если Paddle плохо читает одиночные буквы:

```bash
MIGRATION_FIO_GRID_GLM_FALLBACK_ENABLED=1
```

Это может сильно замедлить запрос, потому что GLM будет вызываться для отдельных проблемных клеток.

---

## 22. Segment dump

Файл:

```text
recognizeuz/debug/segment_dump.py
```

Класс:

```python
SegmentDumpSession
```

Включается per request:

```http
?save_segments=true
```

или:

```http
?dump_segments=true
```

### 22.1. Где сохраняется

По умолчанию:

```text
/home/neuro/PycharmProjects/RecognizeUZ/debug/segment_dumps/<run_id>/
```

Настройка:

```bash
SEGMENT_DUMP_ROOT=/path/to/segment_dumps
```

### 22.2. Что лежит внутри

```text
<run_id>/
  manifest.json
  page/input/...
  document/warp_crop/...
  orientation/field_detector_input/...
  field/raw_crop/...
  field/prepared_for_paddle/...
  fallback/glm_field_input/...
  migration_fio_grid/glyph_prepared_for_ocr/...
```

У каждой картинки рядом есть `.json` metadata:

```json
{
  "index": 12,
  "stage": "field.prepared_for_paddle",
  "image_path": "...png",
  "shape": [48, 320, 3],
  "meta": {
    "doc_type": "migration_card",
    "field_name": "mg_name",
    "paddle_text": "ИВАН",
    "paddle_score": 0.94,
    "passed_to": ["paddle_recognizer"]
  }
}
```

### 22.3. Производительность

Когда `save_segments=false`, `SegmentDumpSession` почти бесплатен: методы сразу возвращают `None` после boolean check.

Не включать `save_segments=true` в постоянном production-трафике: будет много записи на диск.

---

## 23. Pipeline profiler

Файл:

```text
recognizeuz/core/profiling.py
```

Класс:

```python
PipelineProfiler
```

Использование:

```python
with profiler.stage("field.paddle_ocr", doc_type=ctx.doc_type, field_name=field_name):
    ...
```

Профиль включается, когда:

```python
debug or save_segments
```

В debug response доступны:

```json
{
  "pipeline_profile": [
    {
      "stage": "field.paddle_ocr",
      "seconds": 0.012,
      "meta": {
        "doc_type": "passport",
        "field_name": "pas_number"
      }
    }
  ],
  "pipeline_profile_totals": {
    "field.paddle_ocr": 0.147,
    "document.orientation": 0.294
  }
}
```

### 23.1. Как профилировать новый stage

Новый stage должен добавлять profiling так:

```python
with ctx.page.profiler.stage(
    "my_stage.name",
    doc_type=ctx.doc_type,
    field_name=field_name,
):
    result = run_model(...)
```

Не нужно вручную добавлять новый ключ в output. `PipelineProfiler` сам попадёт в debug.

---

## 24. Dataset collection

### 24.1. Low confidence agreement dataset

Файл:

```text
recognizeuz/dataset/low_conf_agreement.py
```

Сохраняет samples, когда:

- PaddleOCR score низкий;
- GLM OCR вернул такой же нормализованный текст;
- режим production fallback.

Цель: собрать реальные сложные примеры, где Paddle неуверен, но ответ подтверждён.

### 24.2. OCR improve dataset

Файл:

```text
recognizeuz/dataset/ocr_improve.py
```

Включается per request:

```http
?ocr_improve=true
```

Логика:

1. каждый OCR-сегмент читается PaddleOCR;
2. каждый OCR-сегмент читается GLM OCR;
3. если тексты отличаются и sample валиден, sample сохраняется;
4. сохраняется prepared original;
5. augmentations строятся только перед сохранением mismatch, чтобы не замедлять обычный путь.

Фильтры качества:

- confidence документа;
- confidence поля;
- уверенная ориентация;
- валидная геометрия поля;
- визуально полезная OCR картинка;
- ограничение длины label.

---

## 25. Как добавить новый тип документа

Допустим, нужно добавить `rus_passport`.

### Шаг 1. Создать папку

```text
recognizeuz/documents/rus_passport/
  __init__.py
  constants.py
  layout.py
  spec.py
```

### Шаг 2. Описать поля

```python
# constants.py
FIELD_NAMES = frozenset({
    "rus_series",
    "rus_number",
    "rus_surname",
})

OUTPUT_FIELDS = (
    "rus_series",
    "rus_number",
    "rus_surname",
)

INTERNAL_ONLY_FIELDS = frozenset()
SKIP_OCR_FIELDS = frozenset()
```

### Шаг 3. Описать layout scoring

```python
# layout.py
def score_rus_passport_layout(fields, image_shape) -> float:
    score = 0.0
    score += len(fields) * 0.5
    score += sum(float(f["confidence"]) for f in fields)
    return score


def is_rus_passport_orientation_confident(fields, score, image_shape) -> bool:
    names = {f["name"] for f in fields}
    return len(fields) >= 3 and "rus_number" in names and score >= 5
```

### Шаг 4. Создать spec

```python
# spec.py
from recognizeuz.documents.base import DocumentSpec, ModelRef

RUS_PASSPORT_SPEC = DocumentSpec(
    doc_type="rus_passport",
    field_names=FIELD_NAMES,
    output_fields=OUTPUT_FIELDS,
    field_detector=ModelRef("rus_passport_fields", "yolo"),
    text_recognizer=ModelRef("rus_passport_ocr", "paddle_recognizer"),
    score_layout=score_rus_passport_layout,
    is_orientation_confident=is_rus_passport_orientation_confident,
    skip_ocr_fields=SKIP_OCR_FIELDS,
    internal_only_fields=INTERNAL_ONLY_FIELDS,
)
```

### Шаг 5. Зарегистрировать spec

```python
# documents/registry.py
from recognizeuz.documents.rus_passport.spec import RUS_PASSPORT_SPEC

_DOCUMENT_SPECS = {
    ...,
    RUS_PASSPORT_SPEC.doc_type: RUS_PASSPORT_SPEC,
}
```

### Шаг 6. Добавить alias document detector

```python
# core/config.py
DOC_ALIASES = {
    ...,
    "rus_passport": "rus_passport",
    "my_yolo_class_name": "rus_passport",
}
```

### Шаг 7. Загрузить модели

```python
# core/resources.py
model_registry.yolo["rus_passport_fields"] = YOLO(str(RUS_PASSPORT_FIELDS_MODEL_PATH))
model_registry.recognizers["rus_passport_ocr"] = TextRecognizer(...)
```

---

## 26. Как добавить новый intermediate stage

Допустим, нужен stage `rus_passport_stamp_classifier`.

### Шаг 1. Описать stage в spec

```python
STAMP_STAGE = IntermediateStageSpec(
    key="rus_passport_stamp_classifier",
    model=ModelRef("rus_stamp_classifier", "custom"),
    applies_to_fields=frozenset({"rus_stamp"}),
    scope="field",
    mode="candidate",
    description="Classify stamp quality and value",
)
```

Добавить в `DocumentSpec`:

```python
intermediate_stages=(STAMP_STAGE,)
```

### Шаг 2. Создать обработчик

```text
recognizeuz/pipeline/stages/rus_passport_stamp.py
```

Пример контракта:

```python
def run_rus_passport_stamp_stage(*, ctx, field_name, field_crop_bgr, item, mode):
    result = {
        "stage": "rus_passport_stamp_classifier",
        "status": "ok",
        "mode": mode,
        "candidate": "...",
        "replaced": False,
    }

    if mode == "replace" and result_is_good:
        item["final_text"] = result["candidate"]
        item["source"] = "rus_passport_stamp_classifier"
        result["replaced"] = True

    item.setdefault("intermediate", []).append(result)
```

### Шаг 3. Добавить dispatch

```python
# pipeline/intermediate.py
if stage.key == "rus_passport_stamp_classifier":
    run_rus_passport_stamp_stage(...)
    return True
```

### Шаг 4. Добавить profiling и segment dump

Внутри stage:

```python
with ctx.page.profiler.stage("rus_passport_stamp.classifier", doc_type=ctx.doc_type):
    ...

ctx.page.segment_dump.save_image(
    stage="rus_passport_stamp.input",
    image_bgr=field_crop_bgr,
    meta={"field_name": field_name, "passed_to": ["stamp_classifier"]},
)
```

---

## 27. Как менять порядок pipeline

Порядок сейчас:

```text
field crop
  -> Paddle OCR
  -> intermediate stages
  -> fallbacks/quality/datasets
```

Это значит, что intermediate stage видит:

- original field crop;
- prepared Paddle crop;
- Paddle text/score;
- field metadata;
- document context.

Если нужен stage **до PaddleOCR**, есть два варианта:

1. сделать его частью `recognize_single_field()` до вызова `recognize_field_text()`;
2. расширить `IntermediateStageSpec.scope`, например `pre_ocr_field`.

Рекомендуемый путь: не смешивать pre-OCR и post-OCR stages в одном dispatcher. Лучше добавить отдельный dispatcher:

```text
pipeline/pre_ocr_intermediate.py
pipeline/post_ocr_intermediate.py
```

Пока такой необходимости нет, текущий stage для migration FIO работает после row PaddleOCR и может заменить результат.

---

## 28. Правила работы с debug и production

### 28.1. Production не должен платить за debug

Нельзя делать тяжёлую подготовку изображений только ради debug, если `debug=false` и `save_segments=false`.

Правильно:

```python
ctx.page.segment_dump.save_image(...)
```

Этот вызов дешёвый, когда dump выключен.

Неправильно:

```python
image = expensive_debug_visualization()
ctx.page.segment_dump.save_image(image)
```

Если визуализация дорогая, её нужно оборачивать:

```python
if ctx.page.segment_dump.enabled:
    image = expensive_debug_visualization()
    ctx.page.segment_dump.save_image(...)
```

### 28.2. Все новые stages должны быть выключаемыми

Любой stage, который меняет результат, должен иметь mode:

```text
disabled/debug_only/candidate/replace
```

Это позволяет быстро вернуть старое поведение через env.

### 28.3. Любой replace должен оставлять след в debug

Если stage меняет `final_text`, в `item["intermediate"]` должно быть:

```json
{
  "stage": "...",
  "replaced": true,
  "text": "...",
  "avg_score": 0.91
}
```

---

## 29. Производительность

### 29.1. Глобальный infer_lock

Сейчас весь pipeline внутри:

```python
with resources.infer_lock:
    ...
```

Причина: YOLO/PaddleOCR/GPU inference может быть не потокобезопасным или может деградировать при параллельных обращениях.

Если понадобится увеличить throughput, варианты:

1. несколько worker-процессов с отдельными GPU/моделями;
2. очередь задач;
3. разделить lock по моделям;
4. batch processing для однотипных этапов.

### 29.2. GLM OCR дорогой

GLM вызывается только:

- на весь документ при плохом среднем Paddle score;
- по отдельным полям ниже threshold;
- по quality flags;
- в `ocr_improve=true`;
- по glyph fallback, если явно включён.

Не включать glyph GLM fallback на постоянном трафике без измерений.

### 29.3. Segment dump дорогой по диску

`save_segments=true` пишет много PNG и JSON. Использовать для диагностики, не для обычного production.

### 29.4. Migration FIO grid использует batch PaddleOCR

Это важно. Не переписывать на вызов PaddleOCR по одной букве.

Правильно:

```python
recognize_prepared_images_with_paddle(doc_type, prepared_images)
```

---

## 30. Запуск проекта

### 30.1. Минимальный запуск

```bash
cd /path/to/recognizeuz_refactor_v3
uvicorn app:app --host 0.0.0.0 --port 8000 --workers 1
```

Или:

```bash
python -m recognizeuz.main
```

### 30.2. Проверка health

```bash
curl http://127.0.0.1:8000/health
```

### 30.3. Debug-запрос

```bash
curl -X POST \
  'http://127.0.0.1:8000/recognize?debug=true' \
  -F 'files=@document.jpg'
```

### 30.4. Debug с сохранением crop’ов

```bash
curl -X POST \
  'http://127.0.0.1:8000/recognize?debug=true&save_segments=true' \
  -F 'files=@document.jpg'
```

### 30.5. OCR improve mode

```bash
curl -X POST \
  'http://127.0.0.1:8000/recognize?ocr_improve=true&debug=true' \
  -F 'files=@document.jpg'
```

---

## 31. Проверки перед деплоем

### 31.1. Синтаксис

```bash
python3 -m compileall -q .
```

### 31.2. Импорт приложения

```bash
python3 - <<'PY'
from recognizeuz.main import app
print(app.title)
PY
```

На машине без моделей импорт может упасть при lifespan startup, если реально запускать сервер. Для unit-проверок можно использовать stubs/mocks.

### 31.3. Проверка registry

```bash
python3 - <<'PY'
from recognizeuz.documents.registry import get_document_spec
for doc_type in ["passport", "migration_card"]:
    spec = get_document_spec(doc_type)
    print(doc_type, spec.field_detector.key, spec.text_recognizer.key)
PY
```

### 31.4. Проверка stage миграционной карты

```bash
python3 - <<'PY'
from recognizeuz.documents.registry import get_document_spec
spec = get_document_spec("migration_card")
print([s.key + ':' + s.mode for s in spec.intermediate_stages])
PY
```

Ожидаемо:

```text
migration_fio_grid_letters:replace
```

---

## 32. Рекомендации по тестам

Сейчас в архиве нет полноценного test suite. Рекомендуется добавить:

```text
tests/
  test_document_registry.py
  test_output_format.py
  test_text_normalization.py
  test_transliteration.py
  test_quality_verification.py
  test_migration_fio_grid.py
  test_segment_dump.py
  test_pipeline_with_mocks.py
```

### 32.1. Что тестировать обязательно

1. `DocumentSpec` всех документов регистрируется.
2. Все `output_fields` входят в `field_names`.
3. `skip_ocr_fields` входят в `field_names`.
4. `internal_only_fields` входят в `field_names`.
5. `MIGRATION_FIO_GRID_STAGE_MODE=disabled` отключает stage.
6. `detect_grid_cells()` режет synthetic grid на ожидаемое число клеток.
7. `normalize_glyph_text()` корректно мапит lookalikes.
8. `build_output_document()` не отдаёт internal fields в production.
9. `save_segments=false` не создаёт файлов.
10. `save_segments=true` создаёт `manifest.json`.

### 32.2. Pipeline mock test

Для pipeline лучше использовать fake models:

- fake document detector;
- fake field detector;
- fake Paddle recognizer;
- fake GLM client.

Не нужно в unit-тестах грузить реальные YOLO/Paddle модели.

---

## 33. Типовые проблемы и диагностика

### 33.1. `/health` показывает модель `false`

Проверить:

- путь к весам;
- доступность файлов;
- права на чтение;
- корректность `PADDLEOCR_ROOT`;
- доступность GPU;
- ошибки startup logs.

### 33.2. Документ не возвращается

Возможные причины:

- document detector не нашёл документ;
- `ASSUME_PASSPORT_WHEN_DOCUMENTS_EMPTY=0` и вход был crop паспорта;
- doc type не входит в `ALLOWED_DOC_TYPES`;
- нет spec в registry;
- orientation неуверенная.

Диагностика:

```http
POST /recognize?debug=true&save_segments=true
```

Смотреть:

- `page.document_detector_output`;
- `orientation.field_detector_output`;
- `debug.orientation.confident`;
- `debug.detected_fields_count`.

### 33.3. Поле вырезается неправильно

Включить:

```http
?save_segments=true
```

Смотреть:

- `field.raw_crop`;
- polygon/bbox в `.json`;
- `field.prepared_for_paddle`.

Если `field.raw_crop` плохой — проблема в YOLO field detector или polygon crop.

Если `field.raw_crop` хороший, но `field.prepared_for_paddle` плохой — проблема в OCR preprocessing.

Если prepared хороший, но OCR ошибся — проблема в recognizer/fallback/quality.

### 33.4. Migration FIO grid неправильно склеивает ФИО

Смотреть:

```text
migration_fio_grid.field_input
migration_fio_grid.glyph_raw_crop
migration_fio_grid.glyph_prepared_for_ocr
```

И debug:

```json
fields.mg_name.debug.intermediate[0]
```

Проверить:

- `cells_count`;
- `glyphs[].paddle_text`;
- `glyphs[].text`;
- `avg_score`;
- `status`.

Настройки для эксперимента:

```bash
MIGRATION_FIO_GRID_STAGE_MODE=candidate
MIGRATION_FIO_GRID_CELL_OVERLAP_RATIO=0.15
MIGRATION_FIO_GRID_ERASE_LINES=1
MIGRATION_FIO_GRID_MIN_AVG_SCORE=0.35
```

### 33.5. GLM fallback слишком медленный

Проверить:

- `fallback_mode`;
- `pipeline_profile_totals`;
- `glm_ocr_seconds` по полям;
- не включён ли `MIGRATION_FIO_GRID_GLM_FALLBACK_ENABLED=1`.

---

## 34. Правила изменения кода

### 34.1. Не добавлять doc-specific if в общий pipeline

Плохо:

```python
if ctx.doc_type == "migration_card":
    ...
```

Допустимо только в stage dispatcher, когда stage явно зарегистрирован:

```python
if stage.key == "migration_fio_grid_letters":
    run_migration_fio_grid_stage(...)
```

Лучше:

```python
spec.intermediate_stages
spec.score_layout
spec.is_orientation_confident
```

### 34.2. Не импортировать модели напрямую

Плохо:

```python
from recognizeuz.core.resources import migration_fields_model
```

Лучше:

```python
resources.model_registry.get_yolo(spec.field_detector.key)
```

### 34.3. Не менять response format без причины

Production consumers могут зависеть от:

```json
{
  "type": "...",
  "fields": {
    "field_name": {
      "text": "...",
      "confidence": 0.99
    }
  }
}
```

Новые debug данные добавлять внутрь `debug`, а не в корень production response.

### 34.4. Heavy debug только под flags

Все тяжёлые дампы, визуализации, дополнительные OCR должны включаться через:

```text
debug
save_segments
ocr_improve
stage mode
```

### 34.5. Любой новый stage должен иметь rollback switch

Минимум:

```bash
MY_STAGE_MODE=disabled
```

---

## 35. Рекомендуемые будущие улучшения

### 35.1. Перевести config на Pydantic Settings

Сейчас часть путей захардкожена. Лучше сделать:

```python
class Settings(BaseSettings):
    project_root: Path
    doc_model_path: Path
    ...
```

И создать единый объект settings.

### 35.2. Разделить `quality/verification.py`

Сейчас это самый большой модуль. Его стоит разнести:

```text
quality/
  schemas.py
  repair.py
  tta.py
  glm_acceptance.py
  dictionaries.py
  report.py
```

Но делать это лучше отдельным refactor-коммитом с тестами.

### 35.3. Добавить полноценный test suite

Особенно для:

- quality repair;
- migration FIO grid;
- output format;
- DocumentSpec registry.

### 35.4. Добавить structured logging

Сейчас есть debug response и segment dump, но production logs лучше привести к JSON:

```json
{
  "event": "ocr_document_processed",
  "doc_type": "passport",
  "seconds": 0.431,
  "fallback_mode": "none"
}
```

### 35.5. Перейти к stage registry

Сейчас stage dispatch сделан через `if stage.key == ...`.

При росте количества stages лучше сделать registry:

```python
STAGE_HANDLERS = {
    "migration_fio_grid_letters": run_migration_fio_grid_stage,
}
```

Это упростит добавление новых этапов.

---

## 36. Краткая карта: куда идти за изменением

| Нужно изменить | Файл |
|---|---|
| Добавить/изменить endpoint | `api/routes.py`, `api/schemas.py` |
| Изменить пути/threshold/env | `core/config.py` |
| Добавить модель | `core/resources.py`, `core/config.py` |
| Добавить документ | `documents/<doc>/`, `documents/registry.py`, `core/config.py` |
| Изменить поля паспорта | `documents/passport/constants.py` |
| Изменить поля миграционной карты | `documents/migration_card/constants.py` |
| Изменить ориентацию паспорта | `documents/passport/layout.py` |
| Изменить ориентацию миграционной карты | `documents/migration_card/layout.py` |
| Изменить PaddleOCR поведение | `ocr/paddle.py` |
| Изменить GLM prompts | `ocr/glm.py` |
| Изменить preprocessing | `image/preprocessing.py` |
| Изменить crop geometry | `image/geometry.py` |
| Добавить промежуточный stage | `documents/<doc>/spec.py`, `pipeline/intermediate.py`, `pipeline/stages/*.py` |
| Debug dump | `debug/segment_dump.py` |
| Профилирование | `core/profiling.py` |
| Production response | `pipeline/output.py` |
| Fallback логика | `pipeline/fallbacks.py` |
| OCR improve dataset | `dataset/ocr_improve.py` |
| Low-conf dataset | `dataset/low_conf_agreement.py` |
| Validation/repair/TTA | `quality/verification.py` |

---

## 37. Мини-чеклист перед merge

Перед merge любого изменения:

```bash
python3 -m compileall -q .
```

Затем проверить минимум:

1. `/health` возвращает все модели;
2. паспорт распознаётся без `debug`;
3. паспорт распознаётся с `debug=true`;
4. миграционная карта распознаётся без `debug`;
5. миграционная карта распознаётся с `MIGRATION_FIO_GRID_STAGE_MODE=disabled`;
6. миграционная карта распознаётся с `MIGRATION_FIO_GRID_STAGE_MODE=replace`;
7. `save_segments=true` создаёт `manifest.json`;
8. `ocr_improve=true` не ломает production path;
9. response format не изменился неожиданно;
10. GLM fallback не вызывается там, где не должен.

---

## 38. Главная идея проекта для будущих разработчиков

Этот проект нельзя развивать как один procedural script. Он должен оставаться системой из трёх уровней:

```text
API layer
  принимает запросы и отдаёт JSON

Generic pipeline layer
  выполняет page/document/field/fallback/output stages

Document-specific layer
  описывает поля, модели, layout, stages и правила конкретного документа
```

Если новая логика относится к конкретному документу — она должна попасть в `documents/<doc>` или `pipeline/stages`, а не в общий pipeline.

Если новая логика относится к инфраструктуре OCR — она должна попасть в `ocr`, `inference`, `image`, `quality` или `dataset`.

Если новая логика нужна только для диагностики — она должна быть включаемой через `debug`, `save_segments` или stage mode.
