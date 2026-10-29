import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigService } from "@nestjs/config";
import { RedisService } from "../src/redis/redis.module";
import { CandidateCardCache } from "../src/documents/candidate-card-cache";

const url = process.env.EDO_CANDIDATE_CACHE_TEST_REDIS_URL;
// These tests evict entries and expire leases: exclusively a disposable Redis.
describe.skipIf(!url)(
  "candidate card Redis cache (disposable instance only)",
  () => {
    let redis: RedisService;
    let cache: CandidateCardCache;
    beforeAll(async () => {
      const endpoint = new URL(url!);
      if (
        !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
        !endpoint.port ||
        endpoint.port === "6379"
      )
        throw new Error("Refusing shared Redis");
      redis = new RedisService(new ConfigService({ REDIS_URL: url }));
      cache = new CandidateCardCache(redis);
      await redis.pingStrict();
    });
    afterAll(async () => {
      await redis?.onModuleDestroy();
    });
    const uuid = "019d0a2a-f080-762e-b2d0-c7bb7ddb1922";
    const entry = {
      snapshot: {
        uuid,
        name: "Иван",
        citizenship: "ru",
        position: { code: "000491" },
      },
      freshUntil: Date.now() + 60_000,
    };
    it("rejects a lost lease, stores the card, and invalidates it after a permanent error", async () => {
      expect(await cache.acquire(uuid, "owner")).toBe(true);
      await expect(cache.write(uuid, "other", entry)).rejects.toThrow(
        "lease lost",
      );
      await cache.write(uuid, "owner", entry);
      expect(await cache.get(uuid)).toEqual(entry);
      expect(await cache.acquire(uuid, "other")).toBe(false);
      await cache.release(uuid, "other");
      expect(await cache.acquire(uuid, "other")).toBe(false);
      await cache.write(uuid, "owner", null);
      expect(await cache.get(uuid)).toBeNull();
      await cache.release(uuid, "owner");
      expect(await cache.acquire(uuid, "other")).toBe(true);
      await cache.release(uuid, "other");
    });
    it("bounds the shared cache to 1000 cards across all owners", async () => {
      for (let index = 0; index < 1001; index++) {
        const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        await cache.acquire(id, "owner");
        await cache.write(id, "owner", {
          ...entry,
          snapshot: { ...entry.snapshot, uuid: id },
        });
        await cache.release(id, "owner");
      }
      expect(
        await redis.evalStrict(
          "return redis.call('HLEN', KEYS[1])",
          ["edo:candidate-cards:v2"],
          [],
        ),
      ).toBe(1000);
      expect(
        await cache.get("00000000-0000-4000-8000-000000000000"),
      ).toBeNull();
    });
  },
);
