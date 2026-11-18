import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ConfigService } from "@nestjs/config";
import { RedisService } from "../src/redis/redis.module";

describe("RedisService Pub/Sub", () => {
  let redisService: RedisService;
  let mockMainClient: any;
  let mockSubClient: any;
  let listeners: Record<string, ((...args: any[]) => void)[]> = {};

  beforeEach(() => {
    listeners = {};
    mockMainClient = {
      publish: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      quit: vi.fn().mockResolvedValue(undefined),
    };
    mockSubClient = {
      subscribe: vi.fn().mockResolvedValue(1),
      unsubscribe: vi.fn().mockResolvedValue(1),
      connect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(handler);
      }),
      quit: vi.fn().mockResolvedValue(undefined),
    };

    const config = {
      get: vi.fn().mockReturnValue("redis://127.0.0.1:6379"),
    } as unknown as ConfigService;

    redisService = new RedisService(config);
    (redisService as any).client = mockMainClient;
    // When createSubscriberClient is called, we let it use mockSubClient
    (redisService as any).createSubscriberClient = function () {
      mockSubClient.on("message", (channel: string, message: string) => {
        const set = this.subListeners.get(channel);
        if (set) {
          for (const fn of set) {
            try {
              fn(message);
            } catch {
              // ignore
            }
          }
        }
      });
      return mockSubClient;
    };
  });

  afterEach(async () => {
    await redisService.onModuleDestroy();
  });

  it("publishes messages to a channel", async () => {
    mockMainClient.publish.mockResolvedValue(2);
    const count = await redisService.publish("test-channel", JSON.stringify({ hello: "world" }));
    expect(mockMainClient.publish).toHaveBeenCalledWith("test-channel", JSON.stringify({ hello: "world" }));
    expect(count).toBe(2);
  });

  it("safely returns null when publish fails", async () => {
    mockMainClient.publish.mockRejectedValue(new Error("Connection lost"));
    const count = await redisService.publish("test-channel", "msg");
    expect(count).toBeNull();
  });

  it("subscribes and routes incoming messages to registered listener", () => {
    const received: string[] = [];
    const unsubscribe = redisService.subscribe("test-channel", (msg) => received.push(msg));

    expect((redisService as any).subClient).toBeDefined();
    expect(mockSubClient.subscribe).toHaveBeenCalledWith("test-channel");

    // Simulate incoming message event from Redis
    const messageHandlers = listeners["message"];
    expect(messageHandlers?.length).toBeGreaterThan(0);

    messageHandlers[0]("test-channel", "hello-from-redis");
    expect(received).toEqual(["hello-from-redis"]);

    // Unsubscribe removes listener and unsubscribes when empty
    unsubscribe();
    expect(mockSubClient.unsubscribe).toHaveBeenCalledWith("test-channel");

    messageHandlers[0]("test-channel", "another-message");
    expect(received).toEqual(["hello-from-redis"]);
  });
});
