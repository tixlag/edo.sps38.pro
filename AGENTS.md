# AGENTS.md — rules for coding agents

This is a pnpm + Turborepo monorepo (`apps/web`, `apps/api`, `packages/*`). Read this before writing code.

## Stack (do not change)

- MariaDB only. Prisma `provider = "mysql"`. Never introduce PostgreSQL.
- Prisma is the ORM. DB changes ONLY via migrations in `prisma/migrations`.
- Frontend: React + Vite. Never Next.js.
- Backend: NestJS + Fastify adapter. REST + OpenAPI. Controllers thin; business logic in domain services.
- Do not add Kubernetes, Kafka, GraphQL, microservices frameworks.

## API contract flow (mandatory)

- Backend DTO/controller -> OpenAPI (`apps/api/openapi.json`) -> Orval -> frontend.
- Frontend API comes ONLY from `packages/api-client` generated TanStack Query hooks.
- `packages/api-client` is GENERATED — DO NOT EDIT. After any endpoint change run `pnpm api:generate`.
- Never write `fetch`/`axios` calls inside React components. Never hand-duplicate API DTO/types on frontend.
- Every public REST endpoint needs `@ApiOperation`, response DTO, error responses, enum schemas.

## Auth

- No custom username/password login. External unified auth service is the only IdP.
- Access JWT in React memory ONLY (`apps/web/src/lib/auth-token.ts`). NEVER localStorage/sessionStorage/IndexedDB.
- Refresh token in HttpOnly cookie; restore session via configured refresh endpoint adapter.
- Backend JWT guard/issuer/JWKS comes from environment only.

## Domain rules

- Workflow logic is backend-owned (stage, required docs, actions, blockers). Never hardcode `if (employee.country ...)` / `showDocument(...)` in frontend.
- Main entities (employees/documents/workflows/requirements) are relational, not JSON. JSON only for raw OCR, integration payload, audit before/after, metadata.
- Audit is core: log via `AuditService` with actorId/action/entityType/entityId/before/after/correlationId.
- Document binaries go to S3-compatible storage (MinIO local), never MariaDB. Documents are versioned (Document -> DocumentVersion N).
- OCR is an external service: use the `OcrService` adapter boundary, do not build an OCR engine or invent its contract. Async: upload -> metadata -> BullMQ job -> OCR -> status update, no long HTTP waits.
- No giant shared services/helpers. No premature universal abstractions.

## UI

- Pencil (`zabor.pen`) is visual truth. Do not restyle on your own.
- Never hardcode design hex (`#bf2026`, `#f3f4f6`) in code; use semantic tokens (`--primary`, `--background`, `--border`, ...).
- Reuse `packages/ui` + `apps/web/src/components` (AppSidebar, AppHeader, PageHeader, MetricCard, StatusBadge, EmptyState, DataTable, ActivityItem). Extend them, don't fork styles.

## Quality gates (must stay green)

- `pnpm install`, `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm test` work from repo root.
- Backend compiles; frontend has zero TS errors; Prisma migrations apply on clean MariaDB; OpenAPI exports; Orval client regenerates and frontend uses generated hooks; dashboard renders; collapsed/expanded sidebar work; employee endpoints respond; no JWT in persistent storage; production build passes.
