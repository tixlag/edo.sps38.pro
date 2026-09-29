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

/**
 * Minimal RabbitMQ abstraction for EDO (shared ecosystem broker).
 * EDO never runs its own production broker; RABBITMQ_URL must point to shared infra.
 * Connection is lazy and tolerant: sync/consumer fail with clear errors, boot never crashes.
 */
@Injectable()
export class RabbitmqService implements OnModuleDestroy {
  private readonly logger = new Logger(RabbitmqService.name);
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private connecting: Promise<void> | null = null;

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

  private get url(): string {
    return (
      this.config.get<string>('RABBITMQ_URL') ??
      process.env.RABBITMQ_URL ??
      'amqp://guest:guest@localhost:5672'
    );
  }

  async ensureConnected(timeoutMs = 5000): Promise<void> {
    if (this.channel) return;
    if (!this.connecting) {
      this.connecting = (async () => {
        const conn = await withTimeout(connect(this.url), timeoutMs, 'RabbitMQ connect timed out');
        this.connection = conn;
        const ch = await conn.createChannel();
        this.channel = ch;
        await ch.assertExchange(this.exchange, 'topic', { durable: true });
        await ch.assertQueue(this.queue, { durable: true });
        for (const key of LK_REFERENCE_BINDINGS) {
          await ch.bindQueue(this.queue, this.exchange, key);
        }
        await ch.prefetch(10);
      })().catch((err) => {
        this.connecting = null;
        this.connection = null;
        this.channel = null;
        throw err;
      });
    }
    await this.connecting;
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

  async consume(
    onMessage: (msg: { routingKey: string; content: Buffer; ack: () => void; nack: (requeue: boolean) => void }) => Promise<void> | void,
  ): Promise<void> {
    await this.ensureConnected();
    if (!this.channel) throw new Error('RabbitMQ channel is not available');
    await this.channel.consume(this.queue, async (msg) => {
      if (!msg) return;
      const ack = () => {
        try {
          this.channel?.ack(msg);
        } catch {
          // ignore
        }
      };
      const nack = (requeue: boolean) => {
        try {
          if (requeue) this.channel?.nack(msg, false, true);
          else this.channel?.nack(msg, false, false);
        } catch {
          // ignore
        }
      };
      try {
        await onMessage({ routingKey: msg.fields.routingKey, content: msg.content, ack, nack });
      } catch (err) {
        this.logger.error(`Consumer handler failed: ${(err as Error).message}`);
        nack(true);
      }
    });
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
