# Общий GLM OCR

Оба Python-сервиса обращаются к GLM по `http://127.0.0.1:8083/v1/chat/completions`. Контейнер управляется только этим Compose-файлом, проект `edo-ocr`, имя контейнера `glm-ocr-vllm`. Старый Compose из RecognizeUZ имеет статус legacy и больше не запускается.

На отдельной машине с Docker Compose и NVIDIA Container Toolkit:

```bash
cd deploy/glm
docker compose up -d --build
curl http://127.0.0.1:8083/v1/models
```

Сохранены модель `zai-org/GLM-OCR`, порт `8083`, `bfloat16`, доля памяти `0.5`, длина контекста `4096`, `max-num-seqs=4`, speculative MTP. Digest базового образа и commit Transformers сняты с работающего контейнера, чтобы сборка не зависела от следующего `nightly`.

При первом переключении на этой машине использован проверенный локальный образ прежнего контейнера, помеченный `document-ocr-glm:local`, без обновления библиотек. После остановки прежнего контейнера запуск: `docker compose up -d --no-build`. На новой машине используйте сборку выше.

Нужен интернет при первой загрузке модели. Hugging Face cache подключается из `~/.cache/huggingface`. Веса GLM не находятся ни в Git, ни в архиве локальных YOLO/Paddle моделей. Python API продолжают работать на хосте, поэтому loopback URL не меняется. Compose не разворачивает существующий внешний прокси.

При CI/CD конфигурация разворачивается в постоянный каталог по хешу содержимого, а GLM_OCR_IMAGE задаётся из release.json. Не запускайте Compose из checkout разработчика поверх такого контейнера; обновление выполняет `scripts/deploy_pc.py`.
