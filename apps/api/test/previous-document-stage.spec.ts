import { describe, expect, it, vi } from "vitest";
import { DocumentReadService } from "../src/documents/document-read.service";
import type { AuthPrincipal } from "../src/auth/auth-principal";

const principal = {
  uuid: "reviewer",
  accessRules: { "20009": [] },
} as unknown as AuthPrincipal;
const catalog = {
  id: "passport",
  code: "PASSPORT",
  title: "Паспорт",
  erpUid: "passport-uid",
  stage: 1,
  requiredForAll: true,
  allRu: true,
  allForeign: true,
  positions: [],
  stageRules: [],
  catalogSyncedAt: new Date(),
};

function setup(group: "RU" | "IG", expired = false, currentStatus?: string) {
  const owner = {
    id: "cycle",
    code1c: "worker",
    personUid: "person",
    chatUuid: group === "RU" ? "chat" : null,
    citizenship: group === "RU" ? "ru" : "uz",
    positionCode: "position",
    isReemployment: true,
  };
  const previous = {
    id: "former",
    candidateId: "cycle",
    documentUid: "passport-uid",
    title: "Паспорт",
    status: "CONFIRMED",
    fields: {},
    originalAvailable: true,
    expiresAt: new Date(expired ? "2000-01-01" : "2100-01-01"),
    reviewedAt: new Date(),
  };
  const current = currentStatus
    ? [
        {
          id: "new",
          candidateId: "cycle",
          documentTypeId: "passport",
          documentType: catalog,
          status: currentStatus,
          currentVersion: 1,
          versions: [{ version: 1, revision: 0, status: currentStatus }],
        },
      ]
    : [];
  const prisma = {
    document: {
      findMany: vi.fn().mockResolvedValue(current),
      groupBy: vi
        .fn()
        .mockResolvedValue(
          current.map((doc) => ({
            candidateId: "cycle",
            documentTypeId: "passport",
            status: doc.status,
            _count: { _all: 1 },
          })),
        ),
    },
    documentType: { findMany: vi.fn().mockResolvedValue([catalog]) },
    candidatePreviousDocument: {
      findMany: vi.fn(async ({ where }: { where: { status?: string } }) =>
        where.status && expired ? [] : [previous],
      ),
    },
  };
  const access = {
    candidate: vi.fn().mockResolvedValue(owner),
    documentWhere: vi.fn().mockReturnValue({}),
  };
  return {
    reads: new DocumentReadService(
      prisma as never,
      access as never,
      null as never,
    ),
    prisma,
    access,
  };
}

describe("former documents in the current stage", () => {
  it.each(["RU", "IG"] as const)(
    "shows a reusable source and includes it in progress for %s",
    async (group) => {
      const { reads, prisma, access } = setup(group);
      const result = await reads.candidateDetails("cycle", principal, "1");
      expect(access.candidate).toHaveBeenCalledWith("cycle", principal);
      expect(prisma.candidatePreviousDocument.findMany).toHaveBeenCalledWith({
        where: { candidateId: "cycle" },
      });
      expect(result.documents).toEqual([]);
      expect(result.stageDocuments?.required.missingDocuments).toEqual([]);
      expect(result.previousDocuments).toEqual([
        expect.objectContaining({
          id: "former",
          state: "REUSED",
          category: "required",
        }),
      ]);
      expect(result.candidate.approvedDocuments).toBe(1);
      expect(result.candidate.stageProgress?.[0].required.reused).toBe(1);
      expect(
        (await reads.candidateDetails("cycle", principal, "2"))
          .previousDocuments,
      ).toEqual([]);
    },
  );
  it("shows expiry without satisfying the current requirement", async () => {
    const { reads } = setup("IG", true);
    const result = await reads.candidateDetails("cycle", principal, "1");
    expect(result.previousDocuments?.[0].state).toBe("EXPIRED");
    expect(result.stageDocuments?.required.missingDocuments).toEqual([
      { code: "PASSPORT", title: "Паспорт" },
    ]);
    expect(result.candidate.approvedDocuments).toBe(0);
  });
  it("keeps a submitted replacement visible and does not count the former source twice", async () => {
    const { reads } = setup("IG", false, "IN_REVIEW");
    const result = await reads.candidateDetails("cycle", principal, "1");
    expect(result.previousDocuments).toEqual([]);
    expect(result.documents).toHaveLength(1);
    expect(result.candidate.approvedDocuments).toBe(0);
    expect(result.candidate.stageProgress?.[0].required.pending).toBe(1);
  });
  it("does not let an unsubmitted draft hide a reusable original", async () => {
    const { reads } = setup("IG", false, "DRAFT");
    const result = await reads.candidateDetails("cycle", principal, "1");
    expect(result.previousDocuments?.[0].state).toBe("REUSED");
    expect(result.stageDocuments?.required.missingDocuments).toEqual([]);
    expect(result.candidate.approvedDocuments).toBe(1);
    expect(result.candidate.stageProgress?.[0].required.reused).toBe(1);
  });
});
