import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ValidationPipe } from "@nestjs/common";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import multipart from "@fastify/multipart";
import { connect } from "amqplib";
import {
  S3Client,
  CreateBucketCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { sign } from "jsonwebtoken";
import { PrismaService } from "../src/prisma/prisma.service";
import { AuthModule } from "../src/auth/auth.module";
import { DocumentsModule } from "../src/documents/documents.module";
import { HttpErrorFilter } from "../src/common/http-error.filter";
import {
  OcrService,
  type OcrRequest,
  type OcrResult,
} from "../src/ocr/ocr.service";
import { OcrWorkerService } from "../src/ocr/ocr-worker.service";
import { OcrQueueService } from "../src/ocr/ocr-queue.service";
import { AuditService } from "../src/audit/audit.service";
import { StorageService } from "../src/storage/storage.service";
import type {
  DocumentVersionDto,
  UploadAcceptedDto,
} from "../src/documents/dto/document.dto";

// Explicit, isolated services only. Never falls back to DATABASE_URL or shared LK infra.
const dbUrl = process.env.EDO_TEST_DATABASE_URL ?? "";
const rabbitUrl = process.env.EDO_TEST_RABBITMQ_URL ?? "";
const s3Endpoint = process.env.EDO_TEST_S3_ENDPOINT ?? "";
if (
  dbUrl &&
  !/^mysql:\/\/[^@/]+@(127\.0\.0\.1|localhost):(3307|3308)\/edo(\?|$)/.test(
    dbUrl,
  )
)
  throw new Error("Refusing non-disposable document-test MariaDB");
if (
  rabbitUrl &&
  !/^amqp:\/\/[^@/]+@(127\.0\.0\.1|localhost):(5673|5675)\//.test(rabbitUrl)
)
  throw new Error("Refusing non-disposable document-test RabbitMQ");
if (s3Endpoint && !/^http:\/\/(127\.0\.0\.1|localhost):5001$/.test(s3Endpoint))
  throw new Error("Refusing non-disposable document-test S3");
const enabled = !!(dbUrl && rabbitUrl && s3Endpoint);
const prefix = `doc-test-${Date.now()}`;
const secret = "documents-test-jwt-secret";
const bucket = `${prefix}-files`;
const chats: string[] = [];
let app: NestFastifyApplication;
let prisma: PrismaService;
let worker: OcrWorkerService;
let queue: OcrQueueService;
let s3: S3Client;
let png: Buffer;
let pdf: Buffer;
let typeCode: string;

class ControlledOcr extends OcrService {
  available = true;
  requests: OcrRequest[] = [];
  responses = new Map<string, OcrResult | Error | (() => Promise<OcrResult>)>();
  isAvailable() {
    return this.available;
  }
  async recognize(request: OcrRequest): Promise<OcrResult> {
    this.requests.push(request);
    const result = this.responses.get(request.jobId);
    if (result instanceof Error) throw result;
    if (typeof result === "function") return result();
    return (
      result ?? {
        outcome: "SUCCEEDED",
        source: "STUB",
        fields: { number: "000123", holder: "TEST PERSON" },
        raw: { synthetic: true, number: "000123" },
      }
    );
  }
}
const ocr = new ControlledOcr();
const reviewer = (rules: Record<string, string[]> = { "20009": [] }) => ({
  authorization: `Bearer ${sign({ uuid: "reviewer", accessRules: rules }, secret, { algorithm: "HS256", issuer: "lk-auth-service", expiresIn: 600 })}`,
});
const serviceHeaders = { authorization: "Bearer lk-documents-test-token" };
function chat() {
  const id = randomUUID();
  chats.push(id);
  return id;
}
function form(
  files: { bytes: Buffer; name: string; mime: string }[],
  fields: Record<string, string> = {},
) {
  const boundary = `edo-${randomUUID()}`;
  const parts: Buffer[] = [];
  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files[]"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`,
      ),
      file.bytes,
      Buffer.from("\r\n"),
    );
  }
  // Fields after files intentionally exercise multipart ordering.
  for (const [name, value] of Object.entries({
    documentTypeCode: typeCode,
    ...fields,
  })) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
