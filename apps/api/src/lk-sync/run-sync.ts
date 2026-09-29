import { NestFactory } from '@nestjs/core';
import { join } from 'path';
import { config as dotenvConfig } from 'dotenv';
import { SyncAppModule } from './sync-app.module';
import { LkReferenceSyncService } from './lk-reference-sync.service';

// Load root .env explicitly (do not rely on cwd).
dotenvConfig({ path: join(__dirname, '..', '..', '..', '..', '.env') });

async function main() {
  // CRITICAL: snapshot must run with the live consumer disabled. SyncAppModule
  // does not include LkEventsModule at all; belt-and-braces also forces the flag
  // before Nest creates any context (queue buffers events, snapshot runs, then
  // the normal app boot replays buffered events in live mode).
  process.env.LK_EVENTS_CONSUME = '0';
  const app = await NestFactory.createApplicationContext(SyncAppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const sync = app.get(LkReferenceSyncService);
    const result = await sync.syncAll();
    // eslint-disable-next-line no-console
    console.log(`LK sync done: ${JSON.stringify(result)}`);
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
