import { describe, expect, it, vi } from "vitest";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { DocumentAccessService } from "../src/documents/document-access.service";
import { DocumentReadService } from "../src/documents/document-read.service";
import { buildCandidateProfileWhere } from "../src/documents/candidate-profile";
import {
  PositionQueryDto,
  ReviewCandidatesQueryDto,
  ReviewDocumentsQueryDto,
  DocumentTypesQueryDto,
} from "../src/documents/dto/document.dto";

const access = new DocumentAccessService(null as never);
const fullAccess = {
  uuid: "reviewer",
  code_1c: null,
  sid: null,
  accessRules: { "20009": [] },
} as never;
const scoped20007 = {
  ...fullAccess,
  accessRules: { "20002": [], "20007": ["98"] },
} as never;

const readsWith = (prisma: Record<string, unknown>) =>
  new DocumentReadService(prisma as never, access, null as never);

describe("positions directory", () => {
  it("lists non-deleted positions ordered by name with default limit", async () => {
    const findMany = vi.fn(async () => [{ code1c: "P1", name: "Водитель" }]);
    const page = await readsWith({
      lkPosition: { findMany },
    } as never).positions({});
    expect(findMany).toHaveBeenCalledWith({
      where: { deleted: false },
      select: { code1c: true, name: true },
      orderBy: { name: "asc" },
      take: 50,
    });
    expect(page).toEqual({ items: [{ code: "P1", name: "Водитель" }] });
  });
  it("searches by name contains and respects the limit", async () => {
    const findMany = vi.fn(async () => []);
    await readsWith({ lkPosition: { findMany } } as never).positions({
      q: "вод",
      limit: 10,
    });
    expect(findMany).toHaveBeenCalledWith({
      where: { deleted: false, name: { contains: "вод" } },
      select: { code1c: true, name: true },
      orderBy: { name: "asc" },
      take: 10,
    });
  });
  it("validates the query DTO bounds", async () => {
    const ok = plainToInstance(PositionQueryDto, { q: "x", limit: "20" });
    expect(await validate(ok)).toEqual([]);
    expect(ok.limit).toBe(20);
    const bad = plainToInstance(PositionQueryDto, { limit: "101" });
    expect(await validate(bad)).not.toEqual([]);
  });
});

