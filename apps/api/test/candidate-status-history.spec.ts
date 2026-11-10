import { describe, expect, it, vi } from "vitest";
import { CandidateDocumentsService } from "../src/documents/candidate-documents.service";

function fixture(syncedAt: Date | null = null) {
  const candidate = { id: "candidate", chatUuid: "chat", erpUid: "erp-candidate", reviewGroup: "RU", citizenship: "ru", personUid: null, code1c: null, previousDocumentsSyncedAt: syncedAt };
  const syncPreviousDocuments = vi.fn().mockResolvedValue(undefined);
  const internalDocuments = vi.fn().mockResolvedValue({ items: [{ documentUid: "passport" }] });
  const service = new CandidateDocumentsService({} as never,
    { byUuid: vi.fn().mockResolvedValue({ chatUuid: "chat", code1c: null }) } as never,
    {} as never, { internalDocuments } as never, {} as never, {} as never,
    { candidate: { findFirst: vi.fn().mockResolvedValue(candidate) } } as never,
    { syncPreviousDocuments } as never);
  return { service, candidate, syncPreviousDocuments };
}
describe("RU chat status history", () => {
  it("refreshes ERP history before a person or employee exists and reuses it on repeat reads", async () => {
    const f = fixture();
    expect(await f.service.statuses("chat")).toEqual({ items: [{ documentUid: "passport" }] });
    await f.service.statuses("chat");
    expect(f.syncPreviousDocuments).toHaveBeenCalledTimes(1);
    expect(f.syncPreviousDocuments.mock.calls[0][3]).toBe(f.candidate);
  });
  it("reuses a snapshot freshly updated by the drawer", async () => {
    const f = fixture(new Date());
    await f.service.statuses("chat");
    expect(f.syncPreviousDocuments).not.toHaveBeenCalled();
  });
  it("refreshes a stale drawer snapshot", async () => {
    const f = fixture(new Date(Date.now() - 6 * 60_000));
    await f.service.statuses("chat");
    expect(f.syncPreviousDocuments).toHaveBeenCalledTimes(1);
  });
});
