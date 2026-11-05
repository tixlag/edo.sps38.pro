import { describe, expect, it, vi } from "vitest";
import { ExpirationBackfill } from "../src/expiration/expiration-backfill";
import type { PrismaService } from "../src/prisma/prisma.service";
import type { AuditService } from "../src/audit/audit.service";

function fixture() {
  const tx = {
    $queryRaw: vi.fn(),
    document: { findUnique: vi.fn().mockResolvedValue({ status: "APPROVED", expiresAt: null, currentVersion: 2 }), update: vi.fn() },
    documentVersion: { findUnique: vi.fn().mockResolvedValue({ id: "v2", version: 2, status: "APPROVED", expiresAt: null, fields: [{ name: "expiryDate", value: "2027-01-02" }] }), update: vi.fn() },
  };
  const prisma = { document: { findMany: vi.fn().mockResolvedValue([{ id: "a" }, { id: "b" }]) }, $transaction: vi.fn((cb) => cb(tx)) };
  const audit = { logInTransaction: vi.fn() };
  return { tx, prisma, audit, backfill: new ExpirationBackfill(prisma as unknown as PrismaService, audit as unknown as AuditService) };
}

describe("expiration backfill", () => {
  it("previews without writes and reports a cursor", async () => {
    const { backfill, tx, audit } = fixture();
    expect(await backfill.run({ apply: false, limit: 1 })).toEqual({ mode: "dry-run", scanned: 1, populated: 1, skipped: 0, nextAfter: "a" });
    expect(tx.document.update).not.toHaveBeenCalled();
    expect(tx.documentVersion.update).not.toHaveBeenCalled();
    expect(audit.logInTransaction).not.toHaveBeenCalled();
  });

  it("writes date and audit together for the approved current version", async () => {
    const { backfill, tx, audit } = fixture();
    await backfill.run({ apply: true, limit: 1 });
    expect(tx.document.update).toHaveBeenCalledWith({ where: { id: "a" }, data: { expiresAt: new Date("2027-01-02T00:00:00Z") } });
    expect(audit.logInTransaction).toHaveBeenCalledWith(tx, expect.objectContaining({ action: "DATA_IMPORTED", entityId: "a" }));
  });

  it("skips a document changed since selection and conflicting version dates", async () => {
    const { backfill, tx, audit } = fixture();
    tx.document.findUnique.mockResolvedValueOnce({ status: "APPROVED", expiresAt: new Date(), currentVersion: 2 });
    tx.documentVersion.findUnique.mockResolvedValueOnce({ id: "v2", version: 2, status: "APPROVED", expiresAt: new Date("2028-01-01T00:00:00Z"), fields: [{ name: "expiryDate", value: "2027-01-02" }] });
    expect(await backfill.run({ apply: true, limit: 2 })).toMatchObject({ populated: 0, skipped: 2, nextAfter: null });
    expect(tx.document.update).not.toHaveBeenCalled();
    expect(audit.logInTransaction).not.toHaveBeenCalled();
  });
});
