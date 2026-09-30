# ADR-002: LK master-data sync (local projection in EDO)

Date: 2026-09-29
Status: accepted (amended 2026-09-30: marker-only reconciliation, Redis lock, delayed retry;
amended 2026-10-01: shared LK infra, fail-closed coordination, no shadow containers)

## Context

`lk.sps38.pro` owns employees, locations (objects), positions, departments
(and eventually organizations/divisions). EDO needs this data for onboarding
workflows, permissions (object scope via `accessRules["20007"]`), and UI, but
must not become a second writer and must not couple request paths to LK
availability. Full LK OpenAPI import and direct LK DB access are forbidden.
LK publishes a narrow internal API + RabbitMQ events (see
`lk.sps38.pro/docs/integrations/edo.md` and `edo-consumer-guide.md`).

## Decision

- **Shared local infrastructure, isolated data**: local development (and
  production) uses the SHARED LK containers — one MariaDB server (`lk_mariadb`),
  one Redis, one RabbitMQ broker — but EDO data stays logically isolated: a
  separate MariaDB database `edo` (dedicated user, rights on `edo.*` only;
  migrations/seed/tests refuse any other database name), Redis keys under
  `edo:*`, and EDO-owned RabbitMQ objects only (`edo.lk-reference-sync` +
  `.retry`/`.dlq`/`.dlx`; `lk.events` is LK-owned and only asserted compatible).
  EDO runs no MariaDB/Redis/RabbitMQ of its own. Same container/server != same
  application database. CI (manual) keeps its own disposable MariaDB.

- **Source of truth**: LK/1C. EDO keeps a local read-model only:
  `LkEmployee` (`lk_employees`, key `code1c`), `LkLocation` (`lk_locations`,
  keys `code1c` + numeric `locationId` for `accessRules`), `LkPosition`
  (`lk_positions`), `LkDepartment` (`lk_departments`). Table names carry the
  `lk_` prefix; business entities reference stable external keys
  (e.g. `EmployeeOnboarding.lkEmployeeCode1c`), never copy LK internals.
- **Bootstrap/reconciliation**: snapshot API
  `GET /api/internal/edo/v1/{employees,locations,positions,departments}`
  via compact backend-only `packages/lk-client` (generated ONLY from
  `openapi/edo.json`, never the full LK spec). Order: locations → positions →
  departments → employees (opaque cursor pagination, `limit` 1–1000, finish on
  `nextCursor: null`; the cursor is held in memory only and advanced after each
  page is fully written — a crash restarts the whole employee snapshot from the
  start, which is safe because upserts are idempotent and each run uses a fresh
  `syncRunId`; `markMissing` runs only after the full pass succeeds).
  CLI `pnpm --filter @edo/api lk:sync`.
- **Changes**: RabbitMQ durable topic `lk.events`, EDO-owned durable queue
  `edo.lk-reference-sync` (+ DLX `edo.lk-reference-sync.dlx` + DLQ
  `edo.lk-reference-sync.dlq` + retry queue `edo.lk-reference-sync.retry`
  with `x-message-ttl=5000` and DLX back to the main queue), bindings
  `lk.reference.*.*.v1`. Published today:
  `employee/position/department.upserted.v1`; location/deleted keys reserved.
  Envelope `{eventId, eventType, version: 1, occurredAt, source: "lk.sps38.pro",
  payload}`. Consumer is idempotent via `lk_processed_events.eventId`
  (same DB transaction as the projection upsert). Permanent errors (invalid
  JSON/envelope, unsupported version, unknown routing key, eventType mismatch,
  invalid domain payload/ZodError) are poison: `nack(requeue=false)` → DLQ,
  logged with eventId/routingKey/reason only (never the full payload).
  Transient infra errors (MariaDB/network) use delayed bounded retry: publish
  to the retry queue with `x-retry-count+1` (TTL 5s → main), then ack the
  original — never a tight `nack(requeue=true)` hot loop. After 5 attempts the
  message goes to the DLQ. Delivery tags are acked only on the channel that
  delivered them; stale acks are ignored and redelivery is deduped via eventId.
  Reconnect uses bounded backoff 1s/2s/5s/10s/30s max + jitter with a single
  loop; after reconnect the topology (including the retry queue) is re-asserted
  and the consumer re-subscribed. Old channel/connection close events never
  clear a newer connection state (identity-checked). Graceful shutdown stops
  the loop.
