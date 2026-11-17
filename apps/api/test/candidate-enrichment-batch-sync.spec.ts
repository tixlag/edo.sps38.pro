import { expect, it, vi } from "vitest";
import { IgEnrichmentQueueService } from "../src/documents/ig-enrichment-queue.service";

it("refreshes a visible RU page in one ERP batch and queues only a failed element", async () => {
  const candidates = [
    { id: "first", erpUid: "11111111-1111-4111-8111-111111111111", previousDocumentsSyncedAt: null },
    { id: "second", erpUid: "22222222-2222-4222-8222-222222222222", previousDocumentsSyncedAt: null },
  ];
  const created = vi.fn().mockResolvedValue({ count: 1 });
  const tx = { igEnrichmentJob: { createMany: created, updateMany: vi.fn().mockResolvedValue({ count: 0 }) } };
  const prisma = {
    candidate: { findMany: vi.fn().mockResolvedValue(candidates) },
    igEnrichmentJob: { findMany: vi.fn().mockResolvedValue([{ candidateId: "second" }]) },
    $transaction: vi.fn(async (run: (tx: typeof tx) => Promise<unknown>) => run(tx)),
  };
  const batch = vi.fn().mockResolvedValue({ items: [
    { candidateUid: candidates[0].erpUid, documents: { items: [] } },
    { candidateUid: candidates[1].erpUid, error: { code: "DOCUMENT_UNAVAILABLE" } },
  ] });
  const sync = vi.fn().mockResolvedValue(undefined);
  const queue = new IgEnrichmentQueueService(
    prisma as never, {} as never,
    { candidateWhere: () => ({}) } as never, {} as never,
    { personDocumentsBatch: batch } as never,
    { syncPreviousDocuments: sync } as never,
  );
  const result = await queue.requestBatch(["first", "second"], { accessRules: { "20002": [] } } as never);
  expect(batch).toHaveBeenCalledTimes(1);
  expect(batch.mock.calls[0][0]).toEqual(candidates.map((item) => item.erpUid));
  expect(sync).toHaveBeenCalledTimes(1);
  expect(sync.mock.calls[0][0]).toBe("first");
  expect(created.mock.calls[0][0].data).toEqual([{ candidateId: "second", priority: false }]);
  expect(result).toEqual({ pendingCandidateIds: ["second"] });
});
