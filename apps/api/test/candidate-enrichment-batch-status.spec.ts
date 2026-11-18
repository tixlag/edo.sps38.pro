import { describe, expect, it, vi } from "vitest";
import { IgEnrichmentQueueService } from "../src/documents/ig-enrichment-queue.service";
import { EdoAccessRule } from "../src/auth/edo-access-rule";

describe("Candidate Enrichment Batch Status", () => {
  it("returns batch statuses without calling ERP or modifying database", async () => {
    const candidates = [
      {
        id: "c-ready",
        erpUid: "uid-1",
        citizenship: "ru",
        chatUuid: null,
        reviewGroup: "RU",
        previousDocumentsSyncedAt: new Date(),
        profileSyncedAt: new Date(),
        positionCode: "DEV",
      },
      {
        id: "c-running",
        erpUid: "uid-2",
        citizenship: "ru",
        chatUuid: null,
        reviewGroup: "RU",
        previousDocumentsSyncedAt: null,
        profileSyncedAt: null,
        positionCode: null,
      },
      {
        id: "c-retry",
        erpUid: "uid-3",
        citizenship: "ru",
        chatUuid: null,
        reviewGroup: "RU",
        previousDocumentsSyncedAt: null,
        profileSyncedAt: null,
        positionCode: null,
      },
      {
        id: "c-pending",
        erpUid: "uid-4",
        citizenship: "ru",
        chatUuid: null,
        reviewGroup: "RU",
        previousDocumentsSyncedAt: null,
        profileSyncedAt: null,
        positionCode: null,
      },
    ];

    const jobs = [
      { candidateId: "c-ready", status: "READY", leaseExpiresAt: null, nextAttemptAt: null },
      {
        candidateId: "c-running",
        status: "RUNNING",
        leaseExpiresAt: new Date(Date.now() + 60_000),
        nextAttemptAt: null,
      },
      {
        candidateId: "c-retry",
        status: "RETRY",
        leaseExpiresAt: null,
        nextAttemptAt: new Date("2026-11-18T14:00:00.000Z"),
      },
    ];

    const prisma = {
      candidate: {
        findMany: vi.fn().mockResolvedValue(candidates),
        update: vi.fn(),
      },
      igEnrichmentJob: {
        findMany: vi.fn().mockResolvedValue(jobs),
        updateMany: vi.fn(),
        createMany: vi.fn(),
      },
    };

    const erp = {
      personDocuments: vi.fn(),
      personDocumentsBatch: vi.fn(),
    };

    const queue = new IgEnrichmentQueueService(
      prisma as never,
      {} as never,
      { candidateWhere: () => ({}) } as never,
      {} as never,
      erp as never,
      {} as never,
    );

    const principal = {
      uuid: "user-1",
      accessRules: { [EdoAccessRule.DOCUMENT_REVIEW_RU]: [] },
    };

    const res = await queue.batchStatus(
      ["c-ready", "c-running", "c-retry", "c-pending", "inaccessible-c"],
      principal as never,
    );

    // No ERP calls
    expect(erp.personDocuments).not.toHaveBeenCalled();
    expect(erp.personDocumentsBatch).not.toHaveBeenCalled();

    // No mutations
    expect(prisma.candidate.update).not.toHaveBeenCalled();
    expect(prisma.igEnrichmentJob.updateMany).not.toHaveBeenCalled();
    expect(prisma.igEnrichmentJob.createMany).not.toHaveBeenCalled();

    // Exactly 1 batch query for candidates and 1 batch query for jobs
    expect(prisma.candidate.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.igEnrichmentJob.findMany).toHaveBeenCalledTimes(1);

    // Inaccessible candidate not returned
    expect(res.items).toHaveLength(4);
    expect(res.items).toEqual([
      { candidateId: "c-ready", status: "READY", retryAt: null },
      { candidateId: "c-running", status: "RUNNING", retryAt: null },
      { candidateId: "c-retry", status: "RETRY", retryAt: "2026-11-18T14:00:00.000Z" },
      { candidateId: "c-pending", status: "PENDING", retryAt: null },
    ]);
  });

  it("throws ForbiddenException when principal lacks RU review rule", async () => {
    const queue = new IgEnrichmentQueueService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const principal = {
      uuid: "user-ig-only",
      accessRules: { [EdoAccessRule.DOCUMENT_REVIEW_IG]: [] },
    };

    await expect(
      queue.batchStatus(["c-1"], principal as never),
    ).rejects.toThrow("Missing required EDO review group access rule");
  });
});
