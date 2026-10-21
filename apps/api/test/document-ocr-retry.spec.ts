import { describe, expect, it, vi } from "vitest";
import { DocumentOcrRetryService } from "../src/documents/document-ocr-retry.service";
import { canRetryDocumentOcr } from "../src/ocr/ocr-retry-policy";
import { MIGRATION_UID, PASSPORT_UID } from "../src/ocr/ocr-profile";

const principal = { uuid: "reviewer", accessRules: { "20002": [] } };
function fixture() {
  const version = {
    id: "v4",
    documentId: "document",
    version: 4,
    revision: 3,
    status: "IN_REVIEW",
    citizenship: "ru",
    reviewedAt: null,
    cleanupPending: false,
    ocrSource: null,
    submittedAt: new Date("2026-10-20T10:00:00Z"),
    document: {
      candidateId: "candidate",
      currentVersion: 4,
      documentType: { erpUid: PASSPORT_UID, code: "passport" },
    },
    files: [{ id: "file", deletedAt: null as Date | null }],
    job: {
      id: "job",
      status: "FAILED",
      errorCode: "OCR_UNAVAILABLE",
      attempts: 3,
      cleanupPending: false,
    },
    submission: {
      id: "submission",
      status: "SUCCEEDED",
      fingerprint: "fingerprint",
    } as { id: string; status: string; fingerprint: string } | null,
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    document: {
      findUnique: vi.fn(async () => ({ candidateId: "candidate" })),
      findFirst: vi.fn(async () => ({ id: "document" })),
      update: vi.fn(),
    },
    documentVersion: {
      findUnique: vi.fn(async () => version),
      update: vi.fn(),
    },
    ocrJob: { updateMany: vi.fn(async () => ({ count: 1 })) },
    ocrOutbox: { upsert: vi.fn() },
    ocrIssue: { deleteMany: vi.fn() },
    documentVersionOcrField: { deleteMany: vi.fn() },
  };
  const config = { OCR_MODE: "external", OCR_WORKER_ENABLED: "true" };
  const audit = { logInTransaction: vi.fn() };
  const reads = {
    version: vi.fn(async () => ({
      job: { status: "QUEUED" },
      canRetryOcr: false,
    })),
  };
  const service = new DocumentOcrRetryService(
    { $transaction: (run) => run(tx) } as never,
    { documentWhere: () => ({ candidate: { locationId: 10 } }) } as never,
    audit as never,
    reads as never,
    { get: (key) => config[key] } as never,
  );
  const retry = () =>
    service.retry("document", 4, 3, principal as never, "correlation");
  return { version, tx, config, audit, reads, retry };
}

describe("OCR retry eligibility", () => {
  it.each([
    [PASSPORT_UID, "ru"],
    [PASSPORT_UID, "uz"],
    [MIGRATION_UID, "tj"],
  ])(
    "allows failed OCR only for a supported document (%s, %s)",
    (erpUid, citizenship) => {
      const { version } = fixture();
      version.document.documentType.erpUid = erpUid;
      version.citizenship = citizenship;
      for (const status of ["FAILED", "REJECTED"]) {
        version.job.status = status;
        expect(canRetryDocumentOcr(version, true)).toBe(true);
      }
    },
  );
  it.each(["QUEUED", "RUNNING", "SUCCEEDED", "UPLOADING", "CANCELLED"])(
    "does not expose retry for %s",
    (status) => {
      const { version } = fixture();
      version.job.status = status;
      expect(canRetryDocumentOcr(version, true)).toBe(false);
    },
  );
  it("does not treat an absent OCR job as a failed attempt", () => {
    const { version } = fixture();
    expect(canRetryDocumentOcr({ ...version, job: null }, true)).toBe(false);
  });
  it("rejects unsupported types/citizenship, historical/reviewed versions, disabled OCR and unavailable originals", () => {
    for (const change of [
      (v) => {
        v.document.documentType.erpUid = "unsupported";
      },
      (v) => {
        v.citizenship = "tj";
      },
      (v) => {
        v.document.currentVersion = 5;
      },
      (v) => {
        v.status = "RETURNED";
      },
      (v) => {
        v.status = "APPROVED";
      },
      (v) => {
        v.reviewedAt = new Date();
      },
      (v) => {
        v.files[0].deletedAt = new Date();
      },
      (v) => {
        v.files = [];
      },
      (v) => {
        v.cleanupPending = true;
      },
      (v) => {
        v.job.cleanupPending = true;
      },
      (v) => {
        v.job.errorCode = "UPLOAD_FAILED";
      },
    ]) {
      const { version } = fixture();
      change(version);
      expect(canRetryDocumentOcr(version, true)).toBe(false);
    }
    expect(canRetryDocumentOcr(fixture().version, false)).toBe(false);
  });
});

