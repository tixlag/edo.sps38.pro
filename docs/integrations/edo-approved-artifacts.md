# Утверждённые артефакты и бинарная доставка в 1С

Дата реализации и измерений: 2026-10-23. База — GitLab main
`9865a8990dcb4b9cac14d8088dc544cf004b4854`, содержащая действующий review,
OCR и диагностику доставки из `fix/erp-delivery-responses` (`ae63073`).
GitHub origin/main (`8ea1e18`) отстаёт; по уточнению владельца feature-ветка
создана от GitLab main. Незавершённая переписка из отдельной
`feat/candidate-chat-workspace` не переносилась и не выпускалась.

## Хранение, метаданные и очистка

В новой версии EDO по указанию владельца **multipart-v2 является значением по
умолчанию для новых подтверждений**. Это не переключение уже созданных доставок.
Для начального безопасного развёртывания с v1 нужно явно установить
`ERP_DOCUMENTS_TRANSPORT=base64-v1` до запуска нового API.

Однофайловый v2 использует серверную S3 CopyObject в новый случайный
`documents/<documentId>/v<version>/approved-<uuid>.<ext>`. Это намеренная
дополнительная копия: нельзя переиспользовать ключ оригинала, пока существующая
очистка возвращённых/незавершённых версий владеет `DocumentVersionFile`.
Копия побайтовая, без загрузки исходника в память или изменения EXIF. После
копирования destination читается потоком, проверяются размер и SHA-256
относительно исходных метаданных. Если у старого оригинала SHA отсутствует,
хеш вычисляется по фактическим скопированным байтам. ETag не считается хешем.

Несколько файлов или любая подготовка для v1 создают PDF. JPEG — embedJpg,
исходный DCT-поток; для несовместимого с pdf-lib варианта JPEG предусмотрен
lossless PNG fallback без ресайза; PNG — embedPng с прозрачностью; WebP — PNG без дополнительной
потери качества; PDF — copyPages, все страницы и их повороты. EXIF 1–8 у
изображений учитывается матрицей страницы, включая отражения. Ресайза,
кадрирования и агрессивного JPEG-сжатия нет. Входные лимиты сохранены:
JPEG/PNG/WebP/PDF, 10 МиБ/файл, 50 МиБ/комплект, 10 файлов, 100 страниц.
100 МиБ — предел утверждённого артефакта и доставки, а не новый лимит загрузки.

Миграция `0016_approved_artifact_transport` добавляет:

| Таблица | Поля |
| --- | --- |
| document_versions | approvedMimeType, approvedFilename, approvedExtension, approvedSizeBytes, approvedSha256, approvedPageCount, approvedPreparation |
| erp_document_deliveries | transport (NOT NULL, default base64-v1), attemptCount (default 0), nextAttemptAt |
| Индекс доставки | status + nextAttemptAt |

Существующие `approvedStorageKey`, pending-ключ и lease сохраняются. Миграция
аддитивная; новые approved-поля nullable, старые объекты — PDF. Массовый backfill,
пересборка, миграция бинарных файлов и изменение старых доставок не нужны.
S3-учётной записи нужны чтение исходника и запись destination для CopyObject;
политики bucket/lifecycle автоматически не меняются.

Применение: штатный `pnpm db:migrate` к базе **edo** перед запуском нового API.
В разработке применено только к одноразовой MariaDB 11.4; production не менялась.

Review сохраняет все метаданные артефакта, замороженный payload/transport
единственной доставки и аудит в одной транзакции. Проверяются текущая версия,
revision, доступ и pending-lease. После подтверждения review не редактирует
версию; retry не вызывает prepare. Новый upload получает другую версию и ключ.

