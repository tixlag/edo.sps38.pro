# EDO ↔ LK reliability contract status

Baseline: `f025b8ae1c32503a0c100aab4bb5bf97dfa0a196` (origin/main at task start).
LK checkout: sibling `../lk.sps38.pro` was absent/empty in this environment
(` /home/tixlag/orca/workspaces/lk.sps38.pro` empty, no git repo), so no LK
contract SHA could be pinned.

## What LK owns (blocked on LK agent)

- `docs/integrations/edo-reliability-contract.md` with the authoritative
  revision/tombstone/generation semantics (sourceRevision, equal-revision
  conflict detection, identifier changes, snapshot generations).
- Updated narrow OpenAPI (`packages/lk-client/openapi/edo.json` source:
  LK `next/openapi/edo.json`) + fixtures for the new event format.
- Published SHA of the contract commit that EDO must implement against.

EDO does NOT invent a revision independently: no local-time/occurredAt/eventId
ordering, no artificial "newest" for unversioned events. The new event format
is accepted early (unknown-version → poison DLQ, no crash) but ordering by
revision is implemented only after the LK SHA lands.

## What EDO implemented independently (this branch)

- Retry preserves `x-original-routing-key` (validated allowlist, must match
  envelope.eventType); old-format messages (queue-name key, no header) poison
  deterministically; `lk:recover --dry-run/--apply --limit` re-hydrates from
  envelope.eventType without mass auto-replay.
- Publisher confirms (ConfirmChannel + waitForConfirms + mandatory return +
  timeout + backpressure); ack original only after confirm; unconfirmed stays
  recoverable via redelivery (no hot loop, no eternal unacked without resume
  via reconnect + idempotent inbox).
- Redis strict GET (distinguishes missing vs down; no GET-error→null+PING
  fallback); fencing via `lk_sync_runs` generation (atomic check in the same
  DB transaction as inbox+projection+audit); guard required for syncAll in
  production; cancellation + overall deadline; heartbeat never holds past deadline.
- P2002 discrimination (duplicate only when inbox eventId confirmed); audit in
  the same transaction for all three event types; ack after commit.
- lk-client: runtime validation, per-request timeout + AbortSignal, bounded
  transient retries with backoff, no retry on 401/403/contract errors, safe
  error messages (status+path, never bodies); pagination: finish only on
  `nextCursor === null`, missing cursor = contract error, repeat/no-progress
  detection, page/time limits, validate-before-apply; incomplete snapshot never
  marks missing; zero-snapshot + shrinkage guards.
- Employee scope: explicit `lkEmployeeCode1c` + `locationId` (migration 0004);
  backend DB-filtered list/getById/total; 20009/20008 → all, 20007 → listed ids,
  else denied; NULL object invisible to scoped users; no ФИО matching, no
  auto-creation of cases for the whole LK staff.
- Integration health (`GET /api/health/integration`): Redis, consumer, bootstrap,
  freshness (24h), queue depths (best-effort); reads never gated by integration
  staleness.
- Durable sync ledger (`lk_sync_runs`): started/finished/status/counts/error
  category (safe ids, truncated messages, no PII).

## Dependent stage (explicit, not started)

When LK publishes the contract SHA:

1. Pin `packages/lk-client/openapi/edo.json` to that SHA (copy, never hand-edit
   generated client; `pnpm --filter @edo/lk-client generate` + drift check).
2. Implement unified revision semantics: newer updates, older never rolls back,
   equal is idempotent, equal-payload conflict detected, version check + write
   atomic under concurrency (no JS Number for big string revisions).
3. `lastSeenSyncId` vs field updates separated; late upsert never resurrects
   `sourcePresent=true` after confirmed disappearance (tombstone/generation rules
   from the contract); explicit transitional mode for old unversioned events.
4. Add revision-ordering regression tests (old-after-snapshot, reverse-order pair)
   against LK fixtures from that SHA.

Do not mark the task complete with only retry fixed while revision ordering or
object rights remain broken.
