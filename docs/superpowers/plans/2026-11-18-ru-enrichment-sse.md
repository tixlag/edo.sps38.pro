# RU Document Sync Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate repeated `POST /candidates/enrichment-batch` polling every 5 seconds by introducing SSE `ru-enrichment` notifications over existing SSE connections via Redis Pub/Sub, with 3 targeted fixes (prevent single fallback on missing ERP batch item, remove broken `lastPending` logic, automatic update of document history and card).

**Architecture:** A lightweight `RuEnrichmentNotificationsService` bridges background batch / priority lane completions to existing `DocumentEventsService` review streams via Redis Pub/Sub without cyclic NestJS dependencies. `DocumentEventsService` filters candidates by caller review permissions and pushes `ru-enrichment` SSE frames. Web client consumes `ru-enrichment` to invalidate React Query caches and clear pending sets without polling. A read-only `GET /candidates/enrichment-batch/status` endpoint provides rare safety checks for missed events.

**Tech Stack:** NestJS, Fastify, Prisma, MariaDB, ioredis (Pub/Sub), RxJS (SSE), React, TanStack Query, Orval.

---

### Task 1: Add Redis Pub/Sub Support to RedisService

**Files:**
- Modify: `apps/api/src/redis/redis.module.ts`
- Test: `apps/api/test/redis-pubsub.spec.ts`

- [x] **Step 1: Write test for RedisService publish and subscribe**
- [x] **Step 2: Run test to verify it fails**
- [x] **Step 3: Implement publish and lazy subscriber client in RedisService**
- [x] **Step 4: Run test to verify it passes**
- [x] **Step 5: Verify onModuleDestroy cleans up both clients**

---

### Task 2: Create RuEnrichmentNotificationsService

**Files:**
- Create: `apps/api/src/documents/ru-enrichment-notifications.service.ts`
- Modify: `apps/api/src/documents/documents.module.ts`
- Test: `apps/api/test/ru-enrichment-notifications.spec.ts`

- [x] **Step 1: Write failing test for RuEnrichmentNotificationsService**
- [x] **Step 2: Implement RuEnrichmentNotificationsService with publish and subscribe**
- [x] **Step 3: Register in DocumentsModule**
- [x] **Step 4: Run tests to verify clean serialization and error tolerance**

---

### Task 3: Fix ERP Batch Missing Item and Publish Notifications from Queue

**Files:**
- Modify: `apps/api/src/documents/ig-enrichment-queue.service.ts`
- Test: `apps/api/test/candidate-enrichment-batch-sync.spec.ts`

- [x] **Step 1: Write test cases in candidate-enrichment-batch-sync.spec.ts**
  - Missing batch item does NOT trigger single ERP request; marks RETRY
  - Batch completion publishes one event with READY / RETRY items
  - Failed publish does not mark successful jobs as RETRY
  - Lost lease does not appear in published items
  - Priority RU publishes single-item event; Priority IG does not publish
- [x] **Step 2: Run test to verify it fails**
- [x] **Step 3: Implement missing item check in ru-batch and publish notification after transaction**
- [x] **Step 4: Implement priority RU notification after single job transaction**
- [x] **Step 5: Run tests and verify all pass**

---

### Task 4: Connect ru-enrichment to DocumentEventsService with Permission Filtering

**Files:**
- Modify: `apps/api/src/documents/document-events.service.ts`
- Test: `apps/api/test/document-events.spec.ts`

- [x] **Step 1: Write test cases in document-events.spec.ts for ru-enrichment streaming**
  - Reviewer with RU access receives ru-enrichment
  - Reviewer without RU access receives nothing
  - Candidates filtered by candidateWhere and reviewGroupWhere("RU")
  - Owner-scoped stream does not receive ru-enrichment
- [x] **Step 2: Run test to verify it fails**
- [x] **Step 3: Implement notification subscription and scoped broadcast in DocumentEventsService**
- [x] **Step 4: Run tests to verify all pass**

---

### Task 5: Implement Read-Only GET Status Endpoint & Regenerate API Client

**Files:**
- Modify: `apps/api/src/documents/dto/candidate-enrichment.dto.ts`
- Modify: `apps/api/src/documents/candidate-enrichment.controller.ts`
- Modify: `apps/api/src/documents/ig-enrichment-queue.service.ts`
- Test: `apps/api/test/candidate-enrichment-batch-status.spec.ts`

- [x] **Step 1: Write test for GET /api/v1/candidates/enrichment-batch/status**
- [x] **Step 2: Implement DTOs, queue method, and controller endpoint**
- [x] **Step 3: Run test to verify it passes**
- [x] **Step 4: Regenerate api-client via pnpm api:generate**

---

### Task 6: Frontend SSE Transport and Query Invalidation

**Files:**
- Modify: `packages/api-client/src/document-events.ts`
- Modify: `apps/web/src/lib/document-events.ts`
- Test: `apps/web/src/lib/document-events.spec.ts`
- Test: `apps/web/src/lib/document-query-updates.spec.ts`

- [x] **Step 1: Write tests for event: ru-enrichment parsing and React Query invalidation**
- [x] **Step 2: Add onRuEnrichment callback and event parsing in api-client**
- [x] **Step 3: Add ru-enrichment invalidations in apps/web/src/lib/document-events.ts**
- [x] **Step 4: Provide local event subscriber for visible sync hook**
- [x] **Step 5: Run tests to verify invalidation of details, history, and review queues**

---

### Task 7: Refactor useVisibleRuDocumentSync

**Files:**
- Modify: `apps/web/src/lib/use-visible-ru-document-sync.ts`
- Test: `apps/web/src/lib/use-visible-ru-document-sync.spec.tsx`

- [x] **Step 1: Update unit tests in use-visible-ru-document-sync.spec.tsx**
  - Only one POST sent on page open
  - No repeated POST polling after 5, 10, 30s
  - READY event clears pending candidate
  - Initial POST response does not cause false refetch()
  - RETRY keeps candidate without loop
  - Fallback status GET reconciles missed events
- [x] **Step 2: Implement single POST + SSE event listener + GET status fallback**
- [x] **Step 3: Run tests and verify all pass**

---

### Task 8: Refactor useCandidateDocumentSync (Card RU Sync)

**Files:**
- Modify: `apps/web/src/lib/use-candidate-document-sync.ts`
- Test: `apps/web/src/lib/use-candidate-document-sync.spec.tsx`

- [x] **Step 1: Update tests for useCandidateDocumentSync**
  - RU candidates disable 5s refetchInterval when SSE is active
  - IG candidates retain 5s refetchInterval
  - Candidate details update on READY event
- [x] **Step 2: Implement RU refetchInterval adjustment and SSE listener**
- [x] **Step 3: Run tests and verify all pass**

---

### Task 9: Full Verification and GitLab MR

- [x] **Step 1: Run all backend tests**
- [x] **Step 2: Run all frontend tests**
- [x] **Step 3: Run pnpm lint and pnpm build**
- [ ] **Step 4: Check git status, commit with semantic commit message**
- [ ] **Step 5: Push to remotes and verify MR status (do not merge or deploy)**