Prepare резервирует единственный pending-ключ через CAS. Ошибка подготовки или
транзакции удаляет только собственный pending-объект. `discard` блокирует строку
версии и заново проверяет pending/approved-ключи, префикс владения и отсутствие
ссылки из DocumentVersionFile. Устаревшая выборка maintenance не может удалить
уже утверждённый артефакт. Ошибка S3 оставляет pending-ключ в БД для повторной
очистки. Очистка `cleanupPending` не выбирает версии с approved-ключом.
Оригиналы утверждённых версий и прежние артефакты не чистятся этим изменением.
Удаления из тестов ограничены одноразовыми собственными buckets/контейнерами.

Download/preview по-прежнему используют исходные файлы и их MIME/имена.
Жёсткой зависимости ссылки от `application/pdf` в DocumentReadService нет;
approvedStorageKey до этого использовался только подготовкой/доставкой.
Публичные REST DTO, права, generated hooks, OCR и координаты не менялись.

## Транспорт, квитанции, повторы

[Согласованный контракт 1С](edo-candidate-documents-v2.md) передан владельцем
файлом 2026-10-23. Это копия контракта, а не изменение репозитория 1С.

`transport` фиксируется при создании доставки, независимо от последующего env.
Старые строки по DB default и старые объекты без свойства transport идут по v1.
V1 сохраняет JSON/Base64, PDF, прежние даты и семантику HTTP 2xx. V2 сохраняет
ISO-даты и существующую фильтрацию positionUid при подтверждении; повторяет
ровно сохранённый payload. Автоматического fallback/перевода старых строк нет.

V2 использует Basic/token, постоянный `Idempotency-Key = delivery.id`,
X-File-SHA256, X-File-Size, Accept JSON; части metadata и file, без fileExtension
и fileBase64. Имя всегда безопасное `document.<ext>`. Размер metadata ≤256 КиБ,
тело ≤105136128 байт; Content-Length рассчитан точно. Выходной HTTP не сжимается.
Boundary случайный; проверка разделителя работает и на стыках S3-блоков, при
коллизии запрос обрывается до завершающего разделителя.

S3 GetObject → async iterator → Node HTTP(S) pipeline. Буфер iterator 64 КиБ;
префикс содержит только ограниченные metadata/заголовки, footer маленький.
SHA-256/размер контролируются при передаче, до footer. Backpressure задаёт
pipeline, общий AbortSignal отменяет S3/HTTP, finally закрывает потоки.
Полного Buffer/Blob или Base64 файла в v2 нет. Node HTTP выбран вместо fetch:
на Node 25 fetch превращал потоковый 401 в сетевую ошибку при попытке replay;
явный HTTP-клиент сохраняет статус и не делает скрытых повторов/редиректов.
Node fetch/duplex в этой реализации v2 не используется.

SENT требует 201/duplicate=false либо 200/duplicate=true, полного JSON и
совпадения deliveryId, documentUid, MIME, размера, SHA-256 и безопасного имени.
Проверяются непустые UUID receiptId/fileUid/candidateUid и календарный period.
Кандидатский UID 1С не сравнивается с UUID чата. Некорректный/обрезанный/непрочитанный
ответ не считается подтверждением. В responseBody попытки v2 остаются только
success/receiptId/duplicate/безопасный code; HTTP-статус и флаги чтения — отдельно.
Описания, персональные реквизиты и произвольные поля ответа v2 не сохраняются.
В audit не попадают тело, файлы или секреты. Для v1 прежнее маскирование сохранено.

| Настройка | Значение по умолчанию | Назначение |
| --- | --- | --- |
| ERP_DOCUMENTS_TRANSPORT | multipart-v2 | Только новые подтверждения; base64-v1 для отката |
| ERP_DOCUMENTS_V2_AUTO_RETRY | false | Включать после приёмки идемпотентности публикации |
| ERP_DOCUMENTS_V2_TIMEOUT_MS | 300000 | Общий S3+HTTP deadline, 60000–600000 мс |
| DOCUMENT_WORKER_ENABLED | true | Начальные отправки, восстановление и maintenance |

