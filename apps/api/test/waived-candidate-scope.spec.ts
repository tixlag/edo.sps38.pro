import { describe, expect, it, vi } from "vitest";
import { DocumentReadService } from "../src/documents/document-read.service";

const oldCard = {
  id: "old",
  code1c: "worker",
  chatUuid: "old-chat",
  citizenship: "ru",
  reviewGroup: "RU",
};
const currentCard = {
  id: "current",
  code1c: "worker",
  chatUuid: "current-chat",
  citizenship: "ru",
  reviewGroup: "RU",
};
const igCard = {
  id: "ig",
  code1c: "worker",
  chatUuid: null,
  citizenship: "uz",
  reviewGroup: "IG",
};

function fixture(
  candidates: Array<typeof oldCard | typeof igCard>,
  currentCandidateId: string | null = null,
) {
  const prisma = {
    igEmploymentState: {
      findUnique: vi
        .fn()
        .mockResolvedValue(currentCandidateId ? { currentCandidateId } : null),
    },
    candidate: {
      findFirst: vi.fn(
        async ({ where }: { where: { id?: string; chatUuid?: string } }) =>
          candidates.find((c) =>
            where.id ? c.id === where.id : c.chatUuid === where.chatUuid,
          ) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { code1c?: string } }) =>
        candidates.filter((c) => c.code1c === where.code1c).slice(0, 2),
      ),
    },
    document: { findMany: vi.fn().mockResolvedValue([]) },
    candidatePreviousDocument: { findMany: vi.fn().mockResolvedValue([]) },
    candidateDocumentAbsence: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { candidateId: string; status: string };
        }) =>
          where.candidateId === "old" && where.status === "APPROVED"
            ? [{ documentType: { erpUid: "old-uid" } }]
            : [],
      ),
    },
  };
  return {
    prisma,
    reads: new DocumentReadService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    ),
  };
}

describe("waived documents follow an unambiguous admission", () => {
  it("uses the only non-deleted candidate for an employee code", async () => {
    const { reads, prisma } = fixture([oldCard]);
    expect(
      (await reads.internalDocuments({ code_1c: "worker" })).waivedDocumentUids,
    ).toEqual(["old-uid"]);
    expect(prisma.candidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { code1c: "worker", erpDeleted: false },
        take: 2,
      }),
    );
  });

  it("does not reuse a historical waiver when several cards share the employee code", async () => {
    const { reads, prisma } = fixture([oldCard, currentCard]);
    expect(
      (await reads.internalDocuments({ code_1c: "worker" })).waivedDocumentUids,
    ).toEqual([]);
    expect(prisma.candidateDocumentAbsence.findMany).not.toHaveBeenCalled();
    expect(prisma.document.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ candidate: { code1c: "worker" } }),
      }),
    );
  });

  it("honours the explicit candidate id ahead of another chat identity", async () => {
    const { reads } = fixture([oldCard, currentCard]);
    expect(
      (
        await reads.internalDocuments({
          candidateId: "current",
          chat_uuid: "old-chat",
        })
      ).waivedDocumentUids,
    ).toEqual([]);
    expect(
      (await reads.internalDocuments({ candidateId: "old" }))
        .waivedDocumentUids,
    ).toEqual(["old-uid"]);
  });

  it("uses the candidate bound to the chat rather than another admission", async () => {
    const { reads } = fixture([oldCard, currentCard]);
    expect(
      (await reads.internalDocuments({ chat_uuid: "CURRENT-CHAT" }))
        .waivedDocumentUids,
    ).toEqual([]);
    expect(
      (await reads.internalDocuments({ chat_uuid: "OLD-CHAT" }))
        .waivedDocumentUids,
    ).toEqual(["old-uid"]);
  });

  it("does not leak a RU waiver into the current IG admission", async () => {
    const { reads, prisma } = fixture([oldCard, igCard], "ig");
    expect(
      (await reads.internalDocuments({ code_1c: "worker" })).waivedDocumentUids,
    ).toEqual([]);
    expect(prisma.candidateDocumentAbsence.findMany).not.toHaveBeenCalled();
    expect(prisma.document.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ candidate: { id: "ig" } }),
      }),
    );
  });
});
