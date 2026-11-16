import { describe, expect, it, vi } from "vitest";
import { DocumentAbsenceService } from "../src/documents/document-absence.controller";
const principal = (
  accessRules: Record<string, string[]> = { "20002": [] },
) => ({
  uuid: "reviewer",
  accessRules,
  code1c: null,
  sid: null,
  deviceId: null,
  expiresAt: null,
});
function fixture(group = "RU") {
  const row = {
    id: "absence",
    candidateId: "candidate",
    documentTypeId: "type",
    status: "PENDING",
    reason: "lost",
  };
  const tx = {
    $queryRaw: vi.fn(),
    candidate: {
      findFirst: vi.fn(async () => ({
        reviewGroup: group,
        chatUuid: null,
        citizenship: group === "RU" ? "ru" : "uz",
      })),
    },
    candidateDocumentAbsence: {
      findFirst: vi.fn(async () => row),
      update: vi.fn(async ({ data }) => ({ ...row, ...data })),
      upsert: vi.fn(async ({ create }) => ({ ...row, ...create })),
    },
    documentType: {
      findFirst: vi.fn(async () => ({
        id: "type",
        code: "PASSPORT",
        allRu: true,
        allForeign: false,
        requiredForAll: false,
        positions: [],
        stageRules: [],
      })),
    },
  };
  const audit = { logInTransaction: vi.fn() };
  const prisma = {
    $transaction: async (work: (tx: unknown) => unknown) => work(tx),
  };
  return {
    tx,
    audit,
    service: new DocumentAbsenceService(
      prisma as never,
      audit as never,
      { candidateWhere: () => ({}) } as never,
    ),
  };
}
describe("RU document absence decisions", () => {
  it("resolves an actual required type by its public catalog code", async () => {
    const { service, tx } = fixture();
    const result = await service.write(
      "candidate",
      principal(),
      "correlation",
      { documentTypeCode: "PASSPORT", reason: "lost" },
    );
    expect(result).toMatchObject({
      documentTypeCode: "PASSPORT",
      documentTypeId: "type",
    });
    expect(tx.documentType.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ code: "PASSPORT" }),
      }),
    );
  });
  it("refuses waiver requests for additional or inapplicable catalog types", async () => {
    const { service, tx } = fixture();
    tx.documentType.findFirst.mockResolvedValueOnce({
      id: "type",
      code: "EXTRA",
      allRu: false,
      allForeign: false,
      requiredForAll: false,
      positions: [],
      stageRules: [],
    });
    await expect(
      service.write("candidate", principal(), "correlation", {
        documentTypeCode: "EXTRA",
        reason: "lost",
      }),
    ).rejects.toThrow("DOCUMENT_ABSENCE_REQUIRED_TYPE_ONLY");
    expect(tx.candidateDocumentAbsence.upsert).not.toHaveBeenCalled();
  });
  it("rejects IG waivers even for a RU reviewer", async () => {
    const { service, tx } = fixture("IG");
    await expect(
      service.write("candidate", principal(), "correlation", {
        documentTypeId: "type",
        reason: "lost",
      }),
    ).rejects.toThrow("DOCUMENT_ABSENCE_RU_ONLY");
    expect(tx.candidateDocumentAbsence.upsert).not.toHaveBeenCalled();
  });
  it("does not let audit or staff rights approve a waiver", async () => {
    const { service } = fixture();
    await expect(
      service.write(
        "candidate",
        principal({ "20005": [], "20001": [] }),
        "correlation",
        { status: "APPROVED" },
        "absence",
      ),
    ).rejects.toThrow("Missing required EDO review group access rule");
  });
  it("records reviewer decision and audit atomically", async () => {
    const { service, audit } = fixture();
    const result = await service.write(
      "candidate",
      principal(),
      "correlation",
      { status: "APPROVED", comment: "verified" },
      "absence",
    );
    expect(result).toMatchObject({
      status: "APPROVED",
      decidedBy: "reviewer",
      decisionComment: "verified",
    });
    expect(audit.logInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId: "reviewer",
        action: "DOCUMENT_ABSENCE_DECIDED",
        entityId: "candidate",
      }),
    );
  });
  it("propagates audit failure so the database transaction rolls back", async () => {
    const { service, audit } = fixture();
    audit.logInTransaction.mockRejectedValueOnce(
      new Error("audit unavailable"),
    );
    await expect(
      service.write(
        "candidate",
        principal(),
        "correlation",
        { status: "REJECTED" },
        "absence",
      ),
    ).rejects.toThrow("audit unavailable");
  });
});
