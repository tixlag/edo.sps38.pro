import { describe, expect, it, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { RabbitmqService } from '../src/rabbitmq/rabbitmq.module';
import { LkEventHandler } from '../src/lk-events/lk-event.handler';
import { AuditService } from '../src/audit/audit.service';
import { DbFencingService } from '../src/lk-sync/lk-fencing.service';

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
 * Gated on EDO_TEST_RABBITMQ_URL (disposable 127.0.0.1:5673/5675 only) and,
 * for the projection proof, EDO_TEST_DATABASE_URL (disposable :3307/:3308).
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

function disposableDbUrl(): string | null {
  const u = process.env.EDO_TEST_DATABASE_URL ?? '';
  if (!u) return null;
  if (!/^mysql:\/\/[^@/]+@(127\.0\.0\.1|localhost):(3307|3308)\/edo(\?|$)/.test(u)) {
    throw new Error('Refusing: EDO_TEST_DATABASE_URL must be a disposable test server (127.0.0.1:3307 or :3308, db edo)');
  }
  return u;
}

const URL = disposableRabbitUrl();
const DB_URL = disposableDbUrl();
const PFX = `edo.test.recovery.${Date.now().toString(36)}`;

/**
 * Rigorous AMQP-only drain proof (no management API needed):
 * 1. get-loop acks everything READY (returns the drained count);
 * 2. the caller then closes the consumer connection under test, which forces
 *    the broker to requeue anything still UNACKED;
 * 3. a second get-loop must find nothing.
 * A message stuck unacked is invisible in step 1 but reappears in step 3.
 */
async function drainReady(amqpUrl: string, queue: string): Promise<number> {
  const amqp = await import('amqplib');
  const conn = await amqp.connect(amqpUrl);
  try {
    const ch = await conn.createChannel();
    try {
      let n = 0;
      for (;;) {
        const m = await ch.get(queue, { noAck: false });
        if (!m) break;
        ch.ack(m);
        n += 1;
      }
      return n;
    } finally {
      await ch.close().catch(() => undefined);
    }
  } finally {
    await conn.close().catch(() => undefined);
  }
}

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

function employeeEnvelope(eventId: string, code1c: string, fullName: string) {
  return {
    eventId,
    eventType: 'employee.upserted',
    version: 1,
    occurredAt: new Date().toISOString(),
    source: 'lk.sps38.pro',
    payload: {
      code1c,
      uuid: '00000000-0000-0000-0000-000000000099',
      fullName,
      birthday: null,
      citizenship: null,
      organization: { code: null, name: null },
      position: { code1c: null, name: null },
      department: { code1c: null, name: null },
      division: { code1c: null, name: null },
      lastLocation: null,
      hireDate: null,
      fired: false,
      contractor: false,
      updatedAt: null,
    },
  };
}

afterAll(async () => {
  if (!DB_URL) return;
  const prisma = new PrismaClient({ datasourceUrl: DB_URL });
  try {
    await prisma.lkEmployee.deleteMany({ where: { code1c: { startsWith: PFX } } });
    await prisma.lkProcessedEvent.deleteMany({ where: { eventId: { startsWith: PFX } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { startsWith: PFX } } });
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
});

describe.skipIf(!URL || !DB_URL)('Live consumer slow-requeue recovery (disposable broker)', () => {
  it('failing retry publish -> delayed nack -> real redelivery -> applied+acked, DLQ empty', async () => {
    const svc = service(URL!, `${PFX}.main`);
    await svc.ensureConnected(8000);
    const deliveries: Array<{ tag: unknown; count: number }> = [];
    let attempts = 0;
    let applied = false;
    await svc.consume(async ({ retryCount, ack }) => {
      attempts += 1;
      deliveries.push({ tag: attempts, count: retryCount });
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

  it('long retry-route outage: slow redeliveries wait, route restore recovers, DB projection applied once', async () => {
    const svc = service(URL!, `${PFX}.main2`);
    await svc.ensureConnected(8000);
    const prisma = new PrismaClient({ datasourceUrl: DB_URL! });
    const audit = new AuditService(prisma as never);
    const fencing = new DbFencingService(prisma as never);
    const realHandler = new LkEventHandler(prisma as never, {} as never, audit as never, fencing as never);
    const code1c = `${PFX}.EMP2`;
    const eventId = `${PFX}-evt-long`;
    let attempts = 0;
    let applied = 0;
    // Consumer logic mirrors LkEventConsumer (apply -> ack / poison -> DLQ /
    // throw -> confirm-gated retryAsync with slow-requeue recovery).
    await svc.consume(async ({ routingKey, content, ack, nack }) => {
      attempts += 1;
      // Five transient failures (retry route down throughout), then the real apply.
      if (attempts < 6) throw new Error(`transient failure ${attempts}`);
      const outcome = await realHandler.applyRaw(routingKey, content);
      if (outcome.status === 'applied' || outcome.status === 'duplicate') {
        applied += 1;
        ack();
      } else {
        nack(false);
      }
    });
    // Restore ONLY after attempts>=3 are observed: entry N+1 proves publish N
    // finished unconfirmed (its slow timer fired), so attempts>=3 means two
    // full failed publish cycles are done — not just handler entries.
    const amqp = await import('amqplib');
    const raw = await amqp.connect(URL!);
    try {
      const ch = await raw.createChannel();
      try {
        await ch.deleteQueue(`${PFX}.main2.retry`).catch(() => undefined);
        const body = Buffer.from(JSON.stringify(employeeEnvelope(eventId, code1c, 'Долгий Маршрут')));
        // Publish through the test exchange with the real routing key, so the
        // delivery arrives with fields.routingKey allowed (as LK publishes).
        // sendToQueue would stamp the queue name as the key and the real
        // handler would poison it — a different (already covered) path.
        await ch.publish(`${PFX}.ex`, 'lk.reference.employee.upserted.v1', body, {
          persistent: true,
          contentType: 'application/json',
          headers: {},
        });
        const deadline = Date.now() + 85000;
        let restored = false;
        while (applied === 0 && Date.now() < deadline) {
          // Restore ONLY after two completed slow redelivery cycles are
          // observed (attempts>=3 entries). Each entry N+1 proves publish N
          // finished unconfirmed (slow timer fired) — the handler-entry
          // counter alone is not the signal; observed redelivery is.
          if (!restored && attempts >= 3) {
            await ch.assertQueue(`${PFX}.main2.retry`, {
              durable: true,
              arguments: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': `${PFX}.main2`, 'x-message-ttl': 5000 },
            });
            restored = true;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        expect(restored).toBe(true);
        // Transport: applied exactly once, after exactly 5 failed attempts.
        expect(applied).toBe(1);
        expect(attempts).toBe(6);
        // Real projection (not just a transport counter): inbox + row + audit
        // committed in one transaction by the real handler.
        const inbox = await prisma.lkProcessedEvent.findUnique({ where: { eventId } });
        expect(inbox?.eventId).toBe(eventId);
        const row = await prisma.lkEmployee.findUnique({ where: { code1c } });
        expect(row?.fullName).toBe('Долгий Маршрут');
        expect(row?.sourcePresent).toBe(true);
        expect(await prisma.auditLog.count({ where: { entityId: code1c, action: 'LK_EVENT_APPLIED' } })).toBe(1);
        // No diversion to DLQ for the outage (ready drain must find nothing)...
        expect(await drainReady(URL!, `${PFX}.main2.dlq`)).toBe(0);
        // ...and nothing stuck: close the consumer connection (forces requeue
        // of anything still unacked) and prove a second drain finds nothing.
        await svc.onModuleDestroy();
        expect(await drainReady(URL!, `${PFX}.main2`)).toBe(0);
        expect(await drainReady(URL!, `${PFX}.main2.retry`)).toBe(0);
      } finally {
        await ch.close().catch(() => undefined);
      }
    } finally {
      await raw.close().catch(() => undefined);
    }
    await svc.onModuleDestroy();
    await prisma.$disconnect().catch(() => undefined);
    const janitor = await amqp.connect(URL!);
    try {
      const ch = await janitor.createChannel();
      try {
        await ch.deleteQueue(`${PFX}.main2`).catch(() => undefined);
        await ch.deleteQueue(`${PFX}.main2.retry`).catch(() => undefined);
        await ch.deleteQueue(`${PFX}.main2.dlq`).catch(() => undefined);
        await ch.deleteExchange(`${PFX}.main2.dlx`).catch(() => undefined);
        await ch.deleteExchange(`${PFX}.ex`).catch(() => undefined);
      } finally {
        await ch.close().catch(() => undefined);
      }
    } finally {
      await janitor.close().catch(() => undefined);
    }
  }, 90000);

  it('negative control: close+redrain detects a deliberately unacked delivery', async () => {
    // One checkQueue().messageCount == 0 proves nothing about unacked
    // messages — this control pins that the close+redrain procedure DOES
    // detect them (same procedure the outage test uses for "nothing stuck").
    const amqp = await import('amqplib');
    const raw = await amqp.connect(URL!);
    try {
      const ch = await raw.createChannel();
      try {
        const q = `${PFX}.neg`;
        await ch.assertQueue(q, { durable: true });
        await ch.sendToQueue(q, Buffer.from('{"n":"neg"}'), { persistent: true });
        const got = await ch.get(q, { noAck: false });
        expect(got).not.toBe(false);
        // Ready count is 0 (consumed-unacked), but the message is NOT drained:
        // a plain ready-drain finds nothing here...
        expect(await drainReady(URL!, q)).toBe(0);
        // ...yet closing the holding connection requeues it into view.
        await ch.close();
        expect(await drainReady(URL!, q)).toBe(1);
        // And a final drain is clean.
        expect(await drainReady(URL!, q)).toBe(0);
        const janitor = await amqp.connect(URL!);
        try {
          const jc = await janitor.createChannel();
          try {
            await jc.deleteQueue(q).catch(() => undefined);
          } finally {
            await jc.close().catch(() => undefined);
          }
        } finally {
          await janitor.close().catch(() => undefined);
        }
      } finally {
        await ch.close().catch(() => undefined);
      }
    } finally {
      await raw.close().catch(() => undefined);
    }
  }, 30000);
});
