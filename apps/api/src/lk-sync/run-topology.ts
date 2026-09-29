import { NestFactory } from '@nestjs/core';
import { join } from 'path';
import { config as dotenvConfig } from 'dotenv';
import { SyncAppModule } from './sync-app.module';
import { RabbitmqService } from '../rabbitmq/rabbitmq.module';

// Load root .env explicitly (do not rely on cwd).
dotenvConfig({ path: join(__dirname, '..', '..', '..', '..', '.env') });

/**
 * Create the RabbitMQ topology (exchange, durable queue + DLQ/DLX, bindings)
 * WITHOUT starting the consumer, so the queue can buffer live LK events while
 * a full snapshot runs. Deployment order:
 * 1. lk:topology (queue starts accumulating)
 * 2. lk:sync with consumer disabled (full snapshot, marks missing only on success)
 * 3. boot the API (consumer replays buffered events, then live mode)
 */
async function main() {
  process.env.LK_EVENTS_CONSUME = '0';
  const app = await NestFactory.createApplicationContext(SyncAppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const rabbit = app.get(RabbitmqService);
    await rabbit.assertTopologyOnly();
    // eslint-disable-next-line no-console
    console.log(
      `LK topology ready: exchange=${rabbit.exchange} queue=${rabbit.queue} dlq=${rabbit.dlq} dlx=${rabbit.dlx}`,
    );
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
