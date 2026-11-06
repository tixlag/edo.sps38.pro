import { describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { DocumentReadService } from "../src/documents/document-read.service";
import { DocumentAccessService } from "../src/documents/document-access.service";
import { CandidateReviewQueueQueryDto } from "../src/documents/dto/document.dto";
import type { AuthPrincipal } from "../src/auth/auth-principal";

const principal: AuthPrincipal = {
  uuid: "reviewer",
  code1c: null,
  deviceId: null,
  expiresAt: null,
  sid: null,
  accessRules: { "20009": [] },
};
const owner = (id: string) => ({
  id,
  identityKey: `chat:${id}`,
  chatUuid: id,
  locationId: 98,
  code1c: null,
  fullName: "Иван Петров",
  birthDate: null,
  citizenship: "ru",
  positionCode: "POS1",
  positionName: "Водитель",
  projectCode: null,
  projectName: null,
  managerName: null,
  managerCode1c: null,
  mentorName: null,
  mentorPosition: null,
  mentorCode1c: null,
  isReemployment: false,
  profileSyncedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});
const document = (id: string) => ({
  id,
  status: "IN_REVIEW",
  currentVersion: 2,
  documentType: { code: "PASSPORT", title: "Паспорт", erpUid: "passport" },
  versions: [
    { version: 1, revision: 3, delivery: { status: "REQUIRES_MANUAL" } },
    { version: 2, revision: 4, delivery: null },
  ],
});
function setup() {
  const prisma = {
    candidate: { findMany: vi.fn(), findFirst: vi.fn() },
    document: {
      findMany: vi.fn(),
      groupBy: vi.fn().mockResolvedValue([
        {
          candidateId: "c1",
          documentTypeId: "passport",
          status: "APPROVED",
          _count: { _all: 1 },
        },
      ]),
    },
    documentType: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "passport",
          code: "PASSPORT",
          allRu: false,
          allForeign: false,
          positions: [{ code1c: "POS1" }],
        },
      ]),
    },
  };
  const access = new DocumentAccessService(prisma as never);
  const reads = new DocumentReadService(prisma as never, access, null as never);
  return { prisma, reads, access };
}

