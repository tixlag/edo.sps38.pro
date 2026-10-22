# AGENTS.md — rules for coding agents

This is a pnpm + Turborepo monorepo (`apps/web`, `apps/api`, `packages/*`). Read this before writing code.

## Передача сессии: переписка ERP ↔ ЭДО ↔ ЛК (2026-10-22)

**Пользователь отложил продолжение задачи. Не возобновлять интеграцию, merge или
deploy автоматически.** Исправления сохранены и отправлены, но выпуск и приёмка
на платформе 1С не завершены. Сначала перечитать этот раздел и проверить реальные
ветки, незакоммиченные изменения, remotes и вершины MR/PR: checkout ЛК уже занят
другой задачей. Worktree не создавать и ветки без необходимости не переключать.

### Репозитории и сохранённый код

SHA ниже фиксируют код завершённого корректирующего этапа; последующие коммиты
передачи документации не означают дополнительную реализацию или выпуск.

| Сервис | Checkout и его фактическая ветка при передаче | Код задачи | MR/PR и назначение |
| --- | --- | --- | --- |
| ЭДО API/web | `/home/tixlag/orca/projects/edo.sps38.pro`, `feat/candidate-chat-workspace` | `4d93fd3beef098432a7ce9c3f5c109735f5867d1` | [GitLab !16](https://glab.sps38.pro/webdevs/edo.sps38.pro/-/merge_requests/16) → `main`; код также отправлен в GitHub-зеркало |
| 1С ERP | `/home/tixlag/orca/projects/1c-erp`, `feat/edo-candidate-communications` | `d5e5e372bed630e34d03a9b415c732fe1743c90f` | [GitLab !1286](https://glab.sps38.pro/1cdevs/1c-erp/-/merge_requests/1286) → `develop`; checkout чистый |
| ЛК, текущая чужая работа | `/home/tixlag/PhpstormProjects/lk.sps38.pro`, **`feat/welding-repair-ux-training`**, HEAD `1674ae9f98b75cc6bb0dcc114ba20c680834c148` | Переписка находится **в другой ветке**: `fix/candidate-chat-multiple-sessions`, `eb08b81516d7a05f82cadf764c17e885a8598664` | Исправления запушены в `tixlag/lk.sps38.pro`; [upstream PR #2559](https://github.com/websps/lk.sps38.pro/pull/2559) → `websps/lk.sps38.pro:main` |

- ЭДО: `gitlab` — основной GitLab; `origin` — GitHub-зеркало, но у него **два
  push URL**, GitHub и GitLab. Использовать явный сервер для push. Отметка
  `ahead` относительно старого `origin/*` не доказывает отсутствие push:
  на момент передачи оба сервера содержали `4d93fd3b`.
- ERP: remote `gitlab`; свежий удалённый `develop` уже
  `fa34ea3616cdd0bead0eb224478d63316ffb3b8d`. Не откатывать его к baseline ревью.
  `/Candidate` в целевой ветке расширен параметром **`code1c`**, а не `code_1c`.
- ЛК: `fork` — `tixlag/lk.sps38.pro`, `origin` — upstream
  `websps/lk.sps38.pro`. Не смешивать их `main`. Свежий upstream `main` при
  передаче — `51a442cb19596bf86472dc90113a5d288294c632`.
  Сохранить чужой untracked каталог
  `docs/welding-management-report/exports/svarka_obuchenie_po_rolyam_2026-10-21-with-images/`.
  Не сбрасывать и не коммитить его в задачу переписки. Текущая welding-ветка
  не означает, что исправленный candidate chat-server запущен или развёрнут.

### Что реализовано и согласовано

Единый контракт и все wire-примеры:
[`docs/integrations/candidate-communications-correction.md`](docs/integrations/candidate-communications-correction.md).
Не изобретать вместо него отдельные протоколы для трёх сторон.

- ERP: локальный явный JSON-разбор запроса/вложенного `file` и Telegram без
  изменения глобального default `КоннекторHTTP`; `SENT` только при проверенном
  подтверждении, явный отказ `FAILED`, возможная отправка без подтверждения
  `UNKNOWN`. Старые транспортные сигнатуры и десять шаблонов сохранены.
  API/форма используют общую каноническую ссылку с блокировкой конкретного
  кандидата и устойчивым `erp_candidate_uuid`; существующий чат не заменяется.
  Ответ `/Candidate` по чату дополнен доверенным `erpUid`. Форма получает grant
  серверно, обновляет его и отображает операторские сообщения без дублей.
- ЭДО: доверенное разрешение владельца по ERP UID/chat UUID сохраняет
  `Candidate.id`, документы, отправки и старые квитанции. Новое поле `erpUid`
  не меняет старые fingerprint/пространства `DocumentSubmission`. Конфликтующие
  карточки не удаляются и не объединяются по ФИО, телефону или одному `code1c`.
  Сохранено поведение документов сотрудника без чата из актуальной `main`.
  Пустые необязательные URL не останавливают API. OpenAPI/Orval обновлены.
- ЛК: короткоживущий grant ограничивает автора, чат, `can_send` и срок.
  Закрыты старые анонимные операторские обходы WS/файлов/prepared files;
  public candidate mode не получает операторскую роль. Текст/файл используют
  стабильный `operation_id`, транзакционный реестр и адресный `send_ack` после
  commit. Повтор того же содержимого возвращает прежнее сообщение, другое
  содержимое отклоняется. Broadcast не является подтверждением; потеря ответа
  остаётся `UNKNOWN` без автоповтора. Fanout нескольких подключений сохранён.
  Добавочная миграция ЛК — `db/migrations/20261021150000.php`; её реестр не
  удалять при откате кода.

### Локальный стенд, оставленный работающим

- Адрес: **https://edo.localhost:12443/**. Проверены root, `/review`, API live
  и ready — HTTP 200; `/api/v1/me` без JWT — штатный 401. Сертификат принимается
  локальным curl без отключения проверки TLS. Работают Vite `:5174` и API `:3001`
  через существующий `lk_nginx`; штатная авторизация сохранена.
- API перезапущен после зависшего старого watcher. Текущий запуск использует
  **process env overrides**, root `.env` не менялся:
  `NODE_ENV=development`, `LK_EVENTS_CONSUME=0`,
  `DOCUMENT_WORKER_ENABLED=false`, `OCR_WORKER_ENABLED=false`,
  `CANDIDATE_CATALOG_SYNC_ENABLED=false`. При перезапуске сохранить эти overrides;
  root `.env` сам по себе включает часть workers/consumer.
- `pnpm local:status` показывает managed-процессы; PID/starttime хранятся в
  `.cache/local-stand/processes.json`, логи — `.cache/local-stand/{api,web}.log`.
  `pnpm local:down` останавливает только эти процессы. Не останавливать чужие
  процессы по совпадению порта или имени.
- Используется существующий LK local stack: MariaDB `:12002`, только база
  `edo`; Redis `:6379`; RabbitMQ `:5674`; S3 mock `:5000`.
  При проверке только чтением в `edo` присутствовали нужные таблицы и 12
  завершённых миграций. При подъёме стенда миграции, seed и изменения очередей
  не выполнялись; данные не очищались.
- `ERP_CANDIDATE_URL`, `ERP_COMMUNICATIONS_URL`, `LK_CHAT_BASE_URL` в текущем
  локальном `.env` не заданы. **Доступный UI/readiness не подтверждают работающую
  интеграцию переписки с ERP/ЛК.** Исправленный Go chat-server ЛК для этого
  постоянного стенда не поднимался. Production-конфигурацию сюда не копировать.
- Одноразовый контейнер проверок `edo-candidate-correction-20261021-db` с базами
  `edo`/`lkchat` удалён после тестов; его credentials и harness markers удалены.
  Не ожидать, что cross-runtime тестовый сервер ещё доступен.

### Проверки и оставшиеся действия

- Выполнено: изолированный API run **444 passed / 33 skipped**; после последнего
  усиления replay — **8 MariaDB + 5 resubmission** tests; web **105 passed**;
  API/web lint/build; OpenAPI → Orval. На одноразовой MariaDB проверены оба
  порядка импорта/чата/документа, параллельные catalog/upload, старые квитанции
  и сохранение конфликтующих владельцев.
- Реальный клиент ЭДО против реальных Go routes и той же disposable MariaDB:
  **7 passed**, текст/файл, независимые одинаковые тексты, replay/conflict,
  подмена автора/чата, read-only grant, несколько окон/отключение одного,
  потеря подтверждения после commit текста/файла. Внешних транспортов там нет.
- ЛК: затронутые Go tests, race suites hub/grants/router/MariaDB, vet/build,
  PHP syntax миграции прошли. Два прежних TempAppeal tests требуют реального
  `TEST_REQUESTER_CODE_1C` и не запускались. ERP: JS из поставляемого ZIP **4/4**,
  XML **8**, BSL LS 1.0.7 — **0 новых Error**, сохранены 44 legacy диагностики.
  **Платформы 1С нет: исполнение BSL не проверено.**
- ЭДО MR !16 конфликтует с `gitlab/main=9865a8990dcb4b9cac14d8088dc544cf004b4854`:
  `prisma/schema.prisma`, `manual-document.service.ts`, `dashboard.spec.ts`,
  `apps/api/openapi.json`, generated API client. Merge не выполнялся.
  При отдельном согласовании сохранить действующие OCR-модели/аудит,
  `submittedAt` и транзакционную постановку OCR; аргументы `ConfigService`
  и нового `ErpCandidateClient` загрузчика не смешивать. Сохранить документы
  без чата и актуальную сериализацию дат. Затем заново сгенерировать контракт
  и проверить итоговый SHA. Не заменять целевую main старой веткой переписки.
- ERP [pipeline 3799](https://glab.sps38.pro/1cdevs/1c-erp/-/pipelines/3799)
  на итоговом `d5e5e372` failed в `validate:mr` из-за имени ветки:
  нужен реальный номер задачи для `feature|bugfix|refactor/1C-<номер>[-описание]`.
  Номер не придумывать, CI не обходить, ветку/MR самовольно не переименовывать.
  Для итоговых SHA ЭДО/ЛК успешный CI run не зафиксирован.
- На изолированной 1С со stub-транспортами остаётся smoke: JSON send/link/file,
  Telegram success/refusal/malformed; параллельная ссылка ЭДО/форма и повтор
  после потери ответа; роли/подмена автора/чата текста и файла; форма более
  пяти минут с refresh и несколько окон без дублей. Реальным кандидатам
  сообщения не отправлять.
- Выпуск только отдельным этапом: добавочная схема → защищённый ЛК при
  выключенной операторской отправке → совместимые ERP/ЭДО → включение оператором.
  Существующий `ERP_CANDIDATE_TOKEN` сохраняется; для ЛК нужен серверный
  `LK_CANDIDATE_OPERATOR_TOKEN`. Секреты не передавать браузеру и не печатать.
  Откат сохраняет документы/версии, связи, переписку и реестры идемпотентности.

### Ограничения и инциденты предыдущего этапа

Merge, production deploy/миграции, force push, рабочие отправки, ротация секретов
и изменение рабочих queues/bindings/volumes/S3 lifecycle не выполнялись.
Первый legacy `lk-real-infra.spec.ts` всё же загрузил root `.env` и использовал
две собственные временные очереди shared RabbitMQ; они удалены, отсутствие
тестового префикса подтверждено узкой read-only проверкой. Не повторять:
перед любыми тестами явно задавать disposable DSN и блокировать fallback к
shared/external endpoints; обычный полный `pnpm test` без проверки env опасен.
Также первоначальный диагностический вывод затронул прежние секреты из
исходников/настроек/аргументов процессов. Значения не копировались в новые файлы,
fixtures и коммиты; ротации не было. Не выводить полный env, командные строки
процессов и содержащие credentials исходники/логи.

## Stack (do not change)

- MariaDB only. Prisma `provider = "mysql"`. Never introduce PostgreSQL.
- Prisma is the ORM. DB changes ONLY via migrations in `prisma/migrations`.
- Frontend: React + Vite + TanStack Router. Never Next.js.
- Backend: NestJS + Fastify adapter. REST + OpenAPI. Controllers thin; business logic in domain services.
- Messaging: shared RabbitMQ (`lk.events`); shared Redis for cache/locks only. No BullMQ, no Kafka, no Kubernetes, no GraphQL, no microservices frameworks.

## API contract flow (mandatory)

- Backend DTO/controller -> OpenAPI (`apps/api/openapi.json`) -> Orval -> frontend.
- Frontend API comes ONLY from `packages/api-client` generated TanStack Query hooks (import `@edo/api-client`, never `@edo/api-client/src/...`).
- `packages/api-client/src/generated` is GENERATED — DO NOT EDIT. After any endpoint change run `pnpm api:generate`.
- UI primitives come ONLY from `packages/ui` (import `@edo/ui`, never `@edo/ui/src/...`).
- Never write `fetch`/`axios` calls inside React components. Never hand-duplicate API DTO/types on frontend.
- Every public REST endpoint needs `@ApiOperation` (with operationId), response DTO, error responses, enum schemas.

## Auth (unified JWT, HS256)

- No custom username/password login. External unified auth service is the only IdP.
- JWT: HS256, shared `JWT_SECRET`, pinned `JWT_ALG=HS256` (never trust header.alg), `JWT_ISSUER=lk-auth-service` (verified), `exp` always verified. Fail closed in production.
- Backend: `JwtService.verify()` + global `JwtAuthGuard` attach typed `AuthPrincipal` (uuid/code_1c/sid/accessRules). Dev bypass ONLY via `ALLOW_INSECURE_DEV_AUTH=true` AND `NODE_ENV=development/test` (accepts literal `dev-demo-token`). Default off.
- Access JWT in React memory ONLY (`apps/web/src/lib/auth-token.ts`). NEVER localStorage/sessionStorage/IndexedDB.
- Refresh token in HttpOnly cookie; restore session via configured refresh endpoint adapter. Frontend dev fallback (`dev-demo-token`) ONLY when `VITE_ALLOW_INSECURE_DEV_AUTH=true` in dev.
- EDO access rules 20000–20009 (`EdoAccessRule` enum). Key presence grants (`hasOwnProperty`), NEVER truthiness. Location scope: 20009/20008 → all, else 20007 → listed ids, else denied. Enforce via `@RequireAccessRule(...)` + `AccessRuleGuard` and `resolveLocationScope`/`isLocationAllowed` helpers — never hand-check in controllers. `GET /api/v1/me` exposes permissions + locationScope for UI decisions only; backend re-checks every action.

## LK master-data integration (source of truth = lk.sps38.pro)

- LK/1C owns employees/objects/positions/departments. EDO keeps a local projection (`LkEmployee/LkLocation/LkPosition/LkDepartment`, tables `lk_*`) and NEVER reads LK tables directly, NEVER uses the full LK OpenAPI.
- Compact client `packages/lk-client` is generated ONLY from the narrow spec `packages/lk-client/openapi/edo.json` (copy of LK `next/openapi/edo.json`): `GET /api/internal/edo/v1/{employees,locations,positions,departments}` plus read-only candidate identity endpoints (`candidate-chats/{chatUuid}`, `employees/{code1c}/candidate-chat`). Backend-only; frontend must never import `@edo/lk-client` (React → EDO API → local MariaDB). Client has runtime validation, timeout + AbortSignal, bounded transient retries (no retry on 401/403/contract), safe errors (status+path only, never bodies); pagination finishes only on `nextCursor === null` (missing = contract error), repeat/no-progress detection, page/time limits, validate-before-apply.
- S2S auth: `Authorization: Bearer <LK_EDO_INTERNAL_TOKEN>` (server env only, never frontend). Fail closed when empty.
- Bootstrap/reconciliation: `LkReferenceSyncService` (locations → positions → departments → employees paginated by opaque cursor, guard-required in production). CLI: `pnpm --filter @edo/api lk:sync`. Idempotent upserts, `syncedAt` marked, `deleted`/`fired` preserved (no physical deletes). Fencing via `lk_sync_state` singleton row: every projection write runs in a SHORT tx that first takes `SELECT ... FOR UPDATE` (events require no active run, snapshot writes require own runId+generation; steals bump generation; orphans with stale heartbeat don't block events and are stolen by the next `lk:sync` under the Redis lock). Coordination SQL errors always propagate (explicit test doubles, never "probably a mock"). `syncAll` without guard throws (tests use `allowUnguardedForTests:true`); cancellation + overall deadline 10min (Redis heartbeat bounded, run-sync DB heartbeat + watchdog); incomplete snapshots never mark; zero + shrinkage (>30% vs last FINISHED) guards.
- Changes: RabbitMQ durable topic `lk.events`, queue `edo.lk-reference-sync`, bindings `lk.reference.*.*.v1` (published today: employee/position/department upserted v1; location/deleted keys reserved). Consumer is idempotent via `lk_processed_events.eventId` (same tx as projection + audit, ack after commit), tolerant to redelivery. Poison (malformed, unknown version/key, Zod errors) → `nack(false)` → DLQ `*.dlq` via DLX (never infinite, never acked as applied). Transient → single confirm-gated retry path: default-exchange `publish('', *.retry, {mandatory:true}, perMessageCallback)` with `x-retry-count+1` + validated `x-original-routing-key` (allowlist + envelope match, never arbitrary), ack original only after per-message ack AND no correlated return; unconfirmed → one delayed nack(true) per delivery (fixed 5s, tracked by generation:deliveryTag, removed on settlement; redeliveries carry their own entries, valid events are never DLQed for a mere unavailable retry route). After 5 confirmed attempts → DLQ. ConfirmChannel creation failure fails closed (explicit test seams, no plain-channel fallback). Old retry-format (queue-name key, no header) poisons deterministically; managed recovery via `pnpm --filter @edo/api lk:recover -- --dry-run/--apply --limit --from=dlq|retry` (bounded, never automatic mass replay). Broker-internal DLX hops drop unroutable dead-letters silently (proven) — guarantee is at-least-once ONLY while EDO-owned topology stays intact (never delete queues; missing queues surface as `queueErrors` in integration health). Out-of-order safe as far as possible without LK revisions; periodic full snapshot fixes divergence (LK does not publish every write path — see ADR-002). Revision ordering (newer-wins, tombstones) is BLOCKED on the LK contract — see `docs/integrations/edo-lk-contract-status.md` (studied LK SHAs + handoff); never invent revisions from local time/occurredAt/eventId.
- Employee scope (EDO cases vs LK projection): `Employee.lkEmployeeCode1c` (nullable, never ФИО-matched, never auto-created) + `Employee.locationId` (explicit case object; NULL invisible to 20007). Backend DB-filtered list/getById/total; 20009/20008 → all, 20007 → listed ids, else denied.
- Observability: `GET /api/health/integration` (Redis, consumer, bootstrap, freshness 24h, queue depths; never gates reads); durable `lk_sync_runs` ledger. Runbook + example cron (not installed) in `docs/integrations/edo-runbook.md`.
- See `docs/decisions/ADR-002-lk-master-data-sync.md`.

## Working with LK locally (shared containers)

- LK repo lives outside this monorepo (sibling checkout). Canonical local stack: its `docker/docker-compose.yml`, compose project `lk` — ALL containers must carry the `lk_` prefix. Never run a second compose project/file for the same services (split-brain: app on one network, DB/broker on another).
- Expected containers: `lk_nginx` (host `12000:80` + `12443:443`) · `lk_php` · `lk_php_next` · `lk_mariadb` (host `12002`) · `lk_redis` (host `6379`, no auth) · `lk_rabbitmq` (host AMQP/UI per env) · `lk_auth-service`. Data lives in project volumes (`lk_sps_db`, `lk_rabbitmq-data`, `lk_redis`) — NEVER delete volumes.
- LK HTTP: `https://next.localhost:12443` (`server_name next.localhost`; plain HTTP redirects to HTTPS). Name must resolve to 127.0.0.1 (corporate DNS does here, else add `127.0.0.1 next.localhost` to /etc/hosts). Local cert is self-signed: dev-only `NODE_TLS_REJECT_UNAUTHORIZED=0`, never production.
- S2S token is paired: LK `php_next` env `EDO_INTERNAL_TOKEN` (empty default = guard throws) ↔ EDO `LK_EDO_INTERNAL_TOKEN`. Verify without secrets: bad token → `401`, good token → `200` JSON on `GET /api/internal/edo/v1/locations`.
- RabbitMQ: `RABBITMQ_NODENAME=rabbit@lk_rabbitmq` is pinned in compose (mnesia is hostname-bound — without it every recreate starts with an EMPTY broker). EDO user is operator-created via `rabbitmqctl` with configure/write/read on `(edo\.lk-reference-sync.*|lk.events|amq\.default|)` and read on `(edo\.lk-reference-sync.*|lk\.events)` (`amq.default` is required for the retry-queue DLX). `lk.events` is LK-owned: only assert compatible, never redeclare/delete. Host AMQP port may be remapped if another local stack holds `5672` (container port stays `5672`; LK app uses container DNS).
- Gotchas: after recreating php containers run `docker exec lk_nginx nginx -s reload` (nginx caches upstream DNS at boot → stale IP → `502`). nginx serves code from the mounted repo checkout — mounts pointing at stale host copies (`/var/www/...`) silently serve old code; the local nginx site template must be the full version (an empty stub renders an empty vhost). `php-fpm-healthcheck` missing in dev image keeps php health at "starting" (cosmetic; verify via real request).
- EDO side: `pnpm infra:check` (read-only) → `pnpm db:migrate` (refuses non-`edo` DB) → `pnpm --filter @edo/api lk:topology` → `pnpm --filter @edo/api lk:sync` (exits `2` busy / `3` no Redis). Never read LK tables; never seed/migrate outside database `edo`.

## Domain rules

- Workflow logic is backend-owned (stage, required docs, actions, blockers). Never hardcode `if (employee.country ...)` / `showDocument(...)` in frontend.
- Main entities (employees/documents/workflows/requirements) are relational, not JSON. JSON only for raw OCR, integration payload, audit before/after, metadata.
- Audit is core: log via `AuditService` with actorId/action/entityType/entityId/before/after/correlationId. Critical mutations write state + audit atomically in one Prisma `$transaction` (`logInTransaction`). Never swallow audit errors.
- Document binaries go to S3-compatible storage (MinIO local), never MariaDB. Documents are versioned (Document -> DocumentVersion N).
- OCR is an external service: use the `OcrService` adapter boundary, do not build an OCR engine or invent its contract. Async: upload -> metadata -> RabbitMQ `edo.ocr.requested.v1` -> OCR -> status update, no long HTTP waits.
- No giant shared services/helpers. No premature universal abstractions.

## Env (root .env is authoritative)

- Root `.env` loaded explicitly by `apps/api` (`ConfigModule.envFilePath` + `main.ts` dotenv) and `apps/web` (`vite.config envDir` + loadEnv). Never rely on cwd.
- New vars: `JWT_SECRET/JWT_ALG/JWT_ISSUER/ALLOW_INSECURE_DEV_AUTH`, `LK_BASE_URL/LK_EDO_OPENAPI_URL/LK_EDO_INTERNAL_TOKEN`, `RABBITMQ_URL/LK_EVENTS_EXCHANGE/EDO_LK_QUEUE`. Local dev uses the SHARED LK containers (MariaDB :12002/db `edo`, Redis :6379, RabbitMQ :5672); EDO runs no MariaDB/Redis/Rabbit of its own. CI (manual) uses its own disposable MariaDB + Redis + RabbitMQ services (isolated, never shared LK infra; destructive fault-injection only there).
- ERP runtime guard (по передаче пользователя от 2026-10-21): прежний блокер генерации production `.env` устранён во внешнем `webdevs/ci-templates`. Deploy останавливается до замены `.env`, если `ERP_CANDIDATE_URL` или `ERP_CANDIDATE_TOKEN` пусты, и проверяет наличие обоих внутри API после restart без вывода значений; pipeline 3682 прошёл эти проверки. Сохранить guard. Не выполнять ручное восстановление production на основании устаревшего блокера от 2026-10-19; в этой сессии production не проверялся и не менялся.

## UI

- Pencil (`zabor.pen`) is visual truth. Do not restyle on your own.
- Never hardcode design hex (`#bf2026`, `#f3f4f6`) in code; use semantic tokens (`--primary`, `--background`, `--border`, ...).
- Reuse `packages/ui` + `apps/web/src/components` (AppSidebar, AppHeader, PageHeader, MetricCard, StatusBadge, EmptyState, DataTable, ActivityItem). Extend them, don't fork styles.
- Routing: real TanStack Router (`/`, `/employees`, `/employees/$employeeId`). Deep links + back/forward must work.

## Quality gates (must stay green)

- `pnpm install`, `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm test` work from repo root.
- Backend compiles; frontend has zero TS errors; Prisma migrations apply on clean MariaDB; OpenAPI exports; Orval client regenerates and frontend uses generated hooks; dashboard renders; collapsed/expanded sidebar work; employee endpoints respond; no JWT in persistent storage; production build passes.
- The authoritative CI is GitLab (external `ci-templates/edo.yml`). Per user instruction (2026-10-20), do not trigger GitHub Actions or run e2e unless explicitly requested. The retained `.github/workflows/ci.yml` is a historical/manual workflow, not the project's required CI. Use local targeted checks and GitLab pipeline results for validation.
- Health split: `/api/health/live` (process) vs `/api/health/ready` (MariaDB+RabbitMQ; Redis reported but optional) vs `/api/health/integration` (Redis coordination, consumer, bootstrap, freshness, queue depths; never gates reads).
- E2E auth: API runs with `ALLOW_INSECURE_DEV_AUTH=true` (dev/test only); web runs with `VITE_ALLOW_INSECURE_DEV_AUTH=true` + empty `VITE_AUTH_REFRESH_URL`; specs in `apps/web/e2e/fixture.ts` inject a real HS256-signed JWT (full EDO rules) via the dev-only `window.__EDO_DEV_TOKEN` hook, secret from `EDO_E2E_JWT_SECRET` (must equal the API `JWT_SECRET`). Never use this hook in production.

## Candidate documents boundary

- EDO owns browser document APIs and ERP Candidate context. Surveys owns adaptation authoring/progress and keeps `{{documents}}` / `DOCUMENTS`, but never proxies document requests.
- ERP Candidate citizenship defaults to `ru` in EDO when missing, null, empty, or whitespace-only. Preserve explicitly supplied valid citizenship (normalized to lowercase); malformed nonempty values remain contract errors. A missing position still returns the actionable incomplete-profile error.
- LK PHP exposes only canonical chat identity via the narrow internal API. Chat-server retains atomic employee-link outbox delivery. EDO never reads LK tables.
- Auth-service is the only user JWT issuer. Own-document APIs use verified `code_1c` without administrative EDO permissions; guest chat-link access remains a separate capability.
