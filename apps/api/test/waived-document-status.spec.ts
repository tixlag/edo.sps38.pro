import { describe, expect, it, vi } from "vitest";
import { DocumentReadService } from "../src/documents/document-read.service";

describe("approved document absences in statuses", () => {
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
        candidate: { findFirst: vi.fn().mockResolvedValue(candidate) },
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
