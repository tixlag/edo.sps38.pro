import { describe, expect, it, vi } from "vitest";
import { DocumentAccessService } from "../src/documents/document-access.service";
import { AuditLogsService } from "../src/audit/audit-logs.service";
import type { AuthPrincipal } from "../src/auth/auth-principal";
const user = (extra: Record<string, string[]> = {}) =>
  ({
    uuid: "mixed",
    accessRules: { "20002": [], "20005": [], "20007": ["1"], ...extra },
  }) as unknown as AuthPrincipal;
const matches = (
  row: Record<string, unknown>,
  where: Record<string, unknown>,
): boolean =>
  Object.entries(where).every(([key, value]) => {
    if (key === "AND")
      return (value as Record<string, unknown>[]).every((item) =>
        matches(row, item),
      );
    if (key === "OR")
      return (value as Record<string, unknown>[]).some((item) =>
        matches(row, item),
      );
    const actual = row[key];
    if (value === null || typeof value !== "object") return actual === value;
    const filter = value as Record<string, unknown>;
    if ("in" in filter) return (filter.in as unknown[]).includes(actual);
    if ("not" in filter) return actual !== filter.not;
    return (
      actual !== null &&
      typeof actual === "object" &&
      matches(actual as Record<string, unknown>, filter)
    );
  });
