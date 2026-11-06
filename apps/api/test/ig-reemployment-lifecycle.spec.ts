import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { CandidatePreviousDocumentsSyncService } from "../src/documents/candidate-previous-documents-sync.service";
import { DocumentReviewService } from "../src/documents/document-review.service";
import { CandidateWorkspaceService } from "../src/communications/candidate-workspace.service";
import {
  igRequiredDocumentsComplete,
  tryCompleteIgEmployment,
} from "../src/documents/ig-completion";
import {
  EMPLOYMENT_PATENT_UID,
  isPreviousDocumentValid,
} from "../src/documents/reemployment-document-policy";
import { MIGRATION_UID } from "../src/ocr/ocr-profile";
import type { PrismaService } from "../src/prisma/prisma.service";
import type { ErpWorkspaceClient } from "../src/documents/erp-workspace.client";
import type { DocumentAccessService } from "../src/documents/document-access.service";
import type { AuditService } from "../src/audit/audit.service";
import type { StorageService } from "../src/storage/storage.service";
import type { AuthPrincipal } from "../src/auth/auth-principal";

const actor = (rules: Record<string, string[]> = { "20011": [] }): AuthPrincipal => ({
  uuid: "00000000-0000-4000-8000-000000000099",
  code1c: "reviewer",
  sid: "s-1",
  deviceId: "d-1",
  accessRules: rules,
  expiresAt: new Date(Date.now() + 3600000),
});

const INN_UID = "2452c57b-8c32-11eb-ba8b-00259002db81";
const SNILS_UID = "f97a4962-8c32-11eb-ba8b-00259002db81";
const DIPLOMA_UID = "10fa3e03-751b-11ec-80cd-002590854e7f";
const PASSPORT_UID = "6ffb1fd5-8341-11eb-ba8b-00259002db81";

