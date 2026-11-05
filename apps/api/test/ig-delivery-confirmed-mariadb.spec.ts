import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { PrismaService } from "../src/prisma/prisma.service";
import { AuditService } from "../src/audit/audit.service";
import { EMPLOYMENT_PATENT_UID } from "../src/documents/reemployment-document-policy";
import { MIGRATION_UID } from "../src/ocr/ocr-profile";
import { DocumentDeliveryService } from "../src/documents/document-delivery.service";

const db = process.env.EDO_TEST_DATABASE_URL;
if (db && db !== "mysql://root:ig-isolated-test-20261105@127.0.0.1:33307/edo")
  throw new Error("Refuse non-task database");
describe.skipIf(!db)("IG validated receipt on task MariaDB", () => {
  const person = randomUUID(),
    documentUid = randomUUID(),
    code1c = `ig-${randomUUID()}`;
  const bytes = Buffer.from("synthetic PDF"),
    hash = createHash("sha256").update(bytes).digest("hex");
  const extraTypeIds: string[] = [];
  let prisma: PrismaService,
    server: Server,
    base: string,
    candidateId: string,
    documentId: string,
    deliveryId: string,
    typeId: string;
  let invalid = true;
  beforeAll(async () => {
    prisma = new PrismaService({ datasourceUrl: db });
    const type = await prisma.documentType.create({
      data: {
        code: `T-${randomUUID()}`,
        title: "Synthetic",
        erpUid: documentUid,
        requiredForAll: true,
        catalogSyncedAt: new Date(),
      },
    });
    typeId = type.id;
    const candidate = await prisma.candidate.create({
      data: {
        identityKey: `test:${randomUUID()}`,
        code1c,
        personUid: person,
        reviewGroup: "IG",
        citizenship: "uz",
        positionCode: "test",
      },
    });
    candidateId = candidate.id;
    await prisma.igEmploymentState.create({
      data: { code1c, currentCandidateId: candidateId },
    });
    for (const erpUid of [MIGRATION_UID, EMPLOYMENT_PATENT_UID]) {
      const extraType = await prisma.documentType.create({
        data: {
          code: `T-${randomUUID()}`,
          title: "Synthetic",
          erpUid,
          requiredForAll: true,
          catalogSyncedAt: new Date(),
        },
      });
      extraTypeIds.push(extraType.id);
      const extraDoc = await prisma.document.create({
        data: {
          candidateId,
          documentTypeId: extraType.id,
          status: "APPROVED",
          currentVersion: 1,
        },
      });
      const extraVersion = await prisma.documentVersion.create({
        data: {
          documentId: extraDoc.id,
          version: 1,
          storageKey: "test",
          status: "APPROVED",
        },
      });
      await prisma.erpDocumentDelivery.create({
        data: {
          versionId: extraVersion.id,
          status: "SENT",
          transport: "multipart-v2",
          payload: {},
          attempts: {
            create: {
              actorId: "test",
              finishedAt: new Date(),
              receiptValidated: true,
            },
          },
        },
      });
    }
    const doc = await prisma.document.create({
      data: {
        candidateId,
        documentTypeId: typeId,
        status: "APPROVED",
        currentVersion: 1,
      },
    });
    documentId = doc.id;
    const version = await prisma.documentVersion.create({
      data: {
        documentId,
        version: 1,
        storageKey: "source",
        status: "APPROVED",
        approvedStorageKey: "approved",
        approvedMimeType: "application/pdf",
        approvedExtension: "pdf",
        approvedFilename: "document.pdf",
        approvedSizeBytes: bytes.length,
        approvedSha256: hash,
      },
    });
    const delivery = await prisma.erpDocumentDelivery.create({
      data: {
        versionId: version.id,
        transport: "multipart-v2",
        status: "PENDING",
        payload: {
          recipientType: "person",
          personUid: person,
          code1c,
          documentUid,
          documentFields: {},
        },
      },
    });
    deliveryId = delivery.id;
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const form = await new Response(Buffer.concat(chunks), {
        headers: { "content-type": String(req.headers["content-type"]) },
      }).formData();
      const metadata = JSON.parse(String(form.get("metadata")));
      expect(metadata.personUid).toBe(person);
      expect(metadata.chatUid).toBeUndefined();
      res.writeHead(201, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          receiptId: randomUUID(),
          deliveryId: req.headers["idempotency-key"],
          duplicate: false,
          recipientType: "person",
          personUid: person,
          candidateUid: null,
          chatUid: null,
          documentUid,
          fileUid: randomUUID(),
          period: "2026-11-05",
          fileName: "document.pdf",
          mimeType: "application/pdf",
          fileSha256: invalid ? "0".repeat(64) : hash,
          fileSize: bytes.length,
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  });
  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prisma) {
      await prisma.igEmploymentState.deleteMany({ where: { code1c } });
      await prisma.candidate.deleteMany({ where: { id: candidateId } });
      await prisma.documentType.deleteMany({
        where: { id: { in: [typeId, ...extraTypeIds] } },
      });
      await prisma.auditLog.deleteMany({
        where: { entityId: { in: [candidateId, documentId] } },
      });
      await prisma.$disconnect();
    }
  });
  it("rejects invalid receipt then atomically records validated receipt and completes", async () => {
    const service = new DocumentDeliveryService(
      prisma,
      { openRead: vi.fn(async () => Readable.from([bytes])) } as never,
      {
        get: (key: string) =>
          ({
            ERP_DOCUMENTS_TOKEN: "test",
            ERP_USERNAME: "test",
            ERP_PASSWORD: "test",
            ERP_DOCUMENTS_BASE_URL: base,
            ERP_DOCUMENTS_V2_AUTO_RETRY: "false",
          })[key],
      } as never,
      new AuditService(prisma),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await service.send(deliveryId);
    expect(
      (
        await prisma.erpDocumentDelivery.findUniqueOrThrow({
          where: { id: deliveryId },
        })
      ).status,
    ).toBe("REQUIRES_MANUAL");
    expect(
      (await prisma.candidate.findUniqueOrThrow({ where: { id: candidateId } }))
        .igCompletionVerified,
    ).toBe(false);
    invalid = false;
    await service.send(deliveryId);
    const saved = await prisma.erpDocumentDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
      include: { attempts: { orderBy: { startedAt: "asc" } } },
    });
    expect({
      status: saved.status,
      errorCode: saved.errorCode,
      attempts: saved.attempts.map((a) => ({
        errorCode: a.errorCode,
        httpStatus: a.httpStatus,
      })),
    }).toEqual({
      status: "SENT",
      errorCode: null,
      attempts: [
        { errorCode: "ERP_RECEIPT_INVALID", httpStatus: 201 },
        { errorCode: null, httpStatus: 201 },
      ],
    });
    expect(saved.attempts.map((attempt) => attempt.receiptValidated)).toEqual([
      false,
      true,
    ]);
    expect(
      (await prisma.candidate.findUniqueOrThrow({ where: { id: candidateId } }))
        .igCompletionVerified,
    ).toBe(true);
  });
});
