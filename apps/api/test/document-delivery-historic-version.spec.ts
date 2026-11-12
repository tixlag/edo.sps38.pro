import { describe, expect, it, vi } from "vitest";
import { DocumentDeliveryService } from "../src/documents/document-delivery.service";

function service(currentVersion: number, reviewGroup: "RU" | "IG") {
  const candidate = {
    id: "candidate",
    code1c: reviewGroup === "IG" ? "worker" : null,
    personUid: null,
    chatUuid: reviewGroup === "RU" ? "chat" : null,
    citizenship: reviewGroup === "RU" ? "ru" : "uz",
    reviewGroup,
  };
  const row = {
    id: "delivery",
    status: "REQUIRES_MANUAL",
    transport: "multipart-v2",
    errorCode: "ERP_INVALID_FILE_CONTENT",
    payload: { documentUid: "type", documentFields: {} },
    version: {
      version: 1,
      status: "APPROVED",
      documentId: "document",
      document: { currentVersion, candidateId: candidate.id, candidate },
    },
  };
  const prisma = {
    erpDocumentDelivery: {
      findFirst: vi.fn(async () => row),
      findUnique: vi.fn(async () => row),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $transaction: (fn: (value: unknown) => unknown) => fn({}),
  };
  const delivery = new DocumentDeliveryService(
    prisma as never,
    {} as never,
    {} as never,
    { logInTransaction: vi.fn() } as never,
    { document: vi.fn(), documentReviewWhere: () => ({}) } as never,
    { version: vi.fn() } as never,
    {} as never,
    { reprepareCanonical: vi.fn(async () => null) } as never,
    {} as never,
  );
  const send = vi.spyOn(delivery, "send").mockResolvedValue();
  const repair = vi
    .spyOn(delivery, "repairArtifact")
    .mockResolvedValue(false);
  return { delivery, send, repair };
}

describe("manual delivery retry of a historic version", () => {
  it.each(["RU", "IG"] as const)(
    "refuses to repeat a historic version for %s candidates",
    async (reviewGroup) => {
      const { delivery, send } = service(2, reviewGroup);
      await expect(
        delivery.request(
          "document",
          1,
          { uuid: "reviewer" } as never,
          "test",
        ),
      ).rejects.toThrow("Document version is not current");
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each(["RU", "IG"] as const)(
    "repeats the current version for %s candidates",
    async (reviewGroup) => {
      const { delivery, send } = service(1, reviewGroup);
      await delivery.request(
        "document",
        1,
        { uuid: "reviewer" } as never,
        "test",
      );
      expect(send).toHaveBeenCalledWith(
        "delivery",
        "reviewer",
        "test",
        expect.anything(),
      );
    },
  );
});
