import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

function redisConnection() {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || 'localhost',
      port: Number(parsed.port || 6379),
      // Do not block boot when Redis is absent (local docs builds, CI).
      maxRetriesPerRequest: 1 as const,
      enableReadyCheck: false,
    };
  } catch {
    return { host: 'localhost', port: 6379, maxRetriesPerRequest: 1 as const, enableReadyCheck: false };
  }
}

@Global()
@Module({
  imports: [
    BullModule.forRoot({
      connection: redisConnection(),
      defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
    }),
    // Future queues: ocr, notifications, expiry, integrations, generation.
    BullModule.registerQueue({ name: 'ocr' }, { name: 'notifications' }),
  ],
  exports: [BullModule],
})
export class QueuesModule {}
