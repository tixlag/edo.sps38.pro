import { describe, expect, it } from 'vitest';
import {
  RabbitmqService,
  getRetryCount,
  LK_RETRY_COUNT_HEADER,
  LK_MAX_RETRIES,
} from '../src/rabbitmq/rabbitmq.module';

function service() {
  const config = { get: () => undefined } as never;
  return new RabbitmqService(config);
}

function mockChannel(name: string) {
  const calls: { ack: unknown[]; nack: unknown[]; sent: unknown[]; published: unknown[] } = {
    ack: [],
    nack: [],
    sent: [],
    published: [],
  };
  let consumeCb: ((msg: unknown) => Promise<void>) | null = null;
  const ch = {
    name,
    calls,
    async consume(_queue: string, cb: (msg: unknown) => Promise<void>) {
      consumeCb = cb;
      return { consumerTag: `${name}-tag` };
    },
    ack(msg: unknown) {
      calls.ack.push(msg);
    },
    nack(msg: unknown, all: boolean, requeue: boolean) {
      calls.nack.push({ msg, all, requeue });
    },
    sendToQueue(queue: string, content: Buffer, opts: unknown) {
      calls.sent.push({ queue, content, opts });
    },
    publish(exchange: string, key: string, content: Buffer, opts: unknown) {
      calls.published.push({ exchange, key, content, opts });
      return true;
    },
    async assertExchange() {},
    async assertQueue() {},
    async bindQueue() {},
    async prefetch() {},
    async close() {},
    on() {},
    trigger(msg: unknown) {
      if (!consumeCb) throw new Error('no consumer registered');
      return consumeCb(msg);
    },
  };
  return ch;
}

function rabbitMsg(overrides: Record<string, unknown> = {}) {
  return {
    fields: { routingKey: 'lk.reference.employee.upserted.v1' },
    properties: { headers: {} },
    content: Buffer.from('{}'),
    ...overrides,
  };
}

describe('RabbitMQ delivery-channel ack safety', () => {
  it('acks an old message on channel A even after the service switched to B', async () => {
    const svc = service();
    const channelA = mockChannel('A');
    const channelB = mockChannel('B');
    (svc as unknown as { channel: unknown }).channel = channelA;
    let capturedAck: (() => void) | null = null;
    (svc as unknown as { consumerHandler: unknown }).consumerHandler = async ({
      ack,
    }: {
      ack: () => void;
    }) => {
      capturedAck = ack;
    };
    await (svc as unknown as { subscribe: () => Promise<void> }).subscribe();
    // Channel A delivers a message; handler captures ack/nack bound to A.
    await channelA.trigger(rabbitMsg());
    expect(capturedAck).not.toBeNull();
    // Reconnect switches the service to channel B before the handler finishes.
    (svc as unknown as { channel: unknown }).channel = channelB;
    capturedAck!();
    expect(channelA.calls.ack).toHaveLength(1);
    expect(channelB.calls.ack).toHaveLength(0);
    expect(channelB.calls.nack).toHaveLength(0);
    await svc.onModuleDestroy();
  });

  it('nacks an old message on channel A, never on the reconnected B', async () => {
    const svc = service();
    const channelA = mockChannel('A');
    const channelB = mockChannel('B');
    (svc as unknown as { channel: unknown }).channel = channelA;
    let capturedNack: ((r: boolean) => void) | null = null;
    (svc as unknown as { consumerHandler: unknown }).consumerHandler = async ({
      nack,
    }: {
      nack: (r: boolean) => void;
    }) => {
      capturedNack = nack;
    };
    await (svc as unknown as { subscribe: () => Promise<void> }).subscribe();
    await channelA.trigger(rabbitMsg());
    (svc as unknown as { channel: unknown }).channel = channelB;
    capturedNack!(false);
    expect(channelA.calls.nack).toHaveLength(1);
    expect(channelB.calls.nack).toHaveLength(0);
    await svc.onModuleDestroy();
  });

  it('old channel close does not wipe a newer channel state', async () => {
    const svc = service();
    const oldConn: { handlers: Record<string, Array<(e?: unknown) => void>> } = { handlers: {} };
    const newConn: { handlers: Record<string, Array<(e?: unknown) => void>> } = { handlers: {} };
    const mkConn = (store: typeof oldConn) =>
      ({
        on: (ev: string, fn: (e?: unknown) => void) => {
          (store.handlers[ev] ??= []).push(fn);
        },
      }) as never;
    const c1 = mkConn(oldConn);
    const c2 = mkConn(newConn);
    (svc as unknown as { attachConnectionListeners: (c: unknown) => void }).attachConnectionListeners.call(
      svc,
      c1,
    );
    // Simulate reconnect: service now tracks the new connection.
    (svc as unknown as { connection: unknown }).connection = 'new-conn-stub';
    // Re-attach for the new connection (identity = c2 object is not tracked by
    // value, but `this.connection` no longer equals c1, so c1 close is stale).
    // Trigger old connection close: must NOT schedule/clear new state.
    const before = (svc as unknown as { connection: unknown }).connection;
    for (const fn of oldConn.handlers['close'] ?? []) fn(new Error('close'));
    const after = (svc as unknown as { connection: unknown }).connection;
    expect(after).toBe(before);
    expect(c1).toBeDefined();
    expect(c2).toBeDefined();
    await svc.onModuleDestroy();
  });
});

