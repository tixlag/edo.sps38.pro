# Передача контекста: Интеграция EDO ↔ 1С ERP ↔ ЛК

Дата фиксации: 2026-11-05

## 1. Зафиксированное исходное и текущее состояние репозиториев

### EDO (`/home/tixlag/orca/projects/edo.sps38.pro`)
- **Ветка:** `fix/ig-erp-confirmed-delivery`
- **Базовый HEAD:** `7398395be67aba24c745494d58839aa313b11a8d`
- **Новый HEAD:** `16ea3d8` (3 новых логических коммита: `ff416d6`, `a2d181d`, `16ea3d8`)
- **Remote gitlab:** `https://glab.sps38.pro/webdevs/edo.sps38.pro.git` (приватный)
- **Remote origin:** `https://github.com/tixlag/edo.sps38.pro.git` (публичный) + `https://glab.sps38.pro/webdevs/edo.sps38.pro.git`
- **Правило публикации EDO:** публиковать изменения ТОЛЬКО в приватный `gitlab`, без разрешения в публичный GitHub не пушить!
- **Связанные ветки и MR:**
  - !16 `feat/candidate-chat-workspace` (Draft -> `main`)
  - !47 `feat/notification-expiration-control` (HEAD `f258f04663707fe3d738a1d9997c358f39e5dd7b`, успешно перенесён и согласован)
  - Ветка `fix/ig-erp-confirmed-delivery` готова для MR/PR в приватный GitLab.

### 1C ERP (`/home/tixlag/orca/projects/1c-erp`)
- **Ветка:** `fix/ig-arrival-identity-sync`
- **HEAD:** `a7f2b8695b863cb85c191e76d5eb9e0e0a6c21a9`
- **Remote gitlab:** `https://glab.sps38.pro/1cdevs/1c-erp.git` (приватный)
- **MR:** !1349 к `develop`
- **Статус тестов (все 7 наборов):**
  - `check-candidate-workspace.py`: 17/17 OK
  - `check-ig-arrivals.py`: 3/3 OK
  - `check-ig-bootstrap.py`: 6/6 OK
  - `check-ig-form-binding.py`: 7/7 OK
  - `check-ig-grants.py`: 3/3 OK
  - `check-ig-list-binding.py`: 8/8 OK
  - `check-ig-transition.py`: 6/6 OK
  - **Итого ERP: 50/50 тестов пройдено успешно.**

### ЛК (`/home/tixlag/PhpstormProjects/lk.sps38.pro`)
- **Ветка 1 (Адаптация):** `feat/ig-arrival-context-integration`, HEAD `78312652d6a90465f201650052dc220f052e4f2b`
- **Ветка 2 (Уведомления):** `fix/edo-notification-recipient-resolution`, HEAD `673dad2f31de257017b0362337b920c50a546029`
- **PR:** #2633 (`fix/edo-notification-recipient-resolution` -> `main`, Draft)
- **Статус тестов:**
  - `EdoNotificationsTest.php`: 22/22 OK (80 проверок)

---

## 2. Реализация задач (A–E)

### [x] Задача A: Фоновое обогащение профилей ИГ (P1)
- Выделена внутренняя операция синхронизации документов (`syncPreviousDocumentsInternal`) в `CandidateWorkspaceService` без использования фиктивного пользователя.
- Реализован сервис `IgProfileEnrichmentService` с раздельным отслеживанием `profileSyncedAt` и `previousDocumentsSyncedAt` и экспоненциальным backoff (30s – 600s).
- Защита от дефолта гражданства РФ: `citizenshipProvided: false` строго отфильтровывается и не переопределяет статус ИГ.
- Добавлена колонка и индекс `candidates.previousDocumentsSyncedAt` (миграция `20261105008600_candidate_previous_documents_synced_at`).
- Все тесты `test/ig-profile-enrichment.spec.ts` (4/4) и тесты ИГ пройдены.

