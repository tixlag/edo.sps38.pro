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
    originalVerified: group === "IG",
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
  describe.each(["RU", "IG"] as const)("%s document presence", (group) => {
    describe.each(["required", "additional"] as const)(
      "%s types",
      (category) => {
        it.each([undefined, "1", "none"])(
          "keeps drafts separate from missing documents and preserves progress (stage %s)",
          async (stage) => {
            const { reads, prisma } = setup(group, false, "DRAFT");
            prisma.candidatePreviousDocument.findMany.mockResolvedValue([]);
            prisma.documentType.findMany.mockResolvedValue([
              {
                ...catalog,
                stage: stage === "none" ? null : 1,
                requiredForAll: category === "required",
                allRu: category === "required",
                allForeign: category === "required",
                positions: [
                  { code1c: "position", required: category === "required" },
                ],
              },
            ]);

            const result = await reads.candidateDetails(
              "cycle",
              principal,
              stage,
            );
            const selected =
              stage === undefined
                ? result.documentGroups
                : result.stageDocuments;
            for (const groups of [selected, ...(result.stages ?? [])]) {
              expect(groups?.[category].documents).toEqual([
                expect.objectContaining({
                  id: "new",
                  status: "DRAFT",
                  title: "Паспорт",
                }),
              ]);
              expect(groups?.[category].missingDocuments).toEqual([]);
            }
            expect(result.documents).toHaveLength(1);
            expect(result.missingDocuments).toEqual([]);
            expect(result.previousDocuments).toEqual([]);
            expect(result.candidate.approvedDocuments).toBe(0);
            expect(result.candidate.stageProgress?.[0][category]).toMatchObject(
              {
                draft: 1,
                missing: 0,
                approved: 0,
                reused: 0,
                signed: 0,
              },
            );
          },
        );
      },
    );

    it.each([undefined, "1"])(
      "uses the catalog name for a genuinely missing document (stage %s)",
      async (stage) => {
        const { reads, prisma } = setup(group);
        prisma.candidatePreviousDocument.findMany.mockResolvedValue([]);
        const result = await reads.candidateDetails("cycle", principal, stage);
        const selected =
          stage === undefined ? result.documentGroups : result.stageDocuments;
        const missing = [{ code: "PASSPORT", title: "Паспорт" }];
        for (const groups of [selected, ...(result.stages ?? [])]) {
          expect(groups?.required.documents).toEqual([]);
          expect(groups?.required.missingDocuments).toEqual(missing);
        }
        expect(result.missingDocuments).toEqual(missing);
        expect(result.candidate.approvedDocuments).toBe(0);
        expect(result.candidate.stageProgress?.[0].required).toMatchObject({
          draft: 0,
          missing: 1,
          approved: 0,
          reused: 0,
          signed: 0,
        });
      },
    );

    it.each([false, true])(
      "does not duplicate a draft alongside an ERP source (expired %s)",
      async (expired) => {
        const { reads } = setup(group, expired, "DRAFT");
        for (const stage of [undefined, "1"]) {
          const result = await reads.candidateDetails(
            "cycle",
            principal,
            stage,
          );
          const selected =
            stage === undefined ? result.documentGroups : result.stageDocuments;
          for (const groups of [selected, ...(result.stages ?? [])]) {
            expect(groups?.required.documents).toHaveLength(1);
            expect(groups?.required.documents[0].status).toBe("DRAFT");
            expect(groups?.required.missingDocuments).toEqual([]);
          }
          expect(result.previousDocuments).toEqual([
            expect.objectContaining({
              id: "former",
              source: "ERP",
              state: expired ? "EXPIRED" : "REUSED",
            }),
          ]);
          expect(result.stages?.[0].previousDocuments).toHaveLength(1);
          expect(result.missingDocuments).toEqual([]);
          expect(result.candidate.approvedDocuments).toBe(expired ? 0 : 1);
          expect(result.candidate.stageProgress?.[0].required).toMatchObject({
            draft: expired ? 1 : 0,
            missing: 0,
            approved: 0,
            reused: expired ? 0 : 1,
            signed: 0,
          });
        }
      },
    );
  });

  it("shows imported RU originals in stages before a person or employee code exists", async () => {
    const { reads, access } = setup("RU");
    access.candidate.mockResolvedValue({ id: "cycle", erpUid: "erp-candidate", code1c: null, personUid: null, chatUuid: "chat", citizenship: "ru", positionCode: "position", isReemployment: false, previousDocumentsSyncedAt: null } as never);
    const result = await reads.candidateDetails("cycle", principal, "1");
    expect(result.previousDocuments).toEqual([expect.objectContaining({ id: "former", state: "REUSED" })]);
    expect(result.stageDocuments?.required.missingDocuments).toEqual([]);
  });
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
    expect(result.previousDocuments).toHaveLength(1);
    expect(result.previousDocuments?.[0].id).toBe("former");
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
  it("uses the approved RU ERP original over an adaptation replacement and counts it once", async () => {
    const { reads } = setup("RU", false, "IN_REVIEW");
    const result = await reads.candidateDetails("cycle", principal, "1");
    expect(result.previousDocuments?.[0]).toMatchObject({ state: "REUSED", source: "ERP" });
    expect(result.candidate.approvedDocuments).toBe(1);
    expect(result.candidate.stageProgress?.[0].required).toMatchObject({ reused: 1, inReview: 0, missing: 0 });
  });

});
