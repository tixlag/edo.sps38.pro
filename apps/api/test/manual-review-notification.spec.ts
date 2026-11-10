import { describe, expect, it, vi } from "vitest";
import { ManualDocumentService } from "../src/documents/manual-document.service";

function fixture(checking = false) {
  const submission = { id: "s", versionId: "v", version: {
    documentId: "doc", version: 1, files: [], document: { candidateId: "candidate" },
  } };
  const tx = {
    $queryRaw: vi.fn(),
    documentSubmission: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    documentVersion: { update: vi.fn() },
    document: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    candidate: { updateMany: vi.fn() },
    ocrJob: { create: vi.fn().mockResolvedValue({ id: "job" }) },
  };
  const prisma = {
    documentSubmission: { findUnique: vi.fn().mockResolvedValue(null) },
    documentType: { findUnique: vi.fn().mockResolvedValue({ id: "type", code: "OTHER", catalogSyncedAt: new Date(), allForeign: true, definitions: [], positions: [] }) },
    $transaction: async (run) => run(tx),
  };
  const notifications = { notifyDocumentReadyForReview: vi.fn() };
  const service = new ManualDocumentService(prisma as never, {} as never,
    { logInTransaction: vi.fn() } as never, { ensure: vi.fn() } as never,
    { get: (key) => key === "OCR_MODE" ? checking ? "external" : "stub" : undefined } as never,
    undefined, notifications as never);
  vi.spyOn(service as never, "reserve").mockResolvedValue({ reused: false, submission } as never);
  vi.spyOn(service as never, "accepted").mockReturnValue({} as never);
  const reuse = vi.spyOn(service as never, "reuse").mockResolvedValue({} as never);
  const upload = { metadata: { code_1c: "employee", documentUid: "other", position_code_1c: "position", citizenship: "uz", documentFields: {} }, files: [] };
  return { service, prisma, submission, notifications, upload, reuse };
}

describe("manual upload review notification", () => {
  it("notifies once without OCR and skips an idempotent replay", async () => {
    const f = fixture();
    await f.service.upload(f.upload as never, "key", "correlation");
    f.prisma.documentSubmission.findUnique.mockResolvedValue(f.submission as never);
    await f.service.upload(f.upload as never, "key", "correlation");
    expect(f.reuse).toHaveBeenCalledTimes(1);
    expect(f.notifications.notifyDocumentReadyForReview).toHaveBeenCalledTimes(1);
    expect(f.notifications.notifyDocumentReadyForReview).toHaveBeenCalledWith({ documentId: "doc", version: 1, candidateId: "candidate" });
  });
  it("defers notification when OCR was queued", async () => {
    const f = fixture(true);
    await f.service.upload(f.upload as never, "key", "correlation");
    expect(f.notifications.notifyDocumentReadyForReview).not.toHaveBeenCalled();
  });
});
