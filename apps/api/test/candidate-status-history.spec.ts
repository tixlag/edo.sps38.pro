import { describe, expect, it, vi } from "vitest";
import { CandidateDocumentsService } from "../src/documents/candidate-documents.service";
import { CandidateWorkspaceService } from "../src/communications/candidate-workspace.service";

function fixture(syncedAt: Date | null = null) {
  const candidate = { id: "candidate", chatUuid: "chat", erpUid: "erp-candidate", reviewGroup: "RU", citizenship: "ru", personUid: null, code1c: null, previousDocumentsSyncedAt: syncedAt };
  const syncPreviousDocuments = vi.fn().mockResolvedValue(undefined);
  const internalDocuments = vi.fn().mockResolvedValue({ items: [{ documentUid: "passport" }] });
  const service = new CandidateDocumentsService({} as never,
    { byUuid: vi.fn().mockResolvedValue({ chatUuid: "chat", code1c: null }) } as never,
    {} as never, { internalDocuments } as never, {} as never, {} as never,
    { candidate: { findFirst: vi.fn().mockResolvedValue(candidate) } } as never,
    { syncPreviousDocuments } as never);
  return { service, candidate, syncPreviousDocuments };
}
describe("RU chat status history", () => {
  it("refreshes ERP history before a person or employee exists and reuses it on repeat reads", async () => {
    const f = fixture();
    expect(await f.service.statuses("chat")).toEqual({ items: [{ documentUid: "passport" }] });
    await f.service.statuses("chat");
    expect(f.syncPreviousDocuments).toHaveBeenCalledTimes(1);
    expect(f.syncPreviousDocuments.mock.calls[0][3]).toBe(f.candidate);
  });
  it("reuses a snapshot freshly updated by the drawer", async () => {
    const f = fixture(new Date());
    await f.service.statuses("chat");
    expect(f.syncPreviousDocuments).not.toHaveBeenCalled();
  });
  it("refreshes a stale drawer snapshot", async () => {
    const f = fixture(new Date(Date.now() - 6 * 60_000));
    await f.service.statuses("chat");
    expect(f.syncPreviousDocuments).toHaveBeenCalledTimes(1);
  });
});

describe("GET /previous-documents for RU candidate", () => {
  it("reads local saved documents without awaiting full ERP sync", async () => {
    const candidate = {
      id: "ru-candidate-id",
      reviewGroup: "RU",
      citizenship: "ru",
      erpUid: "erp-uid-123",
      previousDocumentsSyncedAt: new Date(),
    };
    const localDocs = [
      {
        id: "prev-1",
        title: "Паспорт РФ",
        documentUid: "passport-uid",
        fields: { seriesNumber: "1234 567890" },
        expiresAt: null,
        originalAvailable: true,
        status: "CONFIRMED",
        reviewedBy: "system:previous-document",
        reviewedAt: new Date("2026-11-18T10:00:00Z"),
      },
    ];

    const prisma = {
      candidatePreviousDocument: {
        findMany: vi.fn().mockResolvedValue(localDocs),
      },
    };
    const syncPreviousDocuments = vi.fn();
    const enrichmentQueue = {
      request: vi.fn().mockResolvedValue({}),
    };
    const access = {
      candidate: vi.fn().mockResolvedValue(candidate),
    };

    const service = new CandidateWorkspaceService(
      prisma as never,
      {} as never,
      access as never,
      {} as never,
      {} as never,
      {} as never,
      { syncPreviousDocuments } as never,
      undefined,
      undefined,
      undefined,
      enrichmentQueue as never,
    );

    const principal = { accessRules: { "20002": [] }, code1c: "reviewer-1c" } as never;
    const result = await service.previous("ru-candidate-id", principal);

    // Must return local items
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: "prev-1",
      title: "Паспорт РФ",
      documentUid: "passport-uid",
      status: "CONFIRMED",
      originalAvailable: true,
    });

    // Must NOT call full syncPreviousDocuments
    expect(syncPreviousDocuments).not.toHaveBeenCalled();

    // Since it's freshly synced, must not even queue a job
    expect(enrichmentQueue.request).not.toHaveBeenCalled();
  });

  it("enqueues background refresh for stale RU candidate without blocking the GET response", async () => {
    const candidate = {
      id: "ru-stale-id",
      reviewGroup: "RU",
      citizenship: "ru",
      erpUid: "erp-uid-456",
      previousDocumentsSyncedAt: new Date(Date.now() - 10 * 60_000), // 10 minutes ago
    };
    const localDocs: any[] = [];

    const prisma = {
      candidatePreviousDocument: {
        findMany: vi.fn().mockResolvedValue(localDocs),
      },
    };
    const syncPreviousDocuments = vi.fn();
    const enrichmentQueue = {
      request: vi.fn().mockResolvedValue({}),
    };
    const access = {
      candidate: vi.fn().mockResolvedValue(candidate),
    };

    const service = new CandidateWorkspaceService(
      prisma as never,
      {} as never,
      access as never,
      {} as never,
      {} as never,
      {} as never,
      { syncPreviousDocuments } as never,
      undefined,
      undefined,
      undefined,
      enrichmentQueue as never,
    );

    const principal = { accessRules: { "20002": [] }, code1c: "reviewer-1c" } as never;
    const result = await service.previous("ru-stale-id", principal);

    expect(result.items).toEqual([]);
    expect(syncPreviousDocuments).not.toHaveBeenCalled();
    expect(enrichmentQueue.request).toHaveBeenCalledWith("ru-stale-id", principal);
  });
});
