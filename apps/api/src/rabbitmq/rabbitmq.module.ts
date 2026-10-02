import { Global, Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID, createHash } from 'crypto';
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
/** Preserves the source messageId (return correlation needs a fresh unique id). */
export const LK_SOURCE_MESSAGE_ID_HEADER = 'x-source-message-id';
export const LK_RETRY_PUBLISH_TIMEOUT_MS = 5000;
export const LK_RETRY_MAX_INFLIGHT = 20;
/** Slow-requeue delay after an unconfirmed retry (no hot loop). */
export const LK_STALL_REQUEUE_DELAY_MS = 5000;
/** Bounded slow-requeue cycles per message before DLQ (no infinite wait). */
export const LK_STALL_MAX_CYCLES = 3;

export class ConfirmUnsupportedError extends Error {
  constructor(message = 'RabbitMQ channel does not support publisher confirms (ConfirmChannel required)') {
    super(message);
    this.name = 'ConfirmUnsupportedError';
  }
}

export class RetryPublishTimeoutError extends Error {
  constructor(message = 'RabbitMQ retry publish confirm timed out') {
    super(message);
    this.name = 'RetryPublishTimeoutError';
  }
}

/** Injection seam for the confirm channel (production: createConfirmChannel, no fallback). */
export type ConfirmChannelFactory = (conn: ChannelModel) => Promise<Channel>;

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

