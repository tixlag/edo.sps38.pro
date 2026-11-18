import { describe, expect, it, vi } from "vitest";
import { IgEnrichmentQueueService } from "../src/documents/ig-enrichment-queue.service";

describe("candidate enrichment batch sync", () => {
  it("queues stale RU candidates immediately without synchronous ERP calls", async () => {
    const candidates = [
      { id: "first", erpUid: "11111111-1111-4111-8111-111111111111", previousDocumentsSyncedAt: null },
      { id: "second", erpUid: "22222222-2222-4222-8222-222222222222", previousDocumentsSyncedAt: null },
    ];
    const created = vi.fn().mockResolvedValue({ count: 2 });
    const updated = vi.fn().mockResolvedValue({ count: 0 });
    const tx = {
      igEnrichmentJob: {
        createMany: created,
        updateMany: updated,
      },
    };
    const prisma = {
      candidate: { findMany: vi.fn().mockResolvedValue(candidates) },
      igEnrichmentJob: { findMany: vi.fn().mockResolvedValue([{ candidateId: "first" }, { candidateId: "second" }]) },
      $transaction: vi.fn(async (run: (tx: typeof tx) => Promise<unknown>) => run(tx)),
    };
    const batch = vi.fn();
    const sync = vi.fn();
    const queue = new IgEnrichmentQueueService(
      prisma as never,
      {} as never,
      { candidateWhere: () => ({}) } as never,
      {} as never,
      { personDocumentsBatch: batch } as never,
      { syncPreviousDocuments: sync } as never,
    );

    const result = await queue.requestBatch(["first", "second"], { accessRules: { "20002": [] } } as never);

    // HTTP request must not call ERP or full sync synchronously
    expect(batch).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();

    // Queues stale candidates with priority: false and skipDuplicates
    expect(created).toHaveBeenCalledWith({
      data: [
        { candidateId: "first", priority: false },
        { candidateId: "second", priority: false },
      ],
      skipDuplicates: true,
    });
    expect(result).toEqual({ pendingCandidateIds: ["first", "second"] });
  });

  it("processes RU candidates in background using personDocumentsBatch and handles items independently", async () => {
    const candidates = [
      { id: "first", erpUid: "11111111-1111-4111-8111-111111111111", reviewGroup: "RU", citizenship: "ru" },
      { id: "second", erpUid: "22222222-2222-4222-8222-222222222222", reviewGroup: "RU", citizenship: "ru" },
    ];
    const jobs = [
      { candidateId: "first", priority: false, attempts: 0, status: "PENDING", candidate: candidates[0] },
      { candidateId: "second", priority: false, attempts: 0, status: "PENDING", candidate: candidates[1] },
    ];

    const batch = vi.fn().mockResolvedValue({
      items: [
        { candidateUid: candidates[0].erpUid, documents: { items: [] } },
        { candidateUid: candidates[1].erpUid, error: { code: "DOCUMENT_UNAVAILABLE" } },
      ],
    });

    const enrichCandidate = vi.fn().mockImplementation(async (id: string, opts?: any) => {
      if (id === "first") {
        expect(opts?.preloadedDocuments).toEqual({ items: [] });
        return { profileSynced: true, documentsSynced: true };
      }
      return { profileSynced: false, documentsSynced: false };
    });

    const updatedJobs: any[] = [];
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ leaseToken: null, leaseExpiresAt: null }]),
      igEnrichmentJob: {
        findFirst: vi.fn().mockResolvedValue(jobs[0]),
        findMany: vi.fn().mockResolvedValue(jobs),
        updateMany: vi.fn().mockImplementation(async (args) => {
          updatedJobs.push(args);
          return { count: 2 };
        }),
      },
      igEnrichmentLane: {
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      candidate: {
        update: vi.fn().mockResolvedValue({}),
      },
    };

    const prisma = {
      $transaction: vi.fn(async (run: (tx: typeof tx) => Promise<unknown>) => run(tx)),
      $queryRaw: vi.fn().mockResolvedValue([{ leaseToken: "tok", leaseExpiresAt: new Date(Date.now() + 60_000) }]),
    };

    const queue = new IgEnrichmentQueueService(
      prisma as never,
      { enrichCandidate } as never,
      { candidateWhere: () => ({}) } as never,
      { get: () => "false" } as never,
      { personDocumentsBatch: batch } as never,
      {} as never,
    );

    await queue.runLane("background");

    // personDocumentsBatch must be called once for all candidate UUIDs
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0]).toEqual(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);

    // enrichCandidate called for first (success)
    expect(enrichCandidate).toHaveBeenCalledWith("first", expect.objectContaining({ preloadedDocuments: { items: [] } }));

    // Settlement checks: "first" should be READY, "second" (which had error in batch) should be RETRY
    const settlementUpdates = updatedJobs.filter((u) => u.data?.status === "READY" || u.data?.status === "RETRY");
    const firstSettlement = settlementUpdates.find((u) => u.where.candidateId === "first");
    const secondSettlement = settlementUpdates.find((u) => u.where.candidateId === "second");

    expect(firstSettlement?.data.status).toBe("READY");
    expect(firstSettlement?.data.attempts).toBe(0);

    expect(secondSettlement?.data.status).toBe("RETRY");
    expect(secondSettlement?.data.attempts).toBe(1);
  });
});