describe("candidate review queue", () => {
  it("includes newly admitted IG candidates before their first upload", async () => {
    const { reads, prisma } = setup();
    prisma.candidate.findMany.mockResolvedValue([
      { ...owner("ig1"), chatUuid: null, citizenship: "uz", documents: [] },
    ]);
    const result = await reads.candidateReviewQueue(principal, {
      status: "IN_REVIEW",
      reviewGroup: "IG",
    });
    expect(result.items.map((item) => item.candidate.id)).toEqual(["ig1"]);
    expect(prisma.candidate.findMany.mock.calls[0][0].where.AND).toContainEqual(
      expect.objectContaining({
        OR: expect.arrayContaining([
          expect.objectContaining({
            igEmploymentState: { isNot: null },
            OR: [{ igCompletedAt: null }, { igCompletionVerified: false }],
          }),
        ]),
      }),
    );
  });
  it("offers IG candidates without uploads in the name filter", async () => {
    const { reads, prisma } = setup();
    prisma.document.findMany.mockResolvedValue([]);
    prisma.candidate.findMany.mockResolvedValue([
      { id: "ig1", fullName: "Петров" },
    ]);
    const result = await reads.reviewCandidates(principal, {
      reviewGroup: "IG",
    });
    expect(result.items).toEqual([{ id: "ig1", fullName: "Петров" }]);
    expect(prisma.candidate.findMany).toHaveBeenCalled();
  });
  it("includes candidates with and without uploaded documents in separate ordered groups", async () => {
    const { reads, prisma } = setup();
    prisma.candidate.findMany
      .mockResolvedValueOnce([{ ...owner("c1"), documents: [document("d1")] }])
      .mockResolvedValueOnce([{ ...owner("c2"), documents: [] }]);
    const result = await reads.candidateReviewQueue(principal, {
      status: "ALL",
      reviewGroup: "RU",
      limit: 10,
    });
    expect(result.items.map((item) => item.candidate.id)).toEqual(["c1", "c2"]);
    expect(prisma.candidate.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.candidate.findMany.mock.calls[0][0].orderBy).toEqual([
      { fullName: "asc" },
      { id: "asc" },
    ]);
    expect(prisma.candidate.findMany.mock.calls[1][0].where.AND).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documents: expect.objectContaining({ none: expect.anything() }),
        }),
      ]),
    );
  });
  it("continues into the next group without repeating the previous candidate", async () => {
    const { reads, prisma } = setup();
    const first = {
      ...owner("c1"),
      fullName: "Анна",
      documents: [document("d1")],
    };
    const second = { ...owner("c2"), fullName: "Борис", documents: [] };
    prisma.candidate.findMany
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([second]);
    const page1 = await reads.candidateReviewQueue(principal, {
      status: "ALL",
      reviewGroup: "RU",
      limit: 1,
    });
    expect(page1.items.map((row) => row.candidate.id)).toEqual(["c1"]);
    expect(page1.nextCursor).toBeTruthy();
    prisma.candidate.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([second]);
    const page2 = await reads.candidateReviewQueue(principal, {
      status: "ALL",
      reviewGroup: "RU",
      limit: 1,
      cursor: page1.nextCursor!,
    });
    expect(page2.items.map((row) => row.candidate.id)).toEqual(["c2"]);
    expect(page2.nextCursor).toBeNull();
  });
  it("filters local creation dates using inclusive Irkutsk calendar days", async () => {
    const { reads, prisma } = setup();
    prisma.candidate.findMany.mockResolvedValue([]);
    await reads.candidateReviewQueue(principal, {
      status: "ALL",
      reviewGroup: "RU",
      createdFrom: "2026-01-01",
      createdTo: "2026-01-01",
    });
    expect(prisma.candidate.findMany.mock.calls[0][0].where.AND).toEqual(
      expect.arrayContaining([
        {
          createdAt: {
            gte: new Date("2025-12-31T16:00:00Z"),
            lt: new Date("2026-01-01T16:00:00Z"),
          },
        },
      ]),
    );
    await expect(
      reads.candidateReviewQueue(principal, {
        status: "ALL",
        createdFrom: "2026-02-30",
      }),
    ).rejects.toThrow();
    await expect(
      reads.candidateReviewQueue(principal, {
        status: "ALL",
        createdFrom: "2026-02-01",
        createdTo: "2026-01-01",
      }),
    ).rejects.toThrow();
  });
  it("requires a matching uploaded document when filtering all candidates by document type", async () => {
    const { reads, prisma } = setup();
    prisma.candidate.findMany.mockResolvedValue([]);
    await reads.candidateReviewQueue(principal, {
      status: "ALL",
      reviewGroup: "RU",
      documentTypeCode: "PASSPORT",
    });
    expect(prisma.candidate.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.candidate.findMany.mock.calls[0][0].where.AND).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documents: {
            some: expect.objectContaining({
              documentType: { code: "PASSPORT" },
            }),
          },
        }),
      ]),
    );
  });
  it("starts a catalog refresh without blocking the queue", async () => {
    const { prisma, access } = setup();
    prisma.candidate.findMany.mockResolvedValue([
      { ...owner("c1"), documents: [document("d1")] },
    ]);
    const ensure = vi.fn(() => new Promise<void>(() => {}));
    const reads = new DocumentReadService(
      prisma as never,
      access,
      null as never,
      undefined,
      { ensure } as never,
    );
    const result = await reads.candidateReviewQueue(principal);
    expect(result.items).toHaveLength(1);
    expect(ensure).toHaveBeenCalledOnce();
  });
  it("pages candidates and keeps a large document set together without repeating the profile", async () => {
    const { reads, prisma } = setup();
    const first = {
      ...owner("c1"),
      documents: Array.from({ length: 80 }, (_, i) => document(`d${i}`)),
    };
    const second = { ...owner("c2"), documents: [document("next")] };
    prisma.candidate.findMany
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([second]);
    const page1 = await reads.candidateReviewQueue(principal, { limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0].documents).toHaveLength(80);
    expect(page1.nextCursor).toBe("c1");
    expect(page1.items[0].candidate.approvedDocuments).toBe(1);
    expect(page1.items[0].candidate.requiredDocuments).toBe(1);
    expect(page1.items[0].documents[0]).toEqual({
      id: "d0",
      status: "IN_REVIEW",
      documentTypeCode: "PASSPORT",
      title: "Паспорт",
      documentUid: "passport",
      currentVersion: 2,
      revision: 4,
      deliveryStatus: null,
      pendingDeliveryVersions: [1],
      submittedAt: null,
      reviewedAt: null,
      reviewedBy: null,
      ocrStatus: null,
      ocrErrorCode: null,
    });
    const page2 = await reads.candidateReviewQueue(principal, {
      limit: 1,
      cursor: page1.nextCursor!,
    });
    expect(page2.items.map((item) => item.candidate.id)).toEqual(["c2"]);
    expect(page2.nextCursor).toBeNull();
    expect(prisma.candidate.findMany.mock.calls[1][0]).toMatchObject({
      where: { AND: expect.arrayContaining([{ id: { gt: "c1" } }]) },
      orderBy: { id: "asc" },
      take: 2,
    });
    expect(
      prisma.candidate.findMany.mock.calls[0][0].include.documents,
    ).not.toHaveProperty("take");
    expect(prisma.document.groupBy).toHaveBeenCalledTimes(2);
  });

  it("applies candidate location and profile filters AND the same scoped document predicate inside each group", async () => {
    const { reads, prisma, access } = setup();
    prisma.candidate.findMany.mockResolvedValue([]);
    const scoped = {
      ...principal,
      accessRules: { "20002": [], "20007": ["98"] },
    };
    await reads.candidateReviewQueue(scoped, {
      status: "RETURNED",
      documentTypeCode: "PASSPORT",
      q: "иван",
      citizenship: "RU",
      candidateId: "c1",
      managerCode1c: "M1",
      mentorCode1c: "N1",
      positionCode: "POS1",
      projectCode: "PRJ1",
    });
    const args = prisma.candidate.findMany.mock.calls[0][0];
    const nested = args.include.documents.where;
    expect(args.where.AND).toContainEqual(access.candidateWhere(scoped));
    expect(args.where.AND).toContainEqual({ documents: { some: nested } });
    expect(args.where.AND[1].AND).toEqual(
      expect.arrayContaining([
        { id: "c1" },
        { fullName: { contains: "иван" } },
        { citizenship: "ru" },
        { managerCode1c: "M1" },
        { mentorCode1c: "N1" },
        { positionCode: "POS1" },
        { projectCode: "PRJ1" },
      ]),
    );
    expect(nested).toEqual({
      ...access.documentWhere(scoped),
      candidate: { OR: [{ chatUuid: { not: null } }, { citizenship: "ru" }] },
      currentVersion: { gt: 0 },
      versions: { some: { status: "RETURNED" } },
      documentType: { code: "PASSPORT" },
    });
    expect(prisma.document.groupBy).not.toHaveBeenCalled();
  });

  it.each([undefined, "IN_REVIEW", "RETURNED", "ERP_PENDING", "ALL"])(
    "keeps progress global while selecting nested documents for status %s",
    async (status) => {
      const { reads, prisma } = setup();
      prisma.candidate.findMany.mockResolvedValue([
        { ...owner("c1"), documents: [document("d1")] },
      ]);
      const page = await reads.candidateReviewQueue(principal, { status });
      expect(page.items[0].candidate.approvedDocuments).toBe(1);
      const where =
        prisma.candidate.findMany.mock.calls[0][0].include.documents.where;
      if (status === "ALL") expect(where).not.toHaveProperty("status");
      else if (status === "ERP_PENDING")
        expect(where.versions.some.delivery.status.in).toEqual([
          "REQUIRES_MANUAL",
          "WAITING_CONTRACT",
        ]);
      else if (status === "RETURNED") {
        expect(where.versions.some.status).toBe("RETURNED");
        expect(where).not.toHaveProperty("status");
      } else expect(where.status).toBe(status ?? "IN_REVIEW");
      expect(prisma.document.groupBy.mock.calls[0][0].where).toEqual({
        candidateId: { in: ["c1"] },
      });
    },
  );

  it.each(["IN_REVIEW", "APPROVED"])(
    "keeps historical returns after the current document becomes %s",
    async (status) => {
      const { reads, prisma } = setup();
      const doc = {
        ...document("d1"),
        status,
        currentVersion: 3,
        versions: [
          {
            version: 1,
            revision: 1,
            status: "RETURNED",
            rejectionReason: "Размытое фото",
            delivery: null,
          },
          {
            version: 2,
            revision: 1,
            status: "RETURNED",
            rejectionReason: "Обрезан край",
            delivery: null,
          },
          {
            version: 3,
            revision: 0,
            status,
            rejectionReason: null,
            delivery: null,
          },
        ],
      };
      prisma.candidate.findMany.mockResolvedValue([
        { ...owner("c1"), documents: [doc] },
      ]);
      const page = await reads.candidateReviewQueue(principal, {
        status: "RETURNED",
      });
      expect(page.items[0].documents[0]).toMatchObject({
        currentVersion: 3,
        status,
        returnedVersions: [
          {
            version: 2,
            rejectionReason: "Обрезан край",
            supersededByVersion: 3,
          },
          {
            version: 1,
            rejectionReason: "Размытое фото",
            supersededByVersion: 3,
          },
        ],
      });
      const where =
        prisma.candidate.findMany.mock.calls[0][0].include.documents.where;
      expect(where.versions.some.status).toBe("RETURNED");
      expect(where).not.toHaveProperty("status");
      prisma.candidate.findFirst.mockResolvedValue(owner("c1"));
      prisma.document.findMany.mockResolvedValue([doc]);
      const details = await reads.candidateDetails("c1", principal);
      expect(details.documents[0].returnedVersions).toEqual(
        page.items[0].documents[0].returnedVersions,
      );
    },
  );

  it("distinguishes a current return from a superseded version", async () => {
    const { reads, prisma } = setup();
    prisma.candidate.findMany.mockResolvedValue([
      {
        ...owner("c1"),
        documents: [
          {
            ...document("d1"),
            status: "RETURNED",
            versions: [
              {
                version: 1,
                revision: 1,
                status: "RETURNED",
                rejectionReason: "Фото",
                delivery: null,
              },
              {
                version: 2,
                revision: 1,
                status: "RETURNED",
                rejectionReason: "Поля",
                delivery: null,
              },
            ],
          },
        ],
      },
    ]);
    const page = await reads.candidateReviewQueue(principal, {
      status: "RETURNED",
    });
    expect(page.items[0].documents[0].returnedVersions).toEqual([
      {
        version: 2,
        rejectionReason: "Поля",
        supersededByVersion: null,
        submittedAt: null,
        reviewedAt: null,
        reviewedBy: null,
      },
      {
        version: 1,
        rejectionReason: "Фото",
        supersededByVersion: 2,
        submittedAt: null,
        reviewedAt: null,
        reviewedBy: null,
      },
    ]);
  });

  it("fails closed for callers with no location scope", async () => {
    const { reads, prisma, access } = setup();
    prisma.candidate.findMany.mockResolvedValue([]);
    expect(
      await reads.candidateReviewQueue({
        ...principal,
        accessRules: { "20002": [] },
      }),
    ).toEqual({ items: [], nextCursor: null });
    expect(prisma.candidate.findMany.mock.calls[0][0].where.AND).toContainEqual(
      access.candidateWhere({ ...principal, accessRules: { "20002": [] } }),
    );
  });

  it("inherits limit, status and date validation for the candidate query", async () => {
    const valid = plainToInstance(CandidateReviewQueueQueryDto, {
      limit: "1",
      hasMentor: "false",
    });
    expect(await validate(valid)).toEqual([]);
    expect(valid.limit).toBe(1);
    expect(valid.hasMentor).toBe(false);
    const errors = await validate(
      plainToInstance(CandidateReviewQueueQueryDto, {
        limit: 101,
        status: "INVALID",
      }),
    );
    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(["limit", "status"]),
    );
    const { reads } = setup();
    await expect(
      reads.candidateReviewQueue(principal, { birthDateFrom: "1990-02-31" }),
    ).rejects.toThrow();
  });
});

