import { describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { CandidateWorkspaceService } from "../src/communications/candidate-workspace.service";
import { CandidatePreviousDocumentsSyncService } from "../src/documents/candidate-previous-documents-sync.service";
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
    igEmploymentState: { findFirst: vi.fn(async () => null) },
    candidate: {
      findFirst: vi.fn(async () => ({ ...row })),
      update: vi.fn(async ({ data }: { data: { personUid?: string } }) => {
        if (data.personUid !== undefined) row.personUid = data.personUid;
        return { ...row };
      }),
    },
    candidatePreviousDocument: {
      upsert: vi.fn(),
      findMany: vi.fn(async () => [] as unknown[]),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    documentType: {
      findFirst: vi.fn(async () => null),
    },
    document: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({ id: "doc-id" })),
      findMany: vi.fn(async () => [] as unknown[]),
    },
    documentVersion: {
      findFirst: vi.fn(async () => null),
      upsert: vi.fn(async () => ({ id: "ver-id" })),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (arg: typeof tx) => unknown) => fn(tx)),
    candidatePreviousDocument: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(),
    },
    document: { findMany: vi.fn(async () => [] as unknown[]) },
    documentVersion: { findFirst: vi.fn() },
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
    probePersonOriginal: vi.fn(async () => true),
  };
  const ownHistory = {
    probeOriginal: vi.fn(async () => true),
    edoFile: vi
      .fn()
      .mockResolvedValue({ bytes: Buffer.from("file"), mimeType: "image/png" }),
  };
  const previousDocsSync = new CandidatePreviousDocumentsSyncService(
    prisma as unknown as PrismaService,
    erp as unknown as ErpWorkspaceClient,
    access as unknown as DocumentAccessService,
    audit as unknown as AuditService,
    {} as DocumentCatalogService,
  );
  const service = new CandidateWorkspaceService(
    prisma as unknown as PrismaService,
    erp as unknown as ErpWorkspaceClient,
    access as unknown as DocumentAccessService,
    audit as unknown as AuditService,
    new ConfigService({ JWT_SECRET: "secret" }),
    {} as DocumentCatalogService,
    previousDocsSync,
    ownHistory as never,
  );
  return { service, row, tx, erp, audit, prisma, ownHistory };
}
describe("IG previous ERP documents", () => {
  it("treats an earlier ordinary document as verified when importing it for the linked person", async () => {
    const { service, row, tx, erp } = setup();
    erp.request.mockResolvedValue({
      items: [
        {
          id: "old-passport",
          documentUid: personUid,
          title: "Паспорт",
          fields: {},
          expiresAt: null,
          originalAvailable: true,
          isInvalid: false,
          recheckStatus: "REQUIRES_REVIEW",
        },
      ],
    } as never);
    await service.previous(row.id, actor({ "20011": [] }));
    expect(tx.candidatePreviousDocument.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          sourceId: "old-passport",
          status: "CONFIRMED",
        }),
      }),
    );
    expect(tx.igEmploymentState.findFirst).toHaveBeenCalled();
  });
  it.each([null, undefined])(
    "auto-confirms ERP record with missing or null invalidity %s when not marked invalid (FIX-06)",
    async (isInvalid) => {
      const { service, row, tx, erp } = setup();
      erp.request.mockResolvedValue({
        items: [
          {
            id: "old",
            documentUid: personUid,
            title: "Passport",
            fields: {},
            expiresAt: null,
            originalAvailable: true,
            isInvalid,
            recheckStatus: "REQUIRES_REVIEW",
          },
        ],
      } as never);
      await service.previous(row.id, actor({ "20011": [] }));
      expect(tx.candidatePreviousDocument.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: "CONFIRMED" }),
        }),
      );
    },
  );
  it("does not auto-confirm contradictory ERP invalidity fields", async () => {
    const { service, row, tx, erp } = setup();
    erp.request.mockResolvedValue({
      items: [
        {
          id: "old",
          documentUid: personUid,
          title: "Passport",
          fields: { isInvalid: true },
          expiresAt: null,
          originalAvailable: true,
          isInvalid: false,
          recheckStatus: "REQUIRES_REVIEW",
        },
      ],
    } as never);
    await service.previous(row.id, actor({ "20011": [] }));
    expect(tx.candidatePreviousDocument.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "REQUIRES_REVIEW",
          originalVerified: false,
        }),
      }),
    );
  });
  it("does not auto-confirm when ERP advertises an original that cannot be read", async () => {
    const { service, row, tx, erp } = setup();
    erp.probePersonOriginal.mockResolvedValue(false);
    erp.request.mockResolvedValue({
      items: [
        {
          id: "old",
          documentUid: personUid,
          title: "Passport",
          fields: {},
          expiresAt: null,
          originalAvailable: true,
          isInvalid: false,
          recheckStatus: "REQUIRES_REVIEW",
        },
      ],
    } as never);
    await service.previous(row.id, actor({ "20011": [] }));
    expect(tx.candidatePreviousDocument.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: "REQUIRES_REVIEW" }),
      }),
    );
  });
  it.each([
    { person: null, expiry: "2029-01-01", label: "ambiguous person" },
    {
      person: "00000000-0000-4000-8000-000000000002",
      expiry: "2029-01-01",
      label: "different person",
    },
    { person: personUid, expiry: "2029-02-30", label: "malformed expiry" },
  ])(
    "does not auto-confirm a prior local record with $label",
    async ({ person, expiry }) => {
      const { service, row, tx, prisma } = setup();
      prisma.document.findMany.mockResolvedValue([
        {
          id: "doc",
          currentVersion: 1,
          status: "APPROVED",
          candidate: { personUid: person },
          documentType: { erpUid: personUid, title: "Passport" },
          versions: [
            {
              id: "version",
              version: 1,
              status: "APPROVED",
              fields: [{ name: "expiryDate", kind: "date", value: expiry }],
              files: [
                {
                  deletedAt: null,
                  storageKey: "private",
                  sizeBytes: 4,
                  sha256: "a".repeat(64),
                },
              ],
              delivery: {
                status: "SENT",
                transport: "multipart-v2",
                attempts: [
                  {
                    receiptValidated: true,
                    finishedAt: new Date(),
                    errorCode: null,
                  },
                ],
              },
            },
          ],
        },
      ] as never);
      await service.previous(row.id, actor({ "20011": [] }));
      expect(tx.candidatePreviousDocument.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            status: "REQUIRES_REVIEW",
            originalVerified: false,
          }),
        }),
      );
    },
  );
  it.each(["DRAFT", "RETURNED"])(
    "does not auto-confirm prior local %s document",
    async (status) => {
      const { service, row, tx, prisma } = setup();
      prisma.document.findMany.mockResolvedValue([
        {
          id: "doc",
          currentVersion: 1,
          status,
          candidate: { personUid },
          documentType: { erpUid: personUid, title: "Passport" },
          versions: [
            {
              id: "version",
              version: 1,
              status,
              fields: [],
              files: [{ deletedAt: null, storageKey: "private" }],
              storageKey: "private",
              delivery: null,
            },
          ],
        },
      ] as never);
      await service.previous(row.id, actor({ "20011": [] }));
      expect(tx.candidatePreviousDocument.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: "REQUIRES_REVIEW" }),
        }),
      );
    },
  );
  it.each([
    {
      documentUid: "39554ac3-6462-11ec-80cc-002590854e7f",
      expiresAt: null,
      originalAvailable: true,
      isInvalid: false,
    },
    {
      documentUid: "e87d5a10-d248-11eb-80c7-002590854e7f",
      expiresAt: null,
      originalAvailable: true,
      isInvalid: false,
    },
    {
      documentUid: personUid,
      expiresAt: "2000-01-01",
      originalAvailable: true,
      isInvalid: false,
    },
    {
      documentUid: personUid,
      expiresAt: null,
      originalAvailable: true,
      isInvalid: true,
    },
    {
      documentUid: personUid,
      expiresAt: null,
      originalAvailable: false,
      isInvalid: false,
    },
  ])(
    "does not automatically count a document requiring replacement",
    async (input) => {
      const { service, row, tx, erp } = setup();
      erp.request.mockResolvedValue({
        items: [
          {
            id: "old",
            title: "Документ",
            fields: {},
            recheckStatus: "REQUIRES_REVIEW",
            ...input,
          },
        ],
      } as never);
      await service.previous(row.id, actor({ "20011": [] }));
      expect(tx.candidatePreviousDocument.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: "REQUIRES_REVIEW" }),
        }),
      );
    },
  );
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
  it("includes EDO documents from earlier cycles for the same verified person", async () => {
    const { service, row, prisma, tx } = setup();
    prisma.document.findMany.mockResolvedValue([
      {
        id: "document",
        currentVersion: 2,
        status: "APPROVED",
        documentType: { title: "Паспорт", erpUid: personUid },
        versions: [
          {
            id: "version",
            version: 2,
            fields: [{ name: "number", value: "123", kind: "text" }],
            files: [{ id: "file", deletedAt: null }],
            storageKey: "key",
          },
        ],
      },
    ]);
    const result = await service.previous(row.id, actor({ "20011": [] }));
    expect(result.edoDocuments).toEqual([
      {
        id: "document",
        currentVersion: 2,
        status: "APPROVED",
        title: "Паспорт",
      },
    ]);
    expect(tx.candidatePreviousDocument.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          sourceId: "edo:document:version",
          title: "Паспорт",
          originalAvailable: true,
        }),
      }),
    );
    expect(prisma.document.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          candidate: expect.objectContaining({ code1c: "worker" }),
        }),
      }),
    );
  });
  it("opens an old EDO original through the verified employee scope", async () => {
    const { service, row, prisma, tx, ownHistory } = setup();
    prisma.documentVersion.findFirst.mockResolvedValue({
      id: "version",
      files: [{ id: "file" }],
    } as never);
    prisma.candidatePreviousDocument.findFirst.mockResolvedValue({
      sourceId: "edo:document:version",
      originalAvailable: true,
    });
    const result = await service.original(
      row.id,
      "old",
      actor({ "20011": [] }),
    );
    expect(result.bytes).toEqual(Buffer.from("file"));
    expect(ownHistory.edoFile).toHaveBeenCalledWith(
      "worker",
      "document",
      "file",
    );
    expect(tx.candidate.update).toHaveBeenCalled();
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
          isInvalid: false,
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
  it("automatically confirms changed valid ERP fields without manual review", async () => {
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
          isInvalid: false,
          recheckStatus: "REQUIRES_REVIEW",
        },
      ],
    } as never);
    await service.previous(row.id, actor({ "20011": [] }));
    expect(tx.candidatePreviousDocument.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: "CONFIRMED",
          reviewedBy: "system:previous-document",
          reviewedAt: expect.any(Date),
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
    erp.request.mockRejectedValueOnce(new Error("ERP unavailable"));
    await expect(
      service.previous(row.id, actor({ "20011": [] })),
    ).rejects.toThrow("ERP unavailable");
    expect(tx.candidatePreviousDocument.update).not.toHaveBeenCalled();
  });
  it.each([
    "39554ac3-6462-11ec-80cc-002590854e7f",
    "e87d5a10-d248-11eb-80c7-002590854e7f",
    null,
  ])(
    "does not auto-confirm a previous IG document when it requires a new upload or has unknown type: %s",
    async (documentUid) => {
      const { service, row, tx, erp } = setup();
      erp.request.mockResolvedValue({
        items: [
          {
            id: "source-1",
            documentUid,
            title: "Документ",
            fields: { isInvalid: false },
            expiresAt: null,
            originalAvailable: true,
            recheckStatus: "REQUIRES_REVIEW",
          },
        ],
      } as never);
      await service.previous(row.id, actor({ "20011": [] }));
      expect(tx.candidatePreviousDocument.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            status: "REQUIRES_REVIEW",
          }),
        }),
      );
    },
  );
  it.each([
    { fields: { isInvalid: true }, expiresAt: null },
    {
      fields: { isInvalid: false },
      expiresAt: "2000-01-01",
    },
  ])(
    "does not auto-confirm an invalid or expired ERP document",
    async (document) => {
      const { service, row, tx, erp } = setup();
      erp.request.mockResolvedValue({
        items: [
          {
            id: "source-2",
            documentUid: "6ffb1fd5-8341-11eb-ba8b-00259002db81",
            title: "Паспорт",
            originalAvailable: true,
            recheckStatus: "REQUIRES_REVIEW",
            ...document,
          },
        ],
      } as never);
      await service.previous(row.id, actor({ "20011": [] }));
      expect(tx.candidatePreviousDocument.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            status: "REQUIRES_REVIEW",
          }),
        }),
      );
    },
  );
});
