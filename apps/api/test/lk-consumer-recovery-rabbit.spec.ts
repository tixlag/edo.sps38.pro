import { describe, expect, it } from 'vitest';
import { RabbitmqService } from '../src/rabbitmq/rabbitmq.module';

/**
 * Live consumer recovery on a REAL disposable broker (no mocks for the AMQP
 * path): a real connection + real consumer + a failing retry publish
 * (retry queue deleted, mandatory return) + the bounded slow-requeue nack +
 * a genuine broker redelivery + successful handling.
 *
 * This is NOT a manual second call of retryLaterAsync(): the recovery travels
 * the ordinary subscribe -> handler-throw -> retryAsync(false) -> slow-requeue
 * timer -> nack(true) -> broker redelivery -> handler-success -> ack path.
 *
 * Gated on EDO_TEST_RABBITMQ_URL (disposable 127.0.0.1:5673/5675 only).
 * Test queues use an isolated `edo.test.recovery.*` prefix; nothing shared
 * is touched, created, or deleted.
 */
function disposableRabbitUrl(): string | null {
  const u = process.env.EDO_TEST_RABBITMQ_URL ?? '';
  if (!u) return null;
  if (!/^amqp:\/\/[^@]+@(127\.0\.0\.1|localhost):(5673|5675)\/?$/.test(u)) {
    throw new Error('Refusing: EDO_TEST_RABBITMQ_URL must be a disposable test broker (127.0.0.1:5673 or :5675)');
  }
  return u;
}

const URL = disposableRabbitUrl();
const PFX = `edo.test.recovery.${Date.now().toString(36)}`;

function service(url: string, queue: string) {
  const config = {
    get: (key: string) => {
      if (key === 'RABBITMQ_URL') return url;
      if (key === 'EDO_LK_QUEUE') return queue;
      if (key === 'LK_EVENTS_EXCHANGE') return `${PFX}.ex`;
      return undefined;
    },
  } as never;
  return new RabbitmqService(config);
}

describe.skipIf(!URL)('Live consumer slow-requeue recovery (disposable broker)', () => {
  it('failing retry publish -> delayed nack -> real redelivery -> applied+acked, DLQ empty', async () => {
    const svc = service(URL!, `${PFX}.main`);
    await svc.ensureConnected(8000);
    const deliveries: Array<{ tag: unknown; count: number }> = [];
    let attempts = 0;
    let applied = false;
    await svc.consume(async ({ content, headers, retryCount, ack }) => {
      attempts += 1;
      deliveries.push({ tag: (headers as Record<string, unknown>)['__tag'] ?? attempts, count: retryCount });
      if (attempts === 1) throw new Error('transient handler failure');
      applied = true;
      ack();
    });
    // Publish first via a raw connection straight to the test main queue.
    const amqp = await import('amqplib');
    const raw = await amqp.connect(URL!);
    try {
      const ch = await raw.createChannel();
      try {
        // Break the retry publish deterministically: remove the retry queue so
        // the mandatory publish returns (unroutable) instead of confirming.
        await ch.deleteQueue(`${PFX}.main.retry`).catch(() => undefined);
        const body = Buffer.from(JSON.stringify({ eventId: `${PFX}-evt-1` }));
        await ch.sendToQueue(`${PFX}.main`, body, { persistent: true, contentType: 'application/json', headers: {} });
        // Attempt 1 throws -> retry publish returns -> slow-requeue (5s) ->
        // real broker redelivery -> attempt 2 applies + acks.
        const deadline = Date.now() + 25000;
        while (!applied && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 250));
        }
        expect(applied).toBe(true);
        expect(attempts).toBeGreaterThanOrEqual(2);
        // Restore topology for cleanliness and assert the DLQ stayed empty.
        await svc.assertTopologyOnly(5000).catch(() => undefined);
        const probe = await raw.createChannel();
        try {
          const dlq = await probe.checkQueue(`${PFX}.main.dlq`).catch(() => ({ messageCount: -1 }));
          expect(dlq.messageCount).toBe(0);
        } finally {
          await probe.close().catch(() => undefined);
        }
      } finally {
        await ch.close().catch(() => undefined);
      }
    } finally {
      await raw.close().catch(() => undefined);
    }
    await svc.onModuleDestroy();
    // Cleanup test topology (isolated prefix only).
    const janitor = await amqp.connect(URL!);
    try {
      const ch = await janitor.createChannel();
      try {
        await ch.deleteQueue(`${PFX}.main`).catch(() => undefined);
        await ch.deleteQueue(`${PFX}.main.retry`).catch(() => undefined);
        await ch.deleteQueue(`${PFX}.main.dlq`).catch(() => undefined);
        await ch.deleteExchange(`${PFX}.main.dlx`).catch(() => undefined);
        await ch.deleteExchange(`${PFX}.ex`).catch(() => undefined);
      } finally {
        await ch.close().catch(() => undefined);
      }
    } finally {
      await janitor.close().catch(() => undefined);
    }
  }, 40000);
});
