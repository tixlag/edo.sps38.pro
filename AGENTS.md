# AGENTS.md — rules for coding agents

This is a pnpm + Turborepo monorepo (`apps/web`, `apps/api`, `packages/*`). Read this before writing code.

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
- Compact client `packages/lk-client` is generated ONLY from the narrow spec `packages/lk-client/openapi/edo.json` (copy of LK `next/openapi/edo.json`): `GET /api/internal/edo/v1/{employees,locations,positions,departments}`. Backend-only; frontend must never import `@edo/lk-client` (React → EDO API → local MariaDB). Client has runtime validation, timeout + AbortSignal, bounded transient retries (no retry on 401/403/contract), safe errors (status+path only, never bodies); pagination finishes only on `nextCursor === null` (missing = contract error), repeat/no-progress detection, page/time limits, validate-before-apply.
- S2S auth: `Authorization: Bearer <LK_EDO_INTERNAL_TOKEN>` (server env only, never frontend). Fail closed when empty.
- Bootstrap/reconciliation: `LkReferenceSyncService` (locations → positions → departments → employees paginated by opaque cursor, guard-required in production). CLI: `pnpm --filter @edo/api lk:sync`. Idempotent upserts, `syncedAt` marked, `deleted`/`fired` preserved (no physical deletes). Fencing via `lk_sync_runs` generation (atomic with writes); `syncAll` without guard throws (tests use `allowUnguardedForTests:true`); cancellation + overall deadline; incomplete snapshots never mark; zero + shrinkage (>30% vs last FINISHED) guards.
- Changes: RabbitMQ durable topic `lk.events`, queue `edo.lk-reference-sync`, bindings `lk.reference.*.*.v1` (published today: employee/position/department upserted v1; location/deleted keys reserved). Consumer is idempotent via `lk_processed_events.eventId` (same tx as projection + audit, ack after commit), tolerant to redelivery. Poison (malformed, unknown version/key, Zod errors) → `nack(false)` → DLQ `*.dlq` via DLX (never infinite, never acked as applied). Transient → confirm-gated retry via `*.retry` (TTL 5s → main) with `x-retry-count+1` + validated `x-original-routing-key` (allowlist + envelope match, never arbitrary), ack original only after publisher confirm (ConfirmChannel + mandatory return + timeout + backpressure); unconfirmed stays recoverable via redelivery (no hot loop). After 5 attempts → DLQ. Old retry-format (queue-name key, no header) poisons deterministically; managed recovery via `pnpm --filter @edo/api lk:recover -- --dry-run/--apply --limit --from=dlq|retry` (bounded, never automatic mass replay). Out-of-order safe as far as possible without LK revisions; periodic full snapshot fixes divergence (LK does not publish every write path — see ADR-002). Revision ordering (newer-wins, tombstones) is BLOCKED on the LK contract SHA — see `docs/integrations/edo-lk-contract-status.md`; never invent revisions from local time/occurredAt/eventId.
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

## UI

- Pencil (`zabor.pen`) is visual truth. Do not restyle on your own.
- Never hardcode design hex (`#bf2026`, `#f3f4f6`) in code; use semantic tokens (`--primary`, `--background`, `--border`, ...).
- Reuse `packages/ui` + `apps/web/src/components` (AppSidebar, AppHeader, PageHeader, MetricCard, StatusBadge, EmptyState, DataTable, ActivityItem). Extend them, don't fork styles.
- Routing: real TanStack Router (`/`, `/employees`, `/employees/$employeeId`). Deep links + back/forward must work.

## Quality gates (must stay green)

- `pnpm install`, `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm test` work from repo root.
- Backend compiles; frontend has zero TS errors; Prisma migrations apply on clean MariaDB; OpenAPI exports; Orval client regenerates and frontend uses generated hooks; dashboard renders; collapsed/expanded sidebar work; employee endpoints respond; no JWT in persistent storage; production build passes.
- CI (`.github/workflows/ci.yml`): frozen install → migrate → lint → test → OpenAPI/Orval regen → `git diff --exit-code` drift check → build → seed → Playwright install → e2e. Health split: `/api/health/live` (process) vs `/api/health/ready` (MariaDB+RabbitMQ; Redis reported but optional) vs `/api/health/integration` (Redis coordination, consumer, bootstrap, freshness, queue depths; never gates reads).
- E2E auth: API runs with `ALLOW_INSECURE_DEV_AUTH=true` (dev/test only); web runs with `VITE_ALLOW_INSECURE_DEV_AUTH=true` + empty `VITE_AUTH_REFRESH_URL`; specs in `apps/web/e2e/fixture.ts` inject a real HS256-signed JWT (full EDO rules) via the dev-only `window.__EDO_DEV_TOKEN` hook, secret from `EDO_E2E_JWT_SECRET` (must equal the API `JWT_SECRET`). Never use this hook in production.