describe("reviewDocumentFacets scope", () => {
  const candidateRows = [
    {
      managerName: "Сидоров",
      managerCode1c: "M1",
      mentorName: "Наставник",
      mentorCode1c: "N9",
      projectName: "Проект Север",
      projectCode: "PRJ",
      citizenship: "ru",
    },
  ];
  const setup = (docs: { candidateId: string | null }[]) => {
    const documentFind = vi.fn(async () => docs);
    const candidateFind = vi.fn(async () => candidateRows);
    const service = readsWith({
      document: { findMany: documentFind },
      candidate: { findMany: candidateFind },
    } as never);
    return { service, documentFind, candidateFind };
  };
  it("resolves candidate ids through documentWhere (20007 leak check)", async () => {
    const { service, documentFind, candidateFind } = setup([
      { candidateId: "c1" },
      { candidateId: "c1" },
      { candidateId: null },
    ]);
    const facets = await service.reviewDocumentFacets(scoped20007);
    // The scope predicate travels into the document query: foreign-location
    // documents never contribute candidate ids.
    expect(documentFind).toHaveBeenCalledWith({
      where: {
        ...access.documentWhere(scoped20007),
        reviewGroup: "RU",
        currentVersion: { gt: 0 },
        candidateId: { not: null },
      },
      select: { candidateId: true },
      distinct: ["candidateId"],
    });
    // Only the in-scope candidate is read; its values shape the facets.
    expect(candidateFind).toHaveBeenCalledWith({
      where: { id: { in: ["c1"] } },
      select: {
        managerName: true,
        managerCode1c: true,
        mentorName: true,
        mentorCode1c: true,
        projectName: true,
        projectCode: true,
        citizenship: true,
      },
    });
    expect(facets).toEqual({
      managers: [{ name: "Сидоров", code1c: "M1" }],
      mentors: [{ name: "Наставник", code1c: "N9" }],
      projects: [{ name: "Проект Север", code: "PRJ" }],
      citizenships: ["RU"],
    });
  });
  it("returns empty facets when no scoped documents exist", async () => {
    const candidateFind = vi.fn(async () => {
      throw new Error("must not query candidates without ids");
    });
    const facets = await readsWith({
      document: { findMany: vi.fn(async () => []) },
      candidate: { findMany: candidateFind },
    } as never).reviewDocumentFacets(scoped20007);
    expect(facets).toEqual({
      managers: [],
      mentors: [],
      projects: [],
      citizenships: [],
    });
  });
  it("skips empty/NULL values and uppercases citizenships sorted", async () => {
    const candidateFind = vi.fn(async () => [
      {
        managerName: "  ",
        managerCode1c: null,
        mentorName: null,
        mentorCode1c: null,
        projectName: null,
        projectCode: null,
        citizenship: "kz",
      },
      {
        managerName: " второй ",
        managerCode1c: null,
        mentorName: "",
        mentorCode1c: "N1",
        projectName: "B",
        projectCode: null,
        citizenship: "RU",
      },
      {
        managerName: "второй",
        managerCode1c: null,
        mentorName: null,
        mentorCode1c: null,
        projectName: "A",
        projectCode: "PA",
        citizenship: "ru",
      },
    ]);
    const facets = await readsWith({
      document: { findMany: vi.fn(async () => [{ candidateId: "c1" }]) },
      candidate: { findMany: candidateFind },
    } as never).reviewDocumentFacets(fullAccess);
    expect(facets.managers).toEqual([{ name: "второй", code1c: null }]);
    expect(facets.mentors).toEqual([]);
    expect(facets.projects).toEqual([
      { name: "A", code: "PA" },
      { name: "B", code: null },
    ]);
    expect(facets.citizenships).toEqual(["KZ", "RU"]);
  });
  it("caps each group at 500 distinct candidates", async () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({
      managerName: `Менеджер ${String(i).padStart(4, "0")}`,
      managerCode1c: `M${i}`,
      mentorName: null,
      mentorCode1c: null,
      projectName: null,
      projectCode: null,
      citizenship: null,
    }));
    const facets = await readsWith({
      document: { findMany: vi.fn(async () => [{ candidateId: "c1" }]) },
      candidate: { findMany: vi.fn(async () => rows) },
    } as never).reviewDocumentFacets(fullAccess);
    expect(facets.managers).toHaveLength(500);
    expect(facets.mentors).toEqual([]);
  });
  it("deduplicates exact selector values when snapshots have different names for the same code", async () => {
    const facets = await readsWith({
      document: {
        findMany: vi.fn(async () => [
          { candidateId: "c1" },
          { candidateId: "c2" },
        ]),
      },
      candidate: {
        findMany: vi.fn(async () => [
          candidateRows[0],
          {
            ...candidateRows[0],
            managerName: "Другое имя",
            mentorName: "Новое имя",
            projectName: "Другое название",
          },
        ]),
      },
    } as never).reviewDocumentFacets(fullAccess);
    expect(facets.managers).toEqual([{ name: "Сидоров", code1c: "M1" }]);
    expect(facets.mentors).toEqual([{ name: "Наставник", code1c: "N9" }]);
    expect(facets.projects).toEqual([{ name: "Проект Север", code: "PRJ" }]);
  });
});

