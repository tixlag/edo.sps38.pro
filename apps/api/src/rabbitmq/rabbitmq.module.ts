import { Global, Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, type Channel, type ChannelModel } from 'amqplib';

export const LK_EVENTS_EXCHANGE_DEFAULT = 'lk.events';
export const EDO_LK_QUEUE_DEFAULT = 'edo.lk-reference-sync';

/** Published routing keys (v1). Deleted/location keys are bound for forward-compat. */
export const LK_REFERENCE_BINDINGS = [
  'lk.reference.employee.upserted.v1',
  'lk.reference.position.upserted.v1',
  'lk.reference.department.upserted.v1',
  'lk.reference.employee.deleted.v1',
  'lk.reference.location.upserted.v1',
  'lk.reference.location.deleted.v1',
  'lk.reference.position.deleted.v1',
  'lk.reference.department.deleted.v1',
];

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
const RECONNECT_MAX_MS = 30000;

/** Delayed retry for transient failures (no hot nack/requeue loop). */
export const LK_RETRY_TTL_MS = 5000;
export const LK_MAX_RETRIES = 5;
export const LK_RETRY_COUNT_HEADER = 'x-retry-count';

/** Bounded exponential backoff step for tests/ops. attempt is 0-based. */
export function computeReconnectDelay(attempt: number, jitterMs = 0): number {
  const base =
    attempt < RECONNECT_DELAYS_MS.length
      ? (RECONNECT_DELAYS_MS[attempt] as number)
      : RECONNECT_MAX_MS;
  return base + jitterMs;
}

