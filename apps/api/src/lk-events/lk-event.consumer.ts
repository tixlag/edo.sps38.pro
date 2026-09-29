import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RabbitmqService } from '../rabbitmq/rabbitmq.module';
import { LkEventHandler } from './lk-event.handler';

/**
 * Long-running RabbitMQ consumer for lk.reference.* events.
 * Started on module init; tolerant when the broker is absent (logs, retries lazily).
 * Ack policy: applied/duplicate/ignored(malformed, unknown version/key) -> ack;
 * transient DB errors -> nack+requeue for retry.
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
          if (outcome.status === 'ignored') {
            this.logger.warn(`Ack-ing ignored LK event: ${(outcome as { reason: string }).reason}`);
          }
          ack();
        } catch (err) {
          this.logger.error(`LK event apply failed, requeue: ${(err as Error).message}`);
          nack(true);
        }
      });
      this.logger.log('LK event consumer subscribed');
    } catch (err) {
      this.logger.error(`LK consumer subscribe failed (will retry on demand): ${(err as Error).message}`);
    }
  }
}
