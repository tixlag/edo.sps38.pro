import { describe, expect, it, vi } from "vitest";
import { DocumentReadService } from "../src/documents/document-read.service";
import { CandidateDocumentsService } from "../src/documents/candidate-documents.service";
import { DocumentEventsService } from "../src/documents/document-events.service";

it("credits confirmed ERP documents for the verified RU employee without a chat", async () => {
  const candidate = {
    id: "erp-card", erpUid: "erp", personUid: null, reviewGroup: "RU",
    chatUuid: "old-chat", previousDocumentsSyncedAt: null,
  };
  const documentFind = vi.fn().mockResolvedValue([]);
  const prisma = {
    igEmploymentState: { findUnique: vi.fn().mockResolvedValue(null) },
    candidate: { findUnique: vi.fn().mockResolvedValue(candidate), findMany: vi.fn().mockResolvedValue([]) },
    document: { findMany: documentFind },
    candidateDocumentAbsence: { findMany: vi.fn().mockResolvedValue([]) },
    candidatePreviousDocument: {
      findMany: vi.fn().mockResolvedValue([
        { documentUid: "passport", sourceId: "candidate|1", sourcePersonUid: null, fields: {}, expiresAt: null, originalAvailable: true },
        { documentUid: "wrong-owner", sourceId: "person|1", sourcePersonUid: "other", fields: {}, expiresAt: null, originalAvailable: true },
        { documentUid: "expired", sourceId: "candidate|2", sourcePersonUid: null, fields: {}, expiresAt: new Date("2001-01-01"), originalAvailable: true },
      ]),
    },
  };
  const history = { resolveRuCreditSource: vi.fn().mockResolvedValue({ erpUid: "erp", personUid: "employee" }) };
  const sync = { syncPreviousDocuments: vi.fn().mockResolvedValue(undefined) };
  const reads = new DocumentReadService(
    prisma as never, {} as never, {} as never,
    undefined, undefined, undefined, history as never, sync as never,
  );
  const testUpload = { id: "test-upload", candidateId: "unlinked", documentUid: "passport", status: "IN_REVIEW" };
  vi.spyOn(reads, "documents")
    .mockResolvedValueOnce({ items: [testUpload as never] })
    .mockResolvedValueOnce({ items: [] });
  expect(await reads.internalDocuments({ code_1c: "worker" })).toMatchObject(
    { reusedDocumentUids: ["passport"], items: [] },
  );
  expect(sync.syncPreviousDocuments).toHaveBeenCalledTimes(1);
  expect(prisma.candidatePreviousDocument.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ candidateId: "erp-card", status: "CONFIRMED" }) }),
  );
});

describe("approved document absences in statuses", () => {
  it("delivers changed waivers through both status paths and the existing stream", async () => {
    vi.useFakeTimers();
    let approved = true;
    const prisma = {
      candidate: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: "ru", chatUuid: "chat", citizenship: "ru" }),
      },
      document: { findMany: vi.fn().mockResolvedValue([]) },
      candidatePreviousDocument: { findMany: vi.fn().mockResolvedValue([]) },
      candidateDocumentAbsence: {
        findMany: vi.fn(async () =>
          approved ? [{ documentType: { erpUid: "uid" } }] : [],
        ),
      },
    };
    const reads = new DocumentReadService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const identity = {
      byUuid: vi.fn().mockResolvedValue({ chatUuid: "chat", code1c: "worker" }),
      byEmployee: vi
        .fn()
        .mockResolvedValue({ chatUuid: "chat", code1c: "worker" }),
    };
    const service = new CandidateDocumentsService(
      {} as never,
      identity as never,
      {} as never,
      reads,
      {} as never,
      {} as never,
    );
    const events = new DocumentEventsService(
      prisma as never,
      reads,
      {} as never,
      {} as never,
    );
    const emitted: unknown[] = [];
    const subscription = events
      .stream({ chat_uuid: "chat" })
      .subscribe((event) => emitted.push(event.data));
    try {
      expect((await service.statuses("chat")).waivedDocumentUids).toEqual([
        "uid",
      ]);
      expect((await service.ownStatuses("worker")).waivedDocumentUids).toEqual([
        "uid",
      ]);
      await vi.advanceTimersByTimeAsync(0);
      expect(emitted).toContainEqual(
        expect.objectContaining({ waivedDocumentUids: ["uid"] }),
      );
      approved = false;
      await vi.advanceTimersByTimeAsync(1000);
      expect(emitted).toContainEqual(
        expect.objectContaining({ waivedDocumentUids: [] }),
      );
    } finally {
      subscription.unsubscribe();
      events.onModuleDestroy();
      vi.useRealTimers();
    }
  });
  it.each([
    [
      { chat_uuid: "CHAT" },
      { id: "ru", chatUuid: "chat", citizenship: "ru" },
      ["uid"],
    ],
    [
      { code_1c: "worker" },
      { id: "ru", chatUuid: null, citizenship: "ru" },
      ["uid"],
    ],
    [
      { candidateId: "ig" },
      { id: "ig", chatUuid: null, citizenship: "uz" },
      [],
    ],
  ])(
    "returns approved UIDs for the resolved scope %#",
    async (scope, candidate, expected) => {
      const prisma = {
        igEmploymentState: { findUnique: vi.fn().mockResolvedValue(null) },
        candidate: {
          findFirst: vi.fn().mockResolvedValue(candidate),
          findMany: vi.fn().mockResolvedValue([candidate]),
        },
        document: { findMany: vi.fn().mockResolvedValue([]) },
        candidatePreviousDocument: { findMany: vi.fn().mockResolvedValue([]) },
        candidateDocumentAbsence: {
          findMany: vi
            .fn()
            .mockResolvedValue([
              { documentType: { erpUid: "uid" } },
              { documentType: { erpUid: null } },
            ]),
        },
      };
      const reads = new DocumentReadService(
        prisma as never,
        {} as never,
        {} as never,
        {} as never,
      );
      const result = await reads.internalDocuments(scope);
      expect(result.waivedDocumentUids).toEqual(expected);
      if (expected.length)
        expect(prisma.candidateDocumentAbsence.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { candidateId: candidate.id, status: "APPROVED" },
          }),
        );
      else
        expect(prisma.candidateDocumentAbsence.findMany).not.toHaveBeenCalled();
    },
  );
});
