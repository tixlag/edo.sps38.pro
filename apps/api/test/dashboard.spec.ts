import { describe, expect, it, vi } from "vitest";
import { DashboardService } from "../src/dashboard/dashboard.service";
import type { AuthPrincipal } from "../src/auth/auth-principal";
const user = (accessRules: Record<string, string[]>): AuthPrincipal =>
  ({ uuid: "reviewer", accessRules }) as AuthPrincipal;
function fixture() {
  const query = vi.fn(async (sql: { sql: string }) => {
    if (sql.sql.includes("GROUP BY reviewGroup, d.status"))
      return [
        {
          reviewGroup: "RU",
          status: "IN_REVIEW",
          documents: 4n,
          candidates: 2n,
        },
        {
          reviewGroup: "RU",
          status: "RETURNED",
          documents: 1n,
          candidates: 1n,
        },
        { reviewGroup: "RU", status: "SIGNED", documents: 3n, candidates: 2n },
      ];
    if (sql.sql.includes("GROUP BY reviewGroup, day"))
      return [{ reviewGroup: "RU", day: "2026-10-26", value: 4n }];
    return [];
  });
  return { prisma: { $queryRaw: query }, query };
}
describe("candidate document acceptance dashboard", () => {
  it("counts current documents and distinct candidates without employee pipeline metrics", async () => {
    const { prisma } = fixture();
    const dto = await new DashboardService(prisma as never).get(
      user({ "20002": [] }),
    );
    expect(Object.fromEntries(dto.kpis.map((k) => [k.key, k.value]))).toEqual({
      queue: "4",
      in_review: "2",
      rework: "1",
      approved: "3",
      ocr_failed: "0",
    });
    expect(dto.sections.map((s) => s.reviewGroup)).toEqual(["RU"]);
    expect(dto.tasks).toEqual([]);
    expect(dto.blocked).toEqual([]);
    expect(dto.stages.find((s) => s.label === "Возвращены")?.value).toBe(1);
  });
  it("uses current-version joins and one group/manager scope in every returned collection", async () => {
    const { prisma, query } = fixture();
    await new DashboardService(prisma as never).get(user({ "20011": [] }), {
      reviewGroup: "IG",
      managerCode1c: "000123",
    });
    expect(query).toHaveBeenCalledTimes(5);
    for (const [sql] of query.mock.calls) {
      if (sql.sql.includes("GROUP BY reviewGroup, day"))
        expect(sql.sql).not.toContain("v.version = d.currentVersion");
      else expect(sql.sql).toContain("v.version = d.currentVersion");
      expect(sql.sql).toContain("d.currentVersion > 0");
      expect(sql.sql).toContain("c.chatUuid IS NULL");
      if (!sql.sql.includes("AS code1c"))
        expect(sql.sql).toContain("c.managerCode1c = ?");
      expect(sql.sql).not.toContain("locationId");
      if (!sql.sql.includes("AS code1c"))
        expect((sql as { values?: unknown[] }).values).toContain("000123");
    }
    expect(
      query.mock.calls.find(([sql]) => sql.sql.includes("audit_logs"))?.[0].sql,
    ).toContain("a.actorId = ?");
  });
  it("rejects forbidden group and conflicting exact manager selectors before querying", async () => {
    const { prisma, query } = fixture();
    const service = new DashboardService(prisma as never);
    await expect(
      service.get(user({ "20002": [] }), { reviewGroup: "IG" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.get(user({ "20009": [] }), {
        managerCode1c: "a",
        managerName: "b",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(query).not.toHaveBeenCalled();
  });
  it("returns both sections for admin and no candidate data for non-review roles", async () => {
    const { prisma, query } = fixture();
    const service = new DashboardService(prisma as never);
    expect(
      (await service.get(user({ "20009": [] }))).sections.map(
        (s) => s.reviewGroup,
      ),
    ).toEqual(["RU", "IG"]);
    query.mockClear();
    const dto = await service.get(
      user({ "20000": [], "20003": [], "20008": [] }),
    );
    expect(dto.kpis).toEqual([]);
    expect(dto.sections).toEqual([]);
    expect(dto.activity).toEqual([]);
    expect(dto.managers).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
