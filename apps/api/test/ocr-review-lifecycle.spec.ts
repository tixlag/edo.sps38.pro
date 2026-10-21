import { afterEach, describe, expect, it, vi } from "vitest";
import { OcrWorkerService } from "../src/ocr/ocr-worker.service";
import { DocumentReviewService } from "../src/documents/document-review.service";
import { DocumentReadService } from "../src/documents/document-read.service";
import type { OcrResult } from "../src/ocr/ocr.service";
import { normalizeOcrResponse } from "../src/ocr/external-ocr.service";

const principal = {
  uuid: "verified-reviewer",
  code1c: null,
  sid: null,
  deviceId: null,
  accessRules: { "20009": [] },
  expiresAt: null,
};
const result: OcrResult = {
  outcome: "SUCCEEDED",
  source: "EXTERNAL",
  raw: {},
  fields: { number: "OCR" },
  ocrFields: [
    {
      name: "number",
      documentFieldName: "number",
      value: "OCR",
      source: "GLM",
      paddleText: "PADDLE",
      paddleConfidence: 0.4,
    },
  ],
};

function workerFixture() {
  const version = {
    id: "v1",
    documentId: "doc",
    version: 1,
    status: "IN_REVIEW",
    citizenship: "ru",
    submission: { id: "submission" },
    files: [],
    document: { currentVersion: 1, documentType: { code: "PASSPORT" } },
  };
  const job = {
    id: "job",
    candidateId: "owner",
    versionId: "v1",
    status: "QUEUED",
    leaseToken: null as string | null,
    attempts: 0,
    version,
    correlationId: "correlation",
  };
  const updateMany = vi.fn(async (args) => {
    if (args.where.status && args.where.status !== job.status)
      return { count: 0 };
    if (args.where.leaseToken && args.where.leaseToken !== job.leaseToken)
      return { count: 0 };
    Object.assign(job, args.data);
    return { count: 1 };
  });
  const tx = {
    $queryRaw: vi.fn(async () => []),
    ocrJob: { findUnique: vi.fn(async () => job), updateMany },
    ocrOutbox: { update: vi.fn() },
    documentVersion: {
      findUnique: vi.fn(async () => version),
      update: vi.fn(),
    },
    documentVersionOcrField: { createMany: vi.fn() },
    documentVersionField: {
      updateMany: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn(async () => [
        { id: "series", name: "series" },
        { id: "number", name: "number" },
      ]),
    },
    documentVersionFile: {
      findMany: vi.fn(async () => [{ id: "scan", ordinal: 0, pageCount: 2 }]),
    },
    ocrRegion: { createMany: vi.fn() },
    document: { updateMany: vi.fn() },
    ocrIssue: { createMany: vi.fn() },
  };
  const recognize = vi.fn(async () => result);
  const audit = { logInTransaction: vi.fn() };
  const worker = new OcrWorkerService(
    {
      ocrJob: { updateMany, findUniqueOrThrow: vi.fn(async () => job) },
      $transaction: async (run) => run(tx),
    } as never,
    {} as never,
    { recognize } as never,
    {} as never,
    audit as never,
    { get: () => undefined } as never,
  );
  return { worker, tx, job, version, recognize, audit };
}
afterEach(() => vi.useRealTimers());

