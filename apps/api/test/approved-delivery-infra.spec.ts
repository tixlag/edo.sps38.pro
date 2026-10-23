import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { PrismaService } from "../src/prisma/prisma.service";
import { StorageService } from "../src/storage/storage.service";
import { AuditService } from "../src/audit/audit.service";
import { DocumentAccessService } from "../src/documents/document-access.service";
import { DocumentReadService } from "../src/documents/document-read.service";
import { DocumentReviewService } from "../src/documents/document-review.service";
import { DocumentPdfService } from "../src/documents/document-pdf.service";
import { DocumentDeliveryService } from "../src/documents/document-delivery.service";

const db = process.env.EDO_TEST_DATABASE_URL ?? "";
const endpoint = process.env.EDO_TEST_S3_ENDPOINT ?? "";
if (
  db &&
  !/^mysql:\/\/[^@/]+@(127\.0\.0\.1|localhost):(3307|3308)\/edo(\?|$)/.test(db)
)
  throw new Error("Disposable MariaDB required");
if (endpoint && !/^http:\/\/(127\.0\.0\.1|localhost):5001$/.test(endpoint))
  throw new Error("Disposable S3 required");
const suite = describe.skipIf(!db || !endpoint);
const prefix = `artifact-v2-${Date.now()}`;
const bucket = prefix;
const principal = {
  uuid: "artifact-reviewer",
  code1c: null,
  sid: null,
  deviceId: null,
  accessRules: { "20009": [] },
  expiresAt: null,
};
let prisma: PrismaService,
  storage: StorageService,
  config: ConfigService,
  audit: AuditService,
  pdf: DocumentPdfService;
let reads: DocumentReadService,
  access: DocumentAccessService,
  review: DocumentReviewService,
  server: Server,
  s3: S3Client;
let status = 201,
  failReceipt = false,
  loseResponse = false,
  delay = 0;
