# ADR-002: LK master-data sync (local projection in EDO)

Date: 2026-09-29
Status: accepted

## Context

`lk.sps38.pro` owns employees, locations (objects), positions, departments
(and eventually organizations/divisions). EDO needs this data for onboarding
workflows, permissions (object scope via `accessRules["20007"]`), and UI, but
must not become a second writer and must not couple request paths to LK
availability. Full LK OpenAPI import and direct LK DB access are forbidden.
LK publishes a narrow internal API + RabbitMQ events (see
`lk.sps38.pro/docs/integrations/edo.md` and `edo-consumer-guide.md`).

## Decision

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
  `nextCursor: null`, persist cursor per page). CLI `pnpm --filter @edo/api lk:sync`.
- **Changes**: RabbitMQ durable topic `lk.events`, EDO-owned durable queue
  `edo.lk-reference-sync`, bindings `lk.reference.*.*.v1`. Published today:
  `employee/position/department.upserted.v1`; location/deleted keys reserved.
  Envelope `{eventId, eventType, version: 1, occurredAt, source: "lk.sps38.pro",
  payload}`. Consumer is idempotent via `lk_processed_events.eventId`
  (same DB transaction as the projection upsert), acks malformed/unknown
  versions, requeues transient failures.
- **Auth**: S2S `LK_EDO_INTERNAL_TOKEN` (`Authorization: Bearer`), never user
  JWT, never frontend. User JWT (HS256, `lk-auth-service`) drives EDO access
  rules 20000–20009 separately.
- **No direct LK DB access, no full LK OpenAPI import, no LK business-logic copy.**
- **Soft state preserved**: `fired`/`deleted` are states, not physical deletes.

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
