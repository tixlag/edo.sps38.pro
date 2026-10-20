# Установка и окружения

## Требования

Linux x86_64, Python 3.12, `python3.12-venv`, Git, NVIDIA GPU. На исходной машине: RTX 3060 12 ГБ, драйвер 580.178.04. Оба API и GLM используют видеопамять; первый реальный запрос РФ лениво загружает модели. Для PDF в РФ используется PyMuPDF, резервный путь `pdf2image` требует системный `poppler-utils`. OpenCV wheel может требовать `libgl1`/`libglib2.0-0`.

Две отдельные среды обязательны. UZ использует Paddle GPU 3.3.0, PaddleOCR 3.5.0, Torch 2.12.0; РФ — Paddle GPU 3.2.2, PaddleOCR 3.3.2, Torch 2.9.1. Не обновляйте эти версии при переносе.

## Как устанавливаются зависимости

```bash
bash scripts/setup_service.sh uz
bash scripts/setup_service.sh ru
```

`requirements.txt` перечисляет прямые зависимости, `requirements.lock` — точный снимок окружения для повторения рабочего runtime. Установка выполняется с `--no-deps`: исходные Torch/Paddle имеют конфликтующие требования к версиям CUDA-пакетов, хотя текущая комбинация выполняет inference. Обычный resolver не способен восстановить эту историческую комбинацию. Автоматическое обновление транзитивных библиотек изменило бы рабочую конфигурацию. Ненужный CPU-вариант `paddlepaddle` исключён, GPU-вариант сохранён.

Это осознанное ограничение переноса, а не утверждение об отсутствии конфликтов. `pip check` сообщает известные CUDA-конфликты; их нужно устранять отдельной задачей с проверкой качества и производительности. Исходные инвентаризации сохранены в `docs/environments`. Архивные исследовательские пакеты пока остаются в снимках, поскольку их удаление требует отдельной проверки цепочки импортов.

GPU Paddle берётся по прямому URL из официального хранилища; версия и CUDA build зафиксированы в установщике. Индексы: [CUDA 13.0](https://www.paddlepaddle.org.cn/packages/stable/cu130/paddlepaddle-gpu/), [CUDA 12.9](https://www.paddlepaddle.org.cn/packages/stable/cu129/paddlepaddle-gpu/). Для установки нужен доступ к PyPI и Paddle CDN. Команда прерывается при ошибке загрузки; не заменяйте GPU wheel случайной версией из PyPI.

Для установки Python-пакетов из доверенного локального wheelhouse без обращения к PyPI/Paddle CDN:

```bash
WHEELHOUSE=/private/wheels bash scripts/setup_service.sh uz
WHEELHOUSE=/private/wheels bash scripts/setup_service.sh ru
```

Wheelhouse должен содержать точные версии из снимка и правильные CUDA builds Paddle. Он не входит в Git и не является архивом моделей. Для UZ отдельно требуется закреплённый checkout `vendor/PaddleOCR`: при его отсутствии установщик обращается к GitHub даже с `WHEELHOUSE`. Для полностью автономной установки заранее перенесите этот checkout с закреплённым коммитом; локальный патч проверит/применит `scripts/setup_paddleocr.py`.

## Внешний PaddleOCR для UZ

`setup_service.sh uz` вызывает `scripts/setup_paddleocr.py`: клонирует `vendor/PaddleOCR`, фиксирует commit `0141f249fd0ea7609c16f1f4f851f0fa18125f06`, применяет `patches/paddleocr-use-gcu.patch`. Повторный запуск допустим; неожиданные локальные изменения не перезаписываются. Это отдельный checkout для импорта `tools.infer.predict_rec.TextRecognizer`, пакет `paddleocr` его не заменяет.

`vendor` игнорируется Git. Не используйте прежний checkout из соседнего проекта как обязательную зависимость нового сервиса.

## Настройки путей

Обычно достаточно установки архива в `models`. Для внешнего размещения задайте абсолютный `MODELS_ROOT`. UZ также поддерживает `DOC_MODEL_PATH`, `PASSPORT_FIELDS_MODEL_PATH`, `MIGRATION_FIELDS_MODEL_PATH`, `PASSPORT_OCR_MODEL_DIR`, `MIGRATION_OCR_MODEL_DIR`, `PASSPORT_DICT_PATH`, `MIGRATION_DICT_PATH`, `PADDLEOCR_ROOT`.

РФ: `RU_DOC_MODEL_PATH`, `RU_MULTILINE_MODEL_PATH`, `RU_OCR_MODEL_DIR`, `RU_LOG_DIR`, `RU_DEBUG_DIR`. Записываемые данные по умолчанию находятся в `var/ru` и `var/uz`. Launcher проверяет весь манифест моделей; если используются индивидуальные override-пути, дополнительно сохраняйте установленный комплект или проверяйте конфигурацию и запускайте uvicorn вручную.

`.env` лежит рядом с сервисом и не попадает в Git. Launcher загружает его как shell-файл; используйте только собственную конфигурацию. РФ при прямом запуске также читает свой `.env`, UZ при прямом запуске использует уже экспортированные переменные окружения.

## Диагностика

- `Missing:` / `Checksum/size mismatch:` — повторно установите правильный архив через `scripts/models.py`.
- Нет `tools.infer` — выполните `python3 scripts/setup_paddleocr.py`.
- Порт занят — не останавливайте чужой процесс; для проверки передайте launcher `--host 127.0.0.1 --port 18000` или `18001`.
- Ошибки CUDA/памяти — проверьте `nvidia-smi`, версии из снимка, объём памяти и параллельно запущенные сервисы. Не включайте несколько workers с GPU-моделями.
- Ошибка fallback GLM — проверьте `curl http://127.0.0.1:8083/v1/models` и `GLM_OCR_URL`.

Фактически выполненные проверки и ограничения записаны в `docs/verification.md`.
