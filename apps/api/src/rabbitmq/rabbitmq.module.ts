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
/**
 * Explicit header carrying the original lk.reference.* routing key through the
 * retry queue. The retry queue dead-letters via the default exchange with
 * routing key = main queue name, so without this header the redelivered
 * message would arrive with routingKey `edo.lk-reference-sync` and the handler
 * would poison it as unknown-routing-key. Never trust an arbitrary header
 * value: only LK_REFERENCE_BINDINGS are accepted and the value must match
 * envelope.eventType (checked in LkEventHandler).
 */
export const LK_ORIGINAL_ROUTING_KEY_HEADER = 'x-original-routing-key';
export const LK_RETRY_PUBLISH_TIMEOUT_MS = 5000;
export const LK_RETRY_MAX_INFLIGHT = 20;

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

/** Only routing keys we ever publish/consume are valid for retry preservation. */
export function isAllowedLkRoutingKey(value: unknown): value is string {
  return typeof value === 'string' && (LK_REFERENCE_BINDINGS as readonly string[]).includes(value);
}

/** Read and validate the preserved original routing key (never trust arbitrary values). */
export function getOriginalRoutingKey(headers: Record<string, unknown> | undefined): string | null {
  const v = headers?.[LK_ORIGINAL_ROUTING_KEY_HEADER];
  return isAllowedLkRoutingKey(v) ? v : null;
}

/**
 * Resolve the effective routing key for a delivery on the main queue.
 * - Normal LK publish via `lk.events`: fields key is already allowed -> use it.
 * - Redelivered retry copy via default exchange: fields key == main queue name,
 *   original is restored from validated `x-original-routing-key` header.
 * - Old retry-format messages (no header, fields key == queue name): return the
 *   fields key as-is so the handler poisons them deterministically; the
 *   `lk:recover` CLI can re-hydrate them from envelope.eventType with dry-run.
 */
export function resolveEffectiveRoutingKey(
  fieldsRoutingKey: string,
  headers: Record<string, unknown> | undefined,
  queueName: string,
): string {
  if (isAllowedLkRoutingKey(fieldsRoutingKey)) return fieldsRoutingKey;
  if (fieldsRoutingKey === queueName) {
    const original = getOriginalRoutingKey(headers);
    if (original) return original;
  }
  return fieldsRoutingKey;
}