async function upload(
  chatUuid: string,
  key = randomUUID(),
  fields: Record<string, string> = {},
  files = [{ bytes: png, name: "front.jpg", mime: "image/jpeg" }],
) {
  const body = form(files, fields);
  return app.inject({
    method: "POST",
    url: `/api/internal/edo/v1/candidate-chats/${chatUuid}/documents`,
    payload: body.payload,
    headers: {
      ...serviceHeaders,
      "content-type": body.contentType,
      "idempotency-key": key,
      "x-correlation-id": prefix,
    },
  });
}
async function accepted(
  chatUuid = chat(),
  key = randomUUID(),
  fields: Record<string, string> = {},
): Promise<UploadAcceptedDto> {
  const response = await upload(chatUuid, key, fields);
  expect(response.statusCode, response.body).toBe(202);
  return response.json();
}
async function result(a: UploadAcceptedDto): Promise<DocumentVersionDto> {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/documents/${a.documentId}/versions/${a.version}`,
    headers: reviewer(),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for document processing");
    await new Promise((r) => setTimeout(r, 30));
  }
}

beforeAll(async () => {
  if (!enabled) return;
  prisma = new PrismaService({ datasourceUrl: dbUrl });
  typeCode = `${prefix}-passport`;
  await prisma.documentType.create({
    data: { code: typeCode, title: "Test passport" },
  });
  await prisma.lkLocation.upsert({
    where: { locationId: 98 },
    update: {},
    create: {
      code1c: `${prefix}-location`,
      locationId: 98,
      name: "Test object",
    },
  });
  s3 = new S3Client({
    endpoint: s3Endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  const rabbit = await connect(rabbitUrl);
  const ch = await rabbit.createChannel();
  await ch.assertExchange("lk.events", "topic", { durable: true }); // Isolated test broker only.
  await rabbit.close();
  const config = new ConfigService({
    NODE_ENV: "test",
    JWT_SECRET: secret,
    JWT_ALG: "HS256",
    JWT_ISSUER: "lk-auth-service",
    EDO_LK_INTERNAL_TOKEN: "lk-documents-test-token",
    OCR_MODE: "stub",
    OCR_WORKER_ENABLED: "false",
    RABBITMQ_URL: rabbitUrl,
    EDO_OCR_QUEUE: `edo.ocr.${prefix}`,
    LK_EVENTS_EXCHANGE: "lk.events",
    S3_ENDPOINT: s3Endpoint,
    S3_REGION: "us-east-1",
    S3_BUCKET: bucket,
    S3_ACCESS_KEY: "test",
    S3_SECRET_KEY: "test",
  });
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      DocumentsModule,
      AuthModule,
    ],
  })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .overrideProvider(ConfigService)
    .useValue(config)
    .overrideProvider(OcrService)
    .useValue(ocr)
    .compile();
  app = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ logger: false }),
  );
  await app.register(multipart);
  app.setGlobalPrefix("api");
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new HttpErrorFilter());
  app
    .getHttpAdapter()
    .getInstance()
    .addHook(
      "onRequest",
      (
        req: { correlationId?: string; headers: Record<string, string> },
        _reply: unknown,
        done: () => void,
      ) => {
        req.correlationId = req.headers["x-correlation-id"] ?? prefix;
        done();
      },
    );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  worker = app.get(OcrWorkerService);
  queue = app.get(OcrQueueService);
  queue.setHandler((id) => worker.process(id));
  png = await sharp({
    create: { width: 16, height: 16, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const document = await PDFDocument.create();
  document.addPage();
  document.addPage();
  pdf = Buffer.from(await document.save());
}, 30_000);

afterAll(async () => {
  if (!enabled || !prisma) return;
  if (app) await app.close();
  const docs = await prisma.document.findMany({
    where: { candidate: { chatUuid: { in: chats } } },
    select: { id: true },
  });
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { correlationId: prefix },
        { entityId: { in: docs.map((d) => d.id) } },
      ],
    },
  });
  await prisma.candidate.deleteMany({ where: { chatUuid: { in: chats } } });
  await prisma.employee.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.documentType.deleteMany({ where: { code: typeCode } });
  await prisma.lkLocation.deleteMany({
    where: { code1c: `${prefix}-location` },
  });
  await prisma.$disconnect();
  if (s3) {
    const objects = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    if (objects.Contents?.length)
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects.Contents.map(({ Key }) => ({ Key })) },
        }),
      );
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    s3.destroy();
  }
  const rabbit = await connect(rabbitUrl);
  const ch = await rabbit.createChannel();
  await ch.deleteQueue(`edo.ocr.${prefix}`);
  await ch.deleteQueue(`edo.ocr.${prefix}.dlq`);
  await rabbit.close();
}, 30_000);

describe.skipIf(!enabled)(
  "candidate document pipeline (isolated MariaDB + RabbitMQ + S3)",
  () => {
    it("accepts mixed images/PDF, routes through RabbitMQ, preserves originals and page order", async () => {
      const candidateChat = chat();
      const response = await upload(candidateChat, randomUUID(), {}, [
        { bytes: png, name: "front.jpg", mime: "image/jpeg" }, // MIME/extension are untrusted; detect actual PNG.
        { bytes: pdf, name: "pages.pdf", mime: "application/pdf" },
      ]);
      expect(response.statusCode, response.body).toBe(202);
      const a: UploadAcceptedDto = response.json();
      await worker.tick();
      await until(async () => (await result(a)).job?.status === "SUCCEEDED");
      const r = await result(a);
      expect(r.status).toBe("IN_REVIEW");
      expect(r.ocrSource).toBe("STUB");
      expect(
        r.files.map(({ ordinal, mimeType, pageCount }) => ({
          ordinal,
          mimeType,
          pageCount,
        })),
      ).toEqual([
        { ordinal: 0, mimeType: "image/png", pageCount: 1 },
        { ordinal: 1, mimeType: "application/pdf", pageCount: 2 },
      ]);
      const input = ocr.requests.find((v) => v.jobId === a.jobId)!;
      expect(input.files.map((f) => f.ordinal)).toEqual([0, 1]);
      const link = await app.inject({
        method: "GET",
        url: `/api/v1/documents/${a.documentId}/versions/1/files/${r.files[1].id}/download`,
        headers: reviewer(),
      });
      expect(link.statusCode).toBe(200);
      const bytes = await fetch(link.json().url).then((v) => v.arrayBuffer());
      expect(Buffer.from(bytes)).toEqual(pdf);
      const poll = await app.inject({
        method: "GET",
        url: `/api/internal/edo/v1/candidate-chats/${candidateChat}/documents/${a.documentId}/versions/1`,
        headers: serviceHeaders,
      });
      expect(poll.json().job.status).toBe("SUCCEEDED");
      const foreign = await app.inject({
        method: "GET",
        url: `/api/internal/edo/v1/candidate-chats/${chat()}/documents/${a.documentId}/versions/1`,
        headers: serviceHeaders,
      });
      expect(foreign.statusCode).toBe(404);
      queue.setHandler(async () => undefined); // Subsequent tests control delivery timing explicitly.
    });

    it("deduplicates retries, distinguishes case-sensitive keys, and rejects changed content", async () => {
      const id = chat();
      const key = `${prefix}-idem`;
      const a = await accepted(id, key);
      expect((await upload(id, key)).json()).toEqual(a);
      const altered = await upload(id, key, {}, [
        { bytes: pdf, name: "pages.pdf", mime: "application/pdf" },
      ]);
      expect(altered.statusCode).toBe(409);
      const upper = await accepted(id, key.toUpperCase());
      expect(upper.version).toBe(2);
      expect(upper.documentId).toBe(a.documentId);
    });

    it("serializes concurrent versions for a chat without overwriting the newest completed upload", async () => {
      const id = chat();
      const first = await accepted(id);
      const [a, b] = await Promise.all([accepted(id), accepted(id)]);
      expect([a.version, b.version].sort()).toEqual([2, 3]);
      expect(
        await prisma.document.findUnique({ where: { id: first.documentId } }),
      ).toMatchObject({ currentVersion: 3, status: "OCR_PENDING" });
    });

    it("keeps the original OCR fields, audits corrections and rejects stale review revisions", async () => {
      const a = await accepted();
      await worker.process(a.jobId);
      const r = await result(a);
      const url = `/api/v1/documents/${a.documentId}/versions/1/fields`;
      const edit = await app.inject({
        method: "PATCH",
        url,
        headers: reviewer(),
        payload: {
          revision: r.revision,
          fields: { number: "000999", missing: null },
        },
      });
      expect(edit.statusCode, edit.body).toBe(200);
      expect(
        edit.json().fields.find((f: { name: string }) => f.name === "number"),
      ).toMatchObject({
        originalValue: "000123",
        value: "000999",
        editedBy: "reviewer",
      });
      expect(edit.json().raw).toEqual(r.raw);
      const stale = await app.inject({
        method: "PATCH",
        url,
        headers: reviewer(),
        payload: { revision: r.revision, fields: { number: "bad" } },
      });
      expect(stale.statusCode).toBe(409);
      const approve = await app.inject({
        method: "POST",
        url: `/api/v1/documents/${a.documentId}/versions/1/approve`,
        headers: reviewer(),
        payload: { revision: edit.json().revision },
      });
      expect(approve.statusCode, approve.body).toBe(200);
      expect(approve.json().status).toBe("APPROVED");
      expect(
        await prisma.auditLog.count({
          where: { entityId: a.documentId, action: "DOCUMENT_FIELDS_UPDATED" },
        }),
      ).toBe(1);
      const again = await app.inject({
        method: "PATCH",
        url,
        headers: reviewer(),
        payload: {
          revision: approve.json().revision,
          fields: { number: "bad" },
        },
      });
      expect(again.statusCode).toBe(409);
    });

    it("rolls state back when a critical audit insert fails", async () => {
      const a = await accepted();
      await worker.process(a.jobId);
      const r = await result(a);
      const audit = app.get(AuditService);
      const log = audit.logInTransaction.bind(audit);
      audit.logInTransaction = async () => {
        throw new Error("audit unavailable");
      };
      try {
        const edit = await app.inject({
          method: "PATCH",
          url: `/api/v1/documents/${a.documentId}/versions/1/fields`,
          headers: reviewer(),
          payload: { revision: r.revision, fields: { number: "changed" } },
        });
        expect(edit.statusCode).toBe(500);
        expect((await result(a)).revision).toBe(r.revision);
        expect(
          (await result(a)).fields.find((f) => f.name === "number")?.value,
        ).toBe("000123");
      } finally {
        audit.logInTransaction = log;
      }
    });

    it("returns wrong-document/quality reasons including PDF page, deletes all rejected originals, and retries cleanup", async () => {
      const id = chat();
      const response = await upload(id, randomUUID(), {}, [
        { bytes: pdf, name: "pages.pdf", mime: "application/pdf" },
      ]);
      const a: UploadAcceptedDto = response.json();
      ocr.responses.set(a.jobId, {
        outcome: "REJECTED",
        source: "STUB",
        raw: { fixture: "quality" },
        issues: [
          {
            code: "DOCUMENT_TYPE_MISMATCH",
            message: "Expected passport",
            fileOrdinal: null,
            pageNumber: null,
          },
          {
            code: "POOR_IMAGE_QUALITY",
            message: "Page is blurred",
            fileOrdinal: 0,
            pageNumber: 2,
          },
        ],
      });
      await worker.process(a.jobId);
      const r = await result(a);
      expect(r.job?.status).toBe("REJECTED");
      expect(r.issues[1].pageNumber).toBe(2);
      const download = await app.inject({
        method: "GET",
        url: `/api/v1/documents/${a.documentId}/versions/1/files/${r.files[0].id}/download`,
        headers: reviewer(),
      });
      expect(download.statusCode).toBe(404);
      const storage = app.get(StorageService);
      const remove = storage.delete.bind(storage);
      storage.delete = async () => {
        throw new Error("S3 unavailable");
      };
      try {
        await expect(worker.cleanup()).rejects.toThrow();
        expect((await result(a)).job?.cleanupPending).toBe(true);
      } finally {
        storage.delete = remove;
      }
      const key = (
        await prisma.documentVersionFile.findUniqueOrThrow({
          where: { id: r.files[0].id },
        })
      ).storageKey;
      await worker.cleanup();
      expect((await result(a)).files[0].deleted).toBe(true);
      await expect(
        s3.send(new GetObjectCommand({ Bucket: bucket, Key: key })),
      ).rejects.toThrow();
    });

    it("retries technical failures only five times and distinguishes them from business rejection", async () => {
      const a = await accepted();
      ocr.responses.set(a.jobId, new Error("upstream unavailable"));
      for (let n = 0; n < 5; n++) {
        await prisma.ocrOutbox.update({
          where: { jobId: a.jobId },
          data: { availableAt: new Date(0) },
        });
        await worker.process(a.jobId);
      }
      const r = await result(a);
      expect(r.job?.status).toBe("FAILED");
      expect(r.job?.errorCode).toBe("OCR_UNAVAILABLE");
      expect(r.issues).toEqual([]);
      expect(r.files[0].deleted).toBe(false);
      await worker.process(a.jobId);
      expect(
        (await prisma.ocrJob.findUniqueOrThrow({ where: { id: a.jobId } }))
          .attempts,
      ).toBe(5);
    });

    it("fences late/duplicate results to their own version and preserves a newly approved document", async () => {
      const id = chat();
      const old = await accepted(id);
      let release!: (r: OcrResult) => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      ocr.responses.set(old.jobId, () => {
        entered();
        return new Promise((resolve) => {
          release = resolve;
        });
      });
      const processing = worker.process(old.jobId);
      await started;
      const current = await accepted(id);
      await worker.process(current.jobId);
      const r = await result(current);
      const approved = await app.inject({
        method: "POST",
        url: `/api/v1/documents/${current.documentId}/versions/2/approve`,
        headers: reviewer(),
        payload: { revision: r.revision },
      });
      expect(approved.statusCode).toBe(200);
      release({
        outcome: "SUCCEEDED",
        source: "STUB",
        fields: { number: "old" },
        raw: { old: true },
      });
      await processing;
      expect(
        await prisma.document.findUnique({ where: { id: current.documentId } }),
      ).toMatchObject({ currentVersion: 2, status: "APPROVED" });
      const requests = ocr.requests.length;
      await worker.process(old.jobId);
      expect(ocr.requests.length).toBe(requests);
      const oldEdit = await app.inject({
        method: "PATCH",
        url: `/api/v1/documents/${current.documentId}/versions/1/fields`,
        headers: reviewer(),
        payload: {
          revision: (await result(old)).revision,
          fields: { number: "bad" },
        },
      });
      expect(oldEdit.statusCode).toBe(409);
    });

    it("restores expired processing/upload leases without losing originals or pending jobs", async () => {
      const a = await accepted();
      await prisma.ocrJob.update({
        where: { id: a.jobId },
        data: {
          status: "RUNNING",
          attempts: 1,
          leaseToken: randomUUID(),
          leaseUntil: new Date(0),
        },
      });
      const token = (
        await prisma.ocrJob.findUniqueOrThrow({ where: { id: a.jobId } })
      ).leaseToken!;
      await worker.tick();
      expect((await result(a)).job?.status).toBe("QUEUED");
      await worker.complete(
        a.jobId,
        token,
        {
          outcome: "SUCCEEDED",
          source: "STUB",
          fields: { wrong: "late" },
          raw: {},
        },
        {},
      );
      expect((await result(a)).fields).toEqual([]);
      await prisma.ocrOutbox.update({
        where: { jobId: a.jobId },
        data: { availableAt: new Date(0) },
      });
      await worker.process(a.jobId);
      expect((await result(a)).job?.status).toBe("SUCCEEDED");
    });

    it("enforces service/JWT/action/location access, including candidates with no object", async () => {
      const a = await accepted();
      const scoped = await accepted(chat(), randomUUID(), { locationId: "98" });
      const url = `/api/v1/documents/${a.documentId}/versions/1`;
      expect(
        (await app.inject({ method: "GET", url, headers: serviceHeaders }))
          .statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "GET",
            url,
            headers: reviewer({ "20000": [], "20007": ["98"] }),
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/v1/documents/${scoped.documentId}/versions/1`,
            headers: reviewer({ "20000": [], "20007": ["98"] }),
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `${url}/fields`,
            headers: reviewer({ "20000": [], "20008": [] }),
            payload: { revision: 0, fields: {} },
          })
        ).statusCode,
      ).toBe(403);
      const list = await app.inject({
        method: "GET",
        url: "/api/v1/candidates",
        headers: reviewer({ "20000": [], "20007": ["98"] }),
      });
      expect(
        list
          .json()
          .items.every((c: { locationId: number }) => c.locationId === 98),
      ).toBe(true);
      const body = form([{ bytes: png, name: "page.png", mime: "image/png" }]);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/internal/edo/v1/candidate-chats/${chat()}/documents`,
            headers: {
              ...reviewer(),
              "content-type": body.contentType,
              "idempotency-key": "jwt",
            },
            payload: body.payload,
          })
        ).statusCode,
      ).toBe(401);
    });

    it("links a future code1c idempotently and makes documents discoverable for that employee without moving files", async () => {
      const id = chat();
      const a = await accepted(id);
      const url = `/api/internal/edo/v1/candidate-chats/${id}/employee-link`;
      const code1c = `${prefix}-person`;
      expect(
        (
          await app.inject({
            method: "PUT",
            url,
            headers: serviceHeaders,
            payload: { code1c },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "PUT",
            url,
            headers: serviceHeaders,
            payload: { code1c },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "PUT",
            url,
            headers: serviceHeaders,
            payload: { code1c: "other" },
          })
        ).statusCode,
      ).toBe(409);
      const employee = await prisma.employee.create({
        data: {
          id: `${prefix}-employee`,
          fullName: "Test employee",
          lkEmployeeCode1c: code1c,
        },
      });
      const list = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${employee.id}/documents`,
        headers: reviewer(),
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().items.map((d: { id: string }) => d.id)).toContain(
        a.documentId,
      );
      expect(
        (
          await prisma.document.findUniqueOrThrow({
            where: { id: a.documentId },
          })
        ).candidateId,
      ).toBe(a.candidateId);
      expect(
        await prisma.auditLog.count({
          where: { entityId: a.candidateId, action: "CANDIDATE_LINKED" },
        }),
      ).toBe(1);
    });

    it("rejects invalid requests before S3/job creation and validates runtime availability", async () => {
      const id = chat();
      expect(
        (await upload(id, randomUUID(), { documentTypeCode: "missing" }))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await upload(id, randomUUID(), {}, [
            {
              bytes: Buffer.from("fake"),
              name: "fake.jpg",
              mime: "image/jpeg",
            },
          ])
        ).statusCode,
      ).toBe(415);
      expect(
        (
          await upload(id, randomUUID(), {}, [
            {
              bytes: Buffer.from("%PDF-broken"),
              name: "broken.pdf",
              mime: "application/pdf",
            },
          ])
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await upload(
            id,
            randomUUID(),
            {},
            Array.from({ length: 11 }, () => ({
              bytes: png,
              name: "page.png",
              mime: "image/png",
            })),
          )
        ).statusCode,
      ).toBe(413);
      expect(
        (
          await upload(id, randomUUID(), {}, [
            {
              bytes: Buffer.alloc(10 * 1024 * 1024 + 1),
              name: "large.pdf",
              mime: "application/pdf",
            },
          ])
        ).statusCode,
      ).toBe(413);
      expect(
        await prisma.candidate.findUnique({ where: { chatUuid: id } }),
      ).toBeNull();
      ocr.available = false;
      try {
        expect((await upload(id)).statusCode).toBe(503);
      } finally {
        ocr.available = true;
      }
    });

    it("keeps a queued job durable after an unconfirmed publication", async () => {
      const a = await accepted();
      const publish = queue.publish.bind(queue);
      queue.publish = async () => false;
      try {
        await worker.tick();
        const outbox = await prisma.ocrOutbox.findUniqueOrThrow({
          where: { jobId: a.jobId },
        });
        expect(outbox.publishedAt).toBeNull();
        expect(outbox.leaseToken).toBeNull();
        expect(outbox.availableAt.getTime()).toBeGreaterThan(Date.now());
        expect((await result(a)).job?.status).toBe("QUEUED");
      } finally {
        queue.publish = publish;
      }
    });

    it("recovers a crashed incomplete upload and removes its tracked S3 original", async () => {
      const a = await accepted();
      const job = await prisma.ocrJob.findUniqueOrThrow({
        where: { id: a.jobId },
        include: { version: { include: { files: true } } },
      });
      // Reconstruct the durable state immediately before upload finalization.
      await prisma.ocrOutbox.delete({ where: { jobId: a.jobId } });
      await prisma.document.update({
        where: { id: a.documentId },
        data: { currentVersion: 0, status: "DRAFT" },
      });
      await prisma.ocrJob.update({
        where: { id: a.jobId },
        data: {
          status: "UPLOADING",
          leaseToken: randomUUID(),
          leaseUntil: new Date(0),
        },
      });
      await worker.tick();
      const r = await result(a);
      expect(r.job).toMatchObject({
        status: "FAILED",
        errorCode: "UPLOAD_FAILED",
        cleanupPending: false,
      });
      expect(r.files[0].deleted).toBe(true);
      await expect(
        s3.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: job.version.files[0].storageKey,
          }),
        ),
      ).rejects.toThrow();
    });

    it("enforces exactly one document owner at the database boundary", async () => {
      const a = await accepted();
      const employee = await prisma.employee.create({
        data: { id: `${prefix}-owner`, fullName: "Test owner" },
      });
      await expect(prisma.document.create({ data: {} })).rejects.toThrow();
      await expect(
        prisma.document.create({
          data: { candidateId: a.candidateId, employeeId: employee.id },
        }),
      ).rejects.toThrow();
    });

    it("cleans partial S3 uploads after a failed write", async () => {
      const id = chat();
      const storage = app.get(StorageService);
      const put = storage.upload.bind(storage);
      storage.upload = async (...args) => {
        await put(...args);
        throw new Error("lost S3 response");
      };
      try {
        expect((await upload(id)).statusCode).toBe(503);
      } finally {
        storage.upload = put;
      }
      const job = await prisma.ocrJob.findFirstOrThrow({
        where: { candidate: { chatUuid: id } },
        include: { version: { include: { files: true } } },
      });
      expect(job.status).toBe("FAILED");
      expect(job.cleanupPending).toBe(true);
      await worker.cleanup();
      await expect(
        s3.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: job.version.files[0].storageKey,
          }),
        ),
      ).rejects.toThrow();
      expect(
        await prisma.ocrOutbox.findUnique({ where: { jobId: job.id } }),
      ).toBeNull();
    });
  },
);