const candidate = (citizenship: string, locationId: number | null) => ({
  chatUuid: null,
  citizenship,
  locationId,
});
describe("independent audit and reviewer scope union", () => {
  it("grants RU everywhere and IG only within audit geography, for both candidates and documents", () => {
    const access = new DocumentAccessService(null as never);
    for (const [citizenship, location, allowed] of [
      ["ru", 2, true],
      ["ru", null, true],
      ["uz", 1, true],
      ["uz", 2, false],
      ["uz", null, false],
    ] as const) {
      const row = candidate(citizenship, location);
      expect(
        matches(row, access.candidateWhere(user()) as Record<string, unknown>),
        `${citizenship}/${location} candidate`,
      ).toBe(allowed);
      expect(
        matches(
          { candidateId: "c", candidate: row, employee: null },
          access.documentWhere(user()) as Record<string, unknown>,
        ),
        `${citizenship}/${location} document`,
      ).toBe(allowed);
      expect(
        matches(
          { candidateId: "c", candidate: row, employee: null },
          access.documentReviewWhere(user()) as Record<string, unknown>,
        ),
        `${citizenship}/${location} mutation`,
      ).toBe(citizenship === "ru");
    }
  });
  it("does not create other-group read rights when mixed audit has no geography grant", () => {
    const principal = user();
    delete principal.accessRules["20007"];
    const access = new DocumentAccessService(null as never);
    expect(
      matches(
        candidate("uz", 2),
        access.candidateWhere(principal) as Record<string, unknown>,
      ),
    ).toBe(false);
    expect(
      matches(
        { candidateId: "c", candidate: candidate("uz", 2), employee: null },
        access.documentWhere(principal) as Record<string, unknown>,
      ),
    ).toBe(false);
  });
  it("grants IG everywhere and RU only within audit geography for an IG reviewer", () => {
    const principal = user({ "20011": [] });
    delete principal.accessRules["20002"];
    const access = new DocumentAccessService(null as never);
    for (const [citizenship, location, allowed] of [
      ["uz", 2, true],
      ["uz", null, true],
      ["ru", 1, true],
      ["ru", 2, false],
      ["ru", null, false],
    ] as const) {
      const row = candidate(citizenship, location);
      const document = { candidateId: "c", candidate: row, employee: null };
      expect(
        matches(
          row,
          access.candidateWhere(principal) as Record<string, unknown>,
        ),
        `${citizenship}/${location} candidate`,
      ).toBe(allowed);
      expect(
        matches(
          document,
          access.documentWhere(principal) as Record<string, unknown>,
        ),
        `${citizenship}/${location} document`,
      ).toBe(allowed);
      expect(
        matches(
          document,
          access.documentReviewWhere(principal) as Record<string, unknown>,
        ),
        `${citizenship}/${location} mutation`,
      ).toBe(citizenship === "uz");
    }
  });
  it("preserves independent all-location audit reads without granting foreign-group mutations", () => {
    const access = new DocumentAccessService(null as never);
    const principal = user({ "20008": [] });
    const foreign = {
      candidateId: "c",
      candidate: candidate("uz", null),
      employee: null,
    };
    expect(
      matches(
        foreign.candidate,
        access.candidateWhere(principal) as Record<string, unknown>,
      ),
    ).toBe(true);
    expect(
      matches(
        foreign,
        access.documentWhere(principal) as Record<string, unknown>,
      ),
    ).toBe(true);
    expect(
      matches(
        foreign,
        access.documentReviewWhere(principal) as Record<string, unknown>,
      ),
    ).toBe(false);
  });
  it("preserves employee-based audit geography without widening candidate reads or mutations", () => {
    const access = new DocumentAccessService(null as never);
    const row = candidate("uz", 2);
    const document = {
      candidateId: "c",
      candidate: row,
      employee: { locationId: 1 },
    };
    expect(
      matches(row, access.candidateWhere(user()) as Record<string, unknown>),
    ).toBe(false);
    expect(
      matches(
        document,
        access.documentWhere(user()) as Record<string, unknown>,
      ),
    ).toBe(true);
    expect(
      matches(
        document,
        access.documentReviewWhere(user()) as Record<string, unknown>,
      ),
    ).toBe(false);
  });
  it("keeps global audit location-only and own audit as reviewer-group OR original audit geography", async () => {
    const $queryRaw = vi.fn(async () => []);
    const service = new AuditLogsService({ $queryRaw } as never);
    await service.list(user(), { mine: true });
    const own = $queryRaw.mock.calls[0][0] as {
      sql: string;
      values: unknown[];
    };
    expect(own.sql).toContain("citizenship");
    expect(own.sql).toContain(" OR ");
    expect(own.values).toContain(1);
    expect(own.values).toContain("mixed");
    $queryRaw.mockClear();
    await service.list(user(), {});
    const global = $queryRaw.mock.calls[0][0] as {
      sql: string;
      values: unknown[];
    };
    expect(global.values).toContain(1);
    expect(global.sql).not.toContain("citizenship = 'ru'");
  });
  it("keeps own IG history group constrained when audit has no geography", async () => {
    const principal = user({ "20011": [] });
    delete principal.accessRules["20002"];
    delete principal.accessRules["20007"];
    const $queryRaw = vi.fn(async () => []);
    await new AuditLogsService({ $queryRaw } as never).list(principal, {
      mine: true,
    });
    const own = $queryRaw.mock.calls[0][0] as {
      sql: string;
      values: unknown[];
    };
    expect(own.sql).toContain("d.candidateId IS NOT NULL");
    expect(own.sql).toContain("c.chatUuid IS NULL");
    expect(own.sql).not.toContain("`locationId` IN");
    expect(own.values).toContain("mixed");
  });
  it.each([{ "20002": [] }, { "20002": [], "20011": [] }])(
    "does not grant Employee or unknown own events through review permissions: %j",
    async (accessRules) => {
      const prisma = {
        $queryRaw: vi.fn(async () => []),
        auditLog: { findMany: vi.fn(async () => []) },
      };
      const service = new AuditLogsService(prisma as never);
      const principal = {
        uuid: "reviewer",
        accessRules,
      } as unknown as AuthPrincipal;
      await expect(
        service.list(principal, {
          mine: true,
          entityType: "Employee",
          entityId: "other-case",
        }),
      ).resolves.toEqual({ items: [], nextCursor: null });
      await expect(
        service.list(principal, { mine: true, entityType: "LkEmployee" }),
      ).resolves.toEqual({ items: [], nextCursor: null });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    },
  );
  it.each([false, true])(
    "restricts own Employee history to the independent audit geography with bothGroups=%s",
    async (bothGroups) => {
      const $queryRaw = vi.fn(async () => []);
      const service = new AuditLogsService({ $queryRaw } as never);
      await service.list(user(bothGroups ? { "20011": [] } : {}), {
        mine: true,
        entityType: "Employee",
        entityId: "case",
      });
      const own = $queryRaw.mock.calls[0][0] as {
        sql: string;
        values: unknown[];
      };
      expect(own.sql).toContain("1=0");
      expect(own.sql).toContain("`e`.`locationId` IN");
      expect(own.values).toContain(1);
      expect(own.values).toContain("mixed");
    },
  );
  it("uses document and candidate group scope for both-group reviewer own history instead of unrestricted audit rows", async () => {
    const $queryRaw = vi.fn(async () => []);
    const auditLog = { findMany: vi.fn(async () => []) };
    await new AuditLogsService({ $queryRaw, auditLog } as never).list(
      {
        uuid: "reviewer",
        accessRules: { "20002": [], "20011": [] },
      } as unknown as AuthPrincipal,
      { mine: true },
    );
    const own = $queryRaw.mock.calls[0][0] as {
      sql: string;
      values: unknown[];
    };
    expect(own.sql).toContain("EXISTS");
    expect(own.sql).toContain("'Employee' AND 1=0");
    expect(own.values).toContain("reviewer");
    expect(auditLog.findMany).not.toHaveBeenCalled();
  });
});
