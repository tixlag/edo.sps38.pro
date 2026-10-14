import "reflect-metadata";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { Test } from "@nestjs/testing";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ValidationPipe } from "@nestjs/common";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import multipart from "@fastify/multipart";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import {
  S3Client,
  CreateBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";
import { sign } from "jsonwebtoken";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { PrismaService } from "../src/prisma/prisma.service";
import { AuthModule } from "../src/auth/auth.module";
import { DocumentsModule } from "../src/documents/documents.module";
import { RedisService } from "../src/redis/redis.module";
import { createCatalogRedisDouble } from "./helpers/catalog-redis";
import { DocumentDeliveryService } from "../src/documents/document-delivery.service";
import { StorageService } from "../src/storage/storage.service";
import { AuditService } from "../src/audit/audit.service";
import { applicable, validateFields } from "../src/documents/document-contract";
import { mergeDocumentPdf } from "../src/documents/document-pdf.service";

describe("manual document field contract", () => {
  it("preserves required false and leading zeros, validates actual calendar dates", () => {
    const definitions = [
      { name: "isInvalid", kind: "boolean", required: true, ordinal: 0 },
      { name: "number", kind: "text", required: true, ordinal: 1 },
      { name: "expiryDate", kind: "date", required: false, ordinal: 2 },
    ];
    expect(() =>
      validateFields(definitions, {
        isInvalid: false,
        number: "00012",
        expiryDate: "2030-01-01",
      }),
    ).not.toThrow();
    expect(() =>
      validateFields(definitions, { isInvalid: "false", number: "1" }),
    ).toThrow();
    expect(() =>
      validateFields(definitions, {
        isInvalid: false,
        number: "1",
        expiryDate: "2026-02-31",
      }),
    ).toThrow();
    expect(() =>
      validateFields(definitions, {
        isInvalid: false,
        number: "1",
        unknown: "x",
      }),
    ).toThrow();
  });
  it("uses citizenship OR position applicability", () => {
    const type = {
      allRu: true,
      allForeign: false,
      positions: [{ code1c: "0000491" }],
    };
    expect(applicable(type, "0000000", "RU")).toBe(true);
    expect(applicable(type, "0000491", "kg")).toBe(true);
    expect(applicable(type, "0000000", "kg")).toBe(false);
  });
  it("merges image and PDF pages in order and preserves a single PDF byte-for-byte", async () => {
    const source = await PDFDocument.create();
    source.addPage([100, 200]);
    source.addPage([300, 400]);
    const pdf = Buffer.from(await source.save());
    const image = await sharp({
      create: { width: 20, height: 30, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    expect(
      await mergeDocumentPdf([{ mimeType: "application/pdf", bytes: pdf }]),
    ).toEqual(pdf);
    const merged = await PDFDocument.load(
      await mergeDocumentPdf([
        { mimeType: "image/png", bytes: image },
        { mimeType: "application/pdf", bytes: pdf },
      ]),
    );
    expect(
      merged.getPages().map((page) => [page.getWidth(), page.getHeight()]),
    ).toEqual([
      [20, 30],
      [100, 200],
      [300, 400],
    ]);
  });
});

const db = process.env.EDO_TEST_DATABASE_URL ?? "";
const endpoint = process.env.EDO_TEST_S3_ENDPOINT ?? "";
if (
  db &&
  !/^mysql:\/\/[^@/]+@(127\.0\.0\.1|localhost):(3307|3308)\/edo(\?|$)/.test(db)
)
  throw new Error("Refusing shared manual-document test DB");
if (endpoint && !/^http:\/\/(127\.0\.0\.1|localhost):5001$/.test(endpoint))
  throw new Error("Refusing shared manual-document test S3");
const enabled = !!(db && endpoint);
const suite = describe.skipIf(!enabled);
const typeUid = randomUUID();
const bucket = `manual-test-${Date.now()}`;
const secret = "manual-document-test-jwt";
const service = { authorization: "Bearer manual-test-service" };
const reviewer = (rules = { "20009": [] } as Record<string, string[]>) => ({
  authorization: `Bearer ${sign({ uuid: "reviewer", accessRules: rules }, secret, { issuer: "lk-auth-service", algorithm: "HS256", expiresIn: 600 })}`,
});
let prisma: PrismaService,
  app: NestFastifyApplication,
  s3: S3Client,
  server: Server,
  delivery: DocumentDeliveryService;
let image: Buffer, apiUrl: string;
let erpStatus = 503;
let posts: Array<Record<string, unknown>> = [];
const owners: string[] = [];
function requestForm(
  chat = randomUUID(),
  values: Record<string, string | boolean> = {
    number: "000123",
    issueDate: "2026-10-12",
    isInvalid: false,
  },
) {
  owners.push(`chat:${chat}`);
  const form = new FormData();
  form.set(
    "metadata",
    JSON.stringify({
      documentUid: typeUid,
      chat_uuid: chat,
      position_code_1c: "0000491",
      documentFields: values,
    }),
  );
  form.append(
    "files[]",
    new Blob([new Uint8Array(image)], { type: "image/png" }),
    "photo.png",
  );
  return form;
}
async function upload(form: FormData, key = randomUUID()) {
  return fetch(`${apiUrl}/api/internal/edo/v1/documents`, {
    method: "POST",
    headers: { ...service, "Idempotency-Key": key },
    body: form,
  });
}
async function json(response: Response) {
  return response.json() as Promise<{
    documentId: string;
    version: number;
    candidateId: string;
    submissionId: string;
    jobId: null;
  }>;
}

suite("manual documents with isolated MariaDB/S3 and ERP stub", () => {
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
      if (
        req.headers.token !== "test-token" ||
        req.headers.authorization !==
          `Basic ${Buffer.from("test-user:test-password").toString("base64")}`
      ) {
        res.statusCode = 401;
        res.end();
        return;
      }
      if (req.url === "/documents-by-positions") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify([
            {
              УИНДокумента: typeUid,
              НаименованиеДокумента: "Test passport",
              КодыДолжностей: ["0000491"],
              ВсемРФ: true,
              ВсемИГ: false,
              requiredFields: ["number", "issueDate", "isInvalid"],
              optionalFields: ["positionUid", "comment"],
            },
          ]),
        );
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      posts.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.statusCode = erpStatus;
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    const config = new ConfigService({
      NODE_ENV: "test",
      JWT_SECRET: secret,
      JWT_ALG: "HS256",
      JWT_ISSUER: "lk-auth-service",
      EDO_LK_INTERNAL_TOKEN: "manual-test-service",
      OCR_MODE: "disabled",
      OCR_WORKER_ENABLED: "false",
      DOCUMENT_WORKER_ENABLED: "false",
      S3_ENDPOINT: endpoint,
      S3_REGION: "us-east-1",
      S3_BUCKET: bucket,
      S3_ACCESS_KEY: "test",
      S3_SECRET_KEY: "test",
      ERP_DOCUMENTS_BASE_URL: `http://127.0.0.1:${port}/`,
      ERP_DOCUMENTS_TOKEN: "test-token",
      ERP_USERNAME: "test-user",
      ERP_PASSWORD: "test-password",
      EDO_PUBLIC_API_URL: "http://localhost",
    });
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        DocumentsModule,
        AuthModule,
      ],
    })
      .overrideProvider(RedisService)
      .useValue(createCatalogRedisDouble())
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(ConfigService)
      .useValue(config)
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.register(multipart);
    app.setGlobalPrefix("api");
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.listen(0, "127.0.0.1");
    apiUrl = await app.getUrl();
    config.set("EDO_PUBLIC_API_URL", `${apiUrl}/api`);
    delivery = app.get(DocumentDeliveryService);
    image = await sharp({
      create: { width: 16, height: 24, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
  }, 30000);
  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      await prisma.candidate.deleteMany({
        where: { identityKey: { in: owners } },
      });
      await prisma.documentType.deleteMany({ where: { erpUid: typeUid } });
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
              Objects: objects.Contents.map((object) => ({ Key: object.Key! })),
            },
          }),
        );
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
      s3.destroy();
    }
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 30000);
  it("uploads directly into review without OCR, preserves submitted fields and deduplicates metadata", async () => {
    const chat = randomUUID(),
      key = randomUUID();
    const response = await upload(requestForm(chat), key);
    expect(response.status).toBe(202);
    const body = await json(response);
    expect(body.jobId).toBeNull();
    expect(body.submissionId).toBeTruthy();
    const version = await prisma.documentVersion.findUniqueOrThrow({
      where: {
        documentId_version: {
          documentId: body.documentId,
          version: body.version,
        },
      },
      include: { fields: true, job: true },
    });
    expect(version.status).toBe("IN_REVIEW");
    expect(version.job).toBeNull();
    expect(
      version.fields.find((f) => f.name === "number")?.submittedValue,
    ).toBe("000123");
    expect(version.fields.find((f) => f.name === "isInvalid")?.value).toBe(
      "false",
    );
    expect((await json(await upload(requestForm(chat), key))).documentId).toBe(
      body.documentId,
    );
    expect(
      (
        await upload(
          requestForm(chat, {
            number: "000124",
            issueDate: "2026-10-12",
            isInvalid: false,
          }),
          key,
        )
      ).status,
    ).toBe(409);
  });
  it("stores approval PDF, retains approval on ERP failure and sends again only manually", async () => {
    const body = await json(await upload(requestForm()));
    const approve = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${body.documentId}/versions/1/approve`,
      headers: reviewer(),
      payload: { revision: 0 },
    });
    expect(approve.statusCode).toBe(200);
    const approved = await prisma.documentVersion.findUniqueOrThrow({
      where: {
        documentId_version: { documentId: body.documentId, version: 1 },
      },
    });
    expect(approved.approvedStorageKey).toBeTruthy();
    expect(
      (
        await PDFDocument.load(
          await app.get(StorageService).read(approved.approvedStorageKey!),
        )
      ).getPageCount(),
    ).toBe(1);
    const count = posts.length;
    await delivery.tick();
    expect(posts.length).toBe(count + 1);
    await delivery.tick();
    expect(posts.length).toBe(count + 1);
    const status = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${body.documentId}/versions/1`,
      headers: reviewer(),
    });
    expect(status.json().status).toBe("APPROVED");
    expect(status.json().delivery.status).toBe("REQUIRES_MANUAL");
    expect(posts.at(-1)?.documentUid).toBe(typeUid);
    expect(
      (posts.at(-1)?.documentFields as Record<string, unknown>).isInvalid,
    ).toBe(false);
    expect(posts.at(-1)?.fileExtension).toBe("pdf");
    erpStatus = 204;
    const sent = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${body.documentId}/versions/1/send-to-erp`,
      headers: reviewer(),
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().delivery.status).toBe("SENT");
    expect(sent.json().delivery.attempts).toHaveLength(2);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/documents/${body.documentId}/versions/1/send-to-erp`,
          headers: reviewer({ "20002": [], "20008": [] }),
        })
      ).statusCode,
    ).toBe(403);
  });
  it("rejects stale revisions, rolls back approval audit failures and cleans rejected files", async () => {
    const body = await json(await upload(requestForm()));
    const audit = vi
      .spyOn(app.get(AuditService), "logInTransaction")
      .mockImplementation(async (_tx, event) => {
        if (event.action === "DOCUMENT_APPROVED")
          throw new Error("audit failure");
      });
    const failed = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${body.documentId}/versions/1/approve`,
      headers: reviewer(),
      payload: { revision: 0 },
    });
    expect(failed.statusCode).toBe(500);
    audit.mockRestore();
    const version = await prisma.documentVersion.findUniqueOrThrow({
      where: {
        documentId_version: { documentId: body.documentId, version: 1 },
      },
    });
    expect(version.status).toBe("IN_REVIEW");
    expect(version.pendingApprovalStorageKey).toBeNull();
    const reject = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${body.documentId}/versions/1/reject`,
      headers: reviewer(),
      payload: { revision: 0, reason: "Более качественное фото" },
    });
    expect(reject.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/documents/${body.documentId}/versions/1/approve`,
          headers: reviewer(),
          payload: { revision: 0 },
        })
      ).statusCode,
    ).toBe(409);
    const file = reject.json().files[0];
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/documents/${body.documentId}/versions/1/files/${file.id}/download`,
          headers: reviewer(),
        })
      ).statusCode,
    ).toBe(404);
    await delivery.tick();
    expect(
      (
        await prisma.documentVersionFile.findUniqueOrThrow({
          where: { id: file.id },
        })
      ).deletedAt,
    ).not.toBeNull();
  });
  it("links a chat before its first upload, preserves owner identity and fences conflicting links", async () => {
    const chat = randomUUID();
    owners.push(`chat:${chat}`);
    const url = `/api/internal/edo/v1/candidate-chats/${chat}/employee-link`;
    expect(
      (
        await app.inject({
          method: "PUT",
          url,
          headers: service,
          payload: { code1c: "TEST-CODE" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "PUT",
          url,
          headers: service,
          payload: { code1c: "TEST-CODE" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "PUT",
          url,
          headers: service,
          payload: { code1c: "OTHER-CODE" },
        })
      ).statusCode,
    ).toBe(409);
  });
  it("accepts employee-only uploads but waits for the ERP code_1c contract", async () => {
    const code = `CODE-${randomUUID()}`;
    owners.push(`employee:${code}`);
    const form = requestForm();
    const metadata = JSON.parse(form.get("metadata") as string);
    delete metadata.chat_uuid;
    metadata.code_1c = code;
    form.set("metadata", JSON.stringify(metadata));
    const body = await json(await upload(form));
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/documents/${body.documentId}/versions/1/approve`,
          headers: reviewer(),
          payload: { revision: 0 },
        })
      ).statusCode,
    ).toBe(200);
    const count = posts.length;
    await delivery.tick();
    expect(posts).toHaveLength(count);
    const status = await app.inject({
      method: "GET",
      url: `/api/internal/edo/v1/documents?code_1c=${code}`,
      headers: service,
    });
    expect(status.json().items[0]).toMatchObject({
      id: body.documentId,
      code1c: code,
      chatUuid: null,
      status: "APPROVED",
      deliveryStatus: "WAITING_CONTRACT",
    });
  });
  it("fences concurrent submissions with one receipt and one version", async () => {
    const chat = randomUUID(),
      key = randomUUID();
    const responses = await Promise.all([
      upload(requestForm(chat), key),
      upload(requestForm(chat), key),
    ]);
    expect(responses.map((r) => r.status)).toContain(202);
    expect(responses.every((r) => [202, 409].includes(r.status))).toBe(true);
    expect(
      await prisma.documentSubmission.count({
        where: { identityKey: `chat:${chat}`, idempotencyKey: key },
      }),
    ).toBe(1);
    expect(
      await prisma.documentVersion.count({
        where: { document: { candidate: { chatUuid: chat } } },
      }),
    ).toBe(1);
  });
  it("streams current owner statuses, excludes other chats, updates after rejection and rejects expired grants", async () => {
    const chat = randomUUID();
    const body = await json(await upload(requestForm(chat)));
    const grant = await app.inject({
      method: "POST",
      url: "/api/internal/edo/v1/document-stream-grants",
      headers: service,
      payload: { chat_uuid: chat },
    });
    expect(grant.statusCode).toBe(200);
    const connection = grant.json();
    const controller = new AbortController();
    const response = await fetch(connection.url, {
      headers: { Authorization: `Bearer ${connection.token}` },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const readFrame = async () => {
      let text = "";
      while (!text.includes("event: documents") || !text.endsWith("\n\n")) {
        const chunk = await reader.read();
        if (chunk.done)
          throw new Error("Stream ended before a document snapshot");
        text += new TextDecoder().decode(chunk.value);
      }
      return text;
    };
    try {
      const initial = await readFrame();
      expect(initial).toContain(body.documentId);
      expect(initial).toContain("IN_REVIEW");
      expect(initial.match(/"documentTypeCode"/g)).toHaveLength(1);
      await app.inject({
        method: "POST",
        url: `/api/v1/documents/${body.documentId}/versions/1/reject`,
        headers: reviewer(),
        payload: { revision: 0, reason: "Фото нечёткое" },
      });
      expect(await readFrame()).toContain("RETURNED");
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
    await prisma.documentStreamGrant.updateMany({
      data: { expiresAt: new Date(0) },
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/document-status-events",
          headers: { Authorization: `Bearer ${connection.token}` },
        })
      ).statusCode,
    ).toBe(401);
  });
});
