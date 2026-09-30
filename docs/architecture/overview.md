# Architecture overview

## Topology

Modular monolith inside the company ecosystem (`apps/api` + `apps/web`), shared generated client in `packages/api-client`, compact LK client in `packages/lk-client` (backend-only).

```
LK (lk.sps38.pro, source of truth)
  |-- snapshot: GET /api/internal/edo/v1/* (S2S Bearer) --> LkReferenceSyncService
  |-- changes: RabbitMQ topic lk.events --> edo.lk-reference-sync --> LkEventHandler
  v
EDO MariaDB local projection (lk_employees/lk_locations/lk_positions/lk_departments)
  -> NestJS (Fastify) domain modules
  -> OpenAPI (/api-json)
  -> Orval (`pnpm api:generate`)
  -> generated TanStack Query hooks (`@edo/api-client`)
  -> React (TanStack Router) dashboard / employees
```

No runtime direct DB access to LK. No full LK OpenAPI import. Frontend never calls LK.

## Frontend

- React + Vite + TypeScript, Tailwind, shadcn-style base in `packages/ui` themed to Pencil tokens.
- TanStack Router (real URL routes `/`, `/employees`, `/employees/$employeeId`; back/forward + deep links work), TanStack Query (generated hooks only), TanStack Table for lists, RHF + Zod for forms.
- `src/app/` (router + shell), `src/pages/`, `src/components/`, `src/lib/`.
- Auth: in-memory access JWT only (`lib/auth-token.ts` + `lib/auth-context.tsx`), refresh via configured `VITE_AUTH_REFRESH_URL` through HttpOnly cookie. Dev fallback `dev-demo-token` only with `VITE_ALLOW_INSECURE_DEV_AUTH=true` in dev. `GET /api/v1/me` (`lib/me.ts`) for UI decisions only; backend re-checks every action.
- No direct fetch/axios in components; no hand-written API DTO duplicates; imports via `@edo/api-client` / `@edo/ui` (never `/src/...` deep paths).

## Backend

- NestJS + Fastify, REST under `/api/v1`, Swagger/OpenAPI with `@ApiOperation(operationId)`/response/error/enums.
- Thin controllers, logic in domain services. Modules: employees, documents, dashboard, health (live/ready), auth (HS256 JWT + EDO rules 20000–20009), me, audit, ocr (RabbitMQ), storage, redis (cache/locks), rabbitmq (shared broker), lk-sync, lk-events.
- Auth: `JwtService` verifies HS256 with shared `JWT_SECRET`, pinned alg, `JWT_ISSUER=lk-auth-service`, exp checked, fail closed. `JwtAuthGuard` (global) + `AccessRuleGuard` (`@RequireAccessRule`) + `resolveLocationScope`/`isLocationAllowed` (key presence via `hasOwnProperty`).
- Config/env validation via zod (`env.validation.ts`); root `.env` loaded explicitly (never cwd-dependent). Production fails closed on placeholder secret / dev bypass.
- Prisma models: EDO domain (Employee, DocumentType, Document, DocumentVersion, Task, AuditLog with `LK_REFERENCE_SYNCED`/`LK_EVENT_APPLIED`) + LK projection (`LkEmployee/LkLocation/LkPosition/LkDepartment/LkProcessedEvent`, tables `lk_*`). JSON only for ocrRaw/integration payload/audit before-after/metadata. Migrations only. No runtime seed fallback: DB error → 5xx, empty DB → []. Seed only via `db:seed`.
- Health: `GET /api/health/live` (process) vs `GET /api/health/ready` (MariaDB + RabbitMQ; Redis reported, optional).
- Correlation-id + structured errors.

## Contracts & generation

- `apps/api/openapi.json` is checked in after `pnpm --filter @edo/api openapi:export`.
- Orval (`orval.config.ts`) reads it into `packages/api-client/src/generated/` with axios + react-query mutator. `pnpm api:generate` regenerates; CI fails on drift (`git diff --exit-code`).
- LK narrow spec pinned at `packages/lk-client/openapi/edo.json` (copy of LK `next/openapi/edo.json`); `packages/lk-client` contains only those 4 endpoints. CI pins the spec version.

## Integrations (adapters, not implementations)

- `OcrService` interface (external OCR, async upload → metadata → RabbitMQ `edo.ocr.requested.v1` → status, no long HTTP waits).
- `StorageService` S3-compatible (MinIO local), binary never in MariaDB, Document->DocumentVersion chain.
- LK sync: `LkReferenceSyncService` + `pnpm --filter @edo/api lk:sync` (idempotent, cursor-paginated, soft deletes preserved). Events: `LkEventHandler`/`LkEventConsumer` (idempotent by `eventId`, malformed/unknown-version acked, transient errors requeued). Full snapshot required periodically (LK event coverage is partial — see ADR-002).
- 1C ERP, signing rules, workflow rules: backend is source of truth (stage/docs/actions/blockers); frontend renders what backend returns, no `if (country===...)` hardcode.

## Background jobs

Shared RabbitMQ (`RABBITMQ_URL` — the shared LK broker, exchange `lk.events`, EDO-owned queue `edo.lk-reference-sync` + `.retry`/`.dlq`/`.dlx`) is the primary queue; shared LK Redis (`REDIS_URL`) is cache/locks/ephemeral only (EDO keys under `edo:*`). No BullMQ. EDO never runs its own MariaDB/Redis/RabbitMQ: local dev uses the shared LK containers (see README local development); CI uses its own disposable MariaDB service.
