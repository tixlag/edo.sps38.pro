import { describe, expect, it } from 'vitest';

/**
 * Retry/DLX chain proof on a REAL disposable broker (RabbitMQ 4.x).
 * NEVER runs against shared infrastructure: requires EDO_TEST_RABBITMQ_URL
 * pointing at the disposable test broker (127.0.0.1:5675) and refuses
 * anything else. Destructive ops (queue deletion) happen only here.
 *
 * Proves separately:
 *  (a) retry -> main after TTL works while the topology is intact (headers kept);
 *  (b) the KNOWN LOSS WINDOW: a dead-letter whose target queue is missing at
 *      expire time is silently dropped (official broker semantics) — this is
 *      the documented open blocker, not a code bug;
 *  (c) poison -> DLQ via nack(requeue=false) works while intact.
 */
function disposableRabbitUrl(): string | null {
  const u = process.env.EDO_TEST_RABBITMQ_URL ?? '';
  if (!u) return null;
  if (!/^amqp:\/\/[^@]+@127\.0\.0\.1:5675\/?$/.test(u)) {
    throw new Error('Refusing: EDO_TEST_RABBITMQ_URL must be the disposable test broker (amqp://…@127.0.0.1:5675/)');
  }
  return u;
}

const URL = disposableRabbitUrl();
const PFX = `edo.test.chain.${Date.now().toString(36)}`;

async function connect(url: string) {
  const amqp = await import('amqplib');
  return amqp.connect(url);
}

describe.skipIf(!URL)('LK retry/DLX chain on disposable RabbitMQ', () => {
  it('(a) retry TTL redelivers to main with headers preserved (topology intact)', async () => {
    const conn = await connect(URL!);
    try {
      const ch = await conn.createConfirmChannel();
      const main = `${PFX}.a.main`;
      const retry = `${PFX}.a.retry`;
      const dlx = `${PFX}.a.dlx`;
      const dlq = `${PFX}.a.dlq`;
      try {
        await ch.assertExchange(dlx, 'topic', { durable: true });
        await ch.assertQueue(dlq, { durable: true });
        await ch.bindQueue(dlq, dlx, '#');
        await ch.assertQueue(main, { durable: true, arguments: { 'x-dead-letter-exchange': dlx } });
        await ch.assertQueue(retry, {
          durable: true,
          arguments: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': main, 'x-message-ttl': 300 },
        });
        const body = Buffer.from(JSON.stringify({ eventId: `${PFX}-a1` }));
        ch.publish('', retry, body, {
          persistent: true,
          mandatory: true,
          messageId: 'pub-a1',
          headers: { 'x-retry-count': 1, 'x-original-routing-key': 'lk.reference.employee.upserted.v1' },
        });
        await ch.waitForConfirms();
        let got: { fields: { routingKey: string }; properties: { headers?: Record<string, unknown> } } | null = null;
        for (let i = 0; i < 30; i++) {
          const m = await ch.get(main, { noAck: false });
          if (m) {
            got = m as never;
            ch.ack(m);
            break;
          }
          await new Promise((r) => setTimeout(r, 200));
        }
        expect(got).not.toBeNull();
        expect(got!.fields.routingKey).toBe(main);
        expect((got!.properties.headers as Record<string, unknown>)['x-original-routing-key']).toBe(
          'lk.reference.employee.upserted.v1',
        );
      } finally {
        await ch.deleteQueue(main).catch(() => undefined);
        await ch.deleteQueue(retry).catch(() => undefined);
        await ch.deleteQueue(dlq).catch(() => undefined);
        await ch.deleteExchange(dlx).catch(() => undefined);
        await ch.close().catch(() => undefined);
      }
    } finally {
      await conn.close().catch(() => undefined);
    }
  }, 30000);

  it('(b) OPEN BLOCKER PROOF: dead-letter to a missing queue is silently dropped', async () => {
    const conn = await connect(URL!);
    try {
      const ch = await conn.createConfirmChannel();
      const main = `${PFX}.b.main`;
      const retry = `${PFX}.b.retry`;
      try {
        await ch.assertQueue(main, { durable: true });
        await ch.assertQueue(retry, {
          durable: true,
          arguments: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': main, 'x-message-ttl': 300 },
        });
        const body = Buffer.from(JSON.stringify({ eventId: `${PFX}-b1` }));
        ch.publish('', retry, body, { persistent: true, mandatory: true, messageId: 'pub-b1' });
        await ch.waitForConfirms();
        // Destroy the target BEFORE the TTL expires: the pending dead-letter
        // has nowhere to go when it expires.
        await ch.deleteQueue(main);
        await new Promise((r) => setTimeout(r, 1500));
        // Re-declare and look: nothing arrives — the message was dropped by the
        // broker, not by any consumer. No DLQ, no return, no trace.
        await ch.assertQueue(main, { durable: true });
        const m = await ch.get(main, { noAck: false });
        expect(m).toBe(false);
      } finally {
        await ch.deleteQueue(main).catch(() => undefined);
        await ch.deleteQueue(retry).catch(() => undefined);
        await ch.close().catch(() => undefined);
      }
    } finally {
      await conn.close().catch(() => undefined);
    }
  }, 30000);

  it('(c) poison path: nack(requeue=false) lands in DLQ while intact', async () => {
    const conn = await connect(URL!);
    try {
      const ch = await conn.createChannel();
      const main = `${PFX}.c.main`;
      const dlx = `${PFX}.c.dlx`;
      const dlq = `${PFX}.c.dlq`;
      try {
        await ch.assertExchange(dlx, 'topic', { durable: true });
        await ch.assertQueue(dlq, { durable: true });
        await ch.bindQueue(dlq, dlx, '#');
        await ch.assertQueue(main, { durable: true, arguments: { 'x-dead-letter-exchange': dlx } });
        const body = Buffer.from(JSON.stringify({ eventId: `${PREFIX_FALLBACK()}-c1` }));
        await ch.sendToQueue(main, body, { persistent: true });
        const m = await ch.get(main, { noAck: false });
        expect(m).not.toBe(false);
        ch.nack(m!, false, false);
        let poison: unknown = false;
        for (let i = 0; i < 30; i++) {
          const d = await ch.get(dlq, { noAck: false });
          if (d) {
            poison = d;
            ch.ack(d);
            break;
          }
          await new Promise((r) => setTimeout(r, 200));
        }
        expect(poison).not.toBe(false);
      } finally {
        await ch.deleteQueue(main).catch(() => undefined);
        await ch.deleteQueue(dlq).catch(() => undefined);
        await ch.deleteExchange(dlx).catch(() => undefined);
        await ch.close().catch(() => undefined);
      }
    } finally {
      await conn.close().catch(() => undefined);
    }
  }, 30000);
});

function PREFIX_FALLBACK(): string {
  return PFX;
}
