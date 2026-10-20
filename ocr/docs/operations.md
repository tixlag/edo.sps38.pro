# Эксплуатация OCR из монорепозитория

Единственный поддерживаемый источник — `ocr/` в `webdevs/edo.sps38.pro`. Отдельные RecognizeUZ, DocRecognizer, их старый Docker Compose и промежуточный monorepo-export объявлены **legacy**. Не запускайте их и не вносите туда исправления. Все рабочие изменения делаются в монорепозитории.

## Размещение на текущей машине

Корень компонента: `/home/neuro/PycharmProjects/RecognizeUZ/edo-integration/ocr`. Несмотря на имя родительского каталога, это отдельный checkout репозитория ЭДО; исходники прежнего проекта рядом не используются как runtime-зависимости.

| Компонент | Управление | Адрес |
|---|---|---|
| Паспорт UZ и миграционная карта | `recognize-uz.service` | `0.0.0.0:8000` |
| Паспорт РФ | `recognize-ru.service` | `0.0.0.0:8001` |
| Общий GLM | Compose `edo-ocr`, контейнер `glm-ocr-vllm` | `0.0.0.0:8083` |

Обе systemd-службы работают от `neuro`, используют `scripts/run_service.sh` из компонента, собственные `services/{uz,ru}/.venv`, модели `models/` и записываемые каталоги `var/`. UZ использует закреплённый `vendor/PaddleOCR` внутри компонента. Ни одна из этих зависимостей не является ссылкой в старый проект.

`doc-recognizer.service` — прежняя служба РФ: остановлена, отключена и замаскирована (`masked`), чтобы её нельзя было случайно запустить. Не включайте её снова. Остановленный резервный контейнер GLM с префиксом `legacy-glm-ocr-vllm-` сохраняется только для отката, с `restart=no`. Активный контейнер управляется `deploy/glm/compose.yaml` монорепозитория; restart policy — `always`.

## Проверка и перезапуск

Из `ocr/`:

```bash
systemctl status recognize-uz.service recognize-ru.service --no-pager
systemctl is-enabled recognize-uz.service recognize-ru.service
systemctl is-active doc-recognizer.service # ожидается inactive
systemctl is-enabled doc-recognizer.service # ожидается masked
docker compose -f deploy/glm/compose.yaml ps
curl --fail http://127.0.0.1:8000/health
curl --fail http://127.0.0.1:8001/openapi.json > /dev/null
curl --fail http://127.0.0.1:8083/v1/models
```

Перезапуск после проверенных изменений:

```bash
sudo systemctl restart recognize-uz.service recognize-ru.service
docker compose -f deploy/glm/compose.yaml up -d --no-build
```

Реальный inference проверяйте отдельно на частных документах, без вывода персональных данных в общие журналы. Результаты сохраняйте только в игнорируемом `var/verification`. Проверка HTTP сама по себе не доказывает качество распознавания.

## Новая машина и переключение

1. Клонируйте монорепозиторий, установите модели, оба Python-окружения и закреплённый PaddleOCR по README и `installation.md`. Не используйте старые проекты как источники импортов.
2. Поднимите GLM из `deploy/glm/compose.yaml`. На новой машине требуется `docker compose up -d --build` из `deploy/glm`; проверенный локальный образ `document-ocr-glm:local` можно повторно использовать с `--no-build`. Не запускайте второй GLM на том же GPU/порту.
3. Проверьте оба API на временных портах `18000`/`18001`, включая реальные документы и GLM fallback. Остановите временные процессы после проверки.
4. В шаблонах `deploy/systemd/recognize-{uz,ru}.service` замените `/opt/edo.sps38.pro/ocr`, `User` и `Group` на фактические. Сохраните резервные копии действующих unit-файлов и конфигурации GLM в частном месте.
5. Остановите и отключите `doc-recognizer.service` и другие прежние OCR-службы. После сохранения резервной копии замаскируйте старую службу (`sudo systemctl mask doc-recognizer.service`). Старому GLM отключите restart policy, остановите его и освободите имя контейнера перед запуском нового Compose. Не удаляйте модельный cache.
6. Установите подготовленные unit-файлы в `/etc/systemd/system/`, выполните `sudo systemctl daemon-reload` и `sudo systemctl enable --now recognize-uz.service recognize-ru.service`.
7. Проверьте прежние порты, реальные документы и пути работающих процессов. Доступ из локальной сети проверяется с другой машины по её сетевому маршруту; на текущем хосте адрес `10.10.5.184`. При активном firewall разрешайте API для нужной локальной подсети согласно её правилам.

Переключение касается только локальных Python-служб и GLM. Оно не разворачивает Node-приложение ЭДО и не включает его `OcrService` adapter/worker. Внешний CI ЭДО остаётся отдельным и не используется для этого переключения.
