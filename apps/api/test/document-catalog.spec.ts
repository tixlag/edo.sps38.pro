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
      documentTypeStageRule: {
        deleteMany: vi.fn(async () => undefined),
        create: vi.fn(async () => undefined),
      },
    };
    return {
      tx,
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
            requiredForAll: false,
            stage: null as number | null,
            positions: [],
            definitions: [],
            stageRules: [] as {
              stage: number | null;
              requiredForAll: boolean;
              allRu: boolean;
              allForeign: boolean;
              positions: { code1c: string; required: boolean }[];
              projects: { code1c: string }[];
              countries: { code: string }[];
            }[],
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
  it("returns only applicable stages for each applicable document", async () => {
    syncedAt = new Date();
    const base = (await prisma.documentType.findMany())[0];
    const rule = {
      requiredForAll: false,
      allRu: false,
      allForeign: false,
      positions: [],
      projects: [],
      countries: [],
    };
    prisma.documentType.findMany.mockResolvedValueOnce([
      {
        ...base,
        stageRules: [
          {
            ...rule,
            stage: 7,
            positions: [{ code1c: "001", required: false }],
          },
          { ...rule, stage: 3, allRu: true },
          { ...rule, stage: 3, allRu: true },
          { ...rule, stage: null, projects: [{ code1c: "project" }] },
          { ...rule, stage: 9, countries: [{ code: "uz" }] },
        ],
      },
      {
        ...base,
        code: "OTHER",
        allRu: false,
        stageRules: [{ ...rule, stage: 4 }],
      },
      { ...base, code: "LEGACY", stage: 2, stageRules: [] },
    ]);
    const result = await service().list("001", "ru", null, "project");
    expect(
      result.items.map(({ code, stages, stageDetails }) => ({
        code,
        stages,
        stageDetails,
      })),
    ).toEqual([
      {
        code: "PASSPORT",
        stages: [3, 7, null],
        stageDetails: [
          { stage: 3, category: "required" },
          { stage: 7, category: "additional" },
          { stage: null, category: "required" },
        ],
      },
      {
        code: "LEGACY",
        stages: [2],
        stageDetails: [{ stage: 2, category: "required" }],
      },
    ]);
  });
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
  it("saves separate stage rules atomically during a catalog refresh", async () => {
    request.mockResolvedValue(
      new Response(
        JSON.stringify([
          { ...payload[0], Этап: 7, КодыДолжностей: ["", "001"] },
          { ...payload[0], Этап: 10, ВсемРФ: false, КодыДолжностей: [] },
        ]),
      ),
    );
    await service().ensure();
    await settle(1);
    expect(
      prisma.tx.documentTypeStageRule.create.mock.calls.map(
        ([input]) => input.data,
      ),
    ).toEqual([
      expect.objectContaining({
        stage: 7,
        allRu: true,
        positions: { create: [{ code1c: "001", required: true }] },
      }),
      expect.objectContaining({
        stage: 10,
        allRu: false,
        positions: { create: [] },
      }),
    ]);
  });
  it("persists optional positions, projects and countries from the new contract", async () => {
    request.mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            uid,
            name: "Passport",
            stage: 3,
            requirements: {
              requiredForAll: false,
              citizenship: { russian: false, foreign: false },
              positions: [
                { code: "001", required: false },
                { code: "002", required: true },
              ],
              projectCodes: ["project"],
              countryCodes: ["UZ"],
            },
            fields: { required: ["number"], optional: [] },
          },
        ]),
      ),
    );
    await service().ensure();
    await settle(1);
    expect(prisma.tx.documentTypeStageRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        stage: 3,
        positions: {
          create: [
            { code1c: "001", required: false },
            { code1c: "002", required: true },
          ],
        },
        projects: { create: [{ code1c: "project" }] },
        countries: { create: [{ code: "uz" }] },
      }),
    });
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
  it("keeps the previous snapshot when the new ERP format has an invalid project code", async () => {
    const previous = syncedAt;
    request.mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            uid,
            name: "Passport",
            stage: 3,
            requirements: {
              requiredForAll: false,
              citizenship: { russian: true, foreign: false },
              positions: [],
              projectCodes: ["bad code"],
              countryCodes: [],
            },
            fields: { required: ["number"], optional: [] },
          },
        ]),
      ),
    );
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
