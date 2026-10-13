import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  RabbitmqService,
  getOriginalRoutingKey,
  isAllowedLkRoutingKey,
  resolveEffectiveRoutingKey,
  LK_RETRY_COUNT_HEADER,
  LK_ORIGINAL_ROUTING_KEY_HEADER,
  LK_MAX_RETRIES,
} from '../src/rabbitmq/rabbitmq.module';

afterEach(() => {
  vi.useRealTimers();
});

function service() {
  const config = { get: () => undefined } as never;
  return new RabbitmqService(config);
}

/** Confirm-capable fake: per-message publish callback + return emission. */
function confirmChannel(name: string, behavior: { kind: 'ack' | 'nack' } = { kind: 'ack' }) {
  const calls: { ack: unknown[]; nack: unknown[]; published: unknown[] } = {
    ack: [],
    nack: [],
    published: [],
  };
  const returnHandlers: Array<(m: unknown) => void> = [];
  const ch = {
    name,
    calls,
    async consume() {
      return { consumerTag: `${name}-tag` };
    },
    ack(msg: unknown) {
      calls.ack.push(msg);
    },
    nack(msg: unknown, all: boolean, requeue: boolean) {
      calls.nack.push({ msg, all, requeue });
    },
    publish(exchange: string, key: string, content: Buffer, pOpts: unknown, cb?: (e: Error | null) => void) {
      calls.published.push({ exchange, key, content, opts: pOpts });
      if (typeof cb === 'function') {
        setImmediate(() => {
          if (behavior.kind === 'nack') cb(new Error('broker nack'));
          else cb(null);
        });
      }
      return true;
    },
    on(ev: string, fn: (m: unknown) => void) {
      if (ev === 'return') returnHandlers.push(fn);
    },
    async assertExchange() {},
    async assertQueue() {},
    async bindQueue() {},
    async prefetch() {},
    async close() {},
    async checkQueue(queue: string) {
      return { messageCount: 0, queue };
    },
    trigger(_msg: unknown) {
      throw new Error('no consumer in this spec');
    },
  };
  return ch;
}

function wire(svc: RabbitmqService, ch: ReturnType<typeof confirmChannel>) {
  (svc as unknown as { channel: unknown }).channel = ch;
  (svc as unknown as { attachReturnListener: (c: unknown) => void }).attachReturnListener.call(svc, ch);
}

let nextDeliveryTag = 1000;
function freshTag(): number {
  nextDeliveryTag += 1;
  return nextDeliveryTag;
}

function msg(headers: Record<string, unknown> = {}, fieldsRoutingKey = 'lk.reference.employee.upserted.v1') {
  return {
    fields: { routingKey: fieldsRoutingKey, deliveryTag: freshTag(), redelivered: false },
    properties: { headers, contentType: 'application/json', messageId: 'mid-1' },
    content: Buffer.from(JSON.stringify({ eventId: 'evt-1', eventType: 'employee.upserted' })),
  };
}

describe('Retry routing-key preservation (Etap 1)', () => {
  it('accepts only allowlisted routing keys in the header (no arbitrary trust)', () => {
    expect(isAllowedLkRoutingKey('lk.reference.employee.upserted.v1')).toBe(true);
    expect(isAllowedLkRoutingKey('edo.lk-reference-sync')).toBe(false);
    expect(isAllowedLkRoutingKey('lk.reference.evil.v1')).toBe(false);
    expect(getOriginalRoutingKey({ [LK_ORIGINAL_ROUTING_KEY_HEADER]: 'lk.reference.position.upserted.v1' })).toBe(
      'lk.reference.position.upserted.v1',
    );
    expect(getOriginalRoutingKey({ [LK_ORIGINAL_ROUTING_KEY_HEADER]: 'evil' })).toBeNull();
    expect(getOriginalRoutingKey({})).toBeNull();
  });

  it('resolves effective key for normal, retry-redelivered, and old-format messages', () => {
    const q = 'edo.lk-reference-sync';
    expect(resolveEffectiveRoutingKey('lk.reference.employee.upserted.v1', {}, q)).toBe(
      'lk.reference.employee.upserted.v1',
    );
    expect(
      resolveEffectiveRoutingKey(q, { [LK_ORIGINAL_ROUTING_KEY_HEADER]: 'lk.reference.department.upserted.v1' }, q),
    ).toBe('lk.reference.department.upserted.v1');
    expect(resolveEffectiveRoutingKey(q, {}, q)).toBe(q);
    expect(resolveEffectiveRoutingKey(q, { [LK_ORIGINAL_ROUTING_KEY_HEADER]: 'evil' }, q)).toBe(q);
  });

  it('async retry preserves original routing key in header + bumps count (single publish path)', async () => {
    const svc = service();
    const pub = confirmChannel('pub');
    const delivery = confirmChannel('delivery');
    wire(svc, pub);
    const m = msg({}, 'lk.reference.position.upserted.v1');
    const ok = await svc.retryLaterAsync(delivery as never, m as never, 'lk.reference.position.upserted.v1', 0);
    expect(ok).toBe(true);
    expect(pub.calls.published).toHaveLength(1);
    const sent = pub.calls.published[0] as {
      exchange: string;
      key: string;
      opts: { headers: Record<string, unknown>; mandatory: boolean };
    };
    expect(sent.exchange).toBe('');
    expect(sent.key).toBe('edo.lk-reference-sync.retry');
    expect(sent.opts.mandatory).toBe(true);
    expect(sent.opts.headers[LK_RETRY_COUNT_HEADER]).toBe(1);
    expect(sent.opts.headers[LK_ORIGINAL_ROUTING_KEY_HEADER]).toBe('lk.reference.position.upserted.v1');
    expect(delivery.calls.ack).toHaveLength(1);
    await svc.onModuleDestroy();
  });

  it('keeps existing valid header when fields key is the queue name (redelivery chain)', async () => {
    const svc = service();
    const pub = confirmChannel('pub');
    const delivery = confirmChannel('delivery');
    wire(svc, pub);
    const m = msg(
      { [LK_RETRY_COUNT_HEADER]: 2, [LK_ORIGINAL_ROUTING_KEY_HEADER]: 'lk.reference.employee.upserted.v1' },
      'edo.lk-reference-sync',
    );
    const ok = await svc.retryLaterAsync(delivery as never, m as never, 'edo.lk-reference-sync', 0);
    expect(ok).toBe(true);
    const sent = pub.calls.published[0] as { opts: { headers: Record<string, unknown> } };
    expect(sent.opts.headers[LK_RETRY_COUNT_HEADER]).toBe(3);
    expect(sent.opts.headers[LK_ORIGINAL_ROUTING_KEY_HEADER]).toBe('lk.reference.employee.upserted.v1');
    await svc.onModuleDestroy();
  });

  it('never republishes retry to the shared lk.events exchange', async () => {
    const svc = service();
    const asserted: Array<{ exchange: string }> = [];
    const ch = {
      async assertExchange(ex: string) {
        asserted.push({ exchange: ex });
      },
      async assertQueue() {},
      async bindQueue() {},
    } as never;
    await svc.assertTopology(ch);
    expect(svc.exchange).toBe('lk.events');
    expect(svc.retryQueue).toBe('edo.lk-reference-sync.retry');
  });
});

