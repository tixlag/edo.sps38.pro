# Candidate Documents Stage Breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Break down candidate document uploading in LK (Adaptation and Candidate Chat) into numbered stages ("Этап 1", "Этап 2"...) with double-ring donut status diagrams (inner = required, outer = additional), preserving decoding input fields with speedup incentive notice, and multi-page camera support.

**Architecture:** 
1. EDO API exposes `stageDetails: { stage: number | null; category: "required" | "additional" }[]` on `CatalogDocumentTypeDto`.
2. LK Frontend computes stage progress with cross-stage crediting and renders `StageDonutRing` double-ring charts.
3. LK `DocumentsModal` and `CandidateDocumentsPanel` use the stage breakdown with clean headers (no legend), multi-page photo uploading, and decoding input fields.

**Tech Stack:** TypeScript, React, Fastify/NestJS, TanStack Query, TailwindCSS, SVG.

---

### Task 1: Backend EDO - Expose Stage Details with Categories in Catalog

**Files:**
- Modify: `apps/api/src/documents/dto/document.dto.ts`
- Modify: `apps/api/src/documents/document-catalog.service.ts`
- Test: `apps/api/test/document-catalog.spec.ts`

- [ ] **Step 1: Write test for `stageDetails` with category in catalog**
- [ ] **Step 2: Run test to verify failure**
- [ ] **Step 3: Add `CatalogDocumentStageCategoryDto` and populate `stageDetails` in `document-catalog.service.ts`**
- [ ] **Step 4: Run test to verify pass**
- [ ] **Step 5: Regenerate API client (`pnpm api:generate`)**
- [ ] **Step 6: Commit backend changes**

---

### Task 2: LK Frontend - Stage Progress Calculation & Cross-Stage Crediting

**Files:**
- Modify: `public_next/src/edo-openapi/candidate-api.ts`
- Create: `public_next/src/features/candidate-documents/utils/stage-progress.ts`
- Test: `public_next/src/features/candidate-documents/utils/stage-progress.spec.ts`

- [ ] **Step 1: Write unit tests for stage grouping, required/additional separation and cross-stage crediting**
- [ ] **Step 2: Run test to verify failure**
- [ ] **Step 3: Implement `stage-progress.ts` calculation**
- [ ] **Step 4: Run test to verify pass**
- [ ] **Step 5: Commit stage progress logic**

---

### Task 3: LK Frontend - Double-Ring Donut Chart Component (`StageDonutRing`)

**Files:**
- Create: `public_next/src/features/candidate-documents/components/stage-donut-ring.tsx`
- Test: `public_next/src/features/candidate-documents/components/stage-donut-ring.test.tsx`

- [ ] **Step 1: Write component tests for `StageDonutRing` (rendering SVG arcs for inner required and outer additional)**
- [ ] **Step 2: Implement `StageDonutRing`**
- [ ] **Step 3: Verify tests pass**
- [ ] **Step 4: Commit component**

---

### Task 4: LK Frontend - Update DocumentsModal & DocumentPanel

**Files:**
- Modify: `public_next/src/sections/adaptation/components/documents-modal.comp.tsx`
- Modify: `public_next/src/sections/adaptation/components/document-panel.comp.tsx`
- Modify: `public_next/src/sections/adaptation/components/documents-list.comp.tsx`

- [ ] **Step 1: Update `DocumentsModal` header to use `StageDonutRing` for each stage without legend, and document chips for active stage**
- [ ] **Step 2: Update `DocumentPanel` with multi-page photo capture and speedup incentive banner above decoding inputs**
- [ ] **Step 3: Update `DocumentsList` to group items by stage**
- [ ] **Step 4: Run existing adaptation tests to ensure no regressions**
- [ ] **Step 5: Commit modal updates**

---

### Task 5: LK Frontend - Candidate Chat Widget with Stage Donut Rings

**Files:**
- Modify: `public_next/src/features/candidate-documents/candidate-documents-panel.tsx`
- Modify: `public_next/src/chats/pages/candidate-chat.page.tsx`

- [ ] **Step 1: Replace raw `<details>` in candidate chat with stage-based widget showing `StageDonutRing` for each stage**
- [ ] **Step 2: Wire up "Загрузить документы Этапа N" to open `DocumentsModal`**
- [ ] **Step 3: Run candidate chat tests**
- [ ] **Step 4: Commit candidate chat updates**

---

### Task 6: End-to-End Validation & Build Verification

- [ ] **Step 1: Run full test suite in `edo.sps38.pro` (`pnpm test`, `pnpm build`)**
- [ ] **Step 2: Run test suite in `lk.sps38.pro`**
- [ ] **Step 3: Verify UI in browser across mobile and desktop viewpoints**
