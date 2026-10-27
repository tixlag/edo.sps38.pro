# Dashboard and document annotation implementation

Approved conversation plan, 2026-10-27. Base: GitLab main b546a8a.

## Binding requirements

- Work in this worktree; do not modify ERP/LK repositories. No deployment requested.
- Reviewers 20002 RU / 20011 IG work across ALL locations including NULL, without 20007/20008. 20009 sees both. Preserve separate own/guest authorization and non-review role policies.
- Candidate/document acceptance dashboard, department sections, manager filter and URL state. Every response collection uses the same permitted group/manager scope. Technical debug only 20009; business OCR details still 20010.
- Reviewer opt-in “Хочу премию”; administrator-managed, explicitly published versioned field catalogs independent of ERP catalog row IDs. Per document type/profile, including RU/UZ passport distinction.
- Separate annotation lifecycle DRAFT -> SUBMITTED -> ACCEPTED / CHANGES_REQUESTED, exact source version, one active author, optimistic revision, atomic audit. Finish after approval; never alter business data/delivery. No payout calculations.
- Oriented rectangles per visual text line, literal transcript, explicit line order; all fields answered or NOT_PRESENT/UNREADABLE before submission. Never auto-label with normalized business values.
- Server-authoritative source page hash/dimensions/frame, EXIF and PDF rotation. Immutable accepted revisions and published schemas. Source deletion blocks submission/export.
- Driver.js guided instruction with repeat/cleanup. Ordinary user copy never mentions dataset.
- Separate offline Node exporter: accepted snapshots -> upright PNG pages + line crops + Paddle labels + JSONL provenance. Private artifacts ignored, never committed. No automatic training or Python/GPU dependencies in API.
- REST DTO -> OpenAPI -> generated @edo/api-client hooks; UI primitives @edo/ui and semantic tokens.
- Targeted tests, lint/build, isolated MariaDB migration verification. No GitHub Actions, e2e, Python OCR tests/inference, shared DB reset or infrastructure mutations.

## Task 1: Access and operational dashboard

Own access, dashboard, sidebar/routes and their tests. Remove geographic restrictions for review-capable principals on review operations, preserve group constraints in reads and transactional writes. Dashboard current live candidate documents only: IN_REVIEW documents/distinct candidates, current RETURNED, APPROVED+SIGNED, OCR_FAILED; current-status distribution; submittedAt weekly UTC; attention list; scoped own activity. Filters group/all and exact manager including unassigned/legacy names. Add exact current-status queue filtering without changing historical RETURNED semantics. Shared menu/route capabilities. Hide debug on API and UI while preserving working OCR permission. Update AGENTS policy.

## Task 2: Annotation API and catalog

Own Prisma schema/migrations and new annotation domain. Publish an API contract early in .cache/review-annotations/contract.md. New controller under /api/v1/annotations and /api/v1/annotation-catalogs; sources under document/version endpoint. DTOs operationId/responses/errors, authorization rechecked transactionally. Metadata and geometry validation; catalog drafts/suggestions/publication; author claim, revisioned save/submit/accept/return/reassign. Keep immutable submitted/accepted snapshots. Tests include concurrent claims, audit rollback, ERP refresh independence, after-approval completion and missing sources. Root alone changes generated API files and lockfile.

## Task 3: Annotation UI and Driver.js

Own standalone annotation components, annotation editor overlay and settings pages. Integrate into existing review workspace independently of business editability. Consume Task 2 generated hooks, no handwritten API DTOs/fetch. Early work can cover geometry helpers/overlay without API. Source orientation and transforms, pointer and keyboard editing, line text/order, all-fields completion, error drafts, claim conflicts, admin acceptance/catalog publication. Driver.js after opt-in/render, repeat and cleanup. Keep current visual system. Coordinate existing viewer/workspace files with Task 1 debug changes.

## Task 4: Offline exporter, integration and review

Root owns exporter package, lockfile, generation, plan/ledger, integration and verification. Use sharp, pdfjs-dist and @napi-rs/canvas direct pinned dependencies; canonical PDF render profile 200 DPI, bounds and byte/pixel limits. Read DB/S3 with operator credentials, accepted-only immutable snapshots, hash validation, affine OBB crop, lossless JSONL plus Paddle TSV and checksums. Unit/synthetic image/PDF tests. Split future train data by person/document. No daemon or HTTP crop processing.

## Acceptance

Cross-group data never returned; no location grants needed by reviewers; no unauthorized debug; URL filters and queue counts agree; catalog survives ERP refresh; one atomic annotation owner; concurrent saves return 409; source-version/schema snapshots remain immutable; after-approval edits affect annotation only; EXIF/PDF/zoom/rotation round trip; one text line per crop; export only accepted with correct hashes. Run fresh targeted and root TS test suites, lint, build and generated-client drift checks; independent review before integration.