const accepted = new Map<string, object>();
const posts: {
  id: string;
  metadata: Record<string, unknown>;
  hash: string;
  size: number;
  mime: string;
}[] = [];
function worker() {
  return new DocumentDeliveryService(
    prisma,
    storage,
    config,
    audit,
    access,
    reads,
    { fail: vi.fn() } as never,
    pdf,
    { cleanupCache: vi.fn() } as never,
  );
}
async function version(
  name = "passport.jpg",
  mimeType = "image/jpeg",
  documentId?: string,
) {
  const bytes = await readFile(
    join(__dirname, "fixtures/approved-artifacts", name),
  );
  const number = documentId
    ? (await prisma.documentVersion.count({ where: { documentId } })) + 1
    : 1;
  if (!documentId) {
    const candidate = await prisma.candidate.create({
      data: {
        identityKey: `${prefix}:${randomUUID()}`,
        chatUuid: randomUUID(),
      },
    });
    const type = await prisma.documentType.create({
      data: {
        code: `${prefix}-${randomUUID()}`,
        title: "Synthetic",
        erpUid: randomUUID(),
      },
    });
    documentId = (
      await prisma.document.create({
        data: {
          candidateId: candidate.id,
          documentTypeId: type.id,
          currentVersion: number,
          status: "IN_REVIEW",
        },
      })
    ).id;
  } else
    await prisma.document.update({
      where: { id: documentId },
      data: { currentVersion: number, status: "IN_REVIEW" },
    });
  const key = storage.keyFor(documentId, number, randomUUID());
  await storage.uploadBuffer(key, bytes, mimeType);
  const row = await prisma.documentVersion.create({
    data: {
      documentId,
      version: number,
      storageKey: key,
      status: "IN_REVIEW",
      positionCode1c: "job-code",
      files: {
        create: {
          ordinal: 0,
          storageKey: key,
          filename: name,
          mimeType,
          sizeBytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          pageCount: mimeType === "application/pdf" ? 3 : 1,
        },
      },
      fields: {
        create: [
          { name: "number", value: "0001", ordinal: 0 },
          { name: "issueDate", value: "2020-01-15", kind: "date", ordinal: 1 },
          { name: "positionUid", value: "job-code", ordinal: 2 },
        ],
      },
      submission: {
        create: {
          identityKey: prefix,
          idempotencyKey: randomUUID(),
          fingerprint: "test",
          status: "SUCCEEDED",
        },
      },
    },
  });
  return { row, bytes, documentId, number, key };
}
async function approve(f: Awaited<ReturnType<typeof version>>) {
  await review.approve(
    f.documentId,
    f.number,
    0,
    principal,
    "test-correlation",
  );
  return prisma.erpDocumentDelivery.findUniqueOrThrow({
    where: { versionId: f.row.id },
    include: { version: true },
  });
}
suite(
  "immutable approval and durable delivery on disposable MariaDB/S3",
  () => {
    beforeAll(async () => {
      prisma = new PrismaService({ datasourceUrl: db });
      s3 = new S3Client({
        endpoint,
        region: "us-east-1",
        forcePathStyle: true,
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
      });
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      server = createServer(async (req, res) => {
        try {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(Buffer.from(c));
          const form = await new Response(Buffer.concat(chunks), {
            headers: { "content-type": String(req.headers["content-type"]) },
          }).formData();
          const file = form.get("file") as File;
          const bytes = Buffer.from(await file.arrayBuffer());
          const metadata = JSON.parse(String(form.get("metadata")));
          const id = String(req.headers["idempotency-key"]);
          posts.push({
            id,
            metadata,
            hash: createHash("sha256").update(bytes).digest("hex"),
            size: bytes.length,
            mime: file.type,
          });
          const previous = accepted.get(id);
          const receipt = previous ?? {
            success: true,
            receiptId: randomUUID(),
            deliveryId: id,
            duplicate: false,
            candidateUid: randomUUID(),
            documentUid: metadata.documentUid,
            fileUid: randomUUID(),
            period: "2026-10-22",
            fileName: file.name,
            mimeType: file.type,
            fileSha256: posts.at(-1)!.hash,
            fileSize: bytes.length,
          };
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          if (status < 400) accepted.set(id, receipt);
          if (loseResponse) {
            loseResponse = false;
            res.destroy();
            return;
          }
          res.writeHead(previous ? 200 : status, {
            "content-type": "application/json",
          });
          res.end(
            JSON.stringify(
              failReceipt
                ? { success: false, description: "PRIVATE" }
                : status >= 400
                  ? { success: false, code: "DELIVERY_BUSY" }
                  : { ...receipt, duplicate: !!previous },
            ),
          );
        } catch {
          res.destroy();
        }
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      config = new ConfigService({
        ERP_DOCUMENTS_TRANSPORT: "multipart-v2",
        ERP_DOCUMENTS_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
        ERP_DOCUMENTS_TOKEN: "test-token",
        ERP_USERNAME: "test-user",
        ERP_PASSWORD: "test-password",
        S3_ENDPOINT: endpoint,
        S3_BUCKET: bucket,
        S3_ACCESS_KEY: "test",
        S3_SECRET_KEY: "test",
        OCR_WORKER_ENABLED: "false",
        DOCUMENT_WORKER_ENABLED: "false",
      });
      storage = new StorageService(config);
      audit = new AuditService(prisma);
      access = new DocumentAccessService(prisma);
      reads = new DocumentReadService(prisma, access, storage);
      pdf = new DocumentPdfService(prisma, storage, config);
      review = new DocumentReviewService(prisma, access, audit, reads, pdf);
    }, 30000);
    afterAll(async () => {
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      if (prisma) {
        await prisma.auditLog.deleteMany({
          where: {
            actorId: { in: [principal.uuid, "document-worker"] },
            document: { documentType: { code: { startsWith: prefix } } },
          },
        });
        // Events deliberately carry entityId rather than documentId; remove only our documents' events.
        const docs = await prisma.document.findMany({
          where: { documentType: { code: { startsWith: prefix } } },
          select: { id: true },
        });
        await prisma.auditLog.deleteMany({
          where: { entityId: { in: docs.map((d) => d.id) } },
        });
        await prisma.candidate.deleteMany({
          where: { identityKey: { startsWith: prefix } },
        });
        await prisma.documentType.deleteMany({
          where: { code: { startsWith: prefix } },
        });
        await prisma.$disconnect();
      }
      if (s3) {
        const objects = await s3.send(
          new ListObjectsV2Command({ Bucket: bucket }),
        );
        if (objects.Contents?.length)
          await s3.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: {
                Objects: objects.Contents.map((o) => ({ Key: o.Key! })),
              },
            }),
          );
        await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
        s3.destroy();
      }
      storage?.onModuleDestroy();
    }, 30000);
    it.each([
      ["passport.jpg", "image/jpeg"],
      ["scan.png", "image/png"],
      ["document.webp", "image/webp"],
      ["multipage.pdf", "application/pdf"],
    ])(
      "approves and streams %s without changing bytes",
      async (name, mime) => {
        const f = await version(name, mime);
        const d = await approve(f);
        expect(d.transport).toBe("multipart-v2");
        expect(d.version.approvedStorageKey).not.toBe(f.key);
        expect(
          (await storage.read(d.version.approvedStorageKey!)).equals(f.bytes),
        ).toBe(true);
        expect(d.version.approvedSizeBytes).toBe(f.bytes.length);
        expect(d.version.approvedMimeType).toBe(mime);
        const original = await reads.download(
          f.documentId,
          f.number,
          (
            await prisma.documentVersionFile.findFirstOrThrow({
              where: { versionId: f.row.id },
            })
          ).id,
          principal,
        );
        expect(original.url).toContain("X-Amz-Signature");
        await worker().send(d.id);
        expect(
          (
            await prisma.erpDocumentDelivery.findUniqueOrThrow({
              where: { id: d.id },
            })
          ).status,
        ).toBe("SENT");
        expect(posts.at(-1)).toMatchObject({
          id: d.id,
          hash: d.version.approvedSha256,
          size: f.bytes.length,
          mime,
        });
        expect(posts.at(-1)!.metadata.documentFields).toEqual({
          number: "0001",
          issueDate: "2020-01-15",
        });
        await pdf.discard(f.row.id, d.version.approvedStorageKey!); // stale maintenance
        expect((await storage.read(f.key)).equals(f.bytes)).toBe(true);
        expect(
          (await storage.read(d.version.approvedStorageKey!)).equals(f.bytes),
        ).toBe(true);
        await expect(
          review.approve(f.documentId, f.number, 0, principal, "again"),
        ).rejects.toThrow();
      },
      30000,
    );
    it("freezes transport across configuration changes and creates a new ID for a new version", async () => {
      const f = await version();
      const d = await approve(f);
      config.set("ERP_DOCUMENTS_TRANSPORT", "base64-v1");
      await worker().send(d.id);
      expect(posts.at(-1)!.id).toBe(d.id);
      const second = await version("scan.png", "image/png", f.documentId);
      const next = await approve(second);
      expect(next.transport).toBe("base64-v1");
      expect(next.id).not.toBe(d.id);
      expect(next.version.approvedMimeType).toBe("application/pdf");
      expect(
        (await storage.read(d.version.approvedStorageKey!)).equals(f.bytes),
      ).toBe(true);
      config.set("ERP_DOCUMENTS_TRANSPORT", "multipart-v2");
      // Avoid sending the intentionally-created v1 row into the v2-only stub.
      await prisma.erpDocumentDelivery.update({
        where: { id: next.id },
        data: { status: "WAITING_CONTRACT" },
      });
    });
    it("rolls back metadata, delivery and audit together on approval failure and preserves originals", async () => {
      const f = await version();
      const spy = vi
        .spyOn(audit, "logInTransaction")
        .mockRejectedValueOnce(new Error("audit unavailable"));
      await expect(approve(f)).rejects.toThrow("audit unavailable");
      spy.mockRestore();
      const row = await prisma.documentVersion.findUniqueOrThrow({
        where: { id: f.row.id },
      });
      expect(row.approvedSha256).toBeNull();
      expect(row.approvedStorageKey).toBeNull();
      expect(row.pendingApprovalStorageKey).toBeNull();
      expect(
        await prisma.erpDocumentDelivery.count({
          where: { versionId: row.id },
        }),
      ).toBe(0);
      expect((await storage.read(f.key)).equals(f.bytes)).toBe(true);
      await approve(f);
    });
    it("fences two approvers and two workers with real database compare-and-set", async () => {
      const f = await version();
      const approvals = await Promise.allSettled([approve(f), approve(f)]);
      expect(approvals.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const d = await prisma.erpDocumentDelivery.findUniqueOrThrow({
        where: { versionId: f.row.id },
      });
      delay = 150;
      const before = posts.length;
      const sends = await Promise.allSettled([
        worker().send(d.id),
        worker().send(d.id),
      ]);
      delay = 0;
      expect(sends.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(posts.length).toBe(before + 1);
      expect(
        await prisma.erpDocumentAttempt.count({ where: { deliveryId: d.id } }),
      ).toBe(1);
    });
    it("recovers loss after 1C commit, bounded backoff and a restarted worker using the same ID", async () => {
      config.set("ERP_DOCUMENTS_V2_AUTO_RETRY", "true");
      const f = await version();
      const d = await approve(f);
      loseResponse = true;
      await worker().send(d.id);
      let row = await prisma.erpDocumentDelivery.findUniqueOrThrow({
        where: { id: d.id },
      });
      expect(row.status).toBe("PENDING");
      expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
      const before = posts.filter((p) => p.id === d.id).length;
      await worker().tick();
      expect(posts.filter((p) => p.id === d.id).length).toBe(before);
      await prisma.erpDocumentDelivery.update({
        where: { id: d.id },
        data: { nextAttemptAt: new Date(0) },
      });
      await worker().tick();
      row = await prisma.erpDocumentDelivery.findUniqueOrThrow({
        where: { id: d.id },
      });
      expect(row.status).toBe("SENT");
      expect(row.attemptCount).toBe(2);
      const attempts = await prisma.erpDocumentAttempt.findMany({
        where: { deliveryId: d.id },
        orderBy: { startedAt: "asc" },
      });
      expect(attempts[1].responseBody).toContain('"duplicate":true');
      expect(posts.filter((p) => p.id === d.id)).toHaveLength(2);
      config.set("ERP_DOCUMENTS_V2_AUTO_RETRY", "false");
    });
    it("recovers expired leases and stops at five attempts, allowing a manual repeat", async () => {
      config.set("ERP_DOCUMENTS_V2_AUTO_RETRY", "true");
      const f = await version();
      const d = await approve(f);
      await prisma.erpDocumentDelivery.update({
        where: { id: d.id },
        data: {
          status: "SENDING",
          attemptCount: 1,
          leaseToken: randomUUID(),
          leaseUntil: new Date(0),
        },
      });
      await prisma.erpDocumentAttempt.create({
        data: { deliveryId: d.id, actorId: "document-worker" },
      });
      await worker().tick();
      let row = await prisma.erpDocumentDelivery.findUniqueOrThrow({
        where: { id: d.id },
      });
      expect(row.status).toBe("PENDING");
      expect(row.nextAttemptAt).toBeTruthy();
      status = 503;
      for (let i = 2; i <= 5; i++) {
        await prisma.erpDocumentDelivery.update({
          where: { id: d.id },
          data: { nextAttemptAt: new Date(0) },
        });
        await worker().tick();
        row = await prisma.erpDocumentDelivery.findUniqueOrThrow({
          where: { id: d.id },
        });
        expect(row.attemptCount).toBe(i);
        expect(row.status).toBe(i < 5 ? "PENDING" : "REQUIRES_MANUAL");
      }
      const before = posts.filter((p) => p.id === d.id).length;
      await worker().tick();
      expect(posts.filter((p) => p.id === d.id).length).toBe(before);
      status = 201;
      await worker().send(d.id, principal.uuid, "manual", principal);
      expect(
        (
          await prisma.erpDocumentDelivery.findUniqueOrThrow({
            where: { id: d.id },
          })
        ).status,
      ).toBe("SENT");
      config.set("ERP_DOCUMENTS_V2_AUTO_RETRY", "false");
    });
    it("parks a previously scheduled retry when automatic retries are disabled", async () => {
      config.set("ERP_DOCUMENTS_V2_AUTO_RETRY", "true");
      const f = await version();
      const d = await approve(f);
      status = 503;
      await worker().send(d.id);
      status = 201;
      config.set("ERP_DOCUMENTS_V2_AUTO_RETRY", "false");
      const before = posts.filter((p) => p.id === d.id).length;
      await worker().tick();
      const row = await prisma.erpDocumentDelivery.findUniqueOrThrow({
        where: { id: d.id },
      });
      expect(row.status).toBe("REQUIRES_MANUAL");
      expect(row.nextAttemptAt).toBeNull();
      expect(posts.filter((p) => p.id === d.id)).toHaveLength(before);
    });
    it("never marks a false or invalid receipt SENT and never retries it automatically", async () => {
      const f = await version();
      const d = await approve(f);
      failReceipt = true;
      await worker().send(d.id);
      failReceipt = false;
      const row = await prisma.erpDocumentDelivery.findUniqueOrThrow({
        where: { id: d.id },
      });
      expect(row.status).toBe("REQUIRES_MANUAL");
      expect(row.errorCode).toBe("ERP_RECEIPT_INVALID");
      expect(row.nextAttemptAt).toBeNull();
    });
  },
);
