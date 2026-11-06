import { describe, expect, it, vi } from "vitest";
import { DocumentReadService } from "../src/documents/document-read.service";

describe("IG current-cycle document scope", () => {
  it("does not mix documents from earlier employments into employee statuses", async () => {
    const prisma = {
      igEmploymentState: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ currentCandidateId: "current" }),
      },
      document: { findMany: vi.fn().mockResolvedValue([]) },
      candidatePreviousDocument: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { documentUid: "passport", expiresAt: null, fields: {} },
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
