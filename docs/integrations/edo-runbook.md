# EDO LK runbook (operator)

This runbook covers the LK master-data integration only. It does not deploy
or merge; rollout/rollback are operator actions.

## Topology (never delete to change immutable args)

- `lk.events` (LK-owned topic, durable): only asserted compatible, never
  redeclared with conflicting args, never deleted.
- `edo.lk-reference-sync` (EDO main, durable classic, DLX → `*.dlx`).
- `edo.lk-reference-sync.retry` (EDO retry, durable classic, TTL 5s → default
  exchange routing key = main queue name, no consumer).
- `edo.lk-reference-sync.dlx` (EDO topic) → `edo.lk-reference-sync.dlq` (poison).
- Bindings: `lk.reference.employee/position/department.upserted.v1` + reserved
  location/deleted keys (see `LK_REFERENCE_BINDINGS`).

Publisher confirms (ConfirmChannel, per-message callback, mandatory) give
at-least-once placement INTO the retry queue, and duplicates are deduped via
`lk_processed_events.eventId`. They do NOT cover the broker-internal hops:

- KNOWN LOSS WINDOW (open blocker, proven on disposable RabbitMQ 4.x in
  `test/lk-retry-chain-rabbit.spec.ts`, case b): a dead-lettered message whose
  target queue does not exist at expire time is SILENTLY DROPPED (no DLQ, no
  return, no trace). This covers retry→main, poison→DLQ and exhaust→DLQ alike.
  The guarantee therefore reads: at-least-once **while the EDO-owned topology
  stays intact**. Enforcement is operational, not just code: never delete EDO
  queues; startup `assertTopology` fails closed on mismatch; integration health
  reports missing queues as explicit `queueErrors` (never hidden as zero);
  alert on any `queueErrors` entry immediately.
- A v2 topology (new queue names, explicit drain/rollback plan) is prepared
  separately and is NOT applied to shared infra in this task. Do not "fix" the
  window by deleting/recreating queues with new arguments.

If immutable args must change: deploy a NEW queue name, drain the backlog
(consumer + `lk:recover --dry-run`), switch bindings, keep the old queue until
empty, then delete. Never `purge` the backlog without a snapshot.

## Bootstrap order

1. `pnpm infra:check` (read-only).
2. `pnpm db:migrate` (refuses non-`edo` DB).
3. `pnpm --filter @edo/api lk:topology` (buffers live events, no consumer).
4. `pnpm --filter @edo/api lk:sync` (acquires Redis lock, snapshot, fenced
   markMissing, releases; exits 2 busy / 3 no Redis / 1 other incl. lock lost).
5. Boot API (consumer replays buffered events, then live).

## Periodic reconciliation (example schedule, NOT installed)

Example cron (operator installs separately, never in this repo):

```
# Every 6h, jittered, single instance (lock refuses concurrent runs with exit 2)
17 */6 * * *  cd /opt/edo && /usr/bin/pnpm --filter @edo/api lk:sync >>/var/log/edo-lk-sync.log 2>&1
```

Monitor instead of blindly re-running:

- `GET /api/health/integration`: `redis`, `consumer`, `bootstrap`,
  `freshness` (stale after 24h), `pendingMessages`/`dlqMessages` (best-effort).
- `lk_sync_runs` table: `RUNNING` stuck > deadline → investigate (crashed sync?
  Redis TTL expired?); `FAILED/SHRINKAGE/CANCELLED` with `errorCategory`.
- Alerts (example thresholds): backlog age > 15min, DLQ growth > 0/h,
  retry inflight sustained > 10, last successful sync > 24h, lock held > 10min.

`GET /api/health/ready` stays MariaDB+RabbitMQ (Redis optional); integration
staleness never gates reads of existing data.

## Poison / retry / DLQ triage

- Poison (malformed, unknown version/key, Zod errors): `nack(false)` → DLQ.
  Logs carry routingKey+reason only, never payloads.
