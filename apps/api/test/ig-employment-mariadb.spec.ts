import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { AuditService } from "../src/audit/audit.service";
import { IgEmploymentService } from "../src/documents/ig-employment.service";
import { tryCompleteIgEmployment } from "../src/documents/ig-completion";
import { EMPLOYMENT_PATENT_UID } from "../src/documents/reemployment-document-policy";
import { MIGRATION_UID } from "../src/ocr/ocr-profile";
import { ManualDocumentService } from "../src/documents/manual-document.service";
import { ConfigService } from "@nestjs/config";

const db = process.env.EDO_TEST_DATABASE_URL;
if (db && db !== "mysql://root:isolated-test@127.0.0.1:3308/edo")
  throw new Error("Refuse non-disposable database");
describe.skipIf(!db)("IG cycles on disposable MariaDB", () => {
  const code1c = `IG-${randomUUID()}`;
  const personUid = randomUUID();
  const uploadCode = `IG-${randomUUID()}`;
  const concurrentCode = `IG-${randomUUID()}`;
  const grant = () => ({
    id: randomUUID(),
    employeeCode1c: code1c,
    citizenship: "UZ",
    createdAt: new Date().toISOString(),
  });
  let prisma: PrismaService, audit: AuditService, service: IgEmploymentService;
  const types: string[] = [];
  beforeAll(async () => {
    prisma = new PrismaService({ datasourceUrl: db });
    audit = new AuditService(prisma);
    service = new IgEmploymentService(
      prisma,
      {
        identity: vi.fn(async () => ({
          code1C: code1c,
          personUid,
          reviewGroup: "IG",
          recipientType: "person",
        })),
      } as never,
      audit,
      {
        findByEmployeeCode: vi.fn(async () => ({
          name: "Test IG",
          position: { code: "POS", name: "Test" },
        })),
      } as never,
    );
    for (const erpUid of [MIGRATION_UID, EMPLOYMENT_PATENT_UID, randomUUID()]) {
      const row = await prisma.documentType.create({
        data: {
          erpUid,
          code: randomUUID(),
          title: "Test",
          requiredForAll: true,
          catalogSyncedAt: new Date(),
        },
      });
      types.push(row.id);
    }
  });
  afterAll(async () => {
    const candidates = await prisma.candidate.findMany({
      where: { code1c: { in: [code1c, uploadCode, concurrentCode] } },
      select: { id: true },
    });
    const candidateIds = candidates.map((row) => row.id);
    await prisma.igEmploymentState.deleteMany({
      where: { code1c: { in: [code1c, uploadCode, concurrentCode] } },
    });
    await prisma.igGrantEvent.deleteMany({
      where: { code1c: { in: [code1c, uploadCode, concurrentCode] } },
    });
    await prisma.document.deleteMany({
      where: { candidateId: { in: candidateIds } },
    });
    await prisma.auditLog.deleteMany({
      where: { entityId: { in: candidateIds } },
    });
    await prisma.candidate.deleteMany({ where: { id: { in: candidateIds } } });
    await prisma.documentType.deleteMany({ where: { id: { in: types } } });
    await prisma.$disconnect();
  });
  it("deduplicates concurrent grants, completes the case and starts a new cycle without moving its documents", async () => {
    const firstEvent = grant();
    const [firstRes, replayRes, concurrentRes] = await Promise.all([
      service.applyGrant(firstEvent),
      service.applyGrant(firstEvent),
      service.applyGrant(grant()),
    ]);
    const first = firstRes.candidateId!;
    expect(replayRes.candidateId).toBe(first);
    expect(concurrentRes.candidateId).toBe(first);
    for (const documentTypeId of types)
      await prisma.document.create({
        data: { candidateId: first, documentTypeId, status: "APPROVED" },
      });
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${first} FOR UPDATE`;
      await tryCompleteIgEmployment(tx, audit, first, "reviewer", "test");
    });
    expect(
      (await prisma.candidate.findUniqueOrThrow({ where: { id: first } }))
        .igCompletedAt,
    ).not.toBeNull();
    const delayed = { ...grant(), createdAt: firstEvent.createdAt };
    expect((await service.applyGrant(delayed)).candidateId).toBe(first);
    const secondRes = await service.applyGrant({
      ...grant(),
      createdAt: new Date(Date.now() + 1000).toISOString(),
    });
    const second = secondRes.candidateId!;
    expect(second).not.toBe(first);
    expect(await prisma.document.count({ where: { candidateId: first } })).toBe(
      3,
    );
    expect(
      await prisma.document.count({ where: { candidateId: second } }),
    ).toBe(0);
    expect(
      (await prisma.candidate.findUniqueOrThrow({ where: { id: second } }))
        .personUid,
    ).toBe(personUid);
  });
  it("attaches the later grant to the case created by the first upload", async () => {
    const docType = await prisma.documentType.findUniqueOrThrow({
      where: { id: types[2] },
    });
    const manual = new ManualDocumentService(
      prisma,
      { keyFor: () => "test-file", upload: async () => undefined } as never,
      audit,
      { ensure: async () => undefined } as never,
      new ConfigService({ OCR_MODE: "disabled" }),
    );
    const uploaded = await manual.upload(
      {
        directory: "unused",
        files: [
          {
            id: randomUUID(),
            ordinal: 0,
            filename: "test.pdf",
            mimeType: "application/pdf",
            sizeBytes: 1,
            sha256: "a".repeat(64),
            pageCount: 1,
            path: "unused",
          },
        ],
        metadata: {
          documentUid: docType.erpUid!,
          code_1c: uploadCode,
          citizenship: "uz",
          position_code_1c: "POS",
          documentFields: {},
        },
      } as never,
      randomUUID(),
      "test",
    );
    const other = new IgEmploymentService(
      prisma,
      {
        identity: vi.fn(async () => ({
          code1C: uploadCode,
          personUid,
          reviewGroup: "IG",
          recipientType: "person",
        })),
      } as never,
      audit,
    );
    expect(
      (await other.applyGrant({ ...grant(), employeeCode1c: uploadCode }))
        .candidateId,
    ).toBe(uploaded.candidateId);
    expect(
      await prisma.candidate.count({ where: { code1c: uploadCode } }),
    ).toBe(1);
  });
  it("uses one case when the first upload races with the access grant", async () => {
    const docType = await prisma.documentType.findUniqueOrThrow({
      where: { id: types[2] },
    });
    const manual = new ManualDocumentService(
      prisma,
      { keyFor: () => "test-file", upload: async () => undefined } as never,
      audit,
      { ensure: async () => undefined } as never,
      new ConfigService({ OCR_MODE: "disabled" }),
    );
    const other = new IgEmploymentService(
      prisma,
      {
        identity: vi.fn(async () => ({
          code1C: concurrentCode,
          personUid,
          reviewGroup: "IG",
          recipientType: "person",
        })),
      } as never,
      audit,
    );
    const [uploaded, granted] = await Promise.all([
      manual.upload(
        {
          directory: "unused",
          files: [
            {
              id: randomUUID(),
              ordinal: 0,
              filename: "test.pdf",
              mimeType: "application/pdf",
              sizeBytes: 1,
              sha256: "a".repeat(64),
              pageCount: 1,
              path: "unused",
            },
          ],
          metadata: {
            documentUid: docType.erpUid!,
            code_1c: concurrentCode,
            citizenship: "uz",
            position_code_1c: "POS",
            documentFields: {},
          },
        } as never,
        randomUUID(),
        "test",
      ),
      other.applyGrant({ ...grant(), employeeCode1c: concurrentCode }),
    ]);
    expect(uploaded.candidateId).toBe(granted.candidateId);
    expect(
      await prisma.candidate.count({ where: { code1c: concurrentCode } }),
    ).toBe(1);
  });
});
