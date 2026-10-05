import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  RabbitmqService,
  getRetryCount,
  LK_RETRY_COUNT_HEADER,
  LK_ORIGINAL_ROUTING_KEY_HEADER,
  LK_SOURCE_MESSAGE_ID_HEADER,
  LK_MAX_RETRIES,
} from '../src/rabbitmq/rabbitmq.module';

afterEach(() => {
  vi.useRealTimers();
});

function service() {
  const config = { get: () => undefined } as never;
  return new RabbitmqService(config);
}

type ConfirmBehavior =
  | { kind: 'ack' }
  | { kind: 'nack' }
  | { kind: 'never' };

/**
 * Confirm-capable fake channel (production path):
 * per-message `publish(ex, key, content, opts, cb)` callback, correlated
 * `basic.return` emission, controllable buffer-full, no sendToQueue shortcut.
 */
function confirmChannel(
  name: string,
  behavior: ConfirmBehavior = { kind: 'ack' },
  opts: { bufferFull?: boolean; emitReturnFor?: (o: Record<string, unknown>) => boolean } = {},
) {
  const calls: { ack: unknown[]; nack: unknown[]; published: unknown[] } = {
    ack: [],
    nack: [],
    published: [],
  };
  const returnHandlers: Array<(m: unknown) => void> = [];
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
    publish(exchange: string, key: string, content: Buffer, pOpts: unknown, cb?: (e: Error | null) => void) {
      calls.published.push({ exchange, key, content, opts: pOpts });
      if (typeof cb === 'function') {
        setImmediate(() => {
          if (opts.emitReturnFor?.(pOpts as Record<string, unknown>)) {
            const ret = { properties: { messageId: (pOpts as Record<string, unknown>)['messageId'] } };
            for (const h of [...returnHandlers]) h(ret);
          }
          if (behavior.kind === 'nack') cb(new Error('broker nack'));
          else if (behavior.kind === 'ack') cb(null);
          // 'never': callback never fires (timeout path).
        });
      }
      return !opts.bufferFull;
    },
    on(ev: string, fn: (m: unknown) => void) {
      if (ev === 'return') returnHandlers.push(fn);
    },
    emitReturnNow(msg: unknown) {
      for (const h of [...returnHandlers]) h(msg);
    },
    async assertExchange() {},
    async assertQueue() {},
    async bindQueue() {},
    async prefetch() {},
    async close() {},
    async checkQueue() {
      return { messageCount: 0 };
    },
    trigger(msg: unknown) {
      if (!consumeCb) throw new Error('no consumer registered');
      return consumeCb(msg);
    },
  };
  return ch;
}

/** Wire the service to a fake confirm channel (incl. correlated returns). */
function wire(svc: RabbitmqService, ch: ReturnType<typeof confirmChannel>) {
  (svc as unknown as { channel: unknown }).channel = ch;
  (svc as unknown as { attachReturnListener: (c: unknown) => void }).attachReturnListener.call(svc, ch);
}

let nextDeliveryTag = 100;
function freshTag(): number {
  nextDeliveryTag += 1;
  return nextDeliveryTag;
}

function rabbitMsg(overrides: Record<string, unknown> = {}) {
  return {
    fields: { routingKey: 'lk.reference.employee.upserted.v1', deliveryTag: freshTag(), redelivered: false },
    properties: { headers: {}, messageId: 'src-mid-1' },
    content: Buffer.from(JSON.stringify({ eventId: 'evt-1' })),
    ...overrides,
  };
}

describe('RabbitMQ delivery-channel ack safety', () => {
  it('acks an old message on channel A even after the service switched to B', async () => {
    const svc = service();
    const channelA = confirmChannel('A');
    const channelB = confirmChannel('B');
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
    await channelA.trigger(rabbitMsg());
    expect(capturedAck).not.toBeNull();
    (svc as unknown as { channel: unknown }).channel = channelB;
    capturedAck!();
    expect(channelA.calls.ack).toHaveLength(1);
    expect(channelB.calls.ack).toHaveLength(0);
    expect(channelB.calls.nack).toHaveLength(0);
    await svc.onModuleDestroy();
  });

  it('nacks an old message on channel A, never on the reconnected B', async () => {
    const svc = service();
    const channelA = confirmChannel('A');
    const channelB = confirmChannel('B');
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
    (svc as unknown as { connection: unknown }).connection = 'new-conn-stub';
    const before = (svc as unknown as { connection: unknown }).connection;
    for (const fn of oldConn.handlers['close'] ?? []) fn(new Error('close'));
    const after = (svc as unknown as { connection: unknown }).connection;
    expect(after).toBe(before);
    expect(c1).toBeDefined();
    expect(c2).toBeDefined();
    await svc.onModuleDestroy();
  });

  it('broker cancel (null delivery) triggers re-subscribe, not a silent dead consumer', async () => {
    const svc = service();
    const ch = confirmChannel('A');
    (svc as unknown as { channel: unknown }).channel = ch;
    (svc as unknown as { consumerHandler: unknown }).consumerHandler = async () => undefined;
    await (svc as unknown as { subscribe: () => Promise<void> }).subscribe();
    expect((svc as unknown as { channel: unknown }).channel).not.toBeNull();
    await ch.trigger(null);
    // Cancel clears the channel and schedules the single reconnect loop.
    expect((svc as unknown as { channel: unknown }).channel).toBeNull();
    expect(svc.getReconnectState().scheduled).toBe(true);
    await svc.onModuleDestroy();
  });
});