Lease v2 = deadline + 60 секунд, v1 — 180 секунд при HTTP timeout 60 секунд.
Claim/finish — CAS по статусу/leaseToken, attempt и аудит атомарны. Истёкшая
попытка закрывается, после рестарта используется тот же delivery.id.

После явного включения auto-retry повторяются сеть, timeout, обрыв,
408/429/500/502/503/504. До пяти попыток суммарно (включая первоначальную),
backoff с jitter 15–30, 30–60, 60–120, 120–240 секунд, nextAttemptAt в БД.
FILE_STORAGE_NOT_CONFIGURED не повторяется автоматически. Бизнес-конфликт,
ошибка авторизации, невалидные данные/артефакт и плохая квитанция требуют
ручной проверки. Ручной повтор после лимита использует тот же ID; счётчик не
обнуляется, новая автоматическая серия не открывается. При выключении auto-retry
уже запланированные повторы паркуются атомарно с аудитом в REQUIRES_MANUAL.
SENT не отправляется повторно; WAITING_CONTRACT не обходит отсутствие chatUid.

## Измерения размера и читаемости

Фикстуры — синтетические документы с шумом бумаги, мелким текстом, печатью,
подписью и настоящим QR, без реальных персональных данных. Таблица — реальные
измерения зафиксированных байтов, не обещание процента на произвольном документе.
Старый алгоритм воспроизведён буквально: image → sharp.rotate().png() → PDF.

| Комплект | Исходные байты | Старый PDF | Новый артефакт | Экономия к старому |
| --- | ---: | ---: | ---: | ---: |
| JPEG фото паспорта | 909726 | 2498522 | 909726 | 63,59% |
| JPEG с текстом | 336727 | 2203218 | 336727 | 84,72% |
| PNG-скан | 1898806 | 1580308 | 1898806 | −20,15% |
| WebP | 544270 | 2237366 | 544270 | 75,67% |
| Две стороны JPEG | 1246453 | 4701127 | 1247744 | 73,46% |
| Трёхстраничный PDF + JPEG | 910996 | 2499200 | 911354 | 63,53% |

PNG здесь больше старого PDF: обязательная побайтовая сохранность приоритетнее
произвольной оптимизации. Все четыре одиночных формата имеют идентичные SHA,
размер и байты. Тест проверяет исходный JPEG DCT внутри многофайлового PDF,
порядок/размеры страниц, многолистовые PDF и PNG SMask.

Poppler pdftoppm отрендерил PDF EXIF 1–8. Сравнение 300-px thumbnails с
sharp.auto-orientation: средняя абсолютная ошибка 1,38–2,28/255; размеры и
ориентация совпали. Thumbnail служит только проверкой ориентации — в production
нет уменьшения изображения. Alpha на белом фоне: ошибка 1,21/255. Различия
растровых декодеров не являются перекодированием исходного DCT.
QR `EDO-ARTIFACT-READABILITY-2026` прочитан zxing-cpp во всех четырёх исходных
изображениях и восьми отрендеренных ориентациях. Дополнительного JPEG-сжатия
нет, следовательно текст/печати/подпись одиночного файла сохраняются буквально.
Приёмка реальных трудночитаемых документов и клиентов 1С остаётся отдельной.

Воспроизведение: `pnpm --filter @edo/api exec ts-node --transpile-only
scripts/benchmark-approved-artifacts.ts`; нужен pdftoppm. Артефакты/JSON только в
`.cache/approved-artifacts/benchmark`, fixtures и manifest — в `apps/api/test/fixtures`.

Нагрузочный прогон: Node **22.23.4**, отдельный процесс отправителя, локальный
moto S3 → реальный локальный HTTP-приёмник. Валидный одностраничный PDF ровно
104857600 байт (pdfinfo подтвердил); SHA совпал, Content-Length точен, footer
завершён, открытых S3-потоков после завершения **0**. Отправка **559 мс**;
RSS baseline **140767232**, peak **177000448**, прирост **36233216** байт
(34,56 МиБ); external peak **41784117**, heap peak **46050704** байт.
Результат включает runtime/SDK и сборку мусора. Он не измеряет платформу 1С,
сеть production, буферизацию proxy или предельный параллелизм.

