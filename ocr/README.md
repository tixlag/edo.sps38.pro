# Распознавание паспортов РФ, Узбекистана и миграционных карт

Компонент `ocr/` репозитория ЭДО: два независимых API и два окружения Python. Все команды ниже выполняются из `ocr/`. Объединение API запланировано отдельно: существующие интеграции продолжают использовать прежние адреса.

Это единственный поддерживаемый источник и место запуска OCR. Прежние отдельные `RecognizeUZ`, `DocRecognizer` и промежуточный `monorepo-export` объявлены **legacy**. Их службы должны быть выключены; все изменения и запуск выполняются из этого монорепозитория. Постоянные службы и переключение описаны в [эксплуатации](docs/operations.md).

На рабочий компьютер компонент разворачивается автоматически после успешных проверок при push в защищённую `main`, если изменён `ocr/`. Runner `deploy-ocr-pc` переключает управляемый runtime `/home/neuro/.local/share/edo-ocr/current` с проверкой реального распознавания и откатом. [CI/CD и настройки хоста](docs/ci-cd.md).

| Сервис | Порт | Маршруты |
|---|---|---|
| UZ + миграционная карта | 8000 | `POST /recognize`, `POST /recognize-base64`, `GET /health` |
| РФ | 8001 | `POST /parse`, `POST /parse-id-birthday` |
| Общий GLM OCR | 8083 | `POST /v1/chat/completions` |

API слушают `0.0.0.0`; оба сервиса обращаются к GLM через `http://127.0.0.1:8083/v1/chat/completions`. Внешний прокси и работающие службы автоматически не меняются.

## Установка

Нужны Linux x86_64, Python 3.12 с `venv`, Git, NVIDIA GPU/драйвер. Точная конфигурация и особенности зависимостей описаны в [установке](docs/installation.md).

```bash
bash scripts/setup_service.sh uz
bash scripts/setup_service.sh ru
```

Среды создаются в `services/uz/.venv` и `services/ru/.venv`. Для UZ устанавливается закреплённый checkout PaddleOCR с локальным патчем. Исходники и модели не должны зависеть от других проектов на машине.

## Установка моделей

Веса в Git отсутствуют, Git LFS не используется. Получите отдельно `recognizeuz-models-2026-10-20.tar.gz` и установите его:

```bash
python3 scripts/models.py install /path/to/recognizeuz-models-2026-10-20.tar.gz
python3 scripts/models.py verify
```

Манифест `models/manifest.json` фиксирует состав, размеры и SHA-256. Архив содержит только рабочие модели и их конфигурации/словари. GLM устанавливается отдельно; обучение моделей для запуска не требуется. Подробнее: [модели](models/README.md).

## Запуск

Запускайте из каталога `ocr/`, каждый сервис в отдельном терминале:

```bash
bash scripts/run_service.sh uz
bash scripts/run_service.sh ru
```

Необязательные настройки: скопируйте `services/uz/.env.example` или `services/ru/.env.example` в `.env` рядом с ним. Формат совместим с shell; пути со пробелами заключайте в кавычки. Примеры по умолчанию не требуют редактирования. `MODELS_ROOT` позволяет вынести модели из репозитория.

GLM: [конфигурация Docker](deploy/glm/README.md). Шаблоны systemd находятся в `deploy/systemd`; установку и переключение существующих служб выполняют отдельно.

## Запросы

```bash
curl http://127.0.0.1:8000/health
curl -F 'files=@/path/to/uz-passport.jpg' http://127.0.0.1:8000/recognize
curl -F 'files=@/path/to/migration-card.jpg' http://127.0.0.1:8000/recognize
curl -F 'files=@/path/to/ru-passport.jpg' 'http://127.0.0.1:8001/parse?doc_type=passport_ru'
```

Оба сервиса принимают изображения и PDF, а также несколько полей `files` за запрос. UZ автоматически выбирает тип документа. Для base64 UZ:

```json
{"files":[{"filename":"document.jpg","content_base64":"BASE64"}],"debug":false}
```

Отправьте этот JSON на `POST :8000/recognize-base64`. Описание параметров доступно на `/docs` соответствующего сервиса. Форматы ответов сервисов различаются и сохраняются. Особенности: [контракты](docs/api-compatibility.md).

## Проверки и работа агента

```bash
python3.12 -m venv .venv-test
.venv-test/bin/python -m pip install -r requirements-test.txt
.venv-test/bin/python -m unittest discover -s tests -v
```

Задание `ocr-validate` проверяет контракты, установщик и безопасное переключение без моделей/GPU. Затем `ocr-deploy-pc` проверяет модели и реальное распознавание на частных локальных документах. Оба задания подключаются внешним `edo.yml@webdevs/ci-templates`. [Проверки](docs/verification.md). Перед изменениями прочитайте [AGENTS.md](AGENTS.md).

Каталоги `services` — рабочий код, `research` — обучение и подготовка данных, `archive` — прежние реализации. Исходные коммиты записаны в `docs/provenance.json`. Старые Git-истории не импортировались. В [бэклоге](docs/backlog.md) перечислены следующие шаги.

Подключение к ЭДО: [граница и передача](../docs/integrations/document-ocr-sources.md).
Включение адаптера ЭДО выполняется отдельно после успешного runner и подтверждения пользователя; по умолчанию `OCR_MODE=disabled`. Ответы дополнены `ocr_fields` с источником результата и исходными Paddle-текстом/confidence без включения debug.
