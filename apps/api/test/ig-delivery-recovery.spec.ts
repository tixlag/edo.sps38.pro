import { describe, expect, it, vi } from "vitest";
import { DocumentDeliveryService } from "../src/documents/document-delivery.service";
const person = "fc095953-449f-4bf3-b787-90714efed852";
async function retry(identity: unknown) {
  const candidate = {
    id: "candidate",
    code1c: "worker",
    personUid: person,
    chatUuid: null,
    citizenship: "uz",
    reviewGroup: "IG",
  };
  const row = {
    id: "delivery",
    status: "WAITING_CONTRACT",
    transport: "multipart-v2",
    payload: { documentUid: "type", documentFields: {} },
    version: {
      version: 1,
      status: "APPROVED",
      documentId: "document",
      document: { currentVersion: 1, candidateId: candidate.id, candidate },
    },
  };
  const tx = {
    $queryRaw: vi.fn(),
    erpDocumentDelivery: {
      findUnique: vi.fn(async () => row),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    document: { findFirst: vi.fn(async () => row.version.document) },
  };
  const prisma = {
    erpDocumentDelivery: { findFirst: vi.fn(async () => row) },
    $transaction: (fn: (value: typeof tx) => unknown) => fn(tx),
  };
  const service = new DocumentDeliveryService(
    prisma as never,
    {} as never,
    {} as never,
    { logInTransaction: vi.fn() } as never,
    { document: vi.fn(), documentReviewWhere: () => ({}) } as never,
    { version: vi.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    { identity: vi.fn(async () => identity) } as never,
  );
  const send = vi.spyOn(service, "send").mockResolvedValue();
  let error: unknown;
  try {
    await service.request("document", 1, { uuid: "reviewer" } as never, "test");
  } catch (e) {
    error = e;
  }
  return { row, send, error };
}
describe("parked IG delivery", () => {
  it("re-resolves repaired identity only on authorized manual retry", async () => {
    const result = await retry({
      recipientType: "person",
      reviewGroup: "IG",
      personUid: person,
      code1C: "worker",
      erpUid: null,
      chatUuid: null,
    });
    expect(result.error).toBeUndefined();
    expect(result.row.status).toBe("PENDING");
    expect(result.row.payload).toMatchObject({
      recipientType: "person",
      personUid: person,
      code1c: "worker",
    });
    expect(result.send).toHaveBeenCalledOnce();
  });
  it("keeps a mismatched identity parked", async () => {
    const result = await retry({
      recipientType: "person",
      reviewGroup: "IG",
      personUid: "other",
      code1C: "worker",
    });
    expect(result.error).toBeDefined();
    expect(result.row.status).toBe("WAITING_CONTRACT");
    expect(result.send).not.toHaveBeenCalled();
  });
});
