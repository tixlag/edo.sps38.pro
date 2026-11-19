import { describe, expect, it, vi } from "vitest";
import { DocumentReadService } from "../src/documents/document-read.service";

describe("IG current-cycle document scope", () => {
  it("does not mix documents from earlier employments into employee statuses", async () => {
    const personUid = "9f193736-c815-4d84-8678-197b1e792a67";
    const prisma = {
      igEmploymentState: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ currentCandidateId: "current" }),
      },
      document: { findMany: vi.fn().mockResolvedValue([]) },
      candidate: {
        findFirst: vi
          .fn()
          .mockResolvedValue({
            id: "current",
            chatUuid: null,
            citizenship: "uz",
            personUid,
          }),
      },
      candidatePreviousDocument: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { sourceId: "20261118|passport", sourcePersonUid: personUid, documentUid: "passport", expiresAt: null, fields: {} },
          ]),
      },
    };
    const service = new DocumentReadService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const result = await service.internalDocuments({ code_1c: "worker" });
    expect(result.reusedDocumentUids).toEqual(["passport"]);
    expect(prisma.document.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ candidate: { id: "current" } }),
      }),
    );
  });
});
