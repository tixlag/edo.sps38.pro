import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { connect, type ChannelModel, type ConfirmChannel } from "amqplib";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const OCR_ROUTING_KEY = "edo.ocr.requested.v1";
const envelope = z.object({ jobId: z.string().min(1).max(64) }).strict();
type Handler = (jobId: string) => Promise<void>;

/** OCR-owned queues/channels on the shared broker; never redeclares LK's exchange. */
@Injectable()
export class OcrQueueService implements OnModuleDestroy {
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private connecting?: Promise<void>;
  private handler?: Handler;
  private stopped = false;
  private readonly delayed = new Set<ReturnType<typeof setTimeout>>();
  private readonly pending = new Map<
    string,
    { returned: boolean; settle: (ok: boolean) => void }
  >();

  constructor(private readonly config: ConfigService) {}
  get queue(): string {
    return this.config.get<string>("EDO_OCR_QUEUE") ?? "edo.ocr";
  }
  get exchange(): string {
    return this.config.get<string>("LK_EVENTS_EXCHANGE") ?? "lk.events";
  }
  setHandler(handler: Handler): void {
    this.handler = handler;
  }
  isConnected(): boolean {
    return !!this.channel;
  }

  async ensureConnected(): Promise<void> {
    if (this.stopped) throw new Error("OCR transport stopped");
    if (this.channel) return;
    if (!this.connecting)
      this.connecting = this.open().finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  private async open(): Promise<void> {
    const connection = await connect(
      this.config.get<string>("RABBITMQ_URL") ?? "",
      { timeout: 5000 },
    );
    let channel: ConfirmChannel | undefined;
    // Attach error listeners before awaiting topology (EventEmitter errors must not escape).
    const down = () => {
      if (this.connection === connection) this.drop(connection);
    };
    connection.on("error", down);
    connection.on("close", down);
    try {
      channel = await connection.createConfirmChannel();
      channel.on("error", down);
      channel.on("close", down);
      if (this.stopped) throw new Error("OCR transport stopped");
      this.connection = connection;
      await channel.checkExchange(this.exchange);
      await channel.assertQueue(`${this.queue}.dlq`, { durable: true });
      await channel.assertQueue(this.queue, {
        durable: true,
        arguments: {
          "x-dead-letter-exchange": "",
          "x-dead-letter-routing-key": `${this.queue}.dlq`,
        },
      });
      await channel.bindQueue(this.queue, this.exchange, OCR_ROUTING_KEY);
      await channel.prefetch(2);
      const deliveryChannel = channel;
      channel.on("return", (msg) => {
        if (this.channel !== deliveryChannel) return;
        const pending = this.pending.get(String(msg.properties.messageId));
        if (pending) pending.returned = true;
      });
      this.channel = channel;
      await channel.consume(this.queue, (msg) => {
        if (!msg) {
          this.drop(connection);
          return;
        }
        const parsed = envelope.safeParse(this.parse(msg.content));
        if (!parsed.success || msg.fields.routingKey !== OCR_ROUTING_KEY) {
          deliveryChannel.nack(msg, false, false);
          return;
        }
        void (async () => {
          try {
            if (!this.handler) throw new Error("OCR handler unavailable");
            await this.handler(parsed.data.jobId);
            if (this.channel === deliveryChannel) deliveryChannel.ack(msg);
          } catch {
            // DB failures do not count as OCR attempts; preserve original, with bounded prefetch.
            if (this.channel !== deliveryChannel) return;
            const timer = setTimeout(() => {
              this.delayed.delete(timer);
              if (this.channel === deliveryChannel) {
                try {
                  deliveryChannel.nack(msg, false, true);
                } catch {
                  this.drop(connection);
                }
              }
            }, 5000);
            timer.unref();
            this.delayed.add(timer);
          }
        })();
      });
    } catch (error) {
      this.drop(connection);
      await connection.close().catch(() => undefined);
      throw error;
    }
  }

  private parse(content: Buffer): unknown {
    if (content.length > 1024) return null;
    try {
      return JSON.parse(content.toString());
    } catch {
      return null;
    }
  }

  async publish(jobId: string): Promise<boolean> {
    await this.ensureConnected();
    const channel = this.channel;
    if (!channel) return false;
    const publishId = randomUUID();
    const ok = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => settle(false), 5000);
      const settle = (confirmed: boolean) => {
        const p = this.pending.get(publishId);
        if (!p) return;
        this.pending.delete(publishId);
        clearTimeout(timer);
        resolve(confirmed && !p.returned && this.channel === channel);
      };
      this.pending.set(publishId, { returned: false, settle });
      try {
        // A false return is TCP backpressure, not permission to publish twice.
        channel.publish(
          this.exchange,
          OCR_ROUTING_KEY,
          Buffer.from(JSON.stringify({ jobId })),
          {
            persistent: true,
            mandatory: true,
            messageId: publishId,
            contentType: "application/json",
          },
          (error) => settle(!error),
        );
      } catch {
        settle(false);
      }
    });
    if (!ok && this.channel === channel && this.connection)
      this.drop(this.connection);
    return ok;
  }

  private drop(connection: ChannelModel): void {
    if (this.connection !== connection) return;
    this.connection = undefined;
    this.channel = undefined;
    for (const p of this.pending.values()) p.settle(false);
    for (const timer of this.delayed) clearTimeout(timer);
    this.delayed.clear();
    void connection.close().catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    const connection = this.connection;
    if (connection) this.drop(connection);
    await this.connecting?.catch(() => undefined);
  }
}