describe('Async confirm retry (nack/timeout keep original recoverable)', () => {
  it('confirm nack does NOT ack original (slow-requeue scheduled, no hot loop)', async () => {
    const svc = service();
    const pub = confirmChannel('pub', { kind: 'nack' });
    const delivery = confirmChannel('delivery');
    wire(svc, pub);
    const m = msg({}, 'lk.reference.employee.upserted.v1');
    const ok = await svc.retryLaterAsync(delivery as never, m as never, 'lk.reference.employee.upserted.v1', 0);
    expect(ok).toBe(false);
    expect(delivery.calls.ack).toHaveLength(0);
    expect(delivery.calls.nack.filter((n) => (n as { requeue: boolean }).requeue)).toHaveLength(0);
    await svc.onModuleDestroy();
  });

  it('backpressure overflow schedules slow-requeue (no loss, no hot requeue)', async () => {
    const svc = service();
    (svc as unknown as { retryInflight: number }).retryInflight = 20;
    const delivery = confirmChannel('delivery');
    const pub = confirmChannel('pub');
    wire(svc, pub);
    const m = msg({}, 'lk.reference.employee.upserted.v1');
    const ok = await svc.retryLaterAsync(delivery as never, m as never, 'lk.reference.employee.upserted.v1', 0);
    expect(ok).toBe(false);
    expect(delivery.calls.ack).toHaveLength(0);
    expect(pub.calls.published).toHaveLength(0);
    (svc as unknown as { retryInflight: number }).retryInflight = 0;
    await svc.onModuleDestroy();
  });

  it(`after ${LK_MAX_RETRIES} attempts the message goes to DLQ (nack false, no retry publish)`, async () => {
    const svc = service();
    const delivery = confirmChannel('delivery');
    const pub = confirmChannel('pub');
    wire(svc, pub);
    const m = msg({ [LK_RETRY_COUNT_HEADER]: LK_MAX_RETRIES }, 'lk.reference.employee.upserted.v1');
    const ok = await svc.retryLaterAsync(delivery as never, m as never, 'lk.reference.employee.upserted.v1', 0);
    expect(ok).toBe(true);
    expect(delivery.calls.nack).toHaveLength(1);
    expect((delivery.calls.nack[0] as { requeue: boolean }).requeue).toBe(false);
    await svc.onModuleDestroy();
  });

  it('stale generation (reconnect/shutdown) never acks and never schedules recovery', async () => {
    const svc = service();
    const pub = confirmChannel('pub');
    const delivery = confirmChannel('delivery');
    wire(svc, pub);
    const m = msg({}, 'lk.reference.employee.upserted.v1');
    const ok = await svc.retryLaterAsync(delivery as never, m as never, 'lk.reference.employee.upserted.v1', 999);
    expect(ok).toBe(false);
    expect(delivery.calls.ack).toHaveLength(0);
    expect(delivery.calls.nack).toHaveLength(0);
    await svc.onModuleDestroy();
  });

  it('preserves persistent delivery on retry copy', async () => {
    const svc = service();
    const pub = confirmChannel('pub');
    const delivery = confirmChannel('delivery');
    wire(svc, pub);
    const m = msg({}, 'lk.reference.employee.upserted.v1');
    await svc.retryLaterAsync(delivery as never, m as never, 'lk.reference.employee.upserted.v1', 0);
    const sent = pub.calls.published[0] as { opts: Record<string, unknown> } | undefined;
    expect(sent?.opts['persistent']).toBe(true);
    await svc.onModuleDestroy();
  });
});
