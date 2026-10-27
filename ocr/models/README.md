# Рабочие модели

`manifest.json` — единственный отслеживаемый список файлов. Веса, словари и экспортированные конфигурации устанавливаются из частного архива. Ни Git LFS, ни публичная ссылка на веса не используются.

```bash
python3 scripts/models.py install /path/to/recognizeuz-models-2026-10-20.tar.gz
python3 scripts/models.py verify
# Другой каталог:
python3 scripts/models.py install /path/to/archive.tar.gz --models-dir /srv/ocr-models
python3 scripts/models.py verify --models-dir /srv/ocr-models
```

При внешнем каталоге задайте одинаковый `MODELS_ROOT=/srv/ocr-models` для обоих сервисов. Архив содержит 16 файлов: UZ document detector, два field detector, два OCR export со словарями; РФ field detector, multiline detector и OCR export. Для UZ сохраняются именно словари из действующей конфигурации, а не произвольный словарь рядом с другим экспериментом.

Установщик сверяет список, размер и SHA-256 всех файлов до замены; посторонние файлы, повторы, ссылки и выход за каталог отклоняются. Частный архив не зашифрован: передавайте его через доступное только получателю хранилище. Контрольная сумма подтверждает соответствие репозиторию, но не управляет доступом.

Для повторной упаковки установленного комплекта:

```bash
python3 scripts/models.py pack /private/location/models.tar.gz
```

GLM-OCR в архив не входит. Конфигурация его отдельного сервиса — `deploy/glm`.