- **Auth**: S2S `LK_EDO_INTERNAL_TOKEN` (`Authorization: Bearer`), never user
  JWT, never frontend. User JWT (HS256, `lk-auth-service`) drives EDO access
  rules 20000–20009 separately.
- **No direct LK DB access, no full LK OpenAPI import, no LK business-logic copy.**
- **Soft state preserved**: `fired`/`deleted` are states, not physical deletes.
- **Safe bootstrap (consumer disabled during snapshot)** — deployment order:
  1. `pnpm --filter @edo/api lk:topology` asserts exchange/queue/DLQ/retry/bindings
     without starting a consumer, so the queue starts accumulating live events.
  2. `pnpm --filter @edo/api lk:sync` runs in `SyncAppModule` (no live
     consumer module; `LK_EVENTS_CONSUME=0` forced before context creation),
     acquires the distributed reconciliation lock, performs the full snapshot,
     and marks missing rows ONLY after all four endpoints succeed.
  3. Boot the API: the consumer replays buffered events, then live mode.
  Parallel online full sync + live consumer is NOT safe (no reliable LK entity
  revision).
- **Periodic reconciliation (distributed pause/lock)** — REQUIRED, not optional
  (location events are not published yet; some legacy LK write paths have no
  events). Flow: `lk:sync` acquires `edo:lk-reconciliation-lock` in shared
  Redis via `SET NX PX 30s` with a random owner token (second concurrent sync
  exits non-zero); the live consumer checks the lock before APPLYING each event
  and waits (poll 1s, message stays unacked — no tight requeue loop) while the
  lock is held; buffered Rabbit events replay after release. The lock has a TTL
  so a crashed sync never blocks the consumer forever, a heartbeat renews the
  TTL only while the owner still holds it (`Lua compare-and-expire`), and
  release deletes only its own token (`Lua compare-and-del`). Snapshot failure
  skips `markMissing` but still releases the lock. Coordination is FAIL CLOSED:
  `lk:sync` refuses to run when shared Redis is unavailable (exit 3, no
  degraded no-op mode); a sync that loses lock ownership mid-snapshot aborts
  before `markMissing` (exit 1); the live consumer pauses event apply while the
  lock is held AND while Redis is unreachable (messages stay unacked within
  prefetch). CI (manual, disposable services) is the only environment without
  shared Redis; local dev and production MUST use it.
- **Reconciliation marking (marker-only)**: every snapshotted row is stamped
  `lastSeenSyncId=<syncRunId>` (employees also `sourcePresent=true`); after
  success, rows with `lastSeenSyncId IS NULL OR lastSeenSyncId <> <runId>` are
  marked — refs → `deleted=true`, employees → `sourcePresent=false` (never
  `fired`). No `code1c` lists are kept in memory. Partial failures never mark
  missing; empty snapshots skip marking for that table with a warning
  (especially `0` employees never wipes the staff).

## Consequences

- EDO works offline from LK after sync; LK outages degrade freshness, not availability.
- Events do NOT cover every LK write path (legacy object import, some manual
  edits, `EmployeeImportService` paths). Periodic full snapshot is REQUIRED,
  not optional, until LK closes the coverage gap. Location changes currently
  arrive only via snapshot.
- No monotonic entity version from LK (`updatedAt` is null); out-of-order
  handling is best-effort, reconciliation fixes divergence.
- `organization.code` is null (no stable code from LK); divisions have no
  authoritative directory yet — do not invent IDs from names.
- Queue binding should exist before snapshot so concurrent changes stay queued;
  EDO must agree on the reconciliation schedule + queue-lag monitoring with LK owners.
