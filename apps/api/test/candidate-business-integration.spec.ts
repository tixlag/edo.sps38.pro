import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { AuditService } from "../src/audit/audit.service";
import { ManualDocumentService } from "../src/documents/manual-document.service";
import { DocumentReviewService } from "../src/documents/document-review.service";
import { DocumentAccessService } from "../src/documents/document-access.service";
import { CandidateContextService } from "../src/documents/candidate-context.service";
import { CandidateDocumentsService } from "../src/documents/candidate-documents.service";
import {
  candidateIdentityTransaction,
  resolveCandidateIdentity,
} from "../src/documents/candidate-identity";
import type { AuthPrincipal } from "../src/auth/auth-principal";
import type { StagedUpload } from "../src/documents/document-upload.service";
const db = process.env.EDO_TEST_DATABASE_URL;
if (db && !/^mysql:\/\/root:isolated-test@127\.0\.0\.1:3308\/edo$/.test(db))
  throw new Error("Refuse non-isolated DB");
const suite = describe.skipIf(!db);
const principal = (...rules: string[]): AuthPrincipal => ({
  uuid: "test-reviewer",
  code1c: null,
  sid: null,
  deviceId: null,
  expiresAt: null,
  accessRules: Object.fromEntries(rules.map((r) => [r, []])),
});
suite("confirmed candidate business identity on disposable MariaDB", () => {
  let prisma: PrismaService,
    manual: ManualDocumentService,
    access: DocumentAccessService;
  const typeUid = randomUUID(),
    chat = randomUUID(),
    erpUid = randomUUID(),
    personUid = randomUUID(),
    employee = `test-${randomUUID()}`;
  const ids = new Set<string>();
  let current = {
    recipientType: "candidate",
    reviewGroup: "RU",
    erpUid,
    chatUuid: chat,
    personUid,
    code1C: employee,
  };
  const erp = {
    resolveIdentityByChat: vi.fn(async () => erpUid),
    resolveCurrentIdentity: vi.fn(async () => current),
    workspaceCard: vi.fn(async () => ({
      erpUid,
      chatUuid: chat,
      code1C: employee,
      personUid,
      reviewGroup: "RU",
      fullName: "Synthetic",
      birthDate: "1990-01-01",
      citizenship: "ru",
      position: { code: "TEST", name: "Position" },
      project: null,
    })),
    findByEmployeeCode: vi.fn(async () => ({
      uuid: null,
      position: { code: "TEST" },
      citizenship: "uz",
    })),
  };
  const stage = (code?: string, uuid?: string): StagedUpload => ({
    directory: "unused",
    documentTypeCode: "unused",
    metadata: {
      documentUid: typeUid,
      ...(code ? { code_1c: code } : {}),
      ...(uuid ? { chat_uuid: uuid } : {}),
      position_code_1c: "TEST",
      citizenship: "ru",
      documentFields: {},
    },
    files: [
      {
        id: randomUUID(),
        ordinal: 0,
        filename: "synthetic.pdf",
        mimeType: "application/pdf",
        path: "unused",
        sizeBytes: 4,
        sha256: "a".repeat(64),
        pageCount: 1,
      },
    ],
  });
  beforeAll(async () => {
    prisma = new PrismaService({ datasourceUrl: db });
    const audit = new AuditService(prisma);
    access = new DocumentAccessService(prisma);
    await prisma.documentType.create({
      data: {
        erpUid: typeUid,
        code: `business-${randomUUID()}`,
        title: "Synthetic",
        allRu: true,
        allForeign: true,
        catalogSyncedAt: new Date(),
      },
    });
    manual = new ManualDocumentService(
      prisma,
      {
        keyFor: (id: string, v: number, f: string) => `${id}/${v}/${f}`,
        upload: async () => undefined,
      } as never,
      audit,
      { ensure: async () => undefined } as never,
      new ConfigService({ OCR_MODE: "disabled" }),
      erp as never,
    );
  });
  afterAll(async () => {
    const rows = await prisma.candidate.findMany({
      where: {
        OR: [{ erpUid }, { code1c: employee }, { id: { in: [...ids] } }],
      },
      select: { id: true },
    });
    const candidateIds = rows.map((r) => r.id),
      docs = await prisma.document.findMany({
        where: { candidateId: { in: candidateIds } },
        select: { id: true },
      }),
      docIds = docs.map((d) => d.id);
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { entityId: { in: [...candidateIds, ...docIds] } },
          {
            entityType: "CandidatePreviousDocuments",
            entityId: { in: candidateIds },
          },
        ],
      },
    });
    await prisma.document.deleteMany({ where: { id: { in: docIds } } });
    await prisma.candidate.deleteMany({ where: { id: { in: candidateIds } } });
    await prisma.documentType.deleteMany({ where: { erpUid: typeUid } });
    await prisma.$disconnect();
  });
  it("preserves Candidate.id, chat and document history from guest upload to authenticated RU", async () => {
    const first = await manual.upload(
      stage(undefined, chat),
      randomUUID(),
      "test",
    );
    ids.add(first.candidateId);
    await prisma.document.update({
      where: { id: first.documentId },
      data: { status: "APPROVED" },
    });
    const second = await manual.upload(stage(employee), randomUUID(), "test");
    expect(second.candidateId).toBe(first.candidateId);
    const candidate = await prisma.candidate.findUniqueOrThrow({
      where: { id: first.candidateId },
      include: { documents: { include: { versions: true } } },
    });
    expect(candidate).toMatchObject({
      erpUid,
      chatUuid: chat,
      code1c: employee,
      reviewGroup: "RU",
      personUid,
    });
    expect(candidate.identityKey).toBe(`erp:${erpUid}`);
    expect(candidate.documents).toHaveLength(1);
    expect(candidate.documents[0].versions).toHaveLength(2);
    expect(candidate.documents[0].reviewGroup).toBe("RU");
  });
  it("replays each independent submission namespace without a new version", async () => {
    await prisma.document.updateMany({
      where: { candidate: { erpUid } },
      data: { status: "APPROVED" },
    });
    const key = randomUUID();
    const first = await manual.upload(stage(employee), key, "test");
    const second = await manual.upload(stage(employee), key, "test");
    expect(second).toEqual(first);
    const docs = await prisma.document.findMany({
      where: { candidateId: first.candidateId },
    });
    expect(docs).toHaveLength(1);
  });
  it("uses current ERP identity for every own read and exact EDO candidate scope", async () => {
    const contexts = new CandidateContextService(
      {
        byEmployee: () => {
          throw new Error("stale LK must not be used");
        },
      } as never,
      erp as never,
      {} as never,
      prisma,
      new AuditService(prisma),
    );
    const read = vi.fn(async (scope) => scope);
    const own = new CandidateDocumentsService(
      contexts,
      {} as never,
      {} as never,
      { internalDocuments: read } as never,
      {} as never,
      {} as never,
    );
    const response = await own.ownStatuses(employee);
    const owner = await prisma.candidate.findUniqueOrThrow({
      where: { erpUid },
    });
    expect(response).toEqual({ candidateId: owner.id });
    expect(erp.resolveCurrentIdentity).toHaveBeenCalledWith(employee);
  });
  it("an incomplete ERP position remains an actionable upload-context error", async () => {
    const contexts = new CandidateContextService(
      {} as never,
      erp as never,
      {} as never,
      prisma,
      new AuditService(prisma),
    );
    erp.workspaceCard.mockResolvedValueOnce({
      erpUid,
      chatUuid: chat,
      code1C: employee,
      personUid,
      reviewGroup: "RU",
      position: null,
    } as never);
    await expect(contexts.forEmployee(employee)).rejects.toMatchObject({
      code: "CANDIDATE_PROFILE_INCOMPLETE",
      fields: ["positionCode"],
    });
  });
  it("review rights operate globally without location permissions and cannot cross groups", async () => {
    const ru = await prisma.document.findFirstOrThrow({
      where: { candidate: { erpUid } },
    });
    expect(
      await prisma.document.findFirst({
        where: { id: ru.id, ...access.documentReviewWhere(principal("20002")) },
      }),
    ).not.toBeNull();
    expect(
      await prisma.document.findFirst({
        where: { id: ru.id, ...access.documentReviewWhere(principal("20011")) },
      }),
    ).toBeNull();
    expect(
      await prisma.document.findFirst({
        where: { id: ru.id, ...access.documentReviewWhere(principal("20005")) },
      }),
    ).toBeNull();
    expect(
      await prisma.document.findFirst({
        where: { id: ru.id, ...access.documentReviewWhere(principal("20009")) },
      }),
    ).not.toBeNull();
  });
  it("creates independent IG person history with no chat, and keeps RU inaccessible", async () => {
    const igCode = `ig-${randomUUID()}`,
      igPerson = randomUUID();
    current = {
      recipientType: "person",
      reviewGroup: "IG",
      erpUid: null as never,
      chatUuid: null as never,
      personUid: igPerson,
      code1C: igCode,
    };
    const uploaded = await manual.upload(stage(igCode), randomUUID(), "test");
    ids.add(uploaded.candidateId);
    const doc = await prisma.document.findUniqueOrThrow({
      where: { id: uploaded.documentId },
      include: { candidate: true },
    });
    expect(doc).toMatchObject({
      reviewGroup: "IG",
      candidate: {
        erpUid: null,
        chatUuid: null,
        personUid: igPerson,
        identityKey: `person:${igPerson}`,
      },
    });
    expect(
      await prisma.document.findFirst({
        where: { id: doc.id, ...access.documentWhere(principal("20002")) },
      }),
    ).toBeNull();
    expect(
      await prisma.document.findFirst({
        where: {
          id: doc.id,
          ...access.documentReviewWhere(principal("20011")),
        },
      }),
    ).not.toBeNull();
    current = {
      recipientType: "candidate",
      reviewGroup: "RU",
      erpUid,
      chatUuid: chat,
      personUid,
      code1C: employee,
    };
  });
  it("never moves document workflow when profile citizenship changes", async () => {
    await prisma.candidate.update({
      where: { erpUid },
      data: { citizenship: "uz" },
    });
    const doc = await prisma.document.findFirstOrThrow({
      where: { candidate: { erpUid } },
    });
    expect(
      await prisma.document.findFirst({
        where: {
          id: doc.id,
          ...access.documentReviewWhere(principal("20002")),
        },
      }),
    ).not.toBeNull();
    expect(doc.reviewGroup).toBe("RU");
  });
  it("approval freezes v2 recipients for chat RU, chatless RU and independent IG", async () => {
    const artifact = {
      key: "approved/test",
      mimeType: "application/pdf",
      extension: "pdf",
      filename: "document.pdf",
      sizeBytes: 4,
      sha256: "a".repeat(64),
      pageCount: 1,
      preparation: "original",
      transport: "multipart-v2",
    };
    const review = new DocumentReviewService(
      prisma,
      access,
      new AuditService(prisma),
      { version: async () => ({}) } as never,
      {
        prepare: async (versionId: string) => {
          await prisma.documentVersion.update({
            where: { id: versionId },
            data: {
              pendingApprovalStorageKey: artifact.key,
              approvalLeaseUntil: new Date(Date.now() + 60000),
            },
          });
          return artifact;
        },
        discard: async () => undefined,
      } as never,
    );
    const docs = await prisma.document.findMany({
      where: { candidateId: { in: [...ids] }, status: "IN_REVIEW" },
      include: { candidate: true },
    });
    for (const doc of docs) {
      await review.approve(
        doc.id,
        doc.currentVersion,
        0,
        principal(doc.reviewGroup === "RU" ? "20002" : "20011"),
        "test",
      );
      const delivery = await prisma.erpDocumentDelivery.findFirstOrThrow({
        where: { version: { documentId: doc.id, version: doc.currentVersion } },
      });
      expect(delivery.transport).toBe("multipart-v2");
      expect(delivery.status).toBe("PENDING");
      expect(delivery.payload).toMatchObject(
        doc.reviewGroup === "RU"
          ? { candidateUid: erpUid, chatUid: chat }
          : {
              recipientType: "person",
              personUid: doc.candidate!.personUid,
              code1c: doc.candidate!.code1c,
            },
      );
      expect(delivery.payload).not.toHaveProperty("fileBase64");
    }
    const noChatUid = randomUUID(),
      noChatCode = `chatless-${randomUUID()}`;
    current = {
      recipientType: "candidate",
      reviewGroup: "RU",
      erpUid: noChatUid,
      chatUuid: null as never,
      personUid,
      code1C: noChatCode,
    };
    const uploaded = await manual.upload(
      stage(noChatCode),
      randomUUID(),
      "test",
    );
    ids.add(uploaded.candidateId);
    await review.approve(
      uploaded.documentId,
      uploaded.version,
      0,
      principal("20002"),
      "test",
    );
    const delivery = await prisma.erpDocumentDelivery.findFirstOrThrow({
      where: { version: { documentId: uploaded.documentId } },
    });
    expect(delivery.payload).toMatchObject({ candidateUid: noChatUid });
    expect(delivery.payload).not.toHaveProperty("chatUid");
    await prisma.candidate.update({
      where: { id: uploaded.candidateId },
      data: { chatUuid: randomUUID() },
    });
    expect(
      (
        await prisma.erpDocumentDelivery.findUniqueOrThrow({
          where: { id: delivery.id },
        })
      ).payload,
    ).toEqual(delivery.payload);
    current = {
      recipientType: "candidate",
      reviewGroup: "RU",
      erpUid,
      chatUuid: chat,
      personUid,
      code1C: employee,
    };
  });
  it("separate established historical cycles may share code; current ERP uid wins", async () => {
    const historical = await prisma.candidate.create({
      data: {
        identityKey: `erp:${randomUUID()}`,
        erpUid: randomUUID(),
        code1c: employee,
        reviewGroup: "RU",
      },
    });
    ids.add(historical.id);
    const resolved = await candidateIdentityTransaction(prisma, (tx) =>
      resolveCandidateIdentity(tx, {
        identityKey: `erp:${erpUid}`,
        erpUid,
        code1c: employee,
        reviewGroup: "RU",
      }),
    );
    expect(resolved.id).not.toBe(historical.id);
  });
  it("rejects unresolved legacy employee history instead of creating a duplicate", async () => {
    const code = `legacy-${randomUUID()}`;
    const legacy = await prisma.candidate.create({
      data: { identityKey: `employee:${code}`, code1c: code },
    });
    ids.add(legacy.id);
    await expect(
      candidateIdentityTransaction(prisma, (tx) =>
        resolveCandidateIdentity(tx, {
          identityKey: `erp:${randomUUID()}`,
          erpUid: randomUUID(),
          code1c: code,
          reviewGroup: "RU",
        }),
      ),
    ).rejects.toThrow("LEGACY_CANDIDATE_IDENTITY_REQUIRES_RECONCILIATION");
    expect(await prisma.candidate.count({ where: { code1c: code } })).toBe(1);
  });
  it("rejects conflict between strong chat and ERP candidate owners without merging", async () => {
    const other = await prisma.candidate.create({
      data: {
        identityKey: `erp:${randomUUID()}`,
        erpUid: randomUUID(),
        reviewGroup: "RU",
      },
    });
    ids.add(other.id);
    await expect(
      candidateIdentityTransaction(prisma, (tx) =>
        resolveCandidateIdentity(tx, {
          identityKey: other.identityKey,
          erpUid: other.erpUid,
          chatUuid: chat,
          reviewGroup: "RU",
        }),
      ),
    ).rejects.toThrow("CANDIDATE_IDENTITY_CONFLICT");
  });
  it("unclassified legacy documents stay visible only to full read access and cannot be approved", async () => {
    const owner = await prisma.candidate.create({
      data: { identityKey: `legacy:${randomUUID()}` },
    });
    ids.add(owner.id);
    const type = await prisma.documentType.findUniqueOrThrow({
      where: { erpUid: typeUid },
    });
    const doc = await prisma.document.create({
      data: { candidateId: owner.id, documentTypeId: type.id },
    });
    expect(
      await prisma.document.findFirst({
        where: { id: doc.id, ...access.documentWhere(principal("20009")) },
      }),
    ).not.toBeNull();
    expect(
      await prisma.document.findFirst({
        where: {
          id: doc.id,
          ...access.documentReviewWhere(principal("20009")),
        },
      }),
    ).toBeNull();
  });
});
