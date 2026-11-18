import { describe, expect, it, vi } from "vitest";
import { IgEnrichmentQueueService } from "../src/documents/ig-enrichment-queue.service";
import type { RuEnrichmentNotificationsService } from "../src/documents/ru-enrichment-notifications.service";

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

    const notifications = {
      publish: vi.fn().mockResolvedValue(undefined),
    } as unknown as RuEnrichmentNotificationsService;

    const queue = new IgEnrichmentQueueService(
      prisma as never,
      { enrichCandidate } as never,
      { candidateWhere: () => ({}) } as never,
      { get: () => "false" } as never,
      { personDocumentsBatch: batch } as never,
      {} as never,
      notifications,
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

    // Notification published with both items
    expect(notifications.publish).toHaveBeenCalledTimes(1);
    expect(notifications.publish).toHaveBeenCalledWith({
      items: [
        { candidateId: "first", status: "READY", retryAt: null },
        { candidateId: "second", status: "RETRY", retryAt: expect.any(String) },
      ],
    });
  });

  it("missing item in ERP batch does NOT trigger single ERP request or enrichCandidate, marks RETRY", async () => {
    const candidates = [
      { id: "found", erpUid: "11111111-1111-4111-8111-111111111111", reviewGroup: "RU", citizenship: "ru" },
      { id: "missing", erpUid: "22222222-2222-4222-8222-222222222222", reviewGroup: "RU", citizenship: "ru" },
    ];
    const jobs = [
      { candidateId: "found", priority: false, attempts: 0, status: "PENDING", candidate: candidates[0] },
      { candidateId: "missing", priority: false, attempts: 0, status: "PENDING", candidate: candidates[1] },
    ];

    // ERP batch returns item for 'found', but nothing for 'missing'
    const batch = vi.fn().mockResolvedValue({
      items: [
        { candidateUid: candidates[0].erpUid, documents: { items: [] } },
      ],
    });

    const singlePersonDocs = vi.fn();
    const enrichCandidate = vi.fn().mockImplementation(async (id: string, opts?: any) => {
      // Must only be called for 'found' with preloadedDocuments defined
      expect(opts?.preloadedDocuments).toBeDefined();
      return { profileSynced: true, documentsSynced: true };
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

    const notifications = {
      publish: vi.fn().mockResolvedValue(undefined),
    } as unknown as RuEnrichmentNotificationsService;

    const queue = new IgEnrichmentQueueService(
      prisma as never,
      { enrichCandidate } as never,
      { candidateWhere: () => ({}) } as never,
      { get: () => "false" } as never,
      { personDocumentsBatch: batch, personDocuments: singlePersonDocs } as never,
      {} as never,
      notifications,
    );

    await queue.runLane("background");

    // enrichCandidate was called ONLY for 'found', NOT for 'missing'
    expect(enrichCandidate).toHaveBeenCalledTimes(1);
    expect(enrichCandidate).toHaveBeenCalledWith("found", expect.anything());
    expect(singlePersonDocs).not.toHaveBeenCalled();

    // 'missing' became RETRY
    const missingSettlement = updatedJobs.find(
      (u) => u.where.candidateId === "missing" && (u.data?.status === "READY" || u.data?.status === "RETRY"),
    );
    expect(missingSettlement?.data.status).toBe("RETRY");

    // Notification published containing both READY and RETRY
    expect(notifications.publish).toHaveBeenCalledWith({
      items: [
        { candidateId: "found", status: "READY", retryAt: null },
        { candidateId: "missing", status: "RETRY", retryAt: expect.any(String) },
      ],
    });
  });

  it("excludes jobs with lost leases (updated.count === 0) from published notification", async () => {
    const candidate = { id: "c1", erpUid: "11111111-1111-4111-8111-111111111111", reviewGroup: "RU", citizenship: "ru" };
    const job = { candidateId: "c1", priority: false, attempts: 0, status: "PENDING", candidate };

    const batch = vi.fn().mockResolvedValue({
      items: [{ candidateUid: candidate.erpUid, documents: { items: [] } }],
    });
    const enrichCandidate = vi.fn().mockResolvedValue({ profileSynced: true, documentsSynced: true });

    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ leaseToken: null, leaseExpiresAt: null }]),
      igEnrichmentJob: {
        findFirst: vi.fn().mockResolvedValue(job),
        findMany: vi.fn().mockResolvedValue([job]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }), // Lost lease!
      },
      igEnrichmentLane: {
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      candidate: { update: vi.fn() },
    };

    const prisma = {
      $transaction: vi.fn(async (run: (tx: typeof tx) => Promise<unknown>) => run(tx)),
      $queryRaw: vi.fn().mockResolvedValue([{ leaseToken: "tok", leaseExpiresAt: new Date(Date.now() + 60_000) }]),
    };

    const notifications = {
      publish: vi.fn().mockResolvedValue(undefined),
    } as unknown as RuEnrichmentNotificationsService;

    const queue = new IgEnrichmentQueueService(
      prisma as never,
      { enrichCandidate } as never,
      { candidateWhere: () => ({}) } as never,
      { get: () => "false" } as never,
      { personDocumentsBatch: batch } as never,
      {} as never,
      notifications,
    );

    await queue.runLane("background");

    // Since updated.count was 0, it was not settled by this run; no notification published
    expect(notifications.publish).not.toHaveBeenCalled();
  });

  it("publishes notification for priority RU candidate but not for priority IG candidate", async () => {
    const ruCandidate = { id: "ru-1", erpUid: "11111111-1111-4111-8111-111111111111", reviewGroup: "RU", citizenship: "ru" };
    const igCandidate = { id: "ig-1", erpUid: null, code1c: "IG001", personUid: "p-1", chatUuid: null, reviewGroup: "IG", citizenship: "uz" };

    const ruJob = { candidateId: "ru-1", priority: true, attempts: 0, status: "PENDING", candidate: ruCandidate };
    const igJob = { candidateId: "ig-1", priority: true, attempts: 0, status: "PENDING", candidate: igCandidate };

    const notifications = {
      publish: vi.fn().mockResolvedValue(undefined),
    } as unknown as RuEnrichmentNotificationsService;

    const enrichCandidate = vi.fn().mockResolvedValue({ profileSynced: true, documentsSynced: true });

    // Test RU priority
    const txRu = {
      $queryRaw: vi.fn().mockResolvedValue([{ leaseToken: null, leaseExpiresAt: null }]),
      igEnrichmentJob: {
        findFirst: vi.fn().mockResolvedValue(ruJob),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      igEnrichmentLane: {
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      candidate: { update: vi.fn().mockResolvedValue({}) },
    };

    const prismaRu = {
      $transaction: vi.fn(async (run: (tx: typeof txRu) => Promise<unknown>) => run(txRu)),
      $queryRaw: vi.fn().mockResolvedValue([{ leaseToken: "tok", leaseExpiresAt: new Date(Date.now() + 60_000) }]),
    };

    const queueRu = new IgEnrichmentQueueService(
      prismaRu as never,
      { enrichCandidate } as never,
      { candidateWhere: () => ({}) } as never,
      { get: () => "false" } as never,
      {} as never,
      {} as never,
      notifications,
    );

    await queueRu.runLane("priority");

    expect(notifications.publish).toHaveBeenCalledTimes(1);
    expect(notifications.publish).toHaveBeenCalledWith({
      items: [{ candidateId: "ru-1", status: "READY", retryAt: null }],
    });

    // Test IG priority
    vi.clearAllMocks();

    const txIg = {
      $queryRaw: vi.fn().mockResolvedValue([{ leaseToken: null, leaseExpiresAt: null }]),
      igEnrichmentJob: {
        findFirst: vi.fn().mockResolvedValue(igJob),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      igEnrichmentLane: {
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      candidate: { update: vi.fn().mockResolvedValue({}) },
    };

    const prismaIg = {
      $transaction: vi.fn(async (run: (tx: typeof txIg) => Promise<unknown>) => run(txIg)),
      $queryRaw: vi.fn().mockResolvedValue([{ leaseToken: "tok", leaseExpiresAt: new Date(Date.now() + 60_000) }]),
    };

    const queueIg = new IgEnrichmentQueueService(
      prismaIg as never,
      { enrichCandidate } as never,
      { candidateWhere: () => ({}) } as never,
      { get: () => "false" } as never,
      {} as never,
      {} as never,
      notifications,
    );

    await queueIg.runLane("priority");

    // IG completion must NOT publish an ru-enrichment event
    expect(notifications.publish).not.toHaveBeenCalled();
  });
});
