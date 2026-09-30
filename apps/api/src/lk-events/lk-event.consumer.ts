import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RabbitmqService } from '../rabbitmq/rabbitmq.module';
import { LkReconciliationLockService } from '../lk-sync/lk-reconciliation-lock.service';
import { LkEventHandler } from './lk-event.handler';

const RECONCILIATION_POLL_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 *
 * Ack policy:
 * - applied/duplicate -> ack;
 * - poison (malformed, unknown version/key, Zod payload errors) -> nack
 *   requeue=false -> DLQ (edo.lk-reference-sync.dlq via DLX), never infinite;
 * - transient DB/network errors (throw) -> delayed bounded retry via
 *   edo.lk-reference-sync.retry (TTL 5s -> main, max 5) -> DLQ, never hot loop.
 */
@Injectable()
export class LkEventConsumer implements OnModuleInit {
  private readonly logger = new Logger(LkEventConsumer.name);

  constructor(
    private readonly rabbitmq: RabbitmqService,
    private readonly handler: LkEventHandler,
    private readonly reconciliationLock: LkReconciliationLockService,
  ) {}

  /** Pause event APPLY while reconciling OR while coordination is unknown. */
  async waitWhileReconciling(): Promise<void> {
    for (;;) {
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
      await sleep(RECONCILIATION_POLL_MS);
    }
  }

  async onModuleInit() {
    // Skip eager connect in export/test contexts without broker.
    if (process.env.LK_EVENTS_CONSUME === '0') return;
    try {
      await this.rabbitmq.consume(async ({ routingKey, content, ack, nack, retry }) => {
        await this.waitWhileReconciling();
        try {
          const outcome = await this.handler.applyRaw(routingKey, content);
          if (outcome.status === 'applied' || outcome.status === 'duplicate') {
            ack();
          } else {
            // Poison: log routingKey+reason only (never full payload), DLQ it.
            this.logger.warn(
              `Nack-ing poison LK event to DLQ: routingKey=${routingKey} reason=${outcome.reason}`,
            );
            nack(false);
          }
        } catch (err) {
          this.logger.error(
            `LK event apply failed, scheduling delayed retry: ${(err as Error).message}`,
          );
          retry();
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
