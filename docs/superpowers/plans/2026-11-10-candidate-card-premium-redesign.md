# Candidate Card Premium Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the candidate workspace card (`CandidateWorkspacePage` and related components) into a premium enterprise SaaS interface (Linear/Stripe aesthetic), eliminating stage title and counter duplications, streamlining the right-side stage accordion and document cards, refining the left management panel, and polishing the central communication feed without altering any business logic or backend contracts.

**Architecture:** 
1. Refactor `StageRing` to support `variant="inline"` (double-ring SVG only with accessible tooltip) while preserving `variant="card"` for `ReviewPage`.
2. Redesign `CandidateStageAccordion` to eliminate duplicate title/counters: single horizontal row with double-ring diagram on the left, stage title once, and expansion chevron on the right.
3. Streamline `CandidatePreviousDocumentCard` to remove nested-box clutter while keeping all preview, ERP data, requisites, and review actions.
4. Clean up `CandidateWorkspacePage` right panel: remove redundant large "Документы (N)" header and "Подтверждено 2 из 2" counter, keep subtle upload entry point, display stages directly.
5. Polish `CandidateManagement` left panel: remove redundant name/status cards, organize into clean semantic groups with elegant typography, copy buttons, and status timeline.
6. Polish `CandidateChat` and `CandidateChatEvents` in center column: clear visual distinction between chat messages and system events, refined message composer.
7. Update `CandidateStageAccordion.spec.tsx` and run all tests, build, and lint checks.
8. Perform visual browser verification at 1920x1080 and 1440x900 resolutions, and create screenshots.

**Tech Stack:** React 18, Vite, TypeScript, Tailwind CSS, TanStack Router, `@edo/ui`, `@edo/api-client`, Lucide Icons, Vitest.

---

### Task 1: Refactor `StageRing` for Inline and Card Variants

**Files:**
- Modify: `apps/web/src/components/StageRing.tsx`
- Test: `apps/web/src/components/CandidateStageAccordion.spec.tsx`

- [ ] **Step 1: Update `StageRing` props and rendering to support `variant?: "card" | "inline"`**
  - Add `variant?: "card" | "inline"` to `StageRing` props (default `"card"`).
  - In `variant="inline"`, render a compact 32x32px or 36x36px double-ring circle with center icon and tooltip anchor.
  - Omit `<strong className="...">{label}</strong>` and `<span>{completedCount}/{totalCount}</span>` when `variant === "inline"`.
  - Maintain all keyboard accessibility (`tabIndex={0}`, `onKeyDown`, `aria-describedby`, Escape to dismiss tooltip, `aria-label`).
  - Maintain existing 2-ring semantics (outer = additional, inner = required), colors, and `StageTooltip`.

- [ ] **Step 2: Run web tests to verify existing `StageRing` tests pass**
  Run: `pnpm --filter @edo/web test src/pages/ReviewPage.spec.tsx`

---

### Task 2: Redesign `CandidateStageAccordion` Header and Structure

**Files:**
- Modify: `apps/web/src/components/CandidateStageAccordion.tsx`
- Test: `apps/web/src/components/CandidateStageAccordion.spec.tsx`

- [ ] **Step 1: Redesign the Accordion Header**
  - Layout: `[Двойная круговая диаграмма]  Этап 1                      [⌃]`
  - Render title once.
  - Do not render duplicate `1/1` or `1 из 1` counters in the header.
  - Position `StageRing` (variant="inline") on the left of title on the same horizontal line.
  - Ensure the whole row functions as an accordion trigger while diagram tooltip is accessible via hover and keyboard.
  - Show Chevron indicator on the right rotating 180deg when open.
  - Fallback when `!progress`: show subtle badge with stage number or icon.

- [ ] **Step 2: Streamline expanded stage content**
  - Remove redundant nested borders/cards between stage and documents.
  - Clean section headers for "Обязательные" and "Дополнительные" (11px uppercase tracking-wider).
  - Clean vertical spacing (`space-y-2.5`).

- [ ] **Step 3: Update `CandidateStageAccordion.spec.tsx`**
  - Update tests to reflect the new header structure without duplicate counters.
  - Verify that opening/closing and review callbacks work.

- [ ] **Step 4: Run tests**
  Run: `pnpm --filter @edo/web test src/components/CandidateStageAccordion.spec.tsx`

---

### Task 3: Streamline `CandidatePreviousDocumentCard`

**Files:**
- Modify: `apps/web/src/components/CandidatePreviousDocumentCard.tsx`
- Test: `apps/web/src/components/CandidatePreviousDocumentCard.spec.tsx`

