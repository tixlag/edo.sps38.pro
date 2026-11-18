import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { RedisService } from "../redis/redis.module";

export const RU_ENRICHMENT_CHANNEL = "edo:ru-enrichment:events";

export type RuEnrichmentItem = {
  candidateId: string;
  status: "READY" | "RETRY";
  retryAt: string | null;
};

export type RuEnrichmentEvent = {
  items: RuEnrichmentItem[];
};

@Injectable()
export class RuEnrichmentNotificationsService implements OnModuleDestroy {
  private readonly logger = new Logger(RuEnrichmentNotificationsService.name);
  private readonly unsubscribers: (() => void)[] = [];

  constructor(private readonly redis: RedisService) {}

  async publish(event: RuEnrichmentEvent): Promise<void> {
    if (!event?.items?.length) return;
    try {
      const payload = JSON.stringify(event);
      await this.redis.publish(RU_ENRICHMENT_CHANNEL, payload);
    } catch (error) {
      this.logger.warn(`Failed to publish RU enrichment event: ${error}`);
    }
  }

  subscribe(handler: (event: RuEnrichmentEvent) => void): () => void {
    const unsubscribe = this.redis.subscribe(
      RU_ENRICHMENT_CHANNEL,
      (rawMessage) => {
        try {
          const parsed = JSON.parse(rawMessage);
          if (!parsed || !Array.isArray(parsed.items)) return;

          const validItems: RuEnrichmentItem[] = [];
          for (const item of parsed.items) {
            if (
              item &&
              typeof item.candidateId === "string" &&
              (item.status === "READY" || item.status === "RETRY")
            ) {
              validItems.push({
                candidateId: item.candidateId,
                status: item.status,
                retryAt: typeof item.retryAt === "string" ? item.retryAt : null,
              });
            }
          }

          if (validItems.length > 0) {
            handler({ items: validItems });
          }
        } catch (error) {
          this.logger.warn(`Failed to parse RU enrichment event: ${error}`);
        }
      },
    );

    this.unsubscribers.push(unsubscribe);
    return () => {
      const idx = this.unsubscribers.indexOf(unsubscribe);
      if (idx !== -1) {
        this.unsubscribers.splice(idx, 1);
      }
      unsubscribe();
    };
  }

  onModuleDestroy() {
    for (const unsub of this.unsubscribers) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    this.unsubscribers.length = 0;
  }
}
