import { describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { randomUUID } from "node:crypto";
import {
  candidateSnapshotSchema,
  documentMetadataSchema,
} from "../src/documents/document-contract";
import {
  buildCandidateProfileWhere,
  parseBirthDateBound,
  snapshotUpdateInput,
  toCandidateProfile,
} from "../src/documents/candidate-profile";
import { DocumentAccessService } from "../src/documents/document-access.service";
import { DocumentReadService } from "../src/documents/document-read.service";
import { DocumentUploadGrantService } from "../src/documents/document-upload-grant.service";
import { ReviewDocumentsQueryDto } from "../src/documents/dto/document.dto";

const owner = () => ({
  documentUid: randomUUID(),
  chat_uuid: randomUUID(),
  position_code_1c: "0000491",
  citizenship: "ru",
  documentFields: {},
});

describe("candidate snapshot contract", () => {
  it("normalizes the full shape with trimming and lowercased citizenship", () => {
    expect(
      candidateSnapshotSchema.parse({
        fullName: "  Иван Петров  ",
        birthDate: "1990-05-17",
        citizenship: "RU",
        position: { name: " Водитель ", code: "0000491" },
        project: { name: "Проект", code: "PRJ" },
        managerName: "Сидоров",
        managerCode1C: "M1",
        mentor: { name: "Наставник", position: "Бригадир", code1C: "N9" },
        isReemployment: true,
      }),
    ).toEqual({
      fullName: "Иван Петров",
      birthDate: "1990-05-17",
      citizenship: "ru",
      positionCode: "0000491",
      positionName: "Водитель",
      projectCode: "PRJ",
      projectName: "Проект",
      managerName: "Сидоров",
      managerCode1c: "M1",
      mentorName: "Наставник",
      mentorPosition: "Бригадир",
      mentorCode1c: "N9",
      isReemployment: true,
    });
  });
  it("accepts scalar aliases and strips unknown keys softly", () => {
    expect(
      candidateSnapshotSchema.parse({
        name: "Иван",
        position: "Водитель",
        project: "Проект X",
        manager: "Сидоров",
        managerCode1c: "M1",
        mentor: "Наставник",
        junk: "ignored",
        extra: { nested: true },
      }),
    ).toMatchObject({
      fullName: "Иван",
      positionName: "Водитель",
      positionCode: undefined,
      projectName: "Проект X",
      managerName: "Сидоров",
      managerCode1c: "M1",
      mentorName: "Наставник",
    });
  });
  it("maps every mentor code alias and turns an empty code into NULL", () => {
    for (const code of ["code1C", "code1c", "code_1c"]) {
      expect(
        candidateSnapshotSchema.parse({ mentor: { name: "Н", [code]: " N9 " } }),
      ).toMatchObject({ mentorCode1c: "N9" });
    }
    expect(
      candidateSnapshotSchema.parse({ mentor: { name: "Н", code1C: "   " } }),
    ).toMatchObject({ mentorName: "Н", mentorCode1c: null });
    expect(candidateSnapshotSchema.parse({})).toEqual({
      fullName: undefined,
      birthDate: undefined,
      citizenship: undefined,
      positionCode: undefined,
      positionName: undefined,
      projectCode: undefined,
      projectName: undefined,
      managerName: undefined,
      managerCode1c: undefined,
      mentorName: undefined,
      mentorPosition: undefined,
      mentorCode1c: undefined,
      isReemployment: undefined,
    });
  });
  it("rejects bad dates, citizenship and over-limit text", () => {
    for (const birthDate of ["17.05.1990", "1990-13-01", "1990-02-31", "x"]) {
      expect(() =>
        candidateSnapshotSchema.parse({ birthDate }),
      ).toThrow();
    }
    expect(() =>
      candidateSnapshotSchema.parse({ citizenship: "rus" }),
    ).toThrow();
    expect(() =>
      candidateSnapshotSchema.parse({ fullName: "x".repeat(513) }),
    ).toThrow();
    expect(() =>
      candidateSnapshotSchema.parse({ position: { code: "x".repeat(65) } }),
    ).toThrow();
  });
  it("parses its own normalized shape back unchanged (grant round-trip)", () => {
    const first = candidateSnapshotSchema.parse({
      fullName: "Иван Петров",
      birthDate: "1990-05-17",
      citizenship: "RU",
      position: { name: "Водитель", code: "0000491" },
      project: "Проект X",
      manager: "Сидоров",
      managerCode1C: "M1",
      mentor: { name: "Наставник", position: "Бригадир", code1C: "" },
      isReemployment: true,
    });
    expect(candidateSnapshotSchema.parse(first)).toEqual(first);
    expect(first).toMatchObject({
      positionCode: "0000491",
      projectName: "Проект X",
      managerCode1c: "M1",
      mentorCode1c: null,
    });
  });
  it("accepts both metadata keys and keeps strict() for the rest", () => {
    const parsed = documentMetadataSchema.parse({
      ...owner(),
      candidate_profile: { name: "Иван", birthDate: "1990-01-01" },
    });
    expect(parsed.candidateSnapshot?.fullName).toBe("Иван");
    expect(parsed.candidateSnapshot?.birthDate).toBe("1990-01-01");
    expect(
      (parsed as Record<string, unknown>).candidate_profile,
    ).toBeUndefined();
    const preferred = documentMetadataSchema.parse({
      ...owner(),
      candidateSnapshot: { fullName: "Пётр" },
      candidate_profile: { fullName: "Иван" },
    });
    expect(preferred.candidateSnapshot?.fullName).toBe("Пётр");
    expect(() =>
      documentMetadataSchema.parse({
        ...owner(),
        candidateSnapshot: { birthDate: "1990-02-31" },
      }),
    ).toThrow();
    expect(() =>
      documentMetadataSchema.parse({ ...owner(), unknownTop: 1 }),
    ).toThrow();
  });
});

describe("snapshot persistence mapping", () => {
  it("updates only arrived fields and never touches stored data otherwise", () => {
    expect(snapshotUpdateInput(undefined)).toBeNull();
    expect(snapshotUpdateInput(null)).toBeNull();
    expect(snapshotUpdateInput({})).toBeNull();
    const update = snapshotUpdateInput({
      fullName: "Иван",
      mentorCode1c: null,
    })!;
    expect(update.fullName).toBe("Иван");
    expect(update.mentorCode1c).toBeNull();
    expect(update.birthDate).toBeUndefined();
    expect(update.positionCode).toBeUndefined();
    expect(update.profileSyncedAt).toBeInstanceOf(Date);
  });
  it("parses birthDate as UTC midnight for DATE columns", () => {
    const update = snapshotUpdateInput({ birthDate: "1990-05-17" })!;
    expect(update.birthDate).toEqual(new Date("1990-05-17T00:00:00.000Z"));
    expect(() =>
      snapshotUpdateInput({ birthDate: "1990-02-31" }),
    ).toThrow("birthDate");
    expect(() => parseBirthDateBound("2020-13-01", "birthDateFrom")).toThrow(
      "birthDateFrom",
    );
  });
  it("serializes the profile row with date-only birthDate", () => {
    expect(toCandidateProfile(null)).toBeNull();
    expect(
      toCandidateProfile({
        id: "c1",
        chatUuid: "chat",
        code1c: null,
        fullName: "Иван",
        birthDate: new Date("1990-05-17T00:00:00.000Z"),
        citizenship: "ru",
        positionCode: "0000491",
        positionName: "Водитель",
        projectCode: null,
        projectName: null,
        managerName: null,
        managerCode1c: null,
        mentorName: null,
        mentorPosition: null,
        mentorCode1c: null,
        isReemployment: false,
        profileSyncedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ).toEqual({
      id: "c1",
      chatUuid: "chat",
      code1c: null,
      fullName: "Иван",
      birthDate: "1990-05-17",
      citizenship: "ru",
      positionCode: "0000491",
      positionName: "Водитель",
      projectCode: null,
      projectName: null,
      managerName: null,
      managerCode1c: null,
      mentorName: null,
      mentorPosition: null,
      mentorCode1c: null,
      isReemployment: false,
      profileSyncedAt: "2026-01-01T00:00:00.000Z",
    });
  });
});

describe("review queue profile filters", () => {
  it("builds no candidate filter without profile params", () => {
    expect(buildCandidateProfileWhere({})).toBeUndefined();
    expect(
      buildCandidateProfileWhere({ q: "   ", citizenship: "" }),
    ).toBeUndefined();
  });
  it("combines every filter with AND", () => {
    expect(
      buildCandidateProfileWhere({
        q: "иван",
        citizenship: "RU",
        manager: "Сид",
        mentor: "Нас",
        hasMentor: true,
        birthDateFrom: "1990-01-01",
        birthDateTo: "1990-12-31",
        positionCode: "0000491",
        projectCode: "PRJ",
      }),
    ).toEqual({
      AND: [
        { fullName: { contains: "иван" } },
        { citizenship: "ru" },
        {
          OR: [
            { managerName: { contains: "Сид" } },
            { managerCode1c: { contains: "Сид" } },
          ],
        },
        {
          OR: [
            { mentorName: { contains: "Нас" } },
            { mentorCode1c: { contains: "Нас" } },
          ],
        },
        {
          OR: [{ mentorName: { not: null } }, { mentorCode1c: { not: null } }],
        },
        {
          birthDate: {
            gte: new Date("1990-01-01T00:00:00.000Z"),
            lte: new Date("1990-12-31T00:00:00.000Z"),
          },
        },
        { positionCode: "0000491" },
        { projectCode: "PRJ" },
      ],
    });
  });
  it("expresses missing mentor as two NULL columns", () => {
    expect(buildCandidateProfileWhere({ hasMentor: false })).toEqual({
      mentorName: null,
      mentorCode1c: null,
    });
  });
});

describe("upload grant with candidate snapshot", () => {
  const grants = () =>
    new DocumentUploadGrantService(
      new ConfigService({
        EDO_LK_INTERNAL_TOKEN: "test-service-token",
        EDO_PUBLIC_API_URL: "https://edo.example/api",
      }),
    );
  const base = {
    documentUid: randomUUID(),
    chat_uuid: randomUUID(),
    position_code_1c: "0000491",
    citizenship: "ru",
    idempotencyKey: "bundle-key",
  };
  it("embeds the normalized snapshot into the grant context", () => {
    const grant = grants().grant({
      ...base,
      candidateSnapshot: {
        fullName: "  Иван Петров ",
        birthDate: "1990-05-17",
        citizenship: "RU",
        position: { name: "Водитель", code: "0000491" },
        mentor: { name: "Наставник", code1C: "" },
        isReemployment: true,
      },
    });
    expect(grants().verify(grant.token).context.candidateSnapshot).toEqual({
      fullName: "Иван Петров",
      birthDate: "1990-05-17",
      citizenship: "ru",
      positionCode: "0000491",
      positionName: "Водитель",
      projectCode: undefined,
      projectName: undefined,
      managerName: undefined,
      managerCode1c: undefined,
      mentorName: "Наставник",
      mentorPosition: undefined,
      mentorCode1c: null,
      isReemployment: true,
    });
  });
  it("accepts the legacy key and ignores unknown snapshot fields", () => {
    const grant = grants().grant({
      ...base,
      candidate_profile: { name: "Иван", unknownField: "x" } as never,
    });
    const snapshot = grants().verify(grant.token).context.candidateSnapshot;
    expect(snapshot?.fullName).toBe("Иван");
    expect(
      (snapshot as Record<string, unknown> | undefined)?.unknownField,
    ).toBeUndefined();
  });
  it("rejects an invalid snapshot without minting a grant", () => {
    expect(() =>
      grants().grant({
        ...base,
        candidateSnapshot: { birthDate: "1990-02-31" },
      }),
    ).toThrow("Invalid document upload context");
  });
});

describe("reviewDocuments with profile filters", () => {
  const access = new DocumentAccessService(null as never);
  const fullAccess = {
    uuid: "reviewer",
    code_1c: null,
    sid: null,
    accessRules: { "20009": [] },
  } as never;
  const row = {
    id: "d1",
    status: "IN_REVIEW",
    currentVersion: 1,
    documentType: { code: "PASSPORT", title: "Паспорт", erpUid: "u1" },
    candidate: {
      id: "c1",
      chatUuid: "chat",
      code1c: null,
      fullName: "Иван Петров",
      birthDate: new Date("1990-05-17T00:00:00.000Z"),
      citizenship: "ru",
      positionCode: "0000491",
      positionName: "Водитель",
      projectCode: null,
      projectName: null,
      managerName: "Сидоров",
      managerCode1c: null,
      mentorName: null,
      mentorPosition: null,
      mentorCode1c: null,
      isReemployment: false,
      profileSyncedAt: null,
    },
    versions: [{ version: 1, revision: 0, delivery: null }],
  };
  const readsWith = (findMany: ReturnType<typeof vi.fn>) =>
    new DocumentReadService(
      { document: { findMany } } as never,
      access,
      null as never,
    );
  it("applies profile filters AND the access scope and returns the profile", async () => {
    let calls = 0;
    const findMany = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? [{ id: "d1" }] : [row];
    });
    const page = await readsWith(findMany).reviewDocuments(fullAccess, {
      limit: 10,
      q: "иван",
      documentTypeCode: "PASSPORT",
      citizenship: "RU",
      hasMentor: false,
      birthDateFrom: "1990-01-01",
      birthDateTo: "1990-12-31",
      positionCode: "0000491",
    });
    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: {
        status: "IN_REVIEW",
        currentVersion: { gt: 0 },
        documentType: { code: "PASSPORT" },
        candidate: {
          AND: expect.arrayContaining([
            { fullName: { contains: "иван" } },
            { citizenship: "ru" },
            { mentorName: null, mentorCode1c: null },
            { positionCode: "0000491" },
          ]),
        },
      },
      take: 11,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].candidate).toMatchObject({
      fullName: "Иван Петров",
      birthDate: "1990-05-17",
      citizenship: "ru",
      positionCode: "0000491",
    });
    expect(page.nextCursor).toBeNull();
  });
  it("keeps the 20007 location scope under profile filters", async () => {
    const findMany = vi.fn(async (args: { select?: unknown }) =>
      args.select ? [{ id: "d1" }] : [row],
    );
    const scoped = { ...fullAccess, accessRules: { "20007": ["98"] } } as never;
    await readsWith(findMany).reviewDocuments(scoped, {
      limit: 50,
      manager: "Сид",
    });
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      OR: expect.any(Array),
      candidate: {
        OR: [
          { managerName: { contains: "Сид" } },
          { managerCode1c: { contains: "Сид" } },
        ],
      },
    });
  });
});

describe("ReviewDocumentsQueryDto validation", () => {
  it("coerces hasMentor and accepts real dates", async () => {
    const dto = plainToInstance(ReviewDocumentsQueryDto, {
      hasMentor: "true",
      birthDateFrom: "1990-01-01",
      q: "Иван",
    });
    expect(await validate(dto)).toEqual([]);
    expect(dto.hasMentor).toBe(true);
    const falsy = plainToInstance(ReviewDocumentsQueryDto, {
      hasMentor: "false",
    });
    expect(await validate(falsy)).toEqual([]);
    expect(falsy.hasMentor).toBe(false);
  });
  it("rejects impossible dates and non-boolean flags", async () => {
    const dto = plainToInstance(ReviewDocumentsQueryDto, {
      birthDateFrom: "1990-02-31",
      hasMentor: "yes",
    });
    const errors = await validate(dto);
    // Regex accepts the shape, the service rejects the impossible calendar date;
    // the flag must be a real boolean after coercion.
    expect(errors.map((e) => e.property)).toContain("hasMentor");
  });
});
