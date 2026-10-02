import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RabbitmqService } from '../rabbitmq/rabbitmq.module';
import { LkReconciliationLockService } from '../lk-sync/lk-reconciliation-lock.service';
import { LkEventHandler } from './lk-event.handler';

const RECONCILIATION_POLL_MS = 1000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('LK consumer wait cancelled (shutdown)'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const t = timer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('LK consumer wait cancelled (shutdown)'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Long-running RabbitMQ consumer for lk.reference.* events.
 * Started on module init; tolerant when the broker is absent (schedules
 * reconnect via RabbitmqService instead of a dead "retry on demand" log).
 *
 * Reconciliation coordination (tri-state, FAIL CLOSED):
 * - before APPLYING an event the consumer checks the distributed lock state;
 * - `locked` -> pause (a snapshot is running);
 * - `unavailable` (shared Redis unreachable) -> ALSO pause: if a sync held the
 *   lock when Redis went down we cannot safely claim reconciliation is over;
 * - messages stay unacked within prefetch while paused (no tight nack/requeue
 *   loop); Rabbit buffers the rest server-side and they replay after resume.
 * NOTE: getState()-then-apply is NOT mutual exclusion by itself (a snapshot
 * can acquire the lock after the check). It only pauses NEW admits; fencing
 * at the DB layer (LkSyncRun generation, checked atomically in the same
 * transaction as the inbox+projection write) rejects late admits. See
 * LkEventHandler + LkReferenceSyncService for the fencing protocol.
 *
 * Routing keys: RabbitmqService already resolves the effective key
 * (`x-original-routing-key` for retry redeliveries, validated allowlist).
 * Old retry-format messages without the header keep the queue-name key and
 * are poisoned deterministically; `lk:recover --dry-run` re-hydrates them.
 *
 * Ack policy:
 * - applied/duplicate -> ack (after DB commit);
 * - poison (malformed, unknown version/key, Zod payload errors) -> nack
 *   requeue=false -> DLQ (edo.lk-reference-sync.dlq via DLX), never infinite;
 * - transient DB/network errors (throw) -> async delayed bounded retry via
 *   edo.lk-reference-sync.retry (TTL 5s -> main, max 5, publisher confirm),
 *   ack original ONLY after the confirm. Unconfirmed -> keep unacked for
 *   broker redelivery (no hot loop, no loss).
 */
@Injectable()
export class LkEventConsumer implements OnModuleInit {
  private readonly logger = new Logger(LkEventConsumer.name);
  private stopped = false;
  private waiters = new Set<{ cancelled: boolean }>();

  constructor(
    private readonly rabbitmq: RabbitmqService,
    private readonly handler: LkEventHandler,
    private readonly reconciliationLock: LkReconciliationLockService,
  ) {}

  /** Pause event APPLY while reconciling OR while coordination is unknown. */
  async waitWhileReconciling(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (this.stopped || signal?.aborted) {
        throw new Error('LK consumer wait cancelled (shutdown)');
      }
      let state: string;
      try {
        state = await this.reconciliationLock.getState();
      } catch {
        state = 'unavailable';
      }
      if (state === 'unlocked') return;
      this.logger.log(
        state === 'locked'
          ? 'LK reconciliation in progress; pausing event apply (messages stay queued)'
          : 'LK coordination unavailable (Redis); pausing event apply until Redis recovers',
      );
      await sleep(RECONCILIATION_POLL_MS, signal);
    }
  }

  /** Signal shutdown: waiting callbacks abort promptly instead of hanging. */
  stopWaiting(): void {
    this.stopped = true;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopWaiting();
  }

  async onModuleInit() {
    // Skip eager connect in export/test contexts without broker.
    if (process.env.LK_EVENTS_CONSUME === '0') return;
    try {
      await this.rabbitmq.consume(async ({ routingKey, rawRoutingKey, content, ack, nack, retryAsync }) => {
        if (this.stopped) return;
        await this.waitWhileReconciling();
        if (this.stopped) return;
        try {
          const outcome = await this.handler.applyRaw(routingKey, content);
          if (outcome.status === 'applied' || outcome.status === 'duplicate') {
            ack();
          } else {
            // Poison: log routingKey+reason only (never full payload), DLQ it.
            // rawRoutingKey helps diagnose old retry-format (queue-name key).
            this.logger.warn(
              `Nack-ing poison LK event to DLQ: routingKey=${routingKey} raw=${rawRoutingKey ?? routingKey} reason=${outcome.reason}`,
            );
            nack(false);
          }
        } catch (err) {
          this.logger.error(
            `LK event apply failed, scheduling delayed retry: ${(err as Error).message}`,
          );
          // Async confirm path: ack original only after the retry copy is
          // confirmed. Unconfirmed -> stays unacked for broker redelivery.
          const ok = await retryAsync().catch(() => false);
          if (!ok) {
            this.logger.warn('LK retry unconfirmed; original stays queued for redelivery (no hot loop)');
          }
        }
      });
      this.logger.log('LK event consumer subscribed');
    } catch (err) {
      // RabbitmqService already scheduled a reconnect loop; the consumer
      // re-subscribes automatically after the broker returns.
      this.logger.error(
        `LK consumer subscribe failed, reconnect scheduled: ${(err as Error).message}`,
      );
    }
  }
}
