import "reflect-metadata";
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CandidateReviewQueueQueryDto } from "../src/documents/dto/document.dto";
import { buildCandidateProfileWhere } from "../src/documents/candidate-profile";
import { DashboardQueryDto } from "../src/dashboard/dto/dashboard-response.dto";
import { AuditLogQueryDto } from "../src/audit/dto/audit-log.dto";
import { IgArrivalRegistryQueryDto } from "../src/documents/dto/ig-arrival-registry.dto";
import { candidateNamePage } from "../src/documents/candidate-name-page";

describe("multi-value query contract", () => {
  it("parses actual repeated Fastify query parameters, including a single occurrence", async () => {
    const app = Fastify();
    app.get("/", async (request) => {
      const query = plainToInstance(
        CandidateReviewQueueQueryDto,
        request.query,
      );
      expect(await validate(query)).toEqual([]);
      return query;
    });
    try {
      const response = await app.inject(
        "/?statusIds=Подбор&statusIds=Отказ&positionCodes=P1&managerKeys=id%3AM1&managerKeys=code%3AM2&hasMentorValues=true&hasMentorValues=false",
      );
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        statusIds: ["Подбор", "Отказ"],
        positionCodes: ["P1"],
        managerKeys: ["id:M1", "code:M2"],
        hasMentorValues: ["true", "false"],
      });
    } finally {
      await app.close();
    }
  });
  it("validates every value and bounds the number of selections", async () => {
    for (const input of [
      { statusIds: Array(101).fill("Подбор") },
      { candidateIds: [42] },
      { managerKeys: ["arbitrary:person"] },
      { citizenships: ["RU", "russian"] },
      { hasMentorValues: ["true", "invalid"] },
      { positionCodes: [""] },
    ]) {
      expect(
        (await validate(plainToInstance(CandidateReviewQueueQueryDto, input)))
          .length,
      ).toBeGreaterThan(0);
    }
    expect(
      await validate(
        plainToInstance(CandidateReviewQueueQueryDto, {
          candidateIds: ["c1", "c2"],
          citizenships: ["RU", "uz"],
          managerKeys: ["name:Иванов Иван", "unassigned"],
        }),
      ),
    ).toEqual([]);
    expect(
      (
        await validate(
          plainToInstance(DashboardQueryDto, {
            reviewGroups: ["RU", "forbidden"],
          }),
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(
      (
        await validate(
          plainToInstance(AuditLogQueryDto, {
            actions: ["DOCUMENT_APPROVED", "FAKE_ACTION"],
          }),
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(
      (
        await validate(
          plainToInstance(IgArrivalRegistryQueryDto, {
            requirementsActions: ["REVIEW", "FAKE_ACTION"],
          }),
        )
      ).length,
    ).toBeGreaterThan(0);
  });
  it("combines values with OR and distinct profile filters with AND, overriding scalar aliases", () => {
    const where = buildCandidateProfileWhere({
      candidateIds: ["a", "b"],
      candidateId: "legacy",
      citizenships: ["RU", "UZ"],
      positionCodes: ["P1", "P2"],
      mentorCodes1c: ["N1", "N2"],
      managerKeys: ["id:M1", "code:M2", "unassigned"],
      managerId: "legacy",
      managerCode1c: "legacy",
      managerName: "legacy",
      statusIds: ["Подбор", "Отказ"],
      hasMentorValues: ["true", "false"],
      reviewGroup: "RU",
    });
    expect(where?.AND).toEqual(
      expect.arrayContaining([
        { id: { in: ["a", "b"] } },
        { citizenship: { in: ["ru", "uz"] } },
        { positionCode: { in: ["P1", "P2"] } },
        { mentorCode1c: { in: ["N1", "N2"] } },
        { statusId: { in: ["Подбор", "Отказ"] } },
        {
          OR: expect.arrayContaining([
            { managerId: "M1" },
            { managerCode1c: "M2" },
          ]),
        },
      ]),
    );
    expect(JSON.stringify(where)).not.toContain("legacy");
    expect(JSON.stringify(where)).not.toContain("mentorName");
  });
});

describe("alphabetical candidate pages", () => {
  it("uses one alphabet across document presence, stable ids for equal names, then unnamed candidates", async () => {
    const rows = [
      { id: "a", fullName: "Анна", documents: [] },
      { id: "b", fullName: "Борис", documents: ["document"] },
      { id: "c", fullName: "Борис", documents: [] },
      { id: "d", fullName: null, documents: [] },
      { id: "e", fullName: "", documents: [] },
    ];
    const queries: unknown[] = [];
    const read: Parameters<
      typeof candidateNamePage<(typeof rows)[number]>
    >[0] = async (query) => {
      queries.push(query);
      const and = query.where.AND as Record<string, unknown>[];
      const blank = query.orderBy.length === 1;
      const after = and.find((part) => "id" in part && !("OR" in part))?.id as
        | { gt: string }
        | undefined;
      const nameBoundary = and.find(
        (part) =>
          Array.isArray(part.OR) &&
          (part.OR as Record<string, unknown>[]).some(
            (item) =>
              typeof item.fullName === "object" && item.fullName !== null,
          ),
      );
      const boundary = nameBoundary?.OR as
        | [
            { fullName: { gt: string } },
            { fullName: string; id: { gt: string } },
          ]
        | undefined;
      return rows
        .filter((row) => !row.fullName === blank)
        .filter((row) =>
          blank
            ? !after || row.id > after.gt
            : !boundary ||
              row.fullName! > boundary[0].fullName.gt ||
              (row.fullName === boundary[1].fullName &&
                row.id > boundary[1].id.gt),
        )
        .slice(0, query.take);
    };
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await candidateNamePage(
        read,
        { erpDeleted: false },
        2,
        cursor,
      );
      ids.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toEqual(["a", "b", "c", "d", "e"]);
    expect(new Set(ids).size).toBe(5);
    expect(queries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          where: expect.objectContaining({ erpDeleted: false }),
        }),
      ]),
    );
  });
  it("restarts recognized old cursors and rejects malformed new cursors", async () => {
    const read = async () => [{ id: "a", fullName: "Анна" }];
    for (const cursor of [
      "00000000-0000-0000-0000-000000000000",
      Buffer.from(JSON.stringify({ group: 1, name: "Яна", id: "z" })).toString(
        "base64url",
      ),
    ]) {
      expect(
        (await candidateNamePage(read, {}, 2, cursor)).items.map(
          (item) => item.id,
        ),
      ).toEqual(["a"]);
    }
    await expect(candidateNamePage(read, {}, 2, "garbage")).rejects.toThrow(
      "Invalid candidate cursor",
    );
  });
});

