import { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentDeliveryService } from "../src/documents/document-delivery.service";

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const row = {
    id: "delivery",
    status: "REQUIRES_MANUAL",
    payload: { documentUid: "type", chatUid: "candidate", documentFields: {} },
    version: {
      documentId: "document",
      version: 1,
      fields: [],
      approvedStorageKey: "approved.pdf",
    },
  };
  const tx = {
    erpDocumentDelivery: {
      findUniqueOrThrow: vi.fn(async () => row),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    erpDocumentAttempt: {
      create: vi.fn(async () => ({ id: "attempt" })),
      update: vi.fn(),
    },
  };
  const prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  };
  const audit = { logInTransaction: vi.fn() };
  const config = new ConfigService({
    ERP_DOCUMENTS_TRANSPORT: "multipart-v2",
    ERP_DOCUMENTS_BASE_URL: "https://erp.example/",
    ERP_DOCUMENTS_TOKEN: "private-token",
    ERP_USERNAME: "private-user",
    ERP_PASSWORD: "private-password",
  });
  const service = new DocumentDeliveryService(
    prisma as never,
    { read: vi.fn(async () => Buffer.from("%PDF-test")) } as never,
    config,
    audit as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );
  return { service, tx, audit };
}

describe("ERP attempt diagnostics persistence", () => {
  it("stores the reason on the same attempt and audits completion without logging its body", async () => {
    const { service, tx, audit } = setup();
    const body = {
      code: 400,
      description: "Должность по positionUid не найдена.",
      token: "private-token",
    };
    const fetcher = vi.fn(async () => Response.json(body, { status: 400 }));
    vi.stubGlobal("fetch", fetcher);
    await service.send("delivery", "reviewer", "correlation");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(tx.erpDocumentAttempt.update).toHaveBeenCalledWith({
      where: { id: "attempt" },
      data: {
        finishedAt: expect.any(Date),
        errorCode: "ERP_HTTP_400",
        httpStatus: 400,
        responseBody: JSON.stringify({ ...body, token: "[redacted]" }),
        responseTruncated: false,
        responseReadError: null,
      },
    });
    expect(tx.erpDocumentDelivery.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "REQUIRES_MANUAL" }),
      }),
    );
    const completion = audit.logInTransaction.mock.calls.at(-1)!;
    expect(completion[0]).toBe(tx);
    expect(completion[1]).toMatchObject({
      action: "DOCUMENT_ERP_SEND_COMPLETED",
      after: { httpStatus: 400 },
    });
    expect(JSON.stringify(completion)).not.toContain(body.description);
  });
  it("records a successful response", async () => {
    const { service, tx } = setup();
    vi.stubGlobal("fetch", async () => Response.json({ success: true }));
    await service.send("delivery");
    expect(tx.erpDocumentAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          httpStatus: 200,
          responseBody: '{"success":true}',
          errorCode: null,
        }),
      }),
    );
    expect(tx.erpDocumentDelivery.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SENT" }),
      }),
    );
  });
  it("does not retry or fabricate an HTTP response on a transport failure", async () => {
    const { service, tx } = setup();
    const fetcher = vi.fn(async () => {
      throw new Error("private transport diagnostic");
    });
    vi.stubGlobal("fetch", fetcher);
    await service.send("delivery");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(tx.erpDocumentAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          finishedAt: expect.any(Date),
          errorCode: "ERP_DELIVERY_UNCONFIRMED",
        },
      }),
    );
  });
  it("does not resend a successful HTTP response because its body could not be read", async () => {
    const { service, tx } = setup();
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("body failed"));
            },
          }),
          { status: 200 },
        ),
    );
    await service.send("delivery");
    expect(tx.erpDocumentAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          httpStatus: 200,
          responseReadError: "ERP_RESPONSE_READ_FAILED",
          errorCode: null,
        }),
      }),
    );
    expect(tx.erpDocumentDelivery.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SENT" }),
      }),
    );
  });
});