`EDO_TEST_S3_ENDPOINT=http://127.0.0.1:5001 pnpm --filter @edo/api exec ts-node
--transpile-only scripts/stress-erp-multipart.ts` воспроизводит прогон, запускает
чистый sender-процесс и удаляет только собственный одноразовый bucket.
Рабочие S3 endpoint этот скрипт отвергает. При необходимости запускать Node 22,
как в production Dockerfile. Большие временные файлы остаются в `.cache/`.

## Автоматические проверки

Итоговый прогон API: **531 passed, 0 failed, 2 skipped**, 49 файлов.
Пропущены две проверки `candidate-card-cache.spec.ts`, требующие отдельного
Redis (`EDO_CANDIDATE_CACHE_TEST_REDIS_URL`). `lk-real-infra.spec.ts` исключён:
legacy harness загружает root .env и может обращаться к общим сервисам.
Все остальные инфраструктурные suites выполнены на одноразовых MariaDB/S3/RabbitMQ.
Среди них 11 новых проверок реального review/доставки на MariaDB/S3;
unit/HTTP suites покрывают одиночные форматы, PDF, EXIF, прозрачность,
лимиты, rollback, квитанции, ошибки потоков, backoff и старый транспорт.

Web: **123 passed**, 14 файлов. Корневые `pnpm build` и `pnpm lint`, а также API/web build и lint прошли. Публичных REST
изменений нет, OpenAPI/Orval не менялись. GitHub Actions, browser E2E и внешняя
1С не запускались. Node 22 нагрузочный прогон и замеры выше выполнены отдельно.
Итоговые безопасные числа сохранены в [measurements JSON](edo-approved-artifacts-measurements.json).

Прогон API задаёт явные disposable DSN и исключает legacy harness:

```sh
EDO_TEST_DATABASE_URL=mysql://edo:edo@127.0.0.1:3308/edo \
EDO_TEST_S3_ENDPOINT=http://127.0.0.1:5001 \
EDO_TEST_RABBITMQ_URL=amqp://edo:edo@127.0.0.1:5675/ \
DATABASE_URL=mysql://edo:edo@127.0.0.1:3308/edo \
REDIS_URL=redis://127.0.0.1:6399 \
RABBITMQ_URL=amqp://edo:edo@127.0.0.1:5675/ \
S3_ENDPOINT=http://127.0.0.1:5001 \
LK_EVENTS_CONSUME=0 DOCUMENT_WORKER_ENABLED=false OCR_WORKER_ENABLED=false \
pnpm --filter @edo/api exec vitest run --exclude test/lk-real-infra.spec.ts
```

Адреса выше относятся только к отдельно созданным тестовым сервисам. Не
подставлять рабочие endpoint. При широком прогоне обнаружены старые OCR
фикстуры без document relation и ожидания до введения маскирования optional
OCR/нормализации дат. Фикстуры приведены к текущему контракту; сохранность
исходного OCR проверяется в БД, разница реальных дат — отдельным assertion.
Во время параллельного тяжёлого S3-прогона один промежуточный запуск получил
таймауты harness 5 секунд; отдельный и итоговый последовательный прогоны зелёные.

## Включение и откат

1. На согласованной тестовой 1С проверить endpoint/роль, дисковые тома БСП,
   разрешённые расширения и размер полного тела 105136128 на всех proxy.
   Согласовать timeout до 300 секунд + запас ответа и допустимую конкурентность.
2. Развернуть совместимый EDO с **явным** ERP_DOCUMENTS_TRANSPORT=base64-v1,
   auto-retry=false. Сначала применить добавочную миграцию, затем запустить API.
   Проверить прежнюю отправку v1 и доступность исторических PDF/оригиналов.
3. На тестовом EDO включить multipart-v2 для новых подтверждений: JPEG, PNG,
   WebP, PDF, смешанный/многостраничный комплект. Сверить скачанные из 1С байты.
