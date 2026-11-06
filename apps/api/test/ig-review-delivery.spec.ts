import { describe, expect, it, vi } from "vitest";
import { DocumentReviewService } from "../src/documents/document-review.service";

const person = "fc095953-449f-4bf3-b787-90714efed852";
const type = "7d394149-828a-432d-9e45-de5cdfe1cd22";
async function review(identity: unknown) {
  const candidate = {
    id: "candidate",
    chatUuid: null,
    citizenship: "uz",
    personUid: person,
    code1c: "worker",
  };
  const version = {
    id: "version",
    revision: 1,
    status: "IN_REVIEW",
    fields: [],
    submission: {},
    job: null,
    pendingApprovalStorageKey: "key",
    approvalLeaseUntil: new Date("2099-01-01"),
    document: {
      candidateId: candidate.id,
      candidate,
      documentType: { code: "OTHER", erpUid: type },
    },
  };
  let delivery: Record<string, unknown> = {};
  const tx = {
    $queryRaw: vi.fn(),
    document: {
      findUnique: vi.fn(async () => ({ candidateId: candidate.id })),
      findFirst: vi.fn(async () => ({ currentVersion: 1 })),
      update: vi.fn(),
    },
    documentVersion: {
      findUnique: vi.fn(async () => version),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    erpDocumentDelivery: {
      create: vi.fn(async ({ data }) => {
        delivery = data;
      }),
    },
    igEmploymentState: { findFirst: vi.fn(async () => null) },
  };
  const service = new DocumentReviewService(
    {
      documentVersion: tx.documentVersion,
      $transaction: (fn: (value: typeof tx) => unknown) => fn(tx),
    } as never,
    { document: vi.fn(), documentReviewWhere: () => ({}) } as never,
    { logInTransaction: vi.fn() } as never,
    { version: vi.fn() } as never,
    {
      prepare: vi.fn(async () => ({ key: "key", transport: "multipart-v2" })),
    } as never,
    { identity: vi.fn(async () => identity) } as never,
  );
  await service.approve("doc", 1, 1, { uuid: "reviewer" } as never, "test");
  return delivery;
}
describe("IG approval delivery", () => {
  it("freezes the verified person without requiring a chat", async () => {
    const delivery = await review({
      recipientType: "person",
      reviewGroup: "IG",
      personUid: person,
      code1C: "worker",
      erpUid: null,
      chatUuid: null,
    });
    expect(delivery.status).toBe("PENDING");
    expect(delivery.payload).toMatchObject({
      documentUid: type,
      recipientType: "person",
      personUid: person,
      code1c: "worker",
    });
    expect(delivery.payload).not.toHaveProperty("chatUid");
  });
  it("parks conflicting ERP identity with a safe error", async () => {
    const delivery = await review({
      recipientType: "person",
      reviewGroup: "IG",
      personUid: "33333333-3333-4333-8333-333333333333",
      code1C: "worker",
    });
    expect(delivery.status).toBe("WAITING_CONTRACT");
    expect(delivery.errorCode).toBe("ERP_PERSON_IDENTITY_MISMATCH");
  });
});