/** Broker delivery envelope (subset of amqplib ConsumeMessage we rely on). */
export interface DeliveryMsg {
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
  fields?: { routingKey?: string; deliveryTag?: number | string; redelivered?: boolean };
}

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
 *   `x-original-routing-key`, waiting for the per-message publisher confirm;
 *   ack the original ONLY after the confirm. After 5 attempts -> DLQ.
 * - unconfirmed (nack/return/timeout/drain-timeout/connection loss): the
 *   original is NOT acked. A bounded slow-requeue (one delayed
 *   nack(requeue=true) per 5s, max 3 cycles, then DLQ) guarantees the delivery
 *   slot is eventually freed without a hot loop and without waiting forever.
 * The retry copy preserves eventId (in payload), contentType, deliveryMode,
 * correlationId/source-messageId when present, and the retry counter.
 * Backpressure is bounded (max 20 inflight retry publishes + drain wait);
 * overflow fails the attempt without acking so the broker redelivers later.
 *
 * Publish path (single, no mock-driven branching):
 * - production uses ConfirmChannel ONLY (creation failure fails closed, never
 *   silently degrades to a plain channel);
 * - the retry copy is published via the default exchange
 *   (`publish('', retryQueue, ..., {mandatory: true}, perMessageCallback)` —
 *   wire-identical to sendToQueue but with a per-message ack/nack callback,
 *   which sendToQueue does not expose);
 * - success requires BOTH the per-message ack callback AND no correlated
 *   mandatory `basic.return` (unroutable). Returns are correlated by a fresh
 *   unique messageId per publish (the source messageId is preserved in the
 *   `x-source-message-id` header); a return for another publishId never fails
 *   unrelated waiters, and late returns from a previous generation are ignored.
 * - `publish()` returning false means the TCP buffer is full: the code waits
 *   for `drain` within the remaining budget (no second publish, no loss claim).
 *
 * Topology notes (RabbitMQ 4.x, classic durable queues):
 * - `lk.events` is LK-owned: only asserted compatible (durable topic), never
 *   redeclared with conflicting args, never deleted.
 * - Main queue DLX -> EDO-owned `*.dlx` -> `*.dlq` (poison path, broker-internal).
 * - Retry queue TTL 5s -> default exchange with routing key = main queue name
 *   (retry->main path, broker-internal).
 * - KNOWN LIMIT (open blocker, see ADR-002 + runbook): broker-internal
 *   dead-lettering silently DROPS the message when the target does not exist
 *   at expire time (unroutable dead-letter). Durable + persistent + confirm
 *   gives at-least-once placement INTO each queue, but the retry->main and
 *   ->DLQ hops additionally require the EDO-owned topology to stay intact
 *   (never delete queues; startup assert + integration-health depth checks +
 *   alerts). A v2 topology with an explicit drain/rollback plan is prepared
 *   separately and is NOT applied to shared infra here.
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
  /** Correlated mandatory returns: publishId -> generation that published it. */
  private pendingReturns = new Map<string, number>();
  /** Dedicated diagnostic channel for health checks (never the delivery channel). */
  private diagChannel: Channel | null = null;
  /**
   * Per-delivery stall recovery: deliveryKey -> {cycles, timer}.
   * Keyed by `${generation}:${deliveryTag}` — two deliveries of identical
   * content have different tags and recover INDEPENDENTLY (neither cancels
   * the other's timer, successes never clear another delivery's path).
   * Attempt budgets are per delivery: concurrent identical copies do not
   * pool their cycles as if they were sequential redeliveries of one copy.
   * Each delivery ends exactly once (ack on confirmed retry, delayed
   * nack(true) per failed cycle, nack(false) to DLQ after LK_STALL_MAX_CYCLES
   * cycles). A redelivered copy arrives with a NEW tag and its own budget;
   * the broker-persistent x-retry-count header still bounds the confirm path.
   */
  private stalls = new Map<string, { cycles: number; timer: ReturnType<typeof setTimeout> | null; token: object }>();
  /** Max tracked stall deliveries (overflow degrades to immediate nack(true), never unbounded). */
  private static readonly STALL_MAX_TRACKED = 1000;
  /** Confirm-channel factory (production default; tests inject fakes explicitly). */
  private channelFactory: ConfirmChannelFactory = (conn) =>
    (conn as unknown as { createConfirmChannel: () => Promise<Channel> }).createConfirmChannel();
  /** Dial seam (production default `amqplib.connect`; tests inject fakes explicitly). */
  private dial: (url: string) => Promise<ChannelModel> = (url) => connect(url);

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

  /** Current connection generation (consumer uses it to drop stale post-wait work). */
  getGeneration(): number {
    return this.generation;
  }

  /** True while the service still owns this generation (not shut down / reconnected). */
  isCurrentGeneration(gen: number): boolean {
    return !this.shuttingDown && gen === this.generation;
  }

  /** For tests/ops: bounded backpressure state. */
  getRetryInflight(): number {
    return this.retryInflight;
  }

  async ensureConnected(timeoutMs = 5000): Promise<void> {
    if (this.channel) return;
    if (!this.connecting) {
      this.connecting = (async () => {
        const conn = await withTimeout(this.dial(this.url), timeoutMs, 'RabbitMQ connect timed out');
        this.connection = conn;
        this.attachConnectionListeners(conn);
        // ConfirmChannel is REQUIRED in production: creation failure fails
        // closed (reconnect loop) instead of silently degrading to a plain
        // channel without publisher confirms. Tests inject fakes via
        // `setChannelFactoryForTests`, never via a production fallback.
        const ch = await this.channelFactory(conn);
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

  /**
   * Test seam: replace the confirm-channel factory with an explicit fake.
   * Production never calls this; there is no silent plain-channel fallback.
   */
  setChannelFactoryForTests(factory: ConfirmChannelFactory): void {
    this.channelFactory = factory;
  }

  /** Test seam: replace the AMQP dial with an explicit fake connection. */
  setDialForTests(dial: (url: string) => Promise<ChannelModel>): void {
    this.dial = dial;
  }

  /**
   * Correlated mandatory-return listener: only the publish whose fresh
   * messageId matches (and whose generation is still current) is marked
   * returned. One return never fails unrelated concurrent publishes, and
   * late returns from a previous generation are ignored.
   * (Broker semantics: for an unroutable mandatory message the return frame
   * precedes the confirm on the same channel, so the flag is always set
   * before the per-message ack callback runs.)
   */
  private attachReturnListener(ch: Channel): void {
    const gen = this.generation;
    try {
      const emitter = ch as unknown as { on?: (ev: string, fn: (m: unknown) => void) => void };
      if (typeof emitter.on !== 'function') return;
      emitter.on('return', (msg) => {
        try {
          const id = (msg as { properties?: { messageId?: unknown } })?.properties?.messageId;
          if (typeof id !== 'string' || gen !== this.generation || this.shuttingDown) return;
          if (this.pendingReturns.has(id)) this.pendingReturns.set(id, -1);
        } catch {
          // ignore listener errors
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
      if (!msg) {
        // Broker-sent cancel (queue deleted, etc.): the subscription is gone.
        // Never spin on a dead consumer; re-establish via the reconnect loop.
        if (isStale()) return;
        this.logger.error('RabbitMQ broker cancelled the LK consumer; scheduling re-subscribe');
        this.clearChannelState();
        this.connecting = null;
        this.scheduleReconnect();
        return;
      }
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
   *   the per-message confirm AND absence of a correlated mandatory return,
   *   then ack the original. Returns true on confirmed placement + ack.
   * - attempts >= max: nack(requeue=false) -> DLQ. Returns true (settled).
   * - publish unconfirmed (nack/return/timeout/drain-timeout/connection loss/
   *   backpressure): the original is NOT acked. A bounded slow-requeue is
   *   scheduled (one delayed nack(requeue=true) per 5s, max 3 cycles, then DLQ)
   *   so the prefetch slot is eventually freed without a hot loop, an infinite
   *   wait, or extra consumer subscriptions. Returns false (not settled).
   * Uses the delivery channel for ack/nack and the current confirm channel for
   * the retry publish. Stale generations (reconnect/shutdown) never ack and
   * never schedule recovery.
   */
  async retryLaterAsync(
    deliveryChannel: Channel,
    msg: DeliveryMsg,
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
      this.clearStall(gen, msg);
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
      this.scheduleStallRequeue(deliveryChannel, msg, gen);
      return false;
    }
    this.retryInflight += 1;
    try {
      if (isStale()) return false;
      const confirmed = await this.publishToRetryQueueWithConfirm(msg.content, nextHeaders, msg.properties);
      if (!confirmed) {
        this.logger.error('LK retry publish unconfirmed (nack/return/timeout); scheduling slow-requeue');
        this.scheduleStallRequeue(deliveryChannel, msg, gen);
        return false;
      }
    } catch (err) {
      // Publish failed (no channel, shutting down, timeout, no confirms):
      // do NOT ack. Recovery is the bounded slow-requeue below, not an
      // immediate hot requeue and not an eternal unacked stall.
      this.logger.error(`LK retry publish failed, scheduling slow-requeue: ${(err as Error).message}`);
      this.scheduleStallRequeue(deliveryChannel, msg, gen);
      return false;
    } finally {
      this.retryInflight -= 1;
    }
    if (isStale()) return false;
    this.clearStall(gen, msg);
    try {
      deliveryChannel.ack(msg as never);
      return true;
    } catch {
      // Stale ack ignored; duplicate retry copy is deduped via eventId inbox.
      return false;
    }
  }

  /** Per-delivery stall key: generation + broker deliveryTag (no content coupling). */
  private stallKey(gen: number, msg: DeliveryMsg): string {
    const tag = msg.fields?.deliveryTag;
    if (typeof tag === 'number' || typeof tag === 'string') return `${gen}:${tag}`;
    // Fallback for tag-less doubles: content hash (documented, tests prefer tags).
    return `${gen}:hash:${createHash('sha1').update(msg.content).digest('hex')}`;
  }

  private clearStall(gen: number, msg: DeliveryMsg): void {
    const entry = this.stalls.get(this.stallKey(gen, msg));
    if (entry?.timer) clearTimeout(entry.timer);
    this.stalls.delete(this.stallKey(gen, msg));
  }

  /**
   * Bounded per-delivery recovery for an unconfirmed retry while the channel
   * stays open. Schedules ONE delayed nack(requeue=true) for THIS delivery
   * (5s, unref'd); after LK_STALL_MAX_CYCLES failures of the same delivery the
   * message goes to DLQ via nack(requeue=false) instead of stalling the
   * prefetch slot forever. Stale generations and shutdown never nack; the
   * timer token prevents double nack of one deliveryTag.
   * If tracking overflows (1000 deliveries), degrade to an immediate
   * nack(true): the redelivery recreates tracking — recovery preserved,
   * memory bounded, no stranded delivery.
   */
  private scheduleStallRequeue(deliveryChannel: Channel, msg: DeliveryMsg, gen: number): void {
    if (this.shuttingDown || gen !== this.generation) return;
    const key = this.stallKey(gen, msg);
    const prev = this.stalls.get(key);
    if (prev?.timer) clearTimeout(prev.timer);
    const cycles = (prev?.cycles ?? 0) + 1;
    if (cycles > LK_STALL_MAX_CYCLES) {
      this.stalls.delete(key);
      this.logger.error(
        `LK stall recovery exhausted (${LK_STALL_MAX_CYCLES} cycles); sending to DLQ for operator triage`,
      );
      if (!this.isCurrentGeneration(gen)) return;
      try {
        deliveryChannel.nack(msg as never, false, false);
      } catch {
        // Channel dead: broker redelivers on close; inbox dedup keeps it safe.
      }
      return;
    }
    if (this.stalls.size >= RabbitmqService.STALL_MAX_TRACKED && !this.stalls.has(key)) {
      // Memory bound hit: immediate requeue keeps a live recovery path while
      // bounding memory (redelivery recreates tracking or settles).
      this.logger.warn('LK stall tracking overflow; immediate requeue (bounded memory)');
      if (!this.isCurrentGeneration(gen)) return;
      try {
        deliveryChannel.nack(msg as never, false, true);
      } catch {
        // ignore: broker redelivers on close.
      }
      return;
    }
    const token = {};
    const timer = setTimeout(() => {
      const entry = this.stalls.get(key);
      // Only this timer may settle this delivery (no double nack on one tag).
      if (!entry || entry.token !== token) return;
      entry.timer = null;
      if (!this.isCurrentGeneration(gen)) {
        this.stalls.delete(key);
        return;
      }
      try {
        deliveryChannel.nack(msg as never, false, true);
      } catch {
        // Channel dead: broker redelivers everything unacked on close.
      }
    }, LK_STALL_REQUEUE_DELAY_MS);
    const t = timer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
    this.stalls.set(key, { cycles, timer, token });
  }

  /**
   * Publish a retry copy with a per-message publisher confirm.
   * Single production path (no mock-driven branching):
   * `publish('', retryQueue, ..., {mandatory: true}, callback)` is
   * wire-identical to sendToQueue but additionally exposes the per-message
   * ack/nack callback that sendToQueue does not provide.
   * Resolves true ONLY when the broker acked THIS message AND no correlated
   * mandatory return arrived for it. Resolves false on nack, correlated
   * return (unroutable), timeout, drain timeout, or connection loss.
   * Throws ConfirmUnsupportedError when the channel has no per-message
   * confirm support (fail closed — never treated as placed), and
   * RetryPublishTimeoutError on timeout (caller maps both to slow-requeue).
   * Preserves contentType/correlationId when present and always sets
   * persistent delivery + validated headers. The source messageId is kept in
   * `x-source-message-id`; the wire messageId is a fresh UUID per publish so
   * concurrent returns correlate exactly.
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
    const publishId = randomUUID();
    const nextHeaders: Record<string, unknown> = { ...headers };
    if (srcProps?.messageId !== undefined && srcProps.messageId !== null) {
      nextHeaders[LK_SOURCE_MESSAGE_ID_HEADER] = srcProps.messageId;
    }
    const props: Record<string, unknown> = {
      persistent: true,
      deliveryMode: 2,
      messageId: publishId,
      contentType: typeof srcProps?.contentType === 'string' ? srcProps.contentType : 'application/json',
      headers: nextHeaders,
    };
    for (const k of ['contentEncoding', 'priority', 'correlationId', 'timestamp', 'type', 'appId'] as const) {
      const v = (srcProps as Record<string, unknown> | undefined)?.[k];
      if (v !== undefined && v !== null) props[k] = v;
    }
    const pubCh = ch as unknown as {
      publish?: (
        ex: string,
        key: string,
        c: Buffer,
        o?: unknown,
        cb?: (err: Error | null) => void,
      ) => boolean;
      once?: (ev: string, fn: () => void) => void;
      on?: (ev: string, fn: () => void) => void;
    };
    if (typeof pubCh.publish !== 'function') throw new ConfirmUnsupportedError();
    const gen = this.generation;
    this.pendingReturns.set(publishId, gen);
    try {
      const startedAt = Date.now();
      const remaining = () => Math.max(0, timeoutMs - (Date.now() - startedAt));
      const confirmed = await new Promise<boolean>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new RetryPublishTimeoutError());
        }, remaining());
        const tt = timer as unknown as { unref?: () => void };
        if (typeof tt.unref === 'function') tt.unref();
        let sent: boolean;
        try {
          sent = pubCh.publish!('', this.retryQueue, content, { ...props, mandatory: true }, (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (err) reject(err);
            else resolve(true);
          });
        } catch (err) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
          return;
        }
        if (sent === false) {
          // TCP buffer full: this is backpressure, NOT a placement verdict.
          // The message stays queued inside amqplib and the per-message
          // callback below still gates the final verdict (ack/nack/timeout).
          // Never publish twice because of a false return.
          this.logger.warn('LK retry publish buffer full; awaiting confirm within budget (no re-publish)');
        }
      });
      if (!confirmed) return false;
      // Correlated return check (frame-ordered before the ack callback, but
      // re-checked here against the generation-guarded map).
      if (this.pendingReturns.get(publishId) === -1) return false;
      if (gen !== this.generation || this.shuttingDown) return false;
      return true;
    } catch (err) {
      if (err instanceof RetryPublishTimeoutError) throw err;
      // Nack callback errors, drain failures, and unexpected throws all mean
      // "not confirmed" — the caller slow-requeues instead of acking.
      if (err instanceof ConfirmUnsupportedError) throw err;
      return false;
    } finally {
      this.pendingReturns.delete(publishId);
    }
  }

  /**
   * Delayed bounded retry for transient failures (fire-and-forget wrapper).
   * Production path is `retryLaterAsync` with publisher confirms; this keeps
   * the historical call shape for the consumer (`retry()`). There is no
   * synchronous no-confirm fast path: without confirms the attempt fails
   * closed (slow-requeue) instead of acking an unplaced copy.
   */
  retryLater(
    deliveryChannel: Channel,
    msg: {
      content: Buffer;
      properties: { headers?: Record<string, unknown> | null };
      fields?: { routingKey?: string };
    },
  ): void {
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
    // The diagnostic channel dies with the connection too; drop the handle
    // without touching anything else (generation bump below is for the
    // delivery channel only).
    void this.closeDiagChannel();
    // Invalidate callbacks from the previous connection so stale deliveries
    // cannot ack/nack uncontrolled after reconnect. Stall timers of the dead
    // generation are cancelled too: the broker redelivers everything unacked
    // with NEW deliveryTags, and each redelivery gets its own fresh recovery
    // entry — no live delivery is left without a path.
    for (const [, entry] of this.stalls) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.stalls.clear();
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

  /**
   * Queue depths for integration health/alerts (never throws).
   * Runs on a DEDICATED diagnostic channel, never on the delivery channel:
   * `checkQueue` of a missing queue closes the channel by protocol (404), and
   * that must never reset the working consumer, its generation, or pending
   * confirms. A missing EDO-owned queue is reported explicitly in `errors`
   * (404 NOT_FOUND) instead of being hidden as zero: zero means "empty and
   * present", an error entry means "topology damaged". Returns null only when
   * the broker itself is unreachable.
   */
  async checkQueueDepths(): Promise<{ main: number; retry: number; dlq: number; errors: string[] } | null> {
    let diag: Channel | null = null;
    try {
      await this.ensureConnected(3000);
      diag = await this.ensureDiagChannel();
      if (!diag) return null;
      const ch = diag as unknown as {
        checkQueue?: (q: string) => Promise<{ messageCount: number }>;
      };
      if (typeof ch.checkQueue !== 'function') return null;
      const errors: string[] = [];
      const read = async (name: string, q: string): Promise<number> => {
        try {
          const r = await ch.checkQueue!(q);
          return r.messageCount;
        } catch (err) {
          const code = (err as { code?: unknown })?.code;
          if (code === 404) {
            errors.push(`queue ${name} is missing (NOT_FOUND) — EDO topology damaged, DLX hops may drop messages`);
            return 0;
          }
          errors.push(`queue ${name} unreadable: ${(err as Error).message.slice(0, 120)}`);
          return 0;
        }
      };
      const [main, retry, dlq] = await Promise.all([
        read('main', this.queue),
        read('retry', this.retryQueue),
        read('dlq', this.dlq),
      ]);
      return { main, retry, dlq, errors };
    } catch {
      return null;
    }
  }

  /**
   * Dedicated diagnostic channel for health checks. Isolated from the delivery
   * channel: its death (e.g. 404 on a missing queue) drops only this handle
   * via the error/close listener below — generation, consumer subscription
   * and pending confirms are untouched.
   */
  private async ensureDiagChannel(): Promise<Channel | null> {
    if (this.diagChannel) return this.diagChannel;
    const conn = this.connection;
    if (!conn) return null;
    try {
      const create = (conn as unknown as { createChannel?: () => Promise<Channel> }).createChannel;
      if (typeof create !== 'function') return null;
      const ch = await create.call(conn);
      const drop = () => {
        if (this.diagChannel === ch) this.diagChannel = null;
      };
      try {
        const emitter = ch as unknown as { on?: (ev: string, fn: () => void) => void };
        if (typeof emitter.on === 'function') {
          emitter.on('error', drop);
          emitter.on('close', drop);
        }
      } catch {
        // ignore (mocks)
      }
      this.diagChannel = ch;
      return ch;
    } catch {
      return null;
    }
  }

  private async closeDiagChannel(): Promise<void> {
    const ch = this.diagChannel;
    this.diagChannel = null;
    try {
      await ch?.close();
    } catch {
      // ignore
    }
  }

  async onModuleDestroy() {
    this.shuttingDown = true;
    this.generation += 1;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.closeDiagChannel();
    // Drop pending return correlations and stall-requeue timers: stale
    // callbacks must not nack after shutdown.
    this.pendingReturns.clear();
    for (const [, entry] of this.stalls) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.stalls.clear();
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