describe("reviewCandidates", () => {
  it("lists in-scope candidates with fullName search, sorted, default limit", async () => {
    const documentFind = vi.fn(async () => [
      { candidateId: "c1" },
      { candidateId: "c2" },
    ]);
    const candidateFind = vi.fn(async () => [
      { id: "c1", fullName: "Иван Петров" },
    ]);
    const page = await readsWith({
      document: { findMany: documentFind },
      candidate: { findMany: candidateFind },
    } as never).reviewCandidates(scoped20007, { q: "иван" });
    expect(documentFind).toHaveBeenCalledWith({
      where: {
        ...access.documentWhere(scoped20007),
        reviewGroup: "RU",
        currentVersion: { gt: 0 },
        candidateId: { not: null },
      },
      select: { candidateId: true },
      distinct: ["candidateId"],
    });
    expect(candidateFind).toHaveBeenCalledWith({
      where: { id: { in: ["c1", "c2"] }, fullName: { contains: "иван" } },
      select: { id: true, fullName: true },
      orderBy: { fullName: "asc" },
      take: 20,
    });
    expect(page).toEqual({ items: [{ id: "c1", fullName: "Иван Петров" }] });
  });
  it("validates the query DTO bounds", async () => {
    const ok = plainToInstance(ReviewCandidatesQueryDto, { limit: "50" });
    expect(await validate(ok)).toEqual([]);
    const bad = plainToInstance(ReviewCandidatesQueryDto, { limit: "51" });
    expect(await validate(bad)).not.toEqual([]);
  });
});

describe("document types catalogOnly", () => {
  it("keeps the default list behavior without the flag", async () => {
    const findMany = vi.fn(async () => []);
    await readsWith({ documentType: { findMany } } as never).types();
    expect(findMany).toHaveBeenCalledWith({
      where: undefined,
      select: { code: true, title: true },
      orderBy: { code: "asc" },
    });
  });
  it("filters to catalog types ordered by title with the flag", async () => {
    const findMany = vi.fn(async () => []);
    await readsWith({ documentType: { findMany } } as never).types(true);
    expect(findMany).toHaveBeenCalledWith({
      where: { catalogSyncedAt: { not: null } },
      select: { code: true, title: true },
      orderBy: { title: "asc" },
    });
  });
  it("coerces the catalogOnly query flag", async () => {
    const dto = plainToInstance(DocumentTypesQueryDto, { catalogOnly: "true" });
    expect(await validate(dto)).toEqual([]);
    expect(dto.catalogOnly).toBe(true);
  });
});

describe("review queue exact filters", () => {
  it("matches candidateId/managerCode1c/mentorCode1c exactly with AND", () => {
    expect(
      buildCandidateProfileWhere({
        candidateId: "c1",
        managerCode1c: "M1",
        mentorCode1c: "N9",
      }),
    ).toEqual({
      AND: [{ id: "c1" }, { managerCode1c: "M1" }, { mentorCode1c: "N9" }],
    });
  });
  it("combines exact filters with the contains ones", () => {
    expect(
      buildCandidateProfileWhere({ q: "иван", managerCode1c: "M1" }),
    ).toEqual({
      AND: [{ fullName: { contains: "иван" } }, { managerCode1c: "M1" }],
    });
  });
  it("validates exact params as non-empty bounded strings", async () => {
    const ok = plainToInstance(ReviewDocumentsQueryDto, {
      candidateId: "c1",
      managerCode1c: "M1",
      mentorCode1c: "N9",
    });
    expect(await validate(ok)).toEqual([]);
    for (const field of ["candidateId", "managerCode1c", "mentorCode1c"]) {
      const empty = plainToInstance(ReviewDocumentsQueryDto, {
        [field]: "has space",
      });
      expect(await validate(empty)).not.toEqual([]);
      const long = plainToInstance(ReviewDocumentsQueryDto, {
        [field]: "x".repeat(65),
      });
      expect(await validate(long)).not.toEqual([]);
    }
  });
  it("applies exact filters inside reviewDocuments under the scope", async () => {
    const findMany = vi.fn(async (args: { select?: unknown }) =>
      args.select ? [] : [],
    );
    await readsWith({
      document: { findMany, groupBy: vi.fn(async () => []) },
      documentType: { findMany: vi.fn(async () => []) },
    } as never).reviewDocuments(scoped20007, {
      limit: 10,
      candidateId: "c1",
      managerCode1c: "M1",
    });
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      ...access.documentWhere(scoped20007),
      reviewGroup: "RU",
      candidate: { AND: expect.arrayContaining([{ id: "c1" }]) },
    });
    const and = findMany.mock.calls[0][0].where.candidate.AND as unknown[];
    expect(and).toContainEqual({ managerCode1c: "M1" });
  });
});
