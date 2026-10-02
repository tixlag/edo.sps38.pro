# EDO ↔ LK reliability contract status

EDO branch: `fix/lk-integration-reliability`.
EDO baseline of this iteration: `f025b8ae1c32503a0c100aab4bb5bf97dfa0a196`;
previous published result: `76ced800c491f70dfa4dccc31fba58c81dd32949`.

## Two different blockers (do not conflate)

**Blocker A — wrong checkout path in the previous report (RESOLVED, investigated).**
The previous report claimed "LK checkout absent" based on the empty
`../lk.sps38.pro` and `/home/tixlag/orca/workspaces/lk.sps38.pro` directories.
The correct local path is `/home/tixlag/PhpstormProjects/lk.sps38.pro`.
The absence verdict was an artifact of looking in the wrong place, NOT proof
that LK lacks a contract. This iteration studies LK at its real location.

**Blocker B — no monotonic entity revision in the LK source contract (CONFIRMED,
by design of the source).** LK `docs/integrations/edo.md` (studied SHAs below)
states explicitly: `updatedAt` is always `null` for Employee/Location/Reference;
"`occurredAt` события и время получения не заменяют timestamp изменения
источника"; "не используйте `occurredAt` или `updatedAt` как версию сущности:
LK пока не публикует монотонную версию". `eventId` is uuid7 (identity +
rough order, NOT an entity version). EDO must not invent ordering from
occurredAt/receive-time/eventId/local counters. This is a source-side gap with
a precise handoff (below), not an EDO implementation choice.

## Studied LK SHAs (read-only; LK working tree untouched)

- LK working copy: `/home/tixlag/PhpstormProjects/lk.sps38.pro`, branch `main`,
  local HEAD `fd92f9355` ("feat(surveys): scope author access…"), tracking
  `origin` (= `https://github.com/websps/lk.sps38.pro.git`, NOT tixlag).
- `fork` remote (= `https://github.com/tixlag/lk.sps38.pro.git`): `fork/main`
  = `43fe698b0` — this is the "GitHub tixlag main" from the task brief.
  Local `main` tracks websps `origin/main` and was 6 commits behind it
  (`fd92f9355..origin/main`); same-name mains are not the same ref.
  No reset/rebase/fetch was performed in LK; its uncommitted login-audit
  changes were left alone.
- Contract sources studied via read-only `git show` (never the dirty working
  files): `docs/integrations/edo.md`, `docs/integrations/edo-consumer-guide.md`
  (last touched `99e8e012c`/`ae4a2219c`), `next/openapi/edo.json`,
  `EdoMasterDataController`/`EdoMasterDataService` (cursor = base64url
  `{v:1, code1c}`, limit+1 lookahead, invalid cursor → 400),
  `EdoEventService` (uuid7 eventId, version 1, full-DTO payload, outbox write
  requires the master-data transaction).
- There is NO file named `edo-reliability-contract.md` at local HEAD nor at
  `fork/main` (verified via `ls-tree` on both). The reliability contract lives
  in `edo.md` + `edo-consumer-guide.md` (quoted below). The narrow spec is
  byte-identical across local HEAD, `fork/main`, and EDO's
  `packages/lk-client/openapi/edo.json` (4 paths, no `sourceRevision` field
  anywhere — absence of the field is a spec fact, not an EDO assumption).

## What the LK source contract guarantees (pinned to the SHAs above)

