# Общий GLM OCR

Оба Python-сервиса обращаются к GLM по `http://127.0.0.1:8083/v1/chat/completions`. Если сервис уже работает, повторно запускать контейнер не нужно.

На отдельной машине с Docker Compose и NVIDIA Container Toolkit:

```bash
cd deploy/glm
docker compose up -d --build
curl http://127.0.0.1:8083/v1/models
```

Сохранены модель `zai-org/GLM-OCR`, порт `8083`, `bfloat16`, доля памяти `0.5`, длина контекста `4096`, `max-num-seqs=4`, speculative MTP. Digest базового образа и commit Transformers сняты с работающего контейнера, чтобы сборка не зависела от следующего `nightly`.

Нужен интернет при первой загрузке модели. Hugging Face cache подключается из `~/.cache/huggingface`. Веса GLM не находятся ни в Git, ни в архиве локальных YOLO/Paddle моделей. Python API продолжают работать на хосте, поэтому loopback URL не меняется. Compose не разворачивает существующий внешний прокси.