- [ ] **Step 1: Refactor Document Card styling to eliminate nested box clutter**
  - In `isCompact` mode: sleek, low-profile row with subtle rounded background (`bg-[var(--muted)]/40 hover:bg-[var(--muted)]/70`), file icon, title, status badge, and "Открыть документ".
  - In expanded mode: clean card with soft border (`border-[var(--border)]/70 bg-[var(--card)]`), clear title + status badge header.
  - Rejection reason banner: clean styled alert with return reason.
  - ERP document block: seamless container with thumbnail on the left, ERP source badge, expiry date, requisites pills, and "Открыть документ" button.
  - Action footer: current version info + "Проверить документ" primary action button.

- [ ] **Step 2: Run test suite**
  Run: `pnpm --filter @edo/web test src/components/CandidatePreviousDocumentCard.spec.tsx`

---

### Task 4: Redesign Right Panel in `CandidateWorkspacePage`

**Files:**
- Modify: `apps/web/src/pages/CandidateWorkspacePage.tsx`
- Test: `apps/web/src/pages/CandidateWorkspacePage.spec.tsx`

- [ ] **Step 1: Simplify Right Panel Header and Content**
  - Remove large "Документы (N)" header and the inconsistent "Подтверждено 2 из 2" progress paragraph.
  - Clean, understated header bar: title "Документы" + subtle secondary button for "Загрузить" (with upload icon), preserving the exact navigation callback.
  - Mobile close button (`X`) preserved.
  - Stages rendered directly as clean accordion list without extra nested wrappers.

- [ ] **Step 2: Polish Candidate Center Header**
  - Sleek card header with modern typography, status badge, citizenship badge, reemployment badge.
  - Concise metadata line (position, object, manager with LkLink, mentor).
  - Breadcrumbs at top polished with arrow and candidate name.

- [ ] **Step 3: Run web tests**
  Run: `pnpm --filter @edo/web test src/pages/CandidateWorkspacePage.spec.tsx`

---

### Task 5: Polish Left Panel (`CandidateManagement`)

**Files:**
- Modify: `apps/web/src/components/CandidateManagement.tsx`
- Test: `apps/web/src/components/CandidateManagement.spec.tsx`

- [ ] **Step 1: Streamline action buttons and remove redundant cards**
  - Action buttons: prominent "Изменить статус" button + secondary "Редактировать данные" and "Повторный приём".
  - Group "Личные данные" and "Назначение ERP" with clean section dividers and crisp definition lists (`<dl>`), removing unnecessary double-bordered cards.
  - Keep phone copy button, LkLink for manager, and status badge.
  - Refine "История статусов" timeline: sleek vertical track, status dots, formatted timestamps, and clean comment callouts.

- [ ] **Step 2: Run CandidateManagement tests**
  Run: `pnpm --filter @edo/web test src/components/CandidateManagement.spec.tsx`

---

### Task 6: Polish Center Panel (`CandidateChat` & `CandidateChatEvents`)

**Files:**
- Modify: `apps/web/src/components/CandidateChat.tsx`
- Modify: `apps/web/src/components/CandidateChatEvents.tsx`
- Test: `apps/web/src/components/CandidateChat.spec.tsx`

- [ ] **Step 1: Refine chat message bubbles and system events**
  - Message bubbles:
    - Incoming (candidate): soft neutral background, crisp borders, channel badge, author, time, attachment download buttons.
    - Outgoing (operator): subtle primary tint, right-aligned, channel badge, author, time.
  - System events: elegant, centered, unobtrusive event cards with appropriate icons.
  - Filter tabs: clean active indicator, badges with counts, auto-refresh pulse dot.
  - Message composer: refined layout with channel selector, template selector, clean textarea, file upload button, LK link button, and accent send button.

- [ ] **Step 2: Run CandidateChat tests**
  Run: `pnpm --filter @edo/web test src/components/CandidateChat.spec.tsx`

---

### Task 7: Full Verification (Build, Lint, Tests, Browser Verification)

**Files:**
- None (verification)

- [ ] **Step 1: Run full web tests**
  Run: `pnpm --filter @edo/web test`

- [ ] **Step 2: Run web build and lint**
  Run: `pnpm --filter @edo/web build && pnpm --filter @edo/web lint`

- [ ] **Step 3: Visual inspection via browser**
  Inspect the candidate card in browser at:
  - 1920x1080
  - 1440x900
  Verify:
  1. First stage open, next closed.
  2. Stage with accepted ERP document.
  3. Stage with missing document.
  4. Multiple stages and long titles.
  5. Long message history.
  6. Document review dialog.
  Take screenshots for the final report.

---

### Task 8: Commit, Push and Create Draft MR

- [ ] **Step 1: Verify git status and commit changes with clear semantic messages**
- [ ] **Step 2: Push to `origin` and `gitlab` remotes**
- [ ] **Step 3: Create Draft MR on GitLab targeting `main` in `webdevs/edo.sps38.pro`**
- [ ] **Step 4: Generate comprehensive report with screenshots and details**
