# Architecture overview

## Topology

Modular monolith inside the company ecosystem (`apps/api` + `apps/web`), shared generated client in `packages/api-client`.

```
MariaDB/seed or fixture
  -> NestJS (Fastify) domain modules
  -> OpenAPI (/api-json)
  -> Orval (`pnpm api:generate`)
  -> generated TanStack Query hooks
  -> React dashboard / employees
```

## Frontend

- React + Vite + TypeScript, Tailwind, shadcn-style base in `packages/ui` themed to Pencil tokens.
- TanStack Router (code-based), TanStack Query (generated hooks only), TanStack Table for lists, RHF + Zod for forms.
- `src/app/`, `src/pages/`, `src/features/`, `src/entities/`, `src/components/`, `src/lib/`. No dumping into `components/`+`hooks/`.
- Auth: in-memory access JWT only (`lib/auth-token.ts` + `lib/auth-context.tsx`), refresh via configured `VITE_AUTH_REFRESH_URL` through HttpOnly cookie. Adapter boundary — no invented auth contract, no username/password form.
- No direct fetch/axios in components; no hand-written API DTO duplicates.

## Backend

- NestJS + Fastify, REST under `/api/v1`, Swagger/OpenAPI with `@ApiOperation`/response/error/enums.
- Thin controllers, logic in domain services. Planned modules: employees, documents, document-review, requirements, workflows, tasks, signing, ocr, integrations, notifications, audit, dashboard.
- First slice: `health`, `dashboard` (seed/demo deterministic data via real endpoint), `employees` (list/detail).
- Config/env validation, Prisma (provider mysql = MariaDB), JWT guard abstraction (issuer/JWKS from env), Redis/BullMQ infrastructure (queues module, OCR/notifications/expiry/generation later), correlation-id + structured errors.
- Prisma models: Employee, DocumentType, Document, DocumentVersion, Task, AuditLog (actorId/action/entityType/entityId/before/after/correlationId). JSON only for ocrRaw/integration payload/audit before-after/metadata. Migrations only.

## Contracts & generation

- `apps/api/openapi.json` is checked in after `pnpm --filter @edo/api openapi:export`.
- Orval (`orval.config.ts`) reads it into `packages/api-client/src/generated/` with axios + react-query mutator. `pnpm api:generate` regenerates; CI fails on drift.

## Integrations (adapters, not implementations)

- `OcrService` interface + TODO boundary (external OCR, async upload->job->result->status).
- `StorageService` S3-compatible (MinIO local), binary never in MariaDB, Document->DocumentVersion chain.
- `AuthGuard` validates JWT via env JWKS/issuer; exact external auth API plugged by config.
- 1C ERP, signing rules, workflow rules: backend is source of truth (stage/docs/actions/blockers); frontend renders what backend returns, no `if (country===...)` hardcode.

## Background jobs

Redis + BullMQ `QueuesModule` wired at boot; first slice proves connectivity. Future: OCR, notifications, expiry, integrations, retries, generation.