4. Потерять ответ после commit, повторить с тем же ID, проверить 200 duplicate,
   неизменный receipt/file/period и единственное вложение. Проверить параллельные
   запросы, 409 на изменённый payload и новую версию с другим ID.
5. Прогнать реальные 100 МиБ, память/диск/время 1С, настройку томов и ограничения
   БСП, тонкий/веб-клиент для WebP и EXIF JPEG (включая отражения).
   EXIF в одиночном файле не удалён: браузер EDO учитывает его. Если клиент 1С
   не отображает его корректно, скачивать неизменный оригинал и открывать
   EXIF-aware приложением; бесшумной замены успешного артефакта нет.
6. Отдельно согласовать production-переключение. Наличие рабочей ручки со слов
   владельца не считается выполненной агентом EDO интеграционной приёмкой.
   После приёмки идемпотентности при необходимости явно включить auto-retry.

Предпочтительный откат — оставить совместимый бинарник и аддитивную схему,
установить ERP_DOCUMENTS_TRANSPORT=base64-v1 и auto-retry=false. Только новые
подтверждения станут PDF/v1; уже созданные v2 сохраняют артефакт, payload и ID и
остаются доступными для сверки/ручного v2-повтора. SENT не трогать.
Нельзя пересоздавать доставку, переводить её на v1 или менять ключ ради обхода
409/timeout. Неопределённый результат сверять с реестром 1С по delivery.id.

Откат **к старому несовместимому коду** при наличии v2-строк небезопасен: он
игнорирует transport и может отправить их в v1. Сначала остановить отправки и
ручные операции доставки; сохранить совместимый обработчик v2 до сверки всех
неоконченных записей. Не удалять схему, объекты, версии и реестры идемпотентности.
Рабочие токены, queues, bindings, S3 lifecycle и данные этим этапом не менялись.

## Изменённые файлы

```text
.env.example
apps/api/scripts/benchmark-approved-artifacts.ts
apps/api/scripts/generate-artifact-fixtures.ts
apps/api/scripts/stress-erp-multipart-sender.ts
apps/api/scripts/stress-erp-multipart.ts
apps/api/src/config/env.validation.ts
apps/api/src/documents/approved-artifact.ts
apps/api/src/documents/document-delivery.service.ts
apps/api/src/documents/document-pdf.service.ts
apps/api/src/documents/document-review.service.ts
apps/api/src/documents/erp-delivery-response.ts
apps/api/src/documents/erp-multipart.ts
apps/api/src/storage/storage.service.ts
apps/api/test/approved-artifacts.spec.ts
apps/api/test/approved-delivery-infra.spec.ts
apps/api/test/document-delivery-response.spec.ts
apps/api/test/documents-infra.spec.ts
apps/api/test/erp-multipart.spec.ts
apps/api/test/fixtures/approved-artifacts/README.md
apps/api/test/fixtures/approved-artifacts/document.webp
apps/api/test/fixtures/approved-artifacts/manifest.json
apps/api/test/fixtures/approved-artifacts/multipage.pdf
apps/api/test/fixtures/approved-artifacts/passport.jpg
apps/api/test/fixtures/approved-artifacts/qr.svg
apps/api/test/fixtures/approved-artifacts/scan.png
apps/api/test/fixtures/approved-artifacts/text-photo.jpg
apps/api/test/fixtures/approved-artifacts/transparent.png
apps/api/test/manual-documents.spec.ts
apps/api/test/ocr-review-details.spec.ts
apps/api/test/ocr-review-lifecycle.spec.ts
docs/integrations/edo-approved-artifacts-measurements.json
docs/integrations/edo-approved-artifacts.md
docs/integrations/edo-candidate-documents-v2.md
docs/integrations/edo-candidate-documents.md
prisma/migrations/0016_approved_artifact_transport/migration.sql
prisma/schema.prisma
```