describe('aggregate and registry multi-filters', () => {
  it('applies mixed manager selectors as one SQL OR and rejects unauthorized departments', async () => {
    const { DashboardService } = await import('../src/dashboard/dashboard.service');
    const queries: { sql: string; values: unknown[] }[] = [];
    const prisma = { $queryRaw: async (query: { sql: string; values: unknown[] }) => { queries.push(query); return []; } };
    const service = new DashboardService(prisma as never);
    await service.get({ uuid: 'reviewer', accessRules: { '20009': [] } } as never, { reviewGroups: ['RU', 'IG'], managerKeys: ['id:M1', 'code:M2', 'name:Иванов Иван', 'unassigned'] });
    for (const query of queries.filter(query => !query.sql.includes('AS code1c'))) {
      expect(query.sql).toContain('c.managerId = ? OR c.managerCode1c = ?');
      expect(query.values).toEqual(expect.arrayContaining(['M1', 'M2', 'Иванов Иван']));
    }
    await expect(service.get({ accessRules: { '20002': [] } } as never, { reviewGroups: ['RU', 'IG'] })).rejects.toMatchObject({ status: 403 });
  });
  it('uses IN before grouping and versions alphabetical participation cursors with a filter fingerprint', async () => {
    const { IgArrivalRegistryService } = await import('../src/documents/ig-arrival-registry.service');
    const { vi } = await import('vitest');
    const location1 = '11111111-1111-4111-8111-111111111111';
    const location2 = '22222222-2222-4222-8222-222222222222';
    const raw = vi.fn().mockResolvedValue([]);
    const service = new IgArrivalRegistryService({ $queryRaw: raw, igArrivalSyncState: { findUnique: async () => null } } as never);
    const principal = { accessRules: { '20011': [] } } as never;
    const filters = { locationUids: [location1, location2], requirementsActions: ['REVIEW', 'MISSING'] };
    await service.groups(principal, filters);
    expect(raw.mock.calls[0][0].sql).toContain('m.locationUid IN (?,?)');
    expect(raw.mock.calls[0][0].values).toEqual(expect.arrayContaining([location1, location2, 'REVIEW', 'MISSING']));
    raw.mockResolvedValueOnce([{ personUid: 'p1', arrivalMemberUid: 'm1', fullName: 'Анна', approvedDocuments: 0n, confirmedDocuments: 0n }, { personUid: 'p2', arrivalMemberUid: 'm2', fullName: 'Борис', approvedDocuments: 0n, confirmedDocuments: 0n }]);
    const first = await service.participations(principal, { ...filters, groupKey: 'issues', limit: 1 });
    const token = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString());
    expect(token).toEqual([2, expect.any(String), ['0', 'Анна', 'm1']]);
    raw.mockResolvedValue([]);
    await service.participations(principal, { ...filters, groupKey: 'issues', limit: 1, cursor: first.nextCursor! });
    const query = raw.mock.calls.at(-1)![0];
    expect(query.sql).toContain('ORDER BY CASE WHEN COALESCE(NULLIF(TRIM(m.fullName)');
    expect(query.values).toContain('Анна');
    await expect(service.participations(principal, { groupKey: 'issues', cursor: first.nextCursor! })).rejects.toThrow('Invalid registry cursor');
  });
});
