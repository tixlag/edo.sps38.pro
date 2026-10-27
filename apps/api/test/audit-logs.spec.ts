import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AuditLogsService } from "../src/audit/audit-logs.service";

const principal = (
  accessRules: Record<string, string[]>,
  uuid = "reviewer-1",
) => ({
  uuid,
  code1c: null,
  sid: null,
  deviceId: null,
  expiresAt: null,
  accessRules,
});

function mockPrisma(overrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    auditLog: { findMany: vi.fn().mockResolvedValue([]) },
    document: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    employee: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    candidate: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    lkEmployee: { findMany: vi.fn().mockResolvedValue([]) },
    ...overrides,
  };
}

function rawValues(prisma: ReturnType<typeof mockPrisma>): unknown[] {
  const call = (prisma.$queryRaw as ReturnType<typeof vi.fn>).mock
    .calls[0]?.[0] as { values?: unknown[] } | undefined;
  return call?.values ?? [];
}

function rawSql(prisma: ReturnType<typeof mockPrisma>): string {
  const call = (prisma.$queryRaw as ReturnType<typeof vi.fn>).mock
    .calls[0]?.[0] as { sql?: string } | undefined;
  return call?.sql ?? "";
}

describe("AuditLogsService", () => {
  it("mine=true filters by caller uuid and resolves names via the LK projection", async () => {
    const prisma = mockPrisma({
      $queryRaw: vi.fn().mockResolvedValue([
        {
          id: "a1",
          actorId: "reviewer-1",
          action: "DOCUMENT_APPROVED",
          entityType: "Document",
          entityId: "doc-1",
          after: { version: 2 },
          createdAt: new Date("2026-10-01T10:00:00.000Z"),
        },
      ]),
      lkEmployee: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { uuid: "reviewer-1", code1c: "C-1", fullName: "Reviewer One" },
          ]),
      },
    });
    const dto = await new AuditLogsService(prisma as never).list(
      principal({ "20002": [], "20007": ["98"] }) as never,
      { mine: true, limit: 20 } as never,
    );
    expect(dto.items).toHaveLength(1);
    expect(dto.items[0].actorId).toBe("reviewer-1");
    expect(dto.items[0].actorName).toBe("Reviewer One");
    expect(dto.items[0].linkHint).toBe("/review/doc-1");
    expect(dto.items[0].version).toBe(2);
    expect(dto.nextCursor).toBeNull();
    // Scoped path: single DB-level EXISTS query, never an ID preload.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    expect(prisma.document.findMany).not.toHaveBeenCalled();
    expect(prisma.employee.findMany).not.toHaveBeenCalled();
    // Own reviewer history follows its review group across all locations.
    expect(rawValues(prisma)).toContain("reviewer-1");
    expect(rawValues(prisma)).not.toContain(98);
    expect(rawSql(prisma)).toContain("citizenship");
    expect(rawSql(prisma)).toContain("EXISTS");
    // UUID-only lookup against the local projection, never by full name.
    expect(prisma.lkEmployee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { uuid: { in: ["reviewer-1"] } },
            { code1c: { in: ["reviewer-1"] } },
          ]),
        }),
      }),
    );
  });

  it("actorId=me behaves like mine=true", async () => {
    const prisma = mockPrisma();
    await new AuditLogsService(prisma as never).list(
      principal({ "20009": [] }, "admin-1") as never,
      { actorId: "me" } as never,
    );
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ actorId: "admin-1" }),
      }),
    );
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("rejects unfiltered history for bare DOCUMENT_REVIEW holders", async () => {
    const prisma = mockPrisma();
    await expect(
      new AuditLogsService(prisma as never).list(
        principal({ "20002": [], "20007": ["98"] }) as never,
        {} as never,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("returns empty history for single out-of-scope documents without id enumeration", async () => {
    const prisma = mockPrisma();
    const dto = await new AuditLogsService(prisma as never).list(
      principal({ "20005": [], "20007": ["98"] }) as never,
      { entityType: "Document", entityId: "doc-x" } as never,
    );
    expect(dto).toEqual({ items: [], nextCursor: null });
    expect(prisma.document.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "doc-x" }),
      }),
    );
    expect(prisma.document.findMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("extracts rejectionReason from after JSON for DOCUMENT_RETURNED", async () => {
    const prisma = mockPrisma({
      auditLog: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "a2",
            actorId: "reviewer-1",
            action: "DOCUMENT_RETURNED",
            entityType: "Document",
            entityId: "doc-2",
            after: {
              version: 3,
              status: "RETURNED",
              rejectionReason: "Blurry photo",
            },
            createdAt: new Date("2026-10-02T10:00:00.000Z"),
          },
          {
            id: "a3",
            actorId: "reviewer-1",
            action: "DOCUMENT_APPROVED",
            entityType: "Document",
            entityId: "doc-3",
            after: { version: 1, status: "APPROVED" },
            createdAt: new Date("2026-10-03T10:00:00.000Z"),
          },
          {
            id: "a4",
            actorId: "reviewer-1",
            action: "DOCUMENT_UPLOADED",
            entityType: "Document",
            entityId: "doc-4",
            after: {},
            createdAt: new Date("2026-10-04T10:00:00.000Z"),
          },
        ]),
      },
    });
    const dto = await new AuditLogsService(prisma as never).list(
      principal({ "20009": [] }) as never,
      { mine: true } as never,
    );
    expect(dto.items.find((i) => i.id === "a2")?.rejectionReason).toBe(
      "Blurry photo",
    );
    expect(dto.items.find((i) => i.id === "a2")?.version).toBe(3);
    expect(dto.items.find((i) => i.id === "a3")?.rejectionReason).toBeNull();
    expect(dto.items.find((i) => i.id === "a3")?.version).toBe(1);
    // Legacy rows without after.version map to null, never undefined.
    expect(dto.items.find((i) => i.id === "a4")?.version).toBeNull();
  });

  it("paginates by createdAt+id with take limit+1", async () => {
    const first = {
      id: "a9",
      actorId: null,
      action: "DOCUMENT_UPLOADED",
      entityType: "Candidate",
      entityId: "c-1",
      after: {},
      createdAt: new Date("2026-10-04T10:00:00.000Z"),
    };
    const prisma = mockPrisma({
      auditLog: {
        findMany: vi.fn().mockResolvedValue([first, { ...first, id: "a8" }]),
      },
    });
    const dto = await new AuditLogsService(prisma as never).list(
      principal({ "20009": [] }) as never,
      { limit: 1 } as never,
    );
    expect(dto.items).toHaveLength(1);
    expect(dto.nextCursor).toBeTruthy();
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 2,
      }),
    );
    // Cursor round-trips into the next query.
    const decoded = JSON.parse(
      Buffer.from(dto.nextCursor!, "base64url").toString("utf8"),
    );
    expect(decoded).toEqual({
      createdAt: "2026-10-04T10:00:00.000Z",
      id: "a9",
    });
  });
});
