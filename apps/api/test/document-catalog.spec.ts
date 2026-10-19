import { ConfigService } from "@nestjs/config";
import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentCatalogService } from "../src/documents/document-catalog.service";
import type { PrismaService } from "../src/prisma/prisma.service";
import type { RedisService } from "../src/redis/redis.module";
import { createCatalogRedisDouble } from "./helpers/catalog-redis";

const day = 24 * 60 * 60_000;
const uid = "6ffb1fd5-8341-11eb-ba8b-00259002db81";
const payload = [
  {
    УИНДокумента: uid,
    НаименованиеДокумента: "Passport",
    КодыДолжностей: ["001"],
    ВсемРФ: true,
    ВсемИГ: false,
    requiredFields: ["number"],
    optionalFields: [],
  },
];
const response = () => new Response(JSON.stringify(payload));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("document catalog cached snapshot", () => {
  let syncedAt: Date | null;
  let redis: ReturnType<typeof createCatalogRedisDouble>;
  let prisma: ReturnType<typeof database>;
  let request: ReturnType<typeof vi.fn<typeof fetch>>;
  let commits: number;
  function database() {
    const tx = {
      documentType: {
        upsert: vi.fn(async () => ({ id: "type" })),
        updateMany: vi.fn(async () => undefined),
      },
      documentTypeField: {
        deleteMany: vi.fn(async () => undefined),
        createMany: vi.fn(async () => undefined),
      },
      documentTypePosition: {
        deleteMany: vi.fn(async () => undefined),
        createMany: vi.fn(async () => undefined),
      },
    };
    return {
      documentType: {
        findFirst: vi.fn(async () =>
          syncedAt ? { catalogSyncedAt: syncedAt } : null,
        ),
        findMany: vi.fn(async () => [
          {
            id: "type",
            code: "PASSPORT",
            title: "Passport",
            erpUid: uid,
            allRu: true,
            allForeign: false,
            positions: [],
            definitions: [],
          },
        ]),
      },
      $transaction: vi.fn(
        async (apply: (value: typeof tx) => Promise<void>) => {
          await apply(tx);
          syncedAt = new Date();
          commits++;
        },
      ),
    };
  }
  const service = () =>
    new DocumentCatalogService(
      prisma as unknown as PrismaService,
      new ConfigService({
        ERP_DOCUMENTS_BASE_URL: "https://erp.example/",
        ERP_DOCUMENTS_TOKEN: "catalog-token",
        ERP_USERNAME: "test",
        ERP_PASSWORD: "test",
      }),
      redis as unknown as RedisService,
    );
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    syncedAt = new Date(Date.now() - 25 * 60 * 60_000);
    commits = 0;
    redis = createCatalogRedisDouble();
    prisma = database();
    request = vi.fn<typeof fetch>().mockImplementation(async () => response());
    vi.stubGlobal("fetch", request);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const settle = async (count: number) => {
    await vi.waitFor(() => expect(commits).toBe(count));
  };
  it("uses the persisted synchronization time for 24 hours, including after restart", async () => {
    syncedAt = new Date();
    await service().list("001");
    vi.setSystemTime(Date.now() + day - 1);
    await service().list("001");
    expect(request).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 1);
    await service().list("001");
    await settle(1);
    expect(request).toHaveBeenCalledTimes(1);
    await service().list("001");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("returns stale data immediately and shares one background request across processes", async () => {
    const pending = deferred<Response>();
    request.mockReturnValue(pending.promise);
    const a = service();
    const b = service();
    const lists = await Promise.all([
      a.list("001"),
      a.list("001"),
      b.list("001"),
    ]);
    expect(lists.every((list) => list.items[0].documentUid === uid)).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(commits).toBe(0);
    pending.resolve(response());
    await settle(1);
    await service().ensure();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("waits for the very first snapshot instead of returning an empty document list", async () => {
    syncedAt = null;
    const pending = deferred<Response>();
    request.mockReturnValue(pending.promise);
    const a = service();
    const requests = [a.list("001"), a.list("001"), service().list("001")];
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(commits).toBe(0);
    pending.resolve(response());
    expect(
      (await Promise.all(requests)).every((list) => list.items.length === 1),
    ).toBe(true);
    expect(commits).toBe(1);
  });
  it("keeps the old snapshot on ERP failure and shares the retry pause across restarts", async () => {
    const previous = syncedAt;
    request.mockRejectedValue(new Error("ERP unavailable"));
    await service().list("001");
    await vi.waitFor(() => expect(Logger.prototype.warn).toHaveBeenCalled());
    await service().list("001");
    expect(request).toHaveBeenCalledTimes(1);
    expect(syncedAt).toBe(previous);
    vi.setSystemTime(Date.now() + 90_000);
    request.mockImplementation(async () => response());
    await service().list("001");
    await settle(1);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("rejects invalid or empty ERP catalogs without replacing the saved snapshot", async () => {
    const previous = syncedAt;
    request.mockResolvedValue(new Response("[]"));
    await service().list("001");
    await vi.waitFor(() => expect(Logger.prototype.warn).toHaveBeenCalled());
    expect(syncedAt).toBe(previous);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it("serves cached reads with Redis down and does not run an uncoordinated refresh", async () => {
    vi.spyOn(redis, "setNxPxStrict").mockRejectedValue(new Error("Redis down"));
    expect((await service().list("001")).items).toHaveLength(1);
    expect(request).not.toHaveBeenCalled();
    syncedAt = null;
    await expect(service().ensure()).rejects.toThrow(
      "Каталог документов временно недоступен",
    );
  });
  it("does not commit a snapshot after losing the refresh lease", async () => {
    const pending = deferred<Response>();
    request.mockReturnValue(pending.promise);
    await service().ensure();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    vi.setSystemTime(Date.now() + 90_000);
    pending.resolve(response());
    await vi.waitFor(() => expect(Logger.prototype.warn).toHaveBeenCalled());
    expect(commits).toBe(0);
  });
  it("returns 503 on a cold ERP failure and permits a later retry", async () => {
    syncedAt = null;
    request.mockRejectedValue(new Error("ERP unavailable"));
    const a = service();
    await expect(a.ensure()).rejects.toThrow(
      "Каталог документов временно недоступен",
    );
    await expect(a.ensure()).rejects.toThrow(
      "Каталог документов временно недоступен",
    );
    expect(request).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 90_000);
    request.mockImplementation(async () => response());
    await a.ensure();
    expect(commits).toBe(1);
  });
});
