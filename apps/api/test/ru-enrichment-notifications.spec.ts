import { describe, expect, it, vi, beforeEach } from "vitest";
import { RuEnrichmentNotificationsService, type RuEnrichmentEvent } from "../src/documents/ru-enrichment-notifications.service";
import { RedisService } from "../src/redis/redis.module";

describe("RuEnrichmentNotificationsService", () => {
  let service: RuEnrichmentNotificationsService;
  let mockRedis: any;
  let subscribedHandler: ((msg: string) => void) | undefined;

  beforeEach(() => {
    subscribedHandler = undefined;
    mockRedis = {
      publish: vi.fn().mockResolvedValue(1),
      subscribe: vi.fn((_channel: string, handler: (msg: string) => void) => {
        subscribedHandler = handler;
        return vi.fn();
      }),
    } as unknown as RedisService;

    service = new RuEnrichmentNotificationsService(mockRedis);
  });

  it("publishes valid events over Redis channel", async () => {
    const event: RuEnrichmentEvent = {
      items: [
        { candidateId: "c-1", status: "READY", retryAt: null },
        { candidateId: "c-2", status: "RETRY", retryAt: "2026-11-18T12:00:00.000Z" },
      ],
    };

    await service.publish(event);

    expect(mockRedis.publish).toHaveBeenCalledWith(
      "edo:ru-enrichment:events",
      JSON.stringify(event),
    );
  });

  it("does not throw when Redis publish fails", async () => {
    mockRedis.publish.mockRejectedValue(new Error("Redis offline"));
    await expect(
      service.publish({
        items: [{ candidateId: "c-1", status: "READY", retryAt: null }],
      }),
    ).resolves.not.toThrow();
  });

  it("safely handles incoming events and filters invalid items", () => {
    const received: RuEnrichmentEvent[] = [];
    service.subscribe((evt) => received.push(evt));

    expect(mockRedis.subscribe).toHaveBeenCalledWith(
      "edo:ru-enrichment:events",
      expect.any(Function),
    );

    // Valid payload
    subscribedHandler?.(
      JSON.stringify({
        items: [
          { candidateId: "c-1", status: "READY", retryAt: null },
          { candidateId: "c-2", status: "INVALID_STATUS", retryAt: null },
          { notACandidate: true },
        ],
      }),
    );

    expect(received).toHaveLength(1);
    expect(received[0].items).toEqual([
      { candidateId: "c-1", status: "READY", retryAt: null },
    ]);

    // Malformed JSON should not crash handler
    expect(() => subscribedHandler?.("invalid json")).not.toThrow();
  });
});