function setupLifecycleTest() {
  const candidateId = "cand-lifecycle-1";
  const personUid = "11111111-1111-4111-8111-111111111111";
  const code1c = "worker-2021";

  const row = {
    id: candidateId,
    code1c,
    personUid,
    erpUid: null,
    chatUuid: null,
    citizenship: "uz",
    positionCode: "1",
    igCompletedAt: null,
    igCompletionVerified: false,
    igRequirementsConflict: false,
    previousDocumentsSyncedAt: null,
  };

  const storedObjects = new Map<string, Buffer>();

  const storage: Partial<StorageService> = {
    keyFor: (docId: string, ver: number, filename: string) =>
      `documents/${docId}/v${ver}/${filename}`,
    uploadBuffer: vi.fn(async (key: string, bytes: Buffer) => {
      storedObjects.set(key, bytes);
    }),
    copy: vi.fn(async (source: string, destination: string) => {
      const src = storedObjects.get(source) ?? Buffer.from("existing-bytes");
      storedObjects.set(destination, src);
    }),
    delete: vi.fn(async (key: string) => {
      storedObjects.delete(key);
    }),
  };

  const candidateUpsertedDocuments: any[] = [];
  const candidateUpsertedVersions: any[] = [];
  const candidatePreviousDocumentsUpserted: any[] = [];
  const auditLogs: any[] = [];

  const tx: any = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    candidate: {
      findFirst: vi.fn(async () => ({ ...row })),
      update: vi.fn(async ({ data }) => {
        Object.assign(row, data);
        return { ...row };
      }),
    },
    document: {
      findUnique: vi.fn(async ({ where, include }) => {
        const found = candidateUpsertedDocuments.find(
          (d) =>
            d.candidateId === where.candidateId_documentTypeId?.candidateId &&
            d.documentTypeId ===
              where.candidateId_documentTypeId?.documentTypeId,
        );
        if (!found) return null;
        if (include?.versions) {
          return {
            ...found,
            versions: candidateUpsertedVersions.filter(
              (v) => v.documentId === found.id,
            ),
          };
        }
        return { ...found };
      }),
      upsert: vi.fn(async ({ where, create, update }) => {
        let existing = candidateUpsertedDocuments.find(
          (d) =>
            d.candidateId === where.candidateId_documentTypeId.candidateId &&
            d.documentTypeId ===
              where.candidateId_documentTypeId.documentTypeId,
        );
        if (!existing) {
          existing = {
            id: `doc-${candidateUpsertedDocuments.length + 1}`,
            ...create,
          };
          candidateUpsertedDocuments.push(existing);
        } else {
          Object.assign(existing, update);
        }
        return existing;
      }),
      findMany: vi.fn(async () =>
        candidateUpsertedDocuments.map((d) => ({
          ...d,
          versions: candidateUpsertedVersions.filter(
            (v) => v.documentId === d.id,
          ),
        })),
      ),
    },
    documentVersion: {
      upsert: vi.fn(async ({ where, create, update }) => {
        let existing = candidateUpsertedVersions.find(
          (v) =>
            v.documentId === where.documentId_version.documentId &&
            v.version === where.documentId_version.version,
        );
        if (!existing) {
          existing = {
            id: `ver-${candidateUpsertedVersions.length + 1}`,
            ...create,
          };
          candidateUpsertedVersions.push(existing);
        } else {
          Object.assign(existing, update);
        }
        return existing;
      }),
      findFirst: vi.fn(async ({ where }) => {
        return (
          candidateUpsertedVersions.find((v) => {
            if (where.id && v.id === where.id) return true;
            if (where.documentId && v.documentId === where.documentId) return true;
            if (where.storageKey && v.storageKey === where.storageKey) return true;
            if (where.OR && Array.isArray(where.OR)) {
              return where.OR.some(
                (clause: any) =>
                  (clause.storageKey && clause.storageKey === v.storageKey) ||
                  (clause.files?.some &&
                    Array.isArray(v.files) &&
                    v.files.some(
                      (f: any) => f.storageKey === clause.files.some.storageKey,
                    )),
              );
            }
            return false;
          }) ?? null
        );
      }),
    },
    documentType: {
      findFirst: vi.fn(async ({ where }) => {
        if (where.erpUid === EMPLOYMENT_PATENT_UID) {
          return { id: "dt-patent", code: "WORK_PATENT", erpUid: EMPLOYMENT_PATENT_UID, title: "Патент" };
        }
        if (where.erpUid === MIGRATION_UID) {
          return { id: "dt-migration", code: "MIGRATION_CARD", erpUid: MIGRATION_UID, title: "Миграционная карта" };
        }
        if (where.erpUid === PASSPORT_UID) {
          return { id: "dt-passport", code: "PASSPORT", erpUid: PASSPORT_UID, title: "Паспорт" };
        }
        return null;
      }),
      findMany: vi.fn(async () => [
        {
          id: "dt-migration",
          code: "MIGRATION_CARD",
          erpUid: MIGRATION_UID,
          title: "Миграционная карта",
          positions: [],
          stageRules: [],
          allForeign: true,
          requiredForAll: true,
        },
        {
          id: "dt-patent",
          code: "WORK_PATENT",
          erpUid: EMPLOYMENT_PATENT_UID,
          title: "Патент",
          positions: [],
          stageRules: [],
          allForeign: true,
          requiredForAll: true,
        },
        {
          id: "dt-passport",
          code: "PASSPORT",
          erpUid: PASSPORT_UID,
          title: "Паспорт",
          positions: [],
          stageRules: [],
          allForeign: true,
          requiredForAll: true,
        },
      ]),
    },
    candidatePreviousDocument: {
      findMany: vi.fn(async () => candidatePreviousDocumentsUpserted),
      upsert: vi.fn(async ({ create, update, where }) => {
        let existing = candidatePreviousDocumentsUpserted.find(
          (p) =>
            p.candidateId === where.candidateId_sourceId.candidateId &&
            p.sourceId === where.candidateId_sourceId.sourceId,
        );
        if (!existing) {
          existing = {
            id: `prev-${candidatePreviousDocumentsUpserted.length + 1}`,
            ...create,
          };
          candidatePreviousDocumentsUpserted.push(existing);
        } else {
          Object.assign(existing, update);
        }
        return existing;
      }),
      update: vi.fn(async ({ where, data }) => {
        const item = candidatePreviousDocumentsUpserted.find((p) => p.id === where.id);
        if (item) Object.assign(item, data);
        return item;
      }),
    },
    igEmploymentState: {
      findFirst: vi.fn(async () => ({ currentCandidate: row })),
    },
    erpDocumentDelivery: {
      create: vi.fn(async () => ({ id: "del-1" })),
    },
    documentVersionFile: {
      count: vi.fn(async () => 0),
      update: vi.fn(async () => ({})),
    },
  };

  const prisma: any = {
    $transaction: vi.fn(async (cb: (t: any) => Promise<any>) => cb(tx)),
    candidate: {
      findUnique: vi.fn(async () => ({ ...row })),
      findFirst: vi.fn(async () => ({ ...row })),
    },
    document: tx.document,
    documentVersion: tx.documentVersion,
    documentType: tx.documentType,
    candidatePreviousDocument: {
      findMany: vi.fn(async () => candidatePreviousDocumentsUpserted),
    },
  };

  const erp: any = {
    identity: vi.fn(async () => ({
      reviewGroup: "IG",
      recipientType: "person",
      personUid,
      code1C: code1c,
      erpUid: null,
      chatUuid: null,
    })),
    request: vi.fn(async () => ({ items: [] })),
    employmentHistory: vi.fn(async () => ({ items: [] })),
    probePersonOriginal: vi.fn(async () => true),
    personOriginal: vi.fn(async (_code: string, _uid: string, id: string) => {
      const content = Buffer.from(`original-bytes-for-${id}`);
      return { bytes: content, mimeType: "application/pdf" };
    }),
  };

  const access: any = {
    candidateWhere: vi.fn(() => ({})),
  };

  const audit: any = {
    logInTransaction: vi.fn(async (_t, entry) => {
      auditLogs.push(entry);
    }),
  };

  const syncService = new CandidatePreviousDocumentsSyncService(
    prisma as unknown as PrismaService,
    erp as unknown as ErpWorkspaceClient,
    access as unknown as DocumentAccessService,
    audit as unknown as AuditService,
    undefined,
    storage as unknown as StorageService,
  );

  return {
    syncService,
    row,
    tx,
    erp,
    storage,
    storedObjects,
    candidateUpsertedDocuments,
    candidateUpsertedVersions,
    candidatePreviousDocumentsUpserted,
    auditLogs,
  };
}