- Delivery LK → EDO queue is at-least-once ("Доставка как минимум один раз;
  EDO должен дедуплицировать по `eventId`"); outbox row is written in the
  master-data transaction (rollback removes it); dispatcher delivers to
  `lk.events`. No atomicity between the new-DB and legacy-DB writes of the 1C
  import; location moves via legacy PDO have no guaranteed outbox write.
- Single-transaction event handling: version check → inbox `eventId` → upsert →
  commit → ack; duplicate `eventId` → ack without change; transient → leave
  for retry. No global order reliance.
- Tombstones via flags (`fired:true` / `deleted:true` upserts, never physical
  deletes); vanished merge codes are eliminated by full reconciliation.
- Snapshot: opaque cursor from `code_1c`, strict order, finish at
  `nextCursor: null`; empty page with null cursor is valid; `updated_after`
  absent. Locations are snapshot/reconciliation-first; uncovered write paths
  (legacy imports, location moves) REQUIRE periodic full reconciliation.
- Cooperative rollout: `EDO_EVENTS_ENABLED=false` → create EDO queue/bindings
  → enable → snapshot → live consumer; never delete the queue before
  reconciling.

## What EDO implements against that contract (this branch)

Unversioned transitional mode, precisely bounded:
- Same-`eventId` dedup (inbox PK, P2002 verified by re-read) — proven.
- Different `eventId`s of one entity: last-writer-wins (pinned by an honest
  regression test asserting the stale final state, NOT as correctness).
- `sourcePresent`/`deleted` marks only from fenced full snapshots; a late event
  may re-set `sourcePresent=true` on a row a snapshot already marked missing —
  known limit, repaired by the next snapshot. No `occurredAt` gating (the
  source forbids it).
- Equal-revision conflict detection and newer-wins need a source revision and
  are NOT implemented (nothing to compare; big-decimal-safe comparison will
  land with the revision field).

## Handoff to the LK agent (fields, rules, examples needed)

To close Blocker B, LK should publish (as `edo-reliability-contract.md` or an
amendment to `edo.md` + spec), with a contract SHA EDO can pin:
1. A per-entity monotonic revision: name, type and comparison rule. If the
   revision is a DECIMAL STRING (e.g. 1C sequence numbers), the contract must
   state NUMERIC comparison explicitly: EDO will compare without `Number()`
   and without plain lexicographic order (both misorder e.g. "9" vs "10") —
   arbitrary-precision integer comparison after format validation. Opaque
   lexicographically-comparable strings or `uint64` are equally acceptable
   if the contract says so; what is NOT acceptable is an unspecified order.
   The revision must bump on EVERY write path that feeds the compact DTO
   (including the currently uncovered location-move and legacy-import paths,
   or an explicit list of paths that do NOT bump it).
2. Event/snapshot carriage: `payload.revision` on all three upserted envelopes
   AND `*.revision` on all four HTTP DTOs (null only during a dated transition
   window, with the switchover date in the contract). Cutover rule (confirm
   exact wording): an UNVERSIONED event/snapshot row must NEVER overwrite a
   row that already carries a revision — after cutover, absent revision means
   "unknown", not "newest" and not "zero". EDO will treat unversioned-after-
   versioned as a contract violation (poison DLQ + alert), never as an apply.
3. Application semantics EDO must implement (confirm exact wording):
   newer → apply; older → drop without rollback; equal + byte-equal payload →
   idempotent ok; equal + differing payload → conflict signal (DLQ + alert,
   never silent overwrite); comparison + write atomic under concurrency.
   Normalization of payload bytes for the equal-comparison must be part of
   the contract (field order, whitespace, null-vs-absent).
4. Tombstone/reappearance rules with the revision: does a reappearing `code1c`
   reuse or bump the revision; `code1c`/`uuid` change, merges and splits
   (which code survives, what event the vanished code produces, if any);
   whether a full snapshot may ever LOWER a stored revision.
5. Fixtures at the contract SHA: a 3-event sequence (newer→older→equal-conflict)
   per entity with expected final states, plus a snapshot-then-stale-event case,
   plus an unversioned-after-versioned case.
6. Switchover plan: EDO ships revision-aware handling first (unversioned rows
   handled as today while no revision exists anywhere for the entity);
   LK starts populating; then LK flips a contract flag. Rollback is a
   VERSIONED protocol step, not "stop populating": if LK stops sending
   revisions after cutover, EDO keeps rejecting unversioned writes to
   versioned rows (fail closed with DLQ + alert) instead of silently resuming
   last-writer-wins — resuming it requires a new contract SHA that explicitly
   re-allows unversioned writes, followed by a full reconciliation.

Until that SHA exists, EDO stays in the bounded unversioned mode above and the
integration is NOT declared fully reliable (known windows: stale overwrite,
DLX-unroutable drop — each documented with its repair path).
