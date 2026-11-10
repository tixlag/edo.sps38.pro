import { describe, expect, it, vi } from "vitest";
import { IgEnrichmentQueueService } from "../src/documents/ig-enrichment-queue.service";

describe("IgEnrichmentQueueService priority separation", () => {
  const principal = { accessRules: { "20002": [] } } as never;

  it("queues batch requests with priority: false so they run in background and do not flood priority lane", async () => {
    const candidateWhere = vi.fn(() => ({}));
    const access = { candidateWhere } as any;

    const candidates = [
      { id: "cand-1", erpUid: "uid-1", previousDocumentsSyncedAt: null },
      { id: "cand-2", erpUid: "uid-2", previousDocumentsSyncedAt: null },
    ];

    let createdData: any = null;
    let updatedPriority: any = null;

    const tx = {
      igEnrichmentJob: {
        createMany: vi.fn(async (args) => {
          createdData = args.data;
          return { count: args.data.length };
        }),
        updateMany: vi.fn(async (args) => {
          if (args.data?.priority !== undefined) {
            updatedPriority = args.data.priority;
          }
          return { count: 0 };
        }),
      },
    };

    const prisma = {
      candidate: {
        findMany: vi.fn(async () => candidates),
      },
      igEnrichmentJob: {
        findMany: vi.fn(async () => [{ candidateId: "cand-1" }, { candidateId: "cand-2" }]),
      },
      $transaction: vi.fn(async (callback) => callback(tx)),
    } as any;

    const queue = new IgEnrichmentQueueService(
      prisma,
      {} as any,
      access,
      { get: () => "false" } as any,
    );

    const result = await queue.requestBatch(["cand-1", "cand-2"], principal);
    expect(result).toEqual({ pendingCandidateIds: ["cand-1", "cand-2"] });

    // Batch creation must set priority: false
    expect(createdData).toEqual([
      { candidateId: "cand-1", priority: false },
      { candidateId: "cand-2", priority: false },
    ]);
    // Batch must NOT set priority: true anywhere
    expect(updatedPriority).toBeNull();
  });

  it("promotes interactive candidate request to priority: true and moves requestedAt to epoch for immediate execution", async () => {
    const candidate = {
      id: "cand-interactive",
      erpUid: "uid-interactive",
      reviewGroup: "RU",
      citizenship: "ru",
      previousDocumentsSyncedAt: null,
    };

    const access = {
      candidate: vi.fn(async () => candidate),
      candidateWhere: vi.fn(() => ({})),
    } as any;

    let upsertArgs: any = null;

    const tx = {
      igEnrichmentJob: {
        upsert: vi.fn(async (args) => {
          upsertArgs = args;
          return { candidateId: "cand-interactive" };
        }),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    };

    const prisma = {
      candidate: {
        findUniqueOrThrow: vi.fn(async () => candidate),
      },
      igEnrichmentJob: {
        findUnique: vi.fn(async () => ({
          candidateId: "cand-interactive",
          status: "PENDING",
          priority: true,
        })),
      },
      $transaction: vi.fn(async (callback) => callback(tx)),
    } as any;

    const queue = new IgEnrichmentQueueService(
      prisma,
      {} as any,
      access,
      { get: () => "false" } as any,
    );

    await queue.request("cand-interactive", principal);

    expect(upsertArgs).not.toBeNull();
    expect(upsertArgs.create.priority).toBe(true);
    expect(upsertArgs.create.requestedAt).toEqual(new Date(0));
    expect(upsertArgs.update.priority).toBe(true);
    expect(upsertArgs.update.requestedAt).toEqual(new Date(0));
  });
});