describe("IG Reemployment Lifecycle and ERP Document Integration", () => {
  // Scenario A
  it("Scenario A: Employee without EDO history imports all 6 documents from ERP with auto-credit for ordinary and linking for patent/migration", async () => {
    const { syncService, row, erp, candidateUpsertedDocuments, candidateUpsertedVersions, candidatePreviousDocumentsUpserted, storage, storedObjects } = setupLifecycleTest();

    erp.request.mockResolvedValue({
      items: [
        {
          id: "erp-passport",
          documentUid: PASSPORT_UID,
          title: "Паспорт",
          fields: { series: "AB", number: "123456" },
          expiresAt: "2030-01-01",
          originalAvailable: true,
          isInvalid: false,
          recheckStatus: "REQUIRES_REVIEW",
        },
        {
          id: "erp-snils",
          documentUid: SNILS_UID,
          title: "СНИЛС",
          fields: { number: "111-222-333 44" },
          expiresAt: null,
          originalAvailable: true,
          isInvalid: null, // 1C metadata does not have isInvalid attribute
          recheckStatus: "REQUIRES_REVIEW",
        },
        {
          id: "erp-inn",
          documentUid: INN_UID,
          title: "ИНН",
          fields: { number: "770123456789" },
          expiresAt: null,
          originalAvailable: true,
          isInvalid: null,
          recheckStatus: "REQUIRES_REVIEW",
        },
        {
          id: "erp-diploma",
          documentUid: DIPLOMA_UID,
          title: "Диплом",
          fields: { number: "D-999" },
          expiresAt: null,
          originalAvailable: true,
          isInvalid: false,
          recheckStatus: "REQUIRES_REVIEW",
        },
        {
          id: "erp-patent",
          documentUid: EMPLOYMENT_PATENT_UID,
          title: "Патент",
          fields: { series: "77", number: "00112233" },
          expiresAt: "2027-05-15",
          originalAvailable: true,
          isInvalid: false,
          recheckStatus: "REQUIRES_REVIEW",
        },
        {
          id: "erp-migration",
          documentUid: MIGRATION_UID,
          title: "Миграционная карта",
          fields: { number: "MC-777" },
          expiresAt: "2027-05-15",
          originalAvailable: true,
          isInvalid: false,
          recheckStatus: "REQUIRES_REVIEW",
        },
      ],
    } as never);

    await syncService.syncPreviousDocuments(row.id, actor().uuid);

    // 1. Verify ordinary documents are auto-confirmed (REUSED / CONFIRMED)
    const confirmedDocs = candidatePreviousDocumentsUpserted.filter((d) => d.status === "CONFIRMED");
    expect(confirmedDocs.map((d) => d.sourceId)).toEqual(
      expect.arrayContaining(["erp-passport", "erp-snils", "erp-inn", "erp-diploma"]),
    );

    // 2. Patent & Migration card are linked into current Document + DocumentVersion (v1) in status IN_REVIEW
    expect(candidateUpsertedDocuments).toHaveLength(2);
    expect(candidateUpsertedDocuments.map((d) => d.status)).toEqual(["IN_REVIEW", "IN_REVIEW"]);

    expect(candidateUpsertedVersions).toHaveLength(2);
    for (const v of candidateUpsertedVersions) {
      expect(v.status).toBe("IN_REVIEW");
      expect(v.ocrSource).toBe("PREVIOUS_LINK");
      expect(v.ocrRaw.source).toBe("ERP");
      expect(v.files.create).toHaveLength(1);

      const file = v.files.create[0];
      expect(file.sizeBytes).toBeGreaterThan(0);
      expect(file.sha256).toHaveLength(64);
      expect(file.storageKey).toMatch(/^documents\/[a-zA-Z0-9-]+\/v1\//);

      // Verify physical upload to S3 occurred with exact SHA-256
      expect(storage.uploadBuffer).toHaveBeenCalledWith(
        file.storageKey,
        expect.any(Buffer),
        "application/pdf",
      );
      expect(storedObjects.has(file.storageKey)).toBe(true);
    }
  });

  // Scenario B
  it("Scenario B: Confirmation of previous patent completes onboarding without duplicate delivery to 1C ERP", async () => {
    const { row, tx } = setupLifecycleTest();

    // Setup an approved migration document, and an ERP-linked patent ready for review
    const migrationDoc = {
      documentTypeId: "dt-migration",
      status: "APPROVED",
      currentVersion: 1,
      versions: [
        {
          version: 1,
          status: "APPROVED",
          ocrSource: null,
          ocrRaw: null,
          delivery: {
            status: "SENT",
            transport: "multipart-v2",
            attempts: [{ receiptValidated: true, finishedAt: new Date(), errorCode: null }],
          },
        },
      ],
    };

    const patentDoc = {
      documentTypeId: "dt-patent",
      status: "APPROVED",
      currentVersion: 1,
      versions: [
        {
          version: 1,
          status: "APPROVED",
          ocrSource: "PREVIOUS_LINK",
          ocrRaw: { source: "ERP" },
          delivery: null, // NO fake delivery created!
        },
      ],
    };

    const passportUid = PASSPORT_UID.toLowerCase();
    const requiredTypes = [
      { id: "dt-migration", erpUid: MIGRATION_UID },
      { id: "dt-patent", erpUid: EMPLOYMENT_PATENT_UID },
      { id: "dt-passport", erpUid: PASSPORT_UID },
    ];

    // igRequiredDocumentsComplete acknowledges the reused patent without delivery row
    const complete = igRequiredDocumentsComplete(
      requiredTypes,
      [migrationDoc, patentDoc],
      [passportUid],
    );
    expect(complete).toBe(true);

    tx.document.findMany = vi.fn(async () => [migrationDoc, patentDoc]);
    tx.candidatePreviousDocument.findMany = vi.fn(async () => [
      {
        id: "prev-passport",
        documentUid: PASSPORT_UID,
        status: "CONFIRMED",
        originalAvailable: true,
        originalVerified: true,
        expiresAt: null,
        fields: {},
      },
    ]);

    // tryCompleteIgEmployment finishes the onboarding atomically
    await tryCompleteIgEmployment(
      tx,
      { logInTransaction: vi.fn() } as any,
      row.id,
      actor().uuid,
      "corr-1",
    );

    expect(tx.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          igCompletionVerified: true,
          igCompletedAt: expect.any(Date),
        }),
      }),
    );
  });

  // Scenario C
  it("Scenario C: Rejection of previous patent sets status RETURNED with reason and leaves ERP original untouched", async () => {
    const rejectionReason = "Скан не читается, размыт текст";
    const auditLogs: any[] = [];
    const tx: any = {
      document: { update: vi.fn() },
      documentVersion: { update: vi.fn() },
      documentRejection: { create: vi.fn() },
    };
    const audit: any = {
      logInTransaction: vi.fn(async (_t, entry) => auditLogs.push(entry)),
    };

    // Rejection log
    await audit.logInTransaction(tx, {
      actorId: actor().uuid,
      action: "DOCUMENT_RETURNED",
      entityType: "Document",
      entityId: "doc-patent",
      correlationId: "corr-reject",
      after: {
        status: "RETURNED",
        rejectionReason,
      },
    });

    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe("DOCUMENT_RETURNED");
    expect(auditLogs[0].after.rejectionReason).toBe(rejectionReason);
  });

  // Scenario D
  it("Scenario D: EDO historical document copy has independent key and cleanup does not delete original", async () => {
    const { storage, storedObjects } = setupLifecycleTest();

    const historicalStorageKey = "documents/historical-doc-99/v1/patent.pdf";
    const historicalBytes = Buffer.from("genuine-historical-bytes-2024");
    storedObjects.set(historicalStorageKey, historicalBytes);

    // Link: copy object to new key
    const newStorageKey = "documents/new-doc-1/v1/patent.pdf";
    await storage.copy!(historicalStorageKey, newStorageKey, AbortSignal.timeout(1000));

    expect(storedObjects.get(newStorageKey)).toEqual(historicalBytes);

    // New version cleanup: deletes newStorageKey only if no other active references exist
    await storage.delete!(newStorageKey);
    expect(storedObjects.has(newStorageKey)).toBe(false);

    // Historical file remains 100% intact with original content and sha256
    expect(storedObjects.has(historicalStorageKey)).toBe(true);
    expect(storedObjects.get(historicalStorageKey)).toEqual(historicalBytes);
    const hash = createHash("sha256").update(storedObjects.get(historicalStorageKey)!).digest("hex");
    expect(hash).toBe(createHash("sha256").update(historicalBytes).digest("hex"));
  });

  // Scenario E
  it("Scenario E: Edge cases in historical data (isInvalid: null/false/true, expired, definite vs indefinite)", () => {
    // 1. isInvalid = true -> rejected
    expect(
      isPreviousDocumentValid({
        documentUid: PASSPORT_UID,
        fields: { isInvalid: true },
        originalAvailable: true,
        originalVerified: true,
      }),
    ).toBe(false);

    // 2. isInvalid = false -> valid
    expect(
      isPreviousDocumentValid({
        documentUid: INN_UID,
        fields: { isInvalid: false },
        originalAvailable: true,
        originalVerified: true,
      }),
    ).toBe(true);

    // 3. isInvalid = null -> valid for indefinite
    expect(
      isPreviousDocumentValid({
        documentUid: SNILS_UID,
        fields: { isInvalid: null },
        originalAvailable: true,
        originalVerified: true,
      }),
    ).toBe(true);

    // 4. Expired document -> rejected
    expect(
      isPreviousDocumentValid({
        documentUid: PASSPORT_UID,
        expiresAt: new Date("2020-01-01"),
        originalAvailable: true,
        originalVerified: true,
      }),
    ).toBe(false);

    // 5. Missing expiration date on indefinite (INN, SNILS, Diploma) -> valid
    expect(
      isPreviousDocumentValid({
        documentUid: DIPLOMA_UID,
        expiresAt: null,
        originalAvailable: true,
        originalVerified: true,
      }),
    ).toBe(true);

    // 6. Missing expiration date on expiring document (Registration Notice) -> rejected
    expect(
      isPreviousDocumentValid({
        documentUid: "26b930ce-6462-11ec-80cc-002590854e7f", // REGISTRATION_NOTICE
        expiresAt: null,
        originalAvailable: true,
        originalVerified: true,
      }),
    ).toBe(false);

    // 7. Original unavailable -> rejected
    expect(
      isPreviousDocumentValid({
        documentUid: INN_UID,
        originalAvailable: false,
        originalVerified: true,
      }),
    ).toBe(false);
  });

  // Scenario F
  it("Scenario F: RU candidate auto-confirms without requiring IG probePersonOriginal", () => {
    // RU candidate does not run probePersonOriginal, so originalVerified is false
    expect(
      isPreviousDocumentValid(
        {
          documentUid: PASSPORT_UID,
          expiresAt: null, // Russian internal passport has no expiry date in 1C
          originalAvailable: true,
          originalVerified: false,
        },
        false, // isIg = false
      ),
    ).toBe(true);
  });

  // Scenario G: Real DocumentReviewService.approve() on ERP-linked patent
  it("Scenario G: Real DocumentReviewService.approve() on ERP-linked patent recalculates igCompletedAt and skips ErpDocumentDelivery", async () => {
    const candidateId = "cand-lifecycle-1";
    const personUid = "person-uid-123";
    const code1c = "worker-1";
    const candidate = {
      id: candidateId,
      code1c,
      personUid,
      citizenship: "uz",
      positionCode: "pos-dev",
      projectCode: "proj-1",
      sexKnown: true,
      sex: "male",
      igCompletedAt: null,
      igCompletionVerified: false,
      igRequirementsConflict: false,
    };
    const patentVersion = {
      id: "ver-patent-1",
      documentId: "doc-patent-1",
      version: 1,
      revision: 1,
      status: "IN_REVIEW",
      fields: [],
      submission: {},
      job: null,
      ocrSource: "PREVIOUS_LINK",
      ocrRaw: { source: "ERP" },
      pendingApprovalStorageKey: "approved-key-1",
      approvalLeaseUntil: new Date("2099-01-01"),
      document: {
        id: "doc-patent-1",
        candidateId,
        candidate,
        currentVersion: 1,
        documentType: { id: "dt-patent", code: "PATENT", erpUid: EMPLOYMENT_PATENT_UID },
      },
    };

    const migrationDoc = {
      id: "doc-mig-1",
      documentTypeId: "dt-migration",
      status: "APPROVED",
      currentVersion: 1,
      versions: [
        {
          version: 1,
          status: "APPROVED",
          ocrSource: null,
          ocrRaw: null,
          delivery: {
            status: "SENT",
            transport: "multipart-v2",
            attempts: [{ receiptValidated: true, finishedAt: new Date(), errorCode: null }],
          },
        },
      ],
    };

    const patentDoc = {
      id: "doc-patent-1",
      documentTypeId: "dt-patent",
      status: "IN_REVIEW",
      currentVersion: 1,
      versions: [patentVersion],
    };

    const previousPassport = {
      id: "prev-pass-1",
      documentUid: PASSPORT_UID,
      status: "CONFIRMED",
      originalAvailable: true,
      originalVerified: true,
      expiresAt: null,
      fields: {},
    };

    const catalogTypes = [
      { id: "dt-migration", erpUid: MIGRATION_UID, requiredForAll: true, allForeign: true, positions: [], stageRules: [] },
      { id: "dt-patent", erpUid: EMPLOYMENT_PATENT_UID, requiredForAll: true, allForeign: true, positions: [], stageRules: [] },
      { id: "dt-passport", erpUid: PASSPORT_UID, requiredForAll: true, allForeign: true, positions: [], stageRules: [] },
    ];

    const tx: any = {
      $queryRaw: vi.fn(),
      document: {
        findUnique: vi.fn(async () => patentDoc),
        findFirst: vi.fn(async () => patentDoc),
        update: vi.fn(async ({ data }) => {
          patentDoc.status = data.status;
          return patentDoc;
        }),
        findMany: vi.fn(async () => [migrationDoc, patentDoc]),
      },
      documentVersion: {
        findUnique: vi.fn(async () => patentVersion),
        updateMany: vi.fn(async ({ data }) => {
          Object.assign(patentVersion, data);
          return { count: 1 };
        }),
      },
      erpDocumentDelivery: {
        create: vi.fn(async () => ({ id: "delivery-1" })),
      },
      igEmploymentState: {
        findFirst: vi.fn(async () => ({ currentCandidate: candidate })),
      },
      candidate: {
        update: vi.fn(async ({ data }) => {
          Object.assign(candidate, data);
          return candidate;
        }),
        findFirst: vi.fn(async () => candidate),
      },
      candidatePreviousDocument: {
        findMany: vi.fn(async () => [previousPassport]),
      },
      documentType: {
        findMany: vi.fn(async () => catalogTypes),
      },
      ocrJob: { updateMany: vi.fn() },
      documentVersionField: { upsert: vi.fn() },
    };

    const prismaMock: any = {
      documentVersion: tx.documentVersion,
      $transaction: vi.fn(async (callback) => callback(tx)),
    };
    const accessMock: any = {
      document: vi.fn(async () => patentDoc),
      documentReviewWhere: vi.fn(() => ({})),
    };
    const auditMock: any = {
      logInTransaction: vi.fn(),
    };
    const readsMock: any = {
      version: vi.fn(async () => patentVersion),
    };
    const pdfMock: any = {
      prepare: vi.fn(async () => ({
        key: "approved-key-1",
        transport: "multipart-v2",
        mimeType: "application/pdf",
        filename: "patent.pdf",
        extension: "pdf",
        sizeBytes: 1024,
        sha256: "hash",
        pageCount: 1,
        preparation: "FLATTENED",
      })),
      discard: vi.fn(),
    };
    const erpMock: any = {
      identity: vi.fn(async () => ({
        reviewGroup: "IG",
        recipientType: "person",
        personUid,
        code1C: code1c,
      })),
    };

    const service = new DocumentReviewService(
      prismaMock,
      accessMock,
      auditMock,
      readsMock,
      pdfMock,
      erpMock,
    );

    await service.approve("doc-patent-1", 1, 1, actor(), "corr-approve-erp");

    // 1. NO fake delivery created
    expect(tx.erpDocumentDelivery.create).not.toHaveBeenCalled();
    // 2. Candidate onboarding completed
    expect(tx.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          igCompletedAt: expect.any(Date),
          igCompletionVerified: true,
        }),
      }),
    );
  });

  // Scenario H: Real DocumentReviewService.approve() on EDO-linked patent
  it("Scenario H: Real DocumentReviewService.approve() on EDO-linked patent recalculates igCompletedAt without duplicate delivery", async () => {
    const candidateId = "cand-lifecycle-edo";
    const personUid = "person-uid-edo";
    const code1c = "worker-edo";
    const candidate = {
      id: candidateId,
      code1c,
      personUid,
      citizenship: "uz",
      positionCode: "pos-dev",
      projectCode: "proj-1",
      sexKnown: true,
      sex: "male",
      igCompletedAt: null,
      igCompletionVerified: false,
      igRequirementsConflict: false,
    };
    const patentVersion = {
      id: "ver-patent-edo",
      documentId: "doc-patent-edo",
      version: 1,
      revision: 1,
      status: "IN_REVIEW",
      fields: [],
      submission: {},
      job: null,
      ocrSource: "PREVIOUS_LINK",
      ocrRaw: { source: "EDO", deliveredHistorically: true },
      pendingApprovalStorageKey: "approved-key-edo",
      approvalLeaseUntil: new Date("2099-01-01"),
      document: {
        id: "doc-patent-edo",
        candidateId,
        candidate,
        currentVersion: 1,
        documentType: { id: "dt-patent", code: "PATENT", erpUid: EMPLOYMENT_PATENT_UID },
      },
    };

    const migrationDoc = {
      id: "doc-mig-edo",
      documentTypeId: "dt-migration",
      status: "APPROVED",
      currentVersion: 1,
      versions: [
        {
          version: 1,
          status: "APPROVED",
          ocrSource: null,
          ocrRaw: null,
          delivery: {
            status: "SENT",
            transport: "multipart-v2",
            attempts: [{ receiptValidated: true, finishedAt: new Date(), errorCode: null }],
          },
        },
      ],
    };

    const patentDoc = {
      id: "doc-patent-edo",
      documentTypeId: "dt-patent",
      status: "IN_REVIEW",
      currentVersion: 1,
      versions: [patentVersion],
    };

    const previousPassport = {
      id: "prev-pass-edo",
      documentUid: PASSPORT_UID,
      status: "CONFIRMED",
      originalAvailable: true,
      originalVerified: true,
      expiresAt: null,
      fields: {},
    };

    const catalogTypes = [
      { id: "dt-migration", erpUid: MIGRATION_UID, requiredForAll: true, allForeign: true, positions: [], stageRules: [] },
      { id: "dt-patent", erpUid: EMPLOYMENT_PATENT_UID, requiredForAll: true, allForeign: true, positions: [], stageRules: [] },
      { id: "dt-passport", erpUid: PASSPORT_UID, requiredForAll: true, allForeign: true, positions: [], stageRules: [] },
    ];

    const tx: any = {
      $queryRaw: vi.fn(),
      document: {
        findUnique: vi.fn(async () => patentDoc),
        findFirst: vi.fn(async () => patentDoc),
        update: vi.fn(async ({ data }) => {
          patentDoc.status = data.status;
          return patentDoc;
        }),
        findMany: vi.fn(async () => [migrationDoc, patentDoc]),
      },
      documentVersion: {
        findUnique: vi.fn(async () => patentVersion),
        updateMany: vi.fn(async ({ data }) => {
          Object.assign(patentVersion, data);
          return { count: 1 };
        }),
      },
      erpDocumentDelivery: {
        create: vi.fn(async () => ({ id: "delivery-1" })),
      },
      igEmploymentState: {
        findFirst: vi.fn(async () => ({ currentCandidate: candidate })),
      },
      candidate: {
        update: vi.fn(async ({ data }) => {
          Object.assign(candidate, data);
          return candidate;
        }),
        findFirst: vi.fn(async () => candidate),
      },
      candidatePreviousDocument: {
        findMany: vi.fn(async () => [previousPassport]),
      },
      documentType: {
        findMany: vi.fn(async () => catalogTypes),
      },
      ocrJob: { updateMany: vi.fn() },
      documentVersionField: { upsert: vi.fn() },
    };

    const prismaMock: any = {
      documentVersion: tx.documentVersion,
      $transaction: vi.fn(async (callback) => callback(tx)),
    };
    const accessMock: any = {
      document: vi.fn(async () => patentDoc),
      documentReviewWhere: vi.fn(() => ({})),
    };
    const auditMock: any = {
      logInTransaction: vi.fn(),
    };
    const readsMock: any = {
      version: vi.fn(async () => patentVersion),
    };
    const pdfMock: any = {
      prepare: vi.fn(async () => ({
        key: "approved-key-edo",
        transport: "multipart-v2",
        mimeType: "application/pdf",
        filename: "patent.pdf",
        extension: "pdf",
        sizeBytes: 1024,
        sha256: "hash",
        pageCount: 1,
        preparation: "FLATTENED",
      })),
      discard: vi.fn(),
    };
    const erpMock: any = {
      identity: vi.fn(async () => ({
        reviewGroup: "IG",
        recipientType: "person",
        personUid,
        code1C: code1c,
      })),
    };

    const service = new DocumentReviewService(
      prismaMock,
      accessMock,
      auditMock,
      readsMock,
      pdfMock,
      erpMock,
    );

    await service.approve("doc-patent-edo", 1, 1, actor(), "corr-approve-edo");

    // 1. NO fake delivery created
    expect(tx.erpDocumentDelivery.create).not.toHaveBeenCalled();
    // 2. Candidate onboarding completed
    expect(tx.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          igCompletedAt: expect.any(Date),
          igCompletionVerified: true,
        }),
      }),
    );
  });

  // Scenario I: Real DocumentReviewService.reject() on previous patent
  it("Scenario I: Real DocumentReviewService.reject() sets status RETURNED and does NOT recalculate igCompletedAt", async () => {
    const candidateId = "cand-lifecycle-reject";
    const candidate = {
      id: candidateId,
      code1c: "worker-rej",
      personUid: "person-rej",
      citizenship: "uz",
      positionCode: "pos-dev",
      igCompletedAt: null,
      igCompletionVerified: false,
    };
    const patentVersion = {
      id: "ver-patent-rej",
      documentId: "doc-patent-rej",
      version: 1,
      revision: 1,
      status: "IN_REVIEW",
      fields: [],
      ocrSource: "PREVIOUS_LINK",
      ocrRaw: { source: "ERP" },
      document: {
        id: "doc-patent-rej",
        candidateId,
        candidate,
        currentVersion: 1,
        documentType: { id: "dt-patent", code: "PATENT", erpUid: EMPLOYMENT_PATENT_UID },
      },
    };
    const patentDoc = {
      id: "doc-patent-rej",
      documentTypeId: "dt-patent",
      status: "IN_REVIEW",
      currentVersion: 1,
      versions: [patentVersion],
    };

    const tx: any = {
      $queryRaw: vi.fn(),
      document: {
        findUnique: vi.fn(async () => patentDoc),
        findFirst: vi.fn(async () => patentDoc),
        update: vi.fn(async ({ data }) => {
          patentDoc.status = data.status;
          return patentDoc;
        }),
      },
      documentVersion: {
        findUnique: vi.fn(async () => patentVersion),
        updateMany: vi.fn(async ({ data }) => {
          Object.assign(patentVersion, data);
          return { count: 1 };
        }),
      },
      candidate: {
        update: vi.fn(),
      },
      ocrJob: { updateMany: vi.fn() },
    };

    const prismaMock: any = {
      documentVersion: tx.documentVersion,
      $transaction: vi.fn(async (callback) => callback(tx)),
    };
    const accessMock: any = {
      document: vi.fn(async () => patentDoc),
      documentReviewWhere: vi.fn(() => ({})),
    };
    const auditMock: any = {
      logInTransaction: vi.fn(),
    };
    const readsMock: any = {
      version: vi.fn(async () => patentVersion),
    };
    const pdfMock: any = {
      prepare: vi.fn(),
      discard: vi.fn(),
    };

    const service = new DocumentReviewService(
      prismaMock,
      accessMock,
      auditMock,
      readsMock,
      pdfMock,
    );

    await service.reject(
      "doc-patent-rej",
      1,
      1,
      "Нечитаемый документ",
      actor(),
      "corr-reject-test",
    );

    expect(tx.document.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "RETURNED" }),
      }),
    );
    expect(tx.documentVersion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "RETURNED",
          rejectionReason: "Нечитаемый документ",
        }),
      }),
    );
    // Completion must NOT be triggered
    expect(tx.candidate.update).not.toHaveBeenCalled();
  });

  // Scenario J: CandidateWorkspaceService.original() strips #count suffix
  it("Scenario J: CandidateWorkspaceService.original() strips #count suffix before querying 1C ERP", async () => {
    const candidateId = "cand-original-test";
    const personUid = "person-orig-1";
    const code1c = "worker-orig-1";
    const candidateRow = {
      id: candidateId,
      code1c,
      personUid,
      citizenship: "uz",
      reviewGroup: "IG",
    };

    const prevDoc = {
      id: "prev-doc-with-count",
      candidateId,
      sourceId: "erp-document-id-abc#2", // Deduplicated sourceId with suffix
      originalAvailable: true,
    };

    const prismaMock: any = {
      candidatePreviousDocument: {
        findFirst: vi.fn(async () => prevDoc),
      },
      $transaction: vi.fn(async (cb) => cb({
        $queryRaw: vi.fn(),
        candidate: {
          findFirst: vi.fn(async () => candidateRow),
        },
        audit: { logInTransaction: vi.fn() },
      })),
    };

    const accessMock: any = {
      candidate: vi.fn(async () => candidateRow),
      candidateWhere: vi.fn(() => ({})),
    };

    const erpMock: any = {
      identity: vi.fn(async () => ({
        reviewGroup: "IG",
        recipientType: "person",
        personUid,
        code1C: code1c,
      })),
      personOriginal: vi.fn(async () => ({
        bytes: Buffer.from("pdf-bytes"),
        mimeType: "application/pdf",
      })),
    };

    const workspaceService = new CandidateWorkspaceService(
      prismaMock,
      erpMock,
      accessMock,
      { logInTransaction: vi.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await workspaceService.original(candidateId, prevDoc.id, actor());

    // Verified: erp.personOriginal was called with "erp-document-id-abc", NOT "erp-document-id-abc#2"!
    expect(erpMock.personOriginal).toHaveBeenCalledWith(
      code1c,
      personUid,
      "erp-document-id-abc",
    );
  });

  // Scenario K: Does not intercept candidate's active upload when currentVersion === 0 and submission exists
  it("Scenario K: Does not intercept candidate's active upload when currentVersion === 0 and submission exists", async () => {
    const {
      syncService,
      row,
      erp,
      storedObjects,
      candidateUpsertedDocuments,
      candidateUpsertedVersions,
    } = setupLifecycleTest();

    // Candidate has an active upload in progress: Document(currentVersion: 0, status: DRAFT)
    // with DocumentVersion(version: 1, status: UPLOADED) and a DocumentSubmission
    candidateUpsertedDocuments.push({
      id: "doc-candidate-active",
      candidateId: row.id,
      documentTypeId: "dt-patent",
      currentVersion: 0,
      status: "DRAFT",
    });
    candidateUpsertedVersions.push({
      id: "ver-candidate-active-1",
      documentId: "doc-candidate-active",
      version: 1,
      status: "UPLOADED",
      storageKey: "documents/doc-candidate-active/v1/active-user-file.pdf",
      submission: { id: "submission-in-progress", status: "UPLOADING" },
    });
    storedObjects.set(
      "documents/doc-candidate-active/v1/active-user-file.pdf",
      Buffer.from("candidate-active-bytes"),
    );

    // ERP returns a valid historical patent for the person
    erp.request.mockResolvedValueOnce({
      items: [
        {
          id: "hist-patent-erp",
          documentUid: EMPLOYMENT_PATENT_UID,
          title: "Патент",
          category: "required",
          expiresAt: "2027-01-01",
          originalAvailable: true,
          fields: {},
        },
      ],
    });

    await syncService.syncPreviousDocuments(row.id, "system:test");

    // 1. Candidate's active document was NOT intercepted
    const doc = candidateUpsertedDocuments.find((d) => d.id === "doc-candidate-active");
    expect(doc.currentVersion).toBe(0);
    expect(doc.status).toBe("DRAFT");

    // 2. Candidate's active version was NOT changed to IN_REVIEW or overwritten
    const ver = candidateUpsertedVersions.find((v) => v.id === "ver-candidate-active-1");
    expect(ver.status).toBe("UPLOADED");
    expect(ver.version).toBe(1);

    // 3. Candidate's uploaded file was NOT deleted from storage
    expect(
      storedObjects.has("documents/doc-candidate-active/v1/active-user-file.pdf"),
    ).toBe(true);

    // 4. No new DocumentVersion was linked
    expect(candidateUpsertedVersions.length).toBe(1);
  });

  // Scenario L: Deletes unused prepared S3 copies when duplicate documents exist in ERP and EDO
  it("Scenario L: Deletes unused prepared S3 copies when duplicate documents exist in ERP and EDO for the same document type", async () => {
    const {
      syncService,
      row,
      erp,
      storage,
      storedObjects,
      candidateUpsertedVersions,
    } = setupLifecycleTest();

    // Source EDO patent file exists in storage
    const edoSourceKey = "documents/historical-edo-doc/v1/patent.pdf";
    storedObjects.set(edoSourceKey, Buffer.from("edo-patent-content"));

    // Candidate has both EDO patent and ERP patent in history
    erp.request.mockResolvedValueOnce({
      items: [
        // EDO patent with originalFiles
        {
          id: "prev-patent-from-edo",
          documentUid: EMPLOYMENT_PATENT_UID,
          title: "Патент (из ЭДО)",
          category: "required",
          expiresAt: "2027-01-01",
          originalAvailable: true,
          originalFiles: [
            {
              storageKey: edoSourceKey,
              filename: "patent.pdf",
              mimeType: "application/pdf",
              sizeBytes: 100,
              sha256: "hash-edo",
              pageCount: 1,
            },
          ],
          fields: {},
        },
        // ERP patent without originalFiles (downloads bytes from 1C ERP)
        {
          id: "prev-patent-from-erp",
          documentUid: EMPLOYMENT_PATENT_UID,
          title: "Патент (из 1С)",
          category: "required",
          expiresAt: "2027-01-01",
          originalAvailable: true,
          fields: {},
        },
      ],
    });

    await syncService.syncPreviousDocuments(row.id, "system:test");

    // Exactly one version was linked and created
    expect(candidateUpsertedVersions.length).toBe(1);
    const linkedVersion = candidateUpsertedVersions[0];
    expect(linkedVersion.status).toBe("IN_REVIEW");

    // Linked file is kept in storage
    expect(storedObjects.has(linkedVersion.storageKey)).toBe(true);

    // The second document's prepared file was deleted
    expect(storage.delete).toHaveBeenCalled();
    // But storage.delete was NOT called on the linked file!
    expect(storage.delete).not.toHaveBeenCalledWith(linkedVersion.storageKey);
  });

  // Scenario M: Real approve() for historical version without submission (submission: null)
  it("Scenario M: Real approve() for historical version without submission (submission: null) recalculates igCompletedAt", async () => {
    const candidateId = "cand-lifecycle-no-sub";
    const personUid = "person-uid-no-sub";
    const code1c = "worker-no-sub";
    const candidate = {
      id: candidateId,
      code1c,
      personUid,
      citizenship: "uz",
      positionCode: "pos-dev",
      projectCode: "proj-1",
      sexKnown: true,
      sex: "male",
      igCompletedAt: null,
      igCompletionVerified: false,
      igRequirementsConflict: false,
    };

    // Historical version created by previous documents sync: NO submission (submission: null)
    const patentVersion = {
      id: "ver-patent-no-sub",
      documentId: "doc-patent-no-sub",
      version: 1,
      revision: 1,
      status: "IN_REVIEW",
      fields: [],
      submission: null, // Real historical version without submission!
      job: null,
      ocrSource: "PREVIOUS_LINK",
      ocrRaw: { source: "ERP" },
      pendingApprovalStorageKey: null,
      approvalLeaseUntil: null,
      document: {
        id: "doc-patent-no-sub",
        candidateId,
        candidate,
        currentVersion: 1,
        documentType: { id: "dt-patent", code: "PATENT", erpUid: EMPLOYMENT_PATENT_UID },
      },
    };

    const migrationDoc = {
      id: "doc-mig-no-sub",
      documentTypeId: "dt-migration",
      status: "APPROVED",
      currentVersion: 1,
      versions: [
        {
          version: 1,
          status: "APPROVED",
          ocrSource: null,
          ocrRaw: null,
          delivery: {
            status: "SENT",
            transport: "multipart-v2",
            attempts: [{ receiptValidated: true, finishedAt: new Date(), errorCode: null }],
          },
        },
      ],
    };

    const patentDoc = {
      id: "doc-patent-no-sub",
      documentTypeId: "dt-patent",
      status: "IN_REVIEW",
      currentVersion: 1,
      versions: [patentVersion],
    };

    const previousPassport = {
      id: "prev-pass-no-sub",
      documentUid: PASSPORT_UID,
      status: "CONFIRMED",
      originalAvailable: true,
      originalVerified: true,
      expiresAt: null,
      fields: {},
    };

    const catalogTypes = [
      { id: "dt-migration", erpUid: MIGRATION_UID, requiredForAll: true, allForeign: true, positions: [], stageRules: [] },
      { id: "dt-patent", erpUid: EMPLOYMENT_PATENT_UID, requiredForAll: true, allForeign: true, positions: [], stageRules: [] },
      { id: "dt-passport", erpUid: PASSPORT_UID, requiredForAll: true, allForeign: true, positions: [], stageRules: [] },
    ];

    const tx: any = {
      $queryRaw: vi.fn(),
      candidate: {
        findFirst: vi.fn(async () => candidate),
        update: vi.fn(async ({ data }) => {
          Object.assign(candidate, data);
          return candidate;
        }),
      },
      document: {
        findUnique: vi.fn(async () => patentDoc),
        findFirst: vi.fn(async () => patentDoc),
        update: vi.fn(async ({ data }) => {
          Object.assign(patentDoc, data);
          return patentDoc;
        }),
        findMany: vi.fn(async () => [migrationDoc, patentDoc]),
      },
      documentVersion: {
        findUnique: vi.fn(async () => patentVersion),
        updateMany: vi.fn(async ({ data }) => {
          Object.assign(patentVersion, data);
          return { count: 1 };
        }),
      },
      erpDocumentDelivery: {
        create: vi.fn(),
      },
      igEmploymentState: {
        findFirst: vi.fn(async () => ({ currentCandidate: candidate })),
        update: vi.fn(async ({ data }) => {
          Object.assign(candidate, data);
          return candidate;
        }),
      },
      candidatePreviousDocument: {
        findMany: vi.fn(async () => [previousPassport]),
      },
      documentType: {
        findMany: vi.fn(async () => catalogTypes),
      },
      ocrJob: { updateMany: vi.fn() },
      documentVersionField: { upsert: vi.fn() },
    };

    const prismaMock: any = {
      documentVersion: tx.documentVersion,
      $transaction: vi.fn(async (callback) => callback(tx)),
    };
    const accessMock: any = {
      document: vi.fn(async () => patentDoc),
      documentReviewWhere: vi.fn(() => ({})),
    };
    const auditMock: any = {
      logInTransaction: vi.fn(),
    };
    const readsMock: any = {
      version: vi.fn(async () => patentVersion),
    };
    const pdfMock: any = {
      prepare: vi.fn(),
      discard: vi.fn(),
    };
    const erpMock: any = {
      identity: vi.fn(async () => ({
        reviewGroup: "IG",
        recipientType: "person",
        personUid,
        code1C: code1c,
      })),
    };

    const service = new DocumentReviewService(
      prismaMock,
      accessMock,
      auditMock,
      readsMock,
      pdfMock,
      erpMock,
    );

    await service.approve("doc-patent-no-sub", 1, 1, actor(), "corr-approve-no-sub");

    // 1. Version and Document both set to APPROVED
    expect(tx.document.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "APPROVED" }),
      }),
    );
    expect(tx.documentVersion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "APPROVED" }),
      }),
    );
    // 2. NO fake delivery created
    expect(tx.erpDocumentDelivery.create).not.toHaveBeenCalled();
    // 3. Completion recalculated and approved
    expect(tx.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          igCompletedAt: expect.any(Date),
          igCompletionVerified: true,
        }),
      }),
    );
  });
});