describe("candidate details", () => {
  it("returns the selected stage in required and additional groups, including missing types", async () => {
    const { reads, prisma } = setup();
    prisma.candidate.findFirst.mockResolvedValue(owner("c1"));
    prisma.document.findMany.mockResolvedValue([
      { ...document("d1"), documentTypeId: "a" },
    ]);
    const types = [
      {
        id: "a",
        code: "A",
        title: "Паспорт",
        stage: 1,
        requiredForAll: true,
        allRu: false,
        allForeign: false,
        positions: [],
        stageRules: [
          {
            stage: 1,
            requiredForAll: true,
            allRu: false,
            allForeign: false,
            positions: [],
          },
        ],
        catalogSyncedAt: new Date(),
      },
      {
        id: "b",
        code: "B",
        title: "Справка",
        stage: 1,
        requiredForAll: false,
        allRu: false,
        allForeign: false,
        positions: [],
        stageRules: [
          {
            stage: 1,
            requiredForAll: false,
            allRu: false,
            allForeign: false,
            positions: [],
          },
          {
            stage: 2,
            requiredForAll: true,
            allRu: false,
            allForeign: false,
            positions: [],
          },
        ],
        catalogSyncedAt: new Date(),
      },
      {
        id: "c",
        code: "C",
        title: "Другой этап",
        stage: 2,
        requiredForAll: true,
        allRu: false,
        allForeign: false,
        positions: [],
        stageRules: [],
        catalogSyncedAt: new Date(),
      },
    ];
    types.push({
      id: "d",
      code: "D",
      title: "Дополнительная справка",
      stage: 3,
      requiredForAll: false,
      allRu: false,
      allForeign: false,
      positions: [],
      stageRules: [
        {
          stage: 3,
          requiredForAll: false,
          allRu: false,
          allForeign: false,
          positions: [],
        },
        {
          stage: 4,
          requiredForAll: false,
          allRu: false,
          allForeign: false,
          positions: [],
        },
      ],
      catalogSyncedAt: new Date(),
    });
    prisma.documentType.findMany.mockResolvedValue(types);
    const result = await reads.candidateDetails("c1", principal, "1");
    expect(
      result.stageDocuments?.required.documents.map((doc) => doc.id),
    ).toEqual(["d1"]);
    expect(result.stageDocuments?.additional.missingDocuments).toEqual([]);
    expect(result.stageDocuments?.required.missingDocuments).toEqual([]);
    prisma.document.findMany.mockResolvedValue([
      { ...document("d1"), documentTypeId: "a" },
      { ...document("d2"), documentTypeId: "b" },
      { ...document("d3"), documentTypeId: "unknown" },
    ]);
    const all = await reads.candidateDetails("c1", principal);
    expect(all.documentGroups?.required.documents.map((doc) => doc.id)).toEqual(
      ["d1", "d2"],
    );
    expect(
      all.documentGroups?.additional.documents.map((doc) => doc.id),
    ).toEqual(["d3"]);
    expect(
      all.documentGroups?.required.missingDocuments.map((doc) => doc.code),
    ).toEqual(["C"]);
    expect(all.documentGroups?.additional.missingDocuments).toEqual([]);
    prisma.document.findMany.mockResolvedValue([
      { ...document("d1"), documentTypeId: "a" },
    ]);
    const other = await reads.candidateDetails("c1", principal, "2");
    expect(
      other.stageDocuments?.required.missingDocuments.map((d) => d.code),
    ).toEqual(["B", "C"]);
  });
  it("shows project rules even when the candidate position is unknown", async () => {
    const { reads, prisma } = setup();
    prisma.candidate.findFirst.mockResolvedValue({
      ...owner("c1"),
      positionCode: null,
      projectCode: "P1",
    });
    prisma.document.findMany.mockResolvedValue([]);
    prisma.documentType.findMany.mockResolvedValue([
      {
        id: "a",
        code: "A",
        title: "Документ",
        stage: 2,
        requiredForAll: false,
        allRu: false,
        allForeign: false,
        positions: [],
        stageRules: [
          {
            stage: 2,
            requiredForAll: false,
            allRu: false,
            allForeign: false,
            positions: [],
            projects: [{ code1c: "P1" }],
            countries: [],
          },
        ],
        catalogSyncedAt: new Date(),
      },
    ]);
    const result = await reads.candidateDetails("c1", principal, "2");
    expect(result.stageDocuments?.required.missingDocuments).toEqual([
      { code: "A", title: "Документ" },
    ]);
  });
  it("keeps returned history of a draft and applies rules to unstaged types", async () => {
    const { reads, prisma } = setup();
    prisma.candidate.findFirst.mockResolvedValue(owner("c1"));
    prisma.document.findMany.mockResolvedValue([
      {
        ...document("d1"),
        documentTypeId: "a",
        status: "DRAFT",
        versions: [
          {
            version: 1,
            revision: 1,
            status: "RETURNED",
            rejectionReason: "Фото",
            delivery: null,
          },
        ],
      },
    ]);
    prisma.documentType.findMany.mockResolvedValue([
      {
        id: "a",
        code: "A",
        title: "Документ",
        stage: null,
        requiredForAll: true,
        allRu: true,
        allForeign: true,
        positions: [],
        stageRules: [
          {
            stage: null,
            requiredForAll: true,
            allRu: true,
            allForeign: true,
            positions: [],
          },
        ],
        catalogSyncedAt: new Date(),
      },
    ]);
    const result = await reads.candidateDetails("c1", principal, "none");
    expect(result.stageDocuments?.additional.documents).toEqual([]);
    expect(
      result.stageDocuments?.required.documents[0].returnedVersions?.[0]
        .rejectionReason,
    ).toBe("Фото");
    expect(result.stageDocuments?.required.missingDocuments).toEqual([
      { code: "A", title: "Документ" },
    ]);
  });
  it("returns the profile even when there are no documents", async () => {
    const { reads, prisma } = setup();
    prisma.candidate.findFirst.mockResolvedValue(owner("c1"));
    prisma.document.findMany.mockResolvedValue([]);
    const result = await reads.candidateDetails("c1", principal);
    expect(result).toMatchObject({
      candidate: { id: "c1", fullName: "Иван Петров", approvedDocuments: 1 },
      documents: [],
    });
  });

  it("returns all live documents with scope checks and rejects an inaccessible candidate", async () => {
    const { reads, prisma, access } = setup();
    const scoped = {
      ...principal,
      accessRules: { "20002": [], "20007": ["98"] },
    };
    prisma.candidate.findFirst
      .mockResolvedValueOnce(owner("c1"))
      .mockResolvedValueOnce(null);
    prisma.document.findMany.mockResolvedValue([document("d1")]);
    expect((await reads.candidateDetails("c1", scoped)).documents).toHaveLength(
      1,
    );
    expect(prisma.candidate.findFirst.mock.calls[0][0].where).toEqual({
      id: "c1",
      ...access.candidateWhere(scoped),
    });
    expect(prisma.document.findMany.mock.calls[0][0].where).toEqual({
      candidateId: "c1",
      currentVersion: { gt: 0 },
      ...access.documentWhere(scoped),
    });
    await expect(
      reads.candidateDetails("denied", scoped),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.document.findMany).toHaveBeenCalledTimes(1);
  });
});