### [x] Задача B: Интерфейс списочных заездов ИГ в web (P1)
- Создан компонент `IgArrivalReviewQueue.tsx` с реальными группами `assigned` и `issues`, состояниями `state` и кодами проблем `issueCode`.
- Добавлен переключатель «Списочные заезды» / «Обычный список» в `/review-ig` для операторов с правами `20011` / `20009`.
- В интерфейсе оператора строго исключена кнопка «Загрузить документы».
- Реализованы пагинация, фильтрация/поиск, бейджи статусов проверки документов и интеграция с карточкой `CandidateDrawer`.
- Все тесты `IgArrivalReviewQueue.spec.tsx` (6/6) и `ReviewPage.spec.tsx` (19/19) пройдены, `turbo build` успешен.

### [x] Задача C: Перенос и согласование уведомлений EDO (!47) (P1)
- Перенесена подсистема контроля сроков действия документов (`apps/api/src/expiration/`):
  - Пороги предупреждений строго сохранены: `[30, 15, 7, 1, 0]` дней.
  - Фоновый воркер `ExpirationRetryWorker`, контроллер и бэкфилл.
  - Сохранена полная цепочка 6 миграций из !47 (`20261103170000` – `20261103220000`).
- Перенесена и настроена доставка уведомлений по договорам (`ContractNotificationDeliveryService`).
- Согласован протокол ретраев с ЛК при 409 `RECIPIENT_RESOLUTION_INCOMPLETE`:
  - Сохраняется исходный `idempotencyKey` и полный список получателей (`recipients`).
  - Убран конфликтный параметр `fingerprint`.
- В веб-интерфейсе `NotificationBell.tsx`:
  - Убран постоянный polling (10s/30s).
  - Подключен WebSocket `/ws/notification?user_uuid=${profile.data.uuid}` с инвалидацией TanStack Query кэша по событиям и авто-переподключением с REST-реконсиляцией.
  - Сохранено обновление по открытию шторки и фокусу окна.
- Все тесты (`document-expiration.spec.ts`, `contract-notification-delivery.spec.ts`, `lk-notification.service.spec.ts`, `NotificationBell.spec.tsx`) пройдены.

### [x] Задача D: Синхронизация заездов и персистентность курсора (P2)
- В `erp-workspace.client.ts` обеспечена обработка HTTP 400 `INVALID_CURSOR` с генерацией `BadRequestException("INVALID_CURSOR")`.
- В `ig-arrival-sync.worker.ts` курсор сохраняется в базу данных в singleton-таблицу `ig_arrival_sync_state` (миграция `20261105008700_ig_arrival_sync_state`).
- Курсор сбрасывается в `null` при полном завершении ленты или при возникновении `INVALID_CURSOR`. При перезапуске воркера обход продолжается с сохранённой позиции.
- Все тесты `ig-arrival-sync.spec.ts` (11/11) и `erp-workspace-errors.spec.ts` (9/9) пройдены.

### [x] Задача E: Комплексное тестирование и финализация
- **EDO Backend Tests:** 94 test files passed (946 тестов passed, 0 failed, 138 skipped).
- **EDO Frontend Tests:** 38 test files passed (300 тестов passed, 0 failed).
- **EDO Typecheck / Build:** `@edo/api`, `@edo/web`, `@edo/ui`, `@edo/lk-client` собраны без ошибок.
- **EDO Lint:** 0 ошибок в ESLint по всему монорепозиторию.
- **1C ERP Checks:** 50/50 тестов пройдено (7 наборов).
- **LK Unit Tests:** 22/22 теста пройдено (80 проверок).
- **Git Commits:** создано 3 логических коммита в ветке `fix/ig-erp-confirmed-delivery`.

---

## 3. Коммиты в ветке `fix/ig-erp-confirmed-delivery` (EDO)

1. `ff416d6` `feat(web): add IG arrival review queue with assigned and issue groups`
2. `a2d181d` `feat(ig): enrich IG candidate profiles and persist arrival feed sync state`
3. `16ea3d8` `feat(notifications): integrate expiration alerts and contract notification delivery`