/** Read the bounded-retry attempt counter from message headers. */
export function getRetryCount(headers: Record<string, unknown> | undefined): number {
  const v = headers?.[LK_RETRY_COUNT_HEADER];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

export type LkConsumeHandler = (msg: {
  routingKey: string;
  content: Buffer;
  headers: Record<string, unknown>;
  retryCount: number;
  ack: () => void;
  nack: (requeue: boolean) => void;
  /** Delayed bounded retry for transient failures (retry queue + TTL, not hot loop). */
  retry: () => void;
}) => Promise<void> | void;

/**
 * Minimal RabbitMQ abstraction for EDO (shared ecosystem broker).
 * EDO never runs its own production broker; RABBITMQ_URL must point to shared infra.
 * Connection is lazy and tolerant: sync/consumer fail with clear errors, boot never crashes.
 *
 * Lifecycle: connection/channel error+close listeners clear stale state and
 * schedule a single bounded reconnect loop (1s/2s/5s/10s/30s max + jitter).
 * After reconnect the topology (exchange, main queue with DLX, retry queue,
 * DLQ, bindings) is re-asserted and the consumer is re-subscribed.
 *
 * Ack safety: each delivery captures its own `deliveryChannel`; ack/nack always
 * go to the channel that delivered the message, never to a reconnected
 * `this.channel`. A stale ack may fail (ignored) — Rabbit redelivers and the
 * idempotency inbox (eventId) makes it safe. Old channel/connection close
 * events never clear a newer connection state (identity-checked).
 *
 * Retry policy (no tight loop):
 * - applied/duplicate -> ack;
 * - poison -> nack(requeue=false) -> DLQ;
 * - transient -> publish to `<queue>.retry` (TTL 5s, DLX back to main) with
 *   `x-retry-count+1`, then ack the original. After 5 attempts -> DLQ.
 */
@Injectable()
export class RabbitmqService implements OnModuleDestroy {
  private readonly logger = new Logger(RabbitmqService.name);
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private connecting: Promise<void> | null = null;
  private consumerHandler: LkConsumeHandler | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private shuttingDown = false;

  constructor(private readonly config: ConfigService) {}

  get exchange(): string {
    return (
      this.config.get<string>('LK_EVENTS_EXCHANGE') ??
      process.env.LK_EVENTS_EXCHANGE ??
      LK_EVENTS_EXCHANGE_DEFAULT
    );
  }

  get queue(): string {
    return (
      this.config.get<string>('EDO_LK_QUEUE') ??
      process.env.EDO_LK_QUEUE ??
      EDO_LK_QUEUE_DEFAULT
    );
  }

  /** EDO-owned dead-letter exchange for poison LK events. */
  get dlx(): string {
    return `${this.queue}.dlx`;
  }

  /** EDO-owned dead-letter queue: poison events land here via nack(requeue=false). */
  get dlq(): string {
    return `${this.queue}.dlq`;
  }

  /** Delayed-retry queue for transient failures (TTL -> DLX back to main). */
  get retryQueue(): string {
    return `${this.queue}.retry`;
  }

  get retryTtlMs(): number {
    return LK_RETRY_TTL_MS;
  }

  get maxRetries(): number {
    return LK_MAX_RETRIES;
  }

  private get url(): string {
    return (
      this.config.get<string>('RABBITMQ_URL') ??
      process.env.RABBITMQ_URL ??
      'amqp://guest:guest@localhost:5672'
    );
  }

  /** For tests: current reconnect/consume state without leaking sockets. */
  getReconnectState(): { attempt: number; scheduled: boolean; consuming: boolean } {
    return {
      attempt: this.reconnectAttempt,
      scheduled: this.reconnectTimer != null,
      consuming: this.consumerHandler != null,
    };
  }

  async ensureConnected(timeoutMs = 5000): Promise<void> {
    if (this.channel) return;
    if (!this.connecting) {
      this.connecting = (async () => {
        const conn = await withTimeout(connect(this.url), timeoutMs, 'RabbitMQ connect timed out');
        this.connection = conn;
        this.attachConnectionListeners(conn);
        const ch = await conn.createChannel();
        this.channel = ch;
        this.attachChannelListeners(ch);
        await this.assertTopology(ch);
        await ch.prefetch(10);
      })().catch((err) => {
        this.clearChannelState();
        this.connecting = null;
        throw err;
      });
    }
    await this.connecting;
  }

  /** Assert exchange/queue/bindings WITHOUT starting a consumer (bootstrap step). */
  async assertTopologyOnly(timeoutMs = 5000): Promise<void> {
    await this.ensureConnected(timeoutMs);
  }

  async assertTopology(ch: Channel): Promise<void> {
    // DLQ topology first: poison events must have somewhere to go.
    await ch.assertExchange(this.dlx, 'topic', { durable: true });
    await ch.assertQueue(this.dlq, { durable: true });
    await ch.bindQueue(this.dlq, this.dlx, '#');
    await ch.assertExchange(this.exchange, 'topic', { durable: true });
    await ch.assertQueue(this.queue, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': this.dlx,
      },
    });
    // Retry queue: TTL then dead-letter back to the MAIN queue via the default
    // exchange (routing key = main queue name). No consumer is attached here;
    // messages reappear on the main queue after the delay.
    await ch.assertQueue(this.retryQueue, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': this.queue,
        'x-message-ttl': this.retryTtlMs,
      },
    });
    for (const key of LK_REFERENCE_BINDINGS) {
      await ch.bindQueue(this.queue, this.exchange, key);
    }
  }

  async publish(routingKey: string, payload: unknown): Promise<void> {
    await this.ensureConnected();
    if (!this.channel) throw new Error('RabbitMQ channel is not available');
    const body = Buffer.from(JSON.stringify(payload));
    this.channel.publish(this.exchange, routingKey, body, {
      contentType: 'application/json',
      deliveryMode: 2,
    });
  }

  async consume(onMessage: LkConsumeHandler): Promise<void> {
    this.consumerHandler = onMessage;
    try {
      await this.ensureConnected();
      await this.subscribe();
      this.reconnectAttempt = 0;
    } catch (err) {
      this.logger.error(`LK consumer subscribe failed, will retry: ${(err as Error).message}`);
      this.scheduleReconnect();
      throw err;
    }
  }

  private async subscribe(): Promise<void> {
    if (!this.channel) throw new Error('RabbitMQ channel is not available');
    const handler = this.consumerHandler;
    if (!handler) return;
    // Capture the delivering channel: delivery tags are valid ONLY on the
    // channel that delivered the message. Never use mutable this.channel for
    // ack/nack of an already-delivered message (reconnect would send the ack
    // to channel B with a tag from channel A -> PRECONDITION_FAILED closes B).
    const deliveryChannel = this.channel;
    await deliveryChannel.consume(this.queue, async (msg) => {
      if (!msg) return;
      const headers = ((msg.properties.headers ?? {}) as Record<string, unknown>) ?? {};
      const retryCount = getRetryCount(headers);
      const ack = () => {
        try {
          deliveryChannel.ack(msg);
        } catch {
          // Stale channel: ignore. Rabbit redelivers; eventId dedup keeps it safe.
        }
      };
      const nack = (requeue: boolean) => {
        try {
          if (requeue) deliveryChannel.nack(msg, false, true);
          else deliveryChannel.nack(msg, false, false);
        } catch {
          // ignore (see ack)
        }
      };
      const retry = () => {
        try {
          this.retryLater(deliveryChannel, msg);
        } catch {
          // ignore: redelivery after reconnect is the safe fallback
        }
      };
      try {
        await handler({
          routingKey: msg.fields.routingKey,
          content: msg.content,
          headers,
          retryCount,
          ack,
          nack,
          retry,
        });
      } catch (err) {
        this.logger.error(`Consumer handler failed, scheduling delayed retry: ${(err as Error).message}`);
        retry();
      }
    });
  }

  /**
   * Delayed bounded retry for transient failures.
   * - attempts < max: publish a copy to the retry queue (TTL -> main) with
   *   incremented x-retry-count, then ack the original (no immediate redelivery).
   * - attempts >= max: nack(requeue=false) -> DLQ.
   * Uses the delivery channel for ack/nack and the current channel (falling
   * back to delivery) for the retry publish.
   */
  retryLater(
    deliveryChannel: Channel,
    msg: { content: Buffer; properties: { headers?: Record<string, unknown> | null } },
  ): void {
    const headers = ((msg.properties.headers ?? {}) as Record<string, unknown>) ?? {};
    const count = getRetryCount(headers);
    if (count >= this.maxRetries) {
      this.logger.warn(`LK event exceeded ${this.maxRetries} retries, sending to DLQ`);
      try {
        deliveryChannel.nack(msg as never, false, false);
      } catch {
        // ignore
      }
      return;
    }
    const nextHeaders = { ...headers, [LK_RETRY_COUNT_HEADER]: count + 1 };
    try {
      const pub = (this.channel ?? deliveryChannel) as Channel & {
        sendToQueue?: (q: string, c: Buffer, o?: unknown) => void;
      };
      if (typeof pub.sendToQueue === 'function') {
        pub.sendToQueue(this.retryQueue, msg.content, {
          persistent: true,
          headers: nextHeaders,
        });
      } else {
        // Fallback for minimal channel mocks: publish via default exchange.
        (pub as Channel).publish('', this.retryQueue, msg.content, {
          persistent: true,
          headers: nextHeaders,
        } as never);
      }
    } catch (err) {
      // Publish failed (likely connection down): do NOT ack; the broker will
      // redeliver after reconnect. Not a hot loop — delivery is paused offline.
      this.logger.error(`LK retry publish failed: ${(err as Error).message}`);
      return;
    }
    try {
      deliveryChannel.ack(msg as never);
    } catch {
      // Stale ack ignored; duplicate retry copy is deduped via eventId.
    }
  }

  private attachConnectionListeners(conn: ChannelModel): void {
    const watched = conn;
    const onDown = (err?: unknown) => {
      if (this.shuttingDown) return;
      // Old connection's close must not wipe a newer connection state.
      if (this.connection !== watched) return;
      const msg = err instanceof Error ? err.message : 'connection lost';
      this.logger.error(`RabbitMQ connection down (${msg}), scheduling reconnect`);
      this.clearChannelState();
      this.connecting = null;
      this.scheduleReconnect();
    };
    try {
      (conn as unknown as { on: (e: string, f: (x?: unknown) => void) => void }).on('error', onDown);
      (conn as unknown as { on: (e: string, f: (x?: unknown) => void) => void }).on('close', () =>
        onDown(new Error('close')),
      );
    } catch {
      // mock connections in tests may not implement .on
    }
  }

  private attachChannelListeners(ch: Channel): void {
    const watched = ch;
    const onDown = (err?: unknown) => {
      if (this.shuttingDown) return;
      // Old channel's close must not wipe a newer channel state.
      if (this.channel !== watched) return;
      const msg = err instanceof Error ? err.message : 'channel lost';
      this.logger.error(`RabbitMQ channel down (${msg}), scheduling reconnect`);
      this.clearChannelState();
      this.connecting = null;
      this.scheduleReconnect();
    };
    try {
      (ch as unknown as { on: (e: string, f: (x?: unknown) => void) => void }).on('error', onDown);
      (ch as unknown as { on: (e: string, f: (x?: unknown) => void) => void }).on('close', () =>
        onDown(new Error('close')),
      );
    } catch {
      // ignore
    }
  }

  private clearChannelState(): void {
    this.channel = null;
    this.connection = null;
  }

  scheduleReconnect(): void {
    if (this.shuttingDown) return;
    if (this.reconnectTimer) return;
    const jitter = Math.floor(Math.random() * 500);
    const delay = computeReconnectDelay(this.reconnectAttempt, jitter);
    this.logger.warn(`RabbitMQ reconnect in ${delay}ms (attempt ${this.reconnectAttempt + 1})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void (async () => {
        if (this.shuttingDown) return;
        try {
          await this.ensureConnected();
          if (this.consumerHandler) await this.subscribe();
          this.reconnectAttempt = 0;
          this.logger.log('RabbitMQ reconnected and consumer re-subscribed');
        } catch (err) {
          this.reconnectAttempt += 1;
          this.logger.error(`RabbitMQ reconnect failed: ${(err as Error).message}`);
          this.scheduleReconnect();
        }
      })();
    }, delay);
    // Allow process to exit in scripts/tests even with a pending timer.
    const t = this.reconnectTimer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  }

  async checkHealth(): Promise<boolean> {
    try {
      await this.ensureConnected(3000);
      return this.channel != null;
    } catch {
      // Reset so the next check retries instead of reusing a hung promise.
      this.connecting = null;
      return false;
    }
  }

  async onModuleDestroy() {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      await this.channel?.close();
    } catch {
      // ignore
    }
    try {
      await this.connection?.close();
    } catch {
      // ignore
    }
    this.clearChannelState();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

@Global()
@Module({
  providers: [RabbitmqService],
  exports: [RabbitmqService],
})
export class RabbitmqModule {}
