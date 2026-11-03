import { describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { CandidateWorkspaceService } from "../src/communications/candidate-workspace.service";
import type { AuthPrincipal } from "../src/auth/auth-principal";
import type { PrismaService } from "../src/prisma/prisma.service";
import type { AuditService } from "../src/audit/audit.service";
import type { DocumentAccessService } from "../src/documents/document-access.service";
import type { DocumentCatalogService } from "../src/documents/document-catalog.service";
import type { ErpWorkspaceClient } from "../src/documents/erp-workspace.client";
import { previousDocumentsSchema } from "../src/documents/erp-workspace.client";
import { isPreviousDocumentExpired } from "../src/documents/reemployment-document-policy";

const personUid = "00000000-0000-4000-8000-000000000001";
const actor = (rules: Record<string, unknown>): AuthPrincipal => ({
  uuid: "reviewer",
  code1c: "reviewer-code",
  sid: null,
  deviceId: null,
  expiresAt: null,
  accessRules: rules as AuthPrincipal["accessRules"],
});
function setup() {
  const row = {
    id: "candidate",
    code1c: "worker",
    personUid: null as string | null,
    erpUid: null,
    chatUuid: null,
    citizenship: "uz",
  };
  const tx = {
    $queryRaw: vi.fn(),
    candidate: {
      findFirst: vi.fn(async () => ({ ...row })),
      update: vi.fn(async ({ data }: { data: { personUid: string } }) => {
        row.personUid = data.personUid;
        return { ...row };
      }),
    },
    candidatePreviousDocument: {
      upsert: vi.fn(),
      findMany: vi.fn(async () => [] as unknown[]),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (arg: typeof tx) => unknown) => fn(tx)),
    candidatePreviousDocument: { findMany: vi.fn(async () => []) },
  };
  const audit = { logInTransaction: vi.fn() };
  const access = {
    candidate: vi.fn(async () => ({ ...row })),
    candidateWhere: vi.fn(() => ({})),
  };
  const erp = {
    identity: vi.fn(async () => ({
      reviewGroup: "IG",
      recipientType: "person",
      personUid,
      code1C: "worker",
    })),
    request: vi.fn(async () => ({ items: [] })),
    employmentHistory: vi.fn(async () => ({ items: [] })),
  };
  const service = new CandidateWorkspaceService(
    prisma as unknown as PrismaService,
    erp as unknown as ErpWorkspaceClient,
    access as unknown as DocumentAccessService,
    audit as unknown as AuditService,
    new ConfigService({ JWT_SECRET: "secret" }),
    {} as DocumentCatalogService,
  );
  return { service, row, tx, erp, audit };
}
describe("IG previous ERP documents", () => {
  it("checks expiration by Irkutsk calendar date and includes the expiration day", () => {
    const expires = new Date("2026-11-03T00:00:00Z");
    expect(
      isPreviousDocumentExpired(expires, new Date("2026-11-03T15:59:59Z")),
    ).toBe(false);
    expect(
      isPreviousDocumentExpired(expires, new Date("2026-11-03T16:00:00Z")),
    ).toBe(true);
  });
  it("preserves ERP record date and explicit invalidity while accepting the older contract", () => {
    const base = {
      id: "old",
      documentUid: personUid,
      title: "Документ",
      fields: {},
      expiresAt: null,
      originalAvailable: true,
      recheckStatus: "REQUIRES_REVIEW",
    };
    expect(
      previousDocumentsSchema.parse({ items: [base] }).items[0].isInvalid,
    ).toBeUndefined();
    expect(
      previousDocumentsSchema.parse({
        items: [{ ...base, recordDate: "2020-01-01", isInvalid: false }],
      }).items[0],
    ).toMatchObject({ recordDate: "2020-01-01", isInvalid: false });
    expect(() =>
      previousDocumentsSchema.parse({
        items: [{ ...base, expiresAt: "2024-02-31" }],
      }),
    ).toThrow();
  });
  it("pins the ERP-confirmed person and imports only for the matching code", async () => {
    const { service, row, erp, audit } = setup();
    await expect(
      service.previous(row.id, actor({ "20011": [] })),
    ).resolves.toEqual({
      items: [],
      employmentHistory: { available: true, items: [] },
    });
    expect(row.personUid).toBe(personUid);
    expect(erp.request).toHaveBeenCalledWith(
      "person-documents-by-code",
      expect.anything(),
      { code1c: "worker", personUid },
    );
    expect(audit.logInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "CANDIDATE_LINKED" }),
    );
  });
  it("keeps documents accessible when the optional employment-history source is unavailable", async () => {
    const { service, row, erp } = setup();
    erp.employmentHistory.mockRejectedValueOnce(new Error("ERP unavailable"));
    await expect(
      service.previous(row.id, actor({ "20011": [] })),
    ).resolves.toEqual({
      items: [],
      employmentHistory: { available: false, items: [] },
    });
    expect(erp.request).toHaveBeenCalledWith(
      "person-documents-by-code",
      expect.anything(),
      { code1c: "worker", personUid },
    );
  });
  it("rejects changed ERP identity without importing another person's documents", async () => {
    const { service, row, erp } = setup();
    row.personUid = "00000000-0000-4000-8000-000000000002";
    await expect(
      service.previous(row.id, actor({ "20011": [] })),
    ).rejects.toThrow("ERP_PERSON_IDENTITY_MISMATCH");
    expect(erp.request).not.toHaveBeenCalled();
  });
  it("does not import if candidate identity changes while ERP is loading history", async () => {
    const { service, row, erp, tx } = setup();
    erp.request.mockImplementationOnce(async () => {
      row.personUid = "00000000-0000-4000-8000-000000000002";
      return { items: [] };
    });
    await expect(
      service.previous(row.id, actor({ "20011": [] })),
    ).rejects.toThrow("ERP_PERSON_IDENTITY_MISMATCH");
    expect(tx.candidatePreviousDocument.upsert).not.toHaveBeenCalled();
  });
  it("withdraws confirmation and audits when a previously confirmed document expires", async () => {
    const { service, row, tx, erp, audit } = setup();
    tx.candidatePreviousDocument.findMany.mockResolvedValue([
      {
        id: "old",
        sourceId: "source",
        documentUid: personUid,
        status: "CONFIRMED",
        originalAvailable: true,
        fields: {},
      },
    ]);
    erp.request.mockResolvedValue({
      items: [
        {
          id: "source",
          documentUid: personUid,
          title: "Документ",
          fields: {},
          expiresAt: "2000-01-01",
          originalAvailable: true,
          recheckStatus: "REQUIRES_REVIEW",
        },
      ],
    } as never);
    await service.previous(row.id, actor({ "20011": [] }));
    expect(tx.candidatePreviousDocument.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ status: "REPLACE" }),
      }),
    );
    expect(audit.logInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entityType: "CandidatePreviousDocument",
        after: expect.objectContaining({ source: "ERP_REVALIDATION" }),
      }),
    );
  });
  it("requires review again when ERP changes the fields of a confirmed document", async () => {
    const { service, row, tx, erp } = setup();
    tx.candidatePreviousDocument.findMany.mockResolvedValue([
      {
        id: "old",
        sourceId: "source",
        documentUid: personUid,
        status: "CONFIRMED",
        originalAvailable: true,
        fields: { number: "A1" },
        expiresAt: null,
      },
    ]);
    erp.request.mockResolvedValue({
      items: [
        {
          id: "source",
          documentUid: personUid,
          title: "Документ",
          fields: { number: "A2" },
          expiresAt: null,
          originalAvailable: true,
          recheckStatus: "REQUIRES_REVIEW",
        },
      ],
    } as never);
    await service.previous(row.id, actor({ "20011": [] }));
    expect(tx.candidatePreviousDocument.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: "REQUIRES_REVIEW",
          reviewedBy: null,
          reviewedAt: null,
        }),
      }),
    );
  });
  it("marks a disappeared ERP original unavailable and withdraws confirmation", async () => {
    const { service, row, tx } = setup();
    tx.candidatePreviousDocument.findMany.mockResolvedValue([
      {
        id: "old",
        sourceId: "source",
        documentUid: personUid,
        status: "CONFIRMED",
        originalAvailable: true,
        fields: {},
      },
    ]);
    await service.previous(row.id, actor({ "20011": [] }));
    expect(tx.candidatePreviousDocument.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "old" },
        data: expect.objectContaining({
          status: "ORIGINAL_UNAVAILABLE",
          originalAvailable: false,
        }),
      }),
    );
  });
  it("does not grant IG history to an RU-only reviewer", async () => {
    const { service, row, erp } = setup();
    await expect(
      service.previous(row.id, actor({ "20002": [] })),
    ).rejects.toThrow();
    expect(erp.identity).not.toHaveBeenCalled();
  });
  it("does not confirm a stale document when the ERP history cannot be refreshed", async () => {
    const { service, row, tx, erp } = setup();
    tx.candidatePreviousDocument.findFirst.mockResolvedValue({
      id: "old",
      documentUid: personUid,
      originalAvailable: true,
      fields: { isInvalid: false },
      expiresAt: null,
      status: "REQUIRES_REVIEW",
    } as never);
    erp.request.mockRejectedValueOnce(new Error("ERP unavailable"));
    await expect(
      service.recheck(row.id, "old", actor({ "20011": [] }), {
        status: "CONFIRMED",
      }),
    ).rejects.toThrow("ERP unavailable");
    expect(tx.candidatePreviousDocument.update).not.toHaveBeenCalled();
  });
  it.each([
    "39554ac3-6462-11ec-80cc-002590854e7f",
    "e87d5a10-d248-11eb-80c7-002590854e7f",
    null,
  ])(
    "does not confirm a previous IG document when it requires a new upload or has unknown type: %s",
    async (documentUid) => {
      const { service, row, tx } = setup();
      tx.candidatePreviousDocument.findFirst.mockResolvedValue({
        id: "old",
        documentUid,
        originalAvailable: true,
        status: "REQUIRES_REVIEW",
      } as never);
      await expect(
        service.recheck(row.id, "old", actor({ "20011": [] }), {
          status: "CONFIRMED",
        }),
      ).rejects.toThrow();
      expect(tx.candidatePreviousDocument.update).not.toHaveBeenCalled();
    },
  );
  it.each([
    { fields: { isInvalid: true }, expiresAt: null },
    {
      fields: { isInvalid: false },
      expiresAt: new Date("2000-01-01T00:00:00Z"),
    },
  ])(
    "does not confirm an invalid or expired ERP document",
    async (document) => {
      const { service, row, tx } = setup();
      tx.candidatePreviousDocument.findFirst.mockResolvedValue({
        id: "old",
        documentUid: "6ffb1fd5-8341-11eb-ba8b-00259002db81",
        originalAvailable: true,
        status: "REQUIRES_REVIEW",
        ...document,
      } as never);
      await expect(
        service.recheck(row.id, "old", actor({ "20011": [] }), {
          status: "CONFIRMED",
        }),
      ).rejects.toThrow();
      expect(tx.candidatePreviousDocument.update).not.toHaveBeenCalled();
    },
  );
});
