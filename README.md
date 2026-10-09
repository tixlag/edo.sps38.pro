# EDO (edo.sps38.pro)

Internal employee onboarding service: employees, documents, tasks, dashboard, audit.
Local LK master-data projection (employees/locations/positions/departments) synced
from `lk.sps38.pro` via compact S2S API + RabbitMQ events.

Stack: React + Vite + TanStack Router/Query (apps/web) · NestJS + Fastify (apps/api) ·
Prisma + MariaDB · RabbitMQ · Redis · Orval-generated clients.

## Local development (shared LK infrastructure)

Local HTTPS stand: **https://edo.localhost:12443** · `pnpm local:up` /
`pnpm local:status` / `pnpm local:down`.
See [local stand and login instructions](docs/local/stand.md) for demo auth,
shared nginx, S3 configuration and the currently implemented screens.

EDO runs **no** MariaDB/Redis/RabbitMQ of its own. Local dev uses the shared LK
containers; only data ownership is isolated:

| Service | Shared container | EDO usage |
|---|---|---|
| MariaDB | `lk_mariadb` (host `12002`) | separate database **`edo`** (never LK tables) |
| Redis | LK Redis (host `6379`, no auth) | keys under **`edo:*`** |
| RabbitMQ | `lk_rabbitmq` (host `5672`, vhost `/`) | EDO owns `edo.lk-reference-sync` (+`.retry`/`.dlq`/`.dlx`); `lk.events` is LK-owned |

Same container/server != same application database.

1. Start the usual LK stack (LK repo) — MariaDB/Redis/RabbitMQ must be up.
2. Create the isolated database/user **once** (dedicated `edo` user, rights on `edo.*` only):
   ```sql
   CREATE DATABASE IF NOT EXISTS edo CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER IF NOT EXISTS 'edo'@'%' IDENTIFIED BY '<password>';
   GRANT ALL PRIVILEGES ON edo.* TO 'edo'@'%';
   ```
   (Real passwords live only in your gitignored `.env`, never in git.)
3. RabbitMQ: EDO needs a user with permissions on `edo.lk-reference-sync*` and
   `lk.events` (operator-created, e.g. via `rabbitmqctl`). If host `5672` is
   occupied by another local stack, the operator remaps the LK broker **host**
   port (container port stays `5672`; the LK app uses container DNS).
4. Copy `.env.example` to `.env` and fill secrets (DB/Rabbit passwords, JWT secret,
   `LK_EDO_INTERNAL_TOKEN` from the LK operator).
5. `pnpm install --frozen-lockfile`
6. `pnpm infra:check` — read-only: MariaDB database must be `edo`, Redis PING,
   RabbitMQ `lk.events` check, optional LK API probe. No mutations, no credentials printed.
7. `pnpm db:migrate` (guarded: refuses any database except `edo`) · `pnpm db:seed`
8. `pnpm --filter @edo/api lk:topology` — assert EDO queues/bindings (buffers events)
9. `pnpm --filter @edo/api lk:sync` — coordinated snapshot (Redis lock; fails closed
   without Redis; refuses concurrent runs)
10. `pnpm dev`

EDO `docker-compose.yml` contains only EDO-specific storage (S3 mock on `:5000`):
`pnpm docker:up` / `pnpm s3:up`. Never `docker compose up mariadb/redis/rabbitmq` here.

## Key flows

- Bootstrap: `lk:topology` → `lk:sync` → boot API (consumer replays buffered events).
- Periodic reconciliation (REQUIRED — LK event coverage is partial): distributed
  Redis lock `edo:lk-reconciliation-lock` pauses live event apply; snapshot runs
  with DB fencing (`lk_sync_runs` generation, atomic with writes); `markMissing`
  only on success with lock still owned + latest RUNNING is us; lock released;
  queue replays.
- `lk:sync` exit codes: `0` ok · `2` another sync holds the lock · `3` Redis
  unavailable (fail closed) · `1` other failure (incl. lock lost mid-snapshot,
  fencing conflict, shrinkage guard, cancellation/deadline).
- Retry (confirm-gated, no hot loop): transient → `*.retry` (TTL 5s → main) with
  `x-retry-count+1` + validated `x-original-routing-key`, ack only after publisher
  confirm (ConfirmChannel); max 5 → DLQ. Old-format messages (queue-name key, no
  header) poison deterministically; recover via `lk:recover --dry-run/--apply
  --limit --from=dlq|retry` (bounded, never automatic mass replay).
- Integration health: `GET /api/health/integration` (Redis, consumer, bootstrap,
  freshness 24h, queue depths; never gates reads). Durable `lk_sync_runs` ledger
  for started/finished/status/counts/error. See `docs/integrations/edo-runbook.md`
  (example cron + alerts + rollback; schedule not installed) and
  `docs/integrations/edo-lk-contract-status.md` (LK contract SHA blocked stage).
- Recovery for a 406-mismatched EDO queue (broker already has it with stale
  arguments): `CONFIRM_EDO_QUEUE_RESET=I_UNDERSTAND_QUEUED_EVENTS_WILL_BE_LOST
  pnpm --filter @edo/api lk:queues:reset` (EDO queues only, never LK objects).

## Quality

- `pnpm lint` · `pnpm test` (turbo builds workspace deps first) · `pnpm build`
- Generation drift: `pnpm --filter @edo/api api:generate` +
  `pnpm --filter @edo/lk-client generate` must leave a clean tree
  (prettier is pinned for reproducible Orval output).
- E2E: `pnpm test:e2e` (Playwright, dev-bypass JWT only).
- CI (`.github/workflows/ci.yml`) is a **manual** quality tool (`workflow_dispatch`)
  with its own disposable MariaDB + Redis + RabbitMQ; it never touches shared LK
  containers. Destructive fault-injection uses only CI isolated services, never
  the shared LK broker (local retry tests use isolated `edo.lk-reference-sync.test.*`
  queues).

See `docs/architecture/overview.md` and `docs/decisions/ADR-002-lk-master-data-sync.md`.