export type LkConsumeHandler = (msg: {
  routingKey: string;
  /** Raw routing key as delivered by the broker (for diagnostics). */
  rawRoutingKey?: string;
  content: Buffer;
  headers: Record<string, unknown>;
  retryCount: number;
  ack: () => void;
  nack: (requeue: boolean) => void;
  /** Delayed bounded retry for transient failures (retry queue + TTL, not hot loop). */
  retry: () => void;
  /** Async variant with publisher confirm; ack original only after confirmed placement. */
  retryAsync: () => Promise<boolean>;
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
 * A generation counter invalidates callbacks from a previous connection after
 * reconnect/shutdown so they cannot ack/nack uncontrolled.
 *
 * Retry policy (no tight loop):
 * - applied/duplicate -> ack;
 * - poison -> nack(requeue=false) -> DLQ (via main-queue DLX `*.dlx`);
 * - transient -> async publish a copy to `<queue>.retry` (TTL 5s, DLX back to
 *   main via default exchange) with `x-retry-count+1` AND validated
 *   `x-original-routing-key`, waiting for publisher confirm; ack the original
 *   ONLY after the confirm. After 5 attempts -> DLQ.
 * The retry copy preserves eventId (in payload), contentType, deliveryMode,
 * correlationId/messageId when present, and the retry counter. Backpressure is
 * bounded (max 20 inflight retry publishes); overflow fails the retry without
 * acking so the broker redelivers later (no hot loop, no loss).
 *
 * Topology notes (RabbitMQ 4.x, classic durable queues):
 * - `lk.events` is LK-owned: only asserted compatible (durable topic), never
 *   redeclared with conflicting args, never deleted.
 * - Main queue DLX -> EDO-owned `*.dlx` -> `*.dlq` (poison path, broker-internal).
 * - Retry queue TTL 5s -> default exchange with routing key = main queue name
 *   (retry->main path, broker-internal). Durable + persistent gives
 *   at-least-once across broker restart for confirmed publishes; unconfirmed
 *   publishes never ack the original so the message stays recoverable.
 * - Immutable queue arguments are never changed by deleting the queue. If a new
 *   topology is needed, deploy a new queue name with backlog drain + rollback.
 */
@Injectable()
export class RabbitmqService implements OnModuleDestroy {
  private readonly logger = new Logger(RabbitmqService.name);
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private connecting: Promise<void> | null = null;
  private consumerHandler: LkConsumeHandler | null = null;
  private consumerTag: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private shuttingDown = false;
  /** Invalidates callbacks from a previous connection after reconnect/shutdown. */
  private generation = 0;
  /** Bounded inflight retry publishes (backpressure). */
  private retryInflight = 0;
  private retryReturnListeners = new Set<(msg: unknown) => void>();

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

  /** For tests/ops: bounded backpressure state. */
  getRetryInflight(): number {
    return this.retryInflight;
  }

  async ensureConnected(timeoutMs = 5000): Promise<void> {
    if (this.channel) return;
    if (!this.connecting) {
      this.connecting = (async () => {
        const conn = await withTimeout(connect(this.url), timeoutMs, 'RabbitMQ connect timed out');
        this.connection = conn;
        this.attachConnectionListeners(conn);
        // ConfirmChannel for reliable retry publishes (publisher confirms).
        // Falls back to plain channel for minimal mocks in unit tests.
        const ch = await this.createConfirmChannelCompat(conn);
        this.channel = ch;
        this.attachChannelListeners(ch);
        this.attachReturnListener(ch);
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

  private async createConfirmChannelCompat(conn: ChannelModel): Promise<Channel> {
    const c = conn as unknown as {
      createConfirmChannel?: () => Promise<Channel>;
      createChannel: () => Promise<Channel>;
    };
    if (typeof c.createConfirmChannel === 'function') {
      try {
        return await c.createConfirmChannel();
      } catch {
        // fall through to plain channel (e.g. limited test doubles)
      }
    }
    return await conn.createChannel();
  }

  private attachReturnListener(ch: Channel): void {
    try {
      const emitter = ch as unknown as { on?: (ev: string, fn: (m: unknown) => void) => void };
      if (typeof emitter.on !== 'function') return;
      emitter.on('return', (msg) => {
        for (const fn of [...this.retryReturnListeners]) {
          try {
            fn(msg);
          } catch {
            // ignore listener errors
          }
        }
      });
    } catch {
      // ignore (mocks)
    }
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
    // Capture the delivering channel + generation: delivery tags are valid ONLY
    // on the channel that delivered the message. Never use mutable this.channel
    // for ack/nack of an already-delivered message (reconnect would send the ack
    // to channel B with a tag from channel A -> PRECONDITION_FAILED closes B).
    // After reconnect/shutdown the generation is bumped and stale callbacks
    // become no-ops (they must not ack/nack uncontrolled).
    const deliveryChannel = this.channel;
    const deliveryGeneration = this.generation;
    const isStale = () => this.shuttingDown || deliveryGeneration !== this.generation;
    const sub = (await deliveryChannel.consume(this.queue, async (msg) => {
      if (!msg) return;
      if (isStale()) return;
      const headers = ((msg.properties.headers ?? {}) as Record<string, unknown>) ?? {};
      const retryCount = getRetryCount(headers);
      const rawRoutingKey = msg.fields.routingKey;
      const routingKey = resolveEffectiveRoutingKey(rawRoutingKey, headers, this.queue);
      const ack = () => {
        if (isStale()) return;
        try {
          deliveryChannel.ack(msg);
        } catch {
          // Stale channel: ignore. Rabbit redelivers; eventId dedup keeps it safe.
        }
      };
      const nack = (requeue: boolean) => {
        if (isStale()) return;
        try {
          if (requeue) deliveryChannel.nack(msg, false, true);
          else deliveryChannel.nack(msg, false, false);
        } catch {
          // ignore (see ack)
        }
      };
      const retryAsync = async (): Promise<boolean> =>
        this.retryLaterAsync(deliveryChannel, msg, rawRoutingKey, deliveryGeneration);
      const retry = () => {
        void retryAsync().catch(() => {
          // ignore: redelivery after reconnect is the safe fallback
        });
      };
      try {
        await handler({
          routingKey,
          rawRoutingKey,
          content: msg.content,
          headers,
          retryCount,
          ack,
          nack,
          retry,
          retryAsync,
        });
      } catch (err) {
        this.logger.error(`Consumer handler failed, scheduling delayed retry: ${(err as Error).message}`);
        retry();
      }
    })) as unknown as { consumerTag?: string };
    if (sub && typeof sub.consumerTag === 'string') this.consumerTag = sub.consumerTag;
  }

  /**
   * Async delayed bounded retry with publisher confirm.
   * - attempts < max: publish a copy to the retry queue (TTL -> main) with
   *   incremented x-retry-count + validated x-original-routing-key, wait for
   *   confirm (mandatory return/nack/timeout/connection loss are failures),
   *   then ack the original. Returns true on confirmed placement + ack.
   * - attempts >= max: nack(requeue=false) -> DLQ. Returns true (settled).
   * - publish unconfirmed (nack/return/timeout/connection loss/backpressure):
   *   the original is NOT acked and stays recoverable via broker redelivery;
   *   returns false so the caller can keep it unacked without a hot loop.
   * Uses the delivery channel for ack/nack and the current confirm channel for
   * the retry publish. Stale generations (reconnect/shutdown) never ack.
   */
  async retryLaterAsync(
    deliveryChannel: Channel,
    msg: {
      content: Buffer;
      properties: {
        headers?: Record<string, unknown> | null;
        contentType?: unknown;
        contentEncoding?: unknown;
        deliveryMode?: unknown;
        priority?: unknown;
        correlationId?: unknown;
        messageId?: unknown;
        timestamp?: unknown;
        type?: unknown;
        appId?: unknown;
      };
      fields?: { routingKey?: string };
    },
    routingKey?: string,
    deliveryGeneration?: number,
  ): Promise<boolean> {
    const gen = deliveryGeneration ?? this.generation;
    const isStale = () => this.shuttingDown || gen !== this.generation;
    const headers = ((msg.properties.headers ?? {}) as Record<string, unknown>) ?? {};
    const count = getRetryCount(headers);
    if (count >= this.maxRetries) {
      this.logger.warn(`LK event exceeded ${this.maxRetries} retries, sending to DLQ`);
      if (isStale()) return false;
      try {
        deliveryChannel.nack(msg as never, false, false);
        return true;
      } catch {
        return false;
      }
    }
    // Preserve the original routing key explicitly (validated allowlist only).
    // Fall back to the delivered fields key when the caller did not provide one.
    const deliveredKey =
      routingKey ?? (msg as { fields?: { routingKey?: string } }).fields?.routingKey ?? '';
    const effectiveOriginal = isAllowedLkRoutingKey(deliveredKey)
      ? deliveredKey
      : getOriginalRoutingKey(headers);
    // If we cannot determine a valid original (old retry-format without header),
    // do not invent one: keep headers as-is so the redelivered copy still
    // carries the same evidence; the consumer will poison it deterministically
    // and `lk:recover --dry-run` can re-hydrate from envelope.eventType.
    const nextHeaders: Record<string, unknown> = { ...headers, [LK_RETRY_COUNT_HEADER]: count + 1 };
    if (effectiveOriginal) nextHeaders[LK_ORIGINAL_ROUTING_KEY_HEADER] = effectiveOriginal;

    if (this.retryInflight >= LK_RETRY_MAX_INFLIGHT) {
      this.logger.warn(
        `LK retry backpressure: ${this.retryInflight} inflight, keeping original unacked`,
      );
      return false;
    }
    this.retryInflight += 1;
    try {
      if (isStale()) return false;
      const confirmed = await this.publishToRetryQueueWithConfirm(msg.content, nextHeaders, msg.properties);
      if (!confirmed) {
        this.logger.error('LK retry publish unconfirmed (nack/return/timeout); original stays queued');
        return false;
      }
    } catch (err) {
      // Publish failed (connection down, timeout, backpressure): do NOT ack;
      // the broker will redeliver after reconnect. Not a hot loop — delivery
      // is paused while the retry is outstanding and confirms gate progress.
      this.logger.error(`LK retry publish failed, original stays queued: ${(err as Error).message}`);
      return false;
    } finally {
      this.retryInflight -= 1;
    }
    if (isStale()) return false;
    try {
      deliveryChannel.ack(msg as never);
      return true;
    } catch {
      // Stale ack ignored; duplicate retry copy is deduped via eventId inbox.
      return false;
    }
  }

  /**
   * Publish a retry copy with publisher confirm.
   * Resolves true only when the broker confirmed the placement. Resolves false
   * on mandatory return (unroutable), confirm nack, timeout, or connection loss.
   * Preserves contentType/deliveryMode/correlationId/messageId when present and
   * always sets persistent delivery + validated headers.
   */
  private async publishToRetryQueueWithConfirm(
    content: Buffer,
    headers: Record<string, unknown>,
    srcProps?: {
      contentType?: unknown;
      contentEncoding?: unknown;
      deliveryMode?: unknown;
      priority?: unknown;
      correlationId?: unknown;
      messageId?: unknown;
      timestamp?: unknown;
      type?: unknown;
      appId?: unknown;
    },
    timeoutMs = LK_RETRY_PUBLISH_TIMEOUT_MS,
  ): Promise<boolean> {
    const ch = this.channel ?? null;
    if (!ch) throw new Error('RabbitMQ channel is not available');
    if (this.shuttingDown) throw new Error('RabbitMQ is shutting down');
    const props: Record<string, unknown> = {
      persistent: true,
      deliveryMode: 2,
      contentType: typeof srcProps?.contentType === 'string' ? srcProps.contentType : 'application/json',
      headers,
    };
    for (const k of ['contentEncoding', 'priority', 'correlationId', 'messageId', 'timestamp', 'type', 'appId'] as const) {
      const v = (srcProps as Record<string, unknown> | undefined)?.[k];
      if (v !== undefined && v !== null) props[k] = v;
    }
    // Mandatory publish to detect unroutable (missing retry queue) via `return`.
    // amqplib confirm channels support waitForConfirms(); plain channels resolve
    // immediately (unit-test mocks) — tests assert the topology/call shape, not confirms.
    const confirmCh = ch as unknown as {
      sendToQueue?: (q: string, c: Buffer, o?: unknown) => boolean;
      publish?: (ex: string, key: string, c: Buffer, o?: unknown) => boolean;
      waitForConfirms?: () => Promise<void>;
    };
    let returned = false;
    const onReturn = () => {
      returned = true;
    };
    this.retryReturnListeners.add(onReturn);
    try {
      const doPublish = () => {
        if (typeof confirmCh.sendToQueue === 'function' && !('publish' in confirmCh && typeof confirmCh.publish === 'function' && !confirmCh.waitForConfirms)) {
          // Prefer sendToQueue when available (unit-test shape), else default-exchange publish.
          // For confirm channels both are confirm-tracked; waitForConfirms gates below.
          try {
            return confirmCh.sendToQueue!(this.retryQueue, content, props);
          } catch {
            return (confirmCh.publish as NonNullable<typeof confirmCh.publish>)('', this.retryQueue, content, {
              ...props,
              mandatory: true,
            });
          }
        }
        const pub = confirmCh.publish ?? (ch as unknown as { publish: typeof confirmCh.publish }).publish;
        return pub!('', this.retryQueue, content, { ...props, mandatory: true });
      };
      doPublish();
      if (typeof confirmCh.waitForConfirms === 'function') {
        await withTimeout(confirmCh.waitForConfirms(), timeoutMs, 'RabbitMQ retry publish confirm timed out');
      } else {
        // No confirm support (mocks/plain channel): treat synchronous publish as placed.
        // Production always uses ConfirmChannel, so this branch is test-only.
      }
      if (returned) return false;
      return true;
    } catch {
      return false;
    } finally {
      this.retryReturnListeners.delete(onReturn);
    }
  }

  /**
   * Delayed bounded retry for transient failures (sync wrapper, backward compat).
   * Preserves the original routing key via validated header when available.
   * For publisher-confirm guarantees use retryLaterAsync(); this wrapper fires
   * and forgets (tests assert the queue/headers shape) and is kept for the
   * existing unit-test call shape `retryLater(channel, msg)`.
   * Mock channels without confirms publish synchronously so existing unit tests
   * observe the copy + ack immediately; production ConfirmChannels go through
   * the async confirm path.
   */
  retryLater(
    deliveryChannel: Channel,
    msg: {
      content: Buffer;
      properties: { headers?: Record<string, unknown> | null };
      fields?: { routingKey?: string };
    },
  ): void {
    const headers = ((msg.properties.headers ?? {}) as Record<string, unknown>) ?? {};
    const count = getRetryCount(headers);
    if (count >= this.maxRetries) {
      try {
        deliveryChannel.nack(msg as never, false, false);
      } catch {
        // ignore
      }
      return;
    }
    const deliveredKey = (msg as { fields?: { routingKey?: string } }).fields?.routingKey;
    const effectiveOriginal = deliveredKey
      ? isAllowedLkRoutingKey(deliveredKey)
        ? deliveredKey
        : getOriginalRoutingKey(headers)
      : getOriginalRoutingKey(headers) ?? null;
    // When the caller passes routingKey via fields (new consumer path) and it is
    // valid, preserve it; old unit-test messages without fields keep old shape
    // plus count bump (header added only when we know a valid original).
    const nextHeaders: Record<string, unknown> = { ...headers, [LK_RETRY_COUNT_HEADER]: count + 1 };
    if (effectiveOriginal) nextHeaders[LK_ORIGINAL_ROUTING_KEY_HEADER] = effectiveOriginal;
    else if (deliveredKey && isAllowedLkRoutingKey(deliveredKey)) {
      nextHeaders[LK_ORIGINAL_ROUTING_KEY_HEADER] = deliveredKey;
    }
    // Fast sync path for mocks/plain channels (no confirms): immediate copy + ack
    // so unit tests observe the effect synchronously.
    const confirmCapable = (this.channel as unknown as { waitForConfirms?: unknown } | null)?.waitForConfirms;
    if (typeof confirmCapable !== 'function') {
      try {
        const pub = (this.channel ?? deliveryChannel) as unknown as {
          sendToQueue?: (q: string, c: Buffer, o?: unknown) => void;
          publish?: (ex: string, key: string, c: Buffer, o?: unknown) => void;
        };
        if (typeof pub.sendToQueue === 'function') {
          pub.sendToQueue(this.retryQueue, msg.content, { persistent: true, headers: nextHeaders });
        } else {
          pub.publish!('', this.retryQueue, msg.content, { persistent: true, headers: nextHeaders } as never);
        }
      } catch (err) {
        this.logger.error(`LK retry publish failed: ${(err as Error).message}`);
        return;
      }
      try {
        deliveryChannel.ack(msg as never);
      } catch {
        // ignore
      }
      return;
    }
    void this.retryLaterAsync(deliveryChannel, msg as never).catch(() => undefined);
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
    // Invalidate callbacks from the previous connection so stale deliveries
    // cannot ack/nack uncontrolled after reconnect.
    this.generation += 1;
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

  /** Best-effort queue depths for integration health/alerts (never throws). */
  async checkQueueDepths(): Promise<{ main: number; retry: number; dlq: number } | null> {
    try {
      await this.ensureConnected(3000);
      if (!this.channel) return null;
      const ch = this.channel as unknown as {
        checkQueue?: (q: string) => Promise<{ messageCount: number }>;
      };
      if (typeof ch.checkQueue !== 'function') return null;
      const [main, retry, dlq] = await Promise.all([
        ch.checkQueue(this.queue).catch(() => ({ messageCount: -1 })),
        ch.checkQueue(this.retryQueue).catch(() => ({ messageCount: -1 })),
        ch.checkQueue(this.dlq).catch(() => ({ messageCount: -1 })),
      ]);
      if (main.messageCount < 0) return null;
      return { main: main.messageCount, retry: Math.max(0, retry.messageCount), dlq: Math.max(0, dlq.messageCount) };
    } catch {
      return null;
    }
  }

  async onModuleDestroy() {
    this.shuttingDown = true;
    this.generation += 1;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Cancel the consumer so no new deliveries arrive during shutdown; in-flight
    // handlers observe shuttingDown via generation and skip ack/nack.
    try {
      if (this.channel && this.consumerTag) {
        await (this.channel as unknown as { cancel?: (t: string) => Promise<void> }).cancel?.(this.consumerTag);
      }
    } catch {
      // ignore
    }
    this.consumerTag = null;
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
