import { NestFactory } from '@nestjs/core';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { config as dotenvConfig } from 'dotenv';
import { SyncAppModule } from './sync-app.module';
import { LkReferenceSyncService } from './lk-reference-sync.service';
import {
  LkReconciliationLockService,
  RedisUnavailableError,
} from './lk-reconciliation-lock.service';
import { DbFencingService, SnapshotActiveError, toLedgerError } from './lk-fencing.service';

// Load root .env explicitly when present (local dev); process env wins in CI.
// Missing file is fine — dotenvConfig simply loads nothing.
dotenvConfig({ path: join(__dirname, '..', '..', '..', '..', '.env') });

const SYNC_DEADLINE_MS = 10 * 60 * 1000;
const DB_HEARTBEAT_MS = 10_000;

async function main() {
  // Snapshot coordination (FAIL CLOSED, two gates):
  // - initial bootstrap: SyncAppModule does not include LkEventsModule at all;
  //   belt-and-braces also forces LK_EVENTS_CONSUME=0 before Nest creates any
  //   context (queue buffers events, snapshot runs, then the normal app boot
  //   replays buffered events in live mode).
  // - periodic reconciliation (API already running elsewhere):
  //   1. acquire the distributed Redis lock first so the live consumer pauses
  //      APPLYING events (messages stay queued/unacked, no hot requeue loop);
  //   2. acquire the DB fencing generation (atomic row-lock + RUNNING ledger
  //      row) so event applies serialize against snapshot writes even if the
  //      Redis check raced. A concurrent holder fails here with exit 2.
  // - lock held by another sync -> exit 2 (skip, not an error for schedulers).
  // - shared Redis unavailable -> exit 3 WITHOUT running the snapshot
  //   (fail closed: an uncoordinated full sync is unsafe).
  // - DB fencing unavailable -> exit 1 WITHOUT writing (fail closed).
  // - lock lost mid-snapshot -> abort before markMissing, exit 1.
  // - overall deadline (10min): the Redis heartbeat stops renewing past it
  //   (never holds the consumer pause forever for a hung snapshot) and a
  //   watchdog releases fencing + exits 1.
  process.env.LK_EVENTS_CONSUME = '0';
  const app = await NestFactory.createApplicationContext(SyncAppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const lock = app.get(LkReconciliationLockService);
  const fencing = app.get(DbFencingService);
  const runId = randomUUID();
  let handle: Awaited<ReturnType<LkReconciliationLockService['tryAcquire']>>;
  try {
    handle = await lock.tryAcquire(undefined, { maxHoldMs: SYNC_DEADLINE_MS });
  } catch (err) {
    if (err instanceof RedisUnavailableError) {
      // eslint-disable-next-line no-console
      console.error(`LK sync refused: shared Redis unavailable (${err.message})`);
      await app.close();
      process.exit(3);
    }
    throw err;
  }
  if (!handle) {
    // eslint-disable-next-line no-console
    console.error('LK sync skipped: another reconciliation holds the distributed lock');
    await app.close();
    process.exit(2);
  }
  let dbHeartbeat: ReturnType<typeof setInterval> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const stopTimers = () => {
    if (dbHeartbeat) clearInterval(dbHeartbeat);
    if (watchdog) clearTimeout(watchdog);
    dbHeartbeat = watchdog = null;
  };
  // The fencing generation is acquired inside syncAll (single place); a
  // concurrent holder surfaces as SnapshotActiveError and maps to exit 2.
  // The DB heartbeat + watchdog below bound the hold time: the Redis lock
  // heartbeat stops renewing past the deadline, and the watchdog releases
  // fencing + exits 1 even if the sync hangs inside a call.
  const armed = { runId: null as string | null };
  try {
    dbHeartbeat = setInterval(() => {
      if (!armed.runId) return;
      const id = armed.runId;
      void fencing.heartbeatDb(id).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`LK sync fencing heartbeat failed, aborting: ${(err as Error).message}`);
        process.exit(1);
      });
    }, DB_HEARTBEAT_MS);
    const hb = dbHeartbeat as unknown as { unref?: () => void };
    if (typeof hb.unref === 'function') hb.unref();
    watchdog = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.error(`LK sync deadline exceeded (${SYNC_DEADLINE_MS}ms); releasing and exiting`);
      stopTimers();
      void (async () => {
        await fencing.releaseDb(runId, 'FAILED', null, { category: 'CANCELLED', detail: 'deadline exceeded' }).catch(() => undefined);
        await handle.release();
        await app.close();
        process.exit(1);
      })();
    }, SYNC_DEADLINE_MS);
    const wd = watchdog as unknown as { unref?: () => void };
    if (typeof wd.unref === 'function') wd.unref();
    const sync = app.get(LkReferenceSyncService);
    armed.runId = runId;
    const result = await sync.syncAll(undefined, runId, { guard: handle, deadlineMs: SYNC_DEADLINE_MS });
    // eslint-disable-next-line no-console
    console.log(`LK sync done: ${JSON.stringify(result)}`);
  } catch (err) {
    if (err instanceof SnapshotActiveError) {
      // eslint-disable-next-line no-console
      console.error(`LK sync skipped: fencing generation held (${err.message})`);
      await app.close();
      process.exit(2);
    }
    const ledger = toLedgerError(err);
    await fencing.releaseDb(runId, 'FAILED', null, ledger).catch(() => undefined);
    throw err;
  } finally {
    stopTimers();
    await handle.release();
    await app.close();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
