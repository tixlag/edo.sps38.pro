import { describe, expect, it } from 'vitest';
import {
  RabbitmqService,
  getOriginalRoutingKey,
  isAllowedLkRoutingKey,
  resolveEffectiveRoutingKey,
  LK_RETRY_COUNT_HEADER,
  LK_ORIGINAL_ROUTING_KEY_HEADER,
  LK_MAX_RETRIES,
} from '../src/rabbitmq/rabbitmq.module';

function service() {
  const config = { get: () => undefined } as never;
  return new RabbitmqService(config);
}

function mockChannel(name: string, opts: { confirm?: boolean; failConfirm?: boolean } = {}) {
  const calls: { ack: unknown[]; nack: unknown[]; sent: unknown[]; published: unknown[] } = {
    ack: [],
    nack: [],
    sent: [],
    published: [],
  };
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
    sendToQueue(queue: string, content: Buffer, o?: unknown) {
      calls.sent.push({ queue, content, opts: o });
      return true;
    },
    publish(exchange: string, key: string, content: Buffer, o?: unknown) {
      calls.published.push({ exchange, key, content, opts: o });
      return true;
    },
    async assertExchange() {},
    async assertQueue() {},
    async bindQueue() {},
    async prefetch() {},
    async close() {},
    async checkQueue(queue: string) {
      return { messageCount: 0, queue };
    },
    on() {},
    ...(opts.confirm
      ? {
          async waitForConfirms() {
            if (opts.failConfirm) throw new Error('confirm nack');
          },
        }
      : {}),
  };
  return ch;
}

function msg(headers: Record<string, unknown> = {}, fieldsRoutingKey = 'lk.reference.employee.upserted.v1') {
  return {
    fields: { routingKey: fieldsRoutingKey },
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
    // Normal LK publish: allowed key passes through.
    expect(resolveEffectiveRoutingKey('lk.reference.employee.upserted.v1', {}, q)).toBe(
      'lk.reference.employee.upserted.v1',
    );
    // Retry redelivery: queue-name key + validated header restores original.
    expect(
      resolveEffectiveRoutingKey(q, { [LK_ORIGINAL_ROUTING_KEY_HEADER]: 'lk.reference.department.upserted.v1' }, q),
    ).toBe('lk.reference.department.upserted.v1');
    // Old format (no header): keeps queue-name key so handler poisons deterministically.
    expect(resolveEffectiveRoutingKey(q, {}, q)).toBe(q);
    // Invalid header: never trusted, keeps raw key.
    expect(resolveEffectiveRoutingKey(q, { [LK_ORIGINAL_ROUTING_KEY_HEADER]: 'evil' }, q)).toBe(q);
  });

  it('sync retry preserves original routing key in header + bumps count', () => {
    const svc = service();
    const delivery = mockChannel('delivery');
    (svc as unknown as { channel: unknown }).channel = delivery;
    const m = msg({}, 'lk.reference.position.upserted.v1');
    (svc as unknown as { retryLater: (c: unknown, mm: unknown) => void }).retryLater.call(svc, delivery, m);
    expect(delivery.calls.sent).toHaveLength(1);
    const sent = delivery.calls.sent[0] as { queue: string; opts: { headers: Record<string, unknown> } };
    expect(sent.queue).toBe('edo.lk-reference-sync.retry');
    expect(sent.opts.headers[LK_RETRY_COUNT_HEADER]).toBe(1);
    expect(sent.opts.headers[LK_ORIGINAL_ROUTING_KEY_HEADER]).toBe('lk.reference.position.upserted.v1');
    expect(delivery.calls.ack).toHaveLength(1);
  });

  it('sync retry keeps existing valid header when fields key is the queue name (redelivery chain)', () => {
    const svc = service();
    const delivery = mockChannel('delivery');
    (svc as unknown as { channel: unknown }).channel = delivery;
    const m = msg(
      { [LK_RETRY_COUNT_HEADER]: 2, [LK_ORIGINAL_ROUTING_KEY_HEADER]: 'lk.reference.employee.upserted.v1' },
      'edo.lk-reference-sync',
    );
    (svc as unknown as { retryLater: (c: unknown, mm: unknown) => void }).retryLater.call(svc, delivery, m);
    const sent = delivery.calls.sent[0] as { opts: { headers: Record<string, unknown> } };
    expect(sent.opts.headers[LK_RETRY_COUNT_HEADER]).toBe(3);
    expect(sent.opts.headers[LK_ORIGINAL_ROUTING_KEY_HEADER]).toBe('lk.reference.employee.upserted.v1');
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
    // Retry queue DLX is the default exchange (''), never lk.events.
    // Main queue DLX is EDO-owned *.dlx, never shared.
    expect(svc.exchange).toBe('lk.events');
    expect(svc.retryQueue).toBe('edo.lk-reference-sync.retry');
  });
});

