import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { DashboardService } from "../src/dashboard/dashboard.service";
import type { AuthPrincipal } from "../src/auth/auth-principal";

const url = process.env.EDO_ANNOTATION_TEST_DATABASE_URL ?? "";
if (url) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "mysql:" ||
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !parsed.port ||
    ["3306", "12002"].includes(parsed.port) ||
    parsed.pathname !== "/edo"
  )
    throw new Error("Refusing non-isolated dashboard MariaDB");
}
const suite = describe.skipIf(!url);
const prefix = `dashboard-test-${randomUUID()}`;
const principal = (rules: Record<string, string[]>) =>
  ({ uuid: prefix, accessRules: rules }) as AuthPrincipal;

suite("operational dashboard on MariaDB", () => {
  let prisma: PrismaService;
  let service: DashboardService;
  const docs: string[] = [];
  const candidates: string[] = [];
  let ru: string;
  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url } } });
    await prisma.$connect();
    service = new DashboardService(prisma);
    for (const citizenship of ["ru", "uz"]) {
      const candidate = await prisma.candidate.create({
        data: {
          identityKey: `${prefix}-${citizenship}`,
          citizenship,
          locationId: null,
          fullName: `Synthetic ${citizenship}`,
          managerCode1c: `${prefix}-${citizenship}`,
          managerName: "Same name",
        },
      });
      candidates.push(candidate.id);
      const doc = await prisma.document.create({
        data: {
          candidateId: candidate.id,
          status: "IN_REVIEW",
          currentVersion: 2,
          versions: {
            create: [1, 2].map((version) => ({
              version,
              storageKey: "synthetic-unused",
              status:
                version === 1 ? ("RETURNED" as const) : ("IN_REVIEW" as const),
              submittedAt: new Date(),
              citizenship,
            })),
          },
        },
      });
      docs.push(doc.id);
      if (citizenship === "ru") ru = doc.id;
    }
    await prisma.auditLog.create({
      data: {
        actorId: prefix,
        action: "DOCUMENT_APPROVED",
        entityType: "Document",
        entityId: ru,
      },
    });
  });
  afterAll(async () => {
    if (!prisma) return;
    await prisma.auditLog.deleteMany({ where: { actorId: prefix } });
    await prisma.document.deleteMany({ where: { id: { in: docs } } });
    await prisma.candidate.deleteMany({ where: { id: { in: candidates } } });
    await prisma.$disconnect();
  });
  it("executes all SQL collections and counts separate resubmissions without location grants", async () => {
    const data = await service.get(principal({ "20002": [] }), {
      managerCode1c: `${prefix}-ru`,
    });
    expect(data.sections.map((section) => section.reviewGroup)).toEqual(["RU"]);
    expect(data.kpis.find((kpi) => kpi.key === "queue")?.value).toBe("1");
    expect(data.kpis.find((kpi) => kpi.key === "rework")?.value).toBe("0");
    expect(data.weekly.reduce((sum, day) => sum + day.value, 0)).toBe(2);
    expect(data.activity).toHaveLength(1);
    expect(data.attention.map((item) => item.documentId)).toEqual([ru]);
    expect(
      data.managers.some((manager) => manager.code1c === `${prefix}-uz`),
    ).toBe(false);
  });
  it("keeps manager identifiers distinct and excludes historical returns from current KPIs", async () => {
    const data = await service.get(principal({ "20009": [] }), {
      managerCode1c: `${prefix}-uz`,
    });
    expect(data.sections.map((section) => section.reviewGroup)).toEqual([
      "RU",
      "IG",
    ]);
    expect(data.kpis.find((kpi) => kpi.key === "queue")?.value).toBe("1");
    expect(data.activity).toEqual([]);
    expect(data.attention[0].reviewGroup).toBe("IG");
    expect(
      data.managers.filter((manager) => manager.name === "Same name"),
    ).toHaveLength(2);
    expect(data.weekly.reduce((sum, day) => sum + day.value, 0)).toBe(2);
  });
});