- Transient (DB/network, fencing conflict): confirm-gated retry (TTL 5s → main,
  max 5 confirmed attempts, then DLQ). Original acked only after confirm.
  While the retry route itself is unavailable, originals wait via one delayed
  nack(true) per delivery (fixed 5s) instead of being DLQed for the outage;
  repeated warn logs + integration-health DLQ/backlog signals are the alert
  path. DLQ stays for poison and confirmed-exhaustion. Stall tracking is
  per-delivery (`generation:deliveryTag`, freed on settlement); a tracking
  overflow (1000 entries — unreachable under prefetch=10, i.e. leak/miswire)
  recycles the OLD delivery channel AND the OLD connection (both closed
  best-effort, never awaited) for broker-side requeue instead of creating
  untracked timers. First trigger per generation wins; late old-connection
  callbacks are ignored by the identity guard.
- Old retry-format (queue-name key, no `x-original-routing-key`): poisoned
  deterministically. Recover via:

```bash
# Inspect only (default dry-run, limit 100, max 1000):
pnpm --filter @edo/api lk:recover -- --dry-run --limit=100 --from=dlq
# After triage, republish recoverable messages with correct header (still bounded):
pnpm --filter @edo/api lk:recover -- --apply --limit=50 --from=dlq
```

Never mass-replay automatically. Verify `lk_processed_events.eventId` for
duplicates before/after. The tool preserves eventId/properties, resets
`x-retry-count=0`, sets validated `x-original-routing-key` from
envelope.eventType, and acks the DLQ copy only after confirm.

## Lock loss / fencing

- `LockOwnershipLostError` / `FencingConflictError` / fencing `SnapshotActiveError`:
  the losing side aborts (snapshot before any further write incl. pages, event
  as transient for redelivery after the snapshot). Stale rows keep old marks;
  next coordinated snapshot repairs. Late event writes abort as transient and
  redeliver after the snapshot.
- Serialization point: `lk_sync_state` row (`SELECT ... FOR UPDATE` inside each
  short write transaction). Redis lock pauses admits; the DB row decides races.
- Crashed/stuck `RUNNING` rows and orphaned generations:
  1. The Redis heartbeat stops renewing past the 10min hold bound, so the lock
     lapses and the consumer resumes; the holder's next gate fails and it aborts.
  2. An event admitted while the heartbeat is stale REVOKES the orphan in the
     same row-locked transaction (activeRunId=NULL + generation bump): a merely
     paused holder resuming afterwards fails every gate (pages, stamps, marks),
     and its late heartbeat cannot resurrect it (0 rows updated → lost).
  3. The next `lk:sync` acquires the Redis lock (proving no live holder) and
     STEALS any remaining stale generation (logged `stolen`), bumping it again.
  4. Operator: confirm via `lk_sync_runs` (FAILED/STUCK categories) + Redis
     `GET edo:lk-reconciliation-lock`; never delete `lk_sync_runs` rows.

## Shrinkage / empty snapshot

- Zero-count tables skip marking with a warning (never wipe on truncation).
- Anomalous drops (>30% vs last FINISHED, configurable via `maxShrinkage`)
  abort with `ShrinkageGuardError` before marking. Re-run with explicit
  operator confirmation (`allowShrinkage:true` via code path or CLI flag when
  wired) after verifying LK-side deletions are real.

## Rollback

- Code rollback: redeploy previous image; migrations are additive
  (`lk_sync_runs`, `employees.lkEmployeeCode1c/locationId` nullable) — no data
  loss, unknown links stay NULL (no guessing).
- Topology rollback: keep old queue names/bindings until the new path is
  verified empty via `checkQueueDepths` + `lk:recover --dry-run`.
- Never delete volumes (`lk_sps_db`, `lk_rabbitmq-data`, `lk_redis`) or shared
  queues/exchanges.