describe('RabbitMQ transient retry policy (no hot loop)', () => {
  it('reads retry attempts from headers, defaults to 0', () => {
    expect(getRetryCount(undefined)).toBe(0);
    expect(getRetryCount({})).toBe(0);
    expect(getRetryCount({ [LK_RETRY_COUNT_HEADER]: 2 })).toBe(2);
    expect(getRetryCount({ [LK_RETRY_COUNT_HEADER]: 'bad' })).toBe(0);
  });

  it('transient failure publishes to retry queue with TTL and acks original (no immediate nack)', () => {
    const svc = service();
    const delivery = mockChannel('delivery');
    (svc as unknown as { channel: unknown }).channel = delivery;
    const msg = rabbitMsg({ properties: { headers: {} } });
    (svc as unknown as { retryLater: (c: unknown, m: unknown) => void }).retryLater.call(
      svc,
      delivery,
      msg,
    );
    // One delayed copy, original acked, no hot nack(true).
    expect(delivery.calls.sent).toHaveLength(1);
    const sent = delivery.calls.sent[0] as { queue: string; opts: { headers: Record<string, unknown> } };
    expect(sent.queue).toBe('edo.lk-reference-sync.retry');
    expect(sent.opts.headers[LK_RETRY_COUNT_HEADER]).toBe(1);
    expect(delivery.calls.ack).toHaveLength(1);
    expect(delivery.calls.nack.filter((n) => (n as { requeue: boolean }).requeue)).toHaveLength(0);
  });

  it('increments the attempt counter on each retry', () => {
    const svc = service();
    const delivery = mockChannel('delivery');
    (svc as unknown as { channel: unknown }).channel = delivery;
    const msg = rabbitMsg({ properties: { headers: { [LK_RETRY_COUNT_HEADER]: 3 } } });
    (svc as unknown as { retryLater: (c: unknown, m: unknown) => void }).retryLater.call(
      svc,
      delivery,
      msg,
    );
    const sent = delivery.calls.sent[0] as { opts: { headers: Record<string, unknown> } };
    expect(sent.opts.headers[LK_RETRY_COUNT_HEADER]).toBe(4);
    expect(delivery.calls.ack).toHaveLength(1);
  });

  it(`after ${LK_MAX_RETRIES} attempts the message goes to DLQ (nack false, no retry publish)`, () => {
    const svc = service();
    const delivery = mockChannel('delivery');
    (svc as unknown as { channel: unknown }).channel = delivery;
    const msg = rabbitMsg({
      properties: { headers: { [LK_RETRY_COUNT_HEADER]: LK_MAX_RETRIES } },
    });
    (svc as unknown as { retryLater: (c: unknown, m: unknown) => void }).retryLater.call(
      svc,
      delivery,
      msg,
    );
    expect(delivery.calls.sent).toHaveLength(0);
    expect(delivery.calls.nack).toHaveLength(1);
    const nack = delivery.calls.nack[0] as { requeue: boolean };
    expect(nack.requeue).toBe(false);
  });

  it('asserts retry queue topology (TTL + DLX back to main)', async () => {
    const svc = service();
    const asserted: Array<{ queue: string; args: Record<string, unknown> }> = [];
    const ch = {
      async assertExchange() {},
      async assertQueue(queue: string, opts: { arguments?: Record<string, unknown> }) {
        asserted.push({ queue, args: opts.arguments ?? {} });
      },
      async bindQueue() {},
    } as never;
    await svc.assertTopology(ch);
    const retry = asserted.find((a) => a.queue === 'edo.lk-reference-sync.retry');
    expect(retry).toBeDefined();
    expect(retry!.args['x-message-ttl']).toBe(5000);
    expect(retry!.args['x-dead-letter-routing-key']).toBe('edo.lk-reference-sync');
    expect(svc.retryQueue).toBe('edo.lk-reference-sync.retry');
    expect(svc.dlq).toBe('edo.lk-reference-sync.dlq');
  });

  it('handler throw triggers delayed retry, not immediate nack(true)', async () => {
    const svc = service();
    const delivery = mockChannel('delivery');
    (svc as unknown as { channel: unknown }).channel = delivery;
    (svc as unknown as { consumerHandler: unknown }).consumerHandler = async () => {
      throw new Error('MariaDB down');
    };
    await (svc as unknown as { subscribe: () => Promise<void> }).subscribe();
    await delivery.trigger(rabbitMsg());
    // subscribe() catches handler throw and calls retry(): retry copy + ack.
    expect(delivery.calls.sent.length + delivery.calls.published.length).toBeGreaterThan(0);
    expect(delivery.calls.ack).toHaveLength(1);
    expect(delivery.calls.nack.filter((n) => (n as { requeue: boolean }).requeue)).toHaveLength(0);
    await svc.onModuleDestroy();
  });

  it('poison still goes straight to DLQ (nack false)', async () => {
    const svc = service();
    const delivery = mockChannel('delivery');
    (svc as unknown as { channel: unknown }).channel = delivery;
    let capturedNack: ((r: boolean) => void) | null = null;
    (svc as unknown as { consumerHandler: unknown }).consumerHandler = async ({
      nack,
    }: {
      nack: (r: boolean) => void;
    }) => {
      capturedNack = nack;
    };
    await (svc as unknown as { subscribe: () => Promise<void> }).subscribe();
    await delivery.trigger(rabbitMsg());
    capturedNack!(false);
    expect(delivery.calls.nack).toHaveLength(1);
    expect((delivery.calls.nack[0] as { requeue: boolean }).requeue).toBe(false);
    await svc.onModuleDestroy();
  });
});