describe("manual review enrichment", () => {
  it("stores source boxes for split and unmapped observations without creating candidate requisites", async () => {
    const { worker, tx, job } = workerFixture();
    job.status = "RUNNING";
    job.leaseToken = "lease";
    const region = {
      file_index: 0,
      page_number: 2,
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.05,
      text: "AA1234567",
    };
    const observed = normalizeOcrResponse("passport_uz", [
      {
        type: "passport",
        fields: {},
        ocr_fields: [
          {
            name: "pas_number",
            value: "AA1234567",
            source: "PADDLE",
            paddle_text: "AA1234567",
            paddle_confidence: 0.99,
            regions: [region],
          },
          {
            name: "pas_nationality",
            value: "UZBEKISTAN",
            source: "GLM",
            paddle_text: null,
            paddle_confidence: null,
            regions: [{ ...region, y: 0.5 }],
          },
        ],
      },
    ]);
    await worker.complete("job", "lease", observed, {});
    const observations =
      tx.documentVersionOcrField.createMany.mock.calls[0][0].data;
    const geometry = tx.ocrRegion.createMany.mock.calls[0][0].data;
    expect(observations[0]).not.toHaveProperty("regions");
    expect(geometry).toEqual([
      expect.objectContaining({
        fieldId: "series",
        ocrFieldId: observations[0].id,
        fileId: "scan",
        pageNumber: 2,
      }),
      expect.objectContaining({
        fieldId: "number",
        ocrFieldId: observations[0].id,
        fileId: "scan",
        pageNumber: 2,
      }),
      expect.objectContaining({
        fieldId: null,
        ocrFieldId: observations[1].id,
        fileId: "scan",
        y: 0.5,
      }),
    ]);
    expect(tx.documentVersionField.createMany).not.toHaveBeenCalled();
    expect(tx.documentVersionField.updateMany).toHaveBeenCalledWith({
      where: { versionId: "v1", name: "number" },
      data: { originalValue: "1234567", ocrText: "1234567" },
    });
  });
  it("stores observations and comparison values without overwriting requisites", async () => {
    const { worker, tx, job } = workerFixture();
    await worker.process("job");
    expect(job.status).toBe("SUCCEEDED");
    expect(tx.documentVersionField.updateMany).toHaveBeenCalledWith({
      where: { versionId: "v1", name: "number" },
      data: { originalValue: "OCR", ocrText: "OCR" },
    });
    expect(tx.documentVersionField.createMany).not.toHaveBeenCalled();
    expect(tx.documentVersionOcrField.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          paddleConfidence: 0.4,
          paddleText: "PADDLE",
          source: "GLM",
        }),
      ],
    });
    expect(tx.documentVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "IN_REVIEW" }),
      }),
    );
    const stored = tx.documentVersionOcrField.createMany.mock.calls.length;
    await worker.process("job");
    expect(tx.documentVersionOcrField.createMany).toHaveBeenCalledTimes(stored);
  });
  it("does not apply late success after approval or a newer version", async () => {
    for (const condition of ["reviewed", "superseded"]) {
      const { worker, tx, version, recognize, job } = workerFixture();
      recognize.mockImplementation(async () => {
        if (condition === "reviewed") version.status = "APPROVED";
        else version.document.currentVersion = 2;
        return result;
      });
      await worker.process("job");
      expect(job.status).toBe("CANCELLED");
      expect(tx.documentVersion.update).not.toHaveBeenCalled();
      expect(tx.documentVersionOcrField.createMany).not.toHaveBeenCalled();
    }
  });
  it("keeps review and originals available after OCR rejection or contract failure", async () => {
    const rejected = workerFixture();
    rejected.recognize.mockResolvedValue({
      outcome: "REJECTED",
      source: "EXTERNAL",
      raw: {},
      issues: [
        {
          code: "POOR_IMAGE_QUALITY",
          message: "Quality",
          fileOrdinal: null,
          pageNumber: null,
        },
      ],
    });
    await rejected.worker.process("job");
    expect(rejected.job).toMatchObject({
      status: "REJECTED",
      cleanupPending: false,
    });
    expect(rejected.tx.documentVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "IN_REVIEW" }),
      }),
    );
    const failed = workerFixture();
    failed.recognize.mockRejectedValue(new Error("OCR_CONTRACT_INVALID"));
    await failed.worker.process("job");
    expect(failed.job.status).toBe("FAILED");
    expect(failed.tx.documentVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "IN_REVIEW" }),
      }),
    );
  });
});

describe("review decision metadata", () => {
  it.each([false, true])(
    "records decision and verified actor for return=%s, atomically with audit",
    async (returned) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-20T08:00:00Z"));
      const version = {
        id: "v1",
        status: "IN_REVIEW",
        revision: 2,
        fields: [],
        submission: null,
        job: { id: "job", status: "RUNNING" },
      };
      const tx = {
        $queryRaw: vi.fn(async () => []),
        document: {
          findUnique: vi.fn(async () => ({ candidateId: "owner" })),
          findFirst: vi.fn(async () => ({ currentVersion: 1 })),
          update: vi.fn(),
        },
        documentVersion: {
          findUnique: vi.fn(async () => version),
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
        ocrJob: { updateMany: vi.fn() },
      };
      const audit = { logInTransaction: vi.fn() };
      const prisma = {
        documentVersion: tx.documentVersion,
        $transaction: vi.fn(async (run) => run(tx)),
      };
      const service = new DocumentReviewService(
        prisma as never,
        { document: vi.fn(), documentWhere: () => ({}) } as never,
        audit as never,
        { version: vi.fn() } as never,
        {} as never,
      );
      if (returned)
        await service.reject(
          "doc",
          1,
          2,
          "Return reason",
          principal,
          "correlation",
        );
      else await service.approve("doc", 1, 2, principal, "correlation");
      expect(tx.documentVersion.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            reviewedAt: new Date("2026-10-20T08:00:00Z"),
            reviewedBy: "verified-reviewer",
            status: returned ? "RETURNED" : "APPROVED",
          }),
        }),
      );
      expect(tx.ocrJob.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "CANCELLED" }),
        }),
      );
      expect(audit.logInTransaction).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          actorId: "verified-reviewer",
          action: returned ? "DOCUMENT_RETURNED" : "DOCUMENT_APPROVED",
        }),
      );
    },
  );
  it("serializes UTC dates and resolves reviewer from projection without inventing a name", async () => {
    const row = {
      status: "APPROVED",
      revision: 3,
      fields: [],
      files: [],
      issues: [],
      job: null,
      delivery: null,
      approvedAt: null,
      submittedAt: new Date("2026-10-20T16:00:00+08:00"),
      reviewedAt: new Date("2026-10-20T17:00:00+08:00"),
      reviewedBy: "verified-reviewer",
      ocrFields: [],
    };
    const service = new DocumentReadService(
      {
        documentVersion: { findUnique: vi.fn(async () => row) },
        lkEmployee: {
          findMany: vi.fn(async () => [{ fullName: "Тестовый Проверяющий" }]),
        },
      } as never,
      {} as never,
      {} as never,
    );
    expect(await service.version("doc", 1)).toMatchObject({
      submittedAt: "2026-10-20T08:00:00.000Z",
      reviewedAt: "2026-10-20T09:00:00.000Z",
      reviewedBy: "verified-reviewer",
      reviewedByName: "Тестовый Проверяющий",
    });
  });
});
