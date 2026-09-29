import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RabbitmqService } from '../rabbitmq/rabbitmq.module';
import { LkEventHandler } from './lk-event.handler';

/**
 * Long-running RabbitMQ consumer for lk.reference.* events.
 * Started on module init; tolerant when the broker is absent (schedules
 * reconnect via RabbitmqService instead of a dead "retry on demand" log).
 * Ack policy:
 * - applied/duplicate -> ack;
 * - poison (malformed, unknown version/key, Zod payload errors) -> nack
 *   requeue=false -> DLQ (edo.lk-reference-sync.dlq via DLX), never infinite;
 * - transient DB/network errors (throw) -> nack+requeue for retry.
 */
@Injectable()
export class LkEventConsumer implements OnModuleInit {
  private readonly logger = new Logger(LkEventConsumer.name);

  constructor(
    private readonly rabbitmq: RabbitmqService,
    private readonly handler: LkEventHandler,
  ) {}

  async onModuleInit() {
    // Skip eager connect in export/test contexts without broker.
    if (process.env.LK_EVENTS_CONSUME === '0') return;
    try {
      await this.rabbitmq.consume(async ({ routingKey, content, ack, nack }) => {
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
          this.logger.error(`LK event apply failed, requeue: ${(err as Error).message}`);
          nack(true);
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
