import { NestFactory } from '@nestjs/core';
import { join } from 'path';
import { config as dotenvConfig } from 'dotenv';
import { AppModule } from '../app.module';
import { LkReferenceSyncService } from './lk-reference-sync.service';

// Load root .env explicitly (do not rely on cwd).
dotenvConfig({ path: join(__dirname, '..', '..', '..', '.env') });

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
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