describe("OCR retry transaction", () => {
  it("requeues through the outbox, audits the reviewer and preserves review data", async () => {
    const { tx, audit, retry } = fixture();
    await retry();
    expect(tx.document.findFirst).toHaveBeenCalledWith({
      where: { id: "document", candidate: { locationId: 10 } },
    });
    expect(tx.ocrJob.updateMany).toHaveBeenCalledWith({
      where: { id: "job", status: "FAILED", cleanupPending: false },
      data: {
        status: "QUEUED",
        attempts: 0,
        errorCode: null,
        leaseToken: null,
        leaseUntil: null,
        correlationId: "correlation",
      },
    });
    const data = tx.documentVersion.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      status: "IN_REVIEW",
      revision: { increment: 1 },
    });
    expect(data).not.toHaveProperty("submittedAt");
    expect(data).not.toHaveProperty("reviewedAt");
    expect(data).not.toHaveProperty("fields");
    expect(tx.ocrOutbox.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { jobId: "job" },
        update: expect.objectContaining({
          publishedAt: null,
          leaseToken: null,
        }),
      }),
    );
    expect(audit.logInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        actorId: "reviewer",
        action: "DOCUMENT_OCR_RETRIED",
        correlationId: "correlation",
      }),
    );
  });
  it("restores legacy failed documents to OCR_PENDING", async () => {
    const { version, tx, retry } = fixture();
    version.submission = null;
    version.status = "OCR_FAILED";
    await retry();
    expect(tx.documentVersion.update.mock.calls[0][0].data.status).toBe(
      "OCR_PENDING",
    );
  });
  it("rejects a stale revision or double click before dispatching again", async () => {
    const f = fixture();
    f.version.revision = 4;
    await expect(f.retry()).rejects.toThrow("unavailable");
    expect(f.tx.ocrJob.updateMany).not.toHaveBeenCalled();
    f.version.revision = 3;
    f.tx.ocrJob.updateMany.mockResolvedValue({ count: 0 });
    await expect(f.retry()).rejects.toThrow("changed");
    expect(f.tx.ocrOutbox.upsert).not.toHaveBeenCalled();
  });
  it("fails closed for inaccessible documents and disabled runtime", async () => {
    const f = fixture();
    f.tx.document.findFirst.mockResolvedValue(null);
    await expect(f.retry()).rejects.toThrow("Document not found");
    expect(f.tx.ocrJob.updateMany).not.toHaveBeenCalled();
    const g = fixture();
    g.config.OCR_MODE = "disabled";
    await expect(g.retry()).rejects.toThrow("OCR_NOT_CONFIGURED");
    expect(g.tx.ocrJob.updateMany).not.toHaveBeenCalled();
  });
  it("propagates audit failures inside the mutation transaction", async () => {
    const f = fixture();
    f.audit.logInTransaction.mockRejectedValue(new Error("audit unavailable"));
    await expect(f.retry()).rejects.toThrow("audit unavailable");
    expect(f.reads.version).not.toHaveBeenCalled();
  });
});