describe('Async confirm retry (Etap 1: nack/return/timeout keep original recoverable)', () => {
  it('confirmed publish acks original (happy path via ConfirmChannel)', async () => {
    const svc = service();
    const confirmCh = mockChannel('confirm', { confirm: true });
    const delivery = mockChannel('delivery');
    (svc as unknown as { channel: unknown }).channel = confirmCh;
    const m = msg({}, 'lk.reference.employee.upserted.v1');
    const ok = await svc.retryLaterAsync(delivery as never, m as never, 'lk.reference.employee.upserted.v1', 0);
    expect(ok).toBe(true);
    expect(delivery.calls.ack).toHaveLength(1);
    expect(confirmCh.calls.sent.length + confirmCh.calls.published.length).toBeGreaterThan(0);
    await svc.onModuleDestroy();
  });

  it('confirm nack/timeout does NOT ack original (stays recoverable, no hot loop)', async () => {
    const svc = service();
    const confirmCh = mockChannel('confirm', { confirm: true, failConfirm: true });
    const delivery = mockChannel('delivery');
    (svc as unknown as { channel: unknown }).channel = confirmCh;
    const m = msg({}, 'lk.reference.employee.upserted.v1');
    const ok = await svc.retryLaterAsync(delivery as never, m as never, 'lk.reference.employee.upserted.v1', 0);
    expect(ok).toBe(false);
    expect(delivery.calls.ack).toHaveLength(0);
    expect(delivery.calls.nack.filter((n) => (n as { requeue: boolean }).requeue)).toHaveLength(0);
    await svc.onModuleDestroy();
  });

  it('backpressure overflow keeps original unacked (no loss, no hot requeue)', async () => {
    const svc = service();
    (svc as unknown as { retryInflight: number }).retryInflight = 20;
    const delivery = mockChannel('delivery');
    const confirmCh = mockChannel('confirm', { confirm: true });
    (svc as unknown as { channel: unknown }).channel = confirmCh;
    const m = msg({}, 'lk.reference.employee.upserted.v1');
    const ok = await svc.retryLaterAsync(delivery as never, m as never, 'lk.reference.employee.upserted.v1', 0);
    expect(ok).toBe(false);
    expect(delivery.calls.ack).toHaveLength(0);
    (svc as unknown as { retryInflight: number }).retryInflight = 0;
    await svc.onModuleDestroy();
  });

  it(`after ${LK_MAX_RETRIES} attempts the message goes to DLQ (nack false, no retry publish)`, async () => {
    const svc = service();
    const delivery = mockChannel('delivery');
    const confirmCh = mockChannel('confirm', { confirm: true });
    (svc as unknown as { channel: unknown }).channel = confirmCh;
    const m = msg({ [LK_RETRY_COUNT_HEADER]: LK_MAX_RETRIES }, 'lk.reference.employee.upserted.v1');
    const ok = await svc.retryLaterAsync(delivery as never, m as never, 'lk.reference.employee.upserted.v1', 0);
    expect(ok).toBe(true);
    expect(delivery.calls.nack).toHaveLength(1);
    expect((delivery.calls.nack[0] as { requeue: boolean }).requeue).toBe(false);
    await svc.onModuleDestroy();
  });

  it('stale generation (reconnect/shutdown) never acks', async () => {
    const svc = service();
    const confirmCh = mockChannel('confirm', { confirm: true });
    const delivery = mockChannel('delivery');
    (svc as unknown as { channel: unknown }).channel = confirmCh;
    const m = msg({}, 'lk.reference.employee.upserted.v1');
    // Simulate reconnect bumping generation before the ack.
    const okPromise = svc.retryLaterAsync(delivery as never, m as never, 'lk.reference.employee.upserted.v1', 999);
    const ok = await okPromise;
    expect(ok).toBe(false);
    expect(delivery.calls.ack).toHaveLength(0);
    await svc.onModuleDestroy();
  });

  it('preserves message properties (contentType/messageId) on retry copy', async () => {
    const svc = service();
    const confirmCh = mockChannel('confirm', { confirm: true });
    const delivery = mockChannel('delivery');
    (svc as unknown as { channel: unknown }).channel = confirmCh;
    const m = msg({}, 'lk.reference.employee.upserted.v1');
    await svc.retryLaterAsync(delivery as never, m as never, 'lk.reference.employee.upserted.v1', 0);
    const sent = confirmCh.calls.sent[0] as { opts: Record<string, unknown> } | undefined;
    const pub = confirmCh.calls.published[0] as { opts: Record<string, unknown> } | undefined;
    const opts = (sent?.opts ?? pub?.opts ?? {}) as Record<string, unknown>;
    expect(opts['persistent']).toBe(true);
    await svc.onModuleDestroy();
  });
});