describe('RabbitMQ confirm-gated retry (single publish path)', () => {
  it('reads retry attempts from headers, defaults to 0', () => {
    expect(getRetryCount(undefined)).toBe(0);
    expect(getRetryCount({})).toBe(0);
    expect(getRetryCount({ [LK_RETRY_COUNT_HEADER]: 2 })).toBe(2);
    expect(getRetryCount({ [LK_RETRY_COUNT_HEADER]: 'bad' })).toBe(0);
  });

  it('confirmed publish uses mandatory + fresh messageId and acks original', async () => {
    const svc = service();
    const pub = confirmChannel('pub');
    const delivery = confirmChannel('delivery');
    wire(svc, pub);
    const msg = rabbitMsg({ properties: { headers: {}, messageId: 'src-mid-1' } });
    const ok = await svc.retryLaterAsync(delivery as never, msg as never, 'lk.reference.employee.upserted.v1', 0);
    expect(ok).toBe(true);
    expect(pub.calls.published).toHaveLength(1);
    const sent = pub.calls.published[0] as {
      exchange: string;
      key: string;
      opts: Record<string, unknown>;
    };
    // Default exchange to the retry queue (wire-identical to sendToQueue).
    expect(sent.exchange).toBe('');
    expect(sent.key).toBe('edo.lk-reference-sync.retry');
    expect(sent.opts['mandatory']).toBe(true);
    expect(sent.opts['persistent']).toBe(true);
    const headers = sent.opts['headers'] as Record<string, unknown>;
    expect(headers[LK_RETRY_COUNT_HEADER]).toBe(1);
    expect(headers[LK_ORIGINAL_ROUTING_KEY_HEADER]).toBe('lk.reference.employee.upserted.v1');
    // Fresh unique id on the wire; source id preserved in a header.
    expect(typeof sent.opts['messageId']).toBe('string');
    expect(sent.opts['messageId']).not.toBe('src-mid-1');
    expect(headers[LK_SOURCE_MESSAGE_ID_HEADER]).toBe('src-mid-1');
    expect(delivery.calls.ack).toHaveLength(1);
    expect(delivery.calls.nack).toHaveLength(0);
    await svc.onModuleDestroy();
  });

  it('correlated return (unroutable) fails the publish: no ack, slow-requeue scheduled', async () => {
    vi.useFakeTimers();
    const svc = service();
    const pub = confirmChannel('pub', { kind: 'ack' }, { emitReturnFor: () => true });
    const delivery = confirmChannel('delivery');
    wire(svc, pub);
    const msg = rabbitMsg();
    const p = svc.retryLaterAsync(delivery as never, msg as never, 'lk.reference.employee.upserted.v1', 0);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBe(false);
    expect(delivery.calls.ack).toHaveLength(0);
    // Bounded recovery: exactly one delayed nack(true) per failure.
    await vi.advanceTimersByTimeAsync(5000);
    const requeues = delivery.calls.nack.filter((n) => (n as { requeue: boolean }).requeue);
    expect(requeues).toHaveLength(1);
    await svc.onModuleDestroy();
  });

  it('a return for ANOTHER publishId does not fail an unrelated publish', async () => {
    const svc = service();
    const pub = confirmChannel('pub');
    const delivery = confirmChannel('delivery');
    wire(svc, pub);
    // Foreign return arrives before our publish (late callback scenario).
    pub.emitReturnNow({ properties: { messageId: 'someone-else' } });
    const msg = rabbitMsg();
    const ok = await svc.retryLaterAsync(delivery as never, msg as never, 'lk.reference.employee.upserted.v1', 0);
    expect(ok).toBe(true);
    expect(delivery.calls.ack).toHaveLength(1);
    await svc.onModuleDestroy();
  });

  it('concurrent publishes: return for the first fails only the first', async () => {
    const svc = service();
    let n = 0;
    const pub = confirmChannel(
      'pub',
      { kind: 'ack' },
      {
        emitReturnFor: () => {
          n += 1;
          return n === 1;
        },
      },
    );
    const d1 = confirmChannel('d1');
    const d2 = confirmChannel('d2');
    wire(svc, pub);
    const m1 = rabbitMsg({ properties: { headers: {}, messageId: 'm1' } });
    const m2 = rabbitMsg({
      properties: { headers: {}, messageId: 'm2' },
      content: Buffer.from(JSON.stringify({ eventId: 'evt-2' })),
    });
    const [ok1, ok2] = await Promise.all([
      svc.retryLaterAsync(d1 as never, m1 as never, 'lk.reference.employee.upserted.v1', 0),
      svc.retryLaterAsync(d2 as never, m2 as never, 'lk.reference.employee.upserted.v1', 0),
    ]);
    expect(ok1).toBe(false);
    expect(ok2).toBe(true);
    expect(d1.calls.ack).toHaveLength(0);
    expect(d2.calls.ack).toHaveLength(1);
    await svc.onModuleDestroy();
  });

  it('late return from a previous generation is ignored', async () => {
    const svc = service();
    const pub = confirmChannel('pub');
    const delivery = confirmChannel('delivery');
    wire(svc, pub);
    const msg = rabbitMsg();
    const okP = svc.retryLaterAsync(delivery as never, msg as never, 'lk.reference.employee.upserted.v1', 0);
    // Simulate reconnect BEFORE the confirm lands (generation bump).
    (svc as unknown as { generation: number }).generation += 1;
    // Late return for our publishId arrives on the old channel.
    const sent = pub.calls.published[0] as { opts: Record<string, unknown> };
    pub.emitReturnNow({ properties: { messageId: sent.opts['messageId'] } });
    const ok = await okP;
    // Stale generation: never ack, return ignored (no crash, no ack).
    expect(ok).toBe(false);
    expect(delivery.calls.ack).toHaveLength(0);
    await svc.onModuleDestroy();
  });

  it('confirm nack fails the publish without ack (recoverable via slow-requeue)', async () => {
    const svc = service();
    const pub = confirmChannel('pub', { kind: 'nack' });
    const delivery = confirmChannel('delivery');
    wire(svc, pub);
    const msg = rabbitMsg();
    const ok = await svc.retryLaterAsync(delivery as never, msg as never, 'lk.reference.employee.upserted.v1', 0);
    expect(ok).toBe(false);
    expect(delivery.calls.ack).toHaveLength(0);
    expect(delivery.calls.nack.filter((n) => (n as { requeue: boolean }).requeue)).toHaveLength(0);
    await svc.onModuleDestroy();
  });

  it('confirm timeout fails without ack (no silent success)', async () => {
    vi.useFakeTimers();
    const svc = service();
    const pub = confirmChannel('pub', { kind: 'never' });
    const delivery = confirmChannel('delivery');
    wire(svc, pub);
    const msg = rabbitMsg();
    const p = svc.retryLaterAsync(delivery as never, msg as never, 'lk.reference.employee.upserted.v1', 0);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await p).toBe(false);
    expect(delivery.calls.ack).toHaveLength(0);
    await svc.onModuleDestroy();
  });

  it('buffer-full (publish false) waits for the confirm instead of re-publishing or acking early', async () => {
    const svc = service();
    const pub = confirmChannel('pub', { kind: 'ack' }, { bufferFull: true });
    const delivery = confirmChannel('delivery');
    wire(svc, pub);
    const msg = rabbitMsg();
    const ok = await svc.retryLaterAsync(delivery as never, msg as never, 'lk.reference.employee.upserted.v1', 0);
    expect(ok).toBe(true);
    expect(pub.calls.published).toHaveLength(1);
    expect(delivery.calls.ack).toHaveLength(1);
    await svc.onModuleDestroy();
  });

  it('channel without per-message confirms fails closed (never acked as placed)', async () => {
    const svc = service();
    const noConfirm = {
      calls: { ack: [] as unknown[], nack: [] as unknown[], published: [] as unknown[] },
      ack(msg: unknown) {
        (this.calls.ack as unknown[]).push(msg);
      },
      nack(msg: unknown, all: boolean, requeue: boolean) {
        (this.calls.nack as unknown[]).push({ msg, all, requeue });
      },
    };
    (svc as unknown as { channel: unknown }).channel = noConfirm;
    const delivery = confirmChannel('delivery');
    const msg = rabbitMsg();
    const ok = await svc.retryLaterAsync(delivery as never, msg as never, 'lk.reference.employee.upserted.v1', 0);
    expect(ok).toBe(false);
    expect(delivery.calls.ack).toHaveLength(0);
    await svc.onModuleDestroy();
  });

  it('ConfirmChannel creation failure fails closed (no plain-channel fallback)', async () => {
    const svc = service();
    svc.setDialForTests(async () => ({}) as never);
    svc.setChannelFactoryForTests(async () => {
      throw new Error('no confirm support');
    });
    await expect(
      (svc as unknown as { ensureConnected: (t: number) => Promise<void> }).ensureConnected.call(svc, 50),
    ).rejects.toThrow(/no confirm support/);
    expect((svc as unknown as { channel: unknown }).channel).toBeNull();
    await svc.onModuleDestroy();
  });

  it('two identical deliveries recover independently (no timer clash, no shared budget)', async () => {
    vi.useFakeTimers();
    const svc = service();
    const pub = confirmChannel('pub', { kind: 'nack' });
    const dA = confirmChannel('dA');
    const dB = confirmChannel('dB');
    wire(svc, pub);
    const body = Buffer.from(JSON.stringify({ eventId: 'evt-same' }));
    const mA = { fields: { routingKey: 'lk.reference.employee.upserted.v1', deliveryTag: 11, redelivered: false }, properties: { headers: {} }, content: body };
    const mB = { fields: { routingKey: 'lk.reference.employee.upserted.v1', deliveryTag: 12, redelivered: false }, properties: { headers: {} }, content: body };
    const pA = svc.retryLaterAsync(dA as never, mA as never, 'lk.reference.employee.upserted.v1', 0);
    const pB = svc.retryLaterAsync(dB as never, mB as never, 'lk.reference.employee.upserted.v1', 0);
    await vi.advanceTimersByTimeAsync(10);
    await expect(pA).resolves.toBe(false);
    await expect(pB).resolves.toBe(false);
    // The second schedule must NOT cancel the first delivery's timer.
    await vi.advanceTimersByTimeAsync(5000);
    expect(dA.calls.nack.filter((n) => (n as { requeue: boolean }).requeue)).toHaveLength(1);
    expect(dB.calls.nack.filter((n) => (n as { requeue: boolean }).requeue)).toHaveLength(1);
    expect(dA.calls.nack.filter((n) => !(n as { requeue: boolean }).requeue)).toHaveLength(0);
    expect(dB.calls.nack.filter((n) => !(n as { requeue: boolean }).requeue)).toHaveLength(0);
    await svc.onModuleDestroy();
  });

  it('one copy succeeding never cancels another delivery recovery', async () => {
    vi.useFakeTimers();
    const svc = service();
    let failB = true;
    const pub = confirmChannel('pub', { kind: 'ack' });
    const origPublish = pub.publish.bind(pub);
    (pub as unknown as { publish: unknown }).publish = (
      ex: string,
      key: string,
      content: Buffer,
      o: unknown,
      cb?: (e: Error | null) => void,
    ) => {
      if (failB && typeof cb === 'function') {
        failB = false;
        setImmediate(() => cb(new Error('transient nack')));
        return true;
      }
      return origPublish(ex, key, content, o, cb);
    };
    const dA = confirmChannel('dA');
    const dB = confirmChannel('dB');
    wire(svc, pub);
    const mB = rabbitMsg();
    // B fails first (timer armed for B's tag)...
    const pB = svc.retryLaterAsync(dB as never, mB as never, 'lk.reference.employee.upserted.v1', 0);
    await vi.advanceTimersByTimeAsync(10);
    await expect(pB).resolves.toBe(false);
    // ...then A (different tag, same-shape content) succeeds and acks.
    const mA = rabbitMsg();
    const pA = svc.retryLaterAsync(dA as never, mA as never, 'lk.reference.employee.upserted.v1', 0);
    await vi.advanceTimersByTimeAsync(10);
    await expect(pA).resolves.toBe(true);
    expect(dA.calls.ack).toHaveLength(1);
    // B's recovery still fires afterwards.
    await vi.advanceTimersByTimeAsync(5000);
    expect(dB.calls.nack.filter((n) => (n as { requeue: boolean }).requeue)).toHaveLength(1);
    expect(dA.calls.nack).toHaveLength(0);
    await svc.onModuleDestroy();
  });

  it('four identical copies keep independent budgets (no pooled exhaustion to DLQ)', async () => {
    vi.useFakeTimers();
    const svc = service();
    const pub = confirmChannel('pub', { kind: 'nack' });
    wire(svc, pub);
    const body = Buffer.from(JSON.stringify({ eventId: 'evt-quad' }));
    const chans = [confirmChannel('q1'), confirmChannel('q2'), confirmChannel('q3'), confirmChannel('q4')];
    const calls = chans.map((d, i) => {
      const m = { fields: { routingKey: 'lk.reference.employee.upserted.v1', deliveryTag: 21 + i, redelivered: false }, properties: { headers: {} }, content: body };
      return svc.retryLaterAsync(d as never, m as never, 'lk.reference.employee.upserted.v1', 0);
    });
    await vi.advanceTimersByTimeAsync(10);
    for (const c of calls) await expect(c).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    for (const d of chans) {
      expect(d.calls.nack.filter((n) => (n as { requeue: boolean }).requeue)).toHaveLength(1);
      expect(d.calls.nack.filter((n) => !(n as { requeue: boolean }).requeue)).toHaveLength(0);
    }
    await svc.onModuleDestroy();
  });

  it('reconnect cleanup keeps the live redelivery path (old timer dies, new delivery recovers)', async () => {
    vi.useFakeTimers();
    const svc = service();
    const pub = confirmChannel('pub', { kind: 'nack' });
    const dOld = confirmChannel('dOld');
    wire(svc, pub);
    const body = Buffer.from(JSON.stringify({ eventId: 'evt-reconn' }));
    const mOld = { fields: { routingKey: 'lk.reference.employee.upserted.v1', deliveryTag: 31, redelivered: false }, properties: { headers: {} }, content: body };
    const pOld = svc.retryLaterAsync(dOld as never, mOld as never, 'lk.reference.employee.upserted.v1', 0);
    await vi.advanceTimersByTimeAsync(10);
    await expect(pOld).resolves.toBe(false);
    // Reconnect: dead-generation timers are cancelled; broker redelivers anew.
    (svc as unknown as { clearChannelState: () => void }).clearChannelState.call(svc);
    await vi.advanceTimersByTimeAsync(6000);
    expect(dOld.calls.nack).toHaveLength(0);
    // Redelivery on the new generation schedules a fresh recovery entry.
    const gen = (svc as unknown as { generation: number }).generation;
    expect(gen).toBe(1);
    const dNew = confirmChannel('dNew');
    (svc as unknown as { channel: unknown }).channel = pub;
    const mNew = { fields: { routingKey: 'lk.reference.employee.upserted.v1', deliveryTag: 32, redelivered: true }, properties: { headers: {} }, content: body };
    const pNew = svc.retryLaterAsync(dNew as never, mNew as never, 'lk.reference.employee.upserted.v1', gen);
    await vi.advanceTimersByTimeAsync(10);
    await expect(pNew).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(dNew.calls.nack.filter((n) => (n as { requeue: boolean }).requeue)).toHaveLength(1);
    await svc.onModuleDestroy();
  });

  it('stall tracking overflow recycles the channel (no untracked timers, broker requeues)', async () => {
    const svc = service();
    const pub = confirmChannel('pub', { kind: 'nack' });
    const d = confirmChannel('d');
    wire(svc, pub);
    // Fill tracking to the cap with foreign entries.
    const stalls = (svc as unknown as { stalls: Map<string, { timer: null; token: object }> }).stalls;
    for (let i = 0; i < 1000; i++) stalls.set(`9:fill-${i}`, { timer: null, token: {} });
    let closed = 0;
    (d as unknown as { close: () => Promise<void> }).close = async () => {
      closed += 1;
    };
    const msg = rabbitMsg();
    const ok = await svc.retryLaterAsync(d as never, msg as never, 'lk.reference.employee.upserted.v1', 0);
    expect(ok).toBe(false);
    // No untracked fallback timer, no nack from here: the channel is recycled
    // so the broker requeues everything unacked (message preserved, rate via
    // reconnect backoff). Reachable only on leak/miswiring (prefetch caps
    // live deliveries at ~10); the error is unmissable in logs.
    expect(closed).toBe(1);
    expect(d.calls.nack).toHaveLength(0);
    expect(d.calls.ack).toHaveLength(0);
    expect(stalls.size).toBe(0);
    expect(svc.getReconnectState().scheduled).toBe(true);
    await svc.onModuleDestroy();
  });

  it('exactly one settlement per deliveryTag across fail -> redeliver -> success', async () => {
    vi.useFakeTimers();
    const svc = service();
    const pub = confirmChannel('pub', { kind: 'nack' });
    const d1 = confirmChannel('d1');
    const d2 = confirmChannel('d2');
    wire(svc, pub);
    const body = Buffer.from(JSON.stringify({ eventId: 'evt-once' }));
    const m1 = { fields: { routingKey: 'lk.reference.employee.upserted.v1', deliveryTag: 41, redelivered: false }, properties: { headers: {} }, content: body };
    const p1 = svc.retryLaterAsync(d1 as never, m1 as never, 'lk.reference.employee.upserted.v1', 0);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p1).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    // Redelivery under a new tag succeeds (confirm now acks).
    const pubOk = confirmChannel('pubOk');
    (svc as unknown as { channel: unknown }).channel = pubOk;
    (svc as unknown as { attachReturnListener: (c: unknown) => void }).attachReturnListener.call(svc, pubOk);
    const m2 = { fields: { routingKey: 'lk.reference.employee.upserted.v1', deliveryTag: 42, redelivered: true }, properties: { headers: {} }, content: body };
    const p2 = svc.retryLaterAsync(d2 as never, m2 as never, 'lk.reference.employee.upserted.v1', 0);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p2).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(d1.calls.ack).toHaveLength(0);
    expect(d1.calls.nack).toHaveLength(1);
    expect(d2.calls.ack).toHaveLength(1);
    expect(d2.calls.nack).toHaveLength(0);
    await svc.onModuleDestroy();
  });

  it('REGRESSION (stall lifecycle): 1050 sequential deliveries leave no history', async () => {
    // Defect: the timer callback cleared entry.timer but kept the entry, so
    // sequential deliveries with NEW tags (like real redeliveries) accumulated
    // history until STALL_MAX_TRACKED flipped the path into immediate nack.
    // Here 1050 sequential failing deliveries (one outstanding at a time, as
    // redelivery chains arrive under prefetch) must each wait the full delay,
    // settle exactly once, and leave tracking empty — never DLQed for a mere
    // unavailable retry route.
    vi.useFakeTimers();
    const svc = service();
    const pub = confirmChannel('pub', { kind: 'nack' });
    const d = confirmChannel('d');
    wire(svc, pub);
    const size = () => (svc as unknown as { stalls: Map<string, unknown> }).stalls.size;
    const requeues = () => d.calls.nack.filter((n) => (n as { requeue: boolean }).requeue).length;
    const body = Buffer.from(JSON.stringify({ eventId: 'evt-history' }));
    let maxSize = 0;
    const N = 1050;
    for (let i = 0; i < N; i++) {
      const m = { fields: { routingKey: 'lk.reference.employee.upserted.v1', deliveryTag: 10000 + i, redelivered: i > 0 }, properties: { headers: {} }, content: body };
      const p = svc.retryLaterAsync(d as never, m as never, 'lk.reference.employee.upserted.v1', 0);
      await vi.advanceTimersByTimeAsync(10);
      await expect(p).resolves.toBe(false);
      // Delay preserved per delivery: nothing fires early (total < 5000)...
      await vi.advanceTimersByTimeAsync(4989);
      expect(requeues()).toBe(i);
      await vi.advanceTimersByTimeAsync(1);
      expect(requeues()).toBe(i + 1);
      maxSize = Math.max(maxSize, size());
    }
    // Settled deliveries must not accumulate: bounded by live deliveries only.
    expect(maxSize).toBeLessThanOrEqual(2);
    expect(size()).toBe(0);
    // ...and none was diverted to DLQ for a mere unavailable retry route.
    expect(d.calls.nack.filter((n) => !(n as { requeue: boolean }).requeue)).toHaveLength(0);
    expect(d.calls.ack).toHaveLength(0);
    await svc.onModuleDestroy();
  });

  it('settled entries are freed; later deliveries start clean', async () => {
    vi.useFakeTimers();
    const svc = service();
    const pub = confirmChannel('pub', { kind: 'nack' });
    const d = confirmChannel('d');
    wire(svc, pub);
    const size = () => (svc as unknown as { stalls: Map<string, unknown> }).stalls.size;
    const m1 = { fields: { routingKey: 'lk.reference.employee.upserted.v1', deliveryTag: 81, redelivered: false }, properties: { headers: {} }, content: Buffer.from('{"e":1}') };
    const p1 = svc.retryLaterAsync(d as never, m1 as never, 'lk.reference.employee.upserted.v1', 0);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p1).resolves.toBe(false);
    expect(size()).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(size()).toBe(0);
    // A subsequent successful delivery leaves nothing behind either.
    const pubOk = confirmChannel('pubOk');
    (svc as unknown as { channel: unknown }).channel = pubOk;
    const m2 = { fields: { routingKey: 'lk.reference.employee.upserted.v1', deliveryTag: 82, redelivered: true }, properties: { headers: {} }, content: Buffer.from('{"e":1}') };
    const p2 = svc.retryLaterAsync(d as never, m2 as never, 'lk.reference.employee.upserted.v1', 0);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p2).resolves.toBe(true);
    expect(size()).toBe(0);
    await svc.onModuleDestroy();
  });

  it('same-delivery reschedule replaces the pending timer (not a redelivery): one nack; stale timers silent', async () => {
    vi.useFakeTimers();
    const svc = service();
    const pub = confirmChannel('pub', { kind: 'nack' });
    const d = confirmChannel('d');
    wire(svc, pub);
    const m = { fields: { routingKey: 'lk.reference.employee.upserted.v1', deliveryTag: 83, redelivered: false }, properties: { headers: {} }, content: Buffer.from('{"e":2}') };
    const p1 = svc.retryLaterAsync(d as never, m as never, 'lk.reference.employee.upserted.v1', 0);
    const p2 = svc.retryLaterAsync(d as never, m as never, 'lk.reference.employee.upserted.v1', 0);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p1).resolves.toBe(false);
    await expect(p2).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    // Exactly one nack for the tag despite two schedules (token replacement).
    expect(d.calls.nack).toHaveLength(1);
    // A timer armed before a generation change never settles its tag.
    const mOld = { fields: { routingKey: 'lk.reference.employee.upserted.v1', deliveryTag: 84, redelivered: false }, properties: { headers: {} }, content: Buffer.from('{"e":3}') };
    const pOld = svc.retryLaterAsync(d as never, mOld as never, 'lk.reference.employee.upserted.v1', 0);
    await vi.advanceTimersByTimeAsync(10);
    await expect(pOld).resolves.toBe(false);
    (svc as unknown as { generation: number }).generation = 99;
    await vi.advanceTimersByTimeAsync(10000);
    expect(d.calls.nack).toHaveLength(1);
    await svc.onModuleDestroy();
  });

  it('repeated route failures never divert a valid event to DLQ (waits for recovery)', async () => {
    // Policy: x-retry-count bounds the CONFIRMED retry chain only. While the
    // retry route itself is unavailable, sequential redeliveries (new tags, as
    // the broker really issues them) each get their delayed requeue — the
    // message is preserved for recovery instead of being DLQed for an outage.
    vi.useFakeTimers();
    const svc = service();
    const pub = confirmChannel('pub', { kind: 'nack' });
    const delivery = confirmChannel('delivery');
    wire(svc, pub);
    const body = Buffer.from(JSON.stringify({ eventId: 'evt-outage' }));
    for (let i = 0; i < 4; i++) {
      const m = { fields: { routingKey: 'lk.reference.employee.upserted.v1', deliveryTag: 600 + i, redelivered: i > 0 }, properties: { headers: {} }, content: body };
      const p = svc.retryLaterAsync(delivery as never, m as never, 'lk.reference.employee.upserted.v1', 0);
      await vi.advanceTimersByTimeAsync(10);
      await expect(p).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(delivery.calls.nack.filter((n) => (n as { requeue: boolean }).requeue)).toHaveLength(4);
    expect(delivery.calls.nack.filter((n) => !(n as { requeue: boolean }).requeue)).toHaveLength(0);
    expect(delivery.calls.ack).toHaveLength(0);
    await svc.onModuleDestroy();
  });

  it('recovery through the normal path: failed attempt, then redelivery succeeds (no manual close)', async () => {
    const svc = service();
    let failFirst = true;
    const pub = confirmChannel('pub', { kind: 'ack' });
    const origPublish = pub.publish.bind(pub);
    (pub as unknown as { publish: unknown }).publish = (
      ex: string,
      key: string,
      content: Buffer,
      o: unknown,
      cb?: (e: Error | null) => void,
    ) => {
      if (failFirst && typeof cb === 'function') {
        failFirst = false;
        setImmediate(() => cb(new Error('transient nack')));
        return true;
      }
      return origPublish(ex, key, content, o, cb);
    };
    const delivery = confirmChannel('delivery');
    wire(svc, pub);
    const msg = rabbitMsg();
    // First delivery: confirm fails -> false, one slow-requeue nack(true) pending.
    await expect(
      svc.retryLaterAsync(delivery as never, msg as never, 'lk.reference.employee.upserted.v1', 0),
    ).resolves.toBe(false);
    // Redelivery (as the broker would do after the slow-requeue nack): succeeds.
    const ok = await svc.retryLaterAsync(delivery as never, msg as never, 'lk.reference.employee.upserted.v1', 0);
    expect(ok).toBe(true);
    expect(delivery.calls.ack).toHaveLength(1);
    await svc.onModuleDestroy();
  });

  it('increments the attempt counter on each retry', async () => {
    const svc = service();
    const pub = confirmChannel('pub');
    const delivery = confirmChannel('delivery');
    wire(svc, pub);
    const msg = rabbitMsg({ properties: { headers: { [LK_RETRY_COUNT_HEADER]: 3 } } });
    await svc.retryLaterAsync(delivery as never, msg as never, 'lk.reference.employee.upserted.v1', 0);
    const sent = pub.calls.published[0] as { opts: { headers: Record<string, unknown> } };
    expect(sent.opts.headers[LK_RETRY_COUNT_HEADER]).toBe(4);
    expect(delivery.calls.ack).toHaveLength(1);
    await svc.onModuleDestroy();
  });

  it(`after ${LK_MAX_RETRIES} attempts the message goes to DLQ (nack false, no retry publish)`, async () => {
    const svc = service();
    const pub = confirmChannel('pub');
    const delivery = confirmChannel('delivery');
    wire(svc, pub);
    const msg = rabbitMsg({
      properties: { headers: { [LK_RETRY_COUNT_HEADER]: LK_MAX_RETRIES } },
    });
    const ok = await svc.retryLaterAsync(delivery as never, msg as never, 'lk.reference.employee.upserted.v1', 0);
    expect(ok).toBe(true);
    expect(pub.calls.published).toHaveLength(0);
    expect(delivery.calls.nack).toHaveLength(1);
    const nack = delivery.calls.nack[0] as { requeue: boolean };
    expect(nack.requeue).toBe(false);
    await svc.onModuleDestroy();
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

  it('handler throw triggers confirm-gated retry, not immediate nack(true)', async () => {
    const svc = service();
    const delivery = confirmChannel('delivery');
    // Subscribe on the delivery channel first (it captures the deliverer)...
    (svc as unknown as { channel: unknown }).channel = delivery;
    (svc as unknown as { consumerHandler: unknown }).consumerHandler = async () => {
      throw new Error('MariaDB down');
    };
    await (svc as unknown as { subscribe: () => Promise<void> }).subscribe();
    // ...then switch the publish path to the confirm channel.
    const pub = confirmChannel('pub');
    (svc as unknown as { channel: unknown }).channel = pub;
    (svc as unknown as { attachReturnListener: (c: unknown) => void }).attachReturnListener.call(svc, pub);
    await delivery.trigger(rabbitMsg());
    await new Promise((r) => setTimeout(r, 30));
    expect(pub.calls.published).toHaveLength(1);
    expect(delivery.calls.ack).toHaveLength(1);
    expect(delivery.calls.nack.filter((n) => (n as { requeue: boolean }).requeue)).toHaveLength(0);
    await svc.onModuleDestroy();
  });

  it('poison still goes straight to DLQ (nack false)', async () => {
    const svc = service();
    const delivery = confirmChannel('delivery');
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

  it('diagnostics use an isolated channel: a 404 never closes the delivery channel', async () => {
    const svc = service();
    let deliveryClosed = false;
    const delivery = {
      ...confirmChannel('delivery'),
      async close() {
        deliveryClosed = true;
      },
    };
    let diagClosed = false;
    const diag = {
      async checkQueue(queue: string) {
        if (String(queue).endsWith('.retry')) {
          const err = new Error('NOT_FOUND - no queue') as Error & { code: number };
          err.code = 404;
          throw err;
        }
        return { messageCount: 3 };
      },
      async close() {
        diagClosed = true;
      },
      on() {},
    };
    (svc as unknown as { channel: unknown }).channel = delivery;
    (svc as unknown as { connection: unknown }).connection = {
      createChannel: async () => diag,
    };
    const genBefore = (svc as unknown as { generation: number }).generation;
    const depths = await svc.checkQueueDepths();
    expect(depths).not.toBeNull();
    expect(depths!.errors.length).toBeGreaterThan(0);
    expect(depths!.errors.join(' ')).toMatch(/retry/);
    expect(depths!.main).toBe(3);
    // Delivery channel untouched: not closed, still wired, same generation.
    expect(deliveryClosed).toBe(false);
    expect((svc as unknown as { channel: unknown }).channel).toBe(delivery);
    expect((svc as unknown as { generation: number }).generation).toBe(genBefore);
    // Unknown values are errors, never presented as trustworthy zeros.
    expect(depths!.retry).toBe(0);
    void diagClosed;
    await svc.onModuleDestroy();
  });
});
