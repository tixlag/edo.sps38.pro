import { describe, expect, it, vi } from "vitest";
import { reserveDocumentInstance } from "../src/documents/document-instance";
const uid = "3f164241-8c5b-11eb-ba8b-00259002db81";
const transaction = (erpUid: string, existing: object | null = null) => ({
  documentType: { findUniqueOrThrow: vi.fn().mockResolvedValue({ erpUid }) },
  document: {
    findFirst: vi.fn().mockResolvedValue(existing),
    create: vi.fn().mockResolvedValue({ id: "new" }),
  },
});
describe("document instance reservation under candidate lock", () => {
  it("permits a new instance only for the five explicit ERP types", async () => {
    const tx = transaction(uid, { id: "old" });
    expect(
      await reserveDocumentInstance(tx as never, "candidate", "type", {
        mode: "new",
      }),
    ).toEqual({ id: "new" });
    expect(tx.document.findFirst).not.toHaveBeenCalled();
    await expect(
      reserveDocumentInstance(
        transaction("passport") as never,
        "candidate",
        "type",
        { mode: "new" },
      ),
    ).rejects.toThrow("DOCUMENT_TYPE_SINGLETON");
  });
  it("reuses singleton instance instead of creating a duplicate", async () => {
    const tx = transaction("passport", { id: "old" });
    expect(
      await reserveDocumentInstance(tx as never, "candidate", "type", {}),
    ).toEqual({ id: "old" });
    expect(tx.document.create).not.toHaveBeenCalled();
  });
  it("requires an explicit choice for ambiguous multi-instance uploads", async () => {
    await expect(
      reserveDocumentInstance(
        transaction(uid, { id: "old" }) as never,
        "candidate",
        "type",
        {},
      ),
    ).rejects.toThrow("DOCUMENT_INSTANCE_MODE_REQUIRED");
  });
  it("requires append target owned by the candidate and matching type", async () => {
    const tx = transaction(uid);
    await expect(
      reserveDocumentInstance(tx as never, "candidate", "type", {
        mode: "append",
      }),
    ).rejects.toThrow("DOCUMENT_ID_REQUIRED");
    await expect(
      reserveDocumentInstance(tx as never, "candidate", "type", {
        mode: "append",
        documentId: "other",
      }),
    ).rejects.toThrow("DOCUMENT_NOT_FOUND");
    expect(tx.document.findFirst).toHaveBeenCalledWith({
      where: { id: "other", candidateId: "candidate", documentTypeId: "type" },
    });
  });
});
