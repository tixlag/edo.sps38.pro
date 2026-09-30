import { NestFactory } from '@nestjs/core';
import { join } from 'path';
import { config as dotenvConfig } from 'dotenv';
import { SyncAppModule } from './sync-app.module';
import { LkReferenceSyncService } from './lk-reference-sync.service';
import {
  LkReconciliationLockService,
  RedisUnavailableError,
} from './lk-reconciliation-lock.service';

// Load root .env explicitly when present (local dev); process env wins in CI.
// Missing file is fine — dotenvConfig simply loads nothing.
dotenvConfig({ path: join(__dirname, '..', '..', '..', '..', '.env') });

async function main() {
  // Snapshot coordination (FAIL CLOSED):
  // - initial bootstrap: SyncAppModule does not include LkEventsModule at all;
  //   belt-and-braces also forces LK_EVENTS_CONSUME=0 before Nest creates any
  //   context (queue buffers events, snapshot runs, then the normal app boot
  //   replays buffered events in live mode).
  // - periodic reconciliation (API already running elsewhere): acquire the
  //   distributed Redis lock first so the live consumer pauses APPLYING events
  //   (messages stay queued/unacked, no hot requeue loop).
  // - lock held by another sync -> exit 2 (skip, not an error for schedulers).
  // - shared Redis unavailable -> exit 3 WITHOUT running the snapshot
  //   (fail closed: an uncoordinated full sync is unsafe).
  // - lock lost mid-snapshot -> abort before markMissing, exit 1.
  process.env.LK_EVENTS_CONSUME = '0';
  const app = await NestFactory.createApplicationContext(SyncAppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const lock = app.get(LkReconciliationLockService);
  let handle: Awaited<ReturnType<LkReconciliationLockService['tryAcquire']>>;
  try {
    handle = await lock.tryAcquire();
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
  try {
    const sync = app.get(LkReferenceSyncService);
    const result = await sync.syncAll(undefined, undefined, handle);
    // eslint-disable-next-line no-console
    console.log(`LK sync done: ${JSON.stringify(result)}`);
  } finally {
    await handle.release();
    await app.close();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
