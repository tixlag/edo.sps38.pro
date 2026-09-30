import { NestFactory } from '@nestjs/core';
import { join } from 'path';
import { config as dotenvConfig } from 'dotenv';
import { SyncAppModule } from './sync-app.module';
import { LkReferenceSyncService } from './lk-reference-sync.service';
import { LkReconciliationLockService } from './lk-reconciliation-lock.service';

// Load root .env explicitly (do not rely on cwd).
dotenvConfig({ path: join(__dirname, '..', '..', '..', '..', '.env') });

async function main() {
  // Snapshot coordination:
  // - initial bootstrap: SyncAppModule does not include LkEventsModule at all;
  //   belt-and-braces also forces LK_EVENTS_CONSUME=0 before Nest creates any
  //   context (queue buffers events, snapshot runs, then the normal app boot
  //   replays buffered events in live mode).
  // - periodic reconciliation (API already running elsewhere): acquire the
  //   distributed Redis lock first so the live consumer pauses APPLYING events
  //   (messages stay queued/unacked, no hot requeue loop). A second concurrent
  //   sync refuses to run while the lock is held.
  process.env.LK_EVENTS_CONSUME = '0';
  const app = await NestFactory.createApplicationContext(SyncAppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const lock = app.get(LkReconciliationLockService);
  const handle = await lock.tryAcquire();
  if (!handle) {
    // eslint-disable-next-line no-console
    console.error('LK sync skipped: another reconciliation holds the distributed lock');
    await app.close();
    process.exit(2);
  }
  try {
    const sync = app.get(LkReferenceSyncService);
    const result = await sync.syncAll();
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
